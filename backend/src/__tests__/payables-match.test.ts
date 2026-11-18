/**
 * Płatności — kiedy przelew może AUTOMATYCZNIE oznaczyć fakturę jako opłaconą (services/payment-match) i które
 * wcześniejsze automatyczne dopasowania trzeba cofnąć (routes/payables: invalidAutoMatches).
 *
 * Tło: po naprawie importu wyciągów przelewy dostały tytuły i kontrahentów, a dawna reguła punktowa
 * („kwota ±2 % + kontrahent") zaczęła oznaczać jako opłacone SĄSIEDNIE faktury tego samego dostawcy:
 * przelew za fakturę sierpniową (już oznaczoną ręcznie) „opłacał" październikową o zbliżonej kwocie.
 * Dane syntetyczne (zmyślone firmy, NIP-y i numery).
 *
 * Uruchomienie: cd backend && DATABASE_URL="postgresql://x:x@localhost:1/x" npx tsx --test src/__tests__/payables-match.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideAutoMatch, titleNamesInvoice, titleNamesDifferentNumber, sellerMatchesTransfer, amountEquals,
  payableCandidates, canonTokens, invoiceReferenceText, distinctiveNameTokens,
} from '../services/payment-match'
import { scoreMatch, invalidAutoMatches } from '../routes/payables'

const SELLER = { seller_name: 'Chmurex Dorota Testowa', seller_nip: '8160000001' }
const inv = (id: string, invoice_number: string, gross_amount: number, invoice_date: string, extra: Record<string, unknown> = {}) =>
  ({ id, invoice_number, gross_amount, invoice_date, payment_status: 'unpaid', payment_source: null, bank_tx_id: null, ...SELLER, ...extra })
const transfer = (amount: number, date: string, description: string, counterparty = 'CHMUREX DOROTA TESTOWA', extra: Record<string, unknown> = {}) =>
  ({ id: `tx-${date}-${amount}`, amount: -amount, transaction_date: date, description, counterparty, ...extra })
const split = (amount: number, date: string, invoiceNumber: string) =>
  transfer(amount, date, `/VAT/5029,60/IDC/8160000001/INV/${invoiceNumber}/TXT/PRZELEW ŚRODKÓW`)

// Abonament: co miesiąc faktura „2/MM/2026" na zbliżoną kwotę i „5/MM/2026" na 1 230 zł
const subscription = () => [
  inv('i08', '2/08/2026', 26822.35, '2026-08-03', { payment_status: 'paid', payment_source: 'manual' }),
  inv('i09', '2/09/2026', 26897.42, '2026-09-03', { payment_status: 'paid', payment_source: 'manual' }),
  inv('i10', '2/10/2026', 26793.59, '2026-10-02'),
  inv('i11', '2/11/2026', 26919.75, '2026-11-04'),
  inv('s08', '5/08/2026', 1230, '2026-08-03'),
  inv('s09', '5/09/2026', 1230, '2026-09-03'),
  inv('s10', '5/10/2026', 1230, '2026-10-02'),
]

// ── Scenariusz z produkcji ────────────────────────────────────────────────────

test('przelew za fakturę JUŻ oznaczoną jako opłacona tylko się z nią wiąże — nie „opłaca" sąsiedniej o zbliżonej kwocie', () => {
  const invoices = subscription()
  // 3.10: 26 822,35 zł, tytuł „2/08/2026" — faktura sierpniowa była oznaczona ręcznie; październikowa (26 793,59) NIE jest opłacona
  const a = decideAutoMatch(transfer(26822.35, '2026-10-03', '2/08/2026'), invoices)
  assert.equal(a.action, 'link')
  assert.equal(a.action === 'link' && a.invoice.id, 'i08')
  // 6.10: split payment z numerem faktury w polu /INV/
  const b = decideAutoMatch(split(26897.42, '2026-10-06', '2/09/2026'), invoices)
  assert.equal(b.action, 'link')
  assert.equal(b.action === 'link' && b.invoice.id, 'i09')
  // żadna z tych decyzji nie zmienia statusu faktury październikowej ani listopadowej
  assert.ok(invoices.filter(i => i.id === 'i10' || i.id === 'i11').every(i => i.payment_status === 'unpaid'))
})

test('rata za POPRZEDNI miesiąc nie opłaca faktury za następny, choć kwota jest identyczna', () => {
  const lease = { seller_name: 'Autoleasing Testowy Financial Services Polska Sp. z o.o.', seller_nip: '5270000002' }
  const oct = { ...inv('oct', '146161/1026/RM', 6463.95, '2026-10-02', { payment_status: 'paid', payment_source: 'manual' }), ...lease }
  const nov = { ...inv('nov', '146531/1126/RM', 6463.95, '2026-11-03'), ...lease }
  const tx = transfer(6463.95, '2026-10-30', '146161/1026/RM', 'AUTOLEASING TESTOWY FINANCIAL SERVICES POLSKA SP Z O O')
  const d = decideAutoMatch(tx, [oct, nov])
  assert.equal(d.action, 'link')
  assert.equal(d.action === 'link' && d.invoice.id, 'oct')
  // faktury październikowej nie ma w systemie → tytuł i tak wskazuje INNĄ fakturę tej numeracji: nic automatycznie
  const alone = decideAutoMatch(tx, [nov])
  assert.equal(alone.action, 'none')
  assert.match(alone.action === 'none' ? alone.why : '', /inną fakturę/)
})

// ── Kwota: co do grosza, bez tolerancji ───────────────────────────────────────

test('kwota musi zgadzać się co do grosza — zbliżona kwota (prowizja, inna faktura) nigdy nie daje automatu', () => {
  const one = [inv('a', 'FS/211/02/2026', 21083.52, '2026-02-10')]
  assert.equal(decideAutoMatch(transfer(21083.52, '2026-02-23', 'zapłata'), one).action, 'pay')
  assert.equal(decideAutoMatch(transfer(21083.53, '2026-02-23', 'zapłata'), one).action, 'pay', 'różnica 1 gr = zaokrąglenie')
  assert.equal(decideAutoMatch(transfer(21083.54, '2026-02-23', 'zapłata'), one).action, 'none')
  assert.equal(decideAutoMatch(transfer(21072.45, '2026-02-23', 'zapłata'), one).action, 'none', '11 zł różnicy')
  assert.equal(decideAutoMatch(transfer(21000, '2026-02-23', 'zapłata'), one).action, 'none')
  // nawet z numerem faktury w tytule: inna kwota = płatność częściowa / błąd → decyduje człowiek
  const named = decideAutoMatch(split(20000, '2026-02-23', 'FS/211/02/2026'), one)
  assert.equal(named.action, 'none')
  assert.match(named.action === 'none' ? named.why : '', /kwota przelewu jest inna/)
  assert.equal(amountEquals({ amount: -1230 }, { id: 'x', gross_amount: 1230 }), true)
  assert.equal(amountEquals({ amount: -1230 }, { id: 'x', gross_amount: 0 }), false)
})

// ── Numer faktury w tytule ────────────────────────────────────────────────────

test('numer faktury w tytule wybiera właściwą z kilku faktur na tę samą kwotę; bez numeru — niejednoznaczne', () => {
  const invoices = subscription()
  const named = decideAutoMatch(transfer(1230, '2026-10-20', 'FV 5/09/2026'), invoices)
  assert.equal(named.action, 'pay')
  assert.equal(named.action === 'pay' && named.invoice.id, 's09')
  assert.deepEqual(named.action === 'pay' && named.reasons, ['kwota', 'nr faktury', 'kontrahent'])
  const bare = decideAutoMatch(transfer(1230, '2026-10-20', 'abonament'), invoices)
  assert.equal(bare.action, 'none')
  assert.match(bare.action === 'none' ? bare.why : '', /kilka faktur/)
  // tytuł wymienia dwie faktury (jeden przelew za dwa miesiące) → nie zgadujemy
  const two = decideAutoMatch(transfer(2460, '2026-10-20', '5/08/2026, 5/09/2026'), invoices)
  assert.equal(two.action, 'none')
  assert.match(two.action === 'none' ? two.why : '', /kilka faktur/)
})

test('titleNamesInvoice: cały numer, nie fragment innego; zera wiodące i separatory bez znaczenia', () => {
  assert.equal(titleNamesInvoice('/VAT/1,00/IDC/8160000001/INV/2/09/2026/TXT/PRZELEW', '2/09/2026'), true)
  assert.equal(titleNamesInvoice('2/08/2026', '2/08/2026'), true)
  assert.equal(titleNamesInvoice('zapłata za fv 2-9-2026', '2/09/2026'), true)
  assert.equal(titleNamesInvoice('FV2/09/2026', '2/09/2026'), true, 'litera przed numerem jest w porządku')
  assert.equal(titleNamesInvoice('12/09/2026', '2/09/2026'), false, 'to inna faktura (12/…)')
  assert.equal(titleNamesInvoice('2/09/20261', '2/09/2026'), false)
  assert.equal(titleNamesInvoice('2/10/2026', '2/09/2026'), false)
  assert.equal(titleNamesInvoice('146161/1026/RM', '146531/1126/RM'), false)
  assert.equal(titleNamesInvoice('faktura 12', '12'), false, 'za krótki numer niczego nie identyfikuje')
  assert.equal(titleNamesInvoice('', '2/09/2026'), false)
  assert.equal(canonTokens('FS-211/02/2026'), 'fs/211/2/2026')
  // data transakcji z płatności kartą nie jest numerem faktury
  assert.equal(invoiceReferenceText('SKLEP TESTOWY KASA 8/WARSZAWA DATA TRANSAKCJI: 2026-09-01'), 'SKLEP TESTOWY KASA 8/WARSZAWA')
  assert.equal(titleNamesInvoice('SKLEP TESTOWY/WARSZAWA DATA TRANSAKCJI: 2026-09-01', '2026/09/01'), false)
})

test('titleNamesDifferentNumber: ten sam układ numeracji, inne wartości → przelew dotyczy innej faktury', () => {
  assert.equal(titleNamesDifferentNumber('2/08/2026', '2/10/2026'), true)
  assert.equal(titleNamesDifferentNumber('146161/1026/RM', '146531/1126/RM'), true)
  assert.equal(titleNamesDifferentNumber('/VAT/1,00/IDC/8160000001/INV/FS/200/02/2026/TXT/x', 'FS/211/02/2026'), true)
  assert.equal(titleNamesDifferentNumber('2/10/2026', '2/10/2026'), false, 'to ten sam numer')
  assert.equal(titleNamesDifferentNumber('zapłata za zamówienie 4411', 'FS/211/02/2026'), false)
  assert.equal(titleNamesDifferentNumber('przelew 99999', '12345'), false, 'numer z jednego członu nie ma układu')
  assert.equal(titleNamesDifferentNumber('SKLEP/WARSZAWA DATA TRANSAKCJI: 2026-09-01', '12/09/2026'), false, 'stopka karty nie jest numerem')
})

// ── Kontrahent ────────────────────────────────────────────────────────────────

test('kontrahent: NIP w tytule albo pierwsze dwa wyróżniające człony nazwy — jedno ogólne słowo nie wystarcza', () => {
  const i = inv('a', 'FS/1/2026', 500, '2026-02-10')
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'zapłata'), i), true)
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'zapłata', 'CHMUREX SP Z O O'), i), false, 'tylko jeden z dwóch członów')
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', '/VAT/1,00/IDC/8160000001/INV/x/TXT/y', ''), i), true, 'NIP w split payment')
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'zapłata', 'INNA FIRMA DOROTA KOWALSKA'), i), false)
  const generic = { ...i, seller_name: 'Usługi Transportowe Jan Przykładowy', seller_nip: '' }
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'zapłata', 'USŁUGI BUDOWLANE ADAM INNY'), generic), false)
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'zapłata', 'USŁUGI TRANSPORTOWE JAN PRZYKŁADOWY'), generic), true)
  // formy prawne i ogólniki nie są członami wyróżniającymi
  assert.deepEqual(distinctiveNameTokens('Autoleasing Testowy Financial Services Polska Sp. z o.o.'), ['autoleasing', 'testowy'])
  assert.deepEqual(distinctiveNameTokens('Budomarket Polska S.A.'), ['budomarket'])
  // płatność kartą: sprzedawca w tytule, kontrahent pusty
  const shop = { ...i, seller_name: 'Budomarket Polska S.A.', seller_nip: '' }
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'BUDOMARKET KASA 8/WARSZAWA DATA TRANSAKCJI: 2026-02-19', ''), shop), true)
  // brak zgodnego kontrahenta → nigdy automat, nawet przy idealnej kwocie
  assert.equal(decideAutoMatch(transfer(500, '2026-02-20', 'przelew', 'KTOŚ INNY SP Z O O'), [i]).action, 'none')
  assert.equal(decideAutoMatch(transfer(500, '2026-02-20', 'przelew', ''), [i]).action, 'none')
})

// ── Jednoznaczność, daty, przebieg ────────────────────────────────────────────

test('bez numeru w tytule: automat tylko przy JEDNEJ fakturze na tę kwotę — licząc też opłacone ręcznie bez przelewu', () => {
  const unpaid = inv('u', 'FS/20/2026', 800, '2026-03-01')
  const paidManual = inv('p', 'FS/10/2026', 800, '2026-02-01', { payment_status: 'paid', payment_source: 'manual' })
  const tx = transfer(800, '2026-03-10', 'zapłata')
  // jedna nieopłacona → zapłata
  assert.equal(decideAutoMatch(tx, [unpaid]).action, 'pay')
  // obok jest faktura opłacona ręcznie, bez powiązanego przelewu — ten przelew mógł być JEJ zapłatą → nie zgadujemy
  assert.equal(decideAutoMatch(tx, [unpaid, paidManual]).action, 'none')
  // …chyba że ta opłacona ma już swój przelew
  assert.equal(decideAutoMatch(tx, [unpaid, { ...paidManual, bank_tx_id: 'tx-inny' }]).action, 'pay')
  assert.equal(decideAutoMatch(tx, [unpaid, paidManual], { linkedInvoiceIds: new Set(['p']) }).action, 'pay')
  // tylko opłacona ręcznie na tę kwotę → samo powiązanie (status faktury bez zmian)
  const link = decideAutoMatch(tx, [paidManual])
  assert.equal(link.action, 'link')
  assert.deepEqual(link.action === 'link' && link.reasons, ['kwota', 'kontrahent', 'faktura już opłacona'])
})

test('przelew nie opłaca faktury wystawionej później niż 14 dni po nim; uznanie nigdy nie jest płatnością', () => {
  const nov = inv('nov', 'FS/30/2026', 123, '2026-11-05')
  assert.equal(decideAutoMatch(transfer(123, '2026-03-10', 'abonament'), [nov]).action, 'none')
  assert.equal(decideAutoMatch(transfer(123, '2026-10-25', 'abonament'), [nov]).action, 'pay', 'przedpłata 11 dni przed fakturą')
  assert.equal(decideAutoMatch({ ...transfer(123, '2026-11-10', 'zwrot'), amount: 123 }, [nov]).action, 'none')
  const list = [{ id: 'a', invoice_date: '2026-03-24' }, { id: 'b', invoice_date: '2026-03-25' }, { id: 'c', invoice_date: null }]
  assert.deepEqual(payableCandidates({ transaction_date: '2026-03-10' }, list).map(i => i.id), ['a', 'c'])
  assert.equal(payableCandidates({ transaction_date: '' }, list).length, 3)
})

test('jedna faktura nie zostanie opłacona dwoma przelewami w jednym przebiegu', () => {
  const a = inv('a', 'FS/1/2026', 500, '2026-02-10')
  const taken = new Set<string>()
  const first = decideAutoMatch(transfer(500, '2026-02-20', 'zapłata'), [a], { taken })
  assert.equal(first.action, 'pay')
  taken.add('a')
  // drugi identyczny przelew: faktura jest już rozliczona w tym przebiegu → nic automatycznie
  assert.equal(decideAutoMatch(transfer(500, '2026-02-21', 'zapłata'), [a], { taken }).action, 'none')
})

// ── Podpowiedzi na liście „do sprawdzenia" (punkty) ───────────────────────────

test('scoreMatch służy tylko podpowiedziom: „nr faktury" liczy się dla całego numeru, kwota w tolerancji to podpowiedź', () => {
  const a = inv('a', '2/09/2026', 1000, '2026-09-03')
  assert.ok(scoreMatch(transfer(1000, '2026-10-06', 'INV 2/09/2026'), a).reasons.includes('nr faktury'))
  assert.ok(!scoreMatch(transfer(1000, '2026-10-06', '12/09/2026'), a).reasons.includes('nr faktury'))
  assert.ok(scoreMatch(transfer(1004, '2026-10-06', 'zapłata'), a).reasons.includes('kwota ±prowizja'))
  // …ale automat tej kwoty nie przyjmie
  assert.equal(decideAutoMatch(transfer(1004, '2026-10-06', 'zapłata'), [a]).action, 'none')
})

// ── Cofanie wcześniejszych automatycznych dopasowań ───────────────────────────

test('invalidAutoMatches: dopasowanie, którego ścisła reguła by nie zrobiła, jest do cofnięcia; poprawne zostają', () => {
  const lease = { seller_name: 'Autoleasing Testowy Financial Services Polska Sp. z o.o.', seller_nip: '5270000002' }
  const oct = { ...inv('oct', '146161/1026/RM', 6463.95, '2026-10-02', { payment_status: 'paid', payment_source: 'manual' }), ...lease }
  // listopadowa błędnie „opłacona" ratą październikową
  const wrongTx = { ...transfer(6463.95, '2026-10-30', '146161/1026/RM', 'AUTOLEASING TESTOWY FINANCIAL SERVICES POLSKA SP Z O O'), id: 'tx-wrong', matched_invoice_id: 'nov', review_status: 'matched' }
  const nov = { ...inv('nov', '146531/1126/RM', 6463.95, '2026-11-03', { payment_status: 'paid', payment_source: 'mt940', bank_tx_id: 'tx-wrong' }), ...lease }
  // poprawna automatyczna zapłata (kwota co do grosza + numer w tytule)
  const goodTx = { ...split(21083.52, '2026-02-23', 'FS/211/02/2026'), id: 'tx-good', matched_invoice_id: 'good', review_status: 'matched' }
  const good = inv('good', 'FS/211/02/2026', 21083.52, '2026-02-10', { payment_status: 'paid', payment_source: 'mt940', bank_tx_id: 'tx-good' })
  // poprawne samo powiązanie z fakturą opłaconą ręcznie
  const linkTx = { ...transfer(26822.35, '2026-10-03', '2/08/2026'), id: 'tx-link', matched_invoice_id: 'i08', review_status: 'matched' }
  const i08 = inv('i08', '2/08/2026', 26822.35, '2026-08-03', { payment_status: 'paid', payment_source: 'manual' })
  // zapłata po zbliżonej kwocie (dawna tolerancja 2 %) — do cofnięcia
  const nearTx = { ...transfer(26822.35, '2026-10-03', 'abonament'), id: 'tx-near', matched_invoice_id: 'i10', review_status: 'matched' }
  const i10 = inv('i10', '2/10/2026', 26793.59, '2026-10-02', { payment_status: 'paid', payment_source: 'mt940', bank_tx_id: 'tx-near' })

  const invoices = [oct, nov, good, i08, i10]
  const rows = [wrongTx, goodTx, linkTx, nearTx]
  const bad = invalidAutoMatches(rows, invoices, rows)
  assert.deepEqual(bad.map(b => b.tx.id).sort(), ['tx-near', 'tx-wrong'])
  const wrong = bad.find(b => b.tx.id === 'tx-wrong')!
  assert.equal(wrong.paidByThisTx, true)                       // faktura listopadowa wraca do „do zapłaty"
  assert.match(wrong.why, /146161\/1026\/RM/)                  // przelew dotyczy faktury październikowej
  assert.equal(bad.find(b => b.tx.id === 'tx-near')!.paidByThisTx, true)
  // przelew wskazujący usuniętą fakturę też wraca na listę
  const orphan = invalidAutoMatches([{ ...goodTx, matched_invoice_id: 'nie-ma' }], invoices, rows)
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0].invoice, null)
  // wejście nie jest modyfikowane
  assert.equal(nov.payment_status, 'paid')
})
