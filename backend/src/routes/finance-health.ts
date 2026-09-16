/**
 * „Kondycja firmy" — API (mount: /api/finance). Dostęp: admin lub księgowy (can_view_payments).
 *
 *  GET  /health?period=YYYY-MM|YYYY-Qn        — pełna odpowiedź HealthResponse (domyślnie poprzedni miesiąc)
 *  GET  /health/report-preview?kind&period    — { subject, html, complete, missing } (ten sam HTML co e-mail)
 *  POST /health/report-send { kind, period, force? } — wysyłka raportu (force = pełny mimo braków)
 *  GET  /health/report-settings               — ustawienia raportu + log ostatnich 12 wysyłek
 *  PUT  /health/report-settings (admin)       — zapis ustawień z walidacją
 */
import { Router, Request, Response } from 'express'
import { prisma } from '../db'
import { requireAdmin } from '../middleware/auth'
import { requirePayments } from './payables'
import { computeHealth, parsePeriod, type HealthKind } from '../services/finance-health'
import { buildReportEmail, sendReport, parseEmails } from '../services/finance-report'

const router = Router()
router.use(requirePayments)

function now() { return new Date().toISOString() }

/** Walidacja pary (kind, period): kind opcjonalny — wtedy wynika z formatu okresu. */
function resolveKindPeriod(kindRaw: unknown, periodRaw: unknown): { kind: HealthKind; period: string } {
  const info = parsePeriod(periodRaw ? String(periodRaw) : undefined)
  const kind = kindRaw ? String(kindRaw) : info.kind
  if (kind !== 'monthly' && kind !== 'quarterly') throw new Error('Rodzaj raportu musi być „monthly" lub „quarterly"')
  if (kind !== info.kind) throw new Error(`Okres ${info.period} nie pasuje do rodzaju raportu „${kind}"`)
  return { kind, period: info.period }
}

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/health', async (req: Request, res: Response) => {
  let period: string | undefined
  try {
    period = req.query.period ? String(req.query.period) : undefined
    parsePeriod(period)
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'Nieprawidłowy okres' }); return
  }
  try {
    res.json(await computeHealth(period))
  } catch (e: any) {
    console.error('[finance/health]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd serwera' })
  }
})

// ── GET /health/report-preview ────────────────────────────────────────────────
router.get('/health/report-preview', async (req: Request, res: Response) => {
  let period: string
  try { period = resolveKindPeriod(req.query.kind, req.query.period).period }
  catch (e: any) { res.status(400).json({ error: e?.message }); return }
  try {
    const [health, settings] = await Promise.all([
      computeHealth(period),
      prisma.companySettings.findUnique({ where: { id: 'default' } }).catch(() => null),
    ])
    const companyName = settings?.company_name || process.env.COMPANY_NAME || 'SHC Manager'
    const { subject, html } = buildReportEmail(health, companyName)
    const missing = health.checks.filter(c => c.severity === 'error').map(c => c.message)
    res.json({ subject, html, complete: health.complete, missing })
  } catch (e: any) {
    console.error('[finance/health/report-preview]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd serwera' })
  }
})

// ── POST /health/report-send ──────────────────────────────────────────────────
router.post('/health/report-send', async (req: Request, res: Response) => {
  let kp: { kind: HealthKind; period: string }
  try { kp = resolveKindPeriod(req.body?.kind, req.body?.period) }
  catch (e: any) { res.status(400).json({ error: e?.message }); return }
  try {
    const result = await sendReport(kp.kind, kp.period, { force: req.body?.force === true || req.body?.force === 'true' })
    res.json(result)
  } catch (e: any) {
    console.error('[finance/health/report-send]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd wysyłki raportu' })
  }
})

// ── Ustawienia raportu ────────────────────────────────────────────────────────
async function settingsPayload() {
  const s = await prisma.companySettings.upsert({
    where: { id: 'default' }, update: {}, create: { id: 'default', updated_at: now() },
  })
  const log = await prisma.reportDispatch.findMany({ orderBy: { created_at: 'desc' }, take: 12 })
  return {
    company_name: s.company_name,
    reports_enabled: s.reports_enabled,
    report_day: s.report_day,
    report_emails: s.report_emails,
    cit_rate: s.cit_rate,
    inventory_in_pnl: s.inventory_in_pnl,
    log,
  }
}

router.get('/health/report-settings', async (_req: Request, res: Response) => {
  try { res.json(await settingsPayload()) }
  catch (e: any) {
    console.error('[finance/health/report-settings]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

router.put('/health/report-settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {}
    const data: Record<string, unknown> = {}

    if (b.company_name !== undefined) data.company_name = String(b.company_name).trim().slice(0, 200)
    if (b.reports_enabled !== undefined) data.reports_enabled = b.reports_enabled === true || b.reports_enabled === 'true'
    if (b.inventory_in_pnl !== undefined) data.inventory_in_pnl = b.inventory_in_pnl === true || b.inventory_in_pnl === 'true'

    if (b.report_day !== undefined) {
      const day = Number(b.report_day)
      if (!Number.isInteger(day) || day < 1 || day > 28) { res.status(400).json({ error: 'Dzień wysyłki raportu musi być liczbą od 1 do 28' }); return }
      data.report_day = day
    }
    if (b.cit_rate !== undefined) {
      const rate = Number(b.cit_rate)
      if (!Number.isFinite(rate) || rate < 0 || rate > 40) { res.status(400).json({ error: 'Stawka CIT musi być w zakresie 0–40 %' }); return }
      data.cit_rate = rate
    }
    if (b.report_emails !== undefined) {
      const raw = String(b.report_emails ?? '').split(/[,;\n]+/).map(e => e.trim()).filter(Boolean)
      const bad = raw.find(e => !e.includes('@') || /\s/.test(e))
      if (bad) { res.status(400).json({ error: `Nieprawidłowy adres e-mail: ${bad}` }); return }
      data.report_emails = parseEmails(raw.join(',')).join(', ')
    }

    if (!Object.keys(data).length) { res.status(400).json({ error: 'Brak pól do zapisania' }); return }
    data.updated_at = now()
    await prisma.companySettings.upsert({
      where: { id: 'default' },
      update: data,
      create: { id: 'default', ...data },
    })
    res.json(await settingsPayload())
  } catch (e: any) {
    console.error('[finance/health/report-settings PUT]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
