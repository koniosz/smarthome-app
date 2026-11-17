/**
 * Księgowanie kosztów spoza KSeF w RZiS (routes/finance.ts) — czyste funkcje, bez bazy, dane SYNTETYCZNE:
 * allocateManualCosts / manualLinesByMonth / bookManualCosts / payrollSummary / isKsefInvoicePayment / manualCostDetails.
 *
 * Sprawdza to, co właściciel widzi w wyniku: koszty pracy (pensje, PIT-4, ZUS) w miesiącu, którego dotyczą,
 * szacunek za miesiące bez przelewu, brak podwójnego liczenia (faktura KSeF, przelew własny, VAT) i spójność
 * payroll / payroll_estimate z opex_ga.
 * Uruchomienie: cd backend && DATABASE_URL="postgresql://x:x@localhost:1/x" npx tsx --test src/__tests__/finance-payroll.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateManualCosts, manualLinesByMonth, bookManualCosts, payrollSummary, isKsefInvoicePayment,
  manualCostDetails, ESTIMATE_SOURCE,
  EMPTY_LINES, finalizeLines, monthsOf,
  type ManualCostLike, type ManualMonth, type ManualCostRow,
} from '../routes/finance'
import { buildMatchedIndex, formatFxNote, type MatchedTxLite } from '../services/mt940-costs'
import { computeRecurring } from '../routes/cashflow'

const TODAY = '2026-11'
const NO_MATCHES = buildMatchedIndex([])

let seq = 0
type CostInput = Partial<ManualCostLike> & { date: string; amount: number; subcategory: string }
/** Wiersz kosztu jak z importu wyciągu: G&A, jednostka wspólna, tryb auto, unikalna referencja banku. */
function cost(p: CostInput): ManualCostLike {
  seq++
  return {
    id: `c${seq}`, period: null, currency: 'PLN', cost_category: 'ga', business_unit: 'shared',
    source: 'mt940', pnl_mode: 'auto', reference: `9000000${String(seq).padStart(4, '0')}`, notes: '', ...p,
  }
}
const salary = (date: string, amount: number, period: string | null = null) => cost({ date, amount, period, subcategory: 'salary_gross' })
const zus = (date: string, amount: number, period: string | null = null) => cost({ date, amount, period, subcategory: 'zus_employer' })
const pit4 = (date: string, amount: number, period: string | null = null) => cost({ date, amount, period, subcategory: 'salary_pit' })

/**
 * Firma z czterema miesiącami pensji (po 10 000 zł): czerwiec–sierpień wypłacane ostatniego dnia miesiąca,
 * wrzesień — 2 października. ZUS (4 000 zł) i PIT-4 (1 000 zł) zapłacone za czerwiec i lipiec,
 * przy czym ZUS za lipiec dopiero 20 października. Za sierpień i wrzesień przelewów jeszcze nie było.
 */
function baseCosts(): ManualCostLike[] {
  return [
    salary('2026-06-30', 10_000),
    salary('2026-07-31', 10_000),
    salary('2026-08-31', 10_000),
    salary('2026-10-02', 10_000),                 // pensja za wrzesień wypłacona 2. dnia października
    zus('2026-07-15', 4_000, '2026-06'),
    zus('2026-10-20', 4_000, '2026-07'),          // spóźniony ZUS — tytuł „DRA 01.07.2026"
    pit4('2026-07-20', 1_000, '2026-06'),
    pit4('2026-08-20', 1_000, '2026-07'),
  ]
}

const month = (costs: ManualCostLike[], m: string, opts: { bu?: string; estimate?: boolean; today?: string; matched?: Map<string, MatchedTxLite[]> } = {}): ManualMonth =>
  bookManualCosts(costs, opts.matched ?? NO_MATCHES, Number(m.slice(0, 4)), opts.today ?? TODAY, { bu: opts.bu, estimate: opts.estimate }).get(m)!

