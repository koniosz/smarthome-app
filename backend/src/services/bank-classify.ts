/**
 * Klasyfikator przelewów z wyciągu bankowego (MT940) — CZYSTY moduł: bez bazy, bez importów z routes/.
 *
 * Po co: pensje, ZUS, podatki, opłaty bankowe i dostawcy zagraniczni NIGDY nie przychodzą fakturą
 * w KSeF, więc jedynym źródłem tych kosztów jest wyciąg. Klasyfikacja jest STRUKTURALNA — patrzy
 * najpierw na kod i nazwę operacji bankowej (subpole ~00 w :86:), numer rachunku kontrahenta
 * (rachunek składkowy ZUS, mikrorachunek podatkowy) i dopiero potem na tytuł przelewu.
 *
 * Kolejność reguł (pierwsze trafienie wygrywa):
 *   1. internal         — przelew własny / rachunek VAT / wymiana walut (nie koszt)
 *   2. zus              — składki ZUS
 *   3. tax_*            — przelew do urzędu skarbowego (PIT-4 / podatek dochodowy / VAT / inne)
 *   4. bank_fee/interest— opłaty i odsetki bankowe
 *   5. salary           — wynagrodzenie dla osoby fizycznej
 *   6. foreign_vendor   — znany dostawca fakturujący z zagranicy (bez KSeF)
 *   7. foreign_transfer — przelew wychodzący za granicę (nie: polski odbiorca, rachunek w neobanku)
 *   8. unknown          — do decyzji użytkownika (lista „nierozpoznane przelewy")
 *
 * Zasada ostrożności: rodzaje 6–7 mają pnl_mode = include (koszt wchodzi do RZiS od razu), więc
 * w razie wątpliwości przelew zostaje „nierozpoznany" — brak kosztu widać na liście do decyzji,
 * a koszt policzony podwójnie (przelew + faktura z KSeF) cicho zaniżałby wynik.
 *
 * Pułapka podwójnego liczenia (mBank): przelew własny z rachunku VAT (kody D96 / D41) niesie TEN SAM
 * tytuł co właściwy przelew do ZUS / US („WPŁATA DO ZUS", „N… 26M09 PIT-4"), ale nie ma kontrahenta.
 * Dlatego reguła 1 (kod operacji) jest sprawdzana PRZED ZUS i podatkami.
 *
 * `amount` — ze znakiem jak w ParsedTransaction (ujemna = obciążenie rachunku). Kwota dodatnia przy
 * operacji, której kod/nazwa nie wskazują obciążenia, jest traktowana jako uznanie (wpływ): nie
 * zostanie rozpoznana jako wynagrodzenie, dostawca ani przelew zagraniczny.
 *
 * `period` — miesiąc, KTÓREGO dotyczy płatność (YYYY-MM), tylko gdy mówi o nim tytuł (kod okresu
 * w przelewie podatkowym, identyfikator deklaracji ZUS, „9/2026" w tytule pensji). Bez tego null —
 * miesiąc memoriałowy wyznacza wtedy RZiS (services/payroll-accrual.ts).
 *
 * Testy: cd backend && DATABASE_URL="postgresql://x:x@localhost:1/x" npx tsx --test src/__tests__/bank-classify.test.ts
 */

export type BankKind =
  | 'zus' | 'tax_pit4' | 'tax_cit' | 'tax_vat' | 'tax_other' | 'salary'
  | 'bank_fee' | 'interest' | 'internal' | 'foreign_vendor' | 'foreign_transfer' | 'unknown'

export interface ClassifyInput {
  date: string                       // data operacji YYYY-MM-DD
  amount: number                     // ze znakiem: ujemna = obciążenie (jak ParsedTransaction.amount)
  description: string                // czysty tytuł przelewu
  counterparty: string               // nazwa kontrahenta ('' gdy brak)
  counterparty_iban?: string | null
  op_code?: string | null            // kod operacji bankowej (np. '152', 'D95')
  op_label?: string | null           // nazwa operacji (np. 'PRZELEW ZEWNĘTRZNY WYCH.')
  currency?: string | null           // waluta wyciągu
}

export interface ClassifyContext {
  ownAccounts?: string[]             // własne rachunki firmy (dowolny zapis — porównywane 26 cyfr)
  employeeNames?: string[]           // imiona i nazwiska pracowników / zleceniobiorców
}

export interface Classification {
  kind: BankKind
  cost_category: string
  subcategory: string
  business_unit: string              // zawsze 'shared'
  pnl_mode: 'auto' | 'include' | 'exclude'
  period: string | null              // YYYY-MM, gdy tytuł podaje okres; inaczej null
  not_invoice_payment: boolean       // true => nigdy nie jest płatnością za fakturę zakupową
  label: string                      // krótka etykieta do UI
  reason: string                     // jedno zdanie: dlaczego
}

// ── Etykiety i mapowanie rodzaj → kategoria ───────────────────────────────────

export const KIND_LABELS: Record<BankKind, string> = {
  zus:              'ZUS',
  tax_pit4:         'PIT-4 (podatek od wynagrodzeń)',
  tax_cit:          'Podatek dochodowy',
  tax_vat:          'VAT',
  tax_other:        'Inny podatek / opłata urzędowa',
  salary:           'Wynagrodzenie',
  bank_fee:         'Opłata bankowa',
  interest:         'Odsetki bankowe',
  internal:         'Przelew własny / rachunek VAT',
  foreign_vendor:   'Dostawca zagraniczny (bez KSeF)',
  foreign_transfer: 'Przelew zagraniczny',
  unknown:          'Nierozpoznany',
}

/** Domyślna kategoria / podkategoria / tryb RZiS dla rodzaju (dostawca zagraniczny nadpisuje kategorię per dostawca). */
export const KIND_TARGETS: Record<BankKind, { cost_category: string; subcategory: string; pnl_mode: 'auto' | 'include' | 'exclude' }> = {
  zus:              { cost_category: 'ga',        subcategory: 'zus_employer',      pnl_mode: 'auto' },
  tax_pit4:         { cost_category: 'ga',        subcategory: 'salary_pit',        pnl_mode: 'auto' },
  salary:           { cost_category: 'ga',        subcategory: 'salary_gross',      pnl_mode: 'auto' },
  tax_cit:          { cost_category: 'financial', subcategory: 'tax_income',        pnl_mode: 'auto' },
  tax_vat:          { cost_category: 'financial', subcategory: 'tax_vat',           pnl_mode: 'auto' },
  tax_other:        { cost_category: 'financial', subcategory: 'tax_other',         pnl_mode: 'auto' },
  bank_fee:         { cost_category: 'financial', subcategory: 'bank_fee',          pnl_mode: 'auto' },
  interest:         { cost_category: 'financial', subcategory: 'interest',          pnl_mode: 'auto' },
  internal:         { cost_category: 'financial', subcategory: 'internal_transfer', pnl_mode: 'exclude' },
  foreign_vendor:   { cost_category: 'ga',        subcategory: 'software',          pnl_mode: 'include' },
  foreign_transfer: { cost_category: 'cogs',      subcategory: 'hardware_eu',       pnl_mode: 'include' },
  unknown:          { cost_category: 'ga',        subcategory: 'other',             pnl_mode: 'auto' },
}

