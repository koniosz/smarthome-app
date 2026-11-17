/**
 * Reguły silnika RZiS (routes/finance.ts) — czyste funkcje, bez bazy.
 * includeManualCostInPnl: lista bezpieczna MT940, pnl_mode, waluta obca.
 * costLine: linie RZiS (VAT i przelewy własne poza RZiS). effectiveCostMonth: miesiąc memoriałowy kosztu.
 * payroll / payroll_estimate: część opex_ga — zaokrąglane i sumowane, ale nie liczone do opex drugi raz.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  includeManualCostInPnl, isForeignCurrencyCost, EMPTY_LINES, finalizeLines, sumLines,
  MT940_SAFE_SUBCATEGORIES, costLine, effectiveCostMonth, monthLabel, lastDayOf, warsawToday,
} from '../routes/finance'

describe('isForeignCurrencyCost', () => {
  test('PLN / brak waluty → nie jest walutą obcą', () => {
    assert.equal(isForeignCurrencyCost({ currency: 'PLN' }), false)
    assert.equal(isForeignCurrencyCost({ currency: 'pln' }), false)
    assert.equal(isForeignCurrencyCost({ currency: ' PLN ' }), false)
    assert.equal(isForeignCurrencyCost({ currency: '' }), false)
    assert.equal(isForeignCurrencyCost({ currency: null }), false)
    assert.equal(isForeignCurrencyCost({}), false)
  })
  test('EUR/USD → waluta obca', () => {
    assert.equal(isForeignCurrencyCost({ currency: 'EUR' }), true)
    assert.equal(isForeignCurrencyCost({ currency: 'usd' }), true)
  })
})

describe('includeManualCostInPnl', () => {
  test('MT940: tylko lista bezpieczna w trybie auto', () => {
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'salary_gross', pnl_mode: 'auto', currency: 'PLN' }), true)
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'bank_fee', pnl_mode: 'auto', currency: 'PLN' }), true)
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'rent', pnl_mode: 'auto', currency: 'PLN' }), false)
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'other', pnl_mode: 'auto', currency: 'PLN' }), false)
  })
  test('pnl_mode nadpisuje listę bezpieczną', () => {
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'rent', pnl_mode: 'include', currency: 'PLN' }), true)
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'salary_gross', pnl_mode: 'exclude', currency: 'PLN' }), false)
  })
  test('ręczne i z dokumentów → zawsze (PLN)', () => {
    assert.equal(includeManualCostInPnl({ source: 'manual', subcategory: 'hardware_noneu', pnl_mode: 'auto', currency: 'PLN' }), true)
    assert.equal(includeManualCostInPnl({ source: 'document', subcategory: 'software', pnl_mode: 'include', currency: 'PLN' }), true)
    // brak pola currency (stare wywołania) → jak PLN
    assert.equal(includeManualCostInPnl({ source: 'manual', subcategory: 'hardware_noneu', pnl_mode: 'auto' }), true)
  })
  test('waluta obca → NIGDY do RZiS, niezależnie od pnl_mode/źródła/listy bezpiecznej', () => {
    // przelew 2 000 EUR z reguły bankowej include — bez przeliczenia NBP nie może wejść jako 2 000 zł
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'hardware_eu', pnl_mode: 'include', currency: 'EUR' }), false)
    // prowizja z rachunku EUR (bank_fee jest na liście bezpiecznej) — też nie
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'bank_fee', pnl_mode: 'auto', currency: 'EUR' }), false)
    // ręczny koszt w USD
    assert.equal(includeManualCostInPnl({ source: 'manual', subcategory: 'hardware_noneu', pnl_mode: 'auto', currency: 'USD' }), false)
    assert.equal(includeManualCostInPnl({ source: 'document', subcategory: 'software', pnl_mode: 'include', currency: 'eur' }), false)
  })
})

describe('lista bezpieczna MT940 i linie RZiS', () => {
  test('PIT-4 (salary_pit) jest na liście bezpiecznej — przelew z wyciągu wchodzi do RZiS w trybie auto', () => {
    assert.ok(MT940_SAFE_SUBCATEGORIES.has('salary_pit'))
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'salary_pit', pnl_mode: 'auto', currency: 'PLN' }), true)
    assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'zus_employer', pnl_mode: 'auto', currency: 'PLN' }), true)
    // nierozpoznane i „inne podatki" zostają na liście do decyzji
    for (const sub of ['other', 'tax_other', 'internal_transfer', 'software', 'hardware_eu']) {
      assert.equal(MT940_SAFE_SUBCATEGORIES.has(sub), false, sub)
      assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: sub, pnl_mode: 'auto', currency: 'PLN' }), false, sub)
    }
  })
  test('costLine: koszty pracy w G&A; VAT i przelew własny poza RZiS — także gdy ktoś ustawi „licz zawsze"', () => {
    assert.equal(costLine('ga', 'salary_gross'), 'opex_ga')
    assert.equal(costLine('ga', 'salary_pit'), 'opex_ga')
    assert.equal(costLine('ga', 'zus_employer'), 'opex_ga')
    assert.equal(costLine('financial', 'internal_transfer'), 'excluded')
    assert.equal(costLine('ga', 'internal_transfer'), 'excluded')
    assert.equal(costLine('financial', 'tax_vat'), 'excluded')
    assert.equal(costLine('financial', 'tax_income'), 'cit')
    assert.equal(costLine('financial', 'tax_other'), 'financial')
    assert.equal(costLine('financial', 'bank_fee'), 'financial')
    assert.equal(costLine('financial', 'leasing'), 'opex_leasing')
    assert.equal(costLine('cogs', 'hardware_eu'), 'cogs')
    assert.equal(costLine('operations', 'travel'), 'opex_operations')
    assert.equal(costLine('sales', 'marketing'), 'opex_sales')
    assert.equal(costLine('cos-nowego', 'x'), 'opex_ga')
  })
})

describe('effectiveCostMonth', () => {
  test('poprawny period (YYYY-MM) wygrywa z datą', () => {
    assert.equal(effectiveCostMonth({ date: '2026-10-12', period: '2026-07' }), '2026-07')
    assert.equal(effectiveCostMonth({ date: '2026-01-15', period: '2025-12' }), '2025-12')
    assert.equal(effectiveCostMonth({ date: '2026-08-31', period: ' 2026-08 ' }), '2026-08')
  })
  test('brak albo zły period → miesiąc daty', () => {
    assert.equal(effectiveCostMonth({ date: '2026-10-12' }), '2026-10')
    assert.equal(effectiveCostMonth({ date: '2026-10-12', period: null }), '2026-10')
    assert.equal(effectiveCostMonth({ date: '2026-10-12', period: '' }), '2026-10')
    for (const bad of ['2026-13', '2026-00', '2026-7', '07/2026', '2026-07-01', 'lipiec', '26M07']) {
      assert.equal(effectiveCostMonth({ date: '2026-10-12', period: bad }), '2026-10', bad)
    }
  })
  test('stare wiersze (period = miesiąc daty) — bez zmiany', () => {
    assert.equal(effectiveCostMonth({ date: '2026-03-31', period: '2026-03' }), '2026-03')
  })
})

describe('helpery dat w routes/finance', () => {
  test('monthLabel / lastDayOf / warsawToday', () => {
    assert.equal(monthLabel('2026-10'), 'Październik 2026')
    assert.equal(lastDayOf('2026-02'), '2026-02-28')
    assert.equal(lastDayOf('2028-02'), '2028-02-29')
    // 31 grudnia 23:30 UTC = 1 stycznia 00:30 w Warszawie
    assert.equal(warsawToday(new Date('2025-12-31T23:30:00Z')).period, '2026-01')
  })
})

describe('payroll / payroll_estimate w liniach RZiS', () => {
  test('to część opex_ga: zaokrąglane, ale NIE dodawane do opex drugi raz', () => {
    const L = EMPTY_LINES()
    assert.equal(L.payroll, 0); assert.equal(L.payroll_estimate, 0)
    L.revenue = 100_000; L.opex_ga = 20_000.004; L.opex_sales = 1_000
    L.payroll = 15_000.004; L.payroll_estimate = 5_000.006
    finalizeLines(L)
    assert.equal(L.payroll, 15_000); assert.equal(L.payroll_estimate, 5_000.01)
    assert.equal(L.opex, 21_000)             // opex_sales + opex_ga — bez payroll
    assert.equal(L.ebitda, 79_000)
    assert.equal(L.net_result, 79_000)
  })
  test('sumLines sumuje payroll i payroll_estimate miesięcy', () => {
    const a = EMPTY_LINES(); a.opex_ga = 15_000; a.payroll = 15_000; a.payroll_estimate = 0
    const b = EMPTY_LINES(); b.opex_ga = 17_000; b.payroll = 15_000; b.payroll_estimate = 5_000
    const q = sumLines([finalizeLines(a), finalizeLines(b)])
    assert.equal(q.payroll, 30_000); assert.equal(q.payroll_estimate, 5_000)
    assert.equal(q.opex_ga, 32_000); assert.equal(q.opex, 32_000)
    assert.ok(q.payroll_estimate <= q.payroll && q.payroll <= q.opex_ga)
  })
})

describe('finalizeLines: zmiana stanu magazynu', () => {
  test('cogs = zakupy − zmiana stanu; bez zmiany stanu cogs = zakupy', () => {
    const a = EMPTY_LINES(); a.revenue = 100_000; a.cogs_purchases = 5_000; a.inventory_change = 40_000
    finalizeLines(a)
    assert.equal(a.cogs, -35_000) // widok całej spółki: magazyn urósł o 40k → koszt sprzedanych towarów ujemny w miesiącu dostawy
    // widok jednostki: inventory_change = 0 → cogs = zakupy jednostki (bez zapasów całej firmy)
    const b = EMPTY_LINES(); b.revenue = 100_000; b.cogs_purchases = 5_000; b.inventory_change = 0
    finalizeLines(b)
    assert.equal(b.cogs, 5_000)
    assert.equal(b.gross_margin, 95_000)
    assert.equal(b.gross_margin_pct, 95)
  })
})
