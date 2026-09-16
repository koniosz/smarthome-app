/**
 * „Kondycja firmy" — zdrowie finansowe spółki za miesiąc lub kwartał, językiem laika.
 *
 * Składa RZiS (computePnlYear z routes/finance.ts) z:
 *  - kontrolami kompletności danych (MT940, Firmao, KSeF, skrzynka kosztów, księgowa),
 *  - szacunkiem podatków (VAT, CIT, ZUS),
 *  - gotówką (salda MT940, należności, zobowiązania),
 *  - porównaniami (poprzedni okres, rok temu) i trendem 12 miesięcy.
 *
 * Czyste funkcje (okresy, status, nagłówek, checki, podział kosztów, podatki, gotówka)
 * są wydzielone i testowane na fixture'ach — bez bazy. Jedynie computeHealth() czyta Prisma.
 * Wszystkie kwoty NETTO (jak w RZiS); VAT nie jest kosztem, CIT poniżej EBIT.
 */
import { prisma } from '../db'
import {
  computePnlYear, sumLines, addMonths, costLine, includeManualCostInPnl,
  type PnlLines,
} from '../routes/finance'
import { COST_TAXONOMY } from '../routes/ksef'
import { MANUAL_SUBCATEGORIES } from '../routes/manual-costs'
import { findKsefDuplicate, type DupDocInput, type DupKsefInvoice } from './cost-duplicates'

// ── Typy odpowiedzi (kontrakt dla frontendu i raportu e-mail) ─────────────────
export type HealthKind = 'monthly' | 'quarterly'
export type HealthStatus = 'green' | 'yellow' | 'red'
export type CheckSeverity = 'error' | 'warn' | 'info'

export type HealthCheck = {
  key: string
  severity: CheckSeverity
  message: string
  count?: number
  link?: string
}

export type Cmp = { label: string; revenue: number; costs: number; ebitda: number; ebitda_pct: number }

export type HealthResponse = {
  kind: HealthKind
  period: string                          // '2026-08' | '2026-Q3'
  label: string                           // 'Sierpień 2026' | 'III kwartał 2026'
  range: { from: string; to: string }     // YYYY-MM
  status: HealthStatus
  headline: string
  subline: string
  complete: boolean
  tiles: { revenue: number; costs: number; ebitda: number; ebitda_pct: number; net_result: number; cash: number | null; cash_date: string | null }
  lines: PnlLines
  compare: { prev: Cmp | null; yoy: Cmp | null }
  trend: Array<{ period: string; label: string; revenue: number; costs: number; ebitda: number }>
  cost_breakdown: Array<{ key: string; label: string; amount: number; pct: number }>
  taxes: {
    vat_output: number; vat_input: number; vat_due_estimate: number
    cit_rate: number; cit_base_ytd: number; cit_estimate_ytd: number; cit_paid_ytd: number; cit_to_pay_estimate: number
    zus: number; note: string
  }
  checks: HealthCheck[]
  cash: {
    balances: Array<{ account: string; currency: string; closing: number; date: string }>
    total_pln: number | null
    receivables: number
    overdue_receivables: number
    payables: number
    overdue_payables: number
  }
  generated_at: string
}

// ── Pomocnicze: liczby i polska odmiana ──────────────────────────────────────
export const r2 = (x: number) => Math.round(x * 100) / 100

