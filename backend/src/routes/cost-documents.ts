/**
 * Skrzynka kosztów — dokumenty spoza KSeF (faktury zagraniczne, paragony, subskrypcje, noty).
 *
 * Źródła: upload z przeglądarki (multipart), telefon (JSON base64, source='mobile'), e-mail IMAP
 * (`services/cost-inbox-imap.ts`). Każdy dokument przechodzi potok `processCostDocument()`:
 *   1. odczyt AI (`services/cost-extract.ts`, timeout 60 s) → pola sprzedawcy, kwoty, sugerowana kategoria,
 *   2. kurs NBP (`services/nbp-rates.ts`) → net_pln / gross_pln,
 *   3. wykrywanie duplikatów (`services/cost-duplicates.ts`) → duplicate_of / duplicate_note,
 *   status → `pending` (albo `error` + extract_error — pola do ręcznego uzupełnienia).
 * `POST /` i `POST /:id/reextract` odpowiadają od razu 202 (status `processing`), a potok biegnie w tle
 * (`queueProcessing`) — proxy ucina połączenia po ~30 s, a odczyt AI trwa do 60 s. Klient odpytuje `GET /:id`.
 *
 * Zatwierdzenie (`POST /:id/approve`) tworzy `ManualCost` (source='document', pnl_mode='include'),
 * który wchodzi do RZiS — atomowo (transakcja + warunkowa zmiana statusu, żeby dwa równoległe
 * zatwierdzenia nie utworzyły dwóch kosztów). Kwota kosztu: netto, gdy VAT jest odliczalny (polski NIP,
 * nie paragon, VAT > 0); inaczej brutto (paragon bez NIP nabywcy, faktura zagraniczna z lokalnym VAT).
 * Odrzucenie usuwa ten koszt; przelew MT940 wykluczony przy „zatwierdź mimo to” wraca do trybu z reguły bankowej.
 *
 * Dostęp: `POST /`, `GET /mine`, `GET /:id` (autor — widok zawężony) — każdy zalogowany (pracownik wysyła paragon
 * z telefonu); `GET /:id/file` — księgowość (requirePayments) lub autor; reszta — requirePayments; DELETE — admin.
 */
import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import db, { prisma } from '../db'
import { requireAdmin } from '../middleware/auth'
import { requirePayments } from './payables'
import { extractCostDocument, subcategoryToCategory, EXTRACT_SUBCATEGORIES, normalizeDate, toNumber, type Extracted } from '../services/cost-extract'
import { getNbpRate } from '../services/nbp-rates'
import { findDuplicate, nipDigits, type DupContext, type DuplicateHit } from '../services/cost-duplicates'

const router = Router()

// ─── Stałe ────────────────────────────────────────────────────────────────────

export const MAX_FILE_BYTES = 10 * 1024 * 1024
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const COST_CATEGORIES = new Set(['cogs', 'sales', 'ga', 'operations', 'financial'])
const BUSINESS_UNITS = new Set(['shc', 'gatelynk', 'shared'])
const DOC_STATUSES = new Set(['pending', 'approved', 'rejected', 'error', 'processing'])
const EXTRACT_TIMEOUT_MS = 60_000

/** Wszystkie pola dokumentu poza `file_data` (pliki do 10 MB — nigdy w listach). */
export const DOC_SELECT = {
  id: true, source: true, status: true, file_name: true, mime_type: true,
  extracted: true, extract_error: true,
  seller_name: true, seller_nip: true, seller_country: true, doc_number: true, doc_date: true,
  currency: true, net: true, vat: true, gross: true, fx_rate: true, fx_date: true, net_pln: true, gross_pln: true,
  cost_category: true, subcategory: true, business_unit: true, is_receipt: true, confidence: true,
  duplicate_of: true, duplicate_note: true, manual_cost_id: true,
  email_from: true, email_subject: true, email_uid: true, notes: true,
  created_by: true, created_at: true, reviewed_by: true, reviewed_at: true,
} as const

/**
 * Widok dla autora dokumentu (pracownik bez dostępu do Płatności): bez `duplicate_note` (zawiera datę, kwotę
 * i tytuł przelewu z wyciągu / numer faktury KSeF), bez surowego `extracted`, bez pól e-maila i bez surowego
 * komunikatu błędu API (`extract_error` → stały tekst). Pełny `DOC_SELECT` tylko pod requirePayments.
 */
const { extracted: _sx, duplicate_note: _sdn, email_from: _sef, email_subject: _ses, email_uid: _seu, ...MINE_SELECT } = DOC_SELECT
const EMPLOYEE_HIDDEN_KEYS = ['extracted', 'duplicate_note', 'email_from', 'email_subject', 'email_uid'] as const
export const EMPLOYEE_EXTRACT_ERROR = 'Nie udało się odczytać dokumentu — księgowa uzupełni go ręcznie.'

export function employeeView<T extends Record<string, any>>(doc: T): Record<string, any> {
  const out: Record<string, any> = { ...doc }
  for (const k of EMPLOYEE_HIDDEN_KEYS) delete out[k]
  if (out.extract_error) out.extract_error = EMPLOYEE_EXTRACT_ERROR
  return out
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } })

function now(): string { return new Date().toISOString() }
function r2(n: number): number { return Math.round(n * 100) / 100 }

// ─── Czyste reguły: kwota kosztu, znacznik „wykluczony przez dokument” ────────

/**
 * Kwota, która wchodzi do RZiS z dokumentu: NETTO tylko, gdy VAT jest odliczalny — polski NIP sprzedawcy
 * (10 cyfr), nie paragon i VAT > 0. W pozostałych przypadkach (paragon bez NIP nabywcy, faktura zagraniczna
 * z lokalnym VAT, brak NIP, VAT = 0) VAT jest kosztem firmy → BRUTTO.
 */
