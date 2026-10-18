/**
 * Prognoza gotówki — saldo dzień po dniu na najbliższe N dni (7–90).
 * Mount: /api/finance/cashflow (admin lub can_view_payments).
 *
 * Start = suma najnowszych sald PLN z wyciągów MT940 (BankBalance).
 * Wpływy: nieopłacone faktury sprzedażowe (Firmao `SalesRecord paid=false` + moduł `SalesInvoice issued`).
 * Wypływy: nieopłacone faktury kosztowe z KSeF + „stałe" (pensje, ZUS, podatki, czynsz, leasing)
 * uśrednione z 3 ostatnich pełnych miesięcy przelewów MT940 (dzień = mediana dnia miesiąca).
 * Czysta logika prognozy: `projectCashflow(inputs)` (testowana bez bazy).
 */
import { Router, Request, Response } from 'express'
import { prisma } from '../db'
import { requirePayments } from './payables'
import { addMonths } from './finance'

const router = Router()
router.use(requirePayments)

export const RECURRING_SUBCATEGORIES = ['salary_gross', 'salary_admin', 'zus_employer', 'tax_vat', 'tax_income', 'rent', 'leasing'] as const
const RECURRING_SET = new Set<string>(RECURRING_SUBCATEGORIES)
const RECURRING_LABELS: Record<string, string> = {
  salary_gross: 'Wynagrodzenia (umowy o pracę)',
  salary_admin: 'Wynagrodzenia — administracja',
  zus_employer: 'ZUS',
  tax_vat: 'VAT do urzędu skarbowego',
  tax_income: 'CIT / zaliczka na podatek dochodowy',
  rent: 'Czynsz',
  leasing: 'Leasing',
}

// ── Typy ─────────────────────────────────────────────────────────────────────
export interface OpenItem { label: string; amount: number; due_date: string }
export interface RecurringItem { label: string; amount: number; day_of_month: number; subcategory: string }
export interface DayItem { kind: 'receivable' | 'payable' | 'recurring'; label: string; amount: number }
export interface CashflowDay { date: string; inflow: number; outflow: number; balance: number; items: DayItem[] }

export interface CashflowInputs {
  as_of: string                       // YYYY-MM-DD (dziś)
  days: number                        // horyzont 7–90
  start_balance: number | null        // suma sald PLN; null = brak wyciągów
  balance_date?: string | null        // data najnowszego salda PLN (ostrzeżenie, gdy stare)
  foreign_currencies?: string[]       // waluty sald pominiętych w prognozie
  skipped_fx_invoices?: number        // faktury w walutach obcych pominięte
  receivables: OpenItem[]             // due_date '' → +14 dni od dziś
  payables: OpenItem[]
  recurring: RecurringItem[]
  paid_this_month?: string[]          // podkategorie „stałych" już opłacone w bieżącym miesiącu
}

export interface CashflowProjection {
  days: CashflowDay[]
  min: { date: string; balance: number }
  end_balance: number
  warnings: string[]
  receivables: Array<OpenItem & { overdue: boolean }>
  payables: Array<OpenItem & { overdue: boolean }>
  recurring: RecurringItem[]
}

// ── Pomocnicze daty (UTC, bez wpływu strefy) ──────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const r2 = (x: number) => Math.round(x * 100) / 100

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

