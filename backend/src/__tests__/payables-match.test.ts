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
  decideAutoMatch, titleNamesInvoice, titleHasOtherReference, sellerMatchesTransfer, sameSeller, amountEquals,
  payableCandidates, canonTokens, invoiceReferenceText, distinctiveNameTokens, matchContradiction,
} from '../services/payment-match'
import { scoreMatch, invalidAutoMatches, rematchOrder } from '../routes/payables'

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
  // faktury październikowej nie ma w systemie → tytuł niesie numer, który nie jest numerem żadnej znanej faktury:
  // nic automatycznie (także gdy numer zapisano inaczej: bez „RM", z „FV" na początku)
  for (const title of ['146161/1026/RM', '146161/1026', 'RM146161/1026', 'faktura 146161/10/2026']) {
    const alone = decideAutoMatch({ ...tx, description: title }, [nov])
    assert.equal(alone.action, 'none', title)
    assert.match(alone.action === 'none' ? alone.why : '', /zawiera numer/, title)
  }
})

// ── Kwota: co do grosza, bez tolerancji ───────────────────────────────────────

test('kwota musi zgadzać się co do grosza — zbliżona kwota (prowizja, inna faktura) nigdy nie daje automatu', () => {
  const one = [inv('a', 'FS/211/02/2026', 21083.52, '2026-02-10')]
  assert.equal(decideAutoMatch(transfer(21083.52, '2026-02-23', 'zapłata'), one).action, 'pay')
  assert.equal(decideAutoMatch(transfer(21083.53, '2026-02-23', 'zapłata'), one).action, 'none', 'różnica 1 gr to już inna kwota')
  assert.equal(decideAutoMatch(transfer(21083.51, '2026-02-23', 'zapłata'), one).action, 'none')
  // porównanie w groszach — bez pułapek zmiennoprzecinkowych w obie strony
  assert.equal(amountEquals({ amount: -26822.35 }, { id: 'x', gross_amount: 26822.35 }), true)
  assert.equal(amountEquals({ amount: -26822.36 }, { id: 'x', gross_amount: 26822.35 }), false)
  assert.equal(amountEquals({ amount: -0.1 - 0.2 }, { id: 'x', gross_amount: 0.3 }), true)
  // inna waluta = inna kwota (przelew 500 PLN nie opłaca faktury na 500 EUR)
  assert.equal(amountEquals({ amount: -500 }, { id: 'x', gross_amount: 500, currency: 'EUR' }), false)
  assert.equal(amountEquals({ amount: -500, currency: 'EUR' }, { id: 'x', gross_amount: 500, currency: 'EUR' }), true)
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
  const two = decideAutoMatch(transfer(2460, '2026-10-20', 'FV 5/08/2026, FV 5/09/2026'), invoices)
  assert.equal(two.action, 'none')
  assert.match(two.action === 'none' ? two.why : '', /kilka faktur/)
  // to samo bez słowa „FV": numery wyglądają jak daty, więc nie uznajemy ich za wskazanie faktury — ale i tak nic automatycznie
  assert.equal(decideAutoMatch(transfer(2460, '2026-10-20', '5/08/2026, 5/09/2026'), invoices).action, 'none')
  assert.equal(decideAutoMatch(transfer(1230, '2026-10-20', 'za 5/08/2026 i 5/09/2026'), invoices).action, 'none')
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
  // daty i okresy to nie numery faktur
  assert.equal(titleNamesInvoice('abonament 10/2026', '10/2026'), false, 'okres, nie faktura')
  assert.equal(titleNamesInvoice('uslugi ksiegowe 10/2026', '10/2026'), false)
  assert.equal(titleNamesInvoice('faktura 10/2026', '10/2026'), true, 'po słowie „faktura" to numer')
  assert.equal(titleNamesInvoice('10/2026', '10/2026'), true, 'cały tytuł jest numerem')
  assert.equal(titleNamesInvoice('FV 5/12/2026', '12/2026'), false, 'fragment numeru 5/12/2026')
  assert.equal(titleNamesInvoice('usluga z dnia 03.01.2026', '1/2026'), false, 'fragment daty')
  assert.equal(titleNamesInvoice('abonament za okres 02.09.2026-01.10.2026', '2/09/2026'), false, 'początek okresu')
  assert.equal(titleNamesInvoice('FAKTURA 09 09 2026', '09 09 2026'), true)
  assert.equal(titleNamesInvoice('01/09/26', '01/09/26'), true)
  // literowy przedrostek numeru może w tytule nie wystąpić — o ile reszta jest wyróżniająca
  assert.equal(titleNamesInvoice('1894/MG/08/2026', 'FS 1894/MG/08/2026'), true)
  assert.equal(titleNamesInvoice('zaplata 211/02/2026', 'FS/211/02/2026'), true)
  assert.equal(titleNamesInvoice('abonament 10/2026', 'FV/10/2026'), false, 'po zdjęciu przedrostka zostaje okres')
  // data transakcji z płatności kartą nie jest numerem faktury
  assert.equal(invoiceReferenceText('SKLEP TESTOWY KASA 8/WARSZAWA DATA TRANSAKCJI: 2026-09-01'), 'SKLEP TESTOWY KASA 8/WARSZAWA')
  assert.equal(titleNamesInvoice('SKLEP TESTOWY/WARSZAWA DATA TRANSAKCJI: 2026-09-01', '2026/09/01'), false)
})

