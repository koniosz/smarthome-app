/**
 * Auto-klasyfikacja przelewów z MT940 (autoClassifyManual): podatki do US.
 * Opis kosztu z wyciągu to `kontrahent · tytuł` (composeDescription), więc KAŻDY przelew do Urzędu
 * Skarbowego / na mikrorachunek ma „urząd skarbowy” w tekście — rodzaj podatku (CIT/PIT vs VAT)
 * musi być rozpoznany PRZED ogólną regułą „przelew do US”. tax_vat jest wykluczone z RZiS,
 * tax_income wchodzi jako CIT i do cit_paid_ytd — pomyłka = zawyżony zysk i „CIT zapłacony 0 zł”.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/manual-costs-classify.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoClassifyManual } from '../routes/manual-costs'
import { composeDescription } from '../services/mt940-costs'
import { includeManualCostInPnl, costLine } from '../routes/finance'

const sub = (description: string, reference = '') => {
  const a = autoClassifyManual(description, reference)
  return `${a.cost_category}/${a.subcategory}`
}
const mt940 = (counterparty: string, title: string, reference = '') =>
  sub(composeDescription(counterparty, title), reference)

test('CIT / PIT do US → financial/tax_income (nie tax_vat), także z kontrahentem „Urząd Skarbowy”', () => {
  assert.equal(mt940('URZĄD SKARBOWY WARSZAWA-MOKOTÓW', 'CIT-8 zaliczka 08/2026'), 'financial/tax_income')
  assert.equal(mt940('Urząd Skarbowy', 'zaliczka na podatek dochodowy CIT'), 'financial/tax_income')
  assert.equal(mt940('MIKRORACHUNEK PODATKOWY', '/SFP/CIT/2026'), 'financial/tax_income')
  assert.equal(mt940('MIKRORACHUNEK PODATKOWY', '/TXT/CIT8 08/2026'), 'financial/tax_income')
  // PIT-4 / PIT-8A = zaliczki od wynagrodzeń → koszt pensji (ga/salary_gross), nie CIT
  assert.equal(mt940('US Warszawa', 'PIT-4 za 08/2026'), 'ga/salary_gross')
  assert.equal(mt940('URZĄD SKARBOWY', 'PIT-8A 08/2026'), 'ga/salary_gross')
  assert.equal(mt940('MIKRORACHUNEK PODATKOWY', '/TXT/PIT4R 2026'), 'ga/salary_gross')
  assert.equal(mt940('URZĄD SKARBOWY', 'zaliczka na podatek 08/2026'), 'financial/tax_income')
  // bez kontrahenta US (wpis ręczny / krótki tytuł)
  assert.equal(sub('CIT-8 zaliczka 08/2026'), 'financial/tax_income')
  assert.equal(sub('Zaliczka CIT 08/2026'), 'financial/tax_income')
  assert.equal(sub('Zaliczka na podatek dochodowy CIT'), 'financial/tax_income')
  assert.equal(sub('PIT-4 za 08/2026'), 'ga/salary_gross')
})

test('VAT / JPK do US → financial/tax_vat', () => {
  assert.equal(mt940('URZĄD SKARBOWY', 'VAT-7 08/2026'), 'financial/tax_vat')
  assert.equal(mt940('URZĄD SKARBOWY', 'VAT 08/2026'), 'financial/tax_vat')
  assert.equal(mt940('URZĄD SKARBOWY', 'JPK_V7M 08/2026'), 'financial/tax_vat')
  assert.equal(mt940('MIKRORACHUNEK PODATKOWY', '/SFP/VAT-7/2026'), 'financial/tax_vat')
  assert.equal(sub('Deklaracja VAT-7 08/2026'), 'financial/tax_vat')
  assert.equal(sub('Podatek VAT 08/2026'), 'financial/tax_vat')
})

test('inny przelew do US (PCC, odsetki) → financial/tax_other — poza safe listą, więc do decyzji', () => {
  assert.equal(mt940('URZĄD SKARBOWY', 'PCC-3'), 'financial/tax_other')
  assert.equal(mt940('URZĄD SKARBOWY', 'odsetki za zwłokę'), 'financial/tax_other')
  assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'tax_other', pnl_mode: 'auto' }), false)
})

test('„…us” wewnątrz słowa (GLOBUS, PLUS, BONUS, ASUS, CAMPUS, STATUS) NIE jest podatkiem', () => {
  assert.equal(mt940('GLOBUS SP. Z O.O.', 'Materiały montażowe FV 12/2026'), 'ga/other')
  assert.equal(mt940('POLKOMTEL SP. Z O.O.', 'PLUS abonament 09/2026'), 'ga/other')
  assert.equal(mt940('ASUS POLSKA', 'monitor'), 'ga/other')
  assert.equal(mt940('STATUS SP. Z O.O.', 'FV 3/2026'), 'ga/other')
  assert.equal(mt940('FLIXBUS', 'bilet'), 'ga/other')
  assert.equal(sub('Google Workspace Business Plus'), 'ga/other')
  assert.equal(mt940('CAMPUS SP Z OO', 'czynsz 09/2026'), 'ga/rent')
  assert.equal(mt940('JAN KOWALSKI', 'Wynagrodzenie 08/2026 premia bonus'), 'ga/salary_gross')
  // referencja z „US” jako prefiksem ciągu też nie jest urzędem
  assert.equal(mt940('ORANGE POLSKA', 'faktura', 'US20260801'), 'ga/other')
})

test('fragmenty „cit”/„vat” poza kontekstem podatkowym nie klasyfikują jako podatek', () => {
  assert.equal(mt940('CITROEN POLSKA', 'serwis'), 'ga/other')
  assert.equal(mt940('DOSTAWCA', 'FV 12/2026 dostawa city center'), 'ga/other')
  assert.equal(mt940('DOSTAWCA', 'zaliczka na poczet dostawy, w tym podatek VAT 23%'), 'financial/tax_vat',
    'jawne „podatek VAT” w tytule nadal jest VAT (zachowanie sprzed poprawki)')
})

test('nierozpoznany przelew MT940 → ga/other, poza RZiS do decyzji; ZUS przed podatkami', () => {
  assert.equal(mt940('FIRMA XYZ', 'przelew'), 'ga/other')
  assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: 'other', pnl_mode: 'auto' }), false)
  assert.equal(mt940('ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH', 'składki 08/2026'), 'ga/zus_employer')
})

test('skutek w RZiS: zaliczka CIT z US trafia do linii cit, VAT jest neutralny', () => {
  const cit = autoClassifyManual(composeDescription('URZĄD SKARBOWY', 'CIT-8 zaliczka 08/2026'), '')
  assert.equal(includeManualCostInPnl({ source: 'mt940', subcategory: cit.subcategory, pnl_mode: 'auto' }), true)
  assert.equal(costLine(cit.cost_category, cit.subcategory), 'cit')
  const vat = autoClassifyManual(composeDescription('URZĄD SKARBOWY', 'VAT-7 08/2026'), '')
  assert.equal(costLine(vat.cost_category, vat.subcategory), 'excluded')
})