/** Podkategorie składające się na koszt wynagrodzeń (pensje netto + PIT-4 + ZUS). */
export const PAYROLL_SUBCATEGORIES: string[] = ['salary_gross', 'salary_admin', 'salary_civil', 'salary_pit', 'zus_employer']

/** Prefiks notatki dopisywanej do ManualCost, gdy zdecydował klasyfikator (nie reguła użytkownika). */
export const AUTO_NOTE_PREFIX = 'rozpoznano: '

const NOT_INVOICE_KINDS = new Set<string>(['internal', 'zus', 'tax_pit4', 'tax_cit', 'tax_vat', 'tax_other', 'bank_fee', 'interest', 'salary'])

/** Czy przelew tego rodzaju NIGDY nie jest płatnością za fakturę zakupową (auto-odrzucenie w Płatnościach). */
export function isNotInvoicePayment(kind: BankKind | string | null | undefined): boolean {
  return NOT_INVOICE_KINDS.has(String(kind ?? ''))
}

/** Notatka „rozpoznano: <etykieta> — <powód>"; dla nierozpoznanego przelewu pusty tekst. */
export function buildAutoNote(c: Classification): string {
  if (c.kind === 'unknown') return ''
  return `${AUTO_NOTE_PREFIX}${c.label} — ${c.reason}`
}

// ── Normalizacja ──────────────────────────────────────────────────────────────

/** Do porównań: małe litery, bez polskich znaków diakrytycznych, pojedyncze spacje. */
export function normalizeText(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** IBAN / numer rachunku: wielkie litery, bez spacji i znaków innych niż litery i cyfry. */
export function normalizeIban(s: string | null | undefined): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** 26 cyfr polskiego rachunku (NRB) z „PL…" albo z samych cyfr; '' gdy to nie jest pełny polski rachunek. */
function plAccountDigits(s: string | null | undefined): string {
  const n = normalizeIban(s)
  if (/^PL\d{26}$/.test(n)) return n.slice(2)
  if (/^\d{26}$/.test(n)) return n
  return ''
}

/** Ostatnie 26 cyfr rachunku (do porównania rachunków własnych zapisanych w dowolny sposób). */
function last26Digits(s: string | null | undefined): string {
  const d = String(s ?? '').replace(/\D/g, '')
  return d.length >= 26 ? d.slice(-26) : ''
}

/** Kod kraju z zagranicznego IBAN-u (np. 'DE'); '' dla rachunku polskiego, niepełnego lub bez prefiksu. */
function foreignIbanCountry(s: string | null | undefined): string {
  const n = normalizeIban(s)
  const m = n.match(/^([A-Z]{2})\d{2}[A-Z0-9]{8,30}$/)
  if (!m || m[1] === 'PL') return ''
  return m[1]
}

// Rachunek składkowy ZUS (NRS):      kk 6000 0002 026x xxxx xxxx xxxx xxxx
// Mikrorachunek podatkowy:           kk 1010 0071 222x xxxx xxxx xxxx xxxx
const ZUS_ACCOUNT_MARK = '60000002026'
const TAX_ACCOUNT_MARK = '10100071222'

function accountHasMark(iban: string | null | undefined, mark: string): boolean {
  const pl = plAccountDigits(iban)
  if (pl) return pl.startsWith(mark, 2)
  const n = normalizeIban(iban)
  if (/^[A-Z]{2}/.test(n) && !n.startsWith('PL')) return false   // zagraniczny IBAN
  return n.replace(/\D/g, '').includes(mark)                      // niepełny zapis rachunku
}

// Rachunki w bankach internetowych popularnych wśród polskich firm i freelancerów (Revolut, Wise,
// N26, bunq, Paysera): zagraniczny prefiks IBAN-u NIE oznacza zagranicznego kontrahenta, więc taki
// przelew nie jest automatycznie „przelewem zagranicznym" (faktura może być w KSeF) — zostaje do decyzji.
const NEOBANK_IBAN = /^(?:LT\d{2}3250|LT\d{2}3500|BE\d{2}967|DE\d{2}10011001|NL\d{2}BUNQ|GB\d{2}REVO|GB\d{2}TRWI)/

function isNeobankIban(s: string | null | undefined): boolean {
  return NEOBANK_IBAN.test(normalizeIban(s))
}

// ── Okresy ────────────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  styczen: 1, stycznia: 1, luty: 2, lutego: 2, marzec: 3, marca: 3, kwiecien: 4, kwietnia: 4,
  maj: 5, maja: 5, czerwiec: 6, czerwca: 6, lipiec: 7, lipca: 7, sierpien: 8, sierpnia: 8,
  wrzesien: 9, wrzesnia: 9, pazdziernik: 10, pazdziernika: 10, listopad: 11, listopada: 11,
  grudzien: 12, grudnia: 12,
}
const MONTH_ALT = Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join('|')

const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`
const monthIndex = (period: string) => parseInt(period.slice(0, 4), 10) * 12 + parseInt(period.slice(5, 7), 10) - 1

/** Miesiąc płatności (YYYY-MM) z daty operacji; '' gdy data nieczytelna. */
function payMonthOf(date: string | null | undefined): string {
  const m = String(date ?? '').match(/^(\d{4})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}` : ''
}

/**
 * Okno wiarygodności: okres nie późniejszy niż miesiąc płatności i najwyżej `maxBack` miesięcy
 * wcześniejszy. Bez czytelnej daty płatności okres z tytułu przyjmujemy bez kontroli.
 */
function inWindow(period: string, payMonth: string, maxBack: number): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return false
  if (!payMonth) return true
  const diff = monthIndex(payMonth) - monthIndex(period)
  return diff >= 0 && diff <= maxBack
}

