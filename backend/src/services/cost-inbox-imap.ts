/**
 * Skrzynka e-mail (IMAP) na faktury spoza KSeF.
 *
 * Pracownicy / dostawcy przekazują faktury na dedykowany adres; poller co 15 min pobiera nowe wiadomości
 * (UID > last_uid; przy pierwszym uruchomieniu — z ostatnich 14 dni), wyciąga załączniki PDF/JPG/PNG/WEBP
 * (≤ 10 MB) i tworzy `CostDocument source='email'`, który przechodzi ten sam potok co upload
 * (`processCostDocument`: AI → NBP → duplikaty). Idempotencja: `email_uid = host|folder|uid|i`.
 *
 * Pamięć: najpierw pobierane są tylko metadane (UID, rozmiar, BODYSTRUCTURE), wiadomości > 25 MB i bez
 * części PDF/obraz są pomijane bez pobierania treści, a źródło każdej pozostałej wiadomości jest pobierane
 * POJEDYNCZO i przetwarzane od razu (bez buforowania partii). Max 30 wiadomości na przebieg. `last_uid`
 * zapisywany po każdej wiadomości, więc restart nie wraca do tego samego zestawu.
 *
 * Obrazy osadzone w HTML (logo z podpisu: Content-ID wewnątrz multipart/related) i obrazy < 20 KB nie są
 * dokumentami. PDF-y nigdy nie są pomijane ze względu na dyspozycję/rozmiar minimalny.
 *
 * Jeden przebieg naraz (blokada modułowa) — poller i „Sprawdź teraz” nie mogą działać równolegle.
 * Nigdy nie rzuca — błędy trafiają do `ImapSettings.last_error` i do wyniku.
 */
import { ImapFlow, type MessageStructureObject } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { processCostDocument, MAX_FILE_BYTES, normalizeMime } from '../routes/cost-documents'
import { getImapSettings, saveImapSettings } from '../settings-store'
import { forEachCompany } from '../middleware/tenant'

export interface ImapCheckResult {
  fetched: number   // przejrzane wiadomości
  created: number   // utworzone dokumenty
  skipped: number   // załączniki pominięte (już istniały)
  error?: string
}

const FIRST_RUN_DAYS = 14
export const MAX_MESSAGES_PER_RUN = 30
/** Wiadomości większe niż to nie są pobierane wcale (rozmiar z RFC822.SIZE). */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024
/** Obrazy mniejsze niż to (logo, ikony z podpisu) nie są dokumentami. PDF-ów nie dotyczy. */
export const MIN_IMAGE_BYTES = 20 * 1024
/** Rozmiar części w BODYSTRUCTURE jest ZAKODOWANY (base64 ≈ 1,37×) — próg 10 MB dotyczy treści po dekodowaniu. */
const ENCODED_OVERHEAD = 1.4
const CONNECT_TIMEOUT_MS = 30_000
export const IMAP_BUSY_ERROR = 'Sprawdzanie skrzynki już trwa'

function now(): string { return new Date().toISOString() }

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

export interface ImapConnParams { host: string; port: number; secure: boolean; user: string; pass: string }

/** Tworzy klienta ImapFlow z ustawień (bez logowania do konsoli). */
export function createImapClient(p: ImapConnParams): ImapFlow {
  return new ImapFlow({
    host: p.host,
    port: p.port,
    secure: p.secure,
    auth: { user: p.user, pass: p.pass },
    logger: false,
  })
}

function fromAddress(mail: ParsedMail): string {
  const f: any = mail.from
  return String(f?.text ?? f?.value?.[0]?.address ?? '').slice(0, 200)
}

function extForMime(mime: string): string {
  return ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mime] ?? 'bin'
}

// ─── Czyste reguły filtrowania (testowane) ────────────────────────────────────

export interface AttachmentInfo {
  contentType?: string
  filename?: string
  /** mailparser: Content-ID wewnątrz multipart/related — obraz osadzony w HTML (logo z podpisu). */
  related?: boolean
  /** rozmiar treści PO dekodowaniu (bajty) */
  size: number
}

export type AttachmentSkip = 'mime' | 'empty' | 'too_large' | 'inline_image' | 'small_image'

