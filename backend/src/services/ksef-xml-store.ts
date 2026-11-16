/**
 * Magazyn oryginalnych XML faktur z KSeF (FA(2)/FA(3)).
 *
 * Jedno miejsce, przez które idą WSZYSTKIE pobrania XML faktury (podgląd dokumentu, „Pobierz XML",
 * pozycje faktury, termin płatności przy synchronizacji):
 *  - cache w bazie (tabela ksef_invoice_xml) — XML w KSeF jest niezmienny, więc raz pobrany plik jest
 *    zawsze poprawny; cache jest FAIL-SOFT (brak tabeli przed wdrożeniem, błąd bazy = „nie ma w cache"),
 *  - wspólny ogranicznik równoległości (max 2 pobrania z KSeF naraz) — chroni przed rate-limitem,
 *  - de-duplikacja równoległych żądań o tę samą fakturę (lista pozycji + podgląd dokumentu = 1 pobranie),
 *  - mapowanie dowolnego błędu na odpowiedź HTTP (mapKsefXmlError) — czysta funkcja, testowana.
 *
 * Kontrola dostępu należy do wywołującego: fakturę ładuje on wcześniej przez klienta Prisma z zakresem
 * firmy (db.ts → prisma). Magazyn działa w żądaniu, w zadaniach w tle (runWithCompany) i bez kontekstu.
 */
import axios from 'axios'
import { prisma } from '../db'
import { getActiveSession, KsefNotConfiguredError, KSEF_NOT_CONFIGURED_MSG } from './ksef'
import { buildKsefInvoiceHtml, KsefDocumentError } from './ksef-document'

const KSEF_INVOICE_URL = 'https://api.ksef.mf.gov.pl/v2/invoices/ksef'
/** Limit bezczynności gniazda (`timeout` axios to NIE jest limit czasu całego pobrania). */
const DOWNLOAD_TIMEOUT_MS = 15000
/** Łączny limit czasu jednego pobrania XML z KSeF (po nim żądanie jest przerywane). */
const DOWNLOAD_DEADLINE_MS = 30000
/**
 * Największy XML faktury, jaki przyjmujemy z KSeF (limit KSeF: 1 MB, z załącznikami 3 MB).
 * Większa odpowiedź przerywa pobieranie i nigdy nie trafia do cache ani do parsera.
 */
export const MAX_INVOICE_XML_BYTES = 8 * 1024 * 1024
const MAX_PARALLEL_DOWNLOADS = 2
/** Po błędzie „tabela nie istnieje" nie odpytujemy cache przez ten czas (potem próbujemy ponownie). */
const CACHE_RETRY_MS = 10 * 60 * 1000
/** To samo ostrzeżenie o błędzie cache (operacja + rodzaj błędu) wypisujemy najwyżej raz na ten czas. */
const CACHE_WARN_INTERVAL_MS = 60 * 60 * 1000

// ── Komunikaty dla użytkownika ────────────────────────────────────────────────
export const NO_KSEF_NUMBER_MSG   = 'Ta faktura nie ma numeru KSeF — nie ma dokumentu źródłowego do wyświetlenia.'
export const RATE_LIMITED_MSG     = 'KSeF chwilowo ogranicza liczbę zapytań. Spróbuj ponownie za kilka minut.'
export const UNPARSEABLE_MSG      = 'Nie udało się odczytać struktury tej faktury. Pobierz plik XML.'
export const NOT_IN_KSEF_MSG      = 'KSeF nie udostępnia tej faktury — nie znaleziono jej pod tym numerem KSeF.'
export const KSEF_TIMEOUT_MSG     = 'KSeF nie odpowiedział na czas. Spróbuj ponownie za chwilę.'
export const KSEF_UNREACHABLE_MSG = 'Nie udało się połączyć z KSeF. Spróbuj ponownie za chwilę.'
export const INVALID_XML_MSG      = 'KSeF zwrócił nieoczekiwaną odpowiedź zamiast XML faktury. Spróbuj ponownie za chwilę.'
export const KSEF_SESSION_MSG     = 'Nie udało się uzyskać sesji KSeF. Spróbuj ponownie za chwilę.'
export const XML_TOO_LARGE_MSG    = `Plik XML tej faktury jest zbyt duży, żeby pobrać go z KSeF (limit ${MAX_INVOICE_XML_BYTES / (1024 * 1024)} MB).`
export const SERVER_ERROR_MSG     = 'Wystąpił błąd serwera podczas pobierania faktury. Spróbuj ponownie.'

