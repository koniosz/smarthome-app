/**
 * Harmonogram raportów „Kondycja firmy" — czyste funkcje (bez bazy).
 * Uruchom: npx tsx --test src/__tests__/report-scheduler.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { schedulerSettings, dueReports, DEFAULT_REPORT_DAY } from '../services/report-scheduler'

describe('schedulerSettings', () => {
  test('brak wiersza CompanySettings (null/undefined) = raporty WYŁĄCZONE, report_day 10', () => {
    assert.deepEqual(schedulerSettings(null), { reports_enabled: false, report_day: DEFAULT_REPORT_DAY })
    assert.deepEqual(schedulerSettings(undefined), { reports_enabled: false, report_day: 10 })
    // scenariusz z pierwszego deployu: 16.09 ≥ 10, ale nikt nie włączył wysyłki → nic nie wychodzi
    assert.deepEqual(dueReports(schedulerSettings(null), { year: 2026, month: 9, day: 16 }), [])
  })

  test('wiersz bez jawnego true (undefined/null/false) = wyłączone', () => {
    assert.equal(schedulerSettings({}).reports_enabled, false)
    assert.equal(schedulerSettings({ reports_enabled: null }).reports_enabled, false)
    assert.equal(schedulerSettings({ reports_enabled: false }).reports_enabled, false)
  })

  test('świadomie włączone w ustawieniach → włączone, report_day z wiersza', () => {
    assert.deepEqual(schedulerSettings({ reports_enabled: true, report_day: 5 }), { reports_enabled: true, report_day: 5 })
    assert.deepEqual(dueReports(schedulerSettings({ reports_enabled: true, report_day: 5 }), { year: 2026, month: 9, day: 16 }),
      [{ kind: 'monthly', period: '2026-08' }])
  })

  test('niepoprawny report_day (brak, 0, ujemny) → domyślne 10', () => {
    assert.equal(schedulerSettings({ reports_enabled: true }).report_day, 10)
    assert.equal(schedulerSettings({ reports_enabled: true, report_day: 0 }).report_day, 10)
    assert.equal(schedulerSettings({ reports_enabled: true, report_day: -3 }).report_day, 10)
    assert.equal(schedulerSettings({ reports_enabled: true, report_day: null }).report_day, 10)
  })
})