/**
 * Decyduje, czy załącznik (już sparsowany) staje się dokumentem. `skip` = powód pominięcia.
 * Obrazy: pomijane gdy osadzone w HTML (`related`) lub < 20 KB. PDF: tylko limit 10 MB.
 * Uwaga: nie filtrujemy po samym `Content-Disposition: inline` — Apple Mail/iPhone wysyła tak prawdziwe
 * zdjęcia paragonów i PDF-y; logo z podpisu odróżnia `multipart/related` (+ Content-ID) i mały rozmiar.
 */
export function classifyAttachment(att: AttachmentInfo): { mime: string; skip?: AttachmentSkip } {
  const mime = normalizeMime(att.contentType, att.filename)
  if (!mime) return { mime: '', skip: 'mime' }
  if (!(att.size > 0)) return { mime, skip: 'empty' }
  if (att.size > MAX_FILE_BYTES) return { mime, skip: 'too_large' }
  if (mime !== 'application/pdf') {
    if (att.related === true) return { mime, skip: 'inline_image' }
    if (att.size < MIN_IMAGE_BYTES) return { mime, skip: 'small_image' }
  }
  return { mime }
}

/**
 * Czy BODYSTRUCTURE (bez pobierania treści) zawiera choć jedną część, która może stać się dokumentem.
 * Brak struktury (serwer jej nie zwrócił) → `true` (decyzja po sparsowaniu). Załączone wiadomości
 * (message/rfc822) nie są rozwijane — mailparser też ich nie rozwija.
 */
export function structureHasCandidate(node: MessageStructureObject | undefined | null): boolean {
  if (!node) return true
  const walk = (n: MessageStructureObject, inRelated: boolean): boolean => {
    const type = String(n.type ?? '').toLowerCase()
    if (type === 'message/rfc822') return false
    if (Array.isArray(n.childNodes) && n.childNodes.length) {
      const rel = inRelated || type === 'multipart/related'
      return n.childNodes.some((c) => walk(c, rel))
    }
    const fileName = n.dispositionParameters?.filename ?? n.parameters?.name ?? ''
    const mime = normalizeMime(type, fileName)
    if (!mime) return false
    const encoded = Number(n.size) || 0
    if (encoded > MAX_FILE_BYTES * ENCODED_OVERHEAD) return false
    if (mime !== 'application/pdf') {
      if (inRelated && n.id) return false                     // logo osadzone w HTML (cid)
      if (encoded > 0 && encoded < MIN_IMAGE_BYTES) return false // zakodowany < 20 KB ⇒ zdekodowany też
    }
    return true
  }
  return walk(node, false)
}

// ─── Przebieg ─────────────────────────────────────────────────────────────────

let running = false

/** Czy trwa sprawdzanie skrzynki (poller lub „Sprawdź teraz”). */
export function isImapCheckRunning(): boolean { return running }

/**
 * Sprawdza skrzynkę i tworzy dokumenty z załączników. Zwraca statystyki; nigdy nie rzuca.
 * Działa, gdy host/user/pass są ustawione (także przy `enabled=false` — „Sprawdź teraz” z ustawień).
 * Gdy inny przebieg już trwa → `{ error: IMAP_BUSY_ERROR }` bez dotykania skrzynki.
 */
export async function checkImapInbox(): Promise<ImapCheckResult> {
  const result: ImapCheckResult = { fetched: 0, created: 0, skipped: 0 }
  if (running) { result.error = IMAP_BUSY_ERROR; return result }
  running = true
  try {
    await runImapCheck(result)
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 500)
    console.error('[IMAP] Nieoczekiwany błąd przebiegu:', error)
    result.error = result.error || error
  } finally {
    running = false
  }
  return result
}

/**
 * Sparsowana wiadomość → dokumenty (status `processing`, AI później). Id utworzonych dokumentów dopisuje do
 * `createdIds` OD RAZU po `create` — błąd przy kolejnym załączniku nie gubi już utworzonych (musiałyby
 * zostać w `processing` bez odczytu).
 */
