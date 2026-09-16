/**
 * Odczyt dokumentu kosztowego (PDF / zdjęcie) przez AI (Anthropic Messages API).
 *
 * Dokumenty spoza KSeF: faktury zagraniczne, faktury krajowe spoza KSeF, paragony, rachunki, noty.
 * Model zwraca WYŁĄCZNIE JSON; `parseExtraction()` (czysta funkcja, testowana) naprawia go
 * (jsonrepair), waliduje i normalizuje liczby/daty/walutę.
 *
 * Model: `claude-sonnet-5`, a gdy API zgłosi not_found / nieprawidłowy model → fallback `claude-sonnet-4-5`.
 * Brak ANTHROPIC_API_KEY → rzuca Error('Brak ANTHROPIC_API_KEY') — route ustawia dokumentowi status `error`.
 */
import Anthropic from '@anthropic-ai/sdk'
import { jsonrepair } from 'jsonrepair'

// ─── Typy ─────────────────────────────────────────────────────────────────────

export interface Extracted {
  seller_name: string
  seller_nip: string          // same cyfry, '' gdy brak
  seller_country: string      // ISO-2 ('' gdy nieznany)
  doc_number: string
  doc_date: string            // YYYY-MM-DD ('' gdy nie odczytano)
  currency: string            // ISO-3
  net: number
  vat: number
  gross: number
  is_receipt: boolean
  description: string         // ≤ 120 znaków — co kupiono
  suggested_subcategory: string
  confidence: number          // 0–1
}

export type ExtractCostCategory = 'cogs' | 'ga' | 'operations' | 'sales'

// ─── Podkategorie dostępne dla AI (klucz → etykieta po polsku) ────────────────

export const EXTRACT_SUBCATEGORIES: Record<string, string> = {
  hardware:               'Sprzęt krajowy (sprzedawca z Polski)',
  hardware_eu:            'Sprzęt z UE (WNT — sprzedawca z kraju UE poza Polską)',
  hardware_noneu:         'Sprzęt spoza UE (import — np. Chiny, USA, UK)',
  import_duty:            'Cło i opłaty celne',
  import_freight:         'Fracht / spedycja importowa',
  import_agency:          'Agencja celna / obsługa importu',
  subcontractor:          'Podwykonawca (usługi montażowe, instalacyjne)',
  installation_material:  'Materiały instalacyjne (kable, puszki, drobnica)',
  software:               'Oprogramowanie / licencje / subskrypcje (SaaS, chmura, domeny)',
  utilities:              'Media (prąd, internet, telefon)',
  rent:                   'Czynsz biuro / magazyn',
  accounting:             'Księgowość / doradztwo podatkowe',
  legal:                  'Usługi prawne',
  office_supplies:        'Materiały biurowe',
  car_fuel:               'Paliwo',
  car_service:            'Serwis pojazdów, opony, myjnia',
  insurance:              'Ubezpieczenie',
  travel:                 'Podróże służbowe (hotel, bilety, przejazdy, diety)',
  tools:                  'Narzędzia i sprzęt warsztatowy',
  marketing:              'Marketing / reklama',
  other:                  'Inne (gdy nic nie pasuje)',
}