/** Rok dla nazwy miesiąca bez roku: ostatni taki miesiąc nie późniejszy niż miesiąc płatności. */
function latestMonthNotAfter(month: number, payMonth: string): string | null {
  if (!payMonth) return null
  const py = parseInt(payMonth.slice(0, 4), 10)
  const pm = parseInt(payMonth.slice(5, 7), 10)
  return ym(month <= pm ? py : py - 1, month)
}

/**
 * Kandydaci na okres zapisany liczbowo: „9/2026", „09/2026", „09.2026", „09-2026", „2026-09".
 * Pełna data („01.09.2026", „2026-09-01") NIE jest okresem — pomijana.
 */
function numericPeriods(text: string): string[] {
  const out: string[] = []
  const reMY = /(?<!\d)(?<!\d[./-])(0?[1-9]|1[0-2])\s?[/.-]\s?(20\d{2})(?!\d)/g
  const reYM = /(?<!\d)(20\d{2})\s?[/.-]\s?(0[1-9]|1[0-2])(?![./-]?\d)/g
  const found: Array<{ at: number; period: string }> = []
  for (const m of text.matchAll(reMY)) found.push({ at: m.index ?? 0, period: ym(parseInt(m[2], 10), parseInt(m[1], 10)) })
  for (const m of text.matchAll(reYM)) found.push({ at: m.index ?? 0, period: ym(parseInt(m[1], 10), parseInt(m[2], 10)) })
  found.sort((a, b) => a.at - b.at)
  for (const f of found) if (!out.includes(f.period)) out.push(f.period)
  return out
}

/**
 * Kandydaci na okres zapisany nazwą miesiąca (tekst znormalizowany): „wrzesień 2026",
 * „za wrzesień [2026]", „okres marzec [2026]", „za m-c wrzesień". Bez roku — ostatni taki
 * miesiąc nie późniejszy niż płatność.
 */
function namedPeriods(norm: string, payMonth: string): string[] {
  const out: string[] = []
  const push = (p: string | null) => { if (p && !out.includes(p)) out.push(p) }
  const reKeyword = new RegExp(`\\b(?:za|okres|okresu)[\\s:]+(?:(?:m-c|mc|miesiac)\\s+)?(${MONTH_ALT})\\b(?:\\s+(20\\d{2})\\b)?`, 'g')
  for (const m of norm.matchAll(reKeyword)) {
    const month = MONTH_NAMES[m[1]]
    push(m[2] ? ym(parseInt(m[2], 10), month) : latestMonthNotAfter(month, payMonth))
  }
  const reYear = new RegExp(`\\b(${MONTH_ALT})\\s+(20\\d{2})\\b`, 'g')
  for (const m of norm.matchAll(reYear)) push(ym(parseInt(m[2], 10), MONTH_NAMES[m[1]]))
  return out
}

function firstInWindow(candidates: string[], payMonth: string, maxBack: number): string | null {
  for (const c of candidates) if (inWindow(c, payMonth, maxBack)) return c
  return null
}

/**
 * Miesiąc, za który opłacono składki ZUS — z tytułu przelewu:
 *  - identyfikator deklaracji „NN.MM.RRRR" / „N.MM.RRRR" (NN = numer deklaracji 01–89, MM.RRRR =
 *    miesiąc, KTÓREGO dotyczą składki), np. „DEKLARACJA: DRA 01.12.2025 R." → 2025-12;
 *  - „OKRES <miesiąc>" / „za <miesiąc> [RRRR]" (bez roku: ostatni taki miesiąc nie po płatności);
 *  - „MM/RRRR", „RRRR-MM".
 * Przyjmowany tylko okres nie późniejszy niż miesiąc płatności i najwyżej 24 miesiące wstecz.
 * Zapis identyczny z datą płatności („15.10.2026" zapłacone 15.10.2026) to data, nie deklaracja.
 */
export function parseZusPeriod(title: string, date: string): string | null {
  const text = String(title ?? '').replace(/\s+/g, ' ')
  const payMonth = payMonthOf(date)
  const payDay = parseInt(String(date ?? '').slice(8, 10), 10)
  const reId = /(?<![\d.])(\d{1,2})\s?\.\s?(0[1-9]|1[0-2])\s?\.\s?(20\d{2})(?![\d])(?!\.\d)/g
  for (const m of text.matchAll(reId)) {
    const nn = parseInt(m[1], 10)
    if (nn < 1 || nn > 89) continue
    const period = ym(parseInt(m[3], 10), parseInt(m[2], 10))
    if (period === payMonth && nn === payDay) continue   // to data przelewu, nie identyfikator deklaracji
    if (inWindow(period, payMonth, 24)) return period
  }
  const norm = normalizeText(text)
  return firstInWindow([...namedPeriods(norm, payMonth), ...numericPeriods(text)], payMonth, 24)
}

/**
 * Miesiąc, za który wypłacono wynagrodzenie — z tytułu: „M/RRRR", „MM/RRRR", „MM.RRRR", „MM-RRRR",
 * „RRRR-MM", „za <miesiąc> RRRR" / „<miesiąc> RRRR" / „za <miesiąc>". Okno jak dla ZUS: nie później
 * niż miesiąc wypłaty (sam miesiąc wypłaty dozwolony) i najwyżej 24 miesiące wstecz.
 */
export function parseSalaryPeriod(title: string, date: string): string | null {
  const text = String(title ?? '').replace(/\s+/g, ' ')
  const payMonth = payMonthOf(date)
  return firstInWindow([...numericPeriods(text), ...namedPeriods(normalizeText(text), payMonth)], payMonth, 24)
}

// ── Przelew podatkowy ─────────────────────────────────────────────────────────

export type TaxKind = 'tax_pit4' | 'tax_cit' | 'tax_vat' | 'tax_other'

export interface TaxTitle {
  kind: TaxKind
  symbol: string            // symbol formularza w zapisie kanonicznym, np. 'PIT-4', 'VAT-7', 'JPK_V7M'; '' gdy brak
  period: string | null     // YYYY-MM — ostatni miesiąc okresu (po kontroli okna, gdy podano datę płatności)
  period_code: string       // kod okresu z tytułu, np. '26M09'; '' gdy brak
}

// RR + typ okresu: R (rok) | P01–P02 (półrocze) | K01–K04 (kwartał) | M01–M12 (miesiąc)
//                  | D + dekada (01–03) + miesiąc | J + dzień + miesiąc
const PERIOD_CODE_RE = /(?<![A-Z0-9])(\d{2})(R|P0[12]|K0[1-4]|M(?:0[1-9]|1[0-2])|D0[1-3](?:0[1-9]|1[0-2])|J(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2]))(?![A-Z0-9])/

