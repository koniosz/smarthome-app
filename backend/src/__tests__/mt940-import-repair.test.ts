/**
 * Import MT940 — naprawa wierszy starego importu NA MIEJSCU i higiena listy „do sprawdzenia" (logika czysta,
 * bez bazy): prawdziwy parser na SYNTETYCZNYM wyciągu w układzie mBanku (dwa pola :86: na transakcję) →
 * wiersze takie, jakie zapisywał parser sprzed poprawki (opis = sam kod operacji, brak referencji) →
 * plan importu (pomiń / napraw / utwórz) → stan po naprawie → ponowne wgranie = same duplikaty.
 * Wszystkie dane są ZMYŚLONE (nazwy, NIP-y, rachunki).
 * Uruchomienie: cd backend && DATABASE_URL="postgresql://x:x@localhost:1/x" npx tsx --test src/__tests__/mt940-import-repair.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMT940, type ParsedTransaction } from '../utils/mt940Parser'
import {
  isLegacyRow, planMt940CostImport, createCostImportPlanner, composeDescription, costDescription,
  formatFxNote, mt940CostKey, type CostPlanRow, type CostPlanTx, foreignAccountOwner,
} from '../services/mt940-costs'
import {
  bankTxKey, planBankTxImport, createBankTxPlanner, cleanMt940Fields, newTxDisposition, existingTxDisposition,
  type BankTxPlanRow, legacyOrphanIds,
} from '../routes/payables'
import { classifyBankTransfer } from '../services/bank-classify'

// ── Fixture w układzie mBanku ─────────────────────────────────────────────────

function chunks27(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += 27) out.push(text.slice(i, i + 27))
  return out
}

interface MbankTx { line61: string; code: string; label: string; title?: string[]; account?: string; name?: string[] }

/** Transakcja mBanku: pierwsze :86: = sam kod operacji, drugie = kod + subpola (każde w osobnej linii, także puste). */
function mbankTx(t: MbankTx): string[] {
  const title = t.title ?? []
  const name = t.name ?? []
  const acc = t.account ?? ''
  return [
    `:61:${t.line61}`,
    `:86:${t.code}`,
    `:86:${t.code}~00${`B${t.code}${t.label}`.slice(0, 27)}`,
    ...[0, 1, 2, 3, 4, 5].map(k => `~2${k}${title[k] ?? ''}`),
    '~26', '~27', '~28',
    `~29${acc}`, `~30${acc.slice(2, 10)}`, `~31${acc.slice(10)}`,
    `~32${name[0] ?? ''}`, `~33${name[1] ?? ''}`,
    `~34${t.code}`, `~38PL${acc}`, '~62', '~63',
  ]
}

const OWN_MAIN = 'PL11114020040000300212345678'
const OWN_VAT = 'PL22114020040000300212345679'
const SUPPLIER_ACC = '49102055610000390200001234'
const ZUS_ACC = '47600000020260011122233344'
const TAX_ACC = '06101000712221234567890123'
const EMPLOYEE_ACC = '83114020040000310299998888'
const CTX = { ownAccounts: [OWN_MAIN, OWN_VAT], employeeNames: ['Jan Testowy'] }

function statement(body: string[], opts: { account?: string; no?: string } = {}): string {
  return [
    ':20:MT940', `:25:/${opts.account ?? OWN_MAIN}`, `:28C:${opts.no ?? '00009/001'}`, ':60F:C260901PLN10552,99',
    ...body,
    ':62F:C260930PLN8123,45',
  ].join('\r\n')
}

const TX_SUPPLIER = mbankTx({
  line61: '2609010901D1230,00S15207300000001', code: '152', label: 'PRZELEW ZEWNĘTRZNY WYCH',
  title: ['FAKTURA FV/2026/09/0015'], account: SUPPLIER_ACC, name: chunks27('PRZYKLADOWA HURTOWNIA ELEKTRYCZNA SP. Z O.O.'),
})
const TX_CARD = mbankTx({
  line61: '2609010901D349,99S11407300000002', code: '114', label: 'ZAKUP PRZY UŻYCIU KARTY',
  title: ['SKLEP BUDOWLANY KAS/WARSZAW', 'A'.padEnd(27), 'DATA TRANSA'.padStart(27), 'KCJI: 2026-09-01'],
})
const TX_FEE = mbankTx({ line61: '2609020902D2,50S77607300000003', code: '776', label: 'OPŁATA ZA PRZELEW' })
const TX_ZUS = mbankTx({
  line61: '2609150915D4321,10S15307300000004', code: '153', label: 'PRZELEW ZEWNĘTRZNY DO ZUS',
  title: chunks27('DEKLARACJA: DRA 01.08.2026 R OKRES SIERPIEŃ'), account: ZUS_ACC, name: chunks27('ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH'),
})
const TX_PIT4 = mbankTx({
  line61: '2609200920D987,00S21007300000005', code: '210', label: 'PRZELEW PODATKOWY',
  title: ['N5210000000 26M08 PIT-4'], account: TAX_ACC, name: ['URZĄD SKARBOWY'],
})
const TX_VAT_OWN = mbankTx({
  line61: '2609200920D987,00SD9607300000006', code: 'D96', label: 'PP/PRZELEW VAT WYCH. WŁASNY',
  title: ['N5210000000 26M08 PIT-4'],
})
const TX_SALARY = mbankTx({
  line61: '2609300930D6100,00S16907300000007', code: '169', label: 'PRZELEW WEWNĘTRZNY WYCH',
  title: chunks27('WYNAGRODZENIE 9/2026+PREMIA UZNANIOWA'), account: EMPLOYEE_ACC, name: ['JAN TESTOWY'],
})
const TX_CREDIT = mbankTx({
  line61: '2609300930C2460,00S15007300000009', code: '150', label: 'PRZELEW ZEWNĘTRZNY PRZYCH',
  title: ['ZAPLATA ZA FV 12/09/2026'], account: '15109010140000071200005555', name: ['KLIENT TESTOWY SP. Z O.O.'],
})
// dwa RÓŻNE zakupy BLIK tego samego dnia na tę samą kwotę (ten sam kod operacji) — stary klucz ich nie rozróżniał
const TX_BLIK_A = mbankTx({ line61: '2609300930D59,00SC2207300000010', code: 'C22', label: 'BLIK ZAKUP E-COMMERCE', title: ['SKLEP-PIERWSZY.PL'] })
const TX_BLIK_B = mbankTx({ line61: '2609300930D59,00SC2207300000011', code: 'C22', label: 'BLIK ZAKUP E-COMMERCE', title: ['SKLEP-DRUGI.PL'] })