/** Mapowanie podkategorii → kategoria główna RZiS. Nieznany klucz → `ga` (jak `other`). */
export function subcategoryToCategory(subcategory: string): ExtractCostCategory {
  const s = String(subcategory ?? '').trim()
  if (s.startsWith('hardware') || s.startsWith('import_') || s === 'subcontractor' || s === 'installation_material') return 'cogs'
  if (s.startsWith('car_') || s === 'insurance' || s === 'travel' || s === 'tools') return 'operations'
  if (s === 'marketing') return 'sales'
  return 'ga' // software, utilities, rent, accounting, legal, office_supplies, other
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SUBCATEGORY_LIST = Object.entries(EXTRACT_SUBCATEGORIES).map(([k, v]) => `- ${k}: ${v}`).join('\n')

const SYSTEM_PROMPT = `Jesteś asystentem księgowym polskiej firmy instalującej systemy smart home (KNX, Control4, Hikvision, GateLynk).
Odczytujesz dokument kosztowy, którego NIE MA w KSeF: fakturę zagraniczną, fakturę krajową spoza KSeF, paragon, rachunek lub notę obciążeniową.

Zwróć WYŁĄCZNIE jeden obiekt JSON (bez komentarzy, bez markdown, bez tekstu przed ani po) o polach:
{
  "seller_name": "pełna nazwa sprzedawcy / wystawcy",
  "seller_nip": "NIP lub numer VAT sprzedawcy — SAME CYFRY (bez prefiksu kraju, spacji, myślników); "" gdy brak",
  "seller_country": "kraj sprzedawcy jako kod ISO-2 (PL, DE, CN, US, GB…); "" gdy nie wiadomo",
  "doc_number": "numer dokumentu (faktury/paragonu); "" gdy brak",
  "doc_date": "data wystawienia w formacie YYYY-MM-DD",
  "currency": "waluta dokumentu jako kod ISO-3 (PLN, EUR, USD, GBP, CNY…)",
  "net": kwota netto jako liczba (kropka dziesiętna),
  "vat": kwota VAT jako liczba (0 gdy dokument nie wykazuje VAT),
  "gross": kwota brutto / do zapłaty jako liczba,
  "is_receipt": true gdy to paragon lub rachunek bez danych nabywcy, inaczej false,
  "description": "krótko (max 120 znaków), co kupiono — po polsku",
  "suggested_subcategory": "jeden klucz z listy poniżej",
  "confidence": pewność odczytu 0–1 (1 = wszystkie pola czytelne i jednoznaczne)
}

Dozwolone wartości suggested_subcategory (klucz: znaczenie):
${SUBCATEGORY_LIST}

Zasady:
- Kwoty zawsze w walucie dokumentu; nie przeliczaj na PLN. Liczby zapisuj z kropką (1234.56), bez separatorów tysięcy i symboli walut.
- Gdy dokument wykazuje tylko jedną kwotę (np. paragon zagraniczny, faktura bez VAT / reverse charge): net = gross, vat = 0.
- Sprzęt/urządzenia: sprzedawca z Polski → hardware; z kraju UE → hardware_eu; spoza UE → hardware_noneu.
- Subskrypcje online (Google, Apple, Microsoft, Adobe, AWS, domeny, hosting) → software.
- Jeśli pola nie da się odczytać, wpisz "" (tekst) lub 0 (liczba) i obniż confidence.
- Odpowiedź musi być poprawnym JSON-em i niczym więcej.`

// ─── Czysta funkcja: parsowanie i normalizacja odpowiedzi AI ──────────────────

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')
}

function toStr(v: unknown, max = 500): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : ''
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Liczba z wartości AI: akceptuje number, "1 234,56", "1,234.56", "€ 99.00", "-" → 0. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v !== 'string') return 0
  let s = v.replace(/[^\d,.\-]/g, '').trim()
  if (!s || s === '-' ) return 0
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    // Oba separatory: ostatni to dziesiętny
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.')
    else s = s.replace(/,/g, '')
  } else if (lastComma > -1) {
    // Tylko przecinek: dziesiętny gdy 1–2 cyfry po nim, inaczej separator tysięcy
    const after = s.length - lastComma - 1
    s = (after >= 1 && after <= 2) ? s.replace(/,/g, '.') : s.replace(/,/g, '')
  } else if (lastDot > -1) {
    // Tylko kropki w układzie 1.234 / 1.234.567 → separatory tysięcy
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Data → YYYY-MM-DD; akceptuje DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY, YYYY/MM/DD, YYYY.MM.DD; niepoprawna → ''. */
export function normalizeDate(v: unknown): string {
  const s = toStr(v, 40)
  if (!s) return ''
  let y = 0, m = 0, d = 0
  let mt = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s)
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3] }
  else {
    mt = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/.exec(s)
    if (mt) { d = +mt[1]; m = +mt[2]; y = +mt[3] }
    else return ''
  }
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return ''
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return ''
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const CURRENCY_ALIASES: Record<string, string> = {
  'ZL': 'PLN', 'ZŁ': 'PLN', 'PLN': 'PLN', 'ZLOTY': 'PLN', 'ZŁOTY': 'PLN', 'ZLOTYCH': 'PLN', 'ZŁOTYCH': 'PLN',
  '€': 'EUR', 'EURO': 'EUR', 'EUR': 'EUR',
  '$': 'USD', 'USD': 'USD', 'US$': 'USD', 'DOLLAR': 'USD',
  '£': 'GBP', 'GBP': 'GBP', 'POUND': 'GBP',
  '¥': 'CNY', 'RMB': 'CNY', 'CNY': 'CNY', 'YUAN': 'CNY',
  'CHF': 'CHF', 'CZK': 'CZK', 'KC': 'CZK', 'KČ': 'CZK', 'SEK': 'SEK', 'NOK': 'NOK', 'DKK': 'DKK', 'HUF': 'HUF', 'JPY': 'JPY',
}

