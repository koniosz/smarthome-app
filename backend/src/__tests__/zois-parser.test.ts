/**
 * Testy parsera zestawienia obrotów i sald (ZOiS) — czyste funkcje, bez bazy.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/zois-parser.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  parseZoisRows, mapZoisToLines, parseDelimited, detectSeparator, decodeZoisBuffer, decodeCp1250,
  diffZoisRows, parseZoisFile, dropParentAccounts, accountSynthetic, isNumericCell, normText, MAX_ZOIS_ROWS,
} from '../utils/zoisParser'

// ── Fixture 1: Comarch Optima — CSV z separatorem `;`, polskie liczby, tytuł nad tabelą, „Razem” ──
const OPTIMA_CSV = [
  'Zestawienie obrotów i sald;;;',
  'Okres: 2026-08;;;',
  'Numer konta;Nazwa konta;Obroty Wn;Obroty Ma',
  '401;Zużycie materiałów i energii;3 500,00;0,00',
  '401-01;Materiały;3 000,00;0,00',
  '401-02;Energia;500,00;0,00',
  '402;Usługi obce;"12 345,67";100,00',
  '404;Wynagrodzenia;20 000,00;0,00',
  '405;Ubezpieczenia społeczne;4 100,50;0,00',
  '490;Rozliczenie kosztów;0,00;39 946,17',
  '701;Sprzedaż usług;1 000,00;80 000,00',
  '751;Koszty finansowe;250,00;0,00',
  '871;Podatek dochodowy;900,00;0,00',
  'Razem;;42 095,67;120 046,17',
].join('\r\n')

describe('Comarch Optima CSV (;)', () => {
  test('wykrywa separator, nagłówek i kolumny; pomija tytuł, syntetykę 401 i wiersz Razem', () => {
    assert.equal(detectSeparator(OPTIMA_CSV), ';')
    const rows = parseDelimited(OPTIMA_CSV, ';')
    const { rows: out, detected, warnings } = parseZoisRows(rows)
    assert.deepEqual(detected, { account_col: 0, name_col: 1, debit_col: 2, credit_col: 3, header_row: 2, has_period_and_ytd: false })
    assert.deepEqual(out.map(r => r.account), ['401-01', '401-02', '402', '404', '405', '490', '701', '751', '871'])
    assert.equal(out.find(r => r.account === '402')!.debit, 12345.67)
    assert.equal(out.find(r => r.account === '402')!.name, 'Usługi obce')
    assert.equal(out.find(r => r.account === '701')!.credit, 80000)
    assert.ok(warnings.some(w => w.includes('401')), 'ostrzeżenie o pominiętej syntetyce')
  })

  test('mapuje na linie RZiS księgowej (koszty Wn−Ma, przychód Ma−Wn, 490 pominięte)', () => {
    const { rows } = parseZoisRows(parseDelimited(OPTIMA_CSV, ';'))
    const L = mapZoisToLines(rows)
    assert.equal(L.revenue, 79000)
    assert.equal(L.other_revenue, 0)
    assert.equal(L.materials, 3500)          // tylko analityki 401-01 + 401-02
    assert.equal(L.services, 12245.67)       // 12 345,67 − 100,00
    assert.equal(L.salaries, 20000)
    assert.equal(L.social, 4100.5)
    assert.equal(L.financial_costs, 250)
    assert.equal(L.cit, 900)
    assert.equal(L.depreciation, 0)
    assert.equal(L.costs_total, 40096.17)
    assert.equal(L.result, 38003.83)
    assert.equal(L.source_classes, '4')
    assert.deepEqual(L.warnings, [])
  })

  test('cały plik przez parseZoisFile (bufor utf-8 z BOM)', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(OPTIMA_CSV, 'utf-8')])
    const rows = parseZoisFile(buf, 'zois_2026-08.csv')
    const { rows: out } = parseZoisRows(rows)
    assert.equal(out.length, 9)
    assert.equal(out[0].name, 'Materiały')
  })
})

// ── Fixture 2: Symfonia — tablica jak z XLSX (liczby surowe), BO / Obroty / Saldo w jednym wierszu ──
const SYMFONIA_TABLE: any[][] = [
  ['Zestawienie obrotów i sald za sierpień 2026'],
  ['Konto', 'Nazwa konta', 'BO Wn', 'BO Ma', 'Obroty Wn', 'Obroty Ma', 'Saldo Wn', 'Saldo Ma'],
  ['400', 'Amortyzacja', 1000, 0, 500, 0, 1500, 0],
  ['402', 'Usługi obce', 8000, 0, '2 200,00', '0,00', 10200, 0],
  ['700-1', 'Sprzedaż towarów', 0, 5000, 0, 2000, 0, 7000],
  ['700-2', 'Sprzedaż usług', 0, 1000, 0, '3 000,00', 0, 4000],
  ['760', 'Pozostałe przychody operacyjne', 0, 0, 10, 60, 0, 50],
  ['Razem', '', 9000, 6000, 2710, 5060, 11700, 11050],
]

describe('Symfonia XLSX-like', () => {
  test('bierze kolumny Obroty (nie BO ani Saldo), ignoruje tytuł nad tabelą', () => {
    const { rows, detected } = parseZoisRows(SYMFONIA_TABLE)
    assert.equal(detected.header_row, 1)
    assert.equal(detected.account_col, 0)
    assert.equal(detected.name_col, 1)
    assert.equal(detected.debit_col, 4)
    assert.equal(detected.credit_col, 5)
    assert.equal(detected.has_period_and_ytd, false)
    assert.deepEqual(rows.map(r => r.account), ['400', '402', '700-1', '700-2', '760'])
    const L = mapZoisToLines(rows)
    assert.equal(L.depreciation, 500)
    assert.equal(L.services, 2200)
    assert.equal(L.revenue, 5000)
    assert.equal(L.other_revenue, 50)
    assert.equal(L.costs_total, 2700)
    assert.equal(L.result, 2350)
  })

  test('prawdziwy plik XLSX (round-trip przez bibliotekę xlsx)', () => {
    const ws = XLSX.utils.aoa_to_sheet(SYMFONIA_TABLE)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ZOiS')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const rows = parseZoisFile(buf, 'zois.xlsx')
    const { rows: out } = parseZoisRows(rows)
    const L = mapZoisToLines(out)
    assert.equal(out.length, 5)
    assert.equal(L.revenue, 5000)
    assert.equal(L.services, 2200)
    assert.equal(L.depreciation, 500)
  })

  test('XLSX rozpoznany po sygnaturze ZIP nawet bez rozszerzenia', () => {
    const ws = XLSX.utils.aoa_to_sheet(SYMFONIA_TABLE)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Arkusz1')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const { rows } = parseZoisRows(parseZoisFile(buf, 'zestawienie'))
    assert.equal(rows.length, 5)
  })
})

// ── Fixture 3: „Obroty okresu” i „Obroty narastająco” — nagłówek dwuwierszowy (scalone komórki) ──
const PERIOD_YTD_TABLE: any[][] = [
  ['Konto', 'Nazwa', 'Obroty okresu', '', 'Obroty narastająco', '', 'Saldo', ''],
  ['', '', 'Wn', 'Ma', 'Wn', 'Ma', 'Wn', 'Ma'],
  ['402', 'Usługi obce', '1 200,00', '0,00', '9 800,00', '0,00', '9 800,00', '0,00'],
  ['404', 'Wynagrodzenia', '15 000,00', '0,00', '120 000,00', '0,00', '120 000,00', '0,00'],
  ['701', 'Sprzedaż', '0,00', '5 000,00', '0,00', '40 000,00', '0,00', '40 000,00'],
]

describe('Obroty okresu + narastająco', () => {
  test('nagłówek dwuwierszowy: bierze okresu, ustawia flagę has_period_and_ytd', () => {
    const { rows, detected, warnings } = parseZoisRows(PERIOD_YTD_TABLE)
    assert.equal(detected.header_row, 1)
    assert.equal(detected.account_col, 0)
    assert.equal(detected.name_col, 1)
    assert.equal(detected.debit_col, 2)
    assert.equal(detected.credit_col, 3)
    assert.equal(detected.has_period_and_ytd, true)
    assert.ok(warnings.some(w => /okresu/.test(w)))
    const L = mapZoisToLines(rows)
    assert.equal(L.services, 1200)
    assert.equal(L.salaries, 15000)
    assert.equal(L.revenue, 5000)
  })

  test('nagłówek jednowierszowy z narastająco PRZED okresem (Optima Dt/Ct) — nadal okres', () => {
    const table: any[][] = [
      ['Numer', 'Nazwa', 'BO Dt', 'BO Ct', 'Obroty narastająco Dt', 'Obroty narastająco Ct', 'Obroty okresu Dt', 'Obroty okresu Ct', 'Saldo Dt', 'Saldo Ct'],
      ['401-1', 'Materiały', '0,00', '0,00', '7 000,00', '0,00', '700,00', '0,00', '7 000,00', '0,00'],
      ['701', 'Sprzedaż', '0,00', '0,00', '0,00', '30 000,00', '0,00', '4 000,00', '0,00', '30 000,00'],
    ]
    const { rows, detected } = parseZoisRows(table)
    assert.equal(detected.debit_col, 6)
    assert.equal(detected.credit_col, 7)
    assert.equal(detected.has_period_and_ytd, true)
    const L = mapZoisToLines(rows)
    assert.equal(L.materials, 700)
    assert.equal(L.revenue, 4000)
  })

  test('nagłówek „Winien / Ma” + Debet/Kredyt też rozpoznawany', () => {
    const table: any[][] = [
      ['Symbol', 'Nazwa', 'Winien', 'Ma'],
      ['403', 'Podatki i opłaty', '350,00', '0,00'],
    ]
    const { rows, detected } = parseZoisRows(table)
    assert.equal(detected.debit_col, 2)
    assert.equal(detected.credit_col, 3)
    assert.equal(mapZoisToLines(rows).taxes_fees, 350)
  })
})

// ── Fixture 4: brak nagłówka ──────────────────────────────────────────────────
describe('Plik bez nagłówka', () => {
  test('kolumna 0 = konto, ostatnie dwie liczbowe = Wn/Ma + ostrzeżenie', () => {
    const table: any[][] = [
      ['401-01', 'Materiały', '1 200,00', '0,00'],
      ['405', 'ZUS', '2 000,00', '0,00'],
      ['701', 'Sprzedaż usług', '0,00', '10 000,00'],
      ['Razem', '', '3 200,00', '10 000,00'],
    ]
    const { rows, detected, warnings } = parseZoisRows(table)
    assert.equal(detected.header_row, -1)
    assert.equal(detected.account_col, 0)
    assert.equal(detected.name_col, 1)
    assert.equal(detected.debit_col, 2)
    assert.equal(detected.credit_col, 3)
    assert.ok(warnings.some(w => /nagłówka/i.test(w)))
    assert.deepEqual(rows.map(r => [r.account, r.debit, r.credit]), [['401-01', 1200, 0], ['405', 2000, 0], ['701', 0, 10000]])
    const L = mapZoisToLines(rows)
    assert.equal(L.materials, 1200)
    assert.equal(L.social, 2000)
    assert.equal(L.revenue, 10000)
  })

  test('bez nagłówka z dodatkowymi kolumnami (BO, Saldo) — bierze ostatnie dwie liczbowe', () => {
    const table: any[][] = [
      ['402 Usługi obce', '100,00', '0,00', '250,00', '0,00'],
    ]
    const { rows } = parseZoisRows(table)
    assert.equal(rows[0].account, '402')
    assert.equal(rows[0].name, 'Usługi obce')
    assert.equal(rows[0].debit, 250)
    assert.equal(rows[0].credit, 0)
  })

  test('plik bez kont → pusta lista + ostrzeżenie, nie rzuca', () => {
    const { rows, detected, warnings } = parseZoisRows([['Lp', 'Opis'], ['1', 'cokolwiek']])
    assert.equal(rows.length, 0)
    assert.equal(detected.header_row, -1)
    assert.equal(warnings.length, 1)
  })
})

// ── Mapowanie kont ────────────────────────────────────────────────────────────
describe('mapZoisToLines', () => {
  test('zespół 5 gdy brak zespołu 4 → other_costs + ostrzeżenie', () => {
    const L = mapZoisToLines([
      { account: '501', name: 'Koszty działalności', debit: 4000, credit: 100 },
      { account: '550', name: 'Koszty zarządu', debit: 1500, credit: 0 },
      { account: '580', name: 'Rozliczenie kosztów działalności', debit: 0, credit: 5400 },
      { account: '701', name: 'Sprzedaż', debit: 0, credit: 9000 },
    ])
    assert.equal(L.source_classes, '5')
    assert.equal(L.other_costs, 5400)
    assert.equal(L.costs_total, 5400)
    assert.equal(L.result, 3600)
    assert.ok(L.warnings.some(w => /zespołu 4/.test(w)))
  })

  test('zespół 4 obecny → zespół 5 ignorowany (nie podwaja kosztów)', () => {
    const L = mapZoisToLines([
      { account: '401', name: 'Materiały', debit: 1000, credit: 0 },
      { account: '501', name: 'Koszty działalności', debit: 1000, credit: 0 },
      { account: '490', name: 'Rozliczenie kosztów', debit: 0, credit: 1000 },
    ])
    assert.equal(L.source_classes, '4')
    assert.equal(L.materials, 1000)
    assert.equal(L.costs_total, 1000)
  })

  test('pełne mapowanie 40x/75x/76x/87x, zaokrąglenia', () => {
    const L = mapZoisToLines([
      { account: '400-1', name: 'Amortyzacja', debit: 333.335, credit: 0 },
      { account: '406', name: 'Pozostałe koszty', debit: 50, credit: 0 },
      { account: '409', name: 'Pozostałe koszty rodzajowe', debit: 25, credit: 5 },
      { account: '750', name: 'Przychody finansowe', debit: 0, credit: 12.5 },
      { account: '751', name: 'Koszty finansowe', debit: 40, credit: 0 },
      { account: '760', name: 'Pozostałe przychody operacyjne', debit: 0, credit: 100 },
      { account: '761', name: 'Pozostałe koszty operacyjne', debit: 30, credit: 0 },
      { account: '731', name: 'Sprzedaż towarów', debit: 200, credit: 10200 },   // nazwa „sprzedaż” → przychód mimo numeru 731
      { account: '870', name: 'CIT', debit: 950, credit: 50 },
      { account: '860', name: 'Wynik finansowy', debit: 0, credit: 999 },   // bilansowe — ignorowane
      { account: '201', name: 'Rozrachunki', debit: 5000, credit: 3000 },   // bilansowe — ignorowane
    ])
    assert.equal(L.depreciation, 333.34)
    assert.equal(L.other_costs, 100)         // 50 + 20 + 30
    assert.equal(L.other_revenue, 112.5)
    assert.equal(L.financial_costs, 40)
    assert.equal(L.revenue, 10000)
    assert.equal(L.cit, 900)
    assert.equal(L.costs_total, 473.34)
    assert.equal(L.result, 8739.16)           // 10000 + 112.5 − 473.34 − 900
    assert.deepEqual(L.warnings, [])
  })

  test('konta poza mapowaniem z obrotami → ostrzeżenie', () => {
    const L = mapZoisToLines([{ account: '771', name: 'Straty nadzwyczajne', debit: 10, credit: 0 }])
    assert.ok(L.warnings.some(w => w.includes('771')))
  })

  // Firma handlowa: 730 sprzedaż towarów (Ma), 731 wartość sprzedanych towarów w cenach zakupu (Wn — KOSZT, nie netować z przychodem)
  test('731 „Wartość sprzedanych towarów” → cogs w costs_total, przychód brutto, wynik bez zmian', () => {
    const L = mapZoisToLines([
      { account: '730', name: 'Sprzedaż towarów', debit: 0, credit: 300000 },
      { account: '731', name: 'Wartość sprzedanych towarów w cenach zakupu', debit: 180000, credit: 0 },
      { account: '401', name: 'Zużycie materiałów', debit: 90000, credit: 0 },
    ])
    assert.equal(L.revenue, 300000)
    assert.equal(L.cogs, 180000)
    assert.equal(L.materials, 90000)
    assert.equal(L.costs_total, 270000)
    assert.equal(L.result, 30000)
    assert.deepEqual(L.warnings, [])
  })

  test('koszt sprzedanych po nazwie (701 „Koszt sprzedanych produktów”, „koszt własny”), 740 sprzedaż materiałów → przychód, 741 → cogs', () => {
    const L = mapZoisToLines([
      { account: '700', name: 'Sprzedaż produktów', debit: 0, credit: 50000 },
      { account: '701', name: 'Koszt sprzedanych produktów', debit: 20000, credit: 500 },
      { account: '711', name: 'Koszt własny sprzedaży', debit: 1000, credit: 0 },
      { account: '740', name: 'Sprzedaż materiałów', debit: 0, credit: 3000 },
      { account: '741', name: 'Wartość sprzedanych materiałów w cenie zakupu', debit: 2000, credit: 0 },
    ])
    assert.equal(L.revenue, 53000)
    assert.equal(L.cogs, 22500)
    assert.equal(L.costs_total, 22500)
    assert.equal(L.result, 30500)
    assert.deepEqual(L.warnings, [])   // 740/741 nie są już „pominięte”
  })

  test('bez nazwy: 731/741 z saldem Wn → cogs, 701 z saldem Ma → przychód', () => {
    const L = mapZoisToLines([
      { account: '701', name: '', debit: 0, credit: 8000 },
      { account: '731', name: '', debit: 5000, credit: 100 },
      { account: '741-1', name: 'Towary', debit: 700, credit: 0 },
    ])
    assert.equal(L.revenue, 8000)
    assert.equal(L.cogs, 5600)
    assert.equal(L.costs_total, 5600)
    assert.equal(L.result, 2400)
    assert.deepEqual(L.warnings, [])
  })

  test('konto przychodowe z obrotem netto Wn → liczone jako przychód (ujemny) + ostrzeżenie', () => {
    const L = mapZoisToLines([
      { account: '702', name: 'Sprzedaż usług', debit: 500, credit: 0 },
      { account: '733', name: '', debit: 900, credit: 0 },
    ])
    assert.equal(L.revenue, -1400)
    assert.equal(L.cogs, 0)
    assert.ok(L.warnings.some(w => w.includes('702') && w.includes('733') && /Wn/.test(w)))
  })
})

// ── Syntetyki / analityki ─────────────────────────────────────────────────────
describe('dropParentAccounts', () => {
  test('separatory -, ., / oraz wielopoziomowe analityki', () => {
    const { rows, dropped } = dropParentAccounts([
      { account: '401', name: '', debit: 10, credit: 0 },
      { account: '401-1', name: '', debit: 10, credit: 0 },
      { account: '401-1-01', name: '', debit: 6, credit: 0 },
      { account: '401-1-02', name: '', debit: 4, credit: 0 },
      { account: '402', name: '', debit: 3, credit: 0 },
      { account: '402.01', name: '', debit: 3, credit: 0 },
      { account: '403', name: '', debit: 2, credit: 0 },
      { account: '403/1', name: '', debit: 2, credit: 0 },
      { account: '404', name: '', debit: 7, credit: 0 },
    ])
    assert.deepEqual(dropped, ['401', '401-1', '402', '403'])
    assert.deepEqual(rows.map(r => r.account), ['401-1-01', '401-1-02', '402.01', '403/1', '404'])
  })

  test('4011 traktowane jako analityka 401 (konta bez separatora)', () => {
    const { rows } = dropParentAccounts([
      { account: '401', name: '', debit: 5, credit: 0 },
      { account: '4011', name: '', debit: 5, credit: 0 },
    ])
    assert.deepEqual(rows.map(r => r.account), ['4011'])
  })

  test('nie-separator po prefiksie („401!”, „401a”) i wspólny prefiks bez relacji (40, 4011-x vs 401) — nie są rodzicami', () => {
    const { rows, dropped } = dropParentAccounts([
      { account: '401', name: '', debit: 1, credit: 0 },
      { account: '401!', name: '', debit: 1, credit: 0 },
      { account: '401a', name: '', debit: 1, credit: 0 },
      { account: '402', name: '', debit: 1, credit: 0 },
      { account: '4021-01', name: '', debit: 1, credit: 0 },   // analityka 4021, nie 402 (po „402” stoi „1”)
    ])
    assert.deepEqual(dropped, [])
    assert.equal(rows.length, 5)
  })

  test('duży plik w kształcie dziennika (80 000 wierszy, powtarzające się analityki) — liniowo, poprawny wynik', () => {
    const rows = []
    for (let i = 0; i < 80000; i++) {
      const synth = 400 + (i % 10)
      rows.push({ account: `${synth}-${(i % 35) + 1}-${String(i % 7).padStart(2, '0')}`, name: '', debit: 1, credit: 0 })
    }
    rows.push({ account: '401', name: '', debit: 0, credit: 0 })
    rows.push({ account: '401-2', name: '', debit: 0, credit: 0 })   // ma analityki 401-2-01 (i ≡ 1 mod 10 i mod 35)
    rows.push({ account: '409-x', name: '', debit: 0, credit: 0 })   // „409-x” nie ma analityk → zostaje
    const t0 = Date.now()
    const { rows: kept, dropped } = dropParentAccounts(rows)
    const ms = Date.now() - t0
    assert.deepEqual(dropped, ['401', '401-2'])
    assert.equal(kept.length, 80001)
    assert.ok(ms < 5000, `dropParentAccounts trwało ${ms} ms (powinno być liniowe)`)
  })
})

// ── Limit wierszy: dziennik/zapisy na kontach zamiast ZOiS ───────────────────
describe('limit wierszy', () => {
  test(`ponad ${MAX_ZOIS_ROWS} wierszy → pusta lista + ostrzeżenie, nie liczy`, () => {
    const rows: any[][] = [['Konto', 'Nazwa', 'Wn', 'Ma']]
    for (let i = 0; i <= MAX_ZOIS_ROWS; i++) rows.push([`401-${i}`, 'x', '1,00', '0,00'])
    const { rows: out, warnings } = parseZoisRows(rows)
    assert.equal(out.length, 0)
    assert.ok(warnings.some(w => /wierszy/.test(w) && w.includes(String(MAX_ZOIS_ROWS))))
  })

  test(`dokładnie ${MAX_ZOIS_ROWS} wierszy przechodzi`, () => {
    const rows: any[][] = [['Konto', 'Nazwa', 'Wn', 'Ma']]
    for (let i = 1; i < MAX_ZOIS_ROWS; i++) rows.push([`401-${i}`, 'x', '1,00', '0,00'])
    assert.equal(rows.length, MAX_ZOIS_ROWS)
    const { rows: out } = parseZoisRows(rows)
    assert.equal(out.length, MAX_ZOIS_ROWS - 1)
  })
})

// ── Kodowanie i CSV ───────────────────────────────────────────────────────────
describe('kodowanie i separatory', () => {
  test('cp1250 → polskie litery (Zużycie, Łącznie)', () => {
    const buf = Buffer.from([0x5a, 0x75, 0xbf, 0x79, 0x63, 0x69, 0x65, 0x20, 0xa3, 0xb9, 0x63, 0x7a, 0x6e, 0x69, 0x65])
    assert.equal(decodeCp1250(buf), 'Zużycie Łącznie')
    assert.equal(decodeZoisBuffer(buf), 'Zużycie Łącznie')   // utf-8 daje „�” → fallback
  })

  test('utf-8 przechodzi bez zmian, BOM usunięty', () => {
    assert.equal(decodeZoisBuffer(Buffer.from('﻿Konto;Nazwa\n401;Zużycie', 'utf-8')), 'Konto;Nazwa\n401;Zużycie')
  })

  test('utf-16le (Excel „Tekst Unicode”)', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Konto\tNazwa\r\n401\tZużycie', 'utf16le')])
    assert.equal(decodeZoisBuffer(buf), 'Konto\tNazwa\r\n401\tZużycie')
  })

  test('detectSeparator: ; / tab / ,', () => {
    assert.equal(detectSeparator('Konto;Nazwa;Wn;Ma\n401;Materiały;1,50;0,00'), ';')
    assert.equal(detectSeparator('Konto\tNazwa\tWn\tMa\n401\tMateriały\t1,50\t0,00'), '\t')
    assert.equal(detectSeparator('Konto,Nazwa,Wn,Ma\n401,Materials,1.50,0.00'), ',')
  })

  test('parseDelimited: cudzysłowy z separatorem w środku i puste wiersze', () => {
    const rows = parseDelimited('a;"b;c";d\n\n1;"x ""y""";3\n', ';')
    assert.deepEqual(rows, [['a', 'b;c', 'd'], ['1', 'x "y"', '3']])
  })

  test('CSV z przecinkiem i liczbami w cudzysłowach', () => {
    const csv = 'Konto,Nazwa,Wn,Ma\n402,"Usługi, obce","1 234,56","0,00"\n701,Sprzedaż,"0,00","9 999,99"'
    const rows = parseZoisFile(Buffer.from(csv, 'utf-8'), 'zois.csv')
    const { rows: out } = parseZoisRows(rows)
    assert.equal(out[0].name, 'Usługi, obce')
    assert.equal(out[0].debit, 1234.56)
    assert.equal(out[1].credit, 9999.99)
  })
})

// ── Narastająco → miesiąc ─────────────────────────────────────────────────────
describe('diffZoisRows', () => {
  test('odejmuje po kontach; nowe konta w całości; brakujące jako storno', () => {
    const cur = [
      { account: '401-01', name: 'Materiały', debit: 9000, credit: 0 },
      { account: '402', name: 'Usługi', debit: 5000, credit: 100 },
      { account: '701', name: 'Sprzedaż', debit: 0, credit: 40000 },
    ]
    const prev = [
      { account: '401-01', name: 'Materiały', debit: 8000, credit: 0 },
      { account: '701', name: 'Sprzedaż', debit: 0, credit: 35000.5 },
      { account: '403', name: 'Podatki', debit: 120, credit: 0 },
    ]
    const d = diffZoisRows(cur, prev)
    const by = Object.fromEntries(d.map(r => [r.account, r]))
    assert.equal(by['401-01'].debit, 1000)
    assert.equal(by['402'].debit, 5000)
    assert.equal(by['402'].credit, 100)
    assert.equal(by['701'].credit, 4999.5)
    assert.equal(by['403'].debit, -120)
    const L = mapZoisToLines(d)
    assert.equal(L.materials, 1000)
    assert.equal(L.services, 4900)
    assert.equal(L.taxes_fees, -120)
    assert.equal(L.revenue, 4999.5)
  })
})

// ── Drobne pomocnicze ─────────────────────────────────────────────────────────
describe('pomocnicze', () => {
  test('accountSynthetic / isNumericCell / normText', () => {
    assert.equal(accountSynthetic('401-01'), '401')
    assert.equal(accountSynthetic('7010'), '701')
    assert.equal(accountSynthetic('Razem'), '')
    assert.equal(isNumericCell('1 234,56'), true)
    assert.equal(isNumericCell('(1 200,50)'), true)
    assert.equal(isNumericCell('-'), true)
    assert.equal(isNumericCell('401-01'), false)
    assert.equal(isNumericCell('2026-08'), false)
    assert.equal(isNumericCell('Materiały'), false)
    assert.equal(normText('  Obroty  Narastająco Wn '), 'obroty narastajaco wn')
    assert.equal(normText('Zużycie Łącznie'), 'zuzycie lacznie')
  })
})
