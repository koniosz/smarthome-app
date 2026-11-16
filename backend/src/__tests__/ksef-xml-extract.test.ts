/**
 * Pozycje faktury (FaWiersz) i termin płatności z XML KSeF — czysty moduł ksef-xml-extract (bez bazy i sieci).
 * Fikstury są syntetyczne (zmyślone firmy, NIP-y, towary). Stara implementacja regexowa (usunięta
 * z ksef-lineitems.ts) jest tu skopiowana 1:1 jako WZORZEC do porównań na małych fiksturach —
 * nowy, liniowy odczyt ma dawać te same wyniki dla zwykłych faktur.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/ksef-xml-extract.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import {
  extractInvoiceDetails, parseLineItemsFromXml, parsePaymentDueDateFromXml, type InvoiceLineItem,
} from '../services/ksef-xml-extract'
import type { InvoiceLineItem as LegacyInvoiceLineItem } from '../services/ksef-lineitems'

// ── fikstury ────────────────────────────────────────────────────────────────

const NS_FA3 = 'http://crd.gov.pl/wzor/2025/06/25/13775/'

interface Row { nr?: string; fields: Record<string, string> }

/** Syntetyczna faktura FA(3). `p` = prefiks przestrzeni nazw z dwukropkiem ('' albo np. 'tns:'). */
function invoiceXml(opts: { p?: string; rows?: Row[]; payment?: string; extraFa?: string } = {}): string {
  const p = opts.p ?? ''
  const el = (name: string, body: string) => `<${p}${name}>${body}</${p}${name}>`
  const rows = (opts.rows ?? []).map(r => el('FaWiersz',
    (r.nr != null ? el('NrWierszaFa', r.nr) : '')
    + Object.entries(r.fields).map(([k, v]) => el(k, v)).join(''))).join('\n    ')
  const xmlns = p ? `xmlns:${p.slice(0, -1)}="${NS_FA3}"` : `xmlns="${NS_FA3}"`
  return `<?xml version="1.0" encoding="UTF-8"?>
<${p}Faktura ${xmlns}>
  <${p}Naglowek><${p}KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</${p}KodFormularza>${el('WariantFormularza', '3')}</${p}Naglowek>
  ${el('Podmiot1', el('DaneIdentyfikacyjne', el('NIP', '1111111111') + el('Nazwa', 'Hurtownia Testowa sp. z o.o.')))}
  ${el('Podmiot2', el('DaneIdentyfikacyjne', el('NIP', '2222222222') + el('Nazwa', 'Nabywca Testowy')))}
  <${p}Fa>
    ${el('KodWaluty', 'PLN')}${el('P_1', '2026-01-10')}${el('P_2', 'FV/TEST/1/2026')}
    ${el('P_13_1', '300.00')}${el('P_14_1', '69.00')}${el('P_15', '369.00')}
    ${el('RodzajFaktury', 'VAT')}
    ${opts.extraFa ?? ''}
    ${rows}
    ${opts.payment ?? ''}
  </${p}Fa>
</${p}Faktura>`
}

/** Platnosc z podanymi terminami (wartość = zawartość TerminPlatnosci > Termin). */
function paymentXml(terms: string[], p = ''): string {
  const el = (name: string, body: string) => `<${p}${name}>${body}</${p}${name}>`
  return el('Platnosc', terms.map(t => el('TerminPlatnosci', el('Termin', t))).join('') + el('FormaPlatnosci', '6'))
}

const ROWS: Row[] = [
  { nr: '1', fields: { P_7: 'Przewód YDY 3x2,5', P_8A: 'm', P_8B: '100', P_9A: '2.00', P_11: '200.00', P_12: '23' } },
  { nr: '2', fields: { P_7: 'Montaż gniazd', P_8A: 'usł.', P_8B: '1', P_9A: '100.00', P_11: '100.00', P_12: '8' } },
]
const ITEMS: InvoiceLineItem[] = [
  { nr: '1', name: 'Przewód YDY 3x2,5', unit: 'm', qty: '100', unitPrice: '2.00', netValue: '200.00', vatRate: '23' },
  { nr: '2', name: 'Montaż gniazd', unit: 'usł.', qty: '1', unitPrice: '100.00', netValue: '100.00', vatRate: '8' },
]