describe('koszty pracy w miesiącu, którego dotyczą', () => {
  test('spóźniony ZUS z okresem w tytule trafia do swojego miesiąca, nie do miesiąca przelewu', () => {
    const costs = baseCosts()
    const jul = month(costs, '2026-07'), oct = month(costs, '2026-10')
    assert.equal(jul.zus, 4_000)                  // zapłacony 20 października
    assert.equal(jul.zus_estimate, 0)             // miesiąc pokryty — bez szacunku
    assert.equal(jul.opex_ga, 15_000)             // pensja 10 000 + ZUS 4 000 + PIT-4 1 000
    assert.equal(oct.zus, 0)
    assert.equal(oct.opex_ga, 0)
  })

  test('pensja wypłacona 2. dnia miesiąca należy do miesiąca poprzedniego', () => {
    const costs = baseCosts()
    assert.equal(month(costs, '2026-09').salaries, 10_000)
    assert.equal(month(costs, '2026-10').salaries, 0)
    // pensja z okresem w tytule („WYNAGRODZENIE 9/2026") wypłacona 28 września — też wrzesień
    const withTitle = [...baseCosts().slice(0, 3), salary('2026-09-28', 10_000, '2026-09')]
    assert.equal(month(withTitle, '2026-09').salaries, 10_000)
  })

  test('PIT-4 bez okresu → miesiąc poprzedni; z okresem → okres z tytułu', () => {
    const costs = [...baseCosts(), pit4('2026-09-21', 1_000)]   // bez okresu, zapłacony we wrześniu → za sierpień
    assert.equal(month(costs, '2026-08').pit4, 1_000)
    assert.equal(month(costs, '2026-08').pit4_estimate, 0)
    assert.equal(month(costs, '2026-09').pit4, 0)
  })

  test('wpis ręczny / dokument: miesiąc wskazał użytkownik (period albo data) — bez heurystyk dat przelewów', () => {
    const costs = [
      cost({ date: '2026-08-10', amount: 9_000, subcategory: 'salary_gross', source: 'manual' }),                    // data 10. — zostaje w sierpniu
      cost({ date: '2026-08-31', amount: 3_500, subcategory: 'zus_employer', source: 'manual' }),                    // ZUS bez okresu — sierpień, nie lipiec
      cost({ date: '2026-08-12', amount: 800, subcategory: 'salary_pit', source: 'document' }),                      // PIT-4 z dokumentu — sierpień
      cost({ date: '2026-08-10', amount: 7_000, subcategory: 'salary_gross', source: 'manual', period: '2026-06' }), // okres wpisany ręcznie wygrywa
      cost({ date: '2026-08-10', amount: 5_000, subcategory: 'salary_gross', source: 'manual', period: '2026-12' }), // także daleko „do przodu"
    ]
    const o = { estimate: false }
    const aug = month(costs, '2026-08', o)
    assert.equal(aug.salaries, 9_000); assert.equal(aug.zus, 3_500); assert.equal(aug.pit4, 800)
    assert.equal(aug.opex_ga, 13_300)
    assert.equal(month(costs, '2026-07', o).opex_ga, 0)
    assert.equal(month(costs, '2026-06', o).salaries, 7_000)
    assert.equal(month(costs, '2026-12', o).salaries, 5_000)
    // wpis ręczny pokrywa swój miesiąc jak przelew: sierpień ma ZUS i PIT-4 → bez szacunku
    assert.equal(month(costs, '2026-08').payroll_estimate, 0)
    // ten sam koszt jako przelew z wyciągu (10. dnia, bez okresu w tytule) to pensja za lipiec
    assert.equal(month([salary('2026-08-10', 9_000)], '2026-07').salaries, 9_000)
    assert.equal(month([salary('2026-08-10', 9_000)], '2026-08').salaries, 0)
  })

  test('koszt grudnia zapłacony w styczniu trafia do poprzedniego roku', () => {
    const costs = [
      salary('2026-01-02', 8_000),                                                           // pensja za grudzień
      zus('2026-01-15', 3_000, '2025-12'),
      cost({ date: '2026-01-03', amount: 50, period: '2025-12', cost_category: 'financial', subcategory: 'bank_fee' }),
      cost({ date: '2026-03-20', amount: 900, period: '2025-12', cost_category: 'financial', subcategory: 'tax_income' }),
    ]
    const y2025 = bookManualCosts(costs, NO_MATCHES, 2025, TODAY)
    const y2026 = bookManualCosts(costs, NO_MATCHES, 2026, TODAY)
    const dec = y2025.get('2025-12')!
    assert.equal(dec.salaries, 8_000)
    assert.equal(dec.zus, 3_000)
    assert.equal(dec.opex_ga, 11_000)
    assert.equal(dec.financial_costs, 50)
    assert.equal(dec.cit, 900)
    for (const m of monthsOf(2026)) {
      const l = y2026.get(m)!
      assert.equal(l.opex_ga + l.financial_costs + l.cit, 0, m)
    }
  })

  test('koszt inny niż praca: period z tytułu wygrywa, bez periodu — miesiąc daty', () => {
    const costs = [
      cost({ date: '2026-09-05', amount: 120, cost_category: 'financial', subcategory: 'bank_fee' }),
      cost({ date: '2026-09-05', amount: 300, period: '2026-08', cost_category: 'ga', subcategory: 'software', pnl_mode: 'include' }),
      cost({ date: '2026-09-07', amount: 700, period: 'sierpień', cost_category: 'operations', subcategory: 'travel', pnl_mode: 'include' }),
    ]
    assert.equal(month(costs, '2026-09').financial_costs, 120)
    assert.equal(month(costs, '2026-08').opex_ga, 300)
    assert.equal(month(costs, '2026-09').opex_ga, 0)
    assert.equal(month(costs, '2026-09').opex_operations, 700)   // zły period → data
  })
})