/** Części daty YYYY-MM-DD (dopuszczalny sufiks, np. 'T00:00:00Z'); null dla innych formatów. */
function parseIso(s: string | null | undefined): [number, number, number] | null {
  const m = ISO_DATE_RE.exec(String(s ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Data ISO YYYY-MM-DD (obcięta do 10 znaków) lub '' gdy wartość nie jest w tym formacie. */
export function isoDate(s: string | null | undefined): string {
  return parseIso(s) ? String(s).slice(0, 10) : ''
}

/** +n dni; dla daty spoza formatu YYYY-MM-DD zwraca '' (= brak terminu) zamiast rzucać RangeError. */
export function addDays(iso: string, n: number): string {
  const p = parseIso(iso)
  if (!p) return ''
  const [y, m, d] = p
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Różnica dni to − from; 0 gdy któraś z dat nie jest w formacie YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  const a = parseIso(from)
  const b = parseIso(to)
  if (!a || !b) return 0
  const [y1, m1, d1] = a
  const [y2, m2, d2] = b
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const fmtPln = (x: number) => new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(x)

// ── Czyste funkcje (testowane) ────────────────────────────────────────────────

/** Wpływ: termin lub +14 dni; przeterminowany → zakładamy wpływ za 7 dni. */
export function expectedInflowDate(due: string, asOf: string): { date: string; overdue: boolean } {
  const d = due || addDays(asOf, 14)
  return d < asOf ? { date: addDays(asOf, 7), overdue: true } : { date: d, overdue: false }
}

/** Wypływ: termin lub +14 dni; przeterminowany → płacimy za 3 dni. */
export function expectedOutflowDate(due: string, asOf: string): { date: string; overdue: boolean } {
  const d = due || addDays(asOf, 14)
  return d < asOf ? { date: addDays(asOf, 3), overdue: true } : { date: d, overdue: false }
}

function median(values: number[]): number {
  if (!values.length) return 1
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * „Stałe" wypływy: dla każdej podkategorii z listy średnia miesięczna z podanych miesięcy
 * (Σ / liczba miesięcy) i mediana dnia miesiąca przelewów.
 */
export function computeRecurring(
  costs: Array<{ date: string; amount: number; subcategory: string }>,
  months: string[],
): RecurringItem[] {
  if (!months.length) return []
  const monthSet = new Set(months)
  const bySub = new Map<string, { total: number; days: number[] }>()
  for (const c of costs) {
    if (!RECURRING_SET.has(c.subcategory) || !monthSet.has(String(c.date).slice(0, 7))) continue
    const e = bySub.get(c.subcategory) ?? { total: 0, days: [] }
    e.total += Math.abs(Number(c.amount) || 0)
    e.days.push(parseInt(String(c.date).slice(8, 10), 10) || 1)
    bySub.set(c.subcategory, e)
  }
  return RECURRING_SUBCATEGORIES
    .filter(s => bySub.has(s))
    .map(s => {
      const e = bySub.get(s)!
      return { label: RECURRING_LABELS[s] ?? s, amount: r2(e.total / months.length), day_of_month: median(e.days), subcategory: s }
    })
    .filter(r => r.amount > 0)
}

/** Daty wystąpień stałego wypływu w [asOf, end]; bieżący miesiąc pomijany, gdy już opłacony. */
function recurringDates(item: RecurringItem, asOf: string, end: string, paidThisMonth: Set<string>): string[] {
  const out: string[] = []
  let [y, m] = asOf.split('-').map(Number)
  const curPeriod = asOf.slice(0, 7)
  for (let k = 0; k < 5; k++) {
    const period = `${y}-${pad(m)}`
    if (`${period}-01` > end) break
    const day = Math.min(Math.max(1, item.day_of_month), daysInMonth(y, m))
    const date = `${period}-${pad(day)}`
    if (date >= asOf && date <= end && !(period === curPeriod && paidThisMonth.has(item.subcategory))) out.push(date)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

/** Prognoza salda dzień po dniu (czysta funkcja — bez bazy). */
export function projectCashflow(inputs: CashflowInputs): CashflowProjection {
  const days = Math.min(90, Math.max(7, Math.floor(Number(inputs.days) || 30)))
  const asOf = inputs.as_of
  const end = addDays(asOf, days)
  const warnings: string[] = []
  const paid = new Set(inputs.paid_this_month ?? [])

  const byDate = new Map<string, DayItem[]>()
  const push = (date: string, item: DayItem) => {
    const list = byDate.get(date) ?? []
    list.push(item)
    byDate.set(date, list)
  }

  const receivables: Array<OpenItem & { overdue: boolean }> = []
  for (const it of inputs.receivables) {
    if (!(it.amount > 0)) continue
    const { date, overdue } = expectedInflowDate(it.due_date, asOf)
    if (date > end) continue
    receivables.push({ ...it, amount: r2(it.amount), overdue })
    push(date, { kind: 'receivable', label: it.label, amount: r2(it.amount) })
  }

  const payables: Array<OpenItem & { overdue: boolean }> = []
  for (const it of inputs.payables) {
    if (!(it.amount > 0)) continue
    const { date, overdue } = expectedOutflowDate(it.due_date, asOf)
    if (date > end) continue
    payables.push({ ...it, amount: r2(it.amount), overdue })
    push(date, { kind: 'payable', label: it.label, amount: r2(it.amount) })
  }

  const recurring = inputs.recurring.filter(r => r.amount > 0)
  for (const r of recurring) {
    for (const date of recurringDates(r, asOf, end, paid)) push(date, { kind: 'recurring', label: r.label, amount: r2(r.amount) })
  }

  let balance = r2(inputs.start_balance ?? 0)
  let min = { date: asOf, balance }
  const out: CashflowDay[] = []
  for (let i = 0; i <= days; i++) {
    const date = addDays(asOf, i)
    const items = byDate.get(date) ?? []
    const inflow = r2(items.filter(x => x.kind === 'receivable').reduce((s, x) => s + x.amount, 0))
    const outflow = r2(items.filter(x => x.kind !== 'receivable').reduce((s, x) => s + x.amount, 0))
    balance = r2(balance + inflow - outflow)
    out.push({ date, inflow, outflow, balance, items })
    if (balance < min.balance) min = { date, balance }
  }

  if (inputs.start_balance == null) {
    warnings.push('Brak sald — wgraj wyciąg MT940')
  } else if (inputs.balance_date && daysBetween(inputs.balance_date, asOf) > 7) {
    warnings.push(`Ostatnie saldo pochodzi z ${inputs.balance_date} — wgraj nowszy wyciąg MT940, prognoza może być nieaktualna`)
  }
  if (min.balance < 0) {
    const n = daysBetween(asOf, min.date)
    warnings.push(n <= 0
      ? `Saldo jest już ujemne (${fmtPln(min.balance)} zł)`
      : `Za ${n} dni może zabraknąć gotówki (${min.date}: ${fmtPln(min.balance)} zł)`)
  }
  const overdueRec = receivables.filter(r => r.overdue)
  if (overdueRec.length) {
    warnings.push(`${overdueRec.length} przeterminowanych faktur sprzedażowych na ${fmtPln(overdueRec.reduce((s, r) => s + r.amount, 0))} zł — zakładamy wpływ w ciągu 7 dni`)
  }
  if (inputs.foreign_currencies?.length) {
    warnings.push(`Salda w walutach ${inputs.foreign_currencies.join(', ')} nie są wliczone do prognozy`)
  }
  if (inputs.skipped_fx_invoices) {
    warnings.push(`Pominięto ${inputs.skipped_fx_invoices} faktur w walutach obcych`)
  }

  const byDue = (a: OpenItem, b: OpenItem) => (a.due_date || '9999').localeCompare(b.due_date || '9999')
  return {
    days: out,
    min,
    end_balance: out[out.length - 1].balance,
    warnings,
    receivables: receivables.sort(byDue),
    payables: payables.sort(byDue),
    recurring,
  }
}

// ── GET /api/finance/cashflow?days=30 ─────────────────────────────────────────
function alnum(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const daysRaw = parseInt(String(req.query.days ?? '30'), 10)
    const days = Math.min(90, Math.max(7, isNaN(daysRaw) ? 30 : daysRaw))
    const as_of = new Date().toISOString().slice(0, 10)
    const curMonth = as_of.slice(0, 7)
    const months = [addMonths(curMonth, -3), addMonths(curMonth, -2), addMonths(curMonth, -1)]

    const [balanceRows, salesRecords, salesInvoices, ksefUnpaid, recurringCosts] = await Promise.all([
      prisma.bankBalance.findMany({ orderBy: [{ date: 'desc' }, { statement_no: 'desc' }, { created_at: 'desc' }] }),
      prisma.salesRecord.findMany({
        select: { invoice_number: true, buyer_name: true, sale_date: true, due_date: true, paid: true, gross: true, currency: true, dedup_status: true, matched_id: true },
      }),
      prisma.salesInvoice.findMany({
        where: { status: 'issued' },
        select: { id: true, number: true, buyer_name: true, issue_date: true, sale_date: true, due_date: true, total_gross: true, company_id: true },
      }),
      prisma.ksefInvoice.findMany({
        where: { invoice_direction: 'incoming', OR: [{ payment_status: null }, { payment_status: { not: 'paid' } }] },
        select: { seller_name: true, invoice_number: true, invoice_date: true, payment_due_date: true, gross_amount: true, currency: true },
      }),
      prisma.manualCost.findMany({
        where: { source: 'mt940', subcategory: { in: [...RECURRING_SUBCATEGORIES] }, date: { gte: `${months[0]}-01` } },
        select: { date: true, amount: true, subcategory: true },
      }),
    ])

    // Najnowsze saldo per rachunek (posortowane malejąco po dacie/numerze wyciągu → pierwsze wygrywa)
    const latest = new Map<string, typeof balanceRows[number]>()
    for (const b of balanceRows) if (!latest.has(b.account)) latest.set(b.account, b)
    const balances = [...latest.values()].map(b => ({ account: b.account, currency: b.currency, closing: b.closing, date: b.date }))
    const pln = balances.filter(b => b.currency === 'PLN')
    const total_pln = pln.length ? r2(pln.reduce((s, b) => s + b.closing, 0)) : null
    const balance_date = pln.length ? pln.map(b => b.date).sort().pop() ?? null : null
    const foreign_currencies = [...new Set(balances.filter(b => b.currency !== 'PLN').map(b => b.currency))]

    let skippedFx = 0

    // Wpływy: Firmao (nieopłacone) + moduł faktur (wystawione, bez zdeduplikowanych z Firmao)
    const firmaoNumbers = new Set(salesRecords.map(r => alnum(r.invoice_number)).filter(Boolean))
    const dedupedModuleIds = new Set(salesRecords.filter(r => r.dedup_status === 'module_match' && r.matched_id).map(r => r.matched_id as string))
    const receivables: OpenItem[] = []
    // Daty z bazy to String bez walidacji formatu (API/PUT, KSeF) — wartości spoza YYYY-MM-DD
    // traktujemy jak brak terminu (+14 dni od dziś), zamiast wywalać całą prognozę.
    for (const r of salesRecords) {
      if (r.paid) continue
      if (r.currency && r.currency !== 'PLN') { skippedFx++; continue }
      const due = isoDate(r.due_date) || addDays(isoDate(r.sale_date), 14)
      receivables.push({ label: [r.invoice_number, r.buyer_name].filter(Boolean).join(' · '), amount: r.gross, due_date: due })
    }
    const { moduleInvoiceScope } = await import('./companies')
    const inScope = await moduleInvoiceScope() // należności innej spółki nie wpływają na konto SHC
    for (const inv of salesInvoices) {
      if (!inScope(inv)) continue
      if (dedupedModuleIds.has(inv.id)) continue
      if (inv.number && firmaoNumbers.has(alnum(inv.number))) continue
      const base = isoDate(inv.sale_date) || isoDate(inv.issue_date)
      const due = isoDate(inv.due_date) || addDays(base, 14)
      receivables.push({ label: [inv.number ?? 'szkic', inv.buyer_name].filter(Boolean).join(' · '), amount: inv.total_gross, due_date: due })
    }

    // Wypływy: nieopłacone faktury kosztowe z KSeF
    const payables: OpenItem[] = []
    for (const k of ksefUnpaid) {
      if (k.currency && k.currency !== 'PLN') { skippedFx++; continue }
      const due = isoDate(k.payment_due_date) || addDays(isoDate(k.invoice_date), 14)
      payables.push({ label: [k.seller_name, k.invoice_number].filter(Boolean).join(' · ') || 'Faktura KSeF', amount: k.gross_amount, due_date: due })
    }

    // Stałe: średnia z 3 pełnych miesięcy; w bieżącym miesiącu pomijamy już opłacone podkategorie
    const recurring = computeRecurring(recurringCosts.filter(c => c.date < `${curMonth}-01`), months)
    const paid_this_month = [...new Set(recurringCosts.filter(c => c.date >= `${curMonth}-01`).map(c => c.subcategory))]

    const projection = projectCashflow({
      as_of, days, start_balance: total_pln, balance_date, foreign_currencies, skipped_fx_invoices: skippedFx,
      receivables, payables, recurring, paid_this_month,
    })

    res.json({
      as_of,
      cash: { balances, total_pln },
      has_balances: total_pln !== null,
      ...projection,
    })
  } catch (e) {
    console.error('[cashflow]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