const FULL = statement([...TX_SUPPLIER, ...TX_CARD, ...TX_FEE, ...TX_ZUS, ...TX_PIT4, ...TX_VAT_OWN, ...TX_SALARY, ...TX_CREDIT, ...TX_BLIK_A, ...TX_BLIK_B])

// ── Symulacja bazy: wiersze takie, jakie zapisywał stary import ───────────────

type BankRow = BankTxPlanRow & { id: string; op_code: string | null; matched_invoice_id: string | null; review_status: string }

/** BankTransaction sprzed poprawki: opis = kontrahent = sam kod operacji, brak referencji i rachunku. */
function legacyBankRows(txs: ParsedTransaction[]): BankRow[] {
  return txs.map((t, i) => ({
    id: `bt-${i}`, transaction_date: t.date, amount: t.amount,
    description: t.legacy_description ?? '', counterparty: t.legacy_description ?? '', counterparty_iban: '', reference: '',
    op_code: null, matched_invoice_id: null, review_status: t.amount < 0 ? 'pending' : 'dismissed',
  }))
}

/** Naprawa na miejscu — dokładnie pola, które zapisuje import (payables.ts / bank.ts). */
function repairBankRow(row: BankRow, t: ParsedTransaction): void {
  row.description = t.description
  row.counterparty = t.counterparty
  row.counterparty_iban = t.counterparty_iban
  row.reference = t.reference
  row.op_code = t.op_code || null
}

type CostRow = CostPlanRow & { id: string }

const costTx = (t: ParsedTransaction): CostPlanTx => ({
  date: t.date, amount: Math.abs(t.amount), reference: t.reference,
  description: costDescription(t, classifyBankTransfer({ ...t, description: t.description, counterparty: t.counterparty }, CTX)),
  op_code: t.op_code, legacy_description: t.legacy_description,
})

/** ManualCost sprzed poprawki: composeDescription(kod, kod) = kod, kwota dodatnia, brak referencji. */
function legacyCostRows(txs: ParsedTransaction[]): CostRow[] {
  return txs.filter(t => t.amount < 0 && !t.is_reversal).map((t, i) => ({
    id: `mc-${i}`, date: t.date, amount: Math.abs(t.amount),
    description: composeDescription(t.legacy_description, t.legacy_description), reference: '', notes: '',
  }))
}

// ── Parser: to, na czym opiera się naprawa ────────────────────────────────────

test('fixture: parser zwraca czysty tytuł i 11-cyfrową referencję, a legacy_description = sam kod operacji', () => {
  const txs = parseMT940(FULL)
  assert.equal(txs.length, 10)
  for (const t of txs) {
    assert.equal(t.legacy_description, t.op_code, 'stary parser gubił drugie :86: — zostawał sam kod')
    assert.match(t.reference, /^\d{11}$/)
    assert.ok(!t.description.includes('~'))
  }
  assert.equal(txs[1].description, 'SKLEP BUDOWLANY KAS/WARSZAWA DATA TRANSAKCJI: 2026-09-01')
  assert.equal(txs[2].description, '', 'opłata bankowa nie ma tytułu')
})

// ── isLegacyRow ───────────────────────────────────────────────────────────────