describe('szacunek ZUS / PIT-4 za miesiące bez przelewu', () => {
  test('pojawia się dla miesiąca z pensjami, ale bez przelewu ZUS / PIT-4', () => {
    const costs = baseCosts()
    const aug = month(costs, '2026-08'), sep = month(costs, '2026-09')
    // wskaźniki z czerwca i lipca: ZUS 4 000 / 10 000, PIT-4 1 000 / 10 000
    assert.equal(aug.zus_estimate, 4_000); assert.equal(aug.pit4_estimate, 1_000)
    assert.equal(aug.zus, 0); assert.equal(aug.pit4, 0)
    assert.equal(aug.payroll_estimate, 5_000)
    assert.equal(aug.opex_ga, 15_000)             // 10 000 pensji + 5 000 szacunku — jak w miesiącach opłaconych
    assert.equal(sep.payroll_estimate, 5_000)
    assert.equal(month(costs, '2026-06').payroll_estimate, 0)
    assert.equal(month(costs, '2026-07').payroll_estimate, 0)
  })

  test('znika, gdy przelew się pojawi — zastępuje go rzeczywista kwota', () => {
    const before = month(baseCosts(), '2026-08')
    assert.equal(before.zus_estimate, 4_000)
    const costs = [...baseCosts(), zus('2026-11-10', 4_100, '2026-08')]
    const after = month(costs, '2026-08')
    assert.equal(after.zus, 4_100)
    assert.equal(after.zus_estimate, 0)
    assert.equal(after.pit4_estimate, 1_000)      // PIT-4 za sierpień nadal niezapłacony
    assert.equal(after.payroll_estimate, 1_000)
    assert.equal(after.opex_ga, 15_100)           // 10 000 + 4 100 + szacunek PIT-4 1 000
    assert.equal(month(costs, '2026-11').opex_ga, 0)   // przelew z listopada nie jest kosztem listopada
  })

  test('nie ma szacunku: bez pensji w miesiącu, za miesiące po „dziś", przy estimate=false i bez miesięcy odniesienia', () => {
    const costs = baseCosts()
    assert.equal(month(costs, '2026-10').payroll_estimate, 0)                       // październik bez pensji
    assert.equal(month(costs, '2026-09', { today: '2026-08' }).payroll_estimate, 0) // wrzesień jeszcze się nie zaczął
    assert.equal(month(costs, '2026-08', { estimate: false }).payroll_estimate, 0)
    assert.equal(month(costs, '2026-08', { estimate: false }).opex_ga, 10_000)
    // same pensje, żadnego przelewu do ZUS / US w historii → nie zgadujemy stawek
    const onlySalaries = [salary('2026-06-30', 10_000), salary('2026-07-31', 10_000)]
    assert.equal(month(onlySalaries, '2026-07').payroll_estimate, 0)
    assert.equal(month(onlySalaries, '2026-07').opex_ga, 10_000)
  })
})