/** Nowy odczyt = stara implementacja regexowa (pozycje i termin), plus spójność trzech funkcji. */
function assertSameAsOld(xml: string): void {
  assert.deepEqual(parseLineItemsFromXml(xml), oldParseLineItemsFromXml(xml))
  assert.equal(parsePaymentDueDateFromXml(xml), oldParsePaymentDueDateFromXml(xml))
  assert.deepEqual(extractInvoiceDetails(xml), {
    items: parseLineItemsFromXml(xml), dueDate: parsePaymentDueDateFromXml(xml),
  })
}

// ── testy ───────────────────────────────────────────────────────────────────

describe('pozycje faktury (FaWiersz)', () => {
  test('domyślna przestrzeń nazw: wszystkie wiersze w kolejności z faktury', () => {
    const xml = invoiceXml({ rows: ROWS, payment: paymentXml(['2026-01-24']) })
    assert.deepEqual(parseLineItemsFromXml(xml), ITEMS)
    assert.deepEqual(extractInvoiceDetails(xml), { items: ITEMS, dueDate: '2026-01-24' })
    assertSameAsOld(xml)
  })

  test('przestrzeń nazw z prefiksem (tns:) — ten sam wynik', () => {
    const xml = invoiceXml({ p: 'tns:', rows: ROWS, payment: paymentXml(['2026-01-24'], 'tns:') })
    assert.deepEqual(extractInvoiceDetails(xml), { items: ITEMS, dueDate: '2026-01-24' })
    assertSameAsOld(xml)
  })

  test('kształt pozycji: dokładnie 7 pól tekstowych w stałej kolejności (tak jest zapisywana w bazie)', () => {
    const [item] = parseLineItemsFromXml(invoiceXml({ rows: ROWS }))
    assert.deepEqual(Object.keys(item), ['nr', 'name', 'unit', 'qty', 'unitPrice', 'netValue', 'vatRate'])
    for (const v of Object.values(item)) assert.equal(typeof v, 'string')
    const legacy: LegacyInvoiceLineItem = item // typ re-eksportowany z ksef-lineitems to ten sam typ
    assert.equal(legacy.name, 'Przewód YDY 3x2,5')
  })

  test('cena: P_9A, a gdy jej nie ma — P_9B; wartość: P_11, a gdy jej nie ma — P_11A', () => {
    const xml = invoiceXml({
      rows: [
        { nr: '1', fields: { P_7: 'Tylko brutto', P_8A: 'szt.', P_8B: '2', P_9B: '12.30', P_11A: '24.60', P_12: '23' } },
        { nr: '2', fields: { P_7: 'Netto i brutto', P_8A: 'szt.', P_8B: '1', P_9A: '10.00', P_9B: '12.30', P_11: '10.00', P_11A: '12.30', P_12: '23' } },
        { nr: '3', fields: { P_7: 'Bez ceny', P_8A: 'kpl.', P_8B: '1' } },
      ],
    })
    assert.deepEqual(parseLineItemsFromXml(xml), [
      { nr: '1', name: 'Tylko brutto', unit: 'szt.', qty: '2', unitPrice: '12.30', netValue: '24.60', vatRate: '23' },
      { nr: '2', name: 'Netto i brutto', unit: 'szt.', qty: '1', unitPrice: '10.00', netValue: '10.00', vatRate: '23' },
      { nr: '3', name: 'Bez ceny', unit: 'kpl.', qty: '1', unitPrice: '', netValue: '', vatRate: '' },
    ])
    assertSameAsOld(xml)
  })

  test('stawka VAT to surowa wartość P_12 (bez etykiet i znaku %)', () => {
    const rates = ['23', '8', '5', '0 KR', '0 WDT', 'zw', 'oo', 'np I', 'np II']
    const xml = invoiceXml({
      rows: rates.map((rate, i) => ({ nr: String(i + 1), fields: { P_7: `Pozycja ${i + 1}`, P_11: '1.00', P_12: rate } })),
    })
    assert.deepEqual(parseLineItemsFromXml(xml).map(i => i.vatRate), rates)
    assertSameAsOld(xml)
  })

  test('faktura korygująca: wiersze „stan przed” (StanPrzed = 1) zostają na liście', () => {
    const xml = invoiceXml({
      rows: [
        { nr: '1', fields: { P_7: 'Kabel UTP kat. 6', P_8A: 'm', P_8B: '305', P_9A: '1.50', P_11: '457.50', P_12: '23', StanPrzed: '1' } },
        { nr: '1', fields: { P_7: 'Kabel UTP kat. 6', P_8A: 'm', P_8B: '300', P_9A: '1.50', P_11: '450.00', P_12: '23' } },
      ],
    })
    assert.deepEqual(parseLineItemsFromXml(xml).map(i => [i.nr, i.qty, i.netValue]), [
      ['1', '305', '457.50'],
      ['1', '300', '450.00'],
    ])
    assertSameAsOld(xml)
  })

  test('wiersz bez nazwy (P_7) jest pomijany, pozostałe zostają', () => {
    const xml = invoiceXml({
      rows: [
        { nr: '1', fields: { P_11: '10.00', P_12: '23' } },
        { nr: '2', fields: { P_7: '   ', P_11: '5.00', P_12: '23' } },
        { nr: '3', fields: { P_7: 'Puszka podtynkowa', P_11: '3.00', P_12: '23' } },
      ],
    })
    assert.deepEqual(parseLineItemsFromXml(xml).map(i => i.nr), ['3'])
    assertSameAsOld(xml)
  })

  test('brak FaWiersz (np. faktura zaliczkowa z samym zamówieniem) → pusta lista, termin czytany normalnie', () => {
    const xml = invoiceXml({
      extraFa: '<Zamowienie><WartoscZamowienia>1230.00</WartoscZamowienia><ZamowienieWiersz><NrWierszaZam>1</NrWierszaZam>'
        + '<P_7Z>Rozdzielnica</P_7Z><P_8AZ>szt.</P_8AZ><P_8BZ>1</P_8BZ><P_9AZ>1000.00</P_9AZ><P_11NettoZ>1000.00</P_11NettoZ>'
        + '<P_12Z>23</P_12Z></ZamowienieWiersz></Zamowienie>',
      payment: paymentXml(['2026-02-14']),
    })
    assert.deepEqual(extractInvoiceDetails(xml), { items: [], dueDate: '2026-02-14' })
    assertSameAsOld(xml)
  })

  test('encje XML są dekodowane (zamierzona różnica względem starego regexu, który zostawiał je surowe)', () => {
    const xml = invoiceXml({
      rows: [
        { nr: '1', fields: { P_7: 'Rura &amp; z&#322;&#x105;czka &lt;fi 20&gt; &quot;PCV&quot; &apos;A&apos;', P_8A: 'szt.', P_8B: '1', P_9A: '1.00', P_11: '1.00', P_12: '23' } },
        { nr: '2', fields: { P_7: '<![CDATA[Listwa <biała> & zaślepka]]>', P_11: '2.00', P_12: '23' } },
      ],
    })
    assert.deepEqual(parseLineItemsFromXml(xml).map(i => i.name), [
      'Rura & złączka <fi 20> "PCV" \'A\'',
      'Listwa <biała> & zaślepka',
    ])
    // stara implementacja oddawała tekst źródłowy bez dekodowania
    assert.equal(oldParseLineItemsFromXml(xml)[0].name, 'Rura &amp; z&#322;&#x105;czka &lt;fi 20&gt; &quot;PCV&quot; &apos;A&apos;')
  })

  test('tekst wyglądający jak FaWiersz w komentarzu albo CDATA nie jest pozycją faktury', () => {
    const fake = '<FaWiersz><NrWierszaFa>99</NrWierszaFa><P_7>Podstawiona pozycja</P_7><P_11>1.00</P_11></FaWiersz>'
      + '<Platnosc><TerminPlatnosci><Termin>2099-12-31</Termin></TerminPlatnosci></Platnosc>'
    const xml = invoiceXml({
      rows: ROWS,
      payment: paymentXml(['2026-01-24']),
      extraFa: `<!-- ${fake} --><DodatkowyOpis><Klucz>uwagi</Klucz><Wartosc><![CDATA[${fake}]]></Wartosc></DodatkowyOpis>`,
    })
    assert.deepEqual(extractInvoiceDetails(xml), { items: ITEMS, dueDate: '2026-01-24' })
  })
})

