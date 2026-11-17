/**
 * Parser MT940 — szczegóły przelewu z pola :86: (tytuł, kontrahent, IBAN, kod operacji):
 * mBank (dwa pola :86: na transakcję, subpola ~NN w kawałkach po 27 znaków), treść strukturalna
 * w jednej linii (styl ING), separatory „?", „<", „^", treść niestrukturalna (/NAME/), linia :61:
 * (RC/RD, litera waluty, referencje), opis w wersji sprzed poprawki (legacy_description).
 * Wszystkie dane w fixture'ach są ZMYŚLONE (nazwy, NIP-y, rachunki).
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/mt940-parser.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMT940, parseMT940Statements } from '../utils/mt940Parser'

// ── Fixture w układzie mBanku ─────────────────────────────────────────────────

/** Tnie ciągły tekst na kawałki po 27 znaków — tak mBank rozkłada tytuł / nazwę na subpola. */
function chunks27(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += 27) out.push(text.slice(i, i + 27))
  return out
}

interface MbankTx {
  line61: string
  code: string
  label: string        // etykieta operacji (bank ucina „B<kod><etykieta>" do 27 znaków)
  title?: string[]     // subpola ~20..~25
  account?: string     // 26 cyfr rachunku kontrahenta lub brak
  name?: string[]      // subpola ~32, ~33
  address?: string[]   // subpola ~62, ~63
}

/** Transakcja mBanku: pierwsze :86: = sam kod operacji, drugie = kod + subpola, każde w osobnej linii (także puste). */
function mbankTx(t: MbankTx): string[] {
  const title = t.title ?? []
  const name = t.name ?? []
  const address = t.address ?? []
  const acc = t.account ?? ''
  return [
    `:61:${t.line61}`,
    `:86:${t.code}`,
    `:86:${t.code}~00${`B${t.code}${t.label}`.slice(0, 27)}`,
    ...[0, 1, 2, 3, 4, 5].map(k => `~2${k}${title[k] ?? ''}`),
    '~26', '~27', '~28',
    `~29${acc}`,
    `~30${acc.slice(2, 10)}`,
    `~31${acc.slice(10)}`,
    `~32${name[0] ?? ''}`,
    `~33${name[1] ?? ''}`,
    `~34${t.code}`,
    `~38PL${acc}`,
    `~62${address[0] ?? ''}`,
    `~63${address[1] ?? ''}`,
  ]
}

const OWN_ACCOUNT = 'PL11114020040000300212345678'
const SUPPLIER_ACC = '49102055610000390200001234'
const ZUS_ACC = '47600000020260011122233344'
const TAX_ACC = '06101000712221234567890123'
const EMPLOYEE_ACC = '83114020040000310299998888'