test('isLegacyRow: opis = kod operacji (≤ 3 znaki) i brak referencji', () => {
  const tx = { op_code: '152', legacy_description: '152' }
  assert.equal(isLegacyRow({ description: '152', reference: '' }, tx), true)
  assert.equal(isLegacyRow({ description: ' 152 ', reference: null }, tx), true)
  assert.equal(isLegacyRow({ description: '152', reference: 'NONREF' }, tx), true, 'NONREF = brak referencji')
  assert.equal(isLegacyRow({ description: '152', reference: '07300000001' }, tx), false, 'wiersz z referencją jest już z nowego parsera')
  assert.equal(isLegacyRow({ description: '169', reference: '' }, tx), false, 'inny kod operacji')
  assert.equal(isLegacyRow({ description: 'FAKTURA FV/2026/09/0015', reference: '' }, tx), false, 'pełny opis to nie stary wiersz')
  assert.equal(isLegacyRow({ description: '', reference: '' }, tx), false)
  // kod z literą: stary wiersz ma go w oryginalnej pisowni
  assert.equal(isLegacyRow({ description: 'C22', reference: '' }, { op_code: 'C22', legacy_description: 'C22' }), true)
  assert.equal(isLegacyRow({ description: 'c22', reference: '' }, { op_code: 'C22', legacy_description: '' }), true)
  // wyciąg niestrukturalny: brak kodu, stary opis był pełnym tekstem — nie „goły"
  assert.equal(isLegacyRow({ description: 'Przelew za fakture', reference: '' }, { op_code: '', legacy_description: 'Przelew za fakture' }), false)
  assert.equal(isLegacyRow({ description: 'ZUS', reference: '' }, { op_code: '', legacy_description: 'ZUS' }), true, '3-znakowy opis sprzed poprawki')
  assert.equal(isLegacyRow({ description: '152', reference: '' }, { op_code: '', legacy_description: '' }), false, 'transakcja bez kodu nie paruje się z gołym kodem')
})

// ── Transakcje bankowe (Płatności) ────────────────────────────────────────────

test('transakcje bankowe: ponowne wgranie wyciągu naprawia KAŻDY stary wiersz na miejscu — nic nie powstaje', () => {
  const txs = parseMT940(FULL)
  const rows = legacyBankRows(txs)
  const plan = planBankTxImport(txs, rows)
  assert.deepEqual(plan.map(d => d.action), Array(10).fill('repair'))
  assert.equal(new Set(plan.map(d => d.index)).size, 10, 'każdy stary wiersz zużyty dokładnie raz')
  // parowanie po dacie i kwocie ZE ZNAKIEM oraz kodzie operacji
  plan.forEach((d, i) => {
    assert.equal(rows[d.index].transaction_date, txs[i].date)
    assert.equal(rows[d.index].amount, txs[i].amount)
    assert.equal(rows[d.index].description, txs[i].op_code)
  })
})

test('transakcje bankowe: po naprawie ten sam plik to same duplikaty (klucz deduplikacji trafia w naprawione wiersze)', () => {
  const txs = parseMT940(FULL)
  const rows = legacyBankRows(txs)
  planBankTxImport(txs, rows).forEach((d, i) => repairBankRow(rows[d.index], txs[i]))

  const again = planBankTxImport(parseMT940(FULL), rows)
  assert.deepEqual(again.map(d => d.action), Array(10).fill('skip'))
  assert.equal(new Set(again.map(d => d.index)).size, 10)
  // klucz wiersza z bazy (po cleanMt940Fields) = klucz transakcji z pliku
  txs.forEach((t, i) => {
    const row = rows.find(r => r.reference === t.reference)!
    assert.equal(bankTxKey({ ...row, ...cleanMt940Fields(row) }), bankTxKey(t), `transakcja ${i}`)
  })
  // trzecie i kolejne wgranie — bez zmian
  assert.deepEqual(planBankTxImport(parseMT940(FULL), rows).map(d => d.action), Array(10).fill('skip'))
})

test('transakcje bankowe: dwa identyczne zakupy tego samego dnia nie pożerają się nawzajem', () => {
  const txs = parseMT940(statement([...TX_BLIK_A, ...TX_BLIK_B]))
  const rows = legacyBankRows(txs)
  assert.equal(rows[0].description, rows[1].description, 'stare wiersze są nierozróżnialne')
  const plan = planBankTxImport(txs, rows)
  assert.deepEqual(plan.map(d => d.action), ['repair', 'repair'])
  assert.notEqual(plan[0].index, plan[1].index, 'dwa różne wiersze')
  plan.forEach((d, i) => repairBankRow(rows[d.index], txs[i]))
  assert.deepEqual(rows.map(r => r.description).sort(), ['SKLEP-DRUGI.PL', 'SKLEP-PIERWSZY.PL'])

  // w bazie tylko JEDEN stary wiersz, w pliku dwie transakcje → jedna naprawa, jedna nowa
  const one = legacyBankRows(txs).slice(0, 1)
  assert.deepEqual(planBankTxImport(txs, one).map(d => d.action), ['repair', 'create'])
  // trzy takie same transakcje i dwa stare wiersze → dwie naprawy i jedna nowa
  const three = parseMT940(statement([...TX_BLIK_A, ...TX_BLIK_B, ...mbankTx({ line61: '2609300930D59,00SC2207300000012', code: 'C22', label: 'BLIK ZAKUP E-COMMERCE', title: ['SKLEP-TRZECI.PL'] })]))
  assert.deepEqual(planBankTxImport(three, legacyBankRows(txs)).map(d => d.action), ['repair', 'repair', 'create'])
})

