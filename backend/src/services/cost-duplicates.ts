/**
 * Wykrywanie duplikatów dokumentu kosztowego (czysta logika, bez bazy).
 *
 * Dokument spoza KSeF może już istnieć w systemie jako:
 *  (a) faktura KSeF (ten sam NIP + kwota, albo ten sam numer + zbieżna nazwa sprzedawcy) → `ksef:<id>`,
 *  (c) inny dokument w skrzynce (ten sam numer i sprzedawca, status ≠ rejected)         → `document:<id>`,
 *  (b) przelew z wyciągu MT940 (kwota ±max(2 zł, 2 %), wspólny token nazwy, data ±60 dni) → `mt940:<manualCostId>`.
 *
 * Kolejność sprawdzania: (a) → (c) → (b). Powtórny upload tego samego dokumentu jest sygnałem silniejszym
 * niż podobny przelew — inaczej drugi egzemplarz zatwierdzony „mimo to" wykluczyłby przelew po raz drugi
 * i policzyłby koszt podwójnie.
 */

export interface DupDocInput {
  id?: string
  seller_name: string
  seller_nip: string
  doc_number: string
  doc_date: string      // YYYY-MM-DD ('' gdy brak)
  gross_pln: number
}

export interface DupKsefInvoice {
  id: string
  seller_nip: string | null
  seller_name: string | null
  invoice_number: string | null
  gross_amount: number
  invoice_date: string | null
}

export interface DupMt940Cost {
  id: string
  date: string
  amount: number
  description: string
  reference: string
}

export interface DupCostDocument {
  id: string
  seller_name: string
  seller_nip?: string
  doc_number: string
  gross_pln: number
  status: string
}

export interface DupContext {
  ksefIncoming: DupKsefInvoice[]
  mt940Costs: DupMt940Cost[]
  documents: DupCostDocument[]
}

export interface DuplicateHit {
  duplicate_of: string   // 'ksef:<id>' | 'mt940:<id>' | 'document:<id>'
  note: string
}

// ─── Normalizacja tekstu ──────────────────────────────────────────────────────

export function stripDiacritics(s: string): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
}

/** Same cyfry (NIP / VAT-ID bez prefiksu kraju). */
export function nipDigits(s: string | null | undefined): string {
  return String(s ?? '').replace(/\D/g, '')
}