const MBANK_LINES = [
  ':20:MT940',
  `:25:/${OWN_ACCOUNT}`,
  ':28C:00009/001',
  ':60F:C260901PLN10552,99',
  // 0 — przelew zewnętrzny: IBAN, nazwa w dwóch kawałkach, adres
  ...mbankTx({
    line61: '2609010901D1230,00S15207300000001', code: '152', label: 'PRZELEW ZEWNĘTRZNY WYCH',
    title: ['FAKTURA FV/2026/09/0015'], account: SUPPLIER_ACC,
    name: chunks27('PRZYKLADOWA HURTOWNIA ELEKTRYCZNA SP. Z O.O.'),
    address: ['UL. TESTOWA 1', '00-001 WARSZAWA'],
  }),
  // 1 — zakup kartą: słowo przecięte między kawałkami + dopełnienie spacjami
  ...mbankTx({
    line61: '2609010901D349,99S11407300000002', code: '114', label: 'ZAKUP PRZY UŻYCIU KARTY',
    title: ['SKLEP BUDOWLANY KAS/WARSZAW', 'A'.padEnd(27), 'DATA TRANSA'.padStart(27), 'KCJI: 2026-09-01'],
  }),
  // 2 — opłata bankowa: bez tytułu i bez kontrahenta
  ...mbankTx({ line61: '2609020902D2,50S77607300000003', code: '776', label: 'OPŁATA ZA PRZELEW' }),
  // 3 — ZUS
  ...mbankTx({
    line61: '2609150915D4321,10S15307300000004', code: '153', label: 'PRZELEW ZEWNĘTRZNY DO ZUS',
    title: chunks27('DEKLARACJA: DRA 01.08.2026 R OKRES SIERPIEŃ'), account: ZUS_ACC,
    name: chunks27('ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH'),
  }),
  // 4 — przelew podatkowy
  ...mbankTx({
    line61: '2609200920D987,00S21007300000005', code: '210', label: 'PRZELEW PODATKOWY',
    title: ['N5210000000 26M08 PIT-4'], account: TAX_ACC, name: ['URZĄD SKARBOWY'],
  }),
  // 5 — natychmiastowa transakcja walutowa: wszystkie subpola puste
  ...mbankTx({ line61: '2609210921D5000,00SA6007300000006', code: 'A60', label: 'OBCIĄŻ. NATYCH. TRANSAK' }),
  // 6 — wynagrodzenie (przelew wewnętrzny)
  ...mbankTx({
    line61: '2609300930D6100,00S16907300000007', code: '169', label: 'PRZELEW WEWNĘTRZNY WYCH',
    title: chunks27('WYNAGRODZENIE 9/2026+PREMIA UZNANIOWA'), account: EMPLOYEE_ACC, name: ['JAN TESTOWY'],
  }),
  // 7 — BLIK (kod operacji z literą)
  ...mbankTx({
    line61: '2609300930D140,64SC2207300000008', code: 'C22', label: 'BLIK ZAKUP E-COMMERCE',
    title: ['SKLEP-PRZYKLAD.PL'],
  }),
  // 8 — wpływ od klienta
  ...mbankTx({
    line61: '2609300930C2460,00S15007300000009', code: '150', label: 'PRZELEW ZEWNĘTRZNY PRZYCH',
    title: ['ZAPLATA ZA FV 12/09/2026'], account: '15109010140000071200005555', name: ['KLIENT TESTOWY SP. Z O.O.'],
  }),
  ':62F:C260930PLN8123,45',
]
// Realny układ: UTF-8 z BOM, CRLF, plik kończy się na :62F: (bez linii „-")
const MBANK = '﻿' + MBANK_LINES.join('\r\n')

const SEPARATOR_MARKUP = /[~?<^]\d{2}/

// ── mBank: dwa pola :86: ──────────────────────────────────────────────────────

test('mBank: drugie pole :86: nie ginie — przelew z IBAN-em i nazwą w dwóch kawałkach', () => {
  const { transactions } = parseMT940Statements(MBANK)
  assert.equal(transactions.length, 9, 'jedna transakcja na linię :61:')

  const tx = transactions[0]
  assert.equal(tx.date, '2026-09-01')
  assert.equal(tx.amount, -1230)
  assert.equal(tx.is_reversal, false)
  assert.equal(tx.description, 'FAKTURA FV/2026/09/0015')
  // kawałek 27-znakowy sklejony bezpośrednio z następnym: „…ELEKT" + „RYCZNA…"
  assert.equal(tx.counterparty, 'PRZYKLADOWA HURTOWNIA ELEKTRYCZNA SP. Z O.O.')
  assert.equal(tx.counterparty_iban, `PL${SUPPLIER_ACC}`)
  assert.equal(tx.counterparty_address, 'UL. TESTOWA 1 00-001 WARSZAWA')
  assert.equal(tx.op_code, '152')
  assert.equal(tx.op_label, 'PRZELEW ZEWNĘTRZNY WYCH')
  assert.equal(tx.reference, '07300000001', 'mBank: referencja banku po kodzie typu, bez „//"')
  assert.equal(tx.currency, 'PLN')
  assert.equal(tx.account, OWN_ACCOUNT)
  assert.equal(tx.legacy_description, '152', 'stary parser kończył na drugim :86: — zostawał sam kod operacji')
  assert.ok(tx.raw?.startsWith('152\n152~00B152PRZELEW'), 'raw = surowa treść obu pól :86:')
})