export function pnlAmountForDocument(d: { seller_nip?: string | null; is_receipt?: boolean | null; vat?: number | null; net_pln?: number | null; gross_pln?: number | null }): number {
  return Number(isVatDeductible(d) ? d.net_pln : d.gross_pln) || 0
}
export function isVatDeductible(d: { seller_nip?: string | null; is_receipt?: boolean | null; vat?: number | null }): boolean {
  return nipDigits(d.seller_nip).length === 10 && !d.is_receipt && (Number(d.vat) || 0) > 0
}

const EXCLUDED_BY_DOC = 'wykluczony przez dokument'
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Znacznik w notatce przelewu MT940: który dokument go wykluczył i jaki tryb miał wcześniej. */
export function excludedByDocumentMarker(docId: string, prevMode: string): string {
  return `${EXCLUDED_BY_DOC} ${docId} (wcześniej: ${prevMode || 'auto'})`
}
/** Poprzedni pnl_mode ze znacznika dla `docId` albo null, gdy ten dokument nie wykluczył przelewu. */
export function parseExcludedByDocument(notes: string | null | undefined, docId: string): string | null {
  const m = new RegExp(`${EXCLUDED_BY_DOC} ${escapeRe(docId)}(?: \\(wcześniej: ([a-z]+)\\))?`).exec(String(notes ?? ''))
  return m ? (m[1] || 'auto') : null
}
export function stripExcludedByDocument(notes: string | null | undefined, docId: string): string {
  return String(notes ?? '')
    .replace(new RegExp(`\\s*(?:·\\s*)?${EXCLUDED_BY_DOC} ${escapeRe(docId)}(?: \\(wcześniej: [a-z]+\\))?`, 'g'), '')
    .replace(/^\s*·\s*/, '')
    .trim()
}
export function appendNote(notes: string | null | undefined, add: string): string {
  return [String(notes ?? '').trim(), add].filter(Boolean).join(' · ').slice(0, 2000)
}

