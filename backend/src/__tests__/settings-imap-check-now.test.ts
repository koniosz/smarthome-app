/**
 * Testy blokady „Sprawdź teraz” (routes/settings-imap.ts → startCheckNow): sprawdzenie skrzynki startuje w tle
 * i odpowiada od razu; drugie wywołanie w trakcie → busy; blokada zwalniana po wyniku, błędzie i wyjątku.
 * Uruchom: cd backend && npx tsx --test src/__tests__/settings-imap-check-now.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startCheckNow } from '../routes/settings-imap'

const tick = () => new Promise<void>(r => setImmediate(r))
const settle = async () => { for (let i = 0; i < 5; i++) await tick() }

describe('startCheckNow — sprawdzenie skrzynki w tle', () => {
  it('odpowiada natychmiast { started, started_at } bez czekania na wynik', async () => {
    let resolve!: (v: any) => void
    let calls = 0
    const run = () => { calls++; return new Promise<any>(r => { resolve = r }) }
    const r = startCheckNow(run)
    assert.equal('started' in r && r.started, true)
    assert.match((r as any).started_at, /^\d{4}-\d{2}-\d{2}T/)
    await settle()
    assert.equal(calls, 1)
    resolve({ fetched: 2, created: 1, skipped: 0 })
    await settle()
  })

  it('drugie wywołanie w trakcie → busy; po zakończeniu znów started', async () => {
    let resolve!: (v: any) => void
    const run = () => new Promise<any>(r => { resolve = r })
    assert.deepEqual('started' in startCheckNow(run), true)
    await settle()
    assert.deepEqual(startCheckNow(run), { busy: true })
    assert.deepEqual(startCheckNow(run), { busy: true })
    resolve({ fetched: 0, created: 0, skipped: 0 })
    await settle()
    const again = startCheckNow(async () => ({ fetched: 0, created: 0, skipped: 0 }))
    assert.equal('started' in again, true)
    await settle()
  })

  it('wynik z error oraz wyjątek nie zostawiają blokady', async () => {
    const withError = startCheckNow(async () => ({ fetched: 0, created: 0, skipped: 0, error: 'Przekroczono czas łączenia' }))
    assert.equal('started' in withError, true)
    await settle()
    const throwing = startCheckNow(async () => { throw new Error('boom') })
    assert.equal('started' in throwing, true)
    await settle()
    const syncThrow = startCheckNow((() => { throw new Error('sync boom') }) as any)
    assert.equal('started' in syncThrow, true)
    await settle()
    assert.equal('started' in startCheckNow(async () => ({ fetched: 0, created: 0, skipped: 0 })), true)
    await settle()
  })
})