test('mBank: tytuł zakupu kartą — słowo przecięte między kawałkami i dopełnienie spacjami', () => {
  const tx = parseMT940(MBANK)[1]
  assert.equal(tx.description, 'SKLEP BUDOWLANY KAS/WARSZAWA DATA TRANSAKCJI: 2026-09-01')
  assert.equal(tx.counterparty, '', 'karta nie ma kontrahenta — nigdy nie wstawiamy kodu operacji')
  assert.equal(tx.counterparty_iban, '', 'samo „PL" w subpolu 38 to brak rachunku')
  assert.equal(tx.op_code, '114')
  assert.equal(tx.op_label, 'ZAKUP PRZY UŻYCIU KARTY')
  assert.equal(tx.amount, -349.99)
})

test('mBank: opłata bez tytułu i transakcja A60 bez żadnej treści subpól', () => {
  const txs = parseMT940(MBANK)
  const fee = txs[2]
  assert.equal(fee.description, '')
  assert.equal(fee.counterparty, '')
  assert.equal(fee.counterparty_iban, '')
  assert.equal(fee.counterparty_address, '')
  assert.equal(fee.op_code, '776')
  assert.equal(fee.op_label, 'OPŁATA ZA PRZELEW')
  assert.equal(fee.amount, -2.5)
  assert.equal(fee.legacy_description, '776')

  const fx = txs[5]
  assert.equal(fx.description, '')
  assert.equal(fx.counterparty, '')
  assert.equal(fx.counterparty_iban, '')
  assert.equal(fx.op_code, 'A60')
  assert.equal(fx.op_label, 'OBCIĄŻ. NATYCH. TRANSAK')
  assert.equal(fx.reference, '07300000006')
  assert.equal(fx.legacy_description, 'A60')
})

test('mBank: przelew do ZUS i przelew podatkowy', () => {
  const txs = parseMT940(MBANK)
  const zus = txs[3]
  assert.equal(zus.description, 'DEKLARACJA: DRA 01.08.2026 R OKRES SIERPIEŃ')
  assert.equal(zus.counterparty, 'ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH')
  assert.equal(zus.counterparty_iban, `PL${ZUS_ACC}`)
  assert.equal(zus.op_code, '153')
  assert.equal(zus.op_label, 'PRZELEW ZEWNĘTRZNY DO Z', 'etykieta ucięta przez bank do 27 znaków razem z „B<kod>"')
  assert.equal(zus.amount, -4321.1)

  const tax = txs[4]
  assert.equal(tax.description, 'N5210000000 26M08 PIT-4')
  assert.equal(tax.counterparty, 'URZĄD SKARBOWY')
  assert.equal(tax.counterparty_iban, `PL${TAX_ACC}`)
  assert.equal(tax.op_code, '210')
  assert.equal(tax.op_label, 'PRZELEW PODATKOWY')
})

test('mBank: wynagrodzenie, BLIK (kod z literą) i wpływ', () => {
  const txs = parseMT940(MBANK)
  assert.equal(txs[6].description, 'WYNAGRODZENIE 9/2026+PREMIA UZNANIOWA')
  assert.equal(txs[6].counterparty, 'JAN TESTOWY')
  assert.equal(txs[6].counterparty_iban, `PL${EMPLOYEE_ACC}`)
  assert.equal(txs[6].op_code, '169')

  assert.equal(txs[7].description, 'SKLEP-PRZYKLAD.PL')
  assert.equal(txs[7].op_code, 'C22')
  assert.equal(txs[7].op_label, 'BLIK ZAKUP E-COMMERCE')
  assert.equal(txs[7].amount, -140.64)
  assert.equal(txs[7].legacy_description, 'C22')

  assert.equal(txs[8].amount, 2460)
  assert.equal(txs[8].counterparty, 'KLIENT TESTOWY SP. Z O.O.')
  assert.equal(txs[8].op_code, '150')
})

