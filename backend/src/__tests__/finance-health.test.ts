/**
 * Testy czystych funkcji „Kondycji firmy" — okresy, status, nagłówki, checki, podział kosztów,
 * podatki, gotówka, harmonogram i HTML raportu. Bez bazy (fixture'y).
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/finance-health.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LINES, finalizeLines, type PnlLines } from '../routes/finance'
import {
  parsePeriod, shiftPeriod, yoyPeriod, monthsInRange, lastDayOf, shortMonthLabel, monthLabel,
  formatPln, plural, computeCosts, computeStatus, buildHeadline, buildSubline, buildChecks,
  costBreakdown, computeTaxes, computeCashPosition, cmpOf, subcategoryLabels, countCostDocKsefOverlap, isPlnCost,
  type HealthResponse, type HealthCheck,
} from '../services/finance-health'
import { buildReportEmail, buildIncompleteEmail, parseEmails, deltaText, esc } from '../services/finance-report'
import { dueReports } from '../services/report-scheduler'

function lines(p: Partial<PnlLines>): PnlLines {
  return finalizeLines({ ...EMPTY_LINES(), provisional: false, ...p })
}

describe('okresy', () => {
  test('parsePeriod: miesiąc', () => {
    const p = parsePeriod('2026-08')
    assert.equal(p.kind, 'monthly')
    assert.equal(p.label, 'Sierpień 2026')
    assert.deepEqual(p.range, { from: '2026-08', to: '2026-08' })
    assert.equal(p.year, 2026)
  })
  test('parsePeriod: kwartał (małe q też)', () => {
    const p = parsePeriod('2026-q3')
    assert.equal(p.kind, 'quarterly')
    assert.equal(p.period, '2026-Q3')
    assert.equal(p.label, 'III kwartał 2026')
    assert.deepEqual(p.range, { from: '2026-07', to: '2026-09' })
  })
  test('parsePeriod: domyślnie poprzedni miesiąc (Warsaw)', () => {
    // 1 stycznia 00:30 UTC = 01:30 w Warszawie → poprzedni miesiąc to grudzień 2025
    const p = parsePeriod(undefined, new Date('2026-01-01T00:30:00Z'))
    assert.equal(p.period, '2025-12')
    // 31 grudnia 23:30 UTC = 1 stycznia 00:30 w Warszawie → też grudzień
    assert.equal(parsePeriod('', new Date('2025-12-31T23:30:00Z')).period, '2025-12')
  })
  test('parsePeriod: błędne formaty rzucają', () => {
    for (const bad of ['2026-13', '2026-Q5', '2026', 'sierpień', '2026-8']) assert.throws(() => parsePeriod(bad), /Nieprawidłowy okres/)
  })
  test('shiftPeriod / yoyPeriod: przekraczanie roku', () => {
    assert.equal(shiftPeriod(parsePeriod('2026-01'), -1).period, '2025-12')
    assert.equal(shiftPeriod(parsePeriod('2026-Q1'), -1).period, '2025-Q4')
    assert.equal(shiftPeriod(parsePeriod('2025-Q4'), 1).period, '2026-Q1')
    assert.equal(yoyPeriod(parsePeriod('2026-08')).period, '2025-08')
    assert.equal(yoyPeriod(parsePeriod('2026-Q3')).label, 'III kwartał 2025')
  })
  test('monthsInRange / lastDayOf / etykiety', () => {
    assert.deepEqual(monthsInRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02'])
    assert.equal(lastDayOf('2026-02'), '2026-02-28')
    assert.equal(lastDayOf('2024-02'), '2024-02-29')
    assert.equal(lastDayOf('2026-12'), '2026-12-31')
    assert.equal(shortMonthLabel('2026-08'), 'Sie 26')
    assert.equal(shortMonthLabel('2026-10'), 'Paź 26')
    assert.equal(monthLabel('2026-03'), 'Marzec 2026')
  })
})

describe('formatowanie', () => {
  test('formatPln: pełne złote z separatorem tysięcy', () => {
    assert.equal(formatPln(38400.49), '38 400 zł')
    assert.equal(formatPln(1234567.5), '1 234 568 zł')
    assert.equal(formatPln(999), '999 zł')
    assert.equal(formatPln(0), '0 zł')
    assert.equal(formatPln(-12300), '−12 300 zł')
    assert.equal(formatPln(-0.2), '0 zł')
  })
  test('plural: polska odmiana', () => {
    const f = (n: number) => `${n} ${plural(n, 'faktura', 'faktury', 'faktur')}`
    assert.equal(f(1), '1 faktura')
    assert.equal(f(3), '3 faktury')
    assert.equal(f(5), '5 faktur')
    assert.equal(f(12), '12 faktur')
    assert.equal(f(22), '22 faktury')
    assert.equal(f(112), '112 faktur')
  })
})

describe('status i nagłówek', () => {
  test('computeCosts: cogs + opex + amortyzacja + finansowe, bez CIT', () => {
    const l = lines({ revenue: 100000, cogs_purchases: 40000, opex_ga: 20000, depreciation: 1000, financial_costs: 500, cit: 9000 })
    assert.equal(computeCosts(l), 61500)
  })
  test('computeStatus: red / yellow / green', () => {
    assert.equal(computeStatus({ ebitda: -1, ebitda_pct: -1 }, true), 'red')
    assert.equal(computeStatus({ ebitda: 100, ebitda_pct: 4.9 }, true), 'yellow')
    assert.equal(computeStatus({ ebitda: 100, ebitda_pct: 20 }, false), 'yellow')
    assert.equal(computeStatus({ ebitda: 100, ebitda_pct: 5 }, true), 'green')
    assert.equal(computeStatus({ ebitda: 0, ebitda_pct: 0 }, true), 'yellow')
  })
  test('buildHeadline: zysk z marżą / strata / brak danych', () => {
    const zysk = lines({ revenue: 350000, cogs_purchases: 200000, opex_ga: 100000, depreciation: 5000, financial_costs: 600, cit: 6000 })
    assert.equal(zysk.net_result, 38400)
    assert.equal(buildHeadline('Sierpień 2026', zysk, computeCosts(zysk)), 'Sierpień 2026: zarobiliście 38 400 zł na czysto (marża 11 %).')
    const strata = lines({ revenue: 100000, cogs_purchases: 112300 })
    assert.equal(buildHeadline('Lipiec 2026', strata, computeCosts(strata)), 'Lipiec 2026: strata 12 300 zł.')
    const pusty = lines({})
    assert.match(buildHeadline('Czerwiec 2026', pusty, 0), /brak danych/)
    const bezPrzychodu = lines({ revenue: 0, revenue_advances: 0 })
    bezPrzychodu.net_result = 10
    assert.equal(buildHeadline('X', bezPrzychodu, 100), 'X: zarobiliście 10 zł na czysto.')
  })
  test('buildSubline: kompletne / braki', () => {
    const w: HealthCheck = { key: 'ksef_unallocated', severity: 'warn', message: 'x' }
    assert.equal(buildSubline([]), 'Dane kompletne.')
    assert.equal(buildSubline([w, w]), 'Dane kompletne. Do sprawdzenia: 2 uwagi.')
    assert.equal(buildSubline([{ key: 'mt940_missing', severity: 'error', message: 'm' }]), 'Brakuje wyciągu MT940 — wynik może być zawyżony.')
    assert.match(buildSubline([{ key: 'firmao_missing', severity: 'error', message: 'f' }]), /Firmao/)
    assert.match(buildSubline([{ key: 'mt940_missing', severity: 'error', message: 'm' }, { key: 'firmao_missing', severity: 'error', message: 'f' }]), /MT940 i importu Firmao/)
  })
})

describe('buildChecks', () => {
  const base = {
    months: ['2026-07', '2026-08', '2026-09'],
    today_month: '2026-10',
    mt940_months: ['2026-07', '2026-08', '2026-09'],
    provisional_months: [] as string[],
    ksef_unallocated: 0, cost_docs_pending: 0, bank_review_pending: 0,
    accountant_months: ['2026-07', '2026-08', '2026-09'],
    accountant_diffs: [] as Array<{ period: string; ours: number; theirs: number; theirs_costs: number }>,
    cogs_purchases: 0, pz_docs: 0,
    latest_ksef_created_at: '2026-10-05T10:00:00.000Z',
    now: new Date('2026-10-06T10:00:00.000Z'),
  }
  test('komplet danych → brak checków', () => {
    assert.deepEqual(buildChecks(base), [])
  })
  test('brak MT940 i Firmao → errory z linkami, posortowane wg wagi', () => {
    const c = buildChecks({ ...base, mt940_months: ['2026-07'], provisional_months: ['2026-09'], ksef_unallocated: 3, latest_ksef_created_at: '2026-09-01T00:00:00Z' })
    assert.deepEqual(c.map(x => x.key), ['mt940_missing', 'firmao_missing', 'ksef_unallocated', 'ksef_sync_stale'])
    const mt = c[0]
    assert.equal(mt.severity, 'error'); assert.equal(mt.count, 2); assert.equal(mt.link, '/platnosci')
    assert.match(mt.message, /Sierpień 2026, Wrzesień 2026/)
    assert.equal(c[1].link, '/rentownosc')
    assert.match(c[2].message, /^3 faktury kosztowe/)
    assert.equal(c[2].link, '/finanse')
    assert.match(c[3].message, /35 dni temu/)
    assert.equal(c[3].link, '/ksef')
  })
  test('miesiące przyszłe nie są sprawdzane', () => {
    const c = buildChecks({ ...base, today_month: '2026-08', mt940_months: ['2026-07', '2026-08'], accountant_months: ['2026-07', '2026-08'] })
    assert.deepEqual(c, [])
  })
  test('warny i info: dokumenty, przelewy, księgowa, PZ', () => {
    const c = buildChecks({
      ...base, cost_docs_pending: 1, bank_review_pending: 5, accountant_months: ['2026-07', '2026-08'],
      accountant_diffs: [
        { period: '2026-07', ours: 10000, theirs: 9600, theirs_costs: 50000 },   // 400 < 2500 → ok
        { period: '2026-08', ours: 38400, theirs: 30000, theirs_costs: 100000 }, // 8400 > 5000 → diff
      ],
      cogs_purchases: 12000, pz_docs: 0,
    })
    const keys = c.map(x => x.key)
    assert.deepEqual(keys, ['cost_docs_pending', 'bank_review_pending', 'accountant_diff', 'accountant_missing', 'inventory_docs_missing'])
    assert.match(c[0].message, /^1 dokument czeka/)
    assert.equal(c[0].link, '/koszty-spoza-ksef')
    assert.match(c[1].message, /^5 przelewów/)
    const diff = c[2]
    assert.equal(diff.count, 1)
    assert.match(diff.message, /Sierpień 2026 różni się od księgowej o 8 400 zł/)
    assert.equal(c[3].severity, 'info'); assert.match(c[3].message, /Wrzesień 2026/)
    assert.equal(c[4].link, '/magazyn'); assert.match(c[4].message, /12 000 zł/)
  })
  test('próg księgowej: max(500, 5 %)', () => {
    const small = buildChecks({ ...base, accountant_diffs: [{ period: '2026-08', ours: 1000, theirs: 400, theirs_costs: 1000 }] }) // diff 600 > 500
    assert.equal(small[0]?.key, 'accountant_diff')
    const ok = buildChecks({ ...base, accountant_diffs: [{ period: '2026-08', ours: 1000, theirs: 500, theirs_costs: 1000 }] })  // diff 500 = próg → ok
    assert.deepEqual(ok, [])
  })
  test('KSeF: świeża synchronizacja lub brak faktur → bez checka', () => {
    assert.deepEqual(buildChecks({ ...base, latest_ksef_created_at: null }), [])
    assert.deepEqual(buildChecks({ ...base, latest_ksef_created_at: '2026-10-04T00:00:00Z' }), [])
  })
  test('dokument zatwierdzony z odpowiednikiem w KSeF i koszty w walucie obcej → warny', () => {
    assert.deepEqual(buildChecks({ ...base, cost_doc_ksef_overlap: 0, foreign_currency_costs: 0 }), [])
    const c = buildChecks({ ...base, cost_doc_ksef_overlap: 2, foreign_currency_costs: 1 })
    assert.deepEqual(c.map(x => [x.key, x.severity, x.count, x.link]), [
      ['cost_doc_ksef_overlap', 'warn', 2, '/koszty-spoza-ksef'],
      ['manual_costs_foreign_currency', 'warn', 1, '/rentownosc'],
    ])
    assert.match(c[0].message, /^2 zatwierdzone dokumenty spoza KSeF mają odpowiednik/)
    assert.match(c[0].message, /dwa razy/)
    assert.match(c[1].message, /^Koszty w walucie obcej bez kursu: 1/)
    assert.match(buildChecks({ ...base, cost_doc_ksef_overlap: 5 })[0].message, /^5 zatwierdzonych dokumentów spoza KSeF ma odpowiednik/)
  })
})

describe('countCostDocKsefOverlap / isPlnCost', () => {
  const docs = [
    // (1) ten sam NIP i kwota brutto — faktura krajowa zatwierdzona z PDF-a, potem trafiła do KSeF
    { id: 'd1', seller_name: 'Alfa Sp. z o.o.', seller_nip: '5261040828', doc_number: 'FV/2026/08/12', doc_date: '2026-08-28', gross_pln: 12300 },
    // (2) ten sam numer i sprzedawca, kwota inna (np. dokument w EUR przeliczony) — też trafienie
    { id: 'd2', seller_name: 'Beta Systems', seller_nip: '', doc_number: 'B-77/2026', doc_date: '2026-08-10', gross_pln: 999 },
    // (3) inny NIP, inna kwota — brak trafienia
    { id: 'd3', seller_name: 'Gamma', seller_nip: '1111111111', doc_number: 'X1', doc_date: '2026-08-11', gross_pln: 500 },
    // (4) pasuje jak (1), ale koszt tego dokumentu jest już wykluczony z RZiS — nie dubluje
    { id: 'd4', seller_name: 'Alfa Sp. z o.o.', seller_nip: '5261040828', doc_number: 'FV/2026/08/13', doc_date: '2026-08-29', gross_pln: 246 },
  ]
  const invoices = [
    { id: 'k1', seller_nip: 'PL5261040828', seller_name: 'ALFA SPÓŁKA Z O.O.', invoice_number: 'FV/2026/08/12', gross_amount: 12300.01, invoice_date: '2026-08-28' },
    { id: 'k2', seller_nip: '9999999999', seller_name: 'Beta Systems S.A.', invoice_number: 'B 77 2026', gross_amount: 1500, invoice_date: '2026-08-10' },
    { id: 'k3', seller_nip: '5261040828', seller_name: 'Alfa', invoice_number: 'FV/2026/08/13', gross_amount: 246, invoice_date: '2026-08-29' },
  ]
  test('liczy dokumenty z odpowiednikiem w KSeF, pomija wykluczone z RZiS', () => {
    assert.equal(countCostDocKsefOverlap(docs, invoices), 3)          // d1, d2, d4
    assert.equal(countCostDocKsefOverlap(docs, invoices, ['d4']), 2)  // d4 wykluczony → nie dubluje
    assert.equal(countCostDocKsefOverlap(docs, []), 0)
    assert.equal(countCostDocKsefOverlap([], invoices), 0)
    assert.equal(countCostDocKsefOverlap([docs[2]], invoices), 0)
  })
  test('isPlnCost: brak waluty lub PLN → true; EUR → false', () => {
    assert.equal(isPlnCost({}), true)
    assert.equal(isPlnCost({ currency: null }), true)
    assert.equal(isPlnCost({ currency: 'PLN' }), true)
    assert.equal(isPlnCost({ currency: ' pln ' }), true)
    assert.equal(isPlnCost({ currency: 'EUR' }), false)
  })
})

describe('podział kosztów', () => {
  test('top 6 + Pozostałe, procenty, etykiety', () => {
    const labels = { ...subcategoryLabels(), zzz: 'Zet' }
    const items = [
      { subcategory: 'hardware', amount: 5000 }, { subcategory: 'hardware', amount: 5000 },
      { subcategory: 'salary_gross', amount: 30000 }, { subcategory: 'zus_employer', amount: 6000 },
      { subcategory: 'rent', amount: 4000 }, { subcategory: 'car_fuel', amount: 2000 }, { subcategory: 'software', amount: 1500 },
      { subcategory: 'zzz', amount: 300 }, { subcategory: 'nieznana', amount: 200 }, { subcategory: 'ujemna', amount: -50 },
    ]
    const b = costBreakdown(items, labels)
    assert.equal(b.length, 7)
    assert.deepEqual(b.map(x => x.key), ['salary_gross', 'hardware', 'zus_employer', 'rent', 'car_fuel', 'software', 'other'])
    assert.equal(b[0].label, 'Wynagrodzenia brutto (UoP)')
    assert.equal(b[1].amount, 10000)
    assert.equal(b[1].label, 'Sprzęt krajowy (KNX/HDL/Control4…)')
    assert.equal(b[6].label, 'Pozostałe'); assert.equal(b[6].amount, 500)
    const total = b.reduce((s, x) => s + x.amount, 0)
    assert.equal(total, 54000)
    assert.equal(b[0].pct, Math.round(30000 / 54000 * 1000) / 10)
    assert.ok(Math.abs(b.reduce((s, x) => s + x.pct, 0) - 100) < 0.5)
  })
  test('etykieta z emoji jest oczyszczona, fallback = klucz', () => {
    const b = costBreakdown([{ subcategory: 'hardware_eu', amount: 1 }, { subcategory: 'xyz', amount: 1 }], subcategoryLabels())
    assert.equal(b[0].label, 'Sprzęt z UE (WNT)')
    assert.equal(b[1].label, 'xyz')
  })
  test('pusto → pusta lista', () => { assert.deepEqual(costBreakdown([], {}), []) })
})

describe('podatki', () => {
  test('VAT, CIT YTD (min 0), do dopłaty, ZUS', () => {
    const t = computeTaxes({
      vat_output: 23000, vat_input: 15000.005, cit_rate: 9,
      ytd: [{ ebit: 10000, financial_costs: 0 }, { ebit: -3000, financial_costs: 500 }, { ebit: 20000, financial_costs: 1500 }],
      cit_paid_ytd: 1000, zus: 6200.4,
    })
    assert.equal(t.vat_due_estimate, 8000)
    assert.equal(t.vat_input, 15000.01)
    assert.equal(t.cit_base_ytd, 25000)
    assert.equal(t.cit_estimate_ytd, 2250)
    assert.equal(t.cit_paid_ytd, 1000)
    assert.equal(t.cit_to_pay_estimate, 1250)
    assert.equal(t.zus, 6200.4)
    assert.equal(t.cit_rate, 9)
    assert.match(t.note, /księgowa/)
  })
  test('strata → podstawa 0, nadpłata → do dopłaty 0', () => {
    const t = computeTaxes({ vat_output: 0, vat_input: 100, cit_rate: 19, ytd: [{ ebit: -5000, financial_costs: 0 }], cit_paid_ytd: 300, zus: 0 })
    assert.equal(t.cit_base_ytd, 0); assert.equal(t.cit_estimate_ytd, 0); assert.equal(t.cit_to_pay_estimate, 0)
    assert.equal(t.vat_due_estimate, -100)
  })
})

describe('gotówka', () => {
  test('najnowsze saldo per konto, suma PLN, należności i zobowiązania z przeterminowaniem', () => {
    const r = computeCashPosition({
      balances: [
        { account: 'PL1', currency: 'PLN', closing: 50000, date: '2026-08-31' },
        { account: 'PL1', currency: 'PLN', closing: 40000, date: '2026-08-15' },
        { account: 'PL2', currency: 'PLN', closing: 12000.555, date: '2026-08-28' },
        { account: 'EUR1', currency: 'EUR', closing: 3000, date: '2026-08-31' },
      ],
      unpaid_records: [{ gross: 1230, due_date: '2026-09-01' }, { gross: 2000, due_date: '2026-09-20' }, { gross: 500, due_date: '' }],
      module_matched_ids: ['inv-2'],
      issued_invoices: [{ id: 'inv-1', total_gross: 1000, due_date: '2026-08-01' }, { id: 'inv-2', total_gross: 9999, due_date: '2026-08-01' }],
      ksef_payables: [{ gross_amount: 700, payment_due_date: '2026-09-10' }, { gross_amount: 300, payment_due_date: '2026-09-30' }, { gross_amount: 100, payment_due_date: null }],
      today: '2026-09-15',
    })
    assert.deepEqual(r.cash.balances.map(b => [b.account, b.closing, b.date]), [['EUR1', 3000, '2026-08-31'], ['PL1', 50000, '2026-08-31'], ['PL2', 12000.56, '2026-08-28']])
    assert.equal(r.cash.total_pln, 62000.56)
    assert.equal(r.cash_total, 62000.56)
    assert.equal(r.cash_date, '2026-08-31')
    assert.equal(r.cash.receivables, 4730)          // 1230 + 2000 + 500 + 1000 (inv-2 zdeduplikowana)
    assert.equal(r.cash.overdue_receivables, 2230)  // 1230 + 1000
    assert.equal(r.cash.payables, 1100)
    assert.equal(r.cash.overdue_payables, 700)
  })
  test('brak sald → total null; saldo tylko EUR → też null (nie „0 zł z datą wyciągu EUR"), saldo EUR zostaje na liście', () => {
    const empty = computeCashPosition({ balances: [], unpaid_records: [], module_matched_ids: [], issued_invoices: [], ksef_payables: [], today: '2026-09-15' })
    assert.equal(empty.cash.total_pln, null); assert.equal(empty.cash_date, null)
    const eur = computeCashPosition({ balances: [{ account: 'E', currency: 'EUR', closing: 10, date: '2026-01-01' }], unpaid_records: [], module_matched_ids: [], issued_invoices: [], ksef_payables: [], today: '2026-09-15' })
    assert.equal(eur.cash.total_pln, null); assert.equal(eur.cash_total, null); assert.equal(eur.cash_date, null)
    assert.deepEqual(eur.cash.balances, [{ account: 'E', currency: 'EUR', closing: 10, date: '2026-01-01' }])
  })
})

describe('harmonogram', () => {
  test('dueReports: wyłączony / przed dniem / miesięczny / kwartalny', () => {
    assert.deepEqual(dueReports({ reports_enabled: false, report_day: 10 }, { year: 2026, month: 10, day: 15 }), [])
    assert.deepEqual(dueReports({ reports_enabled: true, report_day: 10 }, { year: 2026, month: 9, day: 9 }), [])
    assert.deepEqual(dueReports({ reports_enabled: true, report_day: 10 }, { year: 2026, month: 9, day: 10 }), [{ kind: 'monthly', period: '2026-08' }])
    assert.deepEqual(dueReports({ reports_enabled: true, report_day: 5 }, { year: 2026, month: 10, day: 20 }), [
      { kind: 'monthly', period: '2026-09' }, { kind: 'quarterly', period: '2026-Q3' },
    ])
    assert.deepEqual(dueReports({ reports_enabled: true, report_day: 1 }, { year: 2026, month: 1, day: 1 }), [
      { kind: 'monthly', period: '2025-12' }, { kind: 'quarterly', period: '2025-Q4' },
    ])
    assert.deepEqual(dueReports({ reports_enabled: true, report_day: 3 }, { year: 2026, month: 4, day: 3 }), [
      { kind: 'monthly', period: '2026-03' }, { kind: 'quarterly', period: '2026-Q1' },
    ])
    assert.deepEqual(dueReports({ reports_enabled: true, report_day: 3 }, { year: 2026, month: 7, day: 30 }).map(d => d.period), ['2026-06', '2026-Q2'])
  })
})

describe('raport e-mail', () => {
  const l = lines({ revenue: 350000, cogs_purchases: 200000, opex_ga: 100000, depreciation: 5000, financial_costs: 600, cit: 6000 })
  const health: HealthResponse = {
    kind: 'monthly', period: '2026-08', label: 'Sierpień 2026', range: { from: '2026-08', to: '2026-08' },
    status: 'green', headline: buildHeadline('Sierpień 2026', l, computeCosts(l)), subline: 'Dane kompletne.', complete: true,
    tiles: { revenue: l.revenue, costs: computeCosts(l), ebitda: l.ebitda, ebitda_pct: l.ebitda_pct, net_result: l.net_result, cash: 62000.56, cash_date: '2026-08-31' },
    lines: l,
    compare: { prev: cmpOf('Lipiec 2026', lines({ revenue: 300000, cogs_purchases: 190000, opex_ga: 90000 })), yoy: null },
    trend: [{ period: '2026-08', label: 'Sie 26', revenue: 350000, costs: 305600, ebitda: 50000 }],
    cost_breakdown: [{ key: 'salary_gross', label: 'Wynagrodzenia brutto (UoP)', amount: 30000, pct: 60 }, { key: 'other', label: 'Pozostałe', amount: 20000, pct: 40 }],
    taxes: computeTaxes({ vat_output: 80500, vat_input: 46000, cit_rate: 9, ytd: [l], cit_paid_ytd: 0, zus: 6000 }),
    checks: [{ key: 'ksef_unallocated', severity: 'warn', message: '2 faktury kosztowe z KSeF bez kategorii — <test>', count: 2, link: '/finanse' }],
    cash: { balances: [{ account: 'PL1', currency: 'PLN', closing: 62000.56, date: '2026-08-31' }], total_pln: 62000.56, receivables: 4730, overdue_receivables: 2230, payables: 1100, overdue_payables: 700 },
    generated_at: '2026-09-15T08:00:00.000Z',
  }
  test('buildReportEmail: temat, sekcje, kafle, link z APP_URL, escapowanie', () => {
    const prevUrl = process.env.APP_URL
    process.env.APP_URL = 'https://test.example'
    try {
      const { subject, html } = buildReportEmail(health, 'Smart Home Center')
      assert.equal(subject, '🟢 Kondycja firmy — Sierpień 2026: zysk 38 400 zł')
      assert.match(html, /Smart Home Center/)
      assert.match(html, /zarobiliście 38 400 zł na czysto \(marża 11 %\)/)
      for (const s of ['Przychód', 'Koszty', 'Zysk EBITDA', 'Gotówka', 'Porównanie', 'Na co idą pieniądze', 'Podatki', 'Do sprawdzenia', 'Raport wygenerowany automatycznie przez SHC Manager']) {
        assert.ok(html.includes(s), `brak sekcji: ${s}`)
      }
      assert.match(html, /350 000 zł/)
      assert.match(html, /62 001 zł/)                 // gotówka zaokrąglona do złotych
      assert.match(html, /stan na 2026-08-31/)
      assert.match(html, /Lipiec 2026/)
      assert.match(html, /▲ \+17 %/)                  // przychód 350k vs 300k
      assert.match(html, /Wynagrodzenia brutto \(UoP\)/)
      assert.match(html, /60 %/)
      assert.match(html, /34 500 zł/)                 // VAT do zapłaty
      assert.match(html, /https:\/\/test\.example\/finanse/)
      assert.ok(html.includes('&lt;test&gt;'), 'komunikat checka powinien być escapowany')
      assert.ok(!html.includes('<test>'))
      assert.ok(!/src=|<link|<script/.test(html), 'bez zasobów zewnętrznych')
    } finally {
      if (prevUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = prevUrl
    }
  })
  test('buildReportEmail: brak gotówki i strata', () => {
    const strata = lines({ revenue: 100000, cogs_purchases: 112300 })
    const h: HealthResponse = { ...health, status: 'red', lines: strata, headline: buildHeadline('Lipiec 2026', strata, computeCosts(strata)), label: 'Lipiec 2026',
      tiles: { ...health.tiles, cash: null, cash_date: null, ebitda: strata.ebitda, net_result: strata.net_result }, compare: { prev: null, yoy: null }, cost_breakdown: [], checks: [] }
    const { subject, html } = buildReportEmail(h, '')
    assert.equal(subject, '🔴 Kondycja firmy — Lipiec 2026: strata 12 300 zł')
    assert.match(html, /wgraj wyciąg MT940/)
    assert.match(html, /brak danych/)
    assert.match(html, /Nic do sprawdzenia/)
    assert.match(html, /Brak kosztów w tym okresie/)
  })
  test('buildIncompleteEmail: lista błędów z linkami', () => {
    const h: HealthResponse = { ...health, complete: false, checks: [
      { key: 'mt940_missing', severity: 'error', message: 'Brak wyciągu MT940 za Sierpień 2026', link: '/platnosci' },
      { key: 'ksef_unallocated', severity: 'warn', message: 'warn nie wchodzi', link: '/finanse' },
    ] }
    const { subject, html, missing } = buildIncompleteEmail(h)
    assert.equal(subject, '⏳ Raport „Kondycja firmy" za Sierpień 2026 czeka na dane')
    assert.deepEqual(missing, ['Brak wyciągu MT940 za Sierpień 2026'])
    assert.match(html, /czeka na dane/)
    assert.match(html, /\/platnosci/)
    assert.ok(!html.includes('warn nie wchodzi'))
  })
  test('parseEmails / deltaText / esc', () => {
    assert.deepEqual(parseEmails(' a@x.pl, b@y.pl;c@z.pl  zle-bez-malpy '), ['a@x.pl', 'b@y.pl', 'c@z.pl'])
    assert.deepEqual(parseEmails(null), [])
    assert.equal(deltaText(110, 100), '▲ +10 %')
    assert.equal(deltaText(90, 100), '▼ −10 %')
    assert.equal(deltaText(100, 100), '= 0 %')
    assert.equal(deltaText(100, 0), '—')
    assert.equal(deltaText(-50, -100), '▲ +50 %')
    assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;')
  })
})
