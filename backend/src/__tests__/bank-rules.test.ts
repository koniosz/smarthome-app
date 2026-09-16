/**
 * Reguły bankowe — logika czysta: dopasowanie wzorca (bez polskich znaków, match_field, dłuższy
 * wzorzec pierwszy), klucz deduplikacji MT940, opis „kontrahent · tytuł", propozycja wzorca,
 * rozpoznanie płatności za fakturę KSeF.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/bank-rules.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBankRules, matchBankRule, normalizeForMatch, sortRules, mt940CostKey,
  composeDescription, splitStoredDescription, type BankRuleLike,
} from '../services/mt940-costs'
import {
  suggestPattern, isKsefPayment, buildMatchedIndex, hasDecisionMarker, isDecidedOutsideRules,
  withManualDecisionMarker, withoutManualDecisionMarker,
} from '../routes/bank-rules'

const rule = (over: Partial<BankRuleLike> & { id: string; pattern: string }): BankRuleLike => ({
  match_field: 'any', cost_category: 'ga', subcategory: 'software', business_unit: 'shared', pnl_mode: 'include', ...over,
})

test('normalizeForMatch: małe litery, bez polskich znaków, pojedyncze spacje', () => {
  assert.equal(normalizeForMatch('  Zakład   Ubezpieczeń Społecznych '), 'zaklad ubezpieczen spolecznych')
  assert.equal(normalizeForMatch('ŁÓDŹ Żółć'), 'lodz zolc')
  assert.equal(normalizeForMatch(null), '')
})

test('matchBankRule: wzorzec z polskimi znakami pasuje do tekstu bez nich (i odwrotnie)', () => {
  const rules = [rule({ id: 'zus', pattern: 'Zakład Ubezpieczeń', cost_category: 'ga', subcategory: 'zus_employer' })]
  assert.equal(matchBankRule({ counterparty: 'ZAKLAD UBEZPIECZEN SPOLECZNYCH', description: 'Skladki 01/2026' }, rules)?.id, 'zus')
  const rules2 = [rule({ id: 'zus2', pattern: 'zaklad ubezpieczen' })]
  assert.equal(matchBankRule({ counterparty: 'Zakład Ubezpieczeń Społecznych', description: '' }, rules2)?.id, 'zus2')
  assert.equal(matchBankRule({ counterparty: 'ORANGE POLSKA', description: 'Faktura' }, rules), null)
})

test('matchBankRule: match_field ogranicza pole (counterparty / description / any)', () => {
  const cp = [rule({ id: 'cp', pattern: 'google', match_field: 'counterparty' })]
  const desc = [rule({ id: 'd', pattern: 'google', match_field: 'description' })]
  const any = [rule({ id: 'a', pattern: 'google', match_field: 'any' })]
  const onlyInDesc = { counterparty: 'PAYPAL EUROPE', description: 'Google Workspace 03/2026' }
  const onlyInCp = { counterparty: 'GOOGLE IRELAND LTD', description: 'Subscription' }
  assert.equal(matchBankRule(onlyInDesc, cp), null)
  assert.equal(matchBankRule(onlyInDesc, desc)?.id, 'd')
  assert.equal(matchBankRule(onlyInDesc, any)?.id, 'a')
  assert.equal(matchBankRule(onlyInCp, cp)?.id, 'cp')
  assert.equal(matchBankRule(onlyInCp, desc), null)
  assert.equal(matchBankRule(onlyInCp, any)?.id, 'a')
})

test('sortRules / matchBankRule: dłuższy (bardziej szczegółowy) wzorzec ma pierwszeństwo', () => {
  const rules = [
    rule({ id: 'short', pattern: 'google', subcategory: 'marketing', cost_category: 'sales' }),
    rule({ id: 'long', pattern: 'google workspace', subcategory: 'software', cost_category: 'ga' }),
  ]
  assert.deepEqual(sortRules(rules).map(r => r.id), ['long', 'short'])
  assert.equal(matchBankRule({ counterparty: 'GOOGLE', description: 'Google Workspace' }, rules)?.id, 'long')
  assert.equal(matchBankRule({ counterparty: 'GOOGLE', description: 'Google Ads 123' }, rules)?.id, 'short')
})

test('applyBankRules: trafienie nadaje kategorię, jednostkę, pnl_mode i bank_rule_id; brak → bez zmian', () => {
  const rules = [rule({ id: 'r1', pattern: 'orange', cost_category: 'ga', subcategory: 'utilities', business_unit: 'shc', pnl_mode: 'include' })]
  const base = { counterparty: 'ORANGE POLSKA SA', description: 'Faktura 1/2026', cost_category: 'ga', subcategory: 'other', business_unit: 'shared', pnl_mode: 'auto', bank_rule_id: null as string | null }

  const hit = applyBankRules(base, rules)
  assert.equal(hit.rule?.id, 'r1')
  assert.equal(hit.cost.cost_category, 'ga')
  assert.equal(hit.cost.subcategory, 'utilities')
  assert.equal(hit.cost.business_unit, 'shc')
  assert.equal(hit.cost.pnl_mode, 'include')
  assert.equal(hit.cost.bank_rule_id, 'r1')
  assert.equal(base.subcategory, 'other', 'funkcja czysta — nie mutuje wejścia')

  const miss = applyBankRules({ ...base, counterparty: 'PLAY', description: 'abonament' }, rules)
  assert.equal(miss.rule, null)
  assert.equal(miss.cost.bank_rule_id, null)
  assert.equal(miss.cost.pnl_mode, 'auto')
})

test('applyBankRules: reguła „pomiń" ustawia pnl_mode=exclude; brak jednostki w regule → z kosztu', () => {
  const rules = [rule({ id: 'dup', pattern: 'leasing', pnl_mode: 'exclude', business_unit: null })]
  const { cost } = applyBankRules({ counterparty: 'PKO LEASING', description: 'rata 12', business_unit: 'gatelynk', pnl_mode: 'auto', bank_rule_id: null as string | null }, rules)
  assert.equal(cost.pnl_mode, 'exclude')
  assert.equal(cost.business_unit, 'gatelynk')
})

test('applyBankRules: zapisany ManualCost (bez pola counterparty) — opis „kontrahent · tytuł" jest rozbijany', () => {
  const cpRule = [rule({ id: 'cp', pattern: 'google', match_field: 'counterparty' })]
  const stored = { description: 'GOOGLE IRELAND LTD · Workspace 03/2026' }
  assert.equal(applyBankRules(stored, cpRule).rule?.id, 'cp')
  const cpRule2 = [rule({ id: 'cp2', pattern: 'workspace', match_field: 'counterparty' })]
  assert.equal(applyBankRules(stored, cpRule2).rule, null, 'tytuł nie jest kontrahentem')
})

test('composeDescription / splitStoredDescription: round-trip, limit 500 znaków', () => {
  const d = composeDescription('  ORANGE  POLSKA ', 'Faktura  1/2026 ')
  assert.equal(d, 'ORANGE POLSKA · Faktura 1/2026')
  assert.deepEqual(splitStoredDescription(d), { counterparty: 'ORANGE POLSKA', description: 'Faktura 1/2026' })
  assert.equal(composeDescription('', 'tylko tytuł'), 'tylko tytuł')
  assert.equal(composeDescription('SAMO', 'SAMO'), 'SAMO')
  assert.deepEqual(splitStoredDescription('bez separatora'), { counterparty: '', description: 'bez separatora' })
  assert.equal(composeDescription('a'.repeat(300), 'b'.repeat(300)).length, 500)
})

test('mt940CostKey: data|kwota|referencja; NONREF/brak referencji → początek opisu; kwota bez znaku', () => {
  assert.equal(mt940CostKey({ date: '2026-03-05', amount: -1234.5, reference: '8734501' }), '2026-03-05|1234.50|8734501')
  assert.equal(mt940CostKey({ date: '2026-03-05', amount: 1234.5, reference: '8734501' }), '2026-03-05|1234.50|8734501')
  const longDesc = 'X'.repeat(100)
  assert.equal(mt940CostKey({ date: '2026-03-05', amount: -10, reference: 'NONREF', description: longDesc }), `2026-03-05|10.00|${'X'.repeat(60)}`)
  assert.equal(mt940CostKey({ date: '2026-03-05', amount: -10, reference: '', description: 'opis' }), '2026-03-05|10.00|opis')
})

test('suggestPattern: najdłuższe słowo ≥ 4 liter bez cyfr, kontrahent przed opisem, bez słów ogólnych', () => {
  assert.equal(suggestPattern('ZAKLAD UBEZPIECZEN SPOLECZNYCH', 'Przelew skladki'), 'UBEZPIECZEN')
  assert.equal(suggestPattern('', 'Przelew za fakture FV/12/2024 ORANGE'), 'ORANGE')
  assert.equal(suggestPattern('Faktura', 'Płatność'), '', 'same słowa ogólne → brak propozycji')
  assert.equal(suggestPattern('AB12CD', 'x'), '', 'tokeny z cyframi rozbijają się na krótkie fragmenty')
  assert.equal(suggestPattern('Sp. z o.o. Żabka', ''), 'Żabka')
})

test('isKsefPayment: data + kwota ± 0,01 + zgodna referencja (brak referencji → data + kwota)', () => {
  const idx = buildMatchedIndex([
    { transaction_date: '2026-03-05', amount: -1230, reference: 'REF1' },
    { transaction_date: '2026-03-06', amount: -500, reference: '' },
  ])
  assert.equal(isKsefPayment({ date: '2026-03-05', amount: 1230, reference: 'REF1' }, idx), true)
  assert.equal(isKsefPayment({ date: '2026-03-05', amount: 1230.005, reference: 'REF1' }, idx), true)
  assert.equal(isKsefPayment({ date: '2026-03-05', amount: 1230, reference: 'INNA' }, idx), false, 'inna referencja')
  assert.equal(isKsefPayment({ date: '2026-03-05', amount: 1230, reference: 'NONREF' }, idx), true, 'NONREF = brak referencji')
  assert.equal(isKsefPayment({ date: '2026-03-05', amount: 1231, reference: 'REF1' }, idx), false, 'kwota poza tolerancją')
  assert.equal(isKsefPayment({ date: '2026-03-06', amount: 500, reference: 'COKOLWIEK' }, idx), true, 'transakcja bez referencji')
  assert.equal(isKsefPayment({ date: '2026-03-07', amount: 500, reference: '' }, idx), false, 'inna data')
})

test('hasDecisionMarker: znaczniki decyzji spoza reguł — bez względu na wielkość liter i polskie znaki', () => {
  assert.equal(hasDecisionMarker('wykluczony przez dokument 3f2a'), true)
  assert.equal(hasDecisionMarker('EUR 100 × kurs · Decyzja ręczna (k@x.pl, 2026-03-05)'), true)
  assert.equal(hasDecisionMarker('duplikat dokumentu abc'), true)
  assert.equal(hasDecisionMarker('płatność za fakturę KSeF'), true)
  assert.equal(hasDecisionMarker(''), false)
  assert.equal(hasDecisionMarker(null), false)
  assert.equal(hasDecisionMarker('zwykła notatka o przelewie'), false)
})

test('isDecidedOutsideRules: dokument / znacznik / pnl_mode≠auto bez reguły → nie ruszać w /apply i DELETE reguły', () => {
  const byDoc = new Set(['mt-1'])
  // wykluczony przez zatwierdzony dokument (duplicate_of='mt940:mt-1') — nawet z regułą i bez notes
  assert.equal(isDecidedOutsideRules({ id: 'mt-1', pnl_mode: 'exclude', bank_rule_id: 'r1', notes: '' }, byDoc), true)
  // „Pomiń" / „Licz w RZiS" (PATCH /cost/:id): pnl_mode bez reguły
  assert.equal(isDecidedOutsideRules({ id: 'mt-2', pnl_mode: 'exclude', bank_rule_id: null, notes: '' }, byDoc), true)
  assert.equal(isDecidedOutsideRules({ id: 'mt-3', pnl_mode: 'include', bank_rule_id: null, notes: '' }, byDoc), true)
  // strażnik przy imporcie: reguła include, ale exclude z notatką
  assert.equal(isDecidedOutsideRules({ id: 'mt-4', pnl_mode: 'exclude', bank_rule_id: 'r1', notes: 'płatność za fakturę KSeF' }, byDoc), true)
  // zwykły przelew bez decyzji → reguły mogą działać
  assert.equal(isDecidedOutsideRules({ id: 'mt-5', pnl_mode: 'auto', bank_rule_id: null, notes: '' }, byDoc), false)
  // pnl_mode nadany przez regułę → z overwrite reguły mogą go zmienić
  assert.equal(isDecidedOutsideRules({ id: 'mt-6', pnl_mode: 'exclude', bank_rule_id: 'r1', notes: '' }, byDoc), false)
  assert.equal(isDecidedOutsideRules({ id: 'mt-7', pnl_mode: 'include', bank_rule_id: 'r1' }, byDoc), false)
})

test('withManualDecisionMarker / withoutManualDecisionMarker: dopisanie raz, cofnięcie zachowuje resztę notes', () => {
  const marked = withManualDecisionMarker('', 'k@x.pl', '2026-03-05')
  assert.equal(marked, 'decyzja ręczna (k@x.pl, 2026-03-05)')
  assert.equal(hasDecisionMarker(marked), true)
  assert.equal(withManualDecisionMarker(marked, 'inny@x.pl', '2026-04-01'), marked, 'nie dubluje znacznika')
  const withNote = withManualDecisionMarker('100 EUR × kurs NBP z 2026-03-04', 'k@x.pl', '2026-03-05')
  assert.equal(withNote, '100 EUR × kurs NBP z 2026-03-04 · decyzja ręczna (k@x.pl, 2026-03-05)')
  assert.equal(withoutManualDecisionMarker(withNote), '100 EUR × kurs NBP z 2026-03-04')
  assert.equal(withoutManualDecisionMarker(marked), '')
  assert.equal(hasDecisionMarker(withoutManualDecisionMarker(withNote)), false)
  // znacznik z dokumentu NIE jest usuwany przez cofnięcie decyzji ręcznej
  const doc = 'wykluczony przez dokument abc · decyzja ręczna (k@x.pl, 2026-03-05)'
  assert.equal(withoutManualDecisionMarker(doc), 'wykluczony przez dokument abc')
})