describe('termin płatności (Platnosc > TerminPlatnosci > Termin)', () => {
  test('kilka terminów (raty) → najpóźniejszy, niezależnie od kolejności w pliku', () => {
    const xml = invoiceXml({ rows: ROWS, payment: paymentXml(['2026-03-15', '2026-05-15', '2026-04-15']) })
    assert.equal(parsePaymentDueDateFromXml(xml), '2026-05-15')
    assertSameAsOld(xml)
  })

  test('liczy się tylko data w formacie RRRR-MM-DD; opis terminu bez daty jest pomijany', () => {
    const xml = invoiceXml({
      rows: ROWS,
      payment: '<Platnosc>'
        + '<TerminPlatnosci><TerminOpis><Ilosc>14</Ilosc><Jednostka>dni</Jednostka><ZdarzeniePoczatkowe>odbiór</ZdarzeniePoczatkowe></TerminOpis></TerminPlatnosci>'
        + '<TerminPlatnosci><Termin>15.06.2026</Termin></TerminPlatnosci>'
        + '<TerminPlatnosci><Termin> 2026-02-28 </Termin></TerminPlatnosci>'
        + '</Platnosc>',
    })
    assert.equal(parsePaymentDueDateFromXml(xml), '2026-02-28')
    assertSameAsOld(xml)
  })

  test('brak terminu w XML → pusty tekst (a nie null)', () => {
    const noTerm = invoiceXml({ rows: ROWS, payment: '<Platnosc><Zaplacono>1</Zaplacono><DataZaplaty>2026-01-10</DataZaplaty></Platnosc>' })
    const noPayment = invoiceXml({ rows: ROWS })
    for (const xml of [noTerm, noPayment]) {
      assert.equal(parsePaymentDueDateFromXml(xml), '')
      assert.deepEqual(extractInvoiceDetails(xml), { items: ITEMS, dueDate: '' })
      assertSameAsOld(xml)
    }
  })
})