/** „38 400 zł" — pełne złote, separator tysięcy spacją (dla laika, bez groszy). */
export function formatPln(n: number): string {
  const v = Math.round(Math.abs(n || 0))
  const s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${n < 0 && v !== 0 ? '−' : ''}${s} zł`
}

/** Polska liczba mnoga: plural(3, 'faktura', 'faktury', 'faktur') → 'faktury'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n))
  if (a === 1) return one
  const m10 = a % 10, m100 = a % 100
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return few
  return many
}

// ── Okresy ───────────────────────────────────────────────────────────────────
export const MONTHS_PL = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień']
export const MONTHS_SHORT_PL = ['Sty', 'Lut', 'Mar', 'Kwi', 'Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź', 'Lis', 'Gru']
const ROMAN = ['I', 'II', 'III', 'IV']

export type PeriodInfo = {
  kind: HealthKind
  period: string
  year: number
  quarter?: number
  range: { from: string; to: string }
  label: string
}

/** Dzisiejsza data wg Europe/Warsaw (serwer na Render działa w UTC). */
export function warsawToday(d: Date = new Date()): { year: number; month: number; day: number; iso: string; period: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  const year = get('year'), month = get('month'), day = get('day')
  const period = `${year}-${String(month).padStart(2, '0')}`
  return { year, month, day, iso: `${period}-${String(day).padStart(2, '0')}`, period }
}

export function previousMonthPeriod(d: Date = new Date()): string {
  return addMonths(warsawToday(d).period, -1)
}

export function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return `${MONTHS_PL[m - 1] ?? period} ${y}`
}

/** 'Sie 26' — etykieta słupka na wykresie trendu. */
export function shortMonthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return `${MONTHS_SHORT_PL[m - 1] ?? period} ${String(y).slice(2)}`
}

export function quarterLabel(year: number, q: number): string {
  return `${ROMAN[q - 1]} kwartał ${year}`
}

/** Miesiące od `from` do `to` włącznie (YYYY-MM). */
export function monthsInRange(from: string, to: string): string[] {
  const out: string[] = []
  let m = from, guard = 0
  while (m <= to && guard++ < 240) { out.push(m); m = addMonths(m, 1) }
  return out
}

/** Ostatni dzień miesiąca: '2026-02' → '2026-02-28'. */
export function lastDayOf(period: string): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${period}-${String(d).padStart(2, '0')}`
}

const PERIOD_ERROR = 'Nieprawidłowy okres — użyj YYYY-MM (miesiąc) lub YYYY-Qn (kwartał)'

/** 'YYYY-MM' → miesiąc, 'YYYY-Qn' → kwartał; pusty → poprzedni miesiąc (Europe/Warsaw). Rzuca Error przy złym formacie. */
export function parsePeriod(input?: string | null, d: Date = new Date()): PeriodInfo {
  const raw = String(input ?? '').trim().toUpperCase()
  const period = raw || previousMonthPeriod(d)
  let m = period.match(/^(\d{4})-(\d{2})$/)
  if (m) {
    const year = Number(m[1]), month = Number(m[2])
    if (month < 1 || month > 12) throw new Error(PERIOD_ERROR)
    return { kind: 'monthly', period, year, range: { from: period, to: period }, label: monthLabel(period) }
  }
  m = period.match(/^(\d{4})-Q([1-4])$/)
  if (m) {
    const year = Number(m[1]), q = Number(m[2])
    const from = `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}`
    const to = `${year}-${String(q * 3).padStart(2, '0')}`
    return { kind: 'quarterly', period, year, quarter: q, range: { from, to }, label: quarterLabel(year, q) }
  }
  throw new Error(PERIOD_ERROR)
}

/** Przesunięcie o n okresów (miesięcy lub kwartałów): shiftPeriod('2026-Q1', -1) → 2025-Q4. */
export function shiftPeriod(info: PeriodInfo, n: number): PeriodInfo {
  if (info.kind === 'monthly') return parsePeriod(addMonths(info.period, n))
  const idx = info.year * 4 + (info.quarter! - 1) + n
  const year = Math.floor(idx / 4), q = (idx % 4 + 4) % 4 + 1
  return parsePeriod(`${year}-Q${q}`)
}

/** Ten sam okres rok wcześniej. */
export function yoyPeriod(info: PeriodInfo): PeriodInfo {
  return info.kind === 'monthly' ? parsePeriod(addMonths(info.period, -12)) : parsePeriod(`${info.year - 1}-Q${info.quarter}`)
}

// ── Status, nagłówek, podpis ─────────────────────────────────────────────────
/** Koszty w sensie „ile wydaliśmy" (bez CIT — podatek dochodowy osobno w `taxes`). */
export function computeCosts(l: Pick<PnlLines, 'cogs' | 'opex' | 'depreciation' | 'financial_costs'>): number {
  return r2(l.cogs + l.opex + l.depreciation + l.financial_costs)
}

/** red: EBITDA < 0 · yellow: EBITDA ≥ 0, ale dane niekompletne lub marża EBITDA < 5 % · green: reszta. */
export function computeStatus(l: Pick<PnlLines, 'ebitda' | 'ebitda_pct'>, complete: boolean): HealthStatus {
  if (l.ebitda < 0) return 'red'
  if (!complete || l.ebitda_pct < 5) return 'yellow'
  return 'green'
}

