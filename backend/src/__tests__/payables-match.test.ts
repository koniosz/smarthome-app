/**
 * Płatności — wybór faktury do automatycznego oznaczenia jako opłaconej (pickAutoMatch / scoreMatch).
 * Odkąd wyciąg niesie tytuł i kontrahenta, kilka faktur tego samego dostawcy dobija do pewności 1,0 —
 * rozstrzygać musi suma punktów BEZ obcięcia (numer faktury w tytule), a wynik nie może zależeć od
 * kolejności faktur na liście. Dane syntetyczne.
 *
 * Uruchomienie: cd backend && DATABASE_URL="postgresql://x:x@localhost:1/x" npx tsx --test src/__tests__/payables-match.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAutoMatch, scoreMatch, payableCandidates } from '../routes/payables'

const SELLER = { seller_name: 'Hurtownia Elektryczna Przykład Sp. z o.o.', seller_nip: '5210000001' }
const inv = (id: string, invoice_number: string, gross_amount: number, extra: Record<string, unknown> = {}) =>
  ({ id, invoice_number, gross_amount, invoice_date: '2026-02-10', ...SELLER, ...extra })
// przelew split payment: /VAT/<kwota VAT>/IDC/<NIP sprzedawcy>/INV/<numer faktury>/TXT/...
const splitPayment = (amount: number, invoiceNumber: string) => ({
  amount: -amount, transaction_date: '2026-02-23',
  description: `/VAT/123,45/IDC/5210000001/INV/${invoiceNumber}/TXT/PRZELEW ŚRODKÓW`,
  counterparty: 'HURTOWNIA ELEKTRYCZNA PRZYKŁAD SP. Z O.O.',
})

test('dwie podobne faktury tego samego dostawcy: wygrywa ta z numerem w tytule i dokładną kwotą — niezależnie od kolejności', () => {
  const a = inv('a', 'FS/211/02/2026', 21083.52)
  const b = inv('b', 'FS/212/02/2026', 21072.45) // kwota w tolerancji ±2 % względem przelewu za fakturę A
  const tx = splitPayment(21083.52, 'FS/211/02/2026')
  assert.equal(pickAutoMatch(tx, [a, b])?.invoice.id, 'a')
  assert.equal(pickAutoMatch(tx, [b, a])?.invoice.id, 'a')
  // i w drugą stronę
  const tx2 = splitPayment(21072.45, 'FS/212/02/2026')
  assert.equal(pickAutoMatch(tx2, [a, b])?.invoice.id, 'b')
  assert.equal(pickAutoMatch(tx2, [b, a])?.invoice.id, 'b')
})

test('dwie faktury na TĘ SAMĄ kwotę (abonament): numer faktury w tytule rozstrzyga', () => {
  const jan = inv('jan', 'FV/01/2026/0457', 123)
  const feb = inv('feb', 'FV/02/2026/0611', 123)
  assert.equal(pickAutoMatch(splitPayment(123, 'FV/02/2026/0611'), [jan, feb])?.invoice.id, 'feb')
  assert.equal(pickAutoMatch(splitPayment(123, 'FV/01/2026/0457'), [feb, jan])?.invoice.id, 'jan')
})

test('dwie faktury na tę samą kwotę, tytuł bez numeru faktury → niejednoznaczne, bez automatu', () => {
  const jan = inv('jan', 'FV/01/2026/0457', 123)
  const feb = inv('feb', 'FV/02/2026/0611', 123)
  const tx = { amount: -123, transaction_date: '2026-02-23', description: 'zapłata za abonament', counterparty: 'HURTOWNIA ELEKTRYCZNA PRZYKŁAD SP. Z O.O.' }
  assert.equal(pickAutoMatch(tx, [jan, feb]), null)
  assert.equal(pickAutoMatch(tx, [feb, jan]), null)
})

test('dokładna kwota wygrywa z kwotą ±prowizja także bez numeru w tytule (kolejność bez znaczenia)', () => {
  const exact = inv('exact', 'FV/10/2026', 1000)
  const near = inv('near', 'FV/11/2026', 1004) // różnica 4 zł mieści się w tolerancji prowizji
  const tx = { amount: -1000, transaction_date: '2026-02-23', description: 'zapłata', counterparty: 'HURTOWNIA ELEKTRYCZNA PRZYKŁAD SP. Z O.O.' }
  assert.equal(pickAutoMatch(tx, [exact, near])?.invoice.id, 'exact')
  assert.equal(pickAutoMatch(tx, [near, exact])?.invoice.id, 'exact')
})

test('sama kwota bez kontrahenta i numeru nie wystarcza do automatu; obcy dostawca też nie', () => {
  const a = inv('a', 'FS/211/02/2026', 500)
  const bare = { amount: -500, transaction_date: '2026-02-23', description: 'przelew', counterparty: '' }
  assert.equal(pickAutoMatch(bare, [a]), null)
  const other = { amount: -777, transaction_date: '2026-02-23', description: 'faktura 9/2026', counterparty: 'INNA FIRMA S.A.' }
  assert.equal(pickAutoMatch(other, [a]), null)
})

test('scoreMatch: pewność obcięta do 1, suma punktów (score) nie — i to ona rozróżnia kandydatów', () => {
  const a = inv('a', 'FS/211/02/2026', 21083.52)
  const b = inv('b', 'FS/212/02/2026', 21072.45)
  const tx = splitPayment(21083.52, 'FS/211/02/2026')
  const sa = scoreMatch(tx, a), sb = scoreMatch(tx, b)
  assert.equal(sa.confidence, 1)
  assert.equal(sb.confidence, 1)
  assert.ok(sa.score > sb.score + 0.3, `score A ${sa.score} powinien wyraźnie przewyższać B ${sb.score}`)
  assert.ok(sa.reasons.includes('nr faktury') && sa.reasons.includes('NIP') && sa.reasons.includes('kwota'))
  assert.ok(!sb.reasons.includes('nr faktury') && sb.reasons.includes('kwota ±prowizja'))
})

// ── Kandydaci: przelew nie może opłacić faktury wystawionej długo po nim ───────

test('payableCandidates: faktura wystawiona > 14 dni po przelewie odpada; opóźniona płatność i przedpłata zostają', () => {
  const tx = { transaction_date: '2026-03-10' }
  const invoices = [
    { id: 'stara', invoice_date: '2025-11-02' },        // płatność mocno po terminie — dozwolona
    { id: 'tegodnia', invoice_date: '2026-03-10' },
    { id: 'przedplata', invoice_date: '2026-03-24' },   // faktura 14 dni po przelewie (przedpłata) — jeszcze tak
    { id: 'pozniejsza', invoice_date: '2026-03-25' },   // 15 dni po — już nie
    { id: 'listopad', invoice_date: '2026-11-05' },     // abonament z listopada nie mógł być opłacony w marcu
    { id: 'bezdaty', invoice_date: null },
  ]
  assert.deepEqual(payableCandidates(tx, invoices).map(i => i.id), ['stara', 'tegodnia', 'przedplata', 'bezdaty'])
  // parser zwraca `date`, baza `transaction_date` — obie postaci działają
  assert.deepEqual(payableCandidates({ date: '2026-03-10' }, invoices).map(i => i.id), ['stara', 'tegodnia', 'przedplata', 'bezdaty'])
  // przelew bez czytelnej daty niczego nie odcina
  assert.equal(payableCandidates({ transaction_date: '' }, invoices).length, invoices.length)
})

test('stary przelew (uzupełniany przy ponownym wgraniu wyciągu) nie „opłaca" dzisiejszej faktury abonamentowej', () => {
  const march = { amount: -123, transaction_date: '2026-03-10', description: 'abonament', counterparty: 'HURTOWNIA ELEKTRYCZNA PRZYKŁAD SP. Z O.O.' }
  const november = inv('nov', 'FV/11/2026/0911', 123, { invoice_date: '2026-11-05' })
  // bez odcięcia kandydatów faktura z listopada kwalifikowałaby się (kwota + kontrahent + NIP)
  assert.equal(pickAutoMatch(march, [november])?.invoice.id, 'nov')
  assert.equal(pickAutoMatch(march, payableCandidates(march, [november])), null)
  // faktura z marca nadal jest dopasowywana
  const marchInv = inv('mar', 'FV/03/2026/0301', 123, { invoice_date: '2026-03-01' })
  assert.equal(pickAutoMatch(march, payableCandidates(march, [november, marchInv]))?.invoice.id, 'mar')
})