describe('co nie jest kosztem albo liczyłoby się podwójnie', () => {
  test('przelew własny / rachunek VAT i VAT do urzędu nigdy nie wchodzą do RZiS', () => {
    const costs = [
      cost({ date: '2026-08-10', amount: 50_000, cost_category: 'financial', subcategory: 'internal_transfer', pnl_mode: 'exclude' }),
      cost({ date: '2026-08-11', amount: 4_000, cost_category: 'financial', subcategory: 'internal_transfer', pnl_mode: 'include' }),  // ktoś wymusił „licz zawsze"
      cost({ date: '2026-08-12', amount: 4_000, cost_category: 'ga', subcategory: 'internal_transfer', pnl_mode: 'auto', source: 'manual' }),
      cost({ date: '2026-08-25', amount: 39_800, period: '2026-07', cost_category: 'financial', subcategory: 'tax_vat' }),
      cost({ date: '2026-08-25', amount: 1_000, cost_category: 'financial', subcategory: 'tax_vat', pnl_mode: 'include' }),
    ]
    const alloc = allocateManualCosts(costs, NO_MATCHES, TODAY)
    assert.equal(alloc.booked.length, 0)
    assert.equal(alloc.skipped_ksef.length, 0)
    for (const m of ['2026-07', '2026-08']) {
      const l = month(costs, m)
      assert.deepEqual(Object.values(l).filter(v => v !== 0), [], m)
    }
  })

  test('nierozpoznany przelew i „inne podatki" (tryb auto) czekają na decyzję — nie są w RZiS', () => {
    const costs = [
      cost({ date: '2026-08-10', amount: 2_500, subcategory: 'other' }),
      cost({ date: '2026-08-10', amount: 600, cost_category: 'financial', subcategory: 'tax_other' }),
      cost({ date: '2026-08-10', amount: 9_000, subcategory: 'salary_gross', pnl_mode: 'exclude' }),
      cost({ date: '2026-08-10', amount: 1_000, subcategory: 'salary_gross', currency: 'EUR' }),     // waluta obca bez kursu
    ]
    assert.equal(allocateManualCosts(costs, NO_MATCHES, TODAY).booked.length, 0)
  })

  test('przelew przypisany w Płatnościach do faktury KSeF jest pomijany (także po imporcie wyciągu)', () => {
    const vendor = cost({ date: '2026-08-14', amount: 1_230, cost_category: 'ga', subcategory: 'software', pnl_mode: 'include', reference: '12345678901' })
    const other = cost({ date: '2026-08-14', amount: 1_230, cost_category: 'ga', subcategory: 'software', pnl_mode: 'include', reference: '12345678902' })
    const manualEntry = cost({ date: '2026-08-14', amount: 1_230, cost_category: 'ga', subcategory: 'software', source: 'manual', reference: '12345678901' })
    const matched = buildMatchedIndex([{ transaction_date: '2026-08-14', amount: -1_230, reference: '12345678901' }])

    assert.equal(isKsefInvoicePayment(vendor, matched), true)
    assert.equal(isKsefInvoicePayment(other, matched), false)        // ta sama kwota i dzień, ale inny przelew
    assert.equal(isKsefInvoicePayment(manualEntry, matched), false)  // wpis ręczny — reguła dotyczy tylko wyciągu
    assert.equal(isKsefInvoicePayment(vendor, NO_MATCHES), false)

    const alloc = allocateManualCosts([vendor, other, manualEntry], matched, TODAY)
    assert.deepEqual(alloc.skipped_ksef.map(c => c.id), [vendor.id])
    assert.deepEqual(alloc.booked.map(b => b.cost.id), [other.id, manualEntry.id])
    assert.equal(month([vendor, other, manualEntry], '2026-08', { matched }).opex_ga, 2_460)
    // przed przypisaniem faktury ten sam przelew był w RZiS
    assert.equal(month([vendor, other, manualEntry], '2026-08').opex_ga, 3_690)
  })

  test('faktura KSeF: pensja / ZUS dopasowane do faktury też wypadają i nie budują szacunku', () => {
    const costs = baseCosts()
    const julyZus = costs.find(c => c.subcategory === 'zus_employer' && c.period === '2026-07')!
    const matched = buildMatchedIndex([{ transaction_date: julyZus.date, amount: -julyZus.amount, reference: julyZus.reference ?? null }])
    const jul = month(costs, '2026-07', { matched })
    assert.equal(jul.zus, 0)
    assert.equal(jul.zus_estimate, 4_000)         // lipiec przestał być „pokryty" → szacunek ze wskaźnika czerwca
  })

  test('koszt przeliczony z waluty obcej porównujemy po kwocie oryginalnej z notatki kursowej', () => {
    const fx = cost({
      date: '2026-08-14', amount: 4_301.2, cost_category: 'cogs', subcategory: 'hardware_eu', pnl_mode: 'include', reference: '',
      notes: formatFxNote(1_000, 'EUR', 4.3012, '2026-08-13'),
    })
    const matched = buildMatchedIndex([{ transaction_date: '2026-08-14', amount: -1_000, reference: null }])
    assert.equal(isKsefInvoicePayment(fx, matched), true)
    assert.equal(isKsefInvoicePayment({ ...fx, notes: '' }, matched), false)
    assert.equal(month([fx], '2026-08', { matched }).cogs_purchases, 0)
    assert.equal(month([fx], '2026-08').cogs_purchases, 4_301.2)
  })
})