/** Waluta → kod ISO-3 (domyślnie PLN). */
export function normalizeCurrency(v: unknown): string {
  const raw = toStr(v, 20).toUpperCase()
  if (!raw) return 'PLN'
  if (CURRENCY_ALIASES[raw]) return CURRENCY_ALIASES[raw]
  const m = /^[A-Z]{3}$/.exec(raw)
  if (m) return raw
  const inner = /\b([A-Z]{3})\b/.exec(raw)
  if (inner && CURRENCY_ALIASES[inner[1]]) return CURRENCY_ALIASES[inner[1]]
  if (inner) return inner[1]
  return 'PLN'
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  const s = toStr(v, 10).toLowerCase()
  return s === 'true' || s === 'tak' || s === 'yes' || s === '1'
}

/** Wyciąga pierwszy obiekt JSON z tekstu (obsługuje ```json … ``` i tekst dookoła). */
function extractJsonText(text: string): string | null {
  const t = String(text ?? '')
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  const body = fence ? fence[1] : t
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1) return null
  return end > start ? body.slice(start, end + 1) : body.slice(start)
}

/**
 * Parsuje surową odpowiedź AI → `Extracted`. Rzuca Error, gdy w tekście nie ma JSON-a
 * nawet po naprawie. Normalizuje: NIP → cyfry, daty → ISO, walutę → ISO-3, liczby → number,
 * gross = net + vat gdy brak; net = gross − vat gdy brak; subcategory spoza listy → `other`.
 */