const NBP_FAIL_NOTE_RE = /Nie udało się pobrać kursu NBP dla [A-Z]{3} — popraw datę\/walutę lub wpisz kwoty w PLN\.?\s*(?:·\s*)?/
function nbpFailNote(currency: string): string {
  return `Nie udało się pobrać kursu NBP dla ${currency} — popraw datę/walutę lub wpisz kwoty w PLN.`
}
/** Usuwa automatyczną notatkę o braku kursu (gdy kurs w końcu się pobrał). */
export function stripNbpFailNote(notes: string | null | undefined): string {
  return String(notes ?? '').replace(new RegExp(NBP_FAIL_NOTE_RE.source, 'g'), '').replace(/\s*·\s*$/, '').trim()
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** Typ MIME → znormalizowany i dozwolony ('' gdy nieobsługiwany). Gdy brak/ogólny — wnioskuj z rozszerzenia. */
export function normalizeMime(mime: string | undefined, fileName: string | undefined): string {
  let m = String(mime ?? '').toLowerCase().split(';')[0].trim()
  if (m === 'image/jpg' || m === 'image/pjpeg') m = 'image/jpeg'
  if (ALLOWED_MIME.has(m)) return m
  const ext = String(fileName ?? '').toLowerCase().split('.').pop() ?? ''
  const byExt: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
  return byExt[ext] ?? ''
}

/** multer dekoduje nazwę pliku jako latin1 — napraw polskie znaki, gdy widać mojibake. */
function fixFileName(name: string): string {
  const n = String(name ?? '')
  if (!/[ÃÅÄÂ]/.test(n)) return n
  const fixed = Buffer.from(n, 'latin1').toString('utf8')
  return fixed.includes('�') ? n : fixed
}

function shiftDate(iso: string, days: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

// ─── Potok: kurs NBP + duplikaty ──────────────────────────────────────────────

interface FxFields { fx_rate: number; fx_date: string; net_pln: number; gross_pln: number }

/** Przelicza kwoty dokumentu na PLN. Waluta ≠ PLN bez kursu → rate 0 i kwoty PLN = 0 (blokuje zatwierdzenie). */
export async function computeFx(currency: string, docDate: string, net: number, gross: number): Promise<FxFields> {
  const cur = String(currency || 'PLN').toUpperCase()
  if (cur === 'PLN') return { fx_rate: 1, fx_date: docDate || '', net_pln: r2(net), gross_pln: r2(gross) }
  const { rate, date } = await getNbpRate(cur, docDate || now().slice(0, 10))
  if (!(rate > 0)) return { fx_rate: 0, fx_date: '', net_pln: 0, gross_pln: 0 }
  return { fx_rate: rate, fx_date: date, net_pln: r2(net * rate), gross_pln: r2(gross * rate) }
}

interface DupDocFields { id: string; seller_name: string; seller_nip: string; doc_number: string; doc_date: string; gross_pln: number }

/** Buduje kontekst z bazy (wąski pre-filtr) i uruchamia czystą funkcję `findDuplicate`. */
export async function computeDuplicate(doc: DupDocFields): Promise<DuplicateHit | null> {
  const nip = nipDigits(doc.seller_nip)
  const num = String(doc.doc_number ?? '').trim()
  const gross = Number(doc.gross_pln) || 0
  const digitsRun = (num.match(/\d{3,}/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? ''

  const ksefOr: any[] = []
  if (nip) ksefOr.push({ seller_nip: { contains: nip } })
  if (num) ksefOr.push({ invoice_number: { equals: num, mode: 'insensitive' } })
  if (digitsRun) ksefOr.push({ invoice_number: { contains: digitsRun } })
  if (gross > 0) ksefOr.push({ gross_amount: { gte: gross - 0.02, lte: gross + 0.02 } })

  const tolerance = Math.max(2, gross * 0.02)
  const dateFilter = doc.doc_date ? { date: { gte: shiftDate(doc.doc_date, -60), lte: shiftDate(doc.doc_date, 60) } } : {}

  const [ksefIncoming, mt940Costs, documents] = await Promise.all([
    ksefOr.length
      ? prisma.ksefInvoice.findMany({
          where: { invoice_direction: 'incoming', OR: ksefOr },
          select: { id: true, seller_nip: true, seller_name: true, invoice_number: true, gross_amount: true, invoice_date: true },
          take: 200,
        })
      : Promise.resolve([]),
    // Uwaga: przelewów z pnl_mode='exclude' NIE odfiltrowujemy — inaczej drugi egzemplarz tej samej faktury
    // (inny odczyt numeru) nie zobaczyłby przelewu „zajętego” przez pierwszy dokument i przeszedłby bez ostrzeżenia.
    gross > 0
      ? prisma.manualCost.findMany({
          where: { source: 'mt940', amount: { gte: gross - tolerance, lte: gross + tolerance }, ...dateFilter },
          select: { id: true, date: true, amount: true, description: true, reference: true, pnl_mode: true },
          take: 200,
        })
      : Promise.resolve([]),
    num
      ? prisma.costDocument.findMany({
          where: { id: { not: doc.id }, status: { notIn: ['rejected'] } },
          select: { id: true, seller_name: true, seller_nip: true, doc_number: true, gross_pln: true, status: true },
          orderBy: { created_at: 'desc' },
          take: 500,
        })
      : Promise.resolve([]),
  ])

  const ctx: DupContext = { ksefIncoming, mt940Costs, documents }
  const hit = findDuplicate({ id: doc.id, seller_name: doc.seller_name, seller_nip: doc.seller_nip, doc_number: doc.doc_number, doc_date: doc.doc_date, gross_pln: gross }, ctx)

  // Trafiony przelew jest już wykluczony przez inny zatwierdzony dokument → to ten dokument jest duplikatem
  // (nie przelew); „zatwierdź mimo to” nie wykluczy wtedy przelewu po raz drugi ani nie policzy kosztu 2×.
  if (hit && hit.duplicate_of.startsWith('mt940:')) {
    const mt = mt940Costs.find((c) => `mt940:${c.id}` === hit.duplicate_of)
    if (mt && mt.pnl_mode === 'exclude') {
      const owner = await prisma.costDocument.findFirst({
        where: { status: 'approved', duplicate_of: hit.duplicate_of, id: { not: doc.id } },
        select: { id: true, doc_number: true, seller_name: true, gross_pln: true },
        orderBy: { reviewed_at: 'desc' },
      })
      if (owner) {
        const amountTxt = `${new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(owner.gross_pln) || 0)} zł`
        return {
          duplicate_of: `document:${owner.id}`,
          note: `Przelew z wyciągu (${mt.date}, „${String(mt.description).slice(0, 80)}”) jest już rozliczony zatwierdzonym dokumentem ${owner.doc_number || owner.seller_name || owner.id} (${amountTxt}). Prawdopodobnie ten koszt jest już policzony — nie zatwierdzaj go drugi raz.`,
        }
      }
    }
  }
  return hit
}

/**
 * Pełny potok dla dokumentu: odczyt AI → NBP → duplikaty → status pending/error.
 * Używane przez POST /, POST /:id/reextract i skrzynkę IMAP. Zwraca dokument bez file_data (null gdy nie istnieje).
 */
export async function processCostDocument(id: string) {
  const doc = await prisma.costDocument.findUnique({ where: { id } })
  if (!doc) return null

  let extracted: Extracted | null = null
  let extractError = ''
  try {
    const buffer = Buffer.from(doc.file_data, 'base64')
    if (!buffer.length) throw new Error('Pusty plik')
    extracted = await withTimeout(
      extractCostDocument({ buffer, mimeType: doc.mime_type, fileName: doc.file_name, timeoutMs: EXTRACT_TIMEOUT_MS - 5000 }),
      EXTRACT_TIMEOUT_MS,
      'Przekroczono czas odczytu dokumentu (60 s) — spróbuj „Odczytaj ponownie”',
    )
  } catch (e: any) {
    extractError = String(e?.message ?? e).slice(0, 500)
    console.error('[Skrzynka kosztów] Błąd odczytu AI', id, extractError)
  }

  let patch: any
  if (extracted) {
    const subcategory = extracted.suggested_subcategory || 'other'
    patch = {
      extracted: extracted as any,
      extract_error: '',
      seller_name: extracted.seller_name,
      seller_nip: extracted.seller_nip,
      seller_country: extracted.seller_country,
      doc_number: extracted.doc_number,
      doc_date: extracted.doc_date,
      currency: extracted.currency,
      net: extracted.net,
      vat: extracted.vat,
      gross: extracted.gross,
      is_receipt: extracted.is_receipt,
      confidence: extracted.confidence,
      subcategory,
      cost_category: subcategoryToCategory(subcategory),
      status: 'pending',
    }
    const fx = await computeFx(extracted.currency, extracted.doc_date, extracted.net, extracted.gross)
    Object.assign(patch, fx)
    const dup = await computeDuplicate({ id, seller_name: extracted.seller_name, seller_nip: extracted.seller_nip, doc_number: extracted.doc_number, doc_date: extracted.doc_date, gross_pln: fx.gross_pln })
    patch.duplicate_of = dup?.duplicate_of ?? ''
    patch.duplicate_note = dup?.note ?? ''
    if (fx.fx_rate === 0) {
      patch.notes = doc.notes || nbpFailNote(extracted.currency)
    }
  } else {
    patch = { extract_error: extractError || 'Nieznany błąd odczytu', status: 'error' }
  }

  // Zapis tylko, gdy dokument nadal czeka na odczyt — potok biegnie w tle, a w międzyczasie ktoś mógł go
  // odrzucić/usunąć; wynik odczytu nie może nadpisać tej decyzji.
  const r = await prisma.costDocument.updateMany({ where: { id, status: 'processing' }, data: patch })
  if (r.count === 0) console.warn('[Skrzynka kosztów] Dokument zmienił status w trakcie odczytu — wynik pominięty', id)
  return prisma.costDocument.findUnique({ where: { id }, select: DOC_SELECT })
}

/**
 * Uruchamia potok w tle (odpowiedź HTTP idzie od razu). Każdy błąd poza odczytem AI (baza, NBP) kończy się
 * statusem `error` z komunikatem — dokument nigdy nie zostaje „wiecznie w odczycie”.
 */
export function queueProcessing(id: string): void {
  setImmediate(() => {
    processCostDocument(id).catch(async (e: any) => {
      const msg = String(e?.message ?? e).slice(0, 500)
      console.error('[Skrzynka kosztów] Błąd przetwarzania w tle', id, msg)
      try {
        await prisma.costDocument.updateMany({ where: { id, status: 'processing' }, data: { status: 'error', extract_error: msg || 'Nieznany błąd przetwarzania' } })
      } catch (e2) {
        console.error('[Skrzynka kosztów] Nie udało się zapisać błędu przetwarzania', id, e2)
      }
    })
  })
}

// ─── Walidacja pól edytowalnych (PUT / approve) ───────────────────────────────

const EDITABLE_KEYS = ['seller_name', 'seller_nip', 'seller_country', 'doc_number', 'doc_date', 'currency', 'net', 'vat', 'gross',
  'cost_category', 'subcategory', 'business_unit', 'notes', 'is_receipt'] as const

function validateEditable(body: any): { patch: Record<string, any>; error?: string } {
  const patch: Record<string, any> = {}
  if (!body || typeof body !== 'object') return { patch }
  for (const key of EDITABLE_KEYS) {
    if (body[key] === undefined) continue
    const v = body[key]
    switch (key) {
      case 'seller_name': patch[key] = String(v ?? '').trim().slice(0, 200); break
      case 'seller_nip': patch[key] = nipDigits(String(v ?? '')); break
      case 'seller_country': patch[key] = String(v ?? '').trim().toUpperCase().slice(0, 2); break
      case 'doc_number': patch[key] = String(v ?? '').trim().slice(0, 100); break
      case 'notes': patch[key] = String(v ?? '').slice(0, 2000); break
      case 'doc_date': {
        const s = String(v ?? '').trim()
        if (!s) { patch[key] = ''; break }
        const d = normalizeDate(s)
        if (!d) return { patch, error: 'Nieprawidłowa data dokumentu (oczekiwano YYYY-MM-DD)' }
        patch[key] = d; break
      }
      case 'currency': {
        const c = String(v ?? '').trim().toUpperCase()
        if (!/^[A-Z]{3}$/.test(c)) return { patch, error: 'Waluta musi być kodem ISO (np. PLN, EUR, USD)' }
        patch[key] = c; break
      }
      case 'net': case 'vat': case 'gross': {
        const n = typeof v === 'number' ? v : toNumber(String(v ?? ''))
        if (!Number.isFinite(n) || n < 0) return { patch, error: `Kwota „${key}” musi być liczbą ≥ 0` }
        patch[key] = r2(n); break
      }
      case 'cost_category': {
        const c = String(v ?? '').trim()
        if (!COST_CATEGORIES.has(c)) return { patch, error: 'Nieprawidłowa kategoria kosztu' }
        patch[key] = c; break
      }
      case 'subcategory': {
        const s = String(v ?? '').trim().toLowerCase()
        if (!/^[a-z0-9_]{2,60}$/.test(s)) return { patch, error: 'Nieprawidłowa podkategoria' }
        patch[key] = s; break
      }
      case 'business_unit': {
        const b = String(v ?? '').trim()
        if (!BUSINESS_UNITS.has(b)) return { patch, error: 'Nieprawidłowa jednostka biznesowa (shc / gatelynk / shared)' }
        patch[key] = b; break
      }
      case 'is_receipt': patch[key] = v === true || v === 'true' || v === 1 || v === '1'; break
    }
  }
  // Podkategoria bez kategorii → dobierz kategorię (tylko dla znanych kluczy skrzynki)
  if (patch.subcategory && patch.cost_category === undefined && EXTRACT_SUBCATEGORIES[patch.subcategory]) {
    patch.cost_category = subcategoryToCategory(patch.subcategory)
  }
  // Brakujące brutto/netto dopełniamy po scaleniu z dokumentem (patrz applyPatch)
  return { patch }
}

const AMOUNT_KEYS = new Set(['net', 'vat', 'gross', 'currency', 'doc_date'])
const DUP_KEYS = new Set(['net', 'vat', 'gross', 'currency', 'doc_date', 'seller_name', 'seller_nip', 'doc_number'])

/**
 * Scala patch z dokumentem, dopełnia kwoty i (gdy trzeba) przelicza NBP i duplikaty.
 * Kurs liczymy też wtedy, gdy waluta ≠ PLN a `fx_rate = 0` (NBP było niedostępne przy odczycie) — inaczej
 * dokument nie dałby się nigdy zatwierdzić bez sztucznej zmiany kwoty.
 */
async function applyPatch(doc: any, patch: Record<string, any>): Promise<Record<string, any>> {
  const merged: any = { ...doc, ...patch }
  const changed = Object.keys(patch).filter((k) => patch[k] !== doc[k])
  const amountsTouched = changed.some((k) => AMOUNT_KEYS.has(k))
  let dupTouched = changed.some((k) => DUP_KEYS.has(k))
  const out: Record<string, any> = { ...patch }
  const fxMissing = String(merged.currency || 'PLN').toUpperCase() !== 'PLN' && !(Number(merged.fx_rate) > 0)

  if (amountsTouched || fxMissing) {
    if (amountsTouched) {
      // Dopełnij brakujące kwoty: brutto = netto + VAT; netto = brutto − VAT
      if (patch.gross === undefined && (patch.net !== undefined || patch.vat !== undefined)) out.gross = r2((merged.net || 0) + (merged.vat || 0))
      else if (patch.net === undefined && patch.gross !== undefined) out.net = r2(Math.max(0, (merged.gross || 0) - (merged.vat || 0)))
      Object.assign(merged, out)
    }
    const fx = await computeFx(merged.currency, merged.doc_date, merged.net, merged.gross)
    Object.assign(out, fx)
    Object.assign(merged, fx)
    if (fxMissing && fx.fx_rate > 0) {
      dupTouched = true // dopiero teraz znamy gross_pln → duplikaty (MT940/KSeF) do przeliczenia
      // Automatyczna notatka „brak kursu” z odczytu jest już nieaktualna (inaczej trafiłaby do ManualCost.notes)
      if (patch.notes === undefined && NBP_FAIL_NOTE_RE.test(String(merged.notes ?? ''))) out.notes = merged.notes = stripNbpFailNote(merged.notes)
    }
  }
  if (dupTouched) {
    const dup = await computeDuplicate({ id: doc.id, seller_name: merged.seller_name, seller_nip: merged.seller_nip, doc_number: merged.doc_number, doc_date: merged.doc_date, gross_pln: merged.gross_pln })
    out.duplicate_of = dup?.duplicate_of ?? ''
    out.duplicate_note = dup?.note ?? ''
  }
  return out
}

// ─── Multer z obsługą błędu rozmiaru ──────────────────────────────────────────

function uploadSingle(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      const msg = err?.code === 'LIMIT_FILE_SIZE' ? 'Plik jest za duży — maksymalnie 10 MB' : `Błąd przesyłania pliku: ${err?.message ?? err}`
      res.status(400).json({ error: msg }); return
    }
    next()
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Trasy dla każdego zalogowanego
// ═══════════════════════════════════════════════════════════════════════════════

/** POST / — multipart `file` (upload) lub JSON { file_name, mime_type, data_base64, source:'mobile' }. */
router.post('/', uploadSingle, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    let buffer: Buffer | null = null
    let fileName = ''
    let mime = ''
    let source = 'upload'

    if (req.file) {
      buffer = req.file.buffer
      fileName = fixFileName(req.file.originalname)
      mime = normalizeMime(req.file.mimetype, fileName)
    } else if (req.body && typeof req.body.data_base64 === 'string' && req.body.data_base64) {
      const b64 = String(req.body.data_base64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
      buffer = Buffer.from(b64, 'base64')
      fileName = String(req.body.file_name || '').trim() || `dokument-${now().slice(0, 10)}.jpg`
      mime = normalizeMime(req.body.mime_type, fileName)
      source = req.body.source === 'mobile' ? 'mobile' : 'upload'
    }

    if (!buffer || !buffer.length) {
      res.status(400).json({ error: 'Brak pliku — wyślij pole „file” (multipart) albo data_base64 (JSON)' }); return
    }
    if (!mime) {
      res.status(400).json({ error: 'Nieobsługiwany typ pliku. Dozwolone: PDF, JPG, PNG, WEBP' }); return
    }
    if (buffer.length > MAX_FILE_BYTES) {
      res.status(400).json({ error: 'Plik jest za duży — maksymalnie 10 MB' }); return
    }

    const id = uuidv4()
    const doc = await prisma.costDocument.create({
      data: {
        id, source, status: 'processing',
        file_name: fileName.slice(0, 200), mime_type: mime, file_data: buffer.toString('base64'),
        created_by: String(user?.email ?? ''), created_at: now(),
      },
      select: MINE_SELECT,
    })
    // 202: odczyt AI (do 60 s) biegnie w tle — klient odpytuje GET /:id aż status ≠ 'processing'.
    // Synchroniczne czekanie kończyło się 502 z proxy (~30 s), a użytkownik wysyłał ten sam plik drugi raz.
    res.status(202).json(employeeView(doc))
    queueProcessing(id)
  } catch (e: any) {
    console.error('[Skrzynka kosztów] POST /', e)
    res.status(500).json({ error: 'Nie udało się zapisać dokumentu' })
  }
})

/** GET /mine — dokumenty przesłane przez zalogowanego użytkownika (telefon: „Moje przesłane”), widok zawężony. */
router.get('/mine', async (req: Request, res: Response) => {
  try {
    const email = String((req as any).user?.email ?? '')
    const docs = await prisma.costDocument.findMany({ where: { created_by: email }, orderBy: { created_at: 'desc' }, take: 100, select: MINE_SELECT })
    res.json(docs.map(employeeView))
  } catch (e) {
    console.error('[Skrzynka kosztów] GET /mine', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

/** Czy użytkownik ma dostęp do Płatności (admin lub can_view_payments). */
async function hasPaymentsAccess(userId: string): Promise<boolean> {
  const u: any = await db.users.find(userId)
  return !!u && (u.role === 'admin' || !!u.can_view_payments)
}

/** GET /stats — liczniki do nagłówka strony (księgowość). Musi być przed `/:id`. */
router.get('/stats', requirePayments, async (_req: Request, res: Response) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const [pending, error, approved_30d] = await Promise.all([
      prisma.costDocument.count({ where: { status: 'pending' } }),
      prisma.costDocument.count({ where: { status: 'error' } }),
      prisma.costDocument.count({ where: { status: 'approved', reviewed_at: { gte: cutoff } } }),
    ])
    res.json({ pending, error, approved_30d })
  } catch (e) {
    console.error('[Skrzynka kosztów] GET /stats', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

/** GET /:id — pojedynczy dokument bez pliku (odpytywanie po 202). Księgowość: pełny; autor: widok zawężony. */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const doc = await prisma.costDocument.findUnique({ where: { id: String(req.params.id) }, select: DOC_SELECT })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }
    const user = (req as any).user
    if (await hasPaymentsAccess(String(user?.id ?? ''))) { res.json(doc); return }
    if (doc.created_by && doc.created_by === user?.email) { res.json(employeeView(doc)); return }
    res.status(403).json({ error: 'Brak dostępu do tego dokumentu' })
  } catch (e) {
    console.error('[Skrzynka kosztów] GET /:id', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

/** GET /:id/file — binarny plik (inline). Dostęp: księgowość lub autor dokumentu. */
router.get('/:id/file', async (req: Request, res: Response) => {
  try {
    const doc = await prisma.costDocument.findUnique({
      where: { id: String(req.params.id) },
      select: { file_data: true, mime_type: true, file_name: true, created_by: true },
    })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }

    const user = (req as any).user
    let allowed = !!doc.created_by && doc.created_by === user?.email
    if (!allowed) allowed = await hasPaymentsAccess(String(user?.id ?? ''))
    if (!allowed) { res.status(403).json({ error: 'Brak dostępu do tego pliku' }); return }

    const buf = Buffer.from(doc.file_data || '', 'base64')
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name || 'dokument')}`)
    res.setHeader('Content-Length', String(buf.length))
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.end(buf)
  } catch (e) {
    console.error('[Skrzynka kosztów] GET /:id/file', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// Trasy dla księgowości (admin lub can_view_payments)
// ═══════════════════════════════════════════════════════════════════════════════
router.use(requirePayments)

/** GET /?status=pending|approved|rejected|error|all — lista bez plików (max 500). */
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = String(req.query.status ?? 'all')
    let where: any = {}
    if (status === 'pending') where = { status: { in: ['pending', 'processing'] } }
    else if (status !== 'all') {
      if (!DOC_STATUSES.has(status)) { res.status(400).json({ error: 'Nieprawidłowy status' }); return }
      where = { status }
    }
    const docs = await prisma.costDocument.findMany({ where, orderBy: { created_at: 'desc' }, take: 500, select: DOC_SELECT })
    res.json(docs)
  } catch (e) {
    console.error('[Skrzynka kosztów] GET /', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

/** PUT /:id — ręczna korekta pól; po zmianie kwot/waluty/daty przelicza NBP i duplikaty. */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id)
    const doc = await prisma.costDocument.findUnique({ where: { id }, select: DOC_SELECT })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }
    if (doc.status === 'approved') {
      res.status(409).json({ error: 'Dokument jest już zatwierdzony — aby go zmienić, najpierw odrzuć (koszt zostanie usunięty) i zatwierdź ponownie' }); return
    }
    if (doc.status === 'processing') {
      res.status(409).json({ error: 'Dokument jest jeszcze odczytywany — poczekaj chwilę (odczyt w tle nadpisałby zmiany)' }); return
    }
    const { patch, error } = validateEditable(req.body)
    if (error) { res.status(400).json({ error }); return }
    const data = await applyPatch(doc, patch)
    // Dokument z błędem odczytu po ręcznym uzupełnieniu kwot i daty → czeka na zatwierdzenie
    const merged = { ...doc, ...data }
    if (doc.status === 'error' && merged.doc_date && (merged.gross_pln > 0 || merged.net_pln > 0)) data.status = 'pending'
    const updated = await prisma.costDocument.update({ where: { id }, data, select: DOC_SELECT })
    res.json(updated)
  } catch (e) {
    console.error('[Skrzynka kosztów] PUT /:id', e)
    res.status(500).json({ error: 'Nie udało się zapisać zmian' })
  }
})

/** Sygnał z transakcji zatwierdzenia: ktoś inny zatwierdził dokument w międzyczasie (lub wrócił do odczytu). */
class ApproveConflict extends Error {}

/**
 * Po odrzuceniu/usunięciu dokumentu, który przy „zatwierdź mimo to” wykluczył przelew MT940: przywraca przelewowi
 * tryb sprzed wykluczenia — wg reguły bankowej (`bank_rule_id` → `BankRule.pnl_mode`), inaczej `auto`. Gdy przelew
 * był wykluczony już wcześniej (reguła „pomiń”, płatność za fakturę KSeF) — zostaje `exclude`. Ręczna decyzja
 * użytkownika („decyzja ręczna” w notes) nie jest nadpisywana. Znacznik z notes jest usuwany.
 */
async function restoreMt940AfterDocument(mtId: string, docId: string): Promise<void> {
  const cost = await prisma.manualCost.findUnique({ where: { id: mtId }, select: { source: true, pnl_mode: true, bank_rule_id: true, notes: true } })
  if (!cost || cost.source !== 'mt940') return
  const prev = parseExcludedByDocument(cost.notes, docId)
  if (prev === null) return // to nie ten dokument wykluczył przelew — nie ruszamy
  const notes = stripExcludedByDocument(cost.notes, docId)
  const data: { notes: string; pnl_mode?: string } = { notes }
  if (cost.pnl_mode === 'exclude' && !/decyzja ręczna/i.test(notes)) {
    if (prev === 'exclude') data.pnl_mode = 'exclude'
    else if (cost.bank_rule_id) {
      const rule = await prisma.bankRule.findUnique({ where: { id: cost.bank_rule_id }, select: { pnl_mode: true } })
      data.pnl_mode = rule?.pnl_mode ?? 'auto'
    } else data.pnl_mode = 'auto'
  }
  await prisma.manualCost.update({ where: { id: mtId }, data })
}

/** Usuwa koszt(y) utworzone z dokumentu — po `manual_cost_id` i po `document_id` (sprząta ewentualne sieroty). */
async function deleteDocumentCosts(docId: string, manualCostId: string | null): Promise<void> {
  const or: any[] = [{ document_id: docId, source: 'document' }]
  if (manualCostId) or.push({ id: manualCostId })
  await prisma.manualCost.deleteMany({ where: { OR: or } })
}

/** POST /:id/approve { force?, ...pola } — tworzy ManualCost (source=document, pnl_mode=include). */
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id)
    const user = (req as any).user
    const doc = await prisma.costDocument.findUnique({ where: { id }, select: DOC_SELECT })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }
    if (doc.status === 'approved') { res.status(409).json({ error: 'Dokument jest już zatwierdzony' }); return }
    if (doc.status === 'processing') { res.status(409).json({ error: 'Dokument jest jeszcze odczytywany — poczekaj chwilę' }); return }

    const body = req.body ?? {}
    const force = body.force === true || body.force === 'true'
    const { force: _f, ...overrides } = body
    const { patch, error } = validateEditable(overrides)
    if (error) { res.status(400).json({ error }); return }

    const data = await applyPatch(doc, patch)
    const merged: any = { ...doc, ...data }

    // Duplikaty liczymy zawsze na aktualnych danych (ręczna korekta mogła je rozwiązać)
    if (data.duplicate_of === undefined) {
      const dup = await computeDuplicate({ id, seller_name: merged.seller_name, seller_nip: merged.seller_nip, doc_number: merged.doc_number, doc_date: merged.doc_date, gross_pln: merged.gross_pln })
      merged.duplicate_of = data.duplicate_of = dup?.duplicate_of ?? ''
      merged.duplicate_note = data.duplicate_note = dup?.note ?? ''
    }

    if (!merged.doc_date) { res.status(400).json({ error: 'Uzupełnij datę dokumentu (YYYY-MM-DD)' }); return }
    if (String(merged.currency).toUpperCase() !== 'PLN' && !(merged.fx_rate > 0)) {
      // applyPatch już ponowił pobranie kursu — nadal brak → 409 (bez duplicate_of; frontend pokaże jako błąd)
      res.status(409).json({ error: `Brak kursu NBP dla ${merged.currency} — spróbuj później, popraw datę/walutę albo wpisz kwoty w PLN` }); return
    }
    const vatDeductible = isVatDeductible(merged)
    const amount = pnlAmountForDocument(merged)
    if (!(amount > 0)) { res.status(400).json({ error: 'Kwota kosztu musi być większa od zera — uzupełnij netto/brutto' }); return }
    if (!COST_CATEGORIES.has(merged.cost_category)) merged.cost_category = data.cost_category = subcategoryToCategory(merged.subcategory)

    if (merged.duplicate_of && !force) {
      res.status(409).json({ error: 'To wygląda na duplikat kosztu, który już jest w systemie. Jeśli to na pewno inny koszt — zatwierdź mimo to.', duplicate_of: merged.duplicate_of, duplicate_note: merged.duplicate_note })
      return
    }

    const extracted: any = merged.extracted ?? {}
    const label = [merged.seller_name, merged.doc_number].filter(Boolean).join(' · ')
    const description = (label || String(extracted?.description ?? '') || merged.file_name || 'Dokument spoza KSeF').slice(0, 500)
    const fxNote = String(merged.currency).toUpperCase() !== 'PLN'
      ? `${merged.currency} ${Number(merged.gross).toFixed(2)} × kurs NBP ${merged.fx_rate} z ${merged.fx_date}`
      : ''
    const vatNote = !vatDeductible && (Number(merged.vat) || 0) > 0 ? 'brutto (VAT nieodliczalny)' : ''
    const notes = [merged.notes, fxNote, merged.is_receipt ? 'Paragon' : '', vatNote].filter(Boolean).join(' · ').slice(0, 1000)

    const ts = now()
    const manualCostId = uuidv4()
    const mtId = force && String(merged.duplicate_of).startsWith('mt940:') ? String(merged.duplicate_of).slice('mt940:'.length) : ''

    // Atomowo: warunkowa zmiana statusu (blokuje wiersz; równoległe zatwierdzenie dostaje count=0 → 409),
    // potem ManualCost i ewentualne wykluczenie przelewu — wszystko albo nic (bez sierot przy błędzie).
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.costDocument.updateMany({
        where: { id, status: { notIn: ['approved', 'processing'] } },
        data: { ...data, status: 'approved', reviewed_by: String(user?.email ?? ''), reviewed_at: ts, manual_cost_id: manualCostId },
      })
      if (claimed.count !== 1) throw new ApproveConflict('Dokument został już zatwierdzony')

      await tx.manualCost.create({
        data: {
          id: manualCostId,
          date: merged.doc_date,
          description,
          amount: r2(amount),
          currency: 'PLN',
          cost_category: merged.cost_category,
          subcategory: merged.subcategory || 'other',
          business_unit: BUSINESS_UNITS.has(merged.business_unit) ? merged.business_unit : 'shc',
          period: merged.doc_date.slice(0, 7),
          notes,
          reference: String(merged.doc_number ?? '').slice(0, 200),
          source: 'document',
          pnl_mode: 'include',
          document_id: id,
          created_at: ts,
          created_by: String(user?.email ?? ''),
        },
      })

      // Zatwierdzenie „mimo to” przy duplikacie z wyciągu → przelew z MT940 wykluczamy z RZiS (koszt liczy dokument).
      // W notes zapisujemy, KTÓRY dokument go wykluczył i jaki tryb miał wcześniej — reject/DELETE przywraca go
      // wg reguły bankowej, a DELETE reguły / POST apply (bank-rules.ts) nie resetują takiego przelewu do 'auto'.
      if (mtId) {
        const mt = await tx.manualCost.findUnique({ where: { id: mtId }, select: { source: true, pnl_mode: true, notes: true } })
        if (mt && mt.source === 'mt940') {
          const hasMarker = parseExcludedByDocument(mt.notes, id) !== null
          await tx.manualCost.update({
            where: { id: mtId },
            data: { pnl_mode: 'exclude', notes: hasMarker ? mt.notes : appendNote(mt.notes, excludedByDocumentMarker(id, mt.pnl_mode)) },
          })
        }
      }
    })

    const updated = await prisma.costDocument.findUnique({ where: { id }, select: DOC_SELECT })
    res.json(updated)
  } catch (e) {
    if (e instanceof ApproveConflict) {
      res.status(409).json({ error: 'Dokument został w międzyczasie zatwierdzony przez kogoś innego (albo wrócił do odczytu) — odśwież listę' }); return
    }
    console.error('[Skrzynka kosztów] POST /:id/approve', e)
    res.status(500).json({ error: 'Nie udało się zatwierdzić dokumentu' })
  }
})

/** POST /:id/reject { reason? } — odrzuca; usuwa ManualCost, jeśli dokument był zatwierdzony. */
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id)
    const user = (req as any).user
    const doc = await prisma.costDocument.findUnique({ where: { id }, select: DOC_SELECT })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }

    const reason = String(req.body?.reason ?? '').trim().slice(0, 500)
    if (doc.manual_cost_id || doc.status === 'approved') {
      await deleteDocumentCosts(id, doc.manual_cost_id)
      // Jeśli zatwierdzenie wykluczyło przelew MT940 jako duplikat — przywróć mu tryb wg reguły bankowej (nie 'auto')
      if (String(doc.duplicate_of).startsWith('mt940:')) {
        await restoreMt940AfterDocument(String(doc.duplicate_of).slice('mt940:'.length), id)
      }
    }
    const notes = reason ? [doc.notes, `Odrzucono: ${reason}`].filter(Boolean).join('\n').slice(0, 2000) : doc.notes
    const updated = await prisma.costDocument.update({
      where: { id },
      data: { status: 'rejected', notes, manual_cost_id: null, reviewed_by: String(user?.email ?? ''), reviewed_at: now() },
      select: DOC_SELECT,
    })
    res.json(updated)
  } catch (e) {
    console.error('[Skrzynka kosztów] POST /:id/reject', e)
    res.status(500).json({ error: 'Nie udało się odrzucić dokumentu' })
  }
})

/** POST /:id/reopen — odrzucony dokument wraca do sprawdzenia (status pending). */
router.post('/:id/reopen', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id)
    const doc = await prisma.costDocument.findUnique({ where: { id }, select: { id: true, status: true } })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }
    if (doc.status !== 'rejected') { res.status(409).json({ error: 'Przywrócić do sprawdzenia można tylko odrzucony dokument' }); return }
    const updated = await prisma.costDocument.update({
      where: { id },
      data: { status: 'pending', manual_cost_id: null, reviewed_by: '', reviewed_at: '' },
      select: DOC_SELECT,
    })
    res.json(updated)
  } catch (e) {
    console.error('[Skrzynka kosztów] POST /:id/reopen', e)
    res.status(500).json({ error: 'Nie udało się przywrócić dokumentu' })
  }
})

/** POST /:id/reextract — ponowny odczyt AI w tle (202; nie dla zatwierdzonych). Klient odpytuje GET /:id. */
router.post('/:id/reextract', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id)
    const doc = await prisma.costDocument.findUnique({ where: { id }, select: { id: true, status: true } })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }
    if (doc.status === 'approved') { res.status(409).json({ error: 'Dokument jest zatwierdzony — najpierw go odrzuć' }); return }
    const updated = await prisma.costDocument.update({ where: { id }, data: { status: 'processing', extract_error: '' }, select: DOC_SELECT })
    res.status(202).json(updated)
    queueProcessing(id)
  } catch (e) {
    console.error('[Skrzynka kosztów] POST /:id/reextract', e)
    res.status(500).json({ error: 'Nie udało się ponownie odczytać dokumentu' })
  }
})

/** DELETE /:id — tylko admin; usuwa też koszt utworzony przy zatwierdzeniu. */
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id)
    const doc = await prisma.costDocument.findUnique({ where: { id }, select: { id: true, status: true, manual_cost_id: true, duplicate_of: true } })
    if (!doc) { res.status(404).json({ error: 'Dokument nie istnieje' }); return }
    if (doc.manual_cost_id || doc.status === 'approved') {
      await deleteDocumentCosts(id, doc.manual_cost_id)
      if (String(doc.duplicate_of).startsWith('mt940:')) {
        await restoreMt940AfterDocument(String(doc.duplicate_of).slice('mt940:'.length), id)
      }
    }
    await prisma.costDocument.delete({ where: { id } })
    res.json({ ok: true, id })
  } catch (e) {
    console.error('[Skrzynka kosztów] DELETE /:id', e)
    res.status(500).json({ error: 'Nie udało się usunąć dokumentu' })
  }
})

export default router