describe('spójność payroll / payroll_estimate z opex_ga', () => {
  test('payroll = pensje + PIT-4 + ZUS + szacunek; jest częścią opex_ga i nie powiększa opex drugi raz', () => {
    const costs = [
      ...baseCosts(),
      cost({ date: '2026-08-10', amount: 2_000, subcategory: 'rent', source: 'manual' }),            // G&A spoza kosztów pracy
      cost({ date: '2026-08-03', amount: 35.5, cost_category: 'financial', subcategory: 'bank_fee' }),
      cost({ date: '2026-08-20', amount: 499.99, cost_category: 'ga', subcategory: 'software', pnl_mode: 'include' }),
    ]
    const year = bookManualCosts(costs, NO_MATCHES, 2026, TODAY)
    for (const m of monthsOf(2026)) {
      const l = year.get(m)!
      assert.equal(l.payroll_estimate, Math.round((l.zus_estimate + l.pit4_estimate) * 100) / 100, m)
      assert.equal(l.payroll, Math.round((l.salaries + l.pit4 + l.zus + l.payroll_estimate) * 100) / 100, m)
      assert.ok(l.payroll_estimate <= l.payroll && l.payroll <= l.opex_ga, m)
    }
    const aug = year.get('2026-08')!
    assert.equal(aug.payroll, 15_000)
    assert.equal(aug.opex_ga, 17_499.99)          // 15 000 kosztów pracy + czynsz 2 000 + oprogramowanie 499,99
    assert.equal(aug.financial_costs, 35.5)

    // tak, jak silnik dodaje to do linii RZiS miesiąca
    const L = EMPTY_LINES()
    L.revenue = 100_000
    L.opex_ga += aug.opex_ga; L.financial_costs += aug.financial_costs
    L.payroll += aug.payroll; L.payroll_estimate += aug.payroll_estimate
    finalizeLines(L)
    assert.equal(L.opex, 17_499.99)
    assert.equal(L.ebitda, 82_500.01)             // przychód − opex; payroll nie jest odejmowany drugi raz
    assert.equal(L.payroll, 15_000); assert.equal(L.payroll_estimate, 5_000)
  })

  test('payrollSummary: suma okresu, miesiące z szacunkiem, total = suma payroll miesięcy', () => {
    const year = bookManualCosts(baseCosts(), NO_MATCHES, 2026, TODAY)
    const q3 = payrollSummary(year, ['2026-07', '2026-08', '2026-09'])
    assert.deepEqual(q3, {
      salaries: 30_000, pit4: 1_000, zus: 4_000, zus_estimate: 8_000, pit4_estimate: 2_000,
      total: 45_000, estimated_months: ['2026-08', '2026-09'],
    })
    assert.equal(q3.total, ['2026-07', '2026-08', '2026-09'].reduce((s, m) => s + year.get(m)!.payroll, 0))
    assert.deepEqual(payrollSummary(year, ['2026-10']), { salaries: 0, pit4: 0, zus: 0, zus_estimate: 0, pit4_estimate: 0, total: 0, estimated_months: [] })
    assert.deepEqual(payrollSummary(year, ['2030-01']).total, 0)   // miesiąc spoza mapy
  })

  test('koszt pracy zaksięgowany poza G&A zostaje w swojej linii i nie wchodzi do payroll', () => {
    const costs = [salary('2026-06-30', 10_000), cost({ date: '2026-06-30', amount: 3_000, cost_category: 'cogs', subcategory: 'salary_civil', source: 'manual' })]
    const jun = month(costs, '2026-06')
    assert.equal(jun.cogs_purchases, 3_000)
    assert.equal(jun.opex_ga, 10_000)
    assert.equal(jun.payroll, 10_000)
    assert.equal(jun.salaries, 10_000)
  })
})

describe('jednostki biznesowe', () => {
  // czerwiec opłacony, lipiec bez ZUS → szacunek 4 000 zł; do tego czynsz jednostki SHC
  const costs = [
    salary('2026-06-30', 10_000),
    zus('2026-07-15', 4_000, '2026-06'),
    salary('2026-07-31', 10_000),
    cost({ date: '2026-07-10', amount: 2_000, subcategory: 'rent', source: 'manual', business_unit: 'shc' }),
  ]
  test('szacunek jest w widoku całej spółki i jednostki „shared" (tam trafiają przelewy z wyciągu), nie w shc / gatelynk', () => {
    const all = month(costs, '2026-07'), shared = month(costs, '2026-07', { bu: 'shared' })
    const shc = month(costs, '2026-07', { bu: 'shc' }), gl = month(costs, '2026-07', { bu: 'gatelynk' })
    assert.equal(all.opex_ga, 16_000)             // pensja 10 000 + szacunek ZUS 4 000 + czynsz 2 000
    assert.equal(shared.opex_ga, 14_000); assert.equal(shared.payroll_estimate, 4_000)
    assert.equal(shc.opex_ga, 2_000); assert.equal(shc.payroll_estimate, 0); assert.equal(shc.payroll, 0)
    assert.equal(gl.opex_ga, 0)
    assert.equal(all.opex_ga, shared.opex_ga + shc.opex_ga + gl.opex_ga)
    assert.equal(all.payroll, shared.payroll + shc.payroll + gl.payroll)
  })
  test('manualLinesByMonth: miesiące spoza listy są pomijane, a alokacja jest wspólna dla wszystkich widoków', () => {
    const alloc = allocateManualCosts(costs, NO_MATCHES, TODAY)
    assert.deepEqual([...manualLinesByMonth(alloc, ['2026-06']).keys()], ['2026-06'])
    assert.equal(manualLinesByMonth(alloc, ['2026-06']).get('2026-06')!.opex_ga, 14_000)
    assert.equal(alloc.booked.find(b => b.cost.subcategory === 'zus_employer')!.month, '2026-06')
    assert.equal(alloc.booked.find(b => b.cost.subcategory === 'rent')!.payroll, null)
    assert.equal(alloc.payroll_months.get('2026-07')!.zus_estimate, 4_000)
  })
})

