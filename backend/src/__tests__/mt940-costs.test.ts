/**
 * Import kosztów z MT940 — logika czysta: notatka kursowa NBP (format ↔ odczyt kwoty oryginalnej),
 * klucze deduplikacji dla kosztów przeliczonych z waluty, płatność za fakturę KSeF,
 * parowanie przelewu z już zatwierdzonym dokumentem ze skrzynki.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/mt940-costs.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatFxNote, parseFxNote, existingCostKeys, mt940CostKey,
  buildMatchedIndex, isKsefPayment, matchTransferToDocument, excludingDocIdsFromNotes,
  noteDocumentDuplicate, NOTE_NO_NBP_RATE, NOTE_KSEF_PAYMENT,
} from '../services/mt940-costs'

test('formatFxNote / parseFxNote: round-trip kwoty oryginalnej i waluty (format polski, kurs 4 miejsca)', () => {
  const note = formatFxNote(1000, 'EUR', 4.3012, '2026-08-13')
  // Intl pl-PL nie grupuje liczb 4-cyfrowych („1000,00"), 5+ cyfr grupuje twardą spacją („12 345,00")
  assert.match(note, /^1[\s  ]?000,00 EUR × kurs NBP 4,3012 z dnia 2026-08-13$/u)
  assert.deepEqual(parseFxNote(note), { amount: 1000, currency: 'EUR' })
  assert.match(formatFxNote(12345, 'EUR', 4.3, '2026-08-13'), /^12[\s  ]345,00 EUR/u)

  const small = formatFxNote(12.5, 'USD', 3.9, '2026-01-02')
  assert.deepEqual(parseFxNote(small), { amount: 12.5, currency: 'USD' })

  const big = formatFxNote(1234567.89, 'GBP', 5.1234, '2026-03-03')
  assert.deepEqual(parseFxNote(big), { amount: 1234567.89, currency: 'GBP' })

  // notatka doklejona za innymi uwagami (np. „wykluczony przez dokument …") nadal się odczytuje
  assert.deepEqual(parseFxNote(`coś innego · ${note} · ${NOTE_KSEF_PAYMENT}`), { amount: 1000, currency: 'EUR' })
  assert.equal(parseFxNote(''), null)
  assert.equal(parseFxNote(NOTE_NO_NBP_RATE), null)
  assert.equal(parseFxNote('1 000,00 zł zwykła notatka'), null)
})

test('existingCostKeys: koszt w PLN → jeden klucz; przeliczony z waluty → klucz po PLN i po kwocie oryginalnej', () => {
  const pln = { date: '2026-08-14', amount: 100, reference: 'REF1', description: 'X', notes: '' }
  assert.deepEqual(existingCostKeys(pln), ['2026-08-14|100.00|REF1'])

  const eur = { date: '2026-08-14', amount: 4301.2, reference: 'REF2', description: 'MOUSER', notes: formatFxNote(1000, 'EUR', 4.3012, '2026-08-13') }
  const keys = existingCostKeys(eur)
  assert.deepEqual(keys, ['2026-08-14|4301.20|REF2', '2026-08-14|1000.00|REF2'])
  // ponowny import tego samego pliku EUR: klucz z transakcji (kwota oryginalna) trafia w istniejący wiersz
  assert.ok(keys.includes(mt940CostKey({ date: '2026-08-14', amount: -1000, reference: 'REF2' })))

  // brak kursu przy pierwszym imporcie: wiersz zapisany w EUR z kwotą oryginalną — klucz jak z pliku
  const noRate = { date: '2026-08-14', amount: 1000, reference: 'REF3', description: 'MOUSER', notes: NOTE_NO_NBP_RATE }
  assert.deepEqual(existingCostKeys(noRate), ['2026-08-14|1000.00|REF3'])
})

test('isKsefPayment: data + kwota ± 0,01 + zgodna referencja (brak referencji → data + kwota)', () => {
  const idx = buildMatchedIndex([
    { transaction_date: '2026-09-05', amount: -615, reference: 'REF1' },
    { transaction_date: '2026-09-06', amount: -500, reference: '' },
  ])
  assert.equal(isKsefPayment({ date: '2026-09-05', amount: 615, reference: 'REF1' }, idx), true)
  assert.equal(isKsefPayment({ date: '2026-09-05', amount: 615, reference: 'INNA' }, idx), false, 'inna referencja')
  assert.equal(isKsefPayment({ date: '2026-09-05', amount: 615, reference: 'NONREF' }, idx), true, 'NONREF = brak referencji')
  assert.equal(isKsefPayment({ date: '2026-09-05', amount: 616, reference: 'REF1' }, idx), false, 'kwota poza tolerancją')
  assert.equal(isKsefPayment({ date: '2026-09-06', amount: 500, reference: 'COKOLWIEK' }, idx), true, 'transakcja bez referencji')
  assert.equal(isKsefPayment({ date: '2026-09-07', amount: 500, reference: '' }, idx), false, 'inna data')
})

const mouserDoc = { id: 'doc-mouser', seller_name: 'Mouser Electronics Inc', seller_nip: '', doc_number: 'INV-77', doc_date: '2026-09-01', gross_pln: 4300 }
const googleDoc = { id: 'doc-google', seller_name: 'Google Ireland Limited', seller_nip: '', doc_number: 'G-1', doc_date: '2026-09-03', gross_pln: 400 }

test('matchTransferToDocument: dokument zatwierdzony PRZED wyciągiem — przelew tej samej firmy, kwota ±max(2 zł, 2 %), ±60 dni', () => {
  const docs = [mouserDoc, googleDoc]
  const hit = matchTransferToDocument({ date: '2026-09-28', amount: 4300, description: 'MOUSER ELECTRONICS INC · zamówienie 12345', reference: 'NONREF' }, docs)
  assert.equal(hit?.id, 'doc-mouser')

  // płatność kartą: kontrahent pusty, opis „GOOGLE*WORKSPACE" — token „google" wspólny z „Google Ireland Limited"
  const card = matchTransferToDocument({ date: '2026-10-05', amount: 400, description: 'GOOGLE*WORKSPACE', reference: '' }, docs)
  assert.equal(card?.id, 'doc-google')

  // tolerancja: 2 % z 4300 = 86 zł
  assert.equal(matchTransferToDocument({ date: '2026-09-28', amount: 4380, description: 'MOUSER ELECTRONICS', reference: '' }, docs)?.id, 'doc-mouser')
  assert.equal(matchTransferToDocument({ date: '2026-09-28', amount: 4400, description: 'MOUSER ELECTRONICS', reference: '' }, docs), null, 'kwota poza tolerancją')
  // inna firma o tej samej kwocie — brak wspólnego tokenu
  assert.equal(matchTransferToDocument({ date: '2026-09-28', amount: 4300, description: 'DIGIKEY · order', reference: '' }, docs), null)
  // poza oknem ±60 dni
  assert.equal(matchTransferToDocument({ date: '2026-12-15', amount: 4300, description: 'MOUSER ELECTRONICS', reference: '' }, docs), null)
  assert.equal(matchTransferToDocument({ date: '2026-09-28', amount: 0, description: 'MOUSER', reference: '' }, docs), null)
  assert.equal(matchTransferToDocument({ date: '2026-09-28', amount: 4300, description: 'MOUSER', reference: '' }, []), null)
})

test('matchTransferToDocument: przy kilku trafieniach wygrywa najbliższa kwota', () => {
  const docs = [
    { ...mouserDoc, id: 'a', gross_pln: 4350 },
    { ...mouserDoc, id: 'b', gross_pln: 4301 },
  ]
  assert.equal(matchTransferToDocument({ date: '2026-09-28', amount: 4300, description: 'MOUSER ELECTRONICS', reference: '' }, docs)?.id, 'b')
})

test('noteDocumentDuplicate / excludingDocIdsFromNotes: notatka zawiera oba markery, id odczytywane także z notatek zatwierdzenia „mimo to"', () => {
  const note = noteDocumentDuplicate('doc-mouser')
  assert.ok(note.includes('duplikat dokumentu doc-mouser'))
  assert.ok(note.includes('wykluczony przez dokument doc-mouser'))
  const ids = excludingDocIdsFromNotes([
    note,
    'wykluczony przez dokument 3f2a1b4c-0000-4000-8000-000000000001',
    formatFxNote(10, 'EUR', 4.3, '2026-01-01'),
    null,
    '',
  ])
  assert.deepEqual([...ids].sort(), ['3f2a1b4c-0000-4000-8000-000000000001', 'doc-mouser'])
})
