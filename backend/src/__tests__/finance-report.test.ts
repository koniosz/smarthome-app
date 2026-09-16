/**
 * Testy czystych funkcji wysyłki raportu „Kondycja firmy" (bez bazy i SMTP).
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/finance-report.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sendingInProgress, SENDING_IN_PROGRESS_MS } from '../services/finance-report'

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