/** Błąd magazynu XML z gotowym statusem HTTP, kodem i komunikatem po polsku (dla użytkownika). */
export class KsefXmlError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'KsefXmlError'
    this.status = status
    this.code = code
  }
}

// ── Błąd → odpowiedź HTTP (czyste) ────────────────────────────────────────────
export interface KsefErrorBody { error: string; code?: string; configured?: boolean }
export interface KsefErrorResponse { status: number; body: KsefErrorBody }

// ERR_CANCELED = przerwanie przez nasz łączny limit czasu pobrania (AbortSignal.timeout → axios CanceledError)
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_CANCELED'])
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_NETWORK', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
])

/**
 * Zamień DOWOLNY błąd z pobierania XML / budowania dokumentu na { status, body } zgodne z kontraktem API:
 *  400 brak konfiguracji KSeF firmy (+ configured:false) · 429 rate_limited · 404 faktury nie ma w KSeF ·
 *  502 inny błąd KSeF / sieć / timeout / za duża odpowiedź · 422 unparseable (KsefDocumentError) · 500 reszta.
 * Bez efektów ubocznych — nie loguje i nigdy nie przepuszcza surowej treści błędu do użytkownika.
 */
export function mapKsefXmlError(err: any): KsefErrorResponse {
  if (err instanceof KsefXmlError) {
    return { status: err.status, body: { error: err.message, code: err.code } }
  }
  if (err instanceof KsefNotConfiguredError || err?.name === 'KsefNotConfiguredError') {
    return { status: 400, body: { error: err?.message || KSEF_NOT_CONFIGURED_MSG, configured: false } }
  }
  if (err instanceof KsefDocumentError || err?.name === 'KsefDocumentError') {
    return { status: 422, body: { error: UNPARSEABLE_MSG, code: 'unparseable' } }
  }
  // odpowiedź HTTP z KSeF (błąd axios z `response`)
  const httpStatus = Number(err?.response?.status)
  if (Number.isFinite(httpStatus) && httpStatus > 0) {
    if (httpStatus === 429) return { status: 429, body: { error: RATE_LIMITED_MSG, code: 'rate_limited' } }
    if (httpStatus === 404) return { status: 404, body: { error: NOT_IN_KSEF_MSG, code: 'not_in_ksef' } }
    return { status: 502, body: { error: `KSeF odpowiedział błędem (HTTP ${httpStatus}).` } }
  }
  // brak odpowiedzi: timeout / sieć
  const code = typeof err?.code === 'string' ? err.code : ''
  const message = typeof err?.message === 'string' ? err.message : ''
  if (TIMEOUT_CODES.has(code) || /timeout of \d+ms exceeded/i.test(message)) {
    return { status: 502, body: { error: KSEF_TIMEOUT_MSG } }
  }
  // axios przerwał pobieranie po przekroczeniu maxContentLength (ERR_BAD_RESPONSE bez `response`)
  if (/maxContentLength size of \d+ exceeded/i.test(message)) {
    return { status: 502, body: { error: XML_TOO_LARGE_MSG, code: 'xml_too_large' } }
  }
  if (NETWORK_CODES.has(code) || err?.isAxiosError === true) {
    return { status: 502, body: { error: KSEF_UNREACHABLE_MSG } }
  }
  return { status: 500, body: { error: SERVER_ERROR_MSG } }
}