/** „Sierpień 2026: zarobiliście 38 400 zł na czysto (marża 11 %)." / „…: strata 12 300 zł." */
export function buildHeadline(label: string, l: Pick<PnlLines, 'revenue' | 'net_result'>, costs: number): string {
  if (l.revenue === 0 && costs === 0) return `${label}: brak danych — nie ma jeszcze przychodów ani kosztów.`
  if (l.net_result >= 0) {
    const margin = l.revenue > 0 ? Math.round(l.net_result / l.revenue * 100) : null
    return `${label}: zarobiliście ${formatPln(l.net_result)} na czysto${margin !== null ? ` (marża ${margin} %)` : ''}.`
  }
  return `${label}: strata ${formatPln(-l.net_result)}.`
}

/** „Dane kompletne." lub co brakuje (tylko błędy — one zmieniają wynik). */
export function buildSubline(checks: HealthCheck[]): string {
  const errors = checks.filter(c => c.severity === 'error')
  if (!errors.length) {
    const warns = checks.filter(c => c.severity === 'warn').length
    return warns ? `Dane kompletne. Do sprawdzenia: ${warns} ${plural(warns, 'uwaga', 'uwagi', 'uwag')}.` : 'Dane kompletne.'
  }
  const mt = errors.some(e => e.key === 'mt940_missing')
  const firmao = errors.some(e => e.key === 'firmao_missing')
  if (mt && firmao) return 'Brakuje wyciągu MT940 i importu Firmao — wynik jest wstępny.'
  if (mt) return 'Brakuje wyciągu MT940 — wynik może być zawyżony.'
  if (firmao) return 'Brak importu Firmao — przychód wstępny (z KSeF), wynik może się zmienić.'
  return errors.map(e => e.message).join(' ')
}

// ── Kontrole kompletności („Do sprawdzenia") ─────────────────────────────────
export type CheckFacts = {
  months: string[]                        // miesiące zakresu (YYYY-MM)
  today_month?: string                    // miesiące późniejsze niż bieżący nie są sprawdzane
  mt940_months: string[]                  // miesiące z jakimkolwiek wpisem MT940 (ManualCost lub BankTransaction)
  provisional_months: string[]            // miesiące bez importu Firmao
  ksef_unallocated: number
  cost_docs_pending: number
  bank_review_pending: number
  accountant_months: string[]             // miesiące z zestawieniem księgowej
  accountant_diffs: Array<{ period: string; ours: number; theirs: number; theirs_costs: number }>
  cogs_purchases: number
  pz_docs: number
  latest_ksef_created_at: string | null
  cost_doc_ksef_overlap?: number          // zatwierdzone dokumenty spoza KSeF, które mają odpowiednik wśród faktur KSeF (koszt ×2)
  foreign_currency_costs?: number         // koszty ręczne/MT940 w walucie ≠ PLN (bez kursu NBP) — pominięte w sumach
  now?: Date
}