test('transakcje bankowe: zachodzące na siebie wyciągi — część naprawiona wcześniej, reszta teraz, nowe transakcje dochodzą', () => {
  const first = parseMT940(statement([...TX_SUPPLIER, ...TX_CARD, ...TX_FEE]))
  const second = parseMT940(statement([...TX_FEE, ...TX_ZUS, ...TX_PIT4, ...TX_SALARY], { no: '00010/001' }))
  // stary import obu plików: opłata (wspólna dla obu) zapisana raz
  const rows = legacyBankRows(parseMT940(statement([...TX_SUPPLIER, ...TX_CARD, ...TX_FEE, ...TX_ZUS, ...TX_PIT4])))

  const p1 = planBankTxImport(first, rows)
  assert.deepEqual(p1.map(d => d.action), ['repair', 'repair', 'repair'])
  p1.forEach((d, i) => repairBankRow(rows[d.index], first[i]))

  const p2 = planBankTxImport(second, rows)
  assert.deepEqual(p2.map(d => d.action), ['skip', 'repair', 'repair', 'create'], 'opłata już naprawiona, pensji w bazie nie było')
  assert.equal(rows.filter(r => r.reference === '').length, 2, 'przed zapisem drugiego planu zostały dwa stare wiersze')
})

test('transakcje bankowe: obciążenie i uznanie na tę samą kwotę tego samego dnia to różne wiersze (kwota ze znakiem)', () => {
  const debit = mbankTx({ line61: '2609050905D500,00S15207300000020', code: '152', label: 'PRZELEW ZEWNĘTRZNY WYCH', title: ['ZWROT KAUCJI'] })
  const credit = mbankTx({ line61: '2609050905C500,00S15207300000021', code: '152', label: 'PRZELEW ZEWNĘTRZNY WYCH', title: ['KOREKTA'] })
  const txs = parseMT940(statement([...debit, ...credit]))
  const rows = legacyBankRows(txs)
  const plan = planBankTxImport(txs, rows)
  assert.deepEqual(plan.map(d => d.action), ['repair', 'repair'])
  assert.equal(rows[plan[0].index].amount, -500)
  assert.equal(rows[plan[1].index].amount, 500)
  // sam debet w pliku nie może naprawić wiersza uznania
  assert.deepEqual(planBankTxImport([txs[0]], [rows[1]]).map(d => d.action), ['create'])
})

test('transakcje bankowe: wiersz zapisany bez referencji, ale z pełnym opisem (inny bank) to duplikat, nie nowa transakcja', () => {
  const [tx] = parseMT940(statement(TX_SUPPLIER))
  const row: BankTxPlanRow = {
    transaction_date: tx.date, amount: tx.amount, description: tx.description,
    counterparty: tx.counterparty, counterparty_iban: tx.counterparty_iban, reference: '',
  }
  assert.deepEqual(planBankTxImport([tx], [row]).map(d => d.action), ['skip'])
  // inna referencja przy tym samym opisie = inna transakcja
  assert.deepEqual(planBankTxImport([tx], [{ ...row, reference: '99999999999' }]).map(d => d.action), ['create'])
})

test('bankTxKey: data | kwota ze znakiem | referencja | opis — odstępy i polskie znaki bez znaczenia', () => {
  assert.equal(
    bankTxKey({ date: '2026-09-01', amount: -1230, reference: '07300000001', description: 'FAKTURA FV/2026/09/0015' }),
    '2026-09-01|-1230.00|07300000001|fakturafv2026090015',
  )
  assert.equal(
    bankTxKey({ transaction_date: '2026-09-01', amount: -1230, reference: '0730 0000 001', description: 'Faktura  FV 2026-09-0015' }),
    bankTxKey({ date: '2026-09-01', amount: -1230, reference: '07300000001', description: 'FAKTURA FV/2026/09/0015' }),
  )
  assert.notEqual(
    bankTxKey({ date: '2026-09-01', amount: 1230, reference: 'A', description: 'x' }),
    bankTxKey({ date: '2026-09-01', amount: -1230, reference: 'A', description: 'x' }),
  )
  assert.equal(bankTxKey({ date: '2026-09-02', amount: -2.5, reference: '', description: '' }), '2026-09-02|-2.50||')
})

// ── cleanMt940Fields ──────────────────────────────────────────────────────────

test('cleanMt940Fields: dla wyniku parsera nic nie zmienia', () => {
  for (const t of parseMT940(FULL)) {
    assert.deepEqual(cleanMt940Fields(t), { description: t.description, counterparty: t.counterparty, counterparty_iban: t.counterparty_iban })
  }
  // tylda w zwykłym tekście (nie znacznik subpola na początku) też niczego nie uruchamia
  const plain = { description: 'Zaplata ~ok. 20 szt. ~20 zl', counterparty: 'FIRMA TESTOWA', counterparty_iban: '' }
  assert.deepEqual(cleanMt940Fields(plain), plain)
  const empty = { description: '', counterparty: '', counterparty_iban: '' }
  assert.deepEqual(cleanMt940Fields(empty), empty)
})