/** Numer dokumentu → same znaki alfanumeryczne, małe litery (FV/2026/01/15 ≡ fv-2026-01-15). */
export function normalizeDocNumber(s: string | null | undefined): string {
  return stripDiacritics(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Słowa nic nie wnoszące do identyfikacji firmy — nie mogą być „wspólnym tokenem". */
const NAME_STOPWORDS = new Set([
  'spolka', 'spolki', 'akcyjna', 'jawna', 'komandytowa', 'cywilna', 'ograniczona', 'odpowiedzialnoscia',
  'company', 'limited', 'corporation', 'corp', 'gmbh', 'inc', 'firma', 'przedsiebiorstwo', 'handel', 'handlowa',
  'handlowy', 'handlowe', 'uslug', 'uslugi', 'uslugowa', 'uslugowy', 'uslugowe', 'sklep', 'store', 'shop', 'group', 'grupa',
  'przelew', 'platnosc', 'platnosci', 'faktura', 'faktury', 'invoice', 'payment', 'zaplata', 'oplata', 'tytulem',
  'numer', 'karta', 'transakcja', 'zakup', 'zakupy', 'online', 'internet', 'przelewy', 'nazwa', 'data',
])

/** Tokeny nazwy (≥ 4 litery, bez diakrytyków, bez cyfr, bez stop-słów). */
export function nameTokens(s: string | null | undefined): string[] {
  const norm = stripDiacritics(String(s ?? '')).toLowerCase()
  const parts = norm.split(/[^a-z]+/).filter((t) => t.length >= 4 && !NAME_STOPWORDS.has(t))
  return Array.from(new Set(parts))
}

/** Zbieżność nazw: równość po normalizacji, zawieranie się (≥ 4 zn.) albo wspólny token ≥ 4 liter. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = stripDiacritics(String(a ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '')
  const nb = stripDiacritics(String(b ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true
  return sharedToken(a, b) !== null
}

/** Pierwszy wspólny token (≥ 4 litery) albo null. */
export function sharedToken(a: string | null | undefined, b: string | null | undefined): string | null {
  const tb = new Set(nameTokens(b))
  for (const t of nameTokens(a)) if (tb.has(t)) return t
  return null
}

function daysBetween(a: string, b: string): number | null {
  const da = Date.parse(String(a ?? '').slice(0, 10))
  const db = Date.parse(String(b ?? '').slice(0, 10))
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null
  return Math.abs(da - db) / 86_400_000
}

function fmtPln(n: number): string {
  return `${new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} zł`
}

// ─── Reguły ───────────────────────────────────────────────────────────────────

/** (a) Faktura KSeF: ten sam NIP i kwota brutto ±0,02, lub ten sam numer i zbieżna nazwa. */
export function findKsefDuplicate(doc: DupDocInput, invoices: DupKsefInvoice[]): DuplicateHit | null {
  const nip = nipDigits(doc.seller_nip)
  const num = normalizeDocNumber(doc.doc_number)
  const gross = Number(doc.gross_pln) || 0
  for (const inv of invoices) {
    const invNip = nipDigits(inv.seller_nip)
    const byNipAmount = !!nip && nip === invNip && gross > 0 && Math.abs(gross - (Number(inv.gross_amount) || 0)) <= 0.02
    const invNum = normalizeDocNumber(inv.invoice_number)
    const byNumber = !!num && num === invNum && namesMatch(doc.seller_name, inv.seller_name)
    if (byNipAmount || byNumber) {
      const why = byNipAmount ? 'ten sam NIP i kwota' : 'ten sam numer i sprzedawca'
      return {
        duplicate_of: `ksef:${inv.id}`,
        note: `Ta faktura jest już w KSeF (${inv.invoice_number || 'bez numeru'}, ${inv.seller_name || 'sprzedawca nieznany'}, ${fmtPln(Number(inv.gross_amount) || 0)}) — ${why}. Nie zatwierdzaj, żeby nie policzyć kosztu dwa razy.`,
      }
    }
  }
  return null
}

/** (c) Inny dokument w skrzynce: ten sam numer i sprzedawca (NIP albo nazwa), status ≠ rejected. */
export function findDocumentDuplicate(doc: DupDocInput, documents: DupCostDocument[]): DuplicateHit | null {
  const num = normalizeDocNumber(doc.doc_number)
  if (!num) return null
  const nip = nipDigits(doc.seller_nip)
  for (const other of documents) {
    if (doc.id && other.id === doc.id) continue
    if (other.status === 'rejected') continue
    if (normalizeDocNumber(other.doc_number) !== num) continue
    const otherNip = nipDigits(other.seller_nip)
    const sameSeller = (!!nip && nip === otherNip) || namesMatch(doc.seller_name, other.seller_name)
    if (!sameSeller) continue
    const st = other.status === 'approved' ? 'już zatwierdzony' : other.status === 'pending' ? 'czeka na zatwierdzenie' : `status: ${other.status}`
    return {
      duplicate_of: `document:${other.id}`,
      note: `Dokument o tym numerze od tego sprzedawcy jest już w skrzynce (${st}, ${fmtPln(Number(other.gross_pln) || 0)}). Prawdopodobnie wgrano go dwa razy.`,
    }
  }
  return null
}

/** (b) Przelew MT940: kwota ±max(2 zł, 2 %), wspólny token nazwy z opisem, data ±60 dni. */
export function findMt940Duplicate(doc: DupDocInput, costs: DupMt940Cost[]): DuplicateHit | null {
  const gross = Number(doc.gross_pln) || 0
  if (gross <= 0) return null
  const tolerance = Math.max(2, gross * 0.02)
  let best: { cost: DupMt940Cost; diff: number; token: string } | null = null
  for (const c of costs) {
    const diff = Math.abs(Math.abs(Number(c.amount) || 0) - gross)
    if (diff > tolerance) continue
    const days = doc.doc_date ? daysBetween(doc.doc_date, c.date) : null
    if (doc.doc_date && (days === null || days > 60)) continue
    const token = sharedToken(doc.seller_name, `${c.description} ${c.reference}`)
    if (!token) continue
    if (!best || diff < best.diff) best = { cost: c, diff, token }
  }
  if (!best) return null
  return {
    duplicate_of: `mt940:${best.cost.id}`,
    note: `Prawdopodobnie ten sam koszt z wyciągu bankowego (${best.cost.date}, ${fmtPln(Math.abs(Number(best.cost.amount) || 0))}, „${best.cost.description.slice(0, 80)}”) — po zatwierdzeniu przelew zostanie oznaczony jako duplikat i nie policzy się dwa razy.`,
  }
}

/** Główna funkcja: pierwszy trafiony duplikat wg kolejności (a) KSeF → (c) dokument → (b) MT940, albo null. */
export function findDuplicate(doc: DupDocInput, ctx: DupContext): DuplicateHit | null {
  return findKsefDuplicate(doc, ctx.ksefIncoming ?? [])
    ?? findDocumentDuplicate(doc, ctx.documents ?? [])
    ?? findMt940Duplicate(doc, ctx.mt940Costs ?? [])
}