export function buildChecks(f: CheckFacts): HealthCheck[] {
  const checks: HealthCheck[] = []
  const now = f.now ?? new Date()
  const list = (ms: string[]) => ms.map(monthLabel).join(', ')
  const pastMonths = f.today_month ? f.months.filter(m => m <= f.today_month!) : f.months

  const mt = new Set(f.mt940_months)
  const mtMissing = pastMonths.filter(m => !mt.has(m))
  if (mtMissing.length) checks.push({
    key: 'mt940_missing', severity: 'error', count: mtMissing.length, link: '/platnosci',
    message: `Brak wyciągu bankowego MT940 za ${list(mtMissing)} — bez niego w kosztach nie ma pensji, ZUS i podatków.`,
  })

  const prov = new Set(f.provisional_months)
  const provMissing = pastMonths.filter(m => prov.has(m))
  if (provMissing.length) checks.push({
    key: 'firmao_missing', severity: 'error', count: provMissing.length, link: '/rentownosc',
    message: `Brak importu sprzedaży z Firmao za ${list(provMissing)} — przychód policzony wstępnie (KSeF + moduł faktur).`,
  })

  if (f.ksef_unallocated > 0) checks.push({
    key: 'ksef_unallocated', severity: 'warn', count: f.ksef_unallocated, link: '/finanse',
    message: `${f.ksef_unallocated} ${plural(f.ksef_unallocated, 'faktura kosztowa', 'faktury kosztowe', 'faktur kosztowych')} z KSeF bez kategorii — nie ma ich w kosztach.`,
  })

  if (f.cost_docs_pending > 0) checks.push({
    key: 'cost_docs_pending', severity: 'warn', count: f.cost_docs_pending, link: '/koszty-spoza-ksef',
    message: `${f.cost_docs_pending} ${plural(f.cost_docs_pending, 'dokument czeka', 'dokumenty czekają', 'dokumentów czeka')} na zatwierdzenie w skrzynce kosztów spoza KSeF.`,
  })

  if (f.bank_review_pending > 0) checks.push({
    key: 'bank_review_pending', severity: 'warn', count: f.bank_review_pending, link: '/platnosci',
    message: `${f.bank_review_pending} ${plural(f.bank_review_pending, 'przelew', 'przelewy', 'przelewów')} z wyciągu do sprawdzenia w Płatnościach.`,
  })

  // Dokument zatwierdzony ZANIM faktura pojawiła się w KSeF (sync co kilka godzin, dostawca wystawia z opóźnieniem):
  // kontrola duplikatów przy zatwierdzaniu jej nie widziała, a alokacja KSeF policzy ten sam koszt drugi raz.
  const overlap = f.cost_doc_ksef_overlap ?? 0
  if (overlap > 0) checks.push({
    key: 'cost_doc_ksef_overlap', severity: 'warn', count: overlap, link: '/koszty-spoza-ksef',
    message: `${overlap} ${plural(overlap, 'zatwierdzony dokument spoza KSeF ma', 'zatwierdzone dokumenty spoza KSeF mają', 'zatwierdzonych dokumentów spoza KSeF ma')} odpowiednik wśród faktur KSeF (ten sam NIP i kwota albo numer) — koszt może być policzony dwa razy. Odrzuć dokument albo oznacz go jako duplikat.`,
  })

  const fx = f.foreign_currency_costs ?? 0
  if (fx > 0) checks.push({
    key: 'manual_costs_foreign_currency', severity: 'warn', count: fx, link: '/rentownosc',
    message: `Koszty w walucie obcej bez kursu: ${fx} — nie ${fx === 1 ? 'jest wliczony' : 'są wliczone'} do wyniku, przelicz ${fx === 1 ? 'go' : 'je'} ręcznie na PLN.`,
  })

  const acc = new Set(f.accountant_months)
  const accMissing = pastMonths.filter(m => !acc.has(m))
  if (accMissing.length) checks.push({
    key: 'accountant_missing', severity: 'info', count: accMissing.length, link: '/rentownosc',
    message: `Brak zestawienia od księgowej za ${list(accMissing)} — nie da się uzgodnić wyniku.`,
  })

  const diffs = f.accountant_diffs.filter(d => Math.abs(d.ours - d.theirs) > Math.max(500, 0.05 * Math.abs(d.theirs_costs)))
  if (diffs.length) checks.push({
    key: 'accountant_diff', severity: 'warn', count: diffs.length, link: '/rentownosc',
    message: diffs.map(d => `Wynik za ${monthLabel(d.period)} różni się od księgowej o ${formatPln(Math.abs(d.ours - d.theirs))} (my: ${formatPln(d.ours)}, księgowa: ${formatPln(d.theirs)}).`).join(' '),
  })

  if (f.cogs_purchases > 0 && f.pz_docs === 0) checks.push({
    key: 'inventory_docs_missing', severity: 'info', link: '/magazyn',
    message: `Są zakupy towarów (${formatPln(f.cogs_purchases)}), ale w magazynie nie ma dokumentów PZ za ten okres — zmiana stanu zapasów może być niepełna.`,
  })

  if (f.latest_ksef_created_at) {
    const ageDays = (now.getTime() - Date.parse(f.latest_ksef_created_at)) / 86_400_000
    if (Number.isFinite(ageDays) && ageDays > 3) checks.push({
      key: 'ksef_sync_stale', severity: 'info', link: '/ksef',
      message: `Ostatnia faktura z KSeF pobrana ${Math.floor(ageDays)} dni temu — sprawdź synchronizację.`,
    })
  }

  const order: Record<CheckSeverity, number> = { error: 0, warn: 1, info: 2 }
  return checks.sort((a, b) => order[a.severity] - order[b.severity])
}

/**
 * Ile zatwierdzonych dokumentów spoza KSeF ma odpowiednik wśród faktur KSeF (reguła (a) z cost-duplicates:
 * ten sam NIP i kwota brutto ±0,02, albo ten sam numer i zbieżny sprzedawca). Dokumenty, których koszt i tak
 * nie wchodzi do RZiS (`excludedDocIds` — ManualCost pnl_mode=exclude), nie dublują i są pomijane.
 */