function decodePeriodCode(code: string): string | null {
  const m = code.match(/^(\d{2})([RPKMDJ])(\d*)$/)
  if (!m) return null
  const year = 2000 + parseInt(m[1], 10)
  const n = m[3]
  switch (m[2]) {
    case 'R': return ym(year, 12)
    case 'P': return ym(year, parseInt(n, 10) * 6)
    case 'K': return ym(year, parseInt(n, 10) * 3)
    case 'M': return ym(year, parseInt(n, 10))
    case 'D': return ym(year, parseInt(n.slice(2, 4), 10))
    case 'J': return ym(year, parseInt(n.slice(2, 4), 10))
    default:  return null
  }
}

function taxKindOfSymbol(symbol: string): TaxKind {
  const s = symbol.toUpperCase().replace(/[\s_-]/g, '')
  if (!s) return 'tax_other'
  // PIT-4 / PIT-4R — zaliczki potrącone z wynagrodzeń (koszt płac, nie podatek spółki)
  if (/^PIT4R?$/.test(s)) return 'tax_pit4'
  // PIT-8A / PIT-8AR — podatek ZRYCZAŁTOWANY: od małych umów zleceń, ale też od dywidendy i odsetek (to nie
  // koszt firmy). Z samego przelewu nie da się tego rozróżnić → „inny podatek", do decyzji właściciela;
  // jako koszt płac zawyżałby też szacunek PIT-4 sąsiednich miesięcy.
  if (/^PIT8AR?$/.test(s)) return 'tax_other'
  // CIT-8, CIT… oraz podatek dochodowy właściciela: PIT, PIT-5, PIT-5L, PIT-28, PIT-36, PIT-36L, PPL, PPE
  if (/^(CIT|PIT|PPL|PPE|PPD)/.test(s)) return 'tax_cit'
  if (/^(VAT|JPK)/.test(s)) return 'tax_vat'
  return 'tax_other'
}

/** Symbol formularza gdziekolwiek w tekście (WIELKIE litery, bez ogonków) — pierwszy od lewej. */
function findTaxSymbol(text: string): string {
  const candidates: Array<{ at: number; symbol: string }> = []
  const add = (re: RegExp, build: (m: RegExpMatchArray) => string) => {
    const m = text.match(re)
    if (m && m.index !== undefined) candidates.push({ at: m.index, symbol: build(m) })
  }
  const suffix = (s: string | undefined) => (s ?? '').replace(/\s/g, '')
  add(/(?<![A-Z0-9])JPK[\s_-]?(V(?:AT)?\s?7?\s?[MK]?)?(?![A-Z0-9])/, m => (suffix(m[1]) ? `JPK_${suffix(m[1])}` : 'JPK'))
  // sufiks liczbowy nie może być początkiem okresu („VAT 08/2026" to symbol VAT, nie „VAT-08")
  add(/(?<![A-Z0-9])PIT[\s-]?(\d{1,2}[A-Z]{0,2})?(?![A-Z0-9]|[/.]\d)/, m => (m[1] ? `PIT-${m[1]}` : 'PIT'))
  add(/(?<![A-Z0-9])CIT[\s-]?(\d{1,2}[A-Z]{0,3})?(?![A-Z0-9]|[/.]\d)/, m => (m[1] ? `CIT-${m[1]}` : 'CIT'))
  add(/(?<![A-Z0-9])VAT[\s-]?(\d{1,2}[A-Z]{0,2}|UE[A-Z]?|IM|IN|R)?(?![A-Z0-9]|[/.]\d)/, m => (m[1] ? `VAT-${m[1]}` : 'VAT'))
  add(/(?<![A-Z0-9])(PPL|PPE|PPD)(?![A-Z0-9])/, m => m[1])
  add(/(?<![A-Z0-9])(PCC|AKC)[\s-]?(\d{1,2}[A-Z]{0,2})?(?![A-Z0-9]|[/.]\d)/, m => (m[2] ? `${m[1]}-${m[2]}` : m[1]))
  if (!candidates.length) return ''
  candidates.sort((a, b) => a.at - b.at)
  return candidates[0].symbol
}

/**
 * Tytuł przelewu podatkowego. Obsługiwane zapisy:
 *  - „N5210000000 26M09 PIT-4"                      (identyfikator, kod okresu, symbol formularza)
 *  - „/TI/N5210000000/OKR/26M09/SFP/PIT-4/TXT/…"    (format Elixir)
 *  - sam symbol formularza gdziekolwiek w tytule („zaliczka CIT-8 08/2026")
 * `date` (data płatności) włącza kontrolę okna: okres nie późniejszy niż miesiąc płatności
 * i najwyżej 36 miesięcy wstecz; poza oknem → period = null.
 */
export function parseTaxTitle(title: string, date?: string): TaxTitle {
  const raw = String(title ?? '')
    .toUpperCase()
    .replace(/Ł/g, 'L')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const payMonth = payMonthOf(date)

  // Kod okresu: pole /OKR/ albo pierwszy kod w tytule
  let periodCode = ''
  const okr = raw.match(/\/OKR\/\s*([^/]*)/)
  if (okr) {
    const m = okr[1].replace(/\s/g, '').match(PERIOD_CODE_RE)
    if (m) periodCode = m[0]
  }
  if (!periodCode) {
    const m = raw.match(PERIOD_CODE_RE)
    if (m) periodCode = m[0]
  }

  // Symbol formularza: pole /SFP/ albo symbol gdziekolwiek (bez identyfikatora i kodu okresu)
  let symbol = ''
  const sfp = raw.match(/\/SFP\/\s*([^/]*)/)
  if (sfp) symbol = findTaxSymbol(sfp[1].trim()) || sfp[1].trim().slice(0, 12)
  if (!symbol) {
    let rest = raw
      .replace(/\/TI\/\s*[^/]*/g, ' ')
      .replace(/(?<![A-Z0-9])[NPR123]\d{9,11}(?![A-Z0-9])/g, ' ')
    if (periodCode) rest = rest.replace(periodCode, ' ')
    symbol = findTaxSymbol(rest)
  }

  let kind = taxKindOfSymbol(symbol)
  if (!symbol) {
    // Bez symbolu — rodzaj podatku nazwany słowami
    const n = normalizeText(raw)
    if (/od wynagrodzen|podat\w* od plac/.test(n)) kind = 'tax_pit4'
    else if (/podat\w* dochodow/.test(n)) kind = 'tax_cit'
    else if (/podat\w* vat\b|od towarow i uslug/.test(n)) kind = 'tax_vat'
  }

  let period: string | null = null
  const decoded = periodCode ? decodePeriodCode(periodCode) : null
  if (decoded && inWindow(decoded, payMonth, 36)) period = decoded
  if (!period && !periodCode) {
    // Tytuł wpisany ręcznie („CIT-8 zaliczka 08/2026", „PIT-4 za wrzesień 2026")
    const text = String(title ?? '').replace(/\s+/g, ' ')
    period = firstInWindow([...numericPeriods(text), ...namedPeriods(normalizeText(text), payMonth)], payMonth, 36)
  }

  return { kind, symbol, period, period_code: periodCode }
}