test('cleanMt940Fields: surowy wiersz dawnego importu — kawałek 27 znaków łączy się bezpośrednio z następnym', () => {
  // stary parser przycinał linie i sklejał je spacją
  const rawLines = [
    '114~00B114ZAKUP PRZY UŻYCIU KARTY', '~20SKLEP BUDOWLANY KAS/WARSZAW', `~21${'A'.padEnd(27)}`,
    `~22${'DATA TRANSA'.padStart(27)}`, '~23KCJI: 2026-09-01', '~24', '~25', '~29', '~32', '~33', '~38PL',
  ]
  const multiLine = rawLines.map(l => l.trim()).join(' ')
  const cleaned = cleanMt940Fields({ description: multiLine, counterparty: multiLine.slice(0, 80), counterparty_iban: '' })
  assert.equal(cleaned.description, 'SKLEP BUDOWLANY KAS/WARSZAWA DATA TRANSAKCJI: 2026-09-01')
  assert.equal(cleaned.counterparty, '', 'początek surowego pola to nie nazwa kontrahenta')
  assert.equal(cleaned.counterparty_iban, '', 'sam prefiks „PL" to nie rachunek')

  // subpola w jednej linii (styl ING): tytuł pocięty co 27 znaków w środku słowa, nazwa w dwóch kawałkach
  const name = chunks27('PRZYKLADOWA HURTOWNIA ELEKTRYCZNA SP. Z O.O.')
  const title = chunks27('ZAPLATA ZA FAKTURE FV/2026/09/0015 Z DNIA 2026-09-01')
  const inline = `020~00PRZELEW~20${title[0]}~21${title[1]}~29${SUPPLIER_ACC}~32${name[0]}~33${name[1]}~38PL${SUPPLIER_ACC}`
  const c2 = cleanMt940Fields({ description: inline, counterparty: inline.slice(0, 80), counterparty_iban: '' })
  assert.equal(c2.description, 'ZAPLATA ZA FAKTURE FV/2026/09/0015 Z DNIA 2026-09-01')
  assert.equal(c2.counterparty, 'PRZYKLADOWA HURTOWNIA ELEKTRYCZNA SP. Z O.O.')
  assert.equal(c2.counterparty_iban, `PL${SUPPLIER_ACC}`)

  // krótsze kawałki (nie 27 znaków) dostają spację
  const short = cleanMt940Fields({ description: '~20ZAPLATA ZA~21FAKTURE 7~32FIRMA~33TESTOWA', counterparty: '', counterparty_iban: 'PL00' })
  assert.equal(short.description, 'ZAPLATA ZA FAKTURE 7')
  assert.equal(short.counterparty, 'FIRMA TESTOWA')
  assert.equal(short.counterparty_iban, 'PL00', 'brak ~38 → zostaje zapisany rachunek')
})

test('cleanMt940Fields: surowy wiersz i świeży odczyt tego samego pola dają ten sam klucz deduplikacji', () => {
  const name = chunks27('PRZYKLADOWA HURTOWNIA ELEKTRYCZNA SP. Z O.O.')
  const title = chunks27('ZAPLATA ZA FAKTURE FV/2026/09/0015 Z DNIA 2026-09-01')
  const field = `020~00PRZELEW~20${title[0]}~21${title[1]}~32${name[0]}~33${name[1]}~38PL${SUPPLIER_ACC}`
  const [fresh] = parseMT940(statement([':61:2609010901D1230,00NTRFNONREF//BANKREF1', `:86:${field}`]))
  assert.equal(fresh.description, 'ZAPLATA ZA FAKTURE FV/2026/09/0015 Z DNIA 2026-09-01')
  const stored = { transaction_date: fresh.date, amount: fresh.amount, description: field, counterparty: field.slice(0, 80), counterparty_iban: '', reference: 'BANKREF1' }
  assert.equal(bankTxKey({ ...stored, ...cleanMt940Fields(stored) }), bankTxKey(fresh))
  assert.deepEqual(planBankTxImport([fresh], [stored]).map(d => d.action), ['skip'])
})

// ── Higiena listy „do sprawdzenia" ────────────────────────────────────────────

test('newTxDisposition: uznanie / nie-faktura (odrzucenie bez auto-dopasowania) / storno / próba dopasowania', () => {
  assert.equal(newTxDisposition({ amount: 100, is_reversal: false }, false), 'credit')
  assert.equal(newTxDisposition({ amount: 100, is_reversal: false }, true), 'credit', 'uznania nie klasyfikujemy')
  assert.equal(newTxDisposition({ amount: -100, is_reversal: false }, true), 'dismiss')
  assert.equal(newTxDisposition({ amount: -100, is_reversal: true }, true), 'dismiss')
  assert.equal(newTxDisposition({ amount: -100, is_reversal: true }, false), 'review')
  assert.equal(newTxDisposition({ amount: -100, is_reversal: false }, false), 'match')
})

