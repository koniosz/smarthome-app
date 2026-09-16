/**
 * Testy wykrywania duplikatów dokumentów kosztowych (czysta logika, bez bazy).
 * Uruchom: cd backend && npx tsx --test src/__tests__/cost-duplicates.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findDuplicate, findKsefDuplicate, findMt940Duplicate, findDocumentDuplicate,
  nameTokens, namesMatch, normalizeDocNumber, nipDigits, sharedToken,
  type DupContext, type DupDocInput,
} from '../services/cost-duplicates'

const emptyCtx = (): DupContext => ({ ksefIncoming: [], mt940Costs: [], documents: [] })

const baseDoc = (over: Partial<DupDocInput> = {}): DupDocInput => ({
  id: 'doc-new',
  seller_name: 'Google Ireland Ltd',
  seller_nip: '',
  doc_number: 'INV-2026-000123',
  doc_date: '2026-08-14',
  gross_pln: 431.80,
  ...over,
})

describe('normalizacja', () => {
  it('nipDigits zostawia same cyfry', () => {
    assert.equal(nipDigits('PL 123-456-78-90'), '1234567890')
    assert.equal(nipDigits(null), '')
  })
  it('normalizeDocNumber ignoruje separatory i wielkość liter', () => {
    assert.equal(normalizeDocNumber('FV/2026/08/015'), normalizeDocNumber('fv-2026-08-015'))
    assert.equal(normalizeDocNumber('  '), '')
  })
  it('nameTokens: ≥4 litery, bez diakrytyków, bez stop-słów', () => {
    assert.deepEqual(nameTokens('Zakład Usług Elektrycznych ELEKTRO-BUD Sp. z o.o.'), ['zaklad', 'elektrycznych', 'elektro'])
  })
  it('namesMatch: równość, zawieranie i wspólny token', () => {
    assert.equal(namesMatch('Google Ireland Ltd', 'GOOGLE IRELAND LIMITED'), true)
    assert.equal(namesMatch('Allegro', 'ALLEGRO.PL SP. Z O.O.'), true)
    assert.equal(namesMatch('Orlen', 'Shell Polska'), false)
    assert.equal(sharedToken('AliExpress Hong Kong', 'PLATNOSC KARTA ALIEXPRESS 4839'), 'aliexpress')
  })
})

describe('(a) KSeF', () => {
  it('ten sam NIP i kwota ±0,02 → ksef:<id>', () => {
    const doc = baseDoc({ seller_name: 'Firma X', seller_nip: '5261040828', gross_pln: 1230.00, doc_number: 'inny-numer' })
    const hit = findKsefDuplicate(doc, [
      { id: 'k1', seller_nip: 'PL5261040828', seller_name: 'FIRMA X SP. Z O.O.', invoice_number: 'FV/1/2026', gross_amount: 1230.01, invoice_date: '2026-08-10' },
    ])
    assert.equal(hit?.duplicate_of, 'ksef:k1')
    assert.match(hit!.note, /KSeF/)
  })
  it('ten sam NIP, ale inna kwota → brak', () => {
    const doc = baseDoc({ seller_nip: '5261040828', gross_pln: 1230.00 })
    const hit = findKsefDuplicate(doc, [
      { id: 'k1', seller_nip: '5261040828', seller_name: 'Zupełnie inna nazwa', invoice_number: 'ABC', gross_amount: 999.00, invoice_date: null },
    ])
    assert.equal(hit, null)
  })
  it('ten sam numer (alfanumerycznie) i zbieżna nazwa → ksef:<id>', () => {
    const doc = baseDoc({ seller_name: 'ALLEGRO.PL', doc_number: 'FS 2026/08/0042', gross_pln: 50 })
    const hit = findKsefDuplicate(doc, [
      { id: 'k2', seller_nip: null, seller_name: 'Allegro.pl sp. z o.o.', invoice_number: 'FS-2026-08-0042', gross_amount: 9999, invoice_date: null },
    ])
    assert.equal(hit?.duplicate_of, 'ksef:k2')
  })
  it('ten sam numer, ale inna firma → brak (numery faktur powtarzają się między firmami)', () => {
    const doc = baseDoc({ seller_name: 'Google Ireland', doc_number: '1/2026', gross_pln: 50 })
    const hit = findKsefDuplicate(doc, [
      { id: 'k3', seller_nip: null, seller_name: 'Hydraulik Kowalski', invoice_number: '1/2026', gross_amount: 50, invoice_date: null },
    ])
    assert.equal(hit, null)
  })
})

describe('(b) MT940', () => {
  const costs = [
    { id: 'm1', date: '2026-08-15', amount: 431.80, description: 'GOOGLE IRELAND LIMITED · PLATNOSC KARTA GOOGLE*CLOUD', reference: 'REF1' },
    { id: 'm2', date: '2026-02-01', amount: 431.80, description: 'GOOGLE IRELAND LIMITED · stara płatność', reference: 'REF2' },
    { id: 'm3', date: '2026-08-15', amount: 431.80, description: 'ORLEN PALIWO', reference: 'REF3' },
  ]
  it('kwota ±2 %, wspólny token, data ±60 dni → mt940:<id>', () => {
    const hit = findMt940Duplicate(baseDoc(), costs)
    assert.equal(hit?.duplicate_of, 'mt940:m1')
    assert.match(hit!.note, /wyciągu/)
    assert.match(hit!.note, /duplikat/)
  })
  it('tolerancja kwoty: max(2 zł, 2 %)', () => {
    // 431,80 → tolerancja 8,64 zł
    assert.equal(findMt940Duplicate(baseDoc({ gross_pln: 440.00 }), costs)?.duplicate_of, 'mt940:m1')
    assert.equal(findMt940Duplicate(baseDoc({ gross_pln: 445.00 }), costs), null)
    // mała kwota: 10 zł → tolerancja 2 zł
    const small = [{ id: 's', date: '2026-08-15', amount: 10, description: 'GOOGLE', reference: '' }]
    assert.equal(findMt940Duplicate(baseDoc({ gross_pln: 11.9 }), small)?.duplicate_of, 'mt940:s')
    assert.equal(findMt940Duplicate(baseDoc({ gross_pln: 12.5 }), small), null)
  })
  it('poza oknem ±60 dni → brak', () => {
    assert.equal(findMt940Duplicate(baseDoc({ doc_date: '2026-05-01' }), [costs[1]]), null)
  })
  it('bez wspólnego tokenu nazwy → brak', () => {
    assert.equal(findMt940Duplicate(baseDoc(), [costs[2]]), null)
  })
  it('kwota ujemna w wyciągu traktowana jak wartość bezwzględna', () => {
    const neg = [{ id: 'n', date: '2026-08-15', amount: -431.80, description: 'GOOGLE', reference: '' }]
    assert.equal(findMt940Duplicate(baseDoc(), neg)?.duplicate_of, 'mt940:n')
  })
})

describe('(c) inny dokument', () => {
  const docs = [
    { id: 'd1', seller_name: 'Google Ireland Limited', seller_nip: '', doc_number: 'INV-2026-000123', gross_pln: 431.80, status: 'approved' },
    { id: 'd2', seller_name: 'Google Ireland Limited', seller_nip: '', doc_number: 'INV-2026-000123', gross_pln: 431.80, status: 'rejected' },
  ]
  it('ten sam numer i sprzedawca (status ≠ rejected) → document:<id>', () => {
    const hit = findDocumentDuplicate(baseDoc(), docs)
    assert.equal(hit?.duplicate_of, 'document:d1')
    assert.match(hit!.note, /dwa razy/)
  })
  it('odrzucony dokument nie jest duplikatem', () => {
    assert.equal(findDocumentDuplicate(baseDoc(), [docs[1]]), null)
  })
  it('pomija samego siebie', () => {
    assert.equal(findDocumentDuplicate(baseDoc({ id: 'd1' }), [docs[0]]), null)
  })
  it('ten sam numer, inny sprzedawca → brak', () => {
    const other = [{ id: 'd3', seller_name: 'Hydraulik', seller_nip: '', doc_number: 'INV-2026-000123', gross_pln: 431.80, status: 'pending' }]
    assert.equal(findDocumentDuplicate(baseDoc(), other), null)
  })
})

describe('findDuplicate — kolejność i brak trafień', () => {
  it('brak trafień → null', () => {
    assert.equal(findDuplicate(baseDoc(), emptyCtx()), null)
  })
  it('KSeF ma pierwszeństwo przed dokumentem i MT940', () => {
    const ctx: DupContext = {
      ksefIncoming: [{ id: 'k', seller_nip: '1234567890', seller_name: 'Google', invoice_number: 'X', gross_amount: 431.80, invoice_date: null }],
      mt940Costs: [{ id: 'm', date: '2026-08-15', amount: 431.80, description: 'GOOGLE', reference: '' }],
      documents: [{ id: 'd', seller_name: 'Google Ireland', doc_number: 'INV-2026-000123', gross_pln: 431.80, status: 'pending' }],
    }
    assert.equal(findDuplicate(baseDoc({ seller_nip: '1234567890' }), ctx)?.duplicate_of, 'ksef:k')
  })
  it('dokument ma pierwszeństwo przed MT940', () => {
    const ctx: DupContext = {
      ksefIncoming: [],
      mt940Costs: [{ id: 'm', date: '2026-08-15', amount: 431.80, description: 'GOOGLE', reference: '' }],
      documents: [{ id: 'd', seller_name: 'Google Ireland', doc_number: 'INV-2026-000123', gross_pln: 431.80, status: 'pending' }],
    }
    assert.equal(findDuplicate(baseDoc(), ctx)?.duplicate_of, 'document:d')
  })
  it('dokument bez kwoty PLN (brak kursu) nie dopasowuje się po kwocie', () => {
    const ctx: DupContext = {
      ksefIncoming: [{ id: 'k', seller_nip: '1234567890', seller_name: 'Google', invoice_number: 'X', gross_amount: 0, invoice_date: null }],
      mt940Costs: [{ id: 'm', date: '2026-08-15', amount: 0, description: 'GOOGLE', reference: '' }],
      documents: [],
    }
    assert.equal(findDuplicate(baseDoc({ gross_pln: 0, seller_nip: '1234567890' }), ctx), null)
  })
})
