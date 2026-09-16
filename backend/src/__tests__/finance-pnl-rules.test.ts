/**
 * Reguły silnika RZiS (routes/finance.ts) — czyste funkcje, bez bazy.
 * includeManualCostInPnl: lista bezpieczna MT940, pnl_mode, waluta obca.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { includeManualCostInPnl, isForeignCurrencyCost, EMPTY_LINES, finalizeLines } from '../routes/finance'

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