// ── Dostawcy zagraniczni (bez KSeF) ───────────────────────────────────────────

export interface ForeignVendor {
  key: string
  name: string               // nazwa do UI / uzasadnienia
  cost_category: string
  subcategory: string
  patterns: RegExp[]         // na tekście znormalizowanym (małe litery, bez ogonków)
}

const SOFTWARE = { cost_category: 'ga', subcategory: 'software' }
const TRAVEL   = { cost_category: 'operations', subcategory: 'travel' }

/**
 * ZACHOWAWCZA lista dostawców, którzy fakturują polskie firmy z podmiotu zagranicznego — ich faktur
 * nigdy nie ma w KSeF, więc płatność (karta / przelew) jest jedynym śladem kosztu.
 * Krótkie lub wieloznaczne nazwy wymagają postaci domenowej („render.com", „expo.dev", „neon.tech",
 * „linear.app", „zoom.us") — bez tego łapalibyśmy RENDERING, EXPORT, NEONET, LINEAR SP. Z O.O.
 * CELOWO poza listą (mogą fakturować przez polski podmiot w KSeF): Google, Amazon/AWS, Allegro,
 * Uber, Bolt, Orlen i wszystkie polskie sklepy.
 */
export const FOREIGN_VENDORS: ForeignVendor[] = [
  // — oprogramowanie / SaaS —
  { key: 'openai',       name: 'OpenAI (ChatGPT)',     ...SOFTWARE, patterns: [/\bopenai\b/, /\bchatgpt\b/] },
  { key: 'anthropic',    name: 'Anthropic (Claude)',   ...SOFTWARE, patterns: [/\banthropic\b/, /\bclaude\.ai\b/] },
  { key: 'github',       name: 'GitHub',               ...SOFTWARE, patterns: [/\bgithub\b/] },
  { key: 'microsoft',    name: 'Microsoft',            ...SOFTWARE, patterns: [/\bmsft\s?\*/, /\bmsbill\b/, /\bmicrosoft\s?\*/] },
  { key: 'autodesk',     name: 'Autodesk',             ...SOFTWARE, patterns: [/\bautodesk\b/] },
  { key: 'apple',        name: 'Apple',                ...SOFTWARE, patterns: [/\bapple\.com\/(?:bill|pl)\b/, /\bitunes\.com\b/] },
  { key: 'adobe',        name: 'Adobe',                ...SOFTWARE, patterns: [/\badobe\b/] },
  { key: 'atlassian',    name: 'Atlassian',            ...SOFTWARE, patterns: [/\batlassian\b/] },
  { key: 'slack',        name: 'Slack',                ...SOFTWARE, patterns: [/\bslack\b/] },
  { key: 'zoom',         name: 'Zoom',                 ...SOFTWARE, patterns: [/\bzoom\.(?:us|com)\b/, /\bzoom video\b/] },
  { key: 'notion',       name: 'Notion',               ...SOFTWARE, patterns: [/\bnotion\.so\b/, /\bnotion labs\b/] },
  { key: 'figma',        name: 'Figma',                ...SOFTWARE, patterns: [/\bfigma\b/] },
  { key: 'canva',        name: 'Canva',                ...SOFTWARE, patterns: [/\bcanva\b/] },
  { key: 'dropbox',      name: 'Dropbox',              ...SOFTWARE, patterns: [/\bdropbox\b/] },
  { key: 'jetbrains',    name: 'JetBrains',            ...SOFTWARE, patterns: [/\bjetbrains\b/] },
  { key: 'digitalocean', name: 'DigitalOcean',         ...SOFTWARE, patterns: [/\bdigitalocean\b/, /\bdigital ocean\b/] },
  { key: 'hetzner',      name: 'Hetzner',              ...SOFTWARE, patterns: [/\bhetzner\b/] },
  { key: 'cloudflare',   name: 'Cloudflare',           ...SOFTWARE, patterns: [/\bcloudflare\b/] },
  { key: 'vercel',       name: 'Vercel',               ...SOFTWARE, patterns: [/\bvercel\b/] },
  { key: 'twilio',       name: 'Twilio',               ...SOFTWARE, patterns: [/\btwilio\b/, /\bsendgrid\b/] },
  { key: 'zapier',       name: 'Zapier',               ...SOFTWARE, patterns: [/\bzapier\b/] },
  { key: 'midjourney',   name: 'Midjourney',           ...SOFTWARE, patterns: [/\bmidjourney\b/] },
  { key: 'cursor',       name: 'Cursor',               ...SOFTWARE, patterns: [/\bcursor\.(?:com|sh|so)\b/, /\bcursor,? ai\b/, /\bcursor usage\b/, /\banysphere\b/] },
  { key: 'perplexity',   name: 'Perplexity',           ...SOFTWARE, patterns: [/\bperplexity\b/] },
  { key: 'miro',         name: 'Miro',                 ...SOFTWARE, patterns: [/\bmiro\.com\b/, /\brealtimeboard\b/] },
  { key: 'sentry',       name: 'Sentry',               ...SOFTWARE, patterns: [/\bsentry\.io\b/] },
  { key: 'mailchimp',    name: 'Mailchimp',            ...SOFTWARE, patterns: [/\bmailchimp\b/] },
  { key: 'linkedin',     name: 'LinkedIn',             ...SOFTWARE, patterns: [/\blinkedin\b/] },
  { key: 'render',       name: 'Render',               ...SOFTWARE, patterns: [/\brender\.com\b/] },
  { key: 'expo',         name: 'Expo',                 ...SOFTWARE, patterns: [/\bexpo\.dev\b/] },
  { key: 'neon',         name: 'Neon',                 ...SOFTWARE, patterns: [/\bneon\.tech\b/] },
  { key: 'linear',       name: 'Linear',               ...SOFTWARE, patterns: [/\blinear\.app\b/] },
  { key: 'flyio',        name: 'Fly.io',               ...SOFTWARE, patterns: [/\bfly\.io\b/] },
  { key: 'tailscale',    name: 'Tailscale',            ...SOFTWARE, patterns: [/\btailscale\b/] },
  { key: 'supabase',     name: 'Supabase',             ...SOFTWARE, patterns: [/\bsupabase\b/] },
  { key: 'netlify',      name: 'Netlify',              ...SOFTWARE, patterns: [/\bnetlify\b/] },
  { key: 'heroku',       name: 'Heroku',               ...SOFTWARE, patterns: [/\bheroku\b/] },
  { key: 'replit',       name: 'Replit',               ...SOFTWARE, patterns: [/\breplit\b/] },
  { key: 'elevenlabs',   name: 'ElevenLabs',           ...SOFTWARE, patterns: [/\belevenlabs\b/] },
  { key: 'deepl',        name: 'DeepL',                ...SOFTWARE, patterns: [/\bdeepl\b/] },
  { key: 'parallels',    name: 'Parallels',            ...SOFTWARE, patterns: [/\bparallels\b/] },
  // — reklama —
  { key: 'meta',         name: 'Meta (Facebook Ads)',  cost_category: 'sales', subcategory: 'marketing', patterns: [/\bfacebk\b/, /\bfacebook\b/, /\bmeta platforms\b/] },
  // — sprzęt / narzędzia —
  { key: 'eibmarkt',     name: 'eibmarkt (KNX, Niemcy)', cost_category: 'cogs', subcategory: 'hardware_eu', patterns: [/\beibmarkt\b/] },
  { key: 'bambulab',     name: 'Bambu Lab (sklep EU)', cost_category: 'operations', subcategory: 'tools', patterns: [/bambulab/, /\bbambu lab\b/] },
  { key: 'aliexpress',   name: 'AliExpress / Alibaba', cost_category: 'cogs', subcategory: 'hardware_noneu', patterns: [/\baliexpress\b/, /\balibaba\b/] },
  // — podróże —
  { key: 'wizzair',      name: 'Wizz Air',             ...TRAVEL, patterns: [/\bwizz\s?air/] },
  { key: 'ryanair',      name: 'Ryanair',              ...TRAVEL, patterns: [/\bryanair\b/] },
  { key: 'lufthansa',    name: 'Lufthansa',            ...TRAVEL, patterns: [/\blufthansa\b/] },
  { key: 'easyjet',      name: 'easyJet',              ...TRAVEL, patterns: [/\beasyjet\b/] },
  { key: 'booking',      name: 'Booking.com',          ...TRAVEL, patterns: [/\bbooking\.com\b/] },
  { key: 'airbnb',       name: 'Airbnb',               ...TRAVEL, patterns: [/\bairbnb\b/] },
]