test('existingTxDisposition: dopasowania nigdy nie ruszamy; odrzucamy tylko wiersz czekający (pending / none)', () => {
  const debit = { amount: -100, is_reversal: false }
  // ZUS / podatek / pensja / opłata / przelew własny
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'pending' }, debit, true), 'dismiss')
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'none' }, debit, true), 'dismiss')
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: '' }, debit, true), 'dismiss', 'brak statusu = none')
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'dismissed' }, debit, true), 'keep')
  assert.equal(existingTxDisposition({ matched_invoice_id: 'inv-1', review_status: 'assigned' }, debit, true), 'keep', 'ręcznie przypisany — zostaje')
  assert.equal(existingTxDisposition({ matched_invoice_id: 'inv-1', review_status: 'matched' }, debit, true), 'keep')
  assert.equal(existingTxDisposition({ matched_invoice_id: 'inv-1', review_status: 'none' }, debit, true), 'keep', 'dopasowany starym silnikiem /bank/match')
  // zwykłe obciążenie: auto-dopasowanie tylko dla czekającego w Płatnościach
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'pending' }, debit, false), 'match')
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'none' }, debit, false), 'keep', 'spoza panelu Płatności')
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'dismissed' }, debit, false), 'keep', 'odrzucony ręcznie nie wraca')
  assert.equal(existingTxDisposition({ matched_invoice_id: 'inv-1', review_status: 'matched' }, debit, false), 'keep')
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'pending' }, { amount: -100, is_reversal: true }, false), 'review')
  // uznania
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'dismissed' }, { amount: 100 }, false), 'keep')
  assert.equal(existingTxDisposition({ matched_invoice_id: null, review_status: 'none' }, { amount: 100 }, true), 'keep')
})

test('higiena na syntetycznym wyciągu: ZUS, PIT-4, przelew własny z rachunku VAT, pensja i opłata znikają z listy; dostawca i zakupy zostają', () => {
  const txs = parseMT940(FULL)
  const disposition = txs.map(t => {
    const notInvoice = t.amount < 0 && classifyBankTransfer({
      date: t.date, amount: t.amount, description: t.description, counterparty: t.counterparty,
      counterparty_iban: t.counterparty_iban, op_code: t.op_code, op_label: t.op_label, currency: t.currency,
    }, CTX).not_invoice_payment
    return newTxDisposition(t, notInvoice)
  })
  assert.deepEqual(disposition, [
    'match',    // dostawca — prawdziwa płatność za fakturę
    'match',    // zakup kartą
    'dismiss',  // opłata bankowa
    'dismiss',  // ZUS
    'dismiss',  // PIT-4
    'dismiss',  // D96: przelew własny z rachunku VAT z tytułem PIT-4
    'dismiss',  // wynagrodzenie
    'credit',   // wpływ od klienta
    'match', 'match',
  ])
})

// ── Koszty (ManualCost) ───────────────────────────────────────────────────────

test('koszty: stare wiersze (opis = kod operacji) są naprawiane, a po naprawie ten sam plik niczego nie tworzy', () => {
  const txs = parseMT940(FULL)
  const outgoing = txs.filter(t => t.amount < 0 && !t.is_reversal)
  assert.equal(outgoing.length, 9)
  const rows = legacyCostRows(txs)
  assert.deepEqual([...new Set(rows.map(r => r.description))].sort(), ['114', '152', '153', '169', '210', '776', 'C22', 'D96'])
  // stary klucz deduplikacji (data|kwota|kod) NIE trafia w nową transakcję — dlatego potrzebny jest plan z naprawą
  assert.notEqual(mt940CostKey(rows[0]), mt940CostKey(costTx(outgoing[0])))

  const planned = outgoing.map(costTx)
  const plan = planMt940CostImport(planned, rows)
  assert.deepEqual(plan.map(d => d.action), Array(9).fill('repair'))
  assert.equal(new Set(plan.map(d => d.index)).size, 9)

  // zapis pól tekstowych jak w upsertMt940Costs
  plan.forEach((d, i) => { rows[d.index].description = planned[i].description ?? ''; rows[d.index].reference = planned[i].reference ?? '' })
  assert.deepEqual(planMt940CostImport(outgoing.map(costTx), rows).map(d => d.action), Array(9).fill('skip'))
  // opis operacji bez tytułu i kontrahenta to nazwa operacji — nigdy sam kod
  const fee = rows.find(r => r.reference === '07300000003')!
  assert.equal(fee.description, 'OPŁATA ZA PRZELEW')
  assert.equal(rows.some(r => r.description.trim().length <= 3), false, 'żaden naprawiony wiersz nie wygląda jak stary import')
})

test('koszty: przelew PIT-4 i jego bliźniak z rachunku VAT (ta sama data i kwota, inny kod) trafiają we właściwe stare wiersze', () => {
  const txs = parseMT940(statement([...TX_PIT4, ...TX_VAT_OWN]))
  const rows = legacyCostRows(txs)
  const plan = planMt940CostImport(txs.map(costTx), rows)
  assert.deepEqual(plan.map(d => d.action), ['repair', 'repair'])
  assert.equal(rows[plan[0].index].description, '210')
  assert.equal(rows[plan[1].index].description, 'D96')
  // odwrotna kolejność wierszy w bazie niczego nie zmienia
  const reversed = [...rows].reverse()
  const plan2 = planMt940CostImport(txs.map(costTx), reversed)
  assert.equal(reversed[plan2[0].index].description, '210')
  assert.equal(reversed[plan2[1].index].description, 'D96')
})

