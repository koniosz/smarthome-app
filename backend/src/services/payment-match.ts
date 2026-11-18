/**
 * Płatności — kiedy przelew z wyciągu może AUTOMATYCZNIE oznaczyć fakturę kosztową jako opłaconą.
 * Czysty moduł (bez bazy) — testy: src/__tests__/payables-match.test.ts.
 *
 * Zasada nadrzędna: fałszywe „opłacone" jest gorsze niż jedno kliknięcie więcej. Nieopłacona faktura schowana
 * jako opłacona znika z listy „do zapłaty" — dlatego automat działa tylko wtedy, gdy NIE MA wątpliwości:
 *
 *  1. Kontrahent przelewu to sprzedawca z faktury: NIP w tytule albo WSZYSTKIE wyróżniające człony nazwy
 *     sprzedawcy w nazwie kontrahenta (wspólne słowo branżowe — „USŁUGI ELEKTRYCZNE" — nie wystarcza).
 *  2. Kwota przelewu = kwota brutto faktury CO DO GROSZA, w tej samej walucie. Żadnej tolerancji — różnica to
 *     płatność częściowa, prowizja albo inna faktura; o tym decyduje człowiek (lista „do sprawdzenia" podpowiada).
 *  3. Jeśli tytuł przelewu wymienia numer faktury tego sprzedawcy — liczy się TYLKO ta faktura:
 *       - nieopłacona i kwota zgodna → oznacz jako opłaconą,
 *       - już opłacona (np. oznaczona ręcznie wcześniej) → tylko powiąż przelew z nią; żadna inna faktura nie
 *         zostanie „opłacona" tym przelewem,
 *       - kwota inna → nic automatycznie.
 *  4. Jeśli tytuł nie wymienia żadnej znanej faktury — automat tylko gdy jest DOKŁADNIE JEDNA faktura tego
 *     sprzedawcy na tę kwotę (licząc też opłacone ręcznie bez powiązanego przelewu — to im mógł odpowiadać ten
 *     przelew) i tytuł nie zawiera żadnego innego numeru (zamówienia, proformy, innej faktury, okresu).
 *  5. Przelew nie opłaca faktury wystawionej później niż PREPAYMENT_GRACE_DAYS po nim.
 *
 * Typowy błąd, przed którym to chroni: stałe, podobne kwoty co miesiąc (abonament, leasing). Przelew za
 * fakturę wrześniową (już oznaczoną ręcznie) nie może „opłacić" faktury październikowej tylko dlatego, że
 * kontrahent jest ten sam, a kwota taka sama lub zbliżona.
 *
 * COFANIE wcześniejszych dopasowań (matchContradiction) jest celowo WĘŻSZE niż reguła automatu: cofamy tylko
 * przy twardej sprzeczności (inna kwota, tytuł wymienia inną fakturę tego sprzedawcy, przelew sprzed daty
 * faktury przy istnieniu wcześniejszej faktury na tę kwotę). To, że dzisiejsza reguła nie umiałaby dopasowania
 * powtórzyć (bank skrócił nazwę kontrahenta, w tytule jest data), NIE jest powodem do cofnięcia.
 */

export interface MatchTx {
  amount: number
  transaction_date?: string | null
  date?: string | null
  description?: string | null
  counterparty?: string | null
  currency?: string | null
}

export interface MatchInvoice {
  id: string
  invoice_number?: string | null
  invoice_date?: string | null
  gross_amount?: number | null
  currency?: string | null
  seller_nip?: string | null
  seller_name?: string | null
  payment_status?: string | null
  bank_tx_id?: string | null
}

/** Faktura wystawiona najwyżej tyle dni PO przelewie może być nim opłacona (przedpłata na zamówienie / proformę). */
export const PREPAYMENT_GRACE_DAYS = 14

// ── Tekst ─────────────────────────────────────────────────────────────────────