export function countCostDocKsefOverlap(
  docs: Array<DupDocInput & { id: string }>,
  invoices: DupKsefInvoice[],
  excludedDocIds: Iterable<string> = [],
): number {
  if (!docs.length || !invoices.length) return 0
  const excluded = new Set(excludedDocIds)
  let n = 0
  for (const d of docs) {
    if (excluded.has(d.id)) continue
    if (findKsefDuplicate(d, invoices)) n++
  }
  return n
}

/** ManualCost w walucie ≠ PLN (brak kursu NBP przy imporcie) — nie wolno go sumować z kwotami PLN. */
export function isPlnCost(c: { currency?: string | null }): boolean {
  const cur = String(c.currency ?? '').trim().toUpperCase()
  return !cur || cur === 'PLN'
}

// ── „Na co idą pieniądze" — top podkategorii ─────────────────────────────────
/** Etykiety podkategorii z obu taksonomii (KSeF ma pierwszeństwo, bez emoji na początku). */
export function subcategoryLabels(): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const cat of Object.values(MANUAL_SUBCATEGORIES)) for (const [k, v] of Object.entries(cat)) labels[k] = v
  for (const cat of Object.values(COST_TAXONOMY)) for (const [k, v] of Object.entries(cat.subcategories)) {
    labels[k] = v.replace(/^[^\p{L}\p{N}]+/u, '').trim() || v
  }
  return labels
}

export function costBreakdown(
  items: Array<{ subcategory: string; amount: number }>,
  labels: Record<string, string>,
  top = 6,
): Array<{ key: string; label: string; amount: number; pct: number }> {
  const by = new Map<string, number>()
  for (const it of items) {
    const key = it.subcategory || 'other'
    by.set(key, (by.get(key) ?? 0) + (Number(it.amount) || 0))
  }
  const entries = [...by.entries()].map(([key, amount]) => ({ key, amount: r2(amount) })).filter(e => e.amount > 0).sort((a, b) => b.amount - a.amount)
  const total = entries.reduce((s, e) => s + e.amount, 0)
  const pct = (a: number) => total > 0 ? Math.round(a / total * 1000) / 10 : 0
  const head = entries.slice(0, top).map(e => ({ key: e.key, label: labels[e.key] ?? e.key, amount: e.amount, pct: pct(e.amount) }))
  const rest = r2(entries.slice(top).reduce((s, e) => s + e.amount, 0))
  if (rest > 0) head.push({ key: 'other', label: 'Pozostałe', amount: rest, pct: pct(rest) })
  return head
}

// ── Podatki (szacunek) ───────────────────────────────────────────────────────
export const TAX_NOTE = 'Szacunek — ostateczne kwoty liczy księgowa.'

export function computeTaxes(i: {
  vat_output: number; vat_input: number; cit_rate: number
  ytd: Array<Pick<PnlLines, 'ebit' | 'financial_costs'>>   // miesiące od stycznia do końca okresu
  cit_paid_ytd: number; zus: number
}): HealthResponse['taxes'] {
  const base = Math.max(0, r2(i.ytd.reduce((s, m) => s + (m.ebit - m.financial_costs), 0)))
  const estimate = r2(base * i.cit_rate / 100)
  const paid = r2(i.cit_paid_ytd)
  return {
    vat_output: r2(i.vat_output), vat_input: r2(i.vat_input), vat_due_estimate: r2(i.vat_output - i.vat_input),
    cit_rate: i.cit_rate, cit_base_ytd: base, cit_estimate_ytd: estimate, cit_paid_ytd: paid,
    cit_to_pay_estimate: Math.max(0, r2(estimate - paid)),
    zus: r2(i.zus), note: TAX_NOTE,
  }
}

// ── Gotówka: salda, należności, zobowiązania ─────────────────────────────────
export type CashInputs = {
  balances: Array<{ account: string; currency: string; closing: number; date: string }>   // dowolna kolejność; przy równej dacie wygrywa pierwszy
  unpaid_records: Array<{ gross: number; due_date: string | null }>                        // SalesRecord paid=false
  module_matched_ids: Iterable<string>                                                     // SalesInvoice.id zdeduplikowane z Firmao
  issued_invoices: Array<{ id: string; total_gross: number; due_date: string | null }>     // SalesInvoice status=issued bez ksef_number
  ksef_payables: Array<{ gross_amount: number; payment_due_date: string | null }>          // KSeF incoming ≠ paid
  today: string                                                                            // YYYY-MM-DD
}

