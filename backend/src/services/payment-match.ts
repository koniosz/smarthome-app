/**
 * Płatności — kiedy przelew z wyciągu może AUTOMATYCZNIE oznaczyć fakturę kosztową jako opłaconą.
 * Czysty moduł (bez bazy) — testy: src/__tests__/payment-match.test.ts.
 *
 * Zasada nadrzędna: fałszywe „opłacone" jest gorsze niż jedno kliknięcie więcej. Nieopłacona faktura schowana
 * jako opłacona znika z listy „do zapłaty" — dlatego automat działa tylko wtedy, gdy NIE MA wątpliwości:
 *
 *  1. Kontrahent przelewu to sprzedawca z faktury (NIP w tytule albo nazwa sprzedawcy w kontrahencie / tytule).
 *  2. Kwota przelewu = kwota brutto faktury CO DO GROSZA. Żadnej tolerancji — różnica kwot to płatność częściowa,
 *     prowizja albo inna faktura; o tym decyduje człowiek (lista „do sprawdzenia" podpowiada kandydata).
 *  3. Jeśli tytuł przelewu wymienia numer faktury tego sprzedawcy — liczy się TYLKO ta faktura:
 *       - nieopłacona i kwota zgodna → oznacz jako opłaconą,
 *       - już opłacona (np. oznaczona ręcznie wcześniej) → tylko powiąż przelew z nią; żadna inna faktura nie
 *         zostanie „opłacona" tym przelewem,
 *       - kwota inna → nic automatycznie.
 *  4. Jeśli tytuł nie wymienia żadnej znanej faktury — automat tylko gdy jest DOKŁADNIE JEDNA faktura tego
 *     sprzedawcy na tę kwotę (licząc też faktury opłacone ręcznie bez powiązanego przelewu — to im mógł
 *     odpowiadać ten przelew) i tytuł nie wygląda na numer INNEJ faktury tej samej numeracji.
 *  5. Przelew nie opłaca faktury wystawionej później niż PREPAYMENT_GRACE_DAYS po nim.
 *
 * Typowy błąd, przed którym to chroni: stałe, podobne kwoty co miesiąc (abonament, leasing). Przelew za
 * fakturę wrześniową (już oznaczoną ręcznie) nie może „opłacić" faktury październikowej tylko dlatego, że
 * kontrahent jest ten sam, a kwota taka sama lub zbliżona.
 */

export interface MatchTx {
  amount: number
  transaction_date?: string | null
  date?: string | null
  description?: string | null
  counterparty?: string | null
}

export interface MatchInvoice {
  id: string
  invoice_number?: string | null
  invoice_date?: string | null
  gross_amount?: number | null
  seller_nip?: string | null
  seller_name?: string | null
  payment_status?: string | null
  bank_tx_id?: string | null
}

/** Faktura wystawiona najwyżej tyle dni PO przelewie może być nim opłacona (przedpłata na zamówienie / proformę). */
export const PREPAYMENT_GRACE_DAYS = 14

// ── Tekst ─────────────────────────────────────────────────────────────────────

function fold(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Postać kanoniczna numeru / tytułu: człony alfanumeryczne połączone „/", człony czysto liczbowe bez zer
 * wiodących. „FS-211/02/2026" i „fs 211 2 2026" dają to samo: „fs/211/2/2026".
 */
export function canonTokens(s: string | null | undefined): string {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean).map(t => (/^\d+$/.test(t) ? String(Number(t)) : t)).join('/')
}

/** Część tytułu, w której szukamy numeru faktury: bez stopki płatności kartą; w split payment — pole /INV/. */
export function invoiceReferenceText(description: string | null | undefined): string {
  let d = String(description ?? '').replace(/\s*DATA TRANSAKCJI\b.*$/i, '')
  const inv = /\/INV\/(.*?)(?:\/TXT\/|$)/i.exec(d)
  if (inv) d = inv[1]
  return d
}

function isBoundary(ch: string | undefined, allowLetter: boolean): boolean {
  if (ch === undefined || ch === '/') return true
  return allowLetter && /[a-z]/.test(ch)
}

/**
 * Czy tekst wymienia TEN numer faktury (jako cały numer, nie fragment innego): „2/09/2026" jest w „INV/2/09/2026",
 * ale nie w „12/09/2026" ani „2/09/20261". Przed numerem może stać litera (FV2/09/2026), cyfra — nie.
 */
export function titleNamesInvoice(text: string | null | undefined, invoiceNumber: string | null | undefined): boolean {
  const n = canonTokens(invoiceNumber)
  if (n.length < 4 || !/\d/.test(n)) return false
  const t = canonTokens(invoiceReferenceText(text))
  let i = -1
  while ((i = t.indexOf(n, i + 1)) >= 0) {
    if (isBoundary(t[i - 1], true) && isBoundary(t[i + n.length], false)) return true
  }
  return false
}