test('koszty: identyczne transakcje i częściowo zaimportowany plik — każdy wiersz zużywany raz', () => {
  const txs = parseMT940(statement([...TX_BLIK_A, ...TX_BLIK_B]))
  const planned = txs.map(costTx)
  // w bazie: pierwszy zakup już z nowego parsera, drugi jeszcze jako stary wiersz
  const rows: CostRow[] = [
    { id: 'new', date: planned[0].date, amount: 59, description: planned[0].description ?? '', reference: planned[0].reference ?? '', notes: '' },
    { id: 'old', date: planned[1].date, amount: 59, description: 'C22', reference: '', notes: '' },
  ]
  assert.deepEqual(planMt940CostImport(planned, rows), [{ action: 'skip', index: 0 }, { action: 'repair', index: 1 }])
  // tylko nowy wiersz pierwszego zakupu → drugi zakup jest tworzony (nie „pożera" go wiersz pierwszego)
  assert.deepEqual(planMt940CostImport(planned, rows.slice(0, 1)), [{ action: 'skip', index: 0 }, { action: 'create', index: -1 }])
  // dwa stare wiersze i jedna transakcja → drugi stary wiersz zostaje nietknięty
  const twoOld: CostRow[] = [{ ...rows[1], id: 'old-1' }, { ...rows[1], id: 'old-2' }]
  assert.deepEqual(planMt940CostImport(planned.slice(0, 1), twoOld), [{ action: 'repair', index: 0 }])
})

test('koszty w walucie obcej: klucz po kwocie oryginalnej z notatki kursowej (pomiń) i naprawa starego wiersza po tej kwocie', () => {
  const tx: CostPlanTx = { date: '2026-08-14', amount: 1000, reference: '07300000050', description: 'DOSTAWCA GMBH · ORDER 7', op_code: '340', legacy_description: '340' }
  const note = formatFxNote(1000, 'EUR', 4.3012, '2026-08-13')
  // już zaimportowany poprawionym parserem, przeliczony na PLN
  const converted: CostRow = { id: 'a', date: '2026-08-14', amount: 4301.2, description: 'DOSTAWCA GMBH · ORDER 7', reference: '07300000050', notes: note }
  assert.deepEqual(planMt940CostImport([tx], [converted]), [{ action: 'skip', index: 0 }])
  // stary wiersz przeliczony na PLN: kwota zapisana 4301,20, oryginalna 1000,00 w notatce
  const legacyConverted: CostRow = { id: 'b', date: '2026-08-14', amount: 4301.2, description: '340', reference: '', notes: note }
  assert.deepEqual(planMt940CostImport([tx], [legacyConverted]), [{ action: 'repair', index: 0 }])
  // stary wiersz bez kursu (kwota oryginalna, waluta EUR)
  const legacyNoRate: CostRow = { id: 'c', date: '2026-08-14', amount: 1000, description: '340', reference: '', notes: 'brak kursu NBP — przelicz ręcznie' }
  assert.deepEqual(planMt940CostImport([tx], [legacyNoRate]), [{ action: 'repair', index: 0 }])
  // drugie podejście po przeliczeniu (kwota w PLN) trafia w stary wiersz, którego notatkę kursową nadpisano
  const planner = createCostImportPlanner<CostRow>([{ id: 'd', date: '2026-08-14', amount: 4301.2, description: '340', reference: '', notes: 'notatka użytkownika' }])
  assert.deepEqual(planner.decide(tx), { action: 'create', index: -1 }, 'po kwocie oryginalnej brak trafienia — nic nie zużyte')
  assert.deepEqual(planner.decide({ ...tx, amount: 4301.2 }), { action: 'repair', index: 0 })
  assert.deepEqual(planner.decide({ ...tx, amount: 4301.2 }), { action: 'create', index: -1 }, 'wiersz zużyty tylko raz')
  // tolerancja pół grosza, ale nie grosz
  const near: CostRow = { id: 'e', date: '2026-08-14', amount: 1000.004, description: '340', reference: '', notes: '' }
  assert.deepEqual(planMt940CostImport([tx], [near]), [{ action: 'repair', index: 0 }])
  assert.deepEqual(planMt940CostImport([tx], [{ ...near, amount: 1000.01 }]), [{ action: 'create', index: -1 }])
  // inna data = inna transakcja
  assert.deepEqual(planMt940CostImport([tx], [{ ...near, date: '2026-08-15' }]), [{ action: 'create', index: -1 }])
})

// ── Strażnik: wyciąg rachunku prowadzonego w innej firmie ─────────────────────

