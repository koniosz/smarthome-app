/**
 * Testy parsowania i normalizacji odpowiedzi AI dla dokumentów kosztowych (bez wywołań API).
 * Uruchom: cd backend && npx tsx --test src/__tests__/cost-extract-parse.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseExtraction, subcategoryToCategory, toNumber, normalizeDate, normalizeCurrency, EXTRACT_SUBCATEGORIES } from '../services/cost-extract'

describe('toNumber', () => {
  it('liczby i formaty polskie/angielskie', () => {
    assert.equal(toNumber(123.45), 123.45)
    assert.equal(toNumber('1 234,56'), 1234.56)
    assert.equal(toNumber('1,234.56'), 1234.56)
    assert.equal(toNumber('1.234,56'), 1234.56)
    assert.equal(toNumber('€ 99.00'), 99)
    assert.equal(toNumber('99,5 zł'), 99.5)
    assert.equal(toNumber('12'), 12)
    assert.equal(toNumber('1.234'), 1234) // separator tysięcy
    assert.equal(toNumber(''), 0)
    assert.equal(toNumber('-'), 0)
    assert.equal(toNumber(null), 0)
    assert.equal(toNumber(NaN), 0)
  })
})

describe('normalizeDate', () => {
  it('formaty dat → YYYY-MM-DD', () => {
    assert.equal(normalizeDate('2026-08-14'), '2026-08-14')
    assert.equal(normalizeDate('14.08.2026'), '2026-08-14')
    assert.equal(normalizeDate('14/08/2026'), '2026-08-14')
    assert.equal(normalizeDate('2026/8/4'), '2026-08-04')
    assert.equal(normalizeDate('2026-08-14T10:00:00Z'), '2026-08-14')
    assert.equal(normalizeDate('31.02.2026'), '')
    assert.equal(normalizeDate('brak'), '')
    assert.equal(normalizeDate(''), '')
  })
})

describe('normalizeCurrency', () => {
  it('aliasy i kody ISO', () => {
    assert.equal(normalizeCurrency('zł'), 'PLN')
    assert.equal(normalizeCurrency('€'), 'EUR')
    assert.equal(normalizeCurrency('usd'), 'USD')
    assert.equal(normalizeCurrency('GBP'), 'GBP')
    assert.equal(normalizeCurrency('CNY (RMB)'), 'CNY')
    assert.equal(normalizeCurrency(''), 'PLN')
    assert.equal(normalizeCurrency(undefined), 'PLN')
  })
})

describe('subcategoryToCategory', () => {
  it('mapowanie podkategorii → kategoria główna', () => {
    for (const k of ['hardware', 'hardware_eu', 'hardware_noneu', 'import_duty', 'import_freight', 'import_agency', 'subcontractor', 'installation_material']) assert.equal(subcategoryToCategory(k), 'cogs', k)
    for (const k of ['software', 'utilities', 'rent', 'accounting', 'legal', 'office_supplies', 'other']) assert.equal(subcategoryToCategory(k), 'ga', k)
    for (const k of ['car_fuel', 'car_service', 'insurance', 'travel', 'tools']) assert.equal(subcategoryToCategory(k), 'operations', k)
    assert.equal(subcategoryToCategory('marketing'), 'sales')
    assert.equal(subcategoryToCategory('nieznane'), 'ga')
  })
  it('każdy klucz z listy promptu ma mapowanie', () => {
    for (const k of Object.keys(EXTRACT_SUBCATEGORIES)) assert.ok(['cogs', 'ga', 'operations', 'sales'].includes(subcategoryToCategory(k)), k)
  })
})

describe('parseExtraction', () => {
  it('czysty JSON', () => {
    const out = parseExtraction(JSON.stringify({
      seller_name: 'Google Ireland Limited', seller_nip: 'IE6388047V', seller_country: 'ie', doc_number: '5123456789',
      doc_date: '2026-08-14', currency: 'EUR', net: 100, vat: 0, gross: 100, is_receipt: false,
      description: 'Google Workspace Business Starter – 5 użytkowników', suggested_subcategory: 'software', confidence: 0.93,
    }))
    assert.equal(out.seller_name, 'Google Ireland Limited')
    assert.equal(out.seller_nip, '6388047')
    assert.equal(out.seller_country, 'IE')
    assert.equal(out.currency, 'EUR')
    assert.equal(out.net, 100)
    assert.equal(out.gross, 100)
    assert.equal(out.suggested_subcategory, 'software')
    assert.equal(out.confidence, 0.93)
    assert.equal(out.is_receipt, false)
  })

  it('JSON w bloku ```json i tekst dookoła', () => {
    const text = 'Oto wynik:\n```json\n{"seller_name":"Orlen","doc_date":"14.08.2026","currency":"zł","gross":"250,00","vat":"46,75","is_receipt":"true","suggested_subcategory":"car_fuel","confidence":88}\n```\nKoniec.'
    const out = parseExtraction(text)
    assert.equal(out.seller_name, 'Orlen')
    assert.equal(out.doc_date, '2026-08-14')
    assert.equal(out.currency, 'PLN')
    assert.equal(out.gross, 250)
    assert.equal(out.vat, 46.75)
    assert.equal(out.net, 203.25) // netto = brutto − VAT
    assert.equal(out.is_receipt, true)
    assert.equal(out.confidence, 0.88) // procent → ułamek
    assert.equal(out.suggested_subcategory, 'car_fuel')
  })

  it('uszkodzony JSON naprawiany przez jsonrepair (przecinek na końcu, pojedyncze cudzysłowy)', () => {
    const text = "{'seller_name': 'AliExpress', 'currency': 'USD', 'net': 45.5, 'vat': 0, 'gross': 45.5, 'suggested_subcategory': 'hardware_noneu', 'confidence': 0.7,}"
    const out = parseExtraction(text)
    assert.equal(out.seller_name, 'AliExpress')
    assert.equal(out.currency, 'USD')
    assert.equal(out.gross, 45.5)
    assert.equal(out.suggested_subcategory, 'hardware_noneu')
  })

  it('gross = net + vat, gdy brutto brak', () => {
    const out = parseExtraction('{"net": 100, "vat": 23}')
    assert.equal(out.gross, 123)
  })

  it('vat = gross − net, gdy VAT brak, a brutto > netto', () => {
    const out = parseExtraction('{"net": 100, "gross": 123}')
    assert.equal(out.vat, 23)
  })

  it('nieznana podkategoria → other; ujemne kwoty → wartość bezwzględna; opis ucięty do 120 znaków', () => {
    const out = parseExtraction(JSON.stringify({ suggested_subcategory: 'cokolwiek', net: -10, gross: -10, description: 'x'.repeat(300) }))
    assert.equal(out.suggested_subcategory, 'other')
    assert.equal(out.net, 10)
    assert.equal(out.gross, 10)
    assert.equal(out.description.length, 120)
  })

  it('NIP 10 cyfr bez kraju → PL; confidence przycięte do [0,1]', () => {
    const out = parseExtraction('{"seller_nip":"526-104-08-28","confidence":1.7}')
    assert.equal(out.seller_nip, '5261040828')
    assert.equal(out.seller_country, 'PL')
    assert.equal(out.confidence, 1)
  })

  it('brak JSON → błąd', () => {
    assert.throws(() => parseExtraction('Nie potrafię odczytać tego dokumentu.'), /JSON/)
    assert.throws(() => parseExtraction('[1,2,3]'), /JSON/)
  })
})