export function parseExtraction(text: string): Extracted {
  const jsonText = extractJsonText(text)
  if (!jsonText) throw new Error('AI nie zwróciło JSON')
  let raw: any
  try {
    raw = JSON.parse(jsonText)
  } catch {
    try {
      raw = JSON.parse(jsonrepair(jsonText))
    } catch {
      throw new Error('Nie udało się odczytać JSON z odpowiedzi AI')
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Odpowiedź AI nie jest obiektem JSON')

  const seller_nip = toStr(raw.seller_nip, 40).replace(/\D/g, '')
  let seller_country = stripDiacritics(toStr(raw.seller_country, 10)).toUpperCase().replace(/[^A-Z]/g, '')
  if (seller_country.length !== 2) {
    const map: Record<string, string> = { POLSKA: 'PL', POLAND: 'PL', NIEMCY: 'DE', GERMANY: 'DE', CHINY: 'CN', CHINA: 'CN', USA: 'US', UK: 'GB' }
    seller_country = map[seller_country] ?? ''
  }
  if (!seller_country && seller_nip.length === 10) seller_country = 'PL'

  let net = r2(toNumber(raw.net))
  let vat = r2(toNumber(raw.vat))
  let gross = r2(toNumber(raw.gross))
  if (net < 0) net = Math.abs(net)
  if (vat < 0) vat = Math.abs(vat)
  if (gross < 0) gross = Math.abs(gross)
  if (!gross && (net || vat)) gross = r2(net + vat)
  if (!net && gross) net = r2(gross - vat)
  if (!vat && gross && net && gross > net) vat = r2(gross - net)

  let confidence = toNumber(raw.confidence)
  // Model czasem zwraca procent (88) zamiast ułamka (0.88); wartości 1–2 to raczej „pewny" niż „1,7 %"
  if (confidence >= 2 && confidence <= 100) confidence = confidence / 100
  confidence = Math.min(1, Math.max(0, r2(confidence)))

  const subKey = toStr(raw.suggested_subcategory, 60).toLowerCase().replace(/[^a-z_]/g, '')
  const suggested_subcategory = EXTRACT_SUBCATEGORIES[subKey] ? subKey : 'other'

  return {
    seller_name: toStr(raw.seller_name, 200),
    seller_nip,
    seller_country,
    doc_number: toStr(raw.doc_number, 100),
    doc_date: normalizeDate(raw.doc_date),
    currency: normalizeCurrency(raw.currency),
    net, vat, gross,
    is_receipt: toBool(raw.is_receipt),
    description: toStr(raw.description, 120),
    suggested_subcategory,
    confidence,
  }
}

// ─── Wywołanie AI ─────────────────────────────────────────────────────────────

export const EXTRACT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
type ImageMedia = typeof EXTRACT_IMAGE_TYPES[number]

const PRIMARY_MODEL = 'claude-sonnet-5'
const FALLBACK_MODEL = 'claude-sonnet-4-5'

function isModelNotFound(e: any): boolean {
  const status = Number(e?.status ?? 0)
  const type = String(e?.error?.error?.type ?? e?.error?.type ?? '')
  const msg = String(e?.message ?? '')
  return status === 404 || type === 'not_found_error'
    || /not_found|model.*(not (found|supported|exist)|unknown|invalid)|invalid.*model/i.test(msg)
}

export interface ExtractInput {
  buffer: Buffer
  mimeType: string
  fileName?: string
  timeoutMs?: number
}

/**
 * Odczytuje dokument przez Anthropic Messages i zwraca znormalizowany wynik.
 * Rzuca: brak klucza API, nieobsługiwany typ pliku, błąd API, brak JSON w odpowiedzi.
 */
export async function extractCostDocument(input: ExtractInput): Promise<Extracted> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('Brak ANTHROPIC_API_KEY')

  const mime = String(input.mimeType ?? '').toLowerCase().split(';')[0].trim()
  const data = input.buffer.toString('base64')

  let fileBlock: Anthropic.Messages.ContentBlockParam
  if (mime === 'application/pdf') {
    fileBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  } else if ((EXTRACT_IMAGE_TYPES as readonly string[]).includes(mime)) {
    fileBlock = { type: 'image', source: { type: 'base64', media_type: mime as ImageMedia, data } }
  } else {
    throw new Error(`Nieobsługiwany typ pliku: ${mime || 'nieznany'} (dozwolone: PDF, JPEG, PNG, WEBP)`)
  }

  const client = new Anthropic({ apiKey, timeout: input.timeoutMs ?? 55_000, maxRetries: 1 })
  const userText = `Odczytaj ten dokument kosztowy${input.fileName ? ` (plik: ${input.fileName})` : ''} i zwróć wyłącznie JSON zgodnie z instrukcją.`

  const call = (model: string) => client.messages.create({
    model,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: userText }] }],
  })

  let message: Anthropic.Messages.Message
  try {
    message = await call(PRIMARY_MODEL)
  } catch (e: any) {
    if (!isModelNotFound(e)) throw e
    console.warn(`[CostExtract] Model ${PRIMARY_MODEL} niedostępny — fallback ${FALLBACK_MODEL}:`, e?.message ?? e)
    message = await call(FALLBACK_MODEL)
  }

  const text = message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

  return parseExtraction(text)
}