/** Jedna, przycięta linia tekstu błędu. Prisma zaczyna od „Invalid `…` invocation in”, a sedno podaje w ostatniej linii. */
function firstLine(text: unknown, max = 300): string {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  const s = (lines.length > 1 && /^Invalid `/.test(lines[0]) ? lines[lines.length - 1] : lines[0]) ?? ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Krótki opis błędu do logów serwera. Celowo NIE wypisuje całego obiektu błędu axios —
 * jego `config.headers` zawiera token sesji KSeF (Authorization: Bearer …).
 */
export function describeKsefError(err: any): string {
  const parts: string[] = []
  if (err?.response?.status) parts.push(`HTTP ${err.response.status}`)
  if (typeof err?.code === 'string' && err.code) parts.push(err.code)
  const msg = firstLine(err?.message ?? err)
  if (msg) parts.push(msg)
  const data = err?.response?.data
  if (data != null && data !== '') {
    let text = ''
    try { text = typeof data === 'string' ? data : JSON.stringify(data) } catch { text = '' }
    if (text) parts.push(firstLine(text))
  }
  return parts.join(' | ') || 'nieznany błąd'
}

/** Wyślij odpowiedź błędu wg mapKsefXmlError; błędy 5xx trafiają do logu serwera (bez tokenów). */
export function sendKsefXmlError(
  res: { status(code: number): { json(body: any): unknown } },
  err: any,
  logTag = 'ksef-xml',
): void {
  const { status, body } = mapKsefXmlError(err)
  if (status >= 500) console.error(`[${logTag}] ${status}:`, describeKsefError(err))
  res.status(status).json(body)
}

// ── Pomocnicze (czyste) ───────────────────────────────────────────────────────

/**
 * Czy tekst wygląda na XML faktury z KSeF: element Faktura (FA(2)/FA(3), FA_RR), ewentualnie korzeń
 * UBL (Invoice/CreditNote — faktury PEF). Odsiewa treści błędów (JSON, HTML), których nie wolno cache'ować.
 */
export function looksLikeKsefInvoiceXml(xml: unknown): boolean {
  return typeof xml === 'string'
    && /<(?:[\w.-]+:)?(?:Faktura\w*|Invoice|CreditNote)(?:\s[^>]*)?\/?>/.test(xml)
}

/** Nazwa pliku BEZ rozszerzenia: „faktura-” + numer faktury (albo numer KSeF) ograniczony do [A-Za-z0-9_.-]. */
export function ksefInvoiceFileBaseName(invoice: { invoice_number?: string | null; ksef_number?: string | null }): string {
  const raw = (invoice.invoice_number ?? '').trim() || (invoice.ksef_number ?? '').trim()
  const safe = raw
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // ą→a, ż→z …
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[_.-]+/, '')
    .slice(0, 100)
    .replace(/[_.-]+$/, '')
  return safe ? `faktura-${safe}` : 'faktura'
}

/**
 * Ogranicznik równoległości: najwyżej `max` zadań naraz, reszta czeka w kolejce FIFO.
 * Zwolniony slot jest przekazywany wprost pierwszemu czekającemu (limit nigdy nie jest przekraczany).
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: (() => void)[] = []
  return async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>(resolve => queue.push(resolve)) // slot dostajemy od kończącego
    else active++
    try {
      return await fn()
    } finally {
      const next = queue.shift()
      if (next) next() // przekaż slot (active bez zmian)
      else active--
    }
  }
}

function isMissingTableError(err: any): boolean {
  const code = err?.code
  if (code === 'P2021' || code === 'P2022' || code === '42P01') return true
  const msg = typeof err?.message === 'string' ? err.message : ''
  return /ksef_invoice_xml/i.test(msg) && /does not exist/i.test(msg)
}

// ── Magazyn (logika z wstrzykiwanymi zależnościami — testowalna bez bazy i sieci) ──
export type InvoiceXmlSource = 'cache' | 'ksef'
export interface InvoiceXmlResult { xml: string; source: InvoiceXmlSource }
export interface InvoiceXmlRef { id: string; ksef_number: string | null }

export interface InvoiceXmlStoreDeps {
  /** XML z cache albo null; może rzucić (błąd jest połykany = brak w cache). */
  readCache(invoiceId: string): Promise<string | null>
  /** Zapis do cache; może rzucić (błąd jest połykany). */
  writeCache(invoiceId: string, xml: string): Promise<void>
  /** Pobranie XML z KSeF po numerze KSeF; błędy idą do wywołującego. */
  download(ksefNumber: string): Promise<string>
  warn?(message: string): void
  now?(): number
}

export function createInvoiceXmlStore(deps: InvoiceXmlStoreDeps, opts: { maxParallel?: number } = {}) {
  const withLimit = createLimiter(opts.maxParallel ?? MAX_PARALLEL_DOWNLOADS)
  const inflight = new Map<string, Promise<InvoiceXmlResult>>()
  const warned = new Map<string, { at: number; repeats: number }>()
  const now = deps.now ?? (() => Date.now())
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  let cachePausedUntil = 0

  // Cache fail-soft: każdy błąd = brak w cache. Ostrzeżenie nie przy każdym wywołaniu, tylko najwyżej raz
  // na godzinę na (operację, rodzaj błędu) — trwała awaria cache zostaje widoczna w logach, a nie tylko raz
  // na cały czas życia procesu (bez cache każdy podgląd / pozycje to nowe pobranie z KSeF).
  function cacheFailed(op: 'odczyt' | 'zapis', err: any): void {
    const missingTable = isMissingTableError(err)
    const at = now()
    if (missingTable) cachePausedUntil = at + CACHE_RETRY_MS
    const key = missingTable ? 'missing-table' : `${op}:${err?.code ?? err?.name ?? 'error'}`
    const last = warned.get(key)
    if (last && at - last.at < CACHE_WARN_INTERVAL_MS) { last.repeats++; return }
    warned.set(key, { at, repeats: 0 })
    const repeated = last?.repeats ? ` (od poprzedniego ostrzeżenia błąd powtórzył się ${last.repeats}×)` : ''
    warn((missingTable
      ? '[KSeF] Tabela cache XML faktur (ksef_invoice_xml) jeszcze nie istnieje — XML pobierany bezpośrednio z KSeF (cache włączy się po wdrożeniu schematu).'
      : `[KSeF] Cache XML faktur — ${op} nieudany, pomijam cache: ${firstLine(err?.message ?? err)}`) + repeated)
  }

  async function readCacheSoft(invoiceId: string): Promise<string | null> {
    if (now() < cachePausedUntil) return null
    try {
      const xml = await deps.readCache(invoiceId)
      return xml && looksLikeKsefInvoiceXml(xml) ? xml : null
    } catch (err) {
      cacheFailed('odczyt', err)
      return null
    }
  }

  async function writeCacheSoft(invoiceId: string, xml: string): Promise<void> {
    if (now() < cachePausedUntil) return
    try {
      await deps.writeCache(invoiceId, xml)
    } catch (err) {
      cacheFailed('zapis', err)
    }
  }

  async function load(invoiceId: string, ksefNumber: string): Promise<InvoiceXmlResult> {
    const cached = await readCacheSoft(invoiceId)
    if (cached) return { xml: cached, source: 'cache' }

    const xml = await withLimit(() => deps.download(ksefNumber))
    // za duża treść nie trafia ani do cache, ani do parsera (liczba znaków ≤ liczba bajtów, więc ten sam
    // limit nie odrzuci niczego, co przepuścił klient HTTP)
    if (typeof xml === 'string' && xml.length > MAX_INVOICE_XML_BYTES) {
      throw new KsefXmlError(502, 'xml_too_large', XML_TOO_LARGE_MSG)
    }
    // treści błędów (JSON/HTML z kodem 200) nigdy nie trafiają do cache ani do użytkownika jako „faktura"
    if (!looksLikeKsefInvoiceXml(xml)) throw new KsefXmlError(502, 'invalid_xml', INVALID_XML_MSG)
    await writeCacheSoft(invoiceId, xml)
    return { xml, source: 'ksef' }
  }

  /** XML faktury: z cache, a gdy go nie ma — z KSeF (z zapisem do cache). */
  async function getInvoiceXml(invoice: InvoiceXmlRef): Promise<InvoiceXmlResult> {
    const ksefNumber = invoice.ksef_number
    if (!ksefNumber || !ksefNumber.trim()) throw new KsefXmlError(400, 'no_ksef_number', NO_KSEF_NUMBER_MSG)

    // równoległe żądania o tę samą fakturę dzielą jedno pobranie
    const running = inflight.get(invoice.id)
    if (running) return running
    const promise = load(invoice.id, ksefNumber).finally(() => { inflight.delete(invoice.id) })
    inflight.set(invoice.id, promise)
    return promise
  }

  return { getInvoiceXml }
}

// ── Domyślny magazyn: Prisma (zakres firmy przez tenant.ts → CHILD_SCOPES) + API KSeF ──

/**
 * Błąd uzyskania sesji KSeF (getActiveSession) → błąd, który magazyn oddaje wywołującemu. Czyste, nie loguje.
 *  - brak konfiguracji KSeF firmy przechodzi bez zmian (trasy mapują go na 400 + configured:false),
 *  - getActiveSession opakowuje błędy HTTP w zwykły Error („Challenge failed: HTTP 429: {…}” — format nadaje
 *    axiosError() w ./ksef), więc limit zapytań rozpoznajemy po „HTTP 429” w komunikacie → 429 rate_limited,
 *  - wszystko inne → 502 ksef_session.
 */
export function mapKsefSessionError(err: any): Error {
  if (err instanceof KsefNotConfiguredError) return err
  const msg = typeof err?.message === 'string' ? err.message : ''
  if (/\bHTTP 429\b/.test(msg)) return new KsefXmlError(429, 'rate_limited', RATE_LIMITED_MSG)
  return new KsefXmlError(502, 'ksef_session', KSEF_SESSION_MSG)
}

async function downloadInvoiceXmlFromKsef(ksefNumber: string): Promise<string> {
  let token: string
  try {
    token = await getActiveSession()
  } catch (err: any) {
    const mapped = mapKsefSessionError(err)
    if (mapped instanceof KsefXmlError && mapped.code === 'ksef_session') {
      const msg = typeof err?.message === 'string' ? err.message : ''
      console.error('[KSeF] Nie udało się uzyskać sesji do pobrania XML faktury:', firstLine(msg || err))
    }
    throw mapped
  }
  const res = await axios.get(
    `${KSEF_INVOICE_URL}/${encodeURIComponent(ksefNumber)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'text',
      timeout: DOWNLOAD_TIMEOUT_MS,                       // bezczynność gniazda
      signal: AbortSignal.timeout(DOWNLOAD_DEADLINE_MS),  // łączny limit czasu całego pobrania
      maxContentLength: MAX_INVOICE_XML_BYTES,            // większa odpowiedź przerywa pobieranie
    },
  )
  return typeof res.data === 'string' ? res.data : String(res.data)
}