function fold(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** Człony kanoniczne: alfanumeryczne, małe litery bez ogonków; człon czysto liczbowy bez zer wiodących. */
export function canonTokenList(s: string | null | undefined): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean).map(t => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t))
}

/** Postać kanoniczna: „FS-211/02/2026" i „fs 211 2 2026" dają to samo: „fs/211/2/2026". */
export function canonTokens(s: string | null | undefined): string {
  return canonTokenList(s).join('/')
}

/** Tytuł płatności kartą („SPRZEDAWCA/MIASTO DATA TRANSAKCJI: RRRR-MM-DD") — nie niesie numerów dokumentów. */
export function isCardTitle(description: string | null | undefined): boolean {
  return /\bDATA TRANSAKCJI\b/i.test(String(description ?? ''))
}

/** Czy tytuł ma strukturę split payment z polem /INV/ (numer faktury wpisany w dedykowane pole). */
function invField(description: string | null | undefined): string | null {
  const m = /\/INV\/(.*?)(?:\/TXT\/|$)/i.exec(String(description ?? ''))
  return m ? m[1] : null
}

/** Część tytułu, w której szukamy numeru faktury: bez stopki płatności kartą; w split payment — pole /INV/. */
export function invoiceReferenceText(description: string | null | undefined): string {
  const inv = invField(description)
  if (inv !== null) return inv
  return String(description ?? '').replace(/\s*DATA TRANSAKCJI\b.*$/i, '')
}

const INVOICE_KEYWORDS = new Set(['faktura', 'faktury', 'fakture', 'fakt', 'fv', 'fvat', 'fa', 'fra', 'f', 'nr', 'numer', 'inv', 'invoice', 'rachunek', 'vat'])

const isNumeric = (t: string | undefined) => !!t && /^\d+$/.test(t)
const isYear = (t: string) => /^\d+$/.test(t) && ((Number(t) >= 2000 && Number(t) <= 2099) || t.length <= 2)

/** Numer, który wygląda jak data / okres: „10/2026" (miesiąc/rok) albo „2/09/2026" (dzień/miesiąc/rok). */
function looksLikeDate(tokens: string[]): boolean {
  if (!tokens.every(isNumeric)) return false
  const n = tokens.map(Number)
  if (tokens.length === 2) return n[0] >= 1 && n[0] <= 12 && isYear(tokens[1])
  if (tokens.length === 3) return n[0] >= 1 && n[0] <= 31 && n[1] >= 1 && n[1] <= 12 && isYear(tokens[2])
  return false
}

/**
 * Czy tekst wymienia TEN numer faktury — jako cały numer, a nie fragment innego numeru, daty czy okresu:
 *  - „2/09/2026" jest w „INV/2/09/2026" i w „FV2/09/2026", ale nie w „12/09/2026" ani „2/09/20261",
 *  - numer poprzedzony członem liczbowym to dłuższy ciąg (data „03.01.2026" nie wymienia faktury „1/2026"),
 *  - numer wyglądający jak data / okres („10/2026", „2/09/2026") liczy się tylko w polu /INV/ split payment,
 *    po słowie „faktura / FV / nr…" albo gdy cały tytuł jest tym numerem („abonament 10/2026" to okres),
 *  - literowy przedrostek numeru (FS, FV, F…) może w tytule nie wystąpić („1894/MG/08/2026" = „FS 1894/MG/08/2026").
 */