export function computeCashPosition(i: CashInputs): { cash: HealthResponse['cash']; cash_total: number | null; cash_date: string | null } {
  const latest = new Map<string, CashInputs['balances'][number]>()
  for (const b of i.balances) {
    const cur = latest.get(b.account)
    if (!cur || b.date > cur.date) latest.set(b.account, b)
  }
  const balances = [...latest.values()]
    .map(b => ({ account: b.account, currency: b.currency || 'PLN', closing: r2(b.closing), date: b.date }))
    .sort((a, b) => a.account.localeCompare(b.account))
  // Kafel „Gotówka" = tylko konta PLN. Same salda walutowe → null („brak sald — wgraj MT940"), a nie „0 zł z datą
  // wyciągu EUR" — tak samo liczy prognoza gotówki (routes/cashflow.ts), inaczej oba widoki przeczyłyby sobie na jednej stronie.
  const pln = balances.filter(b => b.currency === 'PLN')
  const cash_total = pln.length ? r2(pln.reduce((s, b) => s + b.closing, 0)) : null
  const cash_date = pln.length ? pln.map(b => b.date).sort().pop()! : null

  const overdue = (due: string | null | undefined) => !!due && due < i.today
  const matched = new Set(i.module_matched_ids)
  let receivables = 0, overdue_receivables = 0
  for (const r of i.unpaid_records) { receivables += r.gross; if (overdue(r.due_date)) overdue_receivables += r.gross }
  for (const inv of i.issued_invoices) {
    if (matched.has(inv.id)) continue
    receivables += inv.total_gross; if (overdue(inv.due_date)) overdue_receivables += inv.total_gross
  }
  let payables = 0, overdue_payables = 0
  for (const p of i.ksef_payables) { payables += p.gross_amount; if (overdue(p.payment_due_date)) overdue_payables += p.gross_amount }

  return {
    cash: {
      balances, total_pln: cash_total,
      receivables: r2(receivables), overdue_receivables: r2(overdue_receivables),
      payables: r2(payables), overdue_payables: r2(overdue_payables),
    },
    cash_total, cash_date,
  }
}

// ── Porównanie ───────────────────────────────────────────────────────────────
export function cmpOf(label: string, l: PnlLines): Cmp {
  return { label, revenue: l.revenue, costs: computeCosts(l), ebitda: l.ebitda, ebitda_pct: l.ebitda_pct }
}