/** Dostawca zagraniczny rozpoznany w tekście (kontrahent + tytuł); null gdy żaden. */
export function matchForeignVendor(text: string | null | undefined): ForeignVendor | null {
  const n = normalizeText(text)
  if (!n) return null
  for (const v of FOREIGN_VENDORS) {
    if (v.patterns.some(p => p.test(n))) return v
  }
  return null
}

// ── Cechy kontrahenta / operacji ──────────────────────────────────────────────

/** Nazwa bez kropek i przecinków — „sp. z o.o." → „sp z o o". */
const undot = (norm: string) => norm.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()

// Polskie formy prawne (jednoznacznie polski podmiot)
const POLISH_LEGAL_FORM = /\bsp ?z ?o ?o\b|\bspolk|\bsp k\b|\bsp j\b|\bsp p\b|\bs c\b|\bs k a\b|\bp s a\b/

function hasPolishLegalForm(name: string): boolean {
  return POLISH_LEGAL_FORM.test(undot(normalizeText(name)))
}

const COMPANY_MARKERS = [
  POLISH_LEGAL_FORM,
  /\bs a\b|\b(?:sa|sc|ska|psa)$/,
  /\b(?:gmbh|ltd|limited|inc|llc|corp|corporation|plc|kft|sarl|srl|sro|s r o|b v|co kg)\b/,
  /\b(?:ag|ab|oy|bv|nv|ug)$/,
  /\b(?:firma|uslugi|uslugowe|uslugowy|uslugowo|handlowe|handlowy|handlowo|handel|przedsiebiorstwo|biuro|kancelaria|gabinet|hurtownia|sklep|serwis|studio|group|grupa|holding|company|fundacja|stowarzyszenie|spoldzielnia|bank|towarzystwo|agencja|centrum|instytut|zaklad|urzad|fhu|phu|pphu|fh|ph|polska|poland|international|solutions|systems|technologies|consulting)\b/,
]

/** Czy nazwa wygląda na firmę / instytucję (forma prawna albo słowo typowe dla działalności). */
function looksLikeCompany(name: string): boolean {
  const n = undot(normalizeText(name))
  if (!n) return false
  // „F.H.U." → „f h u" → „fhu": skróty pisane z kropkami sklejamy do jednego tokenu
  const glued = n.replace(/\b(?:[a-z] ){1,4}[a-z]\b/g, m => m.replace(/ /g, ''))
  return COMPANY_MARKERS.some(re => re.test(n) || re.test(glued))
}

// Kody operacji mBanku (subpole ~00 w :86:)
const INTERNAL_OP_CODES = new Set(['295', 'D95', 'D96', 'D41', 'A60', 'A61', 'D93', 'D94', 'D40'])
const ZUS_OP_CODES      = new Set(['153', '209'])
const TAX_OP_CODES      = new Set(['210'])
const FEE_OP_CODES      = new Set(['776', '27A', '91A', '563', '54A', 'D08'])
const CARD_OP_CODES     = new Set(['114', 'C22', 'C01', '121', 'C23'])
// Kody, które zawsze są obciążeniem rachunku (kierunek znany nawet, gdy kwotę podano bez znaku)
const DEBIT_OP_CODES    = new Set([
  '152', '169', '297', '300', '306', 'D52', 'D07', '261', '088', '340', '153', '209', '210',
  '114', 'C22', 'C01', '90A', 'D01', '776', '27A', '91A', '563', '54A', 'D08', '295', 'D95', 'D96', 'D41', 'A60',
])