export function titleNamesInvoice(text: string | null | undefined, invoiceNumber: string | null | undefined): boolean {
  const full = canonTokenList(invoiceNumber)
  if (!full.length || !full.some(t => /\d/.test(t)) || full.join('/').length < 4) return false
  const structured = invField(text) !== null
  const title = canonTokenList(invoiceReferenceText(text))
  if (!title.length) return false

  const variants: string[][] = [full]
  // bez literowego przedrostka — tylko gdy reszta nadal jest wyróżniająca (≥ 3 człony albo ≥ 2 z literami w środku)
  if (/^[a-z]+$/.test(full[0])) {
    const rest = full.slice(1)
    if (rest.length >= 3 || (rest.length === 2 && rest.some(t => /[a-z]/.test(t)))) variants.push(rest)
  }

  for (const v of variants) {
    const dateLike = looksLikeDate(v)
    for (let i = 0; i + v.length <= title.length; i++) {
      // pierwszy człon może być doklejony do liter („fv2" zawiera „2"); pozostałe muszą być równe
      const first = title[i]
      const firstOk = first === v[0] || (isNumeric(v[0]) && new RegExp(`^[a-z]+${v[0]}$`).test(first))
      if (!firstOk) continue
      let ok = true
      for (let k = 1; k < v.length; k++) if (title[i + k] !== v[k]) { ok = false; break }
      if (!ok) continue
      const prev = title[i - 1]
      if (isNumeric(prev) && first === v[0]) continue   // fragment dłuższego ciągu liczb (data, inny numer)
      if (dateLike) {
        const whole = i === 0 && title.length === v.length
        const keyworded = (prev !== undefined && INVOICE_KEYWORDS.has(prev)) || first !== v[0]
        if (!structured && !whole && !keyworded) continue   // to raczej okres / data, nie numer faktury
      }
      return true
    }
  }
  return false
}

/**
 * Czy tytuł zawiera JAKIKOLWIEK numer (zamówienia, proformy, innej faktury, okresu, daty). Taki przelew dotyczy
 * konkretnego dokumentu — jeśli nie jest nim znana faktura, nie wolno dopasować go po samej kwocie.
 * Tytuł płatności kartą (sprzedawca / miasto, „KASA 5") numerów dokumentów nie niesie.
 */
export function titleHasOtherReference(description: string | null | undefined): boolean {
  if (isCardTitle(description)) return false
  return canonTokenList(invoiceReferenceText(description)).some(t => /\d/.test(t))
}

// ── Kontrahent ────────────────────────────────────────────────────────────────

// Człony nazw, które nie identyfikują firmy: formy prawne i ogólniki (pomijane)
const NAME_STOP = new Set([
  'sp', 'spolka', 'zoo', 'oo', 'sa', 'sc', 'sk', 'spk', 'spj', 'ograniczona', 'odpowiedzialnoscia', 'akcyjna',
  'komandytowa', 'komandytowo', 'jawna', 'cywilna', 'polska', 'poland', 'polskie', 'group', 'grupa', 'holding',
  'international', 'firma', 'przedsiebiorstwo', 'handlowo', 'handlowe', 'handlowa', 'uslugowe', 'uslugowa',
  'uslugowo', 'produkcyjno', 'produkcyjne', 'phu', 'pphu', 'fhu', 'ppuh', 'company', 'gmbh', 'ltd', 'limited',
  'inc', 'services', 'service', 'financial', 'oddzial', 'the', 'and',
])

// Słowa branżowe: mogą być częścią nazwy, ale same niczego nie identyfikują („Usługi Elektryczne …")
const GENERIC_TRADE = new Set([
  'uslugi', 'usluga', 'elektryczne', 'elektryczna', 'elektroinstalacyjne', 'instalacje', 'instalacyjne',
  'instalatorstwo', 'transportowe', 'transport', 'budowlane', 'budowlana', 'bud', 'remontowe', 'remonty',
  'kancelaria', 'prawna', 'radcy', 'adwokacka', 'notarialna', 'stacja', 'kontroli', 'pojazdow', 'paliw', 'auto',
  'serwis', 'leasing', 'bank', 'ubezpieczenia', 'ksiegowosc', 'ksiegowe', 'rachunkowe', 'biuro', 'doradztwo',
  'consulting', 'projekt', 'studio', 'system', 'systemy', 'technika', 'trade', 'trading', 'market', 'sklep',
  'hurtownia', 'hurt', 'zaklad', 'centrum', 'salon', 'warsztat', 'mechanika', 'tech', 'media', 'elektro',
  'montaz', 'ogrodnicze', 'sprzatanie', 'ochrona', 'gastronomia', 'restauracja', 'hotel', 'apteka',
])