describe('wejście, które nie jest fakturą — nigdy nie rzuca', () => {
  test('pusty / uszkodzony / obcy dokument → [] i \'\'', () => {
    const valid = invoiceXml({ rows: ROWS, payment: paymentXml(['2026-01-24']) })
    const inputs: unknown[] = [
      '', '   ', null, undefined, 42, {}, [],
      'to nie jest XML',
      '{"exception":{"exceptionDetailList":[{"exceptionCode":21405}]}}',
      '<html><body><h1>503 Service Unavailable</h1></body></html>',
      valid.slice(0, valid.indexOf('</Fa>')),                       // plik ucięty w połowie
      valid.replace('</Faktura>', ''),                              // niedomknięty element główny
      '<Faktura xmlns="x"><Naglowek/></Faktura>',                   // brak elementu Fa
      '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>1</ID></Invoice>',
    ]
    for (const input of inputs) {
      assert.deepEqual(extractInvoiceDetails(input as string), { items: [], dueDate: '' })
      assert.deepEqual(parseLineItemsFromXml(input as string), [])
      assert.equal(parsePaymentDueDateFromXml(input as string), '')
    }
  })
})

describe('wrogi XML — koszt liniowy', () => {
  /**
   * ~1 MB: bez prawdziwych FaWiersz / TerminPlatnosci, ~1800 pól DodatkowyOpis, których wartości (CDATA)
   * to same niedomknięte „<FaWiersz>” i „<TerminPlatnosci>”. Dawne wzorce „<FaWiersz…>[\s\S]*?</FaWiersz>”
   * dla każdego takiego otwarcia skanowały plik do końca: ~4 s + ~4 s blokady pętli zdarzeń.
   */
  function hostileXml(count: number): string {
    const openers = '<FaWiersz><TerminPlatnosci>'
    const value = openers.repeat(Math.floor(500 / openers.length))
    const row = `<DodatkowyOpis><Klucz>k</Klucz><Wartosc><![CDATA[${value}]]></Wartosc></DodatkowyOpis>`
    return invoiceXml({ extraFa: row.repeat(count) })
  }

  test('plik ~1 MB z tysiącami niedomkniętych „<FaWiersz>” / „<TerminPlatnosci>” kończy się w ułamku sekundy', () => {
    const xml = hostileXml(1800)
    assert.ok(xml.length > 950_000 && xml.length < 1_100_000, `rozmiar ${xml.length}`)
    const started = performance.now()
    const details = extractInvoiceDetails(xml)
    const items = parseLineItemsFromXml(xml)
    const dueDate = parsePaymentDueDateFromXml(xml)
    const elapsed = performance.now() - started
    assert.deepEqual(details, { items: [], dueDate: '' })
    assert.deepEqual(items, [])
    assert.equal(dueDate, '')
    assert.ok(elapsed < 500, `3 odczyty pliku ${Math.round(xml.length / 1024)} KB trwały ${Math.round(elapsed)} ms (limit 500 ms)`)
  })

  test('to samo z prawdziwymi pozycjami i terminem: wynik poprawny, czas dalej liniowy', () => {
    const openers = '<FaWiersz><TerminPlatnosci>'
    const row = `<DodatkowyOpis><Klucz>k</Klucz><Wartosc><![CDATA[${openers.repeat(18)}]]></Wartosc></DodatkowyOpis>`
    const xml = invoiceXml({ rows: ROWS, payment: paymentXml(['2026-01-24']), extraFa: row.repeat(1800) })
    const started = performance.now()
    assert.deepEqual(extractInvoiceDetails(xml), { items: ITEMS, dueDate: '2026-01-24' })
    const elapsed = performance.now() - started
    assert.ok(elapsed < 500, `odczyt trwał ${Math.round(elapsed)} ms (limit 500 ms)`)
  })
})