test('foreignAccountOwner: rachunek z saldami w innej firmie blokuje import; własny i nieznany — nie', () => {
  const A = 'firma-a', B = 'firma-b'
  const balances = [
    { account: 'PL11114020040000300212345678', company_id: A },
    { account: 'PL22114020040000300287654321', company_id: B },
    { account: 'PL33114020040000300200000001', company_id: null }, // stary wiersz = firma domyślna
  ]
  // własny rachunek aktywnej firmy
  assert.equal(foreignAccountOwner(['PL11114020040000300212345678'], balances, A, A), null)
  // rachunek firmy B wgrywany w firmie A
  assert.deepEqual(foreignAccountOwner(['PL22114020040000300287654321'], balances, A, A), { account: 'PL22114020040000300287654321', company_id: B })
  // zapis z odstępami i ukośnikiem (jak w :25:) to ten sam rachunek
  assert.deepEqual(foreignAccountOwner(['/PL22 1140 2004 0000 3002 8765 4321'], balances, A, A), { account: 'PL22114020040000300287654321', company_id: B })
  // rachunek, którego nikt jeszcze nie wgrywał
  assert.equal(foreignAccountOwner(['PL99114020040000300299999999'], balances, A, A), null)
  // brak rachunków w pliku (wyciąg bez :25:)
  assert.equal(foreignAccountOwner([null, '', undefined], balances, A, A), null)
})

test('foreignAccountOwner: wiersz bez firmy należy do firmy domyślnej; brak kontekstu = firma domyślna', () => {
  const DEF = 'firma-domyslna', B = 'firma-b'
  const legacy = [{ account: 'PL33114020040000300200000001', company_id: null }]
  // firma domyślna wgrywa swój stary rachunek — w porządku
  assert.equal(foreignAccountOwner(['PL33114020040000300200000001'], legacy, DEF, DEF), null)
  // zadanie bez kontekstu firmy działa w firmie domyślnej
  assert.equal(foreignAccountOwner(['PL33114020040000300200000001'], legacy, undefined, DEF), null)
  // inna firma wgrywa rachunek firmy domyślnej
  assert.deepEqual(foreignAccountOwner(['PL33114020040000300200000001'], legacy, B, DEF), { account: 'PL33114020040000300200000001', company_id: DEF })
  // ten sam rachunek ma salda w dwóch firmach (ślad dawnej pomyłki): firma, która go prowadzi, NIE jest blokowana —
  // inaczej żadna z dwóch firm nie mogłaby wgrać wyciągu ponownie; trzecia firma nadal jest
  const both = [{ account: 'PL33114020040000300200000001', company_id: B }, { account: 'PL33114020040000300200000001', company_id: null }]
  assert.equal(foreignAccountOwner(['PL33114020040000300200000001'], both, B, DEF), null)
  assert.equal(foreignAccountOwner(['PL33114020040000300200000001'], both, DEF, DEF), null)
  assert.ok(foreignAccountOwner(['PL33114020040000300200000001'], both, 'firma-c', DEF))
})

// ── Pozostałości starego importu (zdublowane „gołe" wiersze) ───────────────────

test('legacyOrphanIds: nadwyżkowy goły wiersz na dzień/kwotę/kod z pliku jest pozostałością; dopasowane i obce — nie', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, transaction_date: '2026-03-10', amount: -1.5, description: '776', reference: '', op_code: null,
    matched_invoice_id: null, review_status: 'pending', ...extra,
  })
  const parsed = [{ date: '2026-03-10', amount: -1.5, op_code: '776', legacy_description: '776' }]
  // dwa identyczne gołe wiersze, plik ma jeden taki przelew: pierwszy naprawiony, drugi jest pozostałością
  assert.deepEqual(legacyOrphanIds([row('a'), row('b')], parsed, new Set(['a'])), ['b'])
  // wiersz dopasowany do faktury albo przypisany ręcznie zostaje nietknięty
  assert.deepEqual(legacyOrphanIds([row('a'), row('b', { matched_invoice_id: 'inv-1' })], parsed, new Set(['a'])), [])
  assert.deepEqual(legacyOrphanIds([row('a'), row('b', { review_status: 'assigned' })], parsed, new Set(['a'])), [])
  // wiersz już uzupełniony wcześniej (ma op_code) nie jest pozostałością
  assert.deepEqual(legacyOrphanIds([row('a'), row('b', { op_code: '776', description: 'OPŁATA ZA PRZELEW' })], parsed, new Set(['a'])), [])
  // inny dzień, inna kwota albo inny kod — plik o nim nie mówi, zostaje do naprawy innym wyciągiem
  assert.deepEqual(legacyOrphanIds([row('c', { transaction_date: '2026-03-11' }), row('d', { amount: -2 }), row('e', { description: '27A' })], parsed, new Set()), [])
  // uznanie i obciążenie o tej samej kwocie to różne klucze (kwota ze znakiem)
  assert.deepEqual(legacyOrphanIds([row('f', { amount: 1.5 })], parsed, new Set()), [])
  // plik bez kodów operacji (inny bank) niczego nie odkłada
  assert.deepEqual(legacyOrphanIds([row('a')], [{ date: '2026-03-10', amount: -1.5, op_code: '', legacy_description: 'OPŁATA ZA PRZELEW' }], new Set()), [])
})