/** Wyróżniające człony nazwy sprzedawcy (≥ 3 znaki, bez form prawnych i ogólników, nie same cyfry). */
export function distinctiveNameTokens(name: string | null | undefined): string[] {
  return fold(name).split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !NAME_STOP.has(t) && !/^\d+$/.test(t))
}

/**
 * Czy przelew poszedł do sprzedawcy z faktury:
 *  - NIP sprzedawcy w tytule / kontrahencie (split payment niesie go w polu /IDC/), albo
 *  - nazwa: WSZYSTKIE wyróżniające człony nazwy sprzedawcy (do czterech pierwszych) występują jako całe słowa
 *    w nazwie kontrahenta — a przy płatności kartą (bez kontrahenta) w tytule — i przynajmniej jeden z nich
 *    nie jest słowem branżowym. „USŁUGI ELEKTRYCZNE PIOTR NOWAK" to nie „Usługi Elektryczne Jan Kowalski".
 * Rozbieżność zapisu (skrócona nazwa na wyciągu) daje „nie wiem" — przelew trafia do ręcznego sprawdzenia.
 */
export function sellerMatchesTransfer(tx: MatchTx, inv: MatchInvoice): boolean {
  const nip = String(inv.seller_nip ?? '').replace(/\D/g, '')
  if (nip.length === 10 && new RegExp(`(^|\\D)${nip}(\\D|$)`).test(`${tx.counterparty ?? ''} ${tx.description ?? ''}`)) return true
  const tokens = distinctiveNameTokens(inv.seller_name).slice(0, 4)
  if (!tokens.length || tokens.every(t => GENERIC_TRADE.has(t))) return false
  const source = String(tx.counterparty ?? '').trim() || invoiceReferenceText(tx.description)
  const words = new Set(fold(source).split(/[^a-z0-9]+/).filter(Boolean))
  return tokens.every(t => words.has(t))
}

/** Czy dwie faktury są od tego samego sprzedawcy: ten sam NIP, a bez NIP — ta sama nazwa. */
export function sameSeller(a: MatchInvoice, b: MatchInvoice): boolean {
  const na = String(a.seller_nip ?? '').replace(/\D/g, ''), nb = String(b.seller_nip ?? '').replace(/\D/g, '')
  if (na.length === 10 || nb.length === 10) return na === nb
  const fa = fold(a.seller_name).replace(/[^a-z0-9]+/g, ' ').trim()
  return !!fa && fa === fold(b.seller_name).replace(/[^a-z0-9]+/g, ' ').trim()
}

// ── Kwota i data ──────────────────────────────────────────────────────────────

const cents = (x: unknown) => Math.round(Math.abs(Number(x) || 0) * 100)
const cur = (x: unknown) => String(x ?? '').trim().toUpperCase() || 'PLN'

/** Kwota przelewu równa kwocie brutto faktury co do grosza, w tej samej walucie. */
export function amountEquals(tx: MatchTx, inv: MatchInvoice): boolean {
  const gross = cents(inv.gross_amount)
  return gross > 0 && cents(tx.amount) === gross && cur(tx.currency) === cur(inv.currency)
}

const txDateOf = (tx: { transaction_date?: string | null; date?: string | null }) => String(tx.transaction_date ?? tx.date ?? '').slice(0, 10)
const isIsoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)