test('mBank: opis i kontrahent nigdy nie zawierają znaczników subpól ani kodu operacji', () => {
  const txs = parseMT940(MBANK)
  for (const tx of txs) {
    assert.ok(!SEPARATOR_MARKUP.test(tx.description), `znacznik subpola w opisie: ${tx.description}`)
    assert.ok(!tx.description.includes('~'))
    assert.ok(!tx.counterparty.includes('~'))
    assert.notEqual(tx.counterparty, tx.op_code)
    assert.notEqual(tx.description, tx.op_code)
    assert.equal(tx.legacy_description, tx.op_code, 'opis sprzed poprawki = sam kod operacji')
    assert.ok(tx.reference, 'każda transakcja mBanku ma referencję')
  }
  assert.equal(new Set(txs.map(t => t.reference)).size, txs.length, 'referencje unikalne')
})

test('mBank: BOM + CRLF, plik bez końcowego „-" — salda i rachunek bez zmian', () => {
  const { transactions, balances } = parseMT940Statements(MBANK)
  assert.deepEqual(balances, [{
    account: OWN_ACCOUNT, currency: 'PLN', date: '2026-09-30',
    opening: 10552.99, closing: 8123.45, statement_no: '00009/001',
  }])
  // ten sam plik z LF, bez BOM i z linią „-" daje identyczny wynik
  const plain = [...MBANK_LINES, '-'].join('\n')
  assert.deepEqual(parseMT940Statements(plain), { transactions, balances })
  // ostatnia transakcja nie „połyka" salda zamknięcia
  assert.ok(!transactions[8].raw?.includes(':62F:'))
  assert.equal(transactions[8].counterparty_address, '')
})

test('mBank: IBAN z subpola 29, gdy 38 to sam prefiks; „PLPL…" w 38 naprawione; 29 bez rachunku to kawałek tytułu', () => {
  const head = [':20:X', `:25:/${OWN_ACCOUNT}`, ':60F:C260901PLN100,00']
  const only29 = parseMT940([
    ...head,
    ':61:2609010901D10,00S15207300000010', ':86:152',
    `:86:152~00B152PRZELEW~20TYTUL~29${SUPPLIER_ACC}~32ODBIORCA TESTOWY~38PL`,
  ].join('\n'))[0]
  assert.equal(only29.counterparty_iban, `PL${SUPPLIER_ACC}`)
  assert.equal(only29.description, 'TYTUL')

  // ~29 ma już prefiks kraju, a bank dokleja „PL" jeszcze raz w ~38
  const doubled = parseMT940([
    ...head,
    ':61:2609010901D10,00S34007300000011', ':86:340',
    `:86:340~00B340PRZELEW SEPA WYCHODZĄCY~20INVOICE 77~29PL${SUPPLIER_ACC}~32ODBIORCA~38PLPL${SUPPLIER_ACC}`,
  ].join('\n'))[0]
  assert.equal(doubled.counterparty_iban, `PL${SUPPLIER_ACC}`)
  assert.equal(doubled.description, 'INVOICE 77', 'rachunek z ~29 nie trafia do tytułu')

  const foreign = parseMT940([
    ...head,
    ':61:2609010901D10,00S34007300000012', ':86:340',
    ':86:340~00B340PRZELEW SEPA WYCHODZĄCY~20INVOICE 78~29DE89370400440532013000~32MUSTER GMBH~38PLDE89370400440532013000',
  ].join('\n'))[0]
  assert.equal(foreign.counterparty_iban, 'DE89370400440532013000')

  const title29 = parseMT940([
    ...head,
    ':61:2609010901D10,00NTRFNONREF//T29',
    ':86:020~00PRZELEW~20POCZATEK~29DALSZY CIAG TYTULU~32ODBIORCA',
  ].join('\n'))[0]
  assert.equal(title29.description, 'POCZATEK DALSZY CIAG TYTULU')
  assert.equal(title29.counterparty_iban, '')
})

// ── Treść strukturalna innych banków ──────────────────────────────────────────