test('titleHasOtherReference: jakikolwiek numer w tytule (zamówienie, proforma, okres) blokuje dopasowanie po samej kwocie', () => {
  for (const t of ['2/08/2026', 'zamówienie 4411', 'FAKTURA PROFORMA 20119/MG/09/2026', 'abonament za 10/2026', '/VAT/1,00/IDC/8160000001/INV/ZAM 77/TXT/x']) {
    assert.equal(titleHasOtherReference(t), true, t)
  }
  for (const t of ['PRZELEW ŚRODKÓW', 'abonament', 'zapłata za fakturę', '/VAT/1,00/IDC/8160000001/INV/zaplata/TXT/przelew 123']) {
    assert.equal(titleHasOtherReference(t), false, t)
  }
  // płatność kartą: „KASA 5" i data transakcji to nie numery dokumentów
  assert.equal(titleHasOtherReference('BUDOMARKET KASA 5 /WARSZAWA DATA TRANSAKCJI: 2026-10-03'), false)
  // skutek: jedyna faktura na tę kwotę, ale tytuł mówi o czymś innym → do ręcznego sprawdzenia
  const one = [inv('a', 'FS/211/02/2026', 500, '2026-02-10')]
  assert.equal(decideAutoMatch(transfer(500, '2026-02-23', 'proforma 77/2026'), one).action, 'none')
  assert.equal(decideAutoMatch(transfer(500, '2026-02-23', 'zapłata'), one).action, 'pay')
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
  // słowa branżowe nie identyfikują firmy: inna osoba o tej samej branży to inny dostawca
  const electrician = { ...i, seller_name: 'Usługi Elektryczne Jan Kowalski', seller_nip: '' }
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'za montaż oświetlenia', 'USLUGI ELEKTRYCZNE PIOTR NOWAK'), electrician), false)
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'za montaż oświetlenia', 'USLUGI ELEKTRYCZNE JAN KOWALSKI'), electrician), true)
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'x', 'USLUGI ELEKTRYCZNE'), { ...i, seller_name: 'Usługi Elektryczne', seller_nip: '' }), false, 'sama branża')
  // człony nazwy muszą być w KONTRAHENCIE, nie rozrzucone między kontrahenta i tytuł
  const lessor = { ...i, seller_name: 'Autko Leasing Polska S.A.', seller_nip: '' }
  assert.equal(sellerMatchesTransfer(transfer(500, '2026-02-20', 'rata autko proace', 'INNY LEASING SA'), lessor), false)
  assert.equal(sameSeller({ id: '1', seller_nip: '8160000001' }, { id: '2', seller_nip: 'PL 816-000-00-01' }), true)
  assert.equal(sameSeller({ id: '1', seller_nip: '8160000001', seller_name: 'A' }, { id: '2', seller_nip: '', seller_name: 'A' }), false)
  assert.equal(sameSeller({ id: '1', seller_name: 'Chmurex  Dorota Testowa' }, { id: '2', seller_name: 'CHMUREX DOROTA TESTOWA' }), true)
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