async function ingestMessage(uid: number, source: Buffer, host: string, folder: string, result: ImapCheckResult, createdIds: string[]): Promise<void> {
  // keepCidLinks: nie wklejaj obrazów cid do HTML jako data: URI (kolejna kopia base64 w pamięci — nie używamy HTML)
  const mail = await simpleParser(source, { keepCidLinks: true })
  const from = fromAddress(mail)
  const subject = String(mail.subject ?? '').slice(0, 300)
  const attachments = mail.attachments ?? []
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    const content: Buffer = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content ?? '')
    const { mime, skip } = classifyAttachment({ contentType: att.contentType, filename: att.filename, related: att.related, size: content.length })
    if (skip) {
      if (skip !== 'mime') console.log(`[IMAP] UID ${uid}: pominięto załącznik „${att.filename ?? ''}” (${skip}, ${content.length} B)`)
      continue
    }

    const emailUid = `${host}|${folder}|${uid}|${i}`
    const exists = await prisma.costDocument.findFirst({ where: { email_uid: emailUid }, select: { id: true } })
    if (exists) { result.skipped++; continue }

    const id = uuidv4()
    await prisma.costDocument.create({
      data: {
        id, source: 'email', status: 'processing',
        file_name: String(att.filename || `zalacznik-${uid}-${i + 1}.${extForMime(mime)}`).slice(0, 200),
        mime_type: mime,
        file_data: content.toString('base64'),
        email_uid: emailUid, email_from: from, email_subject: subject,
        created_by: 'imap', created_at: now(),
      },
    })
    createdIds.push(id)
    result.created++
  }
}

async function runImapCheck(result: ImapCheckResult): Promise<void> {
  let settings: any
  try {
    settings = await getImapSettings()
  } catch (e: any) {
    result.error = `Błąd bazy: ${e?.message ?? e}`
    return
  }
  if (!settings || !settings.host || !settings.user || !settings.pass) {
    result.error = 'Skrzynka e-mail nie jest skonfigurowana (host, login, hasło)'
    return
  }

  const host = String(settings.host)
  const folder = String(settings.folder || 'INBOX')
  const lastUid = Number(settings.last_uid) || 0
  const client = createImapClient({ host, port: Number(settings.port) || 993, secure: settings.secure !== false, user: settings.user, pass: settings.pass })
  client.on('error', (e: any) => console.error('[IMAP] Błąd połączenia:', e?.message ?? e))

  let maxUid = lastUid
  const createdIds: string[] = []
  /** Postęp po KAŻDEJ wiadomości — restart (np. po OOM) nie wraca do tego samego zestawu. */
  const saveProgress = async (uid: number): Promise<void> => {
    if (uid <= maxUid) return
    maxUid = uid
    try {
      await saveImapSettings({ last_uid: maxUid, last_checked_at: now() })
    } catch (e: any) {
      console.error('[IMAP] Błąd zapisu postępu:', e?.message ?? e)
    }
  }

  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'Przekroczono czas łączenia z serwerem IMAP')
    const lock = await client.getMailboxLock(folder)
    try {
      const range: any = lastUid > 0
        ? `${lastUid + 1}:*`
        : { since: new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000) }

      // 1. Tylko metadane (UID, rozmiar, struktura) — bez treści. W trakcie iteracji nie wolno wysyłać
      //    innych komend (kolejka ImapFlow), więc pobieranie źródeł jest osobnym krokiem.
      const candidates: Array<{ uid: number; download: boolean; reason: string }> = []
      for await (const msg of client.fetch(range, { uid: true, size: true, bodyStructure: true }, { uid: true })) {
        // `N:*` zwraca też ostatnią wiadomość, gdy nie ma nowszych — filtruj po UID
        if (msg.uid <= lastUid) continue
        const size = Number(msg.size) || 0
        let download = true
        let reason = ''
        if (size > MAX_MESSAGE_BYTES) { download = false; reason = `wiadomość ${Math.round(size / 1048576)} MB > ${MAX_MESSAGE_BYTES / 1048576} MB` }
        else if (!structureHasCandidate(msg.bodyStructure)) { download = false; reason = 'brak załącznika PDF/obraz' }
        candidates.push({ uid: msg.uid, download, reason })
        if (candidates.length >= MAX_MESSAGES_PER_RUN) break
      }
      candidates.sort((a, b) => a.uid - b.uid)

      // 2. Po jednej wiadomości: źródło → załączniki → dokumenty → postęp. Bufor = jedna wiadomość.
      for (const c of candidates) {
        result.fetched++
        if (c.download) {
          // Błąd fetchOne (zerwane połączenie) przerywa przebieg BEZ przesuwania last_uid — patrz catch niżej.
          const msg = await client.fetchOne(String(c.uid), { uid: true, source: { maxLength: MAX_MESSAGE_BYTES + 1 } }, { uid: true })
          const source = msg && msg.source
          if (!source || !source.length) {
            console.log(`[IMAP] UID ${c.uid}: brak źródła — pominięto`)
          } else if (source.length > MAX_MESSAGE_BYTES) {
            console.log(`[IMAP] UID ${c.uid}: wiadomość > ${MAX_MESSAGE_BYTES / 1048576} MB — pominięto`)
          } else {
            try {
              await ingestMessage(c.uid, source, host, folder, result, createdIds)
            } catch (e: any) {
              console.error('[IMAP] Błąd przetwarzania wiadomości UID', c.uid, e?.message ?? e)
            }
          }
        } else if (c.reason) {
          console.log(`[IMAP] UID ${c.uid}: ${c.reason} — pominięto`)
        }
        await saveProgress(c.uid)
      }
    } finally {
      lock.release()
    }
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 500)
    console.error('[IMAP] Błąd pobierania wiadomości:', error)
    result.error = error
    try { await saveImapSettings({ last_checked_at: now(), last_error: error }) } catch { /* ignoruj */ }
    try { await client.logout() } catch { /* ignoruj */ }
    // dokumenty utworzone przed błędem i tak muszą przejść odczyt AI
    await processCreated(createdIds)
    return
  }
  try { await client.logout() } catch { /* ignoruj */ }

  // 3. Odczyt AI po rozłączeniu (każdy dokument do 60 s — nie trzymamy w tym czasie połączenia IMAP)
  await processCreated(createdIds)

  try {
    await saveImapSettings({ last_uid: maxUid, last_checked_at: now(), last_error: '' })
  } catch (e: any) {
    console.error('[IMAP] Błąd zapisu ustawień:', e?.message ?? e)
  }
}