describe('podział kosztów (cost-details) = ta sama alokacja co silnik RZiS', () => {
  const row = (c: ManualCostLike, description = `opis ${c.id}`): ManualCostRow => ({ ...c, description, document_id: null, op_code: null })
  /** Dane jak z loadManualCosts: wiersze + jedna alokacja. */
  const load = (costs: ManualCostLike[], matched = NO_MATCHES, today = TODAY) => {
    const rows = costs.map(c => row(c))
    return { costs: rows, ...allocateManualCosts(rows, matched, today) }
  }
  const engineTotal = (l: ManualMonth) => l.cogs_purchases + l.opex_sales + l.opex_ga + l.opex_operations + l.opex_leasing + l.financial_costs + l.cit
  const r2 = (x: number) => Math.round(x * 100) / 100
  const sumGroups = (d: ReturnType<typeof manualCostDetails>) => r2(Object.values(d.groups).reduce((s, g) => s + g.total, 0))

  const ksefPaid = cost({ date: '2026-08-14', amount: 1_230, subcategory: 'software', pnl_mode: 'include', reference: '55500000001' })
  const mixed = (): ManualCostLike[] => [
    ...baseCosts(),
    salary('2026-01-02', 8_000),                                                                                   // pensja za grudzień 2025
    zus('2026-01-15', 3_000, '2025-12'),
    cost({ date: '2026-08-03', amount: 35.5, cost_category: 'financial', subcategory: 'bank_fee' }),
    cost({ date: '2026-09-20', amount: 900, period: '2026-08', cost_category: 'financial', subcategory: 'tax_income' }),
    cost({ date: '2026-08-20', amount: 499.99, subcategory: 'software', pnl_mode: 'include' }),                    // dostawca zagraniczny
    cost({ date: '2026-08-21', amount: 4_301.2, cost_category: 'cogs', subcategory: 'hardware_eu', pnl_mode: 'include' }),
    cost({ date: '2026-08-10', amount: 2_000, subcategory: 'rent', source: 'manual', business_unit: 'shc' }),
    cost({ date: '2026-08-11', amount: 615, cost_category: 'operations', subcategory: 'travel', source: 'document' }),
    cost({ date: '2026-08-12', amount: 3_000, cost_category: 'cogs', subcategory: 'salary_civil', source: 'manual' }),  // koszt pracy poza G&A
    cost({ date: '2026-08-13', amount: 777, cost_category: 'financial', subcategory: 'leasing', source: 'manual' }),
    cost({ date: '2026-08-14', amount: 150, cost_category: 'sales', subcategory: 'marketing', source: 'manual' }),
    ksefPaid,                                                                                                      // płatność za fakturę KSeF
    cost({ date: '2026-08-15', amount: 2_500, subcategory: 'other' }),                                             // nierozpoznany — czeka na decyzję
    cost({ date: '2026-08-16', amount: 9_999, subcategory: 'rent', pnl_mode: 'exclude' }),
    cost({ date: '2026-08-17', amount: 50_000, cost_category: 'financial', subcategory: 'internal_transfer', pnl_mode: 'exclude' }),
    cost({ date: '2026-08-25', amount: 39_800, cost_category: 'financial', subcategory: 'tax_vat' }),
    cost({ date: '2026-08-18', amount: 1_000, cost_category: 'cogs', subcategory: 'hardware_eu', currency: 'EUR', pnl_mode: 'exclude' }),
  ]
  const matched = buildMatchedIndex([{ transaction_date: ksefPaid.date, amount: -ksefPaid.amount, reference: ksefPaid.reference ?? null }])

  test('suma grup = suma linii RZiS z kosztów spoza KSeF — dla miesiąca, kwartału, roku i przełomu lat', () => {
    const manual = load(mixed(), matched)
    const ranges: Array<[string, string]> = [
      ['2026-08', '2026-08'], ['2026-09', '2026-09'], ['2026-10', '2026-10'], ['2026-07', '2026-09'],
      ['2026-01', '2026-12'], ['2025-12', '2025-12'], ['2025-01', '2026-12'],
    ]
    for (const [from, to] of ranges) {
      const months = [...monthsOf(2025), ...monthsOf(2026)].filter(m => m >= from && m <= to)
      const lines = manualLinesByMonth(manual, months)
      const engine = r2(months.reduce((s, m) => s + engineTotal(lines.get(m)!), 0))
      const d = manualCostDetails(manual, from, to)
      assert.equal(sumGroups(d), engine, `${from}..${to}`)
      // koszty pracy: grupy „Pensje" + „ZUS" = payroll z RZiS (pensje + PIT-4 + ZUS + szacunek)
      const payroll = payrollSummary(lines, months)
      assert.equal(r2(d.groups.salaries.total), r2(payroll.salaries + payroll.pit4 + payroll.pit4_estimate), `${from}..${to} salaries`)
      assert.equal(r2(d.groups.zus.total), r2(payroll.zus + payroll.zus_estimate), `${from}..${to} zus`)
      assert.equal(r2(d.groups.salaries.total + d.groups.zus.total), payroll.total, `${from}..${to} payroll`)
      assert.equal(r2(d.groups.taxes.total), r2(months.reduce((s, m) => s + lines.get(m)!.cit, 0)), `${from}..${to} cit`)
    }
  })

  test('sierpień: PIT-4 i jego szacunek w grupie „salaries", szacunek ZUS w „zus" — jako osobne, nazwane pozycje', () => {
    const d = manualCostDetails(load(mixed(), matched), '2026-08', '2026-08')
    // Szacunek liczy się od WSZYSTKICH wynagrodzeń miesiąca (13 000 = pensja 10 000 + umowa o dzieło 3 000 zaksięgowana
    // w kosztach sprzedanych): PIT-4 10 % (czerwiec, lipiec) → 1 300; ZUS ze wskaźnika trzech opłaconych miesięcy
    // (lipiec, czerwiec, grudzień: 11 000 / 28 000) → 5 107,14. Grupa „salaries": pensja 10 000 + szacunek PIT-4 1 300.
    assert.equal(d.groups.salaries.total, 11_300)
    const pitEst = d.groups.salaries.items.filter(i => i.source === ESTIMATE_SOURCE)
    assert.deepEqual(pitEst.map(i => [i.description, i.amount, i.category, i.period, i.date]),
      [['PIT-4 — szacunek za Sierpień 2026 (przelewu jeszcze nie było)', 1_300, 'ga/salary_pit', '2026-08', '2026-08-31']])
    assert.deepEqual(d.groups.zus.items.map(i => [i.description, i.amount, i.source]),
      [['ZUS — szacunek za Sierpień 2026 (przelewu jeszcze nie było)', 5_107.14, ESTIMATE_SOURCE]])
    assert.equal(d.groups.zus.total, 5_107.14)
    // CIT zapłacony we wrześniu z okresem sierpnia → podatki sierpnia, z dopiskiem o miesiącu
    assert.equal(d.groups.taxes.total, 900)
    assert.match(d.groups.taxes.items[0].description, /\(koszt za Sierpień 2026\)$/)
    assert.equal(d.groups.taxes.items[0].date, '2026-09-20')
    assert.equal(d.groups.import.total, 4_301.2)
    // dokument + przelew „licz zawsze" → spoza KSeF; wpisy ręczne (czynsz, leasing, marketing, UoD w COGS) i opłata bankowa → inne
    assert.equal(d.groups.non_ksef.total, 615 + 499.99)
    assert.equal(d.groups.other_manual.total, r2(2_000 + 3_000 + 777 + 150 + 35.5))
    // poza RZiS, zdecydowane: płatność za fakturę KSeF i pnl_mode=exclude; VAT i przelew własny nie są duplikatami
    assert.deepEqual(d.skipped_duplicates, { count: 2, total: 1_230 + 9_999 })
    // poza RZiS, BEZ decyzji: nierozpoznany przelew z wyciągu — to nie duplikat, tylko koszt, którego może brakować
    assert.deepEqual(d.awaiting_decision, { count: 1, total: 2_500 })
    assert.equal(d.foreign_currency.count, 1)
    assert.equal(d.foreign_currency.items[0].currency, 'EUR')
    const everything = Object.values(d.groups).flatMap(g => g.items)
    assert.ok(!everything.some(i => /internal_transfer|tax_vat/.test(String(i.category))))
  })

  test('PIT-4 zapłacony (salary_pit) trafia do grupy „salaries"; spóźniony ZUS — do miesiąca, którego dotyczy', () => {
    const manual = load(baseCosts())
    const jul = manualCostDetails(manual, '2026-07', '2026-07')
    assert.deepEqual(jul.groups.salaries.items.map(i => i.category).sort(), ['ga/salary_gross', 'ga/salary_pit'])
    assert.equal(jul.groups.salaries.total, 11_000)
    assert.equal(jul.groups.zus.total, 4_000)
    assert.match(jul.groups.zus.items[0].description, /\(koszt za Lipiec 2026\)$/)   // przelew z 20 października
    assert.equal(jul.groups.zus.items[0].date, '2026-10-20')
    // październik (miesiąc przelewu) nie ma tego ZUS-u ani pensji wypłaconej 2 października
    const oct = manualCostDetails(manual, '2026-10', '2026-10')
    assert.equal(sumGroups(oct), 0)
    assert.equal(oct.skipped_duplicates.count, 0)
  })

  test('koszt grudnia zapłacony w styczniu jest w podziale kosztów grudnia, nie stycznia', () => {
    const manual = load([salary('2026-01-02', 8_000), zus('2026-01-15', 3_000, '2025-12')])
    assert.equal(sumGroups(manualCostDetails(manual, '2025-12', '2025-12')), 11_000)
    assert.equal(sumGroups(manualCostDetails(manual, '2026-01', '2026-12')), 0)
  })
})

