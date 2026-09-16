/**
 * Parser MT940: wiele wyciągów w jednym pliku, salda otwarcia/zamknięcia (:60F/:60M/:62F/:62M),
 * saldo debetowe (D = ujemne), normalizacja rachunku z :25:, zgodność wsteczna parseMT940.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/mt940-balances.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMT940, parseMT940Statements, normalizeAccount, parseBalanceField } from '../utils/mt940Parser'

// Fixture w stylu mBank: 3 bloki (:20:), drugi wyciąg podzielony na 2 strony (:62M: / :60M:)
const MBANK_FIXTURE = [
  ':20:ST240115',
  ':25:/PL27114020040000390234567890',
  ':28C:00012/001',
  ':60F:C240114PLN15234,56',
  ':61:2401150115D1000,00NTRFNONREF//8734501',
  ':86:~00~20Faktura FV/2024/01/12~21skladki~22~23~24~25~26~27~28~29~30114000~31PL27114020040000390211111111~32ZAKLAD UBEZPIECZEN~33SPOLECZNYCH~34~38PL12345678901234567890123456~62~63',
  ':61:2401150115C2500,00NTRFNONREF//8734502',
  ':86:~20Zaplata za FV 5/2024~32KLIENT SP Z OO',
  ':62F:C240115PLN16734,56',
  '-',
  ':20:ST240116',
  ':25:/PL27114020040000390234567890',
  ':28C:00013/001',
  ':60F:C240115PLN16734,56',
  ':61:2401160116D20000,00NTRFNONREF//8734600',
  ':86:~20Wynagrodzenie styczen~32JAN KOWALSKI',
  ':62M:D240116PLN3265,44',
  '-',
  ':20:ST240116',
  ':25:/PL27114020040000390234567890',
  ':28C:00013/002',
  ':60M:D240116PLN3265,44',
  ':61:2401160116D500,00NTRFNONREF//8734601',
  ':86:~20Oplata za prowadzenie rachunku~32MBANK',
  ':62F:D240116PLN3765,44',
  '-',
].join('\r\n')

test('parseMT940Statements: salda każdego wyciągu z pliku wielowyciągowego', () => {
  const { balances } = parseMT940Statements(MBANK_FIXTURE)
  assert.equal(balances.length, 3)

  assert.deepEqual(balances[0], {
    account: 'PL27114020040000390234567890',
    currency: 'PLN',
    date: '2024-01-15',
    opening: 15234.56,
    closing: 16734.56,
    statement_no: '00012/001',
  })

  // strona 1 wyciągu 13: saldo zamknięcia pośrednie (:62M:) debetowe → ujemne
  assert.equal(balances[1].statement_no, '00013/001')
  assert.equal(balances[1].opening, 16734.56)
  assert.equal(balances[1].closing, -3265.44)
  assert.equal(balances[1].date, '2024-01-16')

  // strona 2: otwarcie z :60M: (debetowe), zamknięcie :62F: debetowe
  assert.equal(balances[2].statement_no, '00013/002')
  assert.equal(balances[2].opening, -3265.44)
  assert.equal(balances[2].closing, -3765.44)
})

test('parseMT940Statements: transakcje dostają rachunek i walutę wyciągu', () => {
  const { transactions } = parseMT940Statements(MBANK_FIXTURE)
  assert.equal(transactions.length, 4)
  assert.deepEqual(transactions.map(t => t.amount), [-1000, 2500, -20000, -500])
  assert.deepEqual(transactions.map(t => t.date), ['2024-01-15', '2024-01-15', '2024-01-16', '2024-01-16'])
  for (const t of transactions) {
    assert.equal(t.account, 'PL27114020040000390234567890')
    assert.equal(t.currency, 'PLN')
    assert.equal(t.is_reversal, false)
  }
  assert.equal(transactions[0].reference, '8734501')
  assert.ok(transactions[0].description.includes('~32ZAKLAD UBEZPIECZEN'), 'surowe subpola ~NN zostają (czyści je cleanMt940Fields)')
  // „-" (koniec komunikatu SWIFT) nie trafia do opisu
  assert.ok(!transactions[3].description.endsWith('-'))
})

test('parseMT940: zgodność wsteczna — same transakcje', () => {
  const legacy = parseMT940(MBANK_FIXTURE)
  const modern = parseMT940Statements(MBANK_FIXTURE).transactions
  assert.equal(legacy.length, 4)
  assert.deepEqual(legacy, modern)
})

test('parseMT940Statements: plik bez :20: (jeden blok), waluta EUR, storno RD', () => {
  const content = [
    ':25:PL61109010140000071219812874EUR',
    ':28C:7',
    ':60F:C240301EUR1000,00',
    ':61:2403050305D250,00NTRFNONREF//X1',
    ':86:~20Adobe subscription~32ADOBE SYSTEMS',
    ':61:2403060306RD250,00NTRFNONREF//X2',
    ':86:~20Zwrot~32ADOBE SYSTEMS',
    ':62F:C240306EUR1000,00',
  ].join('\n')
  const { transactions, balances } = parseMT940Statements(content)
  assert.equal(balances.length, 1)
  assert.equal(balances[0].account, 'PL61109010140000071219812874EUR')
  assert.equal(balances[0].currency, 'EUR')
  assert.equal(balances[0].statement_no, '7')
  assert.equal(balances[0].opening, 1000)
  assert.equal(balances[0].closing, 1000)
  assert.equal(transactions.length, 2)
  assert.equal(transactions[0].currency, 'EUR')
  assert.equal(transactions[1].is_reversal, true)
  assert.equal(transactions[1].amount, 250) // RD = środki wracają
})

test('parseMT940Statements: brak :62: → brak salda, transakcje nadal parsowane', () => {
  const content = [':20:X', ':25:/PL1', ':61:2401150115D10,00NTRF//R', ':86:test'].join('\n')
  const { transactions, balances } = parseMT940Statements(content)
  assert.equal(balances.length, 0)
  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].currency, 'PLN') // domyślna waluta
})

test('normalizeAccount: bez „/", spacji i myślników, wielkie litery', () => {
  assert.equal(normalizeAccount('/PL27 1140 2004 0000 3902 3456 7890'), 'PL27114020040000390234567890')
  assert.equal(normalizeAccount('pl27-1140'), 'PL271140')
  assert.equal(normalizeAccount('  //12345 '), '12345')
  assert.equal(normalizeAccount(''), '')
})

test('parseBalanceField: C dodatnie, D ujemne, błędny format → null', () => {
  assert.deepEqual(parseBalanceField('C240114PLN15234,56'), { date: '2024-01-14', currency: 'PLN', amount: 15234.56 })
  assert.deepEqual(parseBalanceField('D240116PLN3765,44'), { date: '2024-01-16', currency: 'PLN', amount: -3765.44 })
  assert.equal(parseBalanceField('240116PLN1,00'), null)
  assert.equal(parseBalanceField(''), null)
})