const RE_INTERNAL_LABEL = /przelew wlasny|pp\/przelew vat|natych\.? ?transak|wymiana walut|kupno walut|sprzedaz walut/
const RE_CARD_LABEL     = /\bkart[ayae]?\b|\bblik zakup|\bblik kor|\bzakup\b|\bpos\b/
const RE_CARD_TITLE     = /platnosc karta|zakup przy uzyciu karty|transakcja karta|data transakcji/
const RE_CASH           = /gotowk|bankomat|\batm\b|wplatomat/
const RE_FOREIGN_LABEL  = /\bsepa\b|zagraniczn|\bswift\b|polecenie wyplaty/

const RE_ZUS_NAME  = /zaklad\w* ubezpiecz\w* ?spoleczn/
const RE_ZUS_WORD  = /\bzus\b/
const RE_TAX_PARTY = /\burz[ae]d\w* skarbow|izb\w* administracji skarbowej|krajow\w* administracj\w* skarbow|mikrorachunek podatkowy/
const RE_US_ABBREV = /^(?:[a-z0-9.]+ ){0,2}us\b/

// Słowa płacowe w tytule (tekst znormalizowany, granice słów — „opłacenie" i „premium" nie pasują)
const PAYROLL_STRICT = [
  /\bwynagrodzeni/, /\bpensj[aei]\b/, /\blist[ay] plac\b/, /\bpremi(?:a|i|e|ii|owa|owe)\b/,
  /\bumow\w*[- ]zleceni/, /\bumow\w* o dzielo\b/,
]
const PAYROLL_BROAD = [
  ...PAYROLL_STRICT, /\bwyplat/, /\bnagrod/, /\bekwiwalent/, /\bodpraw/, /\bnadgodzin/, /\bprowizj/, /\bbonus/,
]
const INVOICE_MARKERS = [
  /\bfaktur/, /\bfv\b|\bfv\d|\bf\.? ?vat\b/, /\bf-ra\b/, /\bfa\.? ?(?:nr\.? ?)?\d/,
  /\brachun\w* (?:nr|numer)\b/, /\brach\.? ?nr\b/,
]
const EMPLOYEE_BLOCKERS = [
  /\bzwrot/, /\bfaktur/, /\bfv\b|\bfv\d/, /\bzaliczk/, /\bpozyczk/, /\bdywidend/, /\bdelegac/, /\brozliczeni/, /\bkaucj/,
]

const anyMatch = (res: RegExp[], text: string) => res.some(re => re.test(text))

/** Tokeny imienia i nazwiska: same litery, min. 2 znaki. */
function nameTokens(name: string): string[] {
  return Array.from(new Set(normalizeText(name).split(/[^a-z]+/).filter(t => t.length >= 2)))
}

/**
 * Kontrahent = pracownik z listy: ten sam zestaw tokenów (kolejność i ogonki bez znaczenia, min. 2 tokeny);
 * dopuszczalny jeden token nadmiarowy po jednej ze stron (drugie imię / drugi człon nazwiska).
 */
function matchesEmployee(counterparty: string, employeeNames: string[] | undefined): boolean {
  if (!employeeNames?.length) return false
  const cp = nameTokens(counterparty)
  if (cp.length < 2) return false
  for (const name of employeeNames) {
    const emp = nameTokens(name)
    if (emp.length < 2) continue
    const [small, big] = emp.length <= cp.length ? [emp, cp] : [cp, emp]
    if (big.length - small.length > 1) continue
    if (small.every(t => big.includes(t))) return true
  }
  return false
}

// Kraje UE + EOG (IS, LI, NO) — dla podziału sprzęt z UE / spoza UE
const EU_EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
])

// ── Klasyfikacja ──────────────────────────────────────────────────────────────

function make(kind: BankKind, reason: string, opts: { period?: string | null; cost_category?: string; subcategory?: string } = {}): Classification {
  const target = KIND_TARGETS[kind]
  return {
    kind,
    cost_category: opts.cost_category ?? target.cost_category,
    subcategory:   opts.subcategory ?? target.subcategory,
    business_unit: 'shared',
    pnl_mode:      target.pnl_mode,
    period:        opts.period ?? null,
    not_invoice_payment: isNotInvoicePayment(kind),
    label:         KIND_LABELS[kind],
    reason,
  }
}