describe('prognoza gotówki zostaje KASOWA (routes/cashflow) — po dacie przelewu, nie po miesiącu kosztu', () => {
  test('PIT-4 i spóźniony ZUS liczą się w miesiącu, w którym wyszły z konta', () => {
    const months = ['2026-08', '2026-09', '2026-10']
    const rec = computeRecurring([
      { date: '2026-10-20', amount: 4_000, subcategory: 'zus_employer' },   // ZUS za lipiec zapłacony w październiku
      { date: '2026-10-20', amount: 1_000, subcategory: 'salary_pit' },     // PIT-4 za wrzesień
      { date: '2026-09-20', amount: 1_100, subcategory: 'salary_pit' },
      { date: '2026-07-20', amount: 9_999, subcategory: 'salary_pit' },     // przelew z lipca — poza trzema miesiącami
      { date: '2026-10-02', amount: 50_000, subcategory: 'internal_transfer' },
    ], months)
    assert.deepEqual(rec.map(r => r.subcategory), ['salary_pit', 'zus_employer'])
    const pit = rec.find(r => r.subcategory === 'salary_pit')!
    assert.equal(pit.amount, 700)                // (1 000 + 1 100) / 3 miesiące
    assert.equal(pit.day_of_month, 20)
    assert.match(pit.label, /PIT-4/)
    assert.equal(rec.find(r => r.subcategory === 'zus_employer')!.amount, Math.round(4_000 / 3 * 100) / 100)
  })
})

