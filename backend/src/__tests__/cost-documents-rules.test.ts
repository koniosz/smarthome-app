/**
 * Testy czystych reguł skrzynki kosztów (routes/cost-documents.ts): kwota kosztu do RZiS (VAT odliczalny
 * czy nie), znacznik „wykluczony przez dokument” w notes przelewu MT940, widok dla pracownika, notatka NBP.
 * Uruchom: cd backend && npx tsx --test src/__tests__/cost-documents-rules.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  pnlAmountForDocument, isVatDeductible,
  excludedByDocumentMarker, parseExcludedByDocument, stripExcludedByDocument, appendNote,
  employeeView, EMPLOYEE_EXTRACT_ERROR, stripNbpFailNote,
} from '../routes/cost-documents'

describe('kwota kosztu do RZiS (pnlAmountForDocument)', () => {
  it('faktura krajowa (NIP 10 cyfr, nie paragon, VAT > 0) → netto', () => {
    const d = { seller_nip: '5261040828', is_receipt: false, vat: 230, net_pln: 1000, gross_pln: 1230 }
    assert.equal(isVatDeductible(d), true)
    assert.equal(pnlAmountForDocument(d), 1000)
  })
  it('paragon bez NIP nabywcy z VAT (Orlen 246 brutto) → brutto', () => {
    const d = { seller_nip: '7740001454', is_receipt: true, vat: 46, net_pln: 200, gross_pln: 246 }
    assert.equal(isVatDeductible(d), false)
    assert.equal(pnlAmountForDocument(d), 246)
  })
  it('faktura zagraniczna z lokalnym VAT (DE, VAT-ID 9 cyfr) → brutto (VAT nieodliczalny w PL)', () => {
    const d = { seller_nip: '123456789', is_receipt: false, vat: 190, net_pln: 4300, gross_pln: 5117 }
    assert.equal(pnlAmountForDocument(d), 5117)
  })
  it('reverse charge (VAT = 0) → brutto = netto', () => {
    const d = { seller_nip: '', is_receipt: false, vat: 0, net_pln: 4300, gross_pln: 4300 }
    assert.equal(pnlAmountForDocument(d), 4300)
  })
  it('brak NIP sprzedawcy → brutto; NIP z prefiksem PL liczony po cyfrach', () => {
    assert.equal(pnlAmountForDocument({ seller_nip: '', is_receipt: false, vat: 23, net_pln: 100, gross_pln: 123 }), 123)
    assert.equal(pnlAmountForDocument({ seller_nip: 'PL 526-104-08-28', is_receipt: false, vat: 23, net_pln: 100, gross_pln: 123 }), 100)
  })
  it('brak kwot → 0 (approve odrzuci)', () => {
    assert.equal(pnlAmountForDocument({ seller_nip: '', is_receipt: true, vat: 0, net_pln: 0, gross_pln: null }), 0)
  })
})

describe('znacznik „wykluczony przez dokument” w notes przelewu MT940', () => {
  const docId = 'b3c1e9d2-0000-4000-8000-1234567890ab'
  it('marker → parse zwraca poprzedni tryb; brak markera → null', () => {
    const notes = appendNote('MOUSER · przelew', excludedByDocumentMarker(docId, 'include'))
    assert.equal(notes, `MOUSER · przelew · wykluczony przez dokument ${docId} (wcześniej: include)`)
    assert.equal(parseExcludedByDocument(notes, docId), 'include')
    assert.equal(parseExcludedByDocument(notes, 'inny-dokument'), null)
    assert.equal(parseExcludedByDocument('', docId), null)
  })
  it('marker bez „wcześniej” → auto; pusty prevMode → auto', () => {
    assert.equal(parseExcludedByDocument(`wykluczony przez dokument ${docId}`, docId), 'auto')
    assert.match(excludedByDocumentMarker(docId, ''), /\(wcześniej: auto\)/)
  })
  it('strip usuwa tylko marker tego dokumentu i porządkuje separatory', () => {
    const notes = appendNote('MOUSER · przelew', excludedByDocumentMarker(docId, 'exclude'))
    assert.equal(stripExcludedByDocument(notes, docId), 'MOUSER · przelew')
    assert.equal(stripExcludedByDocument(excludedByDocumentMarker(docId, 'include'), docId), '')
    const other = appendNote(notes, excludedByDocumentMarker('drugi-dok', 'auto'))
    assert.equal(stripExcludedByDocument(other, docId), 'MOUSER · przelew · wykluczony przez dokument drugi-dok (wcześniej: auto)')
  })
  it('marker zawiera frazę, po której bank-rules.ts rozpoznaje przelew rozliczony dokumentem', () => {
    assert.ok(excludedByDocumentMarker(docId, 'include').includes('wykluczony przez dokument'))
  })
})

describe('widok dokumentu dla pracownika (employeeView)', () => {
  it('ukrywa notę duplikatu, surowy odczyt, pola e-maila i surowy błąd API', () => {
    const doc = {
      id: 'd1', status: 'error', seller_name: 'X', duplicate_of: 'mt940:abc',
      duplicate_note: 'Prawdopodobnie ten sam koszt z wyciągu (2026-08-12, 1 234,56 zł, „X SP. Z O.O. · FV 22/08”)',
      extracted: { seller_name: 'X' }, email_from: 'a@b', email_subject: 'FV', email_uid: 'h|f|1|0',
      extract_error: '401 invalid x-api-key', notes: 'Odrzucono: zła kwota',
    }
    const v = employeeView(doc)
    assert.equal(v.duplicate_note, undefined)
    assert.equal(v.extracted, undefined)
    assert.equal(v.email_from, undefined)
    assert.equal(v.email_subject, undefined)
    assert.equal(v.email_uid, undefined)
    assert.equal(v.extract_error, EMPLOYEE_EXTRACT_ERROR)
    assert.equal(v.duplicate_of, 'mt940:abc')
    assert.equal(v.notes, 'Odrzucono: zła kwota')
    assert.equal(v.seller_name, 'X')
  })
  it('pusty extract_error zostaje pusty', () => {
    assert.equal(employeeView({ extract_error: '' }).extract_error, '')
  })
})

describe('notatka o braku kursu NBP', () => {
  it('usuwana po pobraniu kursu, reszta notatki zostaje', () => {
    assert.equal(stripNbpFailNote('Nie udało się pobrać kursu NBP dla EUR — popraw datę/walutę lub wpisz kwoty w PLN.'), '')
    assert.equal(stripNbpFailNote('Nie udało się pobrać kursu NBP dla EUR — popraw datę/walutę lub wpisz kwoty w PLN. · uwaga księgowej'), 'uwaga księgowej')
    assert.equal(stripNbpFailNote('zwykła notatka'), 'zwykła notatka')
  })
})
