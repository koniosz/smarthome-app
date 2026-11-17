/**
 * Testy czystych funkcji wysyłki raportu „Kondycja firmy" (bez bazy i SMTP).
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/finance-report.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sendingInProgress, SENDING_IN_PROGRESS_MS, payrollHtml } from '../services/finance-report'

describe('payrollHtml — blok „Koszty pracy" w raporcie', () => {
  const paid = { salaries: 30000, pit4: 2400, zus: 12000, zus_estimate: 0, pit4_estimate: 0, total: 44400, estimated_months: [] as string[] }

  test('bez szacunku: wynagrodzenia, PIT-4, ZUS, razem — i informacja, skąd są kwoty', () => {
    const html = payrollHtml(paid)
    for (const s of ['Koszty pracy', 'Wynagrodzenia', 'PIT-4', 'ZUS', 'Razem koszty pracy']) assert.ok(html.includes(s), `brak: ${s}`)
    assert.match(html, /30 000 zł/)
    assert.match(html, /2 400 zł/)
    assert.match(html, /12 000 zł/)
    assert.match(html, /44 400 zł/)
    assert.ok(!html.includes('szacunek'), 'bez szacunku nie wspominamy o szacunku')
    assert.match(html, /przypisane do miesiąca, którego dotyczą/)
    assert.ok(!/src=|<link|<script/.test(html), 'bez zasobów zewnętrznych')
  })

  test('z szacunkiem: wiersz „w tym szacunek" z podziałem i JEDNO zdanie wyjaśnienia z miesiącami', () => {
    const html = payrollHtml({ salaries: 30000, pit4: 800, zus: 4000, zus_estimate: 8000, pit4_estimate: 1600, total: 44400, estimated_months: ['2026-08', '2026-09'] })
    assert.match(html, /w tym szacunek/)
    assert.match(html, /9 600 zł/)                                        // szacunek razem
    assert.match(html, /ZUS 8 000 zł · PIT-4 1 600 zł — przelewu jeszcze nie było/)
    assert.match(html, /12 000 zł/)                                       // ZUS zapłacony + szacunek
    assert.match(html, /2 400 zł/)                                        // PIT-4 zapłacony + szacunek
    assert.match(html, /ZUS i PIT-4 za Sierpień 2026 i Wrzesień 2026 to na razie szacunek \(9 600 zł\)/)
    assert.equal(html.split('to na razie szacunek').length - 1, 1)
    assert.match(html, /zastąpią go rzeczywiste kwoty/)
  })

  test('trzy miesiące z szacunkiem — lista z przecinkiem i „i"; brak listy miesięcy — „ten okres"', () => {
    const three = payrollHtml({ ...paid, zus: 0, zus_estimate: 12000, estimated_months: ['2026-07', '2026-08', '2026-09'] })
    assert.match(three, /za Lipiec 2026, Sierpień 2026 i Wrzesień 2026 to na razie szacunek/)
    const none = payrollHtml({ ...paid, zus: 0, zus_estimate: 12000, estimated_months: [] })
    assert.match(none, /za ten okres to na razie szacunek/)
  })

  test('brak kosztów pracy (albo brak pola w starszej odpowiedzi) → jedno zdanie, bez tabeli', () => {
    for (const html of [payrollHtml({ ...paid, salaries: 0, pit4: 0, zus: 0, total: 0 }), payrollHtml(undefined)]) {
      assert.match(html, /Koszty pracy/)
      assert.match(html, /nie ma przelewów wynagrodzeń, PIT-4 ani ZUS/)
      assert.match(html, /sprawdź, czy wyciąg bankowy za ten okres jest wgrany/)
      assert.ok(!html.includes('<table'))
    }
  })
})

describe('sendingInProgress — blokada ponownej wysyłki przy wpisie „sending"', () => {
  const now = new Date('2026-09-10T10:00:00.000Z')
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

  test('świeży wpis „sending" (< 2 h) = wysyłka w toku', () => {
    assert.equal(sendingInProgress([{ status: 'sending', created_at: ago(5 * 60 * 1000) }], now), true)
    assert.equal(sendingInProgress([{ status: 'sending', created_at: ago(SENDING_IN_PROGRESS_MS - 1000) }], now), true)
  })

  test('stary wpis „sending" (≥ 2 h) nie blokuje — traktujemy jak nieudaną wysyłkę', () => {
    assert.equal(sendingInProgress([{ status: 'sending', created_at: ago(SENDING_IN_PROGRESS_MS + 1000) }], now), false)
    assert.equal(sendingInProgress([{ status: 'sending', created_at: ago(26 * 60 * 60 * 1000) }], now), false)
  })

  test('inne statusy (sent/incomplete/failed) i brak logów nie blokują', () => {
    assert.equal(sendingInProgress([], now), false)
    assert.equal(sendingInProgress([
      { status: 'sent', created_at: ago(1000) },
      { status: 'incomplete', created_at: ago(1000) },
      { status: 'failed', created_at: ago(1000) },
    ], now), false)
  })

  test('mieszanka: jeden świeży „sending" wśród starych → w toku; zepsuta data nie blokuje', () => {
    assert.equal(sendingInProgress([
      { status: 'sending', created_at: ago(3 * 60 * 60 * 1000) },
      { status: 'sending', created_at: ago(60 * 1000) },
    ], now), true)
    assert.equal(sendingInProgress([{ status: 'sending', created_at: 'nie-data' }], now), false)
  })
})