// ── Podział kosztów: „czeka na decyzję" a przelew dopasowany do faktury KSeF ───

test('nierozpoznany przelew dopasowany w Płatnościach do faktury KSeF NIE czeka na decyzję (to opłacona faktura)', () => {
  const row = (id: string, amount: number, reference: string) => ({
    id, date: '2026-08-14', period: null, amount, currency: 'PLN', cost_category: 'ga', subcategory: 'other',
    business_unit: 'shared', source: 'mt940', pnl_mode: 'auto', reference, notes: '',
    description: 'DOSTAWCA TESTOWY · FAKTURA', document_id: null, op_code: '152',
  })
  const costs = [row('a', 12_300, '11100000001'), row('b', 49_200, '11100000002'), row('c', 800, '11100000003')]
  const matched = buildMatchedIndex([
    { transaction_date: '2026-08-14', amount: -12_300, reference: '11100000001' },
    { transaction_date: '2026-08-14', amount: -49_200, reference: '11100000002' },
  ])
  const alloc = allocateManualCosts(costs, matched, '2026-11')
  assert.deepEqual([...alloc.ksef_payment_ids].sort(), ['a', 'b'])
  const d = manualCostDetails({ costs, ...alloc }, '2026-08', '2026-08')
  assert.deepEqual(d.awaiting_decision, { count: 1, total: 800 })            // tylko przelew bez faktury
  assert.deepEqual(d.skipped_duplicates, { count: 2, total: 12_300 + 49_200 }) // opłacone faktury — koszt policzony z faktury
})