const defaultStore = createInvoiceXmlStore({
  readCache: async invoiceId => {
    const row = await prisma.ksefInvoiceXml.findUnique({ where: { invoice_id: invoiceId }, select: { xml: true } })
    return row?.xml ?? null
  },
  writeCache: async (invoiceId, xml) => {
    const fetched_at = new Date().toISOString()
    await prisma.ksefInvoiceXml.upsert({
      where:  { invoice_id: invoiceId },
      create: { invoice_id: invoiceId, xml, fetched_at },
      update: { xml, fetched_at },
    })
  },
  download: downloadInvoiceXmlFromKsef,
})

/**
 * Oryginalny XML faktury: z cache w bazie albo (pierwszy raz) z KSeF.
 * `invoice` musi być wcześniej załadowana przez klienta Prisma z zakresem firmy — to jest kontrola dostępu.
 * Rzuca: KsefXmlError (brak numeru KSeF, nieoczekiwana albo za duża treść, sesja), KsefNotConfiguredError,
 * błąd axios (odpowiedź KSeF / sieć / limit czasu / limit rozmiaru) — wszystko mapowalne przez mapKsefXmlError.
 */
export async function getInvoiceXml(invoice: { id: string; ksef_number: string | null }): Promise<{ xml: string; source: 'cache' | 'ksef' }> {
  return defaultStore.getInvoiceXml(invoice)
}

