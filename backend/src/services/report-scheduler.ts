/**
 * Harmonogram raportów „Kondycja firmy" — pierwszy przebieg 6 min po starcie, potem co 60 min.
 *
 * Data wg Europe/Warsaw. Gdy `reports_enabled` i dzień miesiąca ≥ `report_day`:
 *  - raport miesięczny za poprzedni miesiąc,
 *  - w styczniu/kwietniu/lipcu/październiku dodatkowo kwartalny za poprzedni kwartał.
 * Dla każdego (kind, period): jest log `sent` → nic; wpis `sending` młodszy niż 2 h (wysyłka w toku
 * lub niedokończona) → nic; dane kompletne → pełny raport (`sent`); niekompletne i brak logu `incomplete`
 * → „czeka na dane" (`incomplete`); potem co godzinę sprawdzamy ponownie, aż dane się uzupełnią.
 * Błędy → log `failed` (raz dziennie), nigdy nie rzucamy.
 *
 * Brak wiersza CompanySettings `default` (albo błąd odczytu) = raporty WYŁĄCZONE — tak jak
 * `@default(false)` w schemacie; wysyłkę włącza się świadomie w „Ustawieniach raportu".
 */
import { prisma } from '../db'
import { computeHealth, warsawToday, type HealthKind } from './finance-health'
import { sendReport, logFailed, sendingInProgress } from './finance-report'
import { forEachCompany } from '../middleware/tenant'
import { getCompanySettings } from '../settings-store'

export type DueReport = { kind: HealthKind; period: string }

export const DEFAULT_REPORT_DAY = 10

/**
 * Czysta: ustawienia harmonogramu z wiersza CompanySettings. Brak wiersza / błąd odczytu → wyłączone
 * (spójnie z `@default(false)` w schemacie i z GET /health/report-settings), report_day = 10.
 */
export function schedulerSettings(
  row: { reports_enabled?: boolean | null; report_day?: number | null } | null | undefined,
): { reports_enabled: boolean; report_day: number } {
  return {
    reports_enabled: row?.reports_enabled === true,
    report_day: typeof row?.report_day === 'number' && row.report_day >= 1 ? row.report_day : DEFAULT_REPORT_DAY,
  }
}

/** Czysta: które raporty są „na dziś" wg ustawień i daty (Warsaw). */
export function dueReports(
  settings: { reports_enabled: boolean; report_day: number },
  today: { year: number; month: number; day: number },
): DueReport[] {
  if (!settings.reports_enabled) return []
  if (today.day < settings.report_day) return []
  const prevYear = today.month === 1 ? today.year - 1 : today.year
  const prevMonth = today.month === 1 ? 12 : today.month - 1
  const due: DueReport[] = [{ kind: 'monthly', period: `${prevYear}-${String(prevMonth).padStart(2, '0')}` }]
  if ([1, 4, 7, 10].includes(today.month)) {
    // poprzedni kwartał: styczeń → Q4 zeszłego roku, kwiecień → Q1, lipiec → Q2, październik → Q3
    const q = today.month === 1 ? 4 : (today.month - 1) / 3
    const qYear = today.month === 1 ? today.year - 1 : today.year
    due.push({ kind: 'quarterly', period: `${qYear}-Q${q}` })
  }
  return due
}

/** Jeden przebieg harmonogramu (eksport do testów ręcznych / wywołania z zewnątrz). Nigdy nie rzuca. */
export async function runReportScheduler(nowDate: Date = new Date()): Promise<void> {
  try {
    const settings = await getCompanySettings()
      .catch((e: any) => { console.error('[Raport] Nie udało się odczytać ustawień raportu — wysyłka pominięta:', e?.message ?? e); return null })
    const due = dueReports(schedulerSettings(settings), warsawToday(nowDate))
    for (const { kind, period } of due) {
      try {
        const logs = await prisma.reportDispatch.findMany({ where: { kind, period }, select: { status: true, created_at: true } })
        if (logs.some(l => l.status === 'sent')) continue
        if (sendingInProgress(logs, nowDate)) continue   // wysyłka w toku (wpis `sending` < 2 h) — nie dublujemy i nie logujemy `failed`
        const hasIncomplete = logs.some(l => l.status === 'incomplete')
        const health = await computeHealth(period)
        if (!health.complete && hasIncomplete) continue   // lista braków już poszła — czekamy na dane
        const r = await sendReport(kind, period, { health })
        console.log(`[Raport] ${kind} ${period}: ${r.status} → ${r.recipients.join(', ')}`)
      } catch (e: any) {
        console.error(`[Raport] Błąd raportu ${kind} ${period}:`, e?.message ?? e)
        await logFailed(kind, period, e?.message ?? String(e))
      }
    }
  } catch (e: any) {
    console.error('[Raport] Błąd harmonogramu:', e?.message ?? e)
  }
}

export function startReportScheduler(): void {
  // każda aktywna firma osobno (własne ustawienia, dane, odbiorcy)
  const tick = () => { void forEachCompany(() => runReportScheduler()) }
  setTimeout(() => {
    tick()
    setInterval(tick, 60 * 60 * 1000)
  }, 6 * 60 * 1000)
  console.log('[Raport] Harmonogram raportów „Kondycja firmy" włączony (pierwszy przebieg za 6 min, potem co 60 min)')
}