// ── Cofanie wcześniejszych dopasowań: tylko twarda sprzeczność ────────────────

const lease = { seller_name: 'Autoleasing Testowy Financial Services Polska Sp. z o.o.', seller_nip: '5270000002' }
const paidBy = (txId: string, extra: Record<string, unknown> = {}) => ({ payment_status: 'paid', payment_source: 'mt940', bank_tx_id: txId, ...extra })
const row = (id: string, tx: Record<string, unknown>, invoiceId: string, status = 'matched') => ({ ...tx, id, matched_invoice_id: invoiceId, review_status: status, source: 'mt940' })

test('invalidAutoMatches cofa przy twardej sprzeczności: inna faktura w tytule, inna kwota, przelew sprzed daty faktury', () => {
  const oct = { ...inv('oct', '146161/1026/RM', 6463.95, '2026-10-02', { payment_status: 'paid', payment_source: 'manual' }), ...lease }
  // listopadowa błędnie „opłacona" ratą październikową (tytuł wymienia fakturę październikową)
  const wrongTx = row('tx-wrong', transfer(6463.95, '2026-10-30', '146161/1026/RM', 'AUTOLEASING TESTOWY FINANCIAL SERVICES POLSKA SP Z O O'), 'nov')
  const nov = { ...inv('nov', '146531/1126/RM', 6463.95, '2026-11-03', paidBy('tx-wrong')), ...lease }
  // druga rata: tytuł bez numeru („PRZELEW ŚRODKÓW"), przelew 29.10 „opłacił" fakturę z 3.11, choć tę kwotę ma też wcześniejsza
  const oct2 = { ...inv('oct2', '146160/1026/RM', 1713.44, '2026-10-02', { payment_status: 'paid', payment_source: 'manual' }), ...lease }
  const earlyTx = row('tx-early', transfer(1713.44, '2026-10-29', 'PRZELEW ŚRODKÓW', 'AUTOLEASING TESTOWY FINANCIAL SERVICES POLSKA SP Z O O'), 'nov2')
  const nov2 = { ...inv('nov2', '146530/1126/RM', 1713.44, '2026-11-03', paidBy('tx-early')), ...lease }
  // zapłata po zbliżonej kwocie (dawna tolerancja 2 %)
  const nearTx = row('tx-near', transfer(26822.35, '2026-10-03', 'abonament'), 'i10')
  const i10 = inv('i10', '2/10/2026', 26793.59, '2026-10-02', paidBy('tx-near'))

  const invoices = [oct, nov, oct2, nov2, i10]
  const bad = invalidAutoMatches([wrongTx, earlyTx, nearTx], invoices)
  assert.deepEqual(bad.map(b => b.tx.id).sort(), ['tx-early', 'tx-near', 'tx-wrong'])
  assert.ok(bad.every(b => b.paidByThisTx), 'faktury wracają do „do zapłaty"')
  assert.match(bad.find(b => b.tx.id === 'tx-wrong')!.why, /wskazuje fakturę 146161\/1026\/RM/)
  assert.match(bad.find(b => b.tx.id === 'tx-early')!.why, /wcześniejszy niż faktura .* 146160\/1026\/RM/)
  assert.match(bad.find(b => b.tx.id === 'tx-near')!.why, /kwota przelewu różni się/)
  assert.equal(nov.payment_status, 'paid', 'wejście nie jest modyfikowane')
})