/** Faktury, które przelew w ogóle mógł opłacić: wystawione nie później niż PREPAYMENT_GRACE_DAYS po nim. Bez limitu wstecz. */
export function payableCandidates<T extends { invoice_date?: string | null }>(
  tx: { transaction_date?: string | null; date?: string | null },
  invoices: T[],
): T[] {
  const t = Date.parse(txDateOf(tx))
  if (!Number.isFinite(t)) return invoices
  const limit = new Date(t + PREPAYMENT_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10)
  return invoices.filter(i => {
    const d = String(i.invoice_date ?? '').slice(0, 10)
    return !isIsoDate(d) || d <= limit
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

  // 4. Tytuł nie wymienia żadnej znanej faktury → tylko jednoznaczne dopasowanie po dokładnej kwocie,
  //    i tylko gdy tytuł nie niesie innego numeru (zamówienie, proforma, inna faktura, okres)
  if (titleHasOtherReference(tx.description)) {
    return { action: 'none', why: 'tytuł przelewu zawiera numer, który nie jest numerem żadnej faktury tego kontrahenta' }
  }
  const exact = sellers.filter(i => amountEquals(tx, i))
  const unpaid = exact.filter(i => !isPaid(i))
  // opłacone ręcznie, bez powiązanego przelewu — ten przelew mógł być właśnie ich zapłatą
  const paidUnlinked = exact.filter(i => isPaid(i) && !taken.has(i.id) && !i.bank_tx_id && !linked.has(i.id))
  if (unpaid.length + paidUnlinked.length === 0) return { action: 'none', why: 'brak faktury na dokładnie tę kwotę' }
  if (unpaid.length + paidUnlinked.length > 1) return { action: 'none', why: 'kilka faktur tego kontrahenta na tę samą kwotę' }
  return unpaid.length
    ? { action: 'pay', invoice: unpaid[0], confidence: 0.9, reasons: ['kwota', 'kontrahent'] }
    : { action: 'link', invoice: paidUnlinked[0], confidence: 0.9, reasons: ['kwota', 'kontrahent', 'faktura już opłacona'] }
}

// ── Cofanie: tylko twarda sprzeczność ─────────────────────────────────────────

/**
 * Czy ISTNIEJĄCE powiązanie przelew → faktura jest sprzeczne z danymi (wtedy trzeba je cofnąć). Zwraca powód
 * albo null. Celowo wąskie — patrz nagłówek pliku:
 *  1. faktura została oznaczona jako opłacona TYM przelewem, a kwoty się różnią,
 *  2. tytuł przelewu wymienia INNĄ fakturę tego samego sprzedawcy (a tej nie wymienia),
 *  3. faktura została wystawiona PO dacie przelewu, a ten sam sprzedawca ma wcześniejszą fakturę na tę kwotę.
 * `paidByThisTx` = fakturę opłacił ten przelew (a nie np. ręczne oznaczenie, z którym przelew tylko powiązano).
 */
export function matchContradiction<I extends MatchInvoice>(tx: MatchTx, invoice: I, invoices: I[], paidByThisTx: boolean): string | null {
  if (paidByThisTx && !amountEquals(tx, invoice)) return 'kwota przelewu różni się od kwoty faktury'

  const namesThis = titleNamesInvoice(tx.description, invoice.invoice_number)
  const siblings = invoices.filter(i => i.id !== invoice.id && sameSeller(i, invoice))
  if (!namesThis) {
    const other = siblings.find(i => titleNamesInvoice(tx.description, i.invoice_number))
    if (other) return `tytuł przelewu wskazuje fakturę ${other.invoice_number ?? ''}`.trim()
  }

  const txDate = txDateOf(tx), invDate = String(invoice.invoice_date ?? '').slice(0, 10)
  if (!namesThis && isIsoDate(txDate) && isIsoDate(invDate) && invDate > txDate) {
    const earlier = siblings.find(i => {
      const d = String(i.invoice_date ?? '').slice(0, 10)
      return isIsoDate(d) && d <= txDate && amountEquals(tx, i)
    })
    if (earlier) return `przelew jest wcześniejszy niż faktura — tę samą kwotę ma wcześniejsza faktura ${earlier.invoice_number ?? ''}`.trim()
  }
  return null
}