// ── Główna funkcja: pełna odpowiedź „Kondycja firmy" ─────────────────────────
export async function computeHealth(periodInput?: string | null): Promise<HealthResponse> {
  const info = parsePeriod(periodInput)
  const { year, range } = info
  const months = monthsInRange(range.from, range.to)
  const fromDate = `${range.from}-01`, toDate = lastDayOf(range.to)
  const todayW = warsawToday()

  // RZiS bieżącego i poprzedniego roku (porównania + trend 12 mies. + rok temu)
  const [pnlCur, pnlPrev, settings] = await Promise.all([
    computePnlYear(year),
    computePnlYear(year - 1),
    prisma.companySettings.findUnique({ where: { id: 'default' } }).catch(() => null),
  ])
  const monthMap = new Map<string, PnlLines & { period: string }>()
  for (const m of [...pnlPrev.months, ...pnlCur.months]) monthMap.set(m.period, m)
  const linesFor = (from: string, to: string): PnlLines =>
    sumLines(monthsInRange(from, to).map(m => monthMap.get(m)).filter((m): m is PnlLines & { period: string } => !!m))

  const lines = linesFor(range.from, range.to)
  const costs = computeCosts(lines)

  // Porównania
  const prevInfo = shiftPeriod(info, -1)
  const prevLines = linesFor(prevInfo.range.from, prevInfo.range.to)
  const yoyInfo = yoyPeriod(info)
  const yoyLines = linesFor(yoyInfo.range.from, yoyInfo.range.to)
  const compare = {
    prev: monthMap.has(prevInfo.range.from) ? cmpOf(prevInfo.label, prevLines) : null,
    yoy: yoyLines.revenue > 0 ? cmpOf(yoyInfo.label, yoyLines) : null,
  }

  // Trend: 12 miesięcy kończących się na końcu okresu
  const trend = monthsInRange(addMonths(range.to, -11), range.to).map(m => {
    const l = monthMap.get(m)
    return { period: m, label: shortMonthLabel(m), revenue: l?.revenue ?? 0, costs: l ? computeCosts(l) : 0, ebitda: l?.ebitda ?? 0 }
  })

  // Źródła do checków, podziału kosztów, podatków i gotówki
  const [
    allocations, manualCostsYtd, vatGroups, ksefUnallocated, costDocsPending, bankReviewPending,
    mt940Tx, statements, pzDocs, latestKsef, balanceRows, unpaidRecords, moduleMatched, issuedInvoices, ksefPayables,
    approvedDocs, ksefIncomingInRange,
  ] = await Promise.all([
    prisma.ksefInvoiceAllocation.findMany({
      where: { invoice: { invoice_direction: 'incoming', invoice_date: { gte: fromDate, lte: toDate } } },
      select: { amount: true, cost_category: true, subcategory: true, invoice: { select: { net_amount: true, gross_amount: true } } },
    }),
    prisma.manualCost.findMany({ where: { date: { gte: `${year}-01-01`, lte: toDate } } }),
    prisma.ksefInvoice.groupBy({
      by: ['invoice_direction'],
      where: { invoice_date: { gte: fromDate, lte: toDate } },
      _sum: { vat_amount: true },
    }),
    prisma.ksefInvoice.count({ where: { invoice_direction: 'incoming', invoice_date: { gte: fromDate, lte: toDate }, allocations: { none: {} } } }),
    prisma.costDocument.count({ where: { status: { in: ['pending', 'error'] } } }),
    prisma.bankTransaction.count({ where: { review_status: 'pending' } }),
    prisma.bankTransaction.findMany({
      where: { source: 'mt940', transaction_date: { gte: fromDate, lte: toDate } },
      select: { transaction_date: true }, distinct: ['transaction_date'],
    }),
    prisma.accountantStatement.findMany({ where: { period: { in: months } }, select: { period: true, result: true, costs: true } }),
    prisma.warehouseDoc.count({ where: { type: 'PZ', date: { gte: fromDate, lte: toDate } } }),
    prisma.ksefInvoice.findFirst({ orderBy: { created_at: 'desc' }, select: { created_at: true } }),
    prisma.bankBalance.findMany({
      orderBy: [{ date: 'desc' }, { statement_no: 'desc' }, { created_at: 'desc' }],
      select: { account: true, currency: true, closing: true, date: true },
    }),
    prisma.salesRecord.findMany({ where: { paid: false }, select: { gross: true, due_date: true } }),
    prisma.salesRecord.findMany({ where: { dedup_status: 'module_match', matched_id: { not: null } }, select: { matched_id: true } }),
    prisma.salesInvoice.findMany({
      where: { status: 'issued', OR: [{ ksef_number: null }, { ksef_number: '' }] },
      select: { id: true, total_gross: true, due_date: true },
    }),
    prisma.ksefInvoice.findMany({
      where: { invoice_direction: 'incoming', OR: [{ payment_status: null }, { payment_status: { not: 'paid' } }] },
      select: { gross_amount: true, payment_due_date: true },
    }),
    // Kontrola odwrotna do cost-duplicates: dokument zatwierdzony wcześniej niż faktura trafiła do KSeF
    prisma.costDocument.findMany({
      where: { status: 'approved', doc_date: { gte: fromDate, lte: toDate } },
      select: { id: true, seller_name: true, seller_nip: true, doc_number: true, doc_date: true, gross_pln: true },
    }),
    prisma.ksefInvoice.findMany({
      where: { invoice_direction: 'incoming', invoice_date: { gte: fromDate, lte: toDate } },
      select: { id: true, seller_nip: true, seller_name: true, invoice_number: true, gross_amount: true, invoice_date: true },
    }),
  ])

  const inRange = (date: string | null | undefined) => !!date && date >= fromDate && date <= toDate
  const manualInRange = (manualCostsYtd as any[]).filter(c => inRange(c.date))
  // Koszt w walucie obcej (brak kursu NBP) nie może być dodany do kwot PLN — pomijamy i liczymy jako ostrzeżenie
  const countsInPnl = (c: any) => isPlnCost(c) && includeManualCostInPnl(c)
  const foreignCurrencyCosts = manualInRange.filter(c => !isPlnCost(c)).length

  // Podział kosztów: KSeF (brutto → netto proporcją faktury) + koszty ręczne/MT940/dokumenty
  const breakdownItems: Array<{ subcategory: string; amount: number }> = []
  for (const a of allocations as any[]) {
    const line = costLine(a.cost_category, a.subcategory)
    if (line === 'excluded' || line === 'cit') continue
    const inv = a.invoice
    const netRatio = inv && inv.gross_amount > 0 && inv.net_amount > 0 ? inv.net_amount / inv.gross_amount : 1
    breakdownItems.push({ subcategory: a.subcategory, amount: a.amount * netRatio })
  }
  for (const c of manualInRange) {
    if (!countsInPnl(c)) continue
    const line = costLine(c.cost_category, c.subcategory)
    if (line === 'excluded' || line === 'cit' || c.subcategory === 'tax_income') continue
    breakdownItems.push({ subcategory: c.subcategory, amount: c.amount })
  }
  const cost_breakdown = costBreakdown(breakdownItems, subcategoryLabels())

  // Dokumenty spoza KSeF, których koszt nie wchodzi do RZiS (ManualCost source=document wykluczony) — nie dublują
  const excludedDocIds = (manualCostsYtd as any[])
    .filter(c => c.source === 'document' && c.document_id && !includeManualCostInPnl(c))
    .map(c => String(c.document_id))
  const costDocKsefOverlap = countCostDocKsefOverlap(approvedDocs, ksefIncomingInRange, excludedDocIds)

  // Podatki
  const vatOf = (dir: string) => (vatGroups as any[]).find(g => g.invoice_direction === dir)?._sum?.vat_amount ?? 0
  const ytdMonths = monthsInRange(`${year}-01`, range.to).map(m => monthMap.get(m)).filter((m): m is PnlLines & { period: string } => !!m)
  const taxes = computeTaxes({
    vat_output: vatOf('outgoing'), vat_input: vatOf('incoming'),
    cit_rate: settings?.cit_rate ?? 9,
    ytd: ytdMonths,
    cit_paid_ytd: (manualCostsYtd as any[]).filter(c => c.subcategory === 'tax_income' && countsInPnl(c)).reduce((s, c) => s + c.amount, 0),
    zus: manualInRange.filter(c => c.subcategory === 'zus_employer' && countsInPnl(c)).reduce((s, c) => s + c.amount, 0),
  })

  // Kontrole
  const mt940Months = new Set<string>()
  for (const c of manualInRange) if (c.source === 'mt940') mt940Months.add(String(c.date).slice(0, 7))
  for (const t of mt940Tx) mt940Months.add(String(t.transaction_date).slice(0, 7))
  const checks = buildChecks({
    months,
    today_month: todayW.period,
    mt940_months: [...mt940Months],
    provisional_months: months.filter(m => monthMap.get(m)?.provisional),
    ksef_unallocated: ksefUnallocated,
    cost_docs_pending: costDocsPending,
    bank_review_pending: bankReviewPending,
    accountant_months: statements.map(s => s.period),
    accountant_diffs: statements.map(s => ({ period: s.period, ours: monthMap.get(s.period)?.net_result ?? 0, theirs: s.result, theirs_costs: s.costs })),
    cogs_purchases: lines.cogs_purchases,
    pz_docs: pzDocs,
    latest_ksef_created_at: latestKsef?.created_at ?? null,
    cost_doc_ksef_overlap: costDocKsefOverlap,
    foreign_currency_costs: foreignCurrencyCosts,
  })
  const complete = !checks.some(c => c.severity === 'error')

  // Gotówka
  const { cash, cash_total, cash_date } = computeCashPosition({
    balances: balanceRows,
    unpaid_records: unpaidRecords,
    module_matched_ids: moduleMatched.map(r => r.matched_id!).filter(Boolean),
    issued_invoices: issuedInvoices,
    ksef_payables: ksefPayables,
    today: todayW.iso,
  })

  return {
    kind: info.kind,
    period: info.period,
    label: info.label,
    range,
    status: computeStatus(lines, complete),
    headline: buildHeadline(info.label, lines, costs),
    subline: buildSubline(checks),
    complete,
    tiles: { revenue: lines.revenue, costs, ebitda: lines.ebitda, ebitda_pct: lines.ebitda_pct, net_result: lines.net_result, cash: cash_total, cash_date },
    lines,
    compare,
    trend,
    cost_breakdown,
    taxes,
    checks,
    cash,
    generated_at: new Date().toISOString(),
  }
}