/** AI → NBP → duplikaty dla utworzonych dokumentów (sekwencyjnie; błąd jednego nie zatrzymuje reszty). */
async function processCreated(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await processCostDocument(id)
    } catch (e: any) {
      console.error('[IMAP] Błąd odczytu dokumentu', id, e?.message ?? e)
    }
  }
}

// ─── Poller ───────────────────────────────────────────────────────────────────

const POLL_FIRST_DELAY_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 15 * 60 * 1000

async function pollOnce(): Promise<void> {
  if (running) return // trwa „Sprawdź teraz” lub poprzedni przebieg — blokada właściwa jest w checkImapInbox
  try {
    const s = await getImapSettings()
    if (!s?.enabled || !s.host) return
    const r = await checkImapInbox()
    if (r.error === IMAP_BUSY_ERROR) return
    if (r.error) console.error('[IMAP] Sprawdzenie skrzynki:', r.error)
    else if (r.fetched || r.created) console.log(`[IMAP] Skrzynka: wiadomości ${r.fetched}, nowe dokumenty ${r.created}, pominięte ${r.skipped}`)
  } catch (e: any) {
    console.error('[IMAP] Poller:', e?.message ?? e)
  }
}

/** Uruchamia cykliczne sprawdzanie skrzynki: 5 min po starcie, potem co 15 min (tylko gdy `enabled`). */
export function startImapPoller(): void {
  // każda aktywna firma ma własną skrzynkę (ImapSettings per firma)
  const tick = () => { void forEachCompany(() => pollOnce()) }
  setTimeout(() => {
    tick()
    setInterval(tick, POLL_INTERVAL_MS)
  }, POLL_FIRST_DELAY_MS)
  console.log('[IMAP] Poller skrzynki kosztów uruchomiony (pierwsze sprawdzenie za 5 min, potem co 15 min)')
}