test('styl ING: treść strukturalna w jednej linii, krótkie kawałki łączone spacją', () => {
  const raw86 = '020~00PRZELEW~20TYTUL CZ1~21CZ2~32NAZWA KONTRAHENTA~33SP. Z O.O.~38PL27 1050 0000 1234 5678 9012 3456'
  const tx = parseMT940([
    ':20:ING1', ':25:/PL60105000001111222233334444', ':28C:5', ':60F:C260901PLN1000,00',
    ':61:2609020902D500,00NTRFNONREF//ING0001',
    `:86:${raw86}`,
    ':62F:C260902PLN500,00', '-',
  ].join('\r\n'))[0]
  assert.equal(tx.description, 'TYTUL CZ1 CZ2')
  assert.equal(tx.counterparty, 'NAZWA KONTRAHENTA SP. Z O.O.')
  assert.equal(tx.counterparty_iban, 'PL27105000001234567890123456', 'IBAN bez spacji')
  assert.equal(tx.op_code, '020')
  assert.equal(tx.op_label, 'PRZELEW')
  assert.equal(tx.reference, 'ING0001')
  assert.equal(tx.legacy_description, raw86, 'stary parser zwracał surową treść ze znacznikami')
  assert.ok(!SEPARATOR_MARKUP.test(tx.description))
})

test('treść strukturalna: powtórzone subpole, linia kontynuacji bez separatora, brak kodu operacji', () => {
  const txs = parseMT940([
    ':20:S1', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    // powtórzone ~20 + linia kontynuacji należąca do ~21 (sklejana bez spacji)
    ':61:2609020902D1,00NTRFNONREF//A1',
    ':86:020~00PRZELEW~20PIERWSZA~20DRUGA~21FAKTURA NR 12',
    '3/2026~32ODBIORCA',
    // bez kodu operacji (same subpola)
    ':61:2609020902C2,00NTRFNONREF//A2',
    ':86:~20Zaplata za FV 5/2026~32KLIENT SP Z OO',
    ':62F:C260902PLN1001,00',
  ].join('\n'))
  assert.equal(txs[0].description, 'PIERWSZA DRUGA FAKTURA NR 123/2026')
  assert.equal(txs[0].counterparty, 'ODBIORCA')
  assert.equal(txs[1].description, 'Zaplata za FV 5/2026')
  assert.equal(txs[1].counterparty, 'KLIENT SP Z OO')
  assert.equal(txs[1].op_code, '')
  assert.equal(txs[1].op_label, '')
  assert.equal(txs[1].legacy_description, '~20Zaplata za FV 5/2026~32KLIENT SP Z OO')
})

test('separator „?" (styl SWIFT/niemiecki): subpola łamane między liniami, IBAN z subpola 31', () => {
  const tx = parseMT940([
    ':20:DE1', ':25:10020030/1234567890', ':28C:00001/001', ':60F:C260901EUR1000,00',
    ':61:2609030903C1500,00NTRFKREF123//BANKREF9',
    ':86:166?00GUTSCHRIFT?109075?20EREF+RE-2026-0042?21SVWZ+RECHN',
    'UNG 42?30TESTDEFFXXX?31DE89370400440532013000?32MUSTER GMBH?33BERLIN',
    ':62F:C260903EUR2500,00',
    '-',
  ].join('\n'))[0]
  assert.equal(tx.op_code, '166')
  assert.equal(tx.op_label, 'GUTSCHRIFT')
  assert.equal(tx.description, 'EREF+RE-2026-0042 SVWZ+RECHNUNG 42')
  assert.equal(tx.counterparty, 'MUSTER GMBH BERLIN')
  assert.equal(tx.counterparty_iban, 'DE89370400440532013000')
  assert.equal(tx.reference, 'BANKREF9', 'referencja banku po „//" ma pierwszeństwo')
  assert.equal(tx.currency, 'EUR')
  assert.equal(tx.amount, 1500)
  assert.equal(
    tx.legacy_description,
    '166?00GUTSCHRIFT?109075?20EREF+RE-2026-0042?21SVWZ+RECHN UNG 42?30TESTDEFFXXX?31DE89370400440532013000?32MUSTER GMBH?33BERLIN',
  )
  assert.ok(!SEPARATOR_MARKUP.test(tx.description))
})