test('invalidAutoMatches NIE cofa poprawnych zapłat tylko dlatego, że dzisiejsza reguła by ich nie powtórzyła', () => {
  // (a) bank skrócił / inaczej zapisał nazwę kontrahenta
  const a = inv('a', 'FS/211/02/2026', 21083.52, '2026-02-10', paidBy('tx-a'))
  const txA = row('tx-a', transfer(21083.52, '2026-02-23', 'zaplata FS/211/02/2026', 'CHMUREX'), 'a')
  // (b) data / okres w tytule
  const b = inv('b', '2/10/2026', 26793.59, '2026-10-02', paidBy('tx-b'))
  const txB = row('tx-b', transfer(26793.59, '2026-10-20', 'abonament za okres 01.10.2026-31.10.2026'), 'b')
  // (c) później pojawiła się kolejna faktura na tę samą kwotę
  const c = inv('c', '5/10/2026', 1230, '2026-10-02', paidBy('tx-c'))
  const cNext = inv('c-next', '5/11/2026', 1230, '2026-11-03')
  const txC = row('tx-c', transfer(1230, '2026-10-25', 'abonament'), 'c')
  // (d) sąsiednią fakturę na tę samą kwotę oznaczono potem ręcznie
  const d = inv('d', '5/09/2026', 1230, '2026-09-03', paidBy('tx-d'))
  const dNext = inv('d-next', '5/08/2026', 1230, '2026-08-03', { payment_status: 'paid', payment_source: 'manual' })
  const txD = row('tx-d', transfer(1230, '2026-09-25', 'abonament'), 'd')
  // (e) samo powiązanie z fakturą opłaconą ręcznie; także dopłata na inną kwotę do TEJ faktury
  const e = inv('e', '2/08/2026', 26822.35, '2026-08-03', { payment_status: 'paid', payment_source: 'manual' })
  const txE = row('tx-e', transfer(26822.35, '2026-10-03', '2/08/2026'), 'e')
  const txE2 = row('tx-e2', transfer(0.9, '2026-10-29', '2/08/2026 minus nadpłata'), 'e')
  // (f) dawne dopasowanie ze starego okna weryfikacji (status „none"), przelew bez tytułu
  const f = inv('f', 'FS/9/2026', 500, '2026-03-01', paidBy('tx-f'))
  const txF = row('tx-f', transfer(500, '2026-03-10', '152', '152'), 'f', 'none')

  const invoices = [a, b, c, cNext, d, dNext, e, f]
  assert.deepEqual(invalidAutoMatches([txA, txB, txC, txD, txE, txE2, txF], invoices), [])
})

test('invalidAutoMatches: powiązanie z fakturą usuniętą albo nieopłaconą wraca do oceny — bez zmiany statusu faktury', () => {
  const unpaid = inv('u', '2/10/2026', 26793.59, '2026-10-02')
  const dangling = row('tx-dangling', transfer(26793.59, '2026-10-20', '2/10/2026'), 'u')
  const orphan = row('tx-orphan', transfer(100, '2026-10-20', 'x'), 'nie-ma')
  const bad = invalidAutoMatches([dangling, orphan], [unpaid])
  assert.deepEqual(bad.map(b => [b.tx.id, b.paidByThisTx, b.invoice?.id ?? null]), [['tx-dangling', false, 'u'], ['tx-orphan', false, null]])
})

test('matchContradiction: tytuł wymieniający TĘ fakturę rozstrzyga na jej korzyść', () => {
  const oct = { ...inv('oct', '146161/1026/RM', 6463.95, '2026-10-02', { payment_status: 'paid' }), ...lease }
  const nov = { ...inv('nov', '146531/1126/RM', 6463.95, '2026-11-03', { payment_status: 'paid' }), ...lease }
  // przedpłata: przelew przed datą faktury, ale tytuł wymienia właśnie tę fakturę → bez sprzeczności
  assert.equal(matchContradiction(transfer(6463.95, '2026-10-30', 'FV 146531/1126/RM'), nov, [oct, nov], true), null)
  // tytuł wymienia obie → nie rozstrzygamy na niekorzyść
  assert.equal(matchContradiction(transfer(6463.95, '2026-10-30', '146161/1026/RM, 146531/1126/RM'), nov, [oct, nov], true), null)
  // faktura innego sprzedawcy o tym samym numerze nie jest „inną fakturą tego sprzedawcy"
  const stranger = inv('s', '146161/1026/RM', 6463.95, '2026-10-02')
  assert.equal(matchContradiction(transfer(6463.95, '2026-11-10', '146161/1026/RM'), nov, [stranger, nov], true), null)
})

test('rematchOrder: od najstarszego przelewu (stała kolejność niezależnie od kolejności z bazy)', () => {
  const list = [{ id: 'b', transaction_date: '2026-10-06' }, { id: 'a', transaction_date: '2026-10-03' }, { id: 'c', transaction_date: '2026-10-03' }]
  assert.deepEqual(rematchOrder(list).map(t => t.id), ['a', 'c', 'b'])
})