/**
 * Czy tekst zawiera numer wyglądający jak INNA faktura tej samej numeracji: taki sam układ członów co numer
 * faktury (liczby w tych samych miejscach, te same litery), ale inne wartości — np. faktura „2/10/2026",
 * a w tytule „2/08/2026"; faktura „146531/1126/RM", w tytule „146161/1026/RM". Wtedy przelew dotyczy innej
 * faktury tego sprzedawcy (także takiej, której w systemie nie ma) i nie wolno dopasować go po samej kwocie.
 * Numer z jednego członu („12345") nie ma rozpoznawalnego układu — nie zgadujemy.
 */
export function titleNamesDifferentNumber(text: string | null | undefined, invoiceNumber: string | null | undefined): boolean {
  const n = canonTokens(invoiceNumber)
  const parts = n.split('/').filter(Boolean)
  if (parts.length < 2 || !parts.some(p => /\d/.test(p))) return false
  const pattern = parts.map(p => p.replace(/\d+/g, '\\d+')).join('/')
  const t = canonTokens(invoiceReferenceText(text))
  const re = new RegExp(pattern, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) {
    const start = m.index, end = start + m[0].length
    if (isBoundary(t[start - 1], true) && isBoundary(t[end], false) && m[0] !== n) return true
    re.lastIndex = start + 1
  }
  return false
}

// ── Kontrahent ────────────────────────────────────────────────────────────────

// Człony nazw, które nie identyfikują firmy (formy prawne, ogólniki)
const NAME_STOP = new Set([
  'sp', 'spolka', 'zoo', 'oo', 'sa', 'sc', 'sk', 'spk', 'spj', 'ograniczona', 'odpowiedzialnoscia', 'akcyjna',
  'komandytowa', 'komandytowo', 'jawna', 'cywilna', 'polska', 'poland', 'polskie', 'group', 'grupa', 'holding',
  'international', 'firma', 'przedsiebiorstwo', 'handlowo', 'handlowe', 'handlowa', 'uslugowe', 'uslugowa',
  'uslugowo', 'produkcyjno', 'produkcyjne', 'phu', 'pphu', 'fhu', 'ppuh', 'biuro', 'sklep', 'hurtownia', 'company',
  'gmbh', 'ltd', 'limited', 'inc', 'services', 'service', 'financial', 'serwis', 'oddzial', 'the', 'and',
])

/** Wyróżniające człony nazwy sprzedawcy (≥ 3 znaki, bez form prawnych i ogólników, nie same cyfry). */
export function distinctiveNameTokens(name: string | null | undefined): string[] {
  return fold(name).split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !NAME_STOP.has(t) && !/^\d+$/.test(t))
}

/**
 * Czy przelew poszedł do sprzedawcy z faktury: NIP sprzedawcy w tytule / kontrahencie (split payment niesie go
 * w polu /IDC/) albo nazwa — pierwsze dwa wyróżniające człony nazwy sprzedawcy (jeden, gdy nazwa ma tylko jeden)
 * muszą wystąpić jako całe słowa. Jedno wspólne słowo typu „USŁUGI" czy „FINANCIAL" nie wystarcza.
 */
export function sellerMatchesTransfer(tx: MatchTx, inv: MatchInvoice): boolean {
  const raw = `${tx.counterparty ?? ''} ${tx.description ?? ''}`
  const nip = String(inv.seller_nip ?? '').replace(/\D/g, '')
  if (nip.length === 10 && new RegExp(`(^|\\D)${nip}(\\D|$)`).test(raw)) return true
  const tokens = distinctiveNameTokens(inv.seller_name)
  if (!tokens.length) return false
  const words = new Set(fold(raw).split(/[^a-z0-9]+/).filter(Boolean))
  return tokens.slice(0, Math.min(2, tokens.length)).every(t => words.has(t))
}

// ── Kwota i data ──────────────────────────────────────────────────────────────

/** Kwota przelewu równa kwocie brutto faktury co do grosza. */
export function amountEquals(tx: MatchTx, inv: MatchInvoice): boolean {
  const gross = Number(inv.gross_amount) || 0
  return gross > 0 && Math.abs(Math.abs(Number(tx.amount) || 0) - gross) <= 0.01
}