test('separatory „<" i „^"', () => {
  const txs = parseMT940([
    ':20:X', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    ':61:2609040904D10,00NTRFNONREF//L1',
    ':86:020<00PRZELEW WYCHODZACY<20FV 1/09/2026<27<32DOSTAWCA TESTOWY<38PL27105000001234567890123456',
    ':61:2609040904D20,00NTRFNONREF//L2',
    ':86:051^00PRZELEW^20FV 2/09/2026^32INNY DOSTAWCA^3827105000001234567890123456',
    ':62F:C260904PLN970,00',
  ].join('\n'))
  assert.equal(txs[0].op_code, '020')
  assert.equal(txs[0].op_label, 'PRZELEW WYCHODZACY')
  assert.equal(txs[0].description, 'FV 1/09/2026')
  assert.equal(txs[0].counterparty, 'DOSTAWCA TESTOWY')
  assert.equal(txs[0].counterparty_iban, 'PL27105000001234567890123456')
  assert.equal(txs[1].op_code, '051')
  assert.equal(txs[1].description, 'FV 2/09/2026')
  assert.equal(txs[1].counterparty, 'INNY DOSTAWCA')
  assert.equal(txs[1].counterparty_iban, 'PL27105000001234567890123456', '26 cyfr NRB dostaje prefiks PL')
})

// ── Treść niestrukturalna ─────────────────────────────────────────────────────

test('treść niestrukturalna: /NAME/, IBAN z opisu, cały tekst jako opis', () => {
  const tx = parseMT940([
    ':20:U1', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    ':61:2609040904D99,99NTRFNONREF',
    ':86:/NAME/FIRMA TESTOWA SP Z OO/ACC/PL61109010140000071219812874',
    '/REMI/ZAPLATA ZA FV 7/2026',
    ':62F:C260904PLN900,01',
    '-',
  ].join('\n'))[0]
  assert.equal(tx.description, '/NAME/FIRMA TESTOWA SP Z OO/ACC/PL61109010140000071219812874 /REMI/ZAPLATA ZA FV 7/2026')
  assert.equal(tx.counterparty, 'FIRMA TESTOWA SP Z OO')
  assert.equal(tx.counterparty_iban, 'PL61109010140000071219812874')
  assert.equal(tx.op_code, '')
  assert.equal(tx.op_label, '')
  assert.equal(tx.reference, '', 'NONREF bez „//" = brak referencji')
  assert.equal(tx.legacy_description, tx.description, 'pojedyncze pole niestrukturalne — opis jak przed poprawką')
})

test('treść niestrukturalna: kilka pól :86: łączonych w jeden opis, heurystyka pierwszej linii', () => {
  const txs = parseMT940([
    ':20:U2', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    ':61:2609040904D50,00NTRFNONREF//U21',
    ':86:DOSTAWCA PRZYKLADOWY',
    'UL. DLUGA 5',
    ':86:ZAPLATA ZA FV 9/2026',
    ':61:2609040904D60,00NTRFNONREF//U22',
    ':86:Tytułem: czynsz wrzesien',
    ':61:2609040904D70,00NTRFNONREF//U23',
    ':86:/ACC/de89 3704 0044',
    ':62F:C260904PLN820,00',
  ].join('\n'))
  assert.equal(txs[0].description, 'DOSTAWCA PRZYKLADOWY UL. DLUGA 5 ZAPLATA ZA FV 9/2026')
  assert.equal(txs[0].counterparty, 'DOSTAWCA PRZYKLADOWY')
  assert.equal(txs[0].legacy_description, 'DOSTAWCA PRZYKLADOWY UL. DLUGA 5', 'stary parser widział tylko pierwsze :86:')
  assert.equal(txs[1].counterparty, '', 'etykieta „Tytułem:" to nie kontrahent')
  assert.equal(txs[1].description, 'Tytułem: czynsz wrzesien')
  assert.equal(txs[2].counterparty, '')
  assert.equal(txs[2].counterparty_iban, 'DE89', '/ACC/ do pierwszej spacji, wielkie litery')
})