describe('ksef-lineitems — dotychczasowe importy działają dalej', () => {
  test('parseLineItemsFromXml / parsePaymentDueDateFromXml są re-eksportowane z ksef-xml-extract', async () => {
    const legacy = await import('../services/ksef-lineitems')
    assert.equal(legacy.parseLineItemsFromXml, parseLineItemsFromXml)
    assert.equal(legacy.parsePaymentDueDateFromXml, parsePaymentDueDateFromXml)
    assert.equal(typeof legacy.fetchAndStoreInvoiceDetails, 'function')
    assert.equal(typeof legacy.getInvoiceLineItems, 'function')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// WZORZEC: stara implementacja z ksef-lineitems.ts skopiowana 1:1 (regexy o koszcie kwadratowym —
// wolno jej używać WYŁĄCZNIE na małych fiksturach powyżej, nigdy na wrogim wejściu).
// ═════════════════════════════════════════════════════════════════════════════

// wyciągnij tekst pierwszego z podanych tagów w obrębie fragmentu (ignoruje prefiks ns)
function tag(fragment: string, names: string[]): string {
  for (const name of names) {
    const m = fragment.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'))
    if (m && m[1] != null) return m[1].trim()
  }
  return ''
}

function oldParseLineItemsFromXml(xml: string): InvoiceLineItem[] {
  if (!xml) return []
  const blocks = xml.match(/<(?:[\w-]+:)?FaWiersz\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?FaWiersz>/gi) ?? []
  return blocks
    .map(block => ({
      nr:        tag(block, ['NrWierszaFa', 'NrWiersza']),
      name:      tag(block, ['P_7']),
      unit:      tag(block, ['P_8A']),
      qty:       tag(block, ['P_8B']),
      unitPrice: tag(block, ['P_9A', 'P_9B']),
      netValue:  tag(block, ['P_11', 'P_11A']),
      vatRate:   tag(block, ['P_12']),
    }))
    .filter(i => i.name)
}

function oldParsePaymentDueDateFromXml(xml: string): string {
  if (!xml) return ''
  const blocks = xml.match(/<(?:[\w-]+:)?TerminPlatnosci\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?TerminPlatnosci>/gi) ?? []
  const dates = blocks
    .map(b => tag(b, ['Termin']))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
  return dates.length ? dates[dates.length - 1] : ''
}