export function classifyBankTransfer(tx: ClassifyInput, ctx: ClassifyContext = {}): Classification {
  const date    = String(tx.date ?? '')
  const amount  = Number(tx.amount) || 0
  const title   = String(tx.description ?? '')
  const party   = String(tx.counterparty ?? '')
  const op      = String(tx.op_code ?? '').trim().toUpperCase()
  const label   = normalizeText(tx.op_label)
  const titleN  = normalizeText(title)
  const partyN  = normalizeText(party)
  const currency = String(tx.currency ?? '').trim().toUpperCase()
  const structured = op !== '' || label !== ''
  // Wyciąg bez subpól (inny bank): cały tekst :86: jest w tytule — instytucji szukamy też tam
  const partyOrTitleN = partyN || (structured ? '' : titleN)
  const opName = String(tx.op_label ?? '').trim()
  const companyLike = looksLikeCompany(party || (structured ? '' : title))

  // ── 1. Przelew własny / rachunek VAT / wymiana walut ──
  if (INTERNAL_OP_CODES.has(op) || RE_INTERNAL_LABEL.test(label)) {
    const fx = op === 'A60' || op === 'A61' || /natych|walut/.test(label)
    const vat = /^D\d\d$/.test(op) || /przelew vat/.test(label)
    return make('internal', fx
      ? 'natychmiastowa transakcja wymiany walut — przesunięcie własnych środków, nie koszt'
      : vat
        ? `operacja na rachunku VAT${op ? ` (kod ${op})` : ''} — przesunięcie własnych środków, nie koszt ani płatność za fakturę`
        : 'przelew między własnymi rachunkami firmy — nie koszt')
  }
  const cpAccount = last26Digits(tx.counterparty_iban)
  if (cpAccount && ctx.ownAccounts?.length) {
    const own = new Set(ctx.ownAccounts.map(a => last26Digits(a)).filter(Boolean))
    if (own.has(cpAccount) && !foreignIbanCountry(tx.counterparty_iban)) {
      return make('internal', 'przelew na własny rachunek firmy — nie koszt')
    }
  }

  // ── 2. ZUS ──
  const zusByAccount = accountHasMark(tx.counterparty_iban, ZUS_ACCOUNT_MARK)
  // nazwa operacji bywa ucięta do 27 znaków („PRZELEW ZEWNĘTRZNY DO Z") — stąd tolerancja na końcówkę
  const zusByOp = ZUS_OP_CODES.has(op) || /\bdo zus\b|\bdo zu?$/.test(label)
  // sam skrót „ZUS" nie wystarcza, gdy nazwa wygląda na firmę („ZUS-BUD Sp. z o.o.")
  const zusByParty = RE_ZUS_NAME.test(partyOrTitleN) || (RE_ZUS_WORD.test(partyOrTitleN) && !companyLike)
  if (zusByAccount || zusByOp || zusByParty) {
    const period = parseZusPeriod(title, date)
    const how = zusByAccount ? 'przelew na rachunek składkowy ZUS'
      : zusByOp ? 'operacja bankowa „przelew do ZUS”'
        : 'odbiorcą jest Zakład Ubezpieczeń Społecznych'
    return make('zus', period ? `${how}, składki za ${period}` : how, { period })
  }

  // ── 3. Urząd skarbowy ──
  const taxByAccount = accountHasMark(tx.counterparty_iban, TAX_ACCOUNT_MARK)
  const taxByOp = TAX_OP_CODES.has(op) || /podatkow/.test(label)
  const taxByParty = RE_TAX_PARTY.test(partyOrTitleN)
  let tax: TaxTitle | null = null
  if (taxByAccount || taxByOp || taxByParty) {
    tax = parseTaxTitle(title, date)
  } else if (RE_US_ABBREV.test(partyN) && !looksLikeCompany(party) && !anyMatch(INVOICE_MARKERS, titleN)) {
    // „US Warszawa-Mokotów" — skrót przyjmujemy tylko razem z symbolem formularza lub kodem okresu w tytule
    // (nie firma „US … Sp. z o.o." i nie płatność za fakturę)
    const t = parseTaxTitle(title, date)
    if (t.symbol || t.period_code) tax = t
  }
  if (tax) {
    const how = taxByOp ? 'przelew podatkowy' : taxByAccount ? 'przelew na mikrorachunek podatkowy' : 'przelew do urzędu skarbowego'
    const what = tax.symbol || (tax.kind === 'tax_pit4' ? 'podatek od wynagrodzeń'
      : tax.kind === 'tax_cit' ? 'podatek dochodowy'
        : tax.kind === 'tax_vat' ? 'VAT' : 'bez symbolu formularza')
    return make(tax.kind, `${how}: ${what}${tax.period ? ` za ${tax.period}` : ''}`, { period: tax.period })
  }

  // ── 4. Opłaty i odsetki bankowe ──
  if (FEE_OP_CODES.has(op) || /^(?:oplat|prowizj)/.test(label) || /- ?oplata$/.test(label)) {
    return make('bank_fee', opName ? `opłata bankowa: ${opName}` : `opłata bankowa (kod operacji ${op})`)
  }
  if (/^(?:odsetki|kapitalizacja odsetek|naliczenie odsetek)/.test(label)) {
    return make('interest', `odsetki naliczone przez bank: ${opName}`)
  }
  if (!structured && !partyN && /^(?:oplata|prowizja)\b.*(?:rachun|przelew|kart|bank|konto)/.test(titleN)) {
    return make('bank_fee', 'tytuł operacji wskazuje opłatę bankową')
  }

  // Kierunek: ujemna kwota = obciążenie; przy kwocie bez znaku decyduje kod / nazwa operacji
  const outgoing = amount < 0 || DEBIT_OP_CODES.has(op) || /\bwych|obciaz/.test(label) || amount === 0
  const cardOrBlik = CARD_OP_CODES.has(op) || RE_CARD_LABEL.test(label) || RE_CARD_TITLE.test(titleN)
  const cash = RE_CASH.test(label) || RE_CASH.test(titleN)

  // ── 5. Wynagrodzenie ──
  if (outgoing && !cardOrBlik && !cash) {
    const strict = anyMatch(PAYROLL_STRICT, titleN) && !companyLike && !anyMatch(INVOICE_MARKERS, titleN)
    const employee = !strict && matchesEmployee(party, ctx.employeeNames)
      && anyMatch(PAYROLL_BROAD, titleN) && !anyMatch(EMPLOYEE_BLOCKERS, titleN)
    if (strict || employee) {
      const period = parseSalaryPeriod(title, date)
      const how = strict
        ? 'tytuł przelewu wskazuje wypłatę wynagrodzenia osobie fizycznej'
        : 'przelew do pracownika z tytułem płacowym'
      return make('salary', period ? `${how}, za ${period}` : how, { period })
    }
  }

  // Jednoznacznie polski odbiorca: pełny polski rachunek albo polska forma prawna w nazwie
  const polishParty = plAccountDigits(tx.counterparty_iban) !== '' || hasPolishLegalForm(party)

  // ── 6. Dostawca zagraniczny (bez KSeF) ──
  if (outgoing && !cash && !polishParty) {
    const vendor = matchForeignVendor(`${party} ${title}`)
    if (vendor) {
      return make('foreign_vendor', `płatność dla dostawcy zagranicznego ${vendor.name} — jego faktury nie trafiają do KSeF`, {
        cost_category: vendor.cost_category, subcategory: vendor.subcategory,
      })
    }
  }

  // ── 7. Przelew zagraniczny ──
  if (outgoing && !cardOrBlik && !cash && !polishParty && !isNeobankIban(tx.counterparty_iban)) {
    const country = foreignIbanCountry(tx.counterparty_iban)
    const foreignCurrency = currency !== '' && currency !== 'PLN'
    const foreignLabel = RE_FOREIGN_LABEL.test(label)
    if (country || foreignCurrency || foreignLabel) {
      const eu = country ? EU_EEA.has(country) : (/\bsepa\b/.test(label) || currency === 'EUR')
      const how = country ? `rachunek odbiorcy w kraju ${country}`
        : foreignLabel ? `operacja „${opName}”`
          : `rachunek w walucie ${currency}`
      return make('foreign_transfer', `przelew zagraniczny (${how}) — faktura dostawcy spoza Polski nie trafia do KSeF`, {
        subcategory: eu ? 'hardware_eu' : 'hardware_noneu',
      })
    }
  }

  // ── 8. Nierozpoznany ──
  return make('unknown', 'brak cech pozwalających rozpoznać przelew automatycznie — do decyzji')
}