test('treść niestrukturalna: samotny kod operacji nigdy nie jest kontrahentem', () => {
  const txs = parseMT940([
    ':20:U3', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    ':61:2609040904D1,00NTRFNONREF//U31',
    ':86:152',
    ':61:2609040904D2,00NTRFNONREF//U32',
    ':86:C22',
    ':86:JAKIS WOLNY TEKST',
    ':61:2609040904D3,00NTRFNONREF//U33',
    ':86:TRF',
    ':86:INNY WOLNY TEKST',
    ':61:2609040904D4,00NTRFNONREF//U34',
    ':86:ABC',
    'FAKTURA 1/2026',
    ':62F:C260904PLN990,00',
  ].join('\n'))
  assert.equal(txs[0].counterparty, '')
  assert.equal(txs[0].description, '152')
  assert.equal(txs[0].op_code, '', 'treść niestrukturalna — bez kodu operacji')
  assert.equal(txs[1].counterparty, '')
  assert.equal(txs[1].description, 'C22 JAKIS WOLNY TEKST')
  assert.equal(txs[1].legacy_description, 'C22')
  assert.equal(txs[2].counterparty, '', 'kod literowy też nie jest kontrahentem')
  assert.equal(txs[2].description, 'TRF INNY WOLNY TEKST')
  assert.equal(txs[3].counterparty, '', 'kod w pierwszej linii, tekst w liniach kontynuacji')
  assert.equal(txs[3].description, 'ABC FAKTURA 1/2026')
})

// ── Linia :61: ────────────────────────────────────────────────────────────────