/** Faktury, które przelew w ogóle mógł opłacić: wystawione nie później niż PREPAYMENT_GRACE_DAYS po nim. Bez limitu wstecz. */
export function payableCandidates<T extends { invoice_date?: string | null }>(
  tx: { transaction_date?: string | null; date?: string | null },
  invoices: T[],
): T[] {
  const txDate = String(tx.transaction_date ?? tx.date ?? '').slice(0, 10)
  const t = Date.parse(txDate)
  if (!Number.isFinite(t)) return invoices
  const limit = new Date(t + PREPAYMENT_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10)
  return invoices.filter(i => {
    const d = String(i.invoice_date ?? '').slice(0, 10)
    return !/^\d{4}-\d{2}-\d{2}$/.test(d) || d <= limit
  })
}

// ── Decyzja automatu ──────────────────────────────────────────────────────────

export type AutoMatchDecision<I extends MatchInvoice = MatchInvoice> =
  | { action: 'pay'; invoice: I; confidence: number; reasons: string[] }    // oznacz fakturę jako opłaconą tym przelewem
  | { action: 'link'; invoice: I; confidence: number; reasons: string[] }   // faktura jest już opłacona — tylko powiąż z nią przelew
  | { action: 'none'; why: string }                                         // do ręcznego sprawdzenia

export interface AutoMatchOptions {
  /** Faktury opłacone w trakcie bieżącego przebiegu (traktowane jak opłacone i powiązane). */
  taken?: Set<string>
  /** Faktury, z którymi jest już powiązany jakiś przelew (matched_invoice_id) — także opłacone ręcznie i potem powiązane. */
  linkedInvoiceIds?: Set<string>
}

/**
 * Decyzja dla jednego obciążenia. `invoices` = WSZYSTKIE faktury kosztowe firmy (opłacone i nie) — opłacone są
 * potrzebne, żeby rozpoznać, że przelew dotyczy faktury już rozliczonej, i nie przypisać go do sąsiedniej.
 */
export function decideAutoMatch<I extends MatchInvoice>(tx: MatchTx, invoices: I[], opts: AutoMatchOptions = {}): AutoMatchDecision<I> {
  if (!(Number(tx.amount) < 0)) return { action: 'none', why: 'to nie jest obciążenie' }
  const taken = opts.taken ?? new Set<string>()
  const linked = opts.linkedInvoiceIds ?? new Set<string>()
  const isPaid = (i: I) => i.payment_status === 'paid' || taken.has(i.id)

  const sellers = payableCandidates(tx, invoices).filter(i => sellerMatchesTransfer(tx, i))
  if (!sellers.length) return { action: 'none', why: 'brak faktury od tego kontrahenta' }

  // 3. Tytuł wymienia numer faktury tego sprzedawcy → liczy się tylko ona
  const named = sellers.filter(i => titleNamesInvoice(tx.description, i.invoice_number))
  if (named.length > 1) return { action: 'none', why: 'tytuł przelewu wymienia kilka faktur' }
  if (named.length === 1) {
    const n = named[0]
    if (isPaid(n)) return { action: 'link', invoice: n, confidence: 1, reasons: ['nr faktury', 'faktura już opłacona'] }
    if (amountEquals(tx, n)) return { action: 'pay', invoice: n, confidence: 1, reasons: ['kwota', 'nr faktury', 'kontrahent'] }
    return { action: 'none', why: 'tytuł wskazuje fakturę, ale kwota przelewu jest inna' }
  }

  // 4. Tytuł nie wymienia żadnej znanej faktury → tylko jednoznaczne dopasowanie po dokładnej kwocie
  const exact = sellers.filter(i => amountEquals(tx, i))
  const unpaid = exact.filter(i => !isPaid(i))
  // opłacone ręcznie, bez powiązanego przelewu — ten przelew mógł być właśnie ich zapłatą
  const paidUnlinked = exact.filter(i => isPaid(i) && !taken.has(i.id) && !i.bank_tx_id && !linked.has(i.id))
  if (unpaid.length + paidUnlinked.length === 0) return { action: 'none', why: 'brak faktury na dokładnie tę kwotę' }
  if (unpaid.length + paidUnlinked.length > 1) return { action: 'none', why: 'kilka faktur tego kontrahenta na tę samą kwotę' }
  const only = unpaid[0] ?? paidUnlinked[0]
  if (titleNamesDifferentNumber(tx.description, only.invoice_number)) {
    return { action: 'none', why: 'tytuł przelewu wskazuje inną fakturę tego kontrahenta' }
  }
  return unpaid.length
    ? { action: 'pay', invoice: only, confidence: 0.9, reasons: ['kwota', 'kontrahent'] }
    : { action: 'link', invoice: only, confidence: 0.9, reasons: ['kwota', 'kontrahent', 'faktura już opłacona'] }
}