// ── Dokument faktury (HTML do podglądu / druku) ───────────────────────────────
export interface KsefInvoiceDocument { html: string; title: string; filename: string; source: InvoiceXmlSource }

/**
 * Pełny dokument faktury zbudowany z XML: { html, title, filename (bez rozszerzenia), source }.
 * Faktura, której struktury nie da się odczytać → 422 „unparseable" (użytkownik może pobrać XML).
 */
export async function getInvoiceDocument(invoice: {
  id: string
  ksef_number: string | null
  invoice_number?: string | null
  invoice_direction?: string | null
}): Promise<KsefInvoiceDocument> {
  const { xml, source } = await getInvoiceXml(invoice)
  let doc: { html: string; title: string }
  try {
    doc = buildKsefInvoiceHtml(xml, { ksefNumber: invoice.ksef_number, direction: invoice.invoice_direction })
  } catch (err: any) {
    if (err instanceof KsefDocumentError) throw err
    // nieprzewidziany błąd renderera na nietypowej fakturze — dla użytkownika to samo: nie da się odczytać
    console.error(`[KSeF] Błąd budowania dokumentu faktury ${invoice.id}:`, err?.stack ?? err)
    throw new KsefXmlError(422, 'unparseable', UNPARSEABLE_MSG)
  }
  return { html: doc.html, title: doc.title, filename: ksefInvoiceFileBaseName(invoice), source }
}