test(':61: — RC i RD (storna), litera waluty „CR"/„DR", brak daty księgowania', () => {
  const txs = parseMT940([
    ':20:R1', ':25:/PL60105000001111222233334444', ':60F:C260901EUR1000,00',
    ':61:2609050905RC100,00NTRFNONREF//R1', ':86:storno uznania',
    ':61:2609050905RD250,00NTRFNONREF//R2', ':86:storno obciazenia',
    ':61:2609050905CR1000,00NTRFNONREF//R3', ':86:uznanie EUR',
    ':61:2609050905DR40,00NTRFNONREF//R4', ':86:obciazenie EUR',
    ':61:260905D12,5NTRFNONREF//R5', ':86:bez daty ksiegowania',
    ':61:2609050905RDR7,00NTRFNONREF//R6', ':86:storno obciazenia z litera waluty',
    ':61:2609050905C15,NTRFNONREF//R7', ':86:kwota bez groszy',
    ':61:2609050905D3.75NTRFNONREF//R8', ':86:kropka dziesietna (poza standardem)',
    ':62F:C260905EUR2000,00',
  ].join('\n'))
  assert.equal(txs.length, 8)
  assert.deepEqual(txs.map(t => t.amount), [-100, 250, 1000, -40, -12.5, 7, 15, -3.75])
  assert.deepEqual(txs.map(t => t.is_reversal), [true, true, false, false, false, true, false, false])
  assert.deepEqual(txs.map(t => t.reference), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'])
  assert.deepEqual(txs.map(t => t.date), Array(8).fill('2026-09-05'))
  assert.equal(txs[2].description, 'uznanie EUR')
})

test(':61: — referencja: po „//", referencja klienta, NONREF / NOTPROVIDED / pusta, limit 100 znaków', () => {
  const long = 'X'.repeat(150)
  const txs = parseMT940([
    ':20:F1', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    ':61:2609060906D1,00NTRFKLIENT1//BANK1', ':86:a',
    ':61:2609060906D2,00NTRFKLIENT2', ':86:b',
    ':61:2609060906D3,00NTRFNONREF', ':86:c',
    ':61:2609060906D4,00NTRFNONREF//NONREF', ':86:d',
    ':61:2609060906D5,00NTRFKLIENT5//NOTPROVIDED', ':86:e',
    ':61:2609060906D6,00NTRF', ':86:f',
    ':61:2609060906D7,00S15207312345678', ':86:g',
    `:61:2609060906D8,00NTRFNONREF//${long}`, ':86:h',
    ':61:2609060906D9,00NTRFnonref// BANK9 ', ':86:i',
    ':62F:C260906PLN955,00',
  ].join('\n'))
  assert.deepEqual(txs.map(t => t.reference), [
    'BANK1', 'KLIENT2', '', '', 'KLIENT5', '', '07312345678', 'X'.repeat(100), 'BANK9',
  ])
})

test(':61: — transakcja bez :86:, linia dodatkowych szczegółów po :61:, nieparsowalna :61:', () => {
  const txs = parseMT940([
    ':20:N1', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    ':61:2609070907D10,00NTRFABC123',
    ':61:2609070907D20,00NTRFNONREF//BANK2',
    'DODATKOWE SZCZEGOLY TRANSAKCJI',
    ':86:tytul drugiej',
    ':61:to nie jest transakcja',
    ':61:2609070907C30,00NTRFNONREF//BANK3',
    ':62F:C260907PLN1000,00',
    ':86:informacja do salda, nie do transakcji',
  ].join('\n'))
  assert.equal(txs.length, 3)
  assert.equal(txs[0].description, '')
  assert.equal(txs[0].counterparty, '')
  assert.equal(txs[0].counterparty_iban, '')
  assert.equal(txs[0].op_code, '')
  assert.equal(txs[0].raw, '')
  assert.equal(txs[0].legacy_description, '')
  assert.equal(txs[0].reference, 'ABC123')

  assert.equal(txs[1].description, 'tytul drugiej', 'linia kontynuacji :61: nie trafia do opisu')
  assert.equal(txs[1].legacy_description, 'tytul drugiej')

  assert.equal(txs[2].amount, 30)
  assert.equal(txs[2].description, '', ':86: po saldzie zamknięcia nie należy do transakcji')
})

// ── Wiele wyciągów, koperta SWIFT, limit raw ─────────────────────────────────

test('dwa wyciągi w jednym pliku: rachunek i waluta transakcji z własnego wyciągu', () => {
  const second = [
    ':20:MT940',
    ':25:/PL22114020040000300287654321',
    ':28C:00003/001',
    ':60F:C260901EUR500,00',
    ...mbankTx({
      line61: '2609100910D120,00S15207300000020', code: '152', label: 'PRZELEW ZEWNĘTRZNY WYCH',
      title: ['INVOICE 2026-118'], account: SUPPLIER_ACC, name: ['DOSTAWCA TESTOWY'],
    }),
    ':62F:C260910EUR380,00',
  ]
  const { transactions, balances } = parseMT940Statements([...MBANK_LINES, ...second].join('\r\n'))
  assert.equal(transactions.length, 10)
  assert.equal(balances.length, 2)
  assert.equal(transactions[8].account, OWN_ACCOUNT)
  assert.equal(transactions[8].currency, 'PLN')
  assert.equal(transactions[8].counterparty, 'KLIENT TESTOWY SP. Z O.O.', 'ostatnia transakcja 1. wyciągu nie miesza się z nagłówkiem 2.')
  assert.equal(transactions[9].account, 'PL22114020040000300287654321')
  assert.equal(transactions[9].currency, 'EUR')
  assert.equal(transactions[9].description, 'INVOICE 2026-118')
  assert.equal(transactions[9].counterparty, 'DOSTAWCA TESTOWY')
  assert.deepEqual(balances[1], {
    account: 'PL22114020040000300287654321', currency: 'EUR', date: '2026-09-10',
    opening: 500, closing: 380, statement_no: '00003/001',
  })
})

test('koperta SWIFT („-}" / „{1:…") i limit 2000 znaków w raw', () => {
  const longText = 'A'.repeat(70)
  const txs = parseMT940([
    '{1:F01TESTPLPWAXXX0000000000}{2:I940TESTPLPWXXXXN}{4:',
    ':20:E1', ':25:/PL60105000001111222233334444', ':60F:C260901PLN1000,00',
    ':61:2609080908D10,00NTRFNONREF//E1',
    ':86:pierwsza transakcja',
    '-}',
    '{1:F01TESTPLPWAXXX0000000000}{2:I940TESTPLPWXXXXN}{4:',
    ':20:E2', ':25:/PL60105000001111222233334444', ':60F:C260901PLN990,00',
    ':61:2609080908D20,00NTRFNONREF//E2',
    ':86:druga transakcja',
    ...Array(40).fill(longText),
    ':62F:C260908PLN970,00',
    '-}',
  ].join('\n'))
  assert.equal(txs.length, 2)
  assert.equal(txs[0].description, 'pierwsza transakcja', 'znacznik końca komunikatu nie trafia do opisu')
  assert.ok(txs[1].description.startsWith('druga transakcja AAAA'))
  assert.equal(txs[1].raw?.length, 2000)
})
