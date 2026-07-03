import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'
import { requireAdmin } from '../middleware/auth'

// HR: urlopy + ewidencja czasu pracy (art. 149 KP; rozp. MRPiPS z 10.12.2018, § 6).
// Retencja: dokumentacji nie usuwamy (art. 94 pkt 9b KP — 10 lat po ustaniu stosunku pracy);
// wnioski anulowane/odrzucone zostają w bazie ze statusem.
// Mount: /api/hr (za requireAuth).
const router = Router()
const now = () => new Date().toISOString()

// Typy urlopów/nieobecności — pula urlopowa (20/26 dni) obejmuje wypoczynkowy + na żądanie (art. 167² KP)
export const LEAVE_TYPES = [
  'wypoczynkowy', 'na_zadanie', 'okolicznosciowy', 'bezplatny', 'opieka_dziecko',
  'opiekunczy', 'macierzynski', 'rodzicielski', 'ojcowski', 'wychowawczy', 'chorobowe', 'inna',
] as const
const POOL_TYPES = ['wypoczynkowy', 'na_zadanie']       // zużywają saldo urlopowe
const ON_DEMAND_LIMIT = 4                                // art. 167² KP — max 4 dni/rok

// ── Święta państwowe PL (dni wolne od pracy) ──
function easterSunday(year: number): Date {
  // algorytm Gaussa/Meeusa
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }
function addDaysUTC(d: Date, n: number): Date { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x }

export function polishHolidays(year: number): Set<string> {
  const easter = easterSunday(year)
  const days = [
    `${year}-01-01`, `${year}-01-06`, `${year}-05-01`, `${year}-05-03`,
    `${year}-08-15`, `${year}-11-01`, `${year}-11-11`, `${year}-12-25`, `${year}-12-26`,
    isoDate(easter), isoDate(addDaysUTC(easter, 1)),   // Wielkanoc + Poniedziałek Wielkanocny
    isoDate(addDaysUTC(easter, 49)),                    // Zielone Świątki
    isoDate(addDaysUTC(easter, 60)),                    // Boże Ciało
  ]
  if (year >= 2025) days.push(`${year}-12-24`)          // Wigilia — dzień wolny od 2025
  return new Set(days)
}

export function workingDaysBetween(from: string, to: string): number {
  const start = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0
  let count = 0
  const holidayCache = new Map<number, Set<string>>()
  for (let d = new Date(start); d <= end; d = addDaysUTC(d, 1)) {
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const y = d.getUTCFullYear()
    if (!holidayCache.has(y)) holidayCache.set(y, polishHolidays(y))
    if (holidayCache.get(y)!.has(isoDate(d))) continue
    count++
  }
  return count
}

// HH:MM → minuty
function toMin(t?: string | null): number | null {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
function computeHours(start?: string | null, end?: string | null, breakMin = 0): number {
  const s = toMin(start), e = toMin(end)
  if (s === null || e === null) return 0
  let diff = e - s
  if (diff < 0) diff += 24 * 60   // praca przez północ
  return Math.max(0, (diff - (breakMin || 0)) / 60)
}

// ── Pracownik zalogowanego użytkownika (po user_id, fallback po e-mailu + auto-link) ──
async function resolveEmployee(req: Request): Promise<any | null> {
  const user = (req as any).user
  if (!user) return null
  let emp = await db.employees.findByUserId(user.id)
  if (!emp && user.email) {
    emp = await db.employees.findByEmail(user.email)
    if (emp && !emp.user_id) {
      try { await db.employees.update(emp.id, { user_id: user.id, updated_at: now() }) } catch { /* równoległe łączenie */ }
    }
  }
  return emp
}

// ── Saldo urlopowe pracownika za rok ──
async function computeBalance(employeeId: string, year: number) {
  const bal: any = await db.leave_balances.forEmployeeYear(employeeId, year)
  const entitlement = bal?.entitlement_days ?? 20
  const carried = bal?.carried_over_days ?? 0
  const adjustment = bal?.adjustment_days ?? 0
  const requests: any[] = await db.leave_requests.approvedInRange(employeeId, `${year}-01-01`, `${year}-12-31`)
  const poolReqs = requests.filter(r => POOL_TYPES.includes(r.type) && r.date_from.startsWith(String(year)))
  const used = poolReqs.reduce((s, r) => s + r.days_count, 0)
  const onDemandUsed = poolReqs.filter(r => r.type === 'na_zadanie').reduce((s, r) => s + r.days_count, 0)
  const total = entitlement + carried + adjustment
  return {
    year, entitlement_days: entitlement, carried_over_days: carried,
    adjustment_days: adjustment, adjustment_note: bal?.adjustment_note ?? null,
    total_days: total, used_days: used, remaining_days: total - used,
    on_demand_used: onDemandUsed, on_demand_limit: ON_DEMAND_LIMIT,
  }
}

// ═══ Panel pracownika ═══

// GET /api/hr/me — moje dane + saldo + wnioski
router.get('/me', async (req: Request, res: Response) => {
  try {
    const emp = await resolveEmployee(req)
    if (!emp) { res.json({ employee: null }); return }
    const year = new Date().getFullYear()
    const [balance, requests] = await Promise.all([
      computeBalance(emp.id, year),
      db.leave_requests.forEmployee(emp.id),
    ])
    res.json({ employee: emp, balance, requests })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/me/leave-requests — złóż wniosek
router.post('/me/leave-requests', async (req: Request, res: Response) => {
  try {
    const emp = await resolveEmployee(req)
    if (!emp) { res.status(404).json({ error: 'Brak powiązanej kartoteki pracownika — skontaktuj się z administratorem' }); return }
    const { type, date_from, date_to, comment } = req.body
    if (!LEAVE_TYPES.includes(type)) { res.status(400).json({ error: 'Nieprawidłowy typ wniosku' }); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date_from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date_to))) {
      res.status(400).json({ error: 'Podaj daty w formacie RRRR-MM-DD' }); return
    }
    const days = workingDaysBetween(date_from, date_to)
    if (days <= 0) { res.status(400).json({ error: 'Wybrany zakres nie zawiera dni roboczych' }); return }

    const year = Number(String(date_from).slice(0, 4))
    if (POOL_TYPES.includes(type)) {
      const bal = await computeBalance(emp.id, year)
      if (days > bal.remaining_days) {
        res.status(400).json({ error: `Wniosek (${days} dni) przekracza dostępny urlop (${bal.remaining_days} dni)` }); return
      }
      if (type === 'na_zadanie' && bal.on_demand_used + days > ON_DEMAND_LIMIT) {
        res.status(400).json({ error: `Urlop na żądanie: limit ${ON_DEMAND_LIMIT} dni/rok (wykorzystano ${bal.on_demand_used})` }); return
      }
    }
    const item = {
      id: uuidv4(), employee_id: emp.id, type, date_from, date_to, days_count: days,
      status: 'pending', comment: comment ? String(comment).trim() : null,
      admin_comment: null, decided_by: null, decided_at: null,
      created_at: now(), updated_at: now(),
    }
    await db.leave_requests.insert(item)
    res.status(201).json(item)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/me/leave-requests/:id/cancel — anuluj własny oczekujący wniosek (zostaje w bazie)
router.post('/me/leave-requests/:id/cancel', async (req: Request, res: Response) => {
  try {
    const emp = await resolveEmployee(req)
    const lr: any = await db.leave_requests.find(req.params.id)
    if (!emp || !lr || lr.employee_id !== emp.id) { res.status(404).json({ error: 'Wniosek nie znaleziony' }); return }
    if (lr.status !== 'pending') { res.status(400).json({ error: 'Można anulować tylko oczekujący wniosek' }); return }
    await db.leave_requests.update(lr.id, { status: 'cancelled', updated_at: now() })
    res.json(await db.leave_requests.find(lr.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// GET /api/hr/me/work-time?month=YYYY-MM — moja ewidencja
router.get('/me/work-time', async (req: Request, res: Response) => {
  try {
    const emp = await resolveEmployee(req)
    if (!emp) { res.json({ entries: [] }); return }
    const month = String(req.query.month || now().slice(0, 7))
    res.json({ entries: await db.work_time_entries.forEmployeeMonth(emp.id, month) })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/me/work-time — rejestruj/aktualizuj własny dzień pracy
router.post('/me/work-time', async (req: Request, res: Response) => {
  try {
    const emp = await resolveEmployee(req)
    if (!emp) { res.status(404).json({ error: 'Brak powiązanej kartoteki pracownika' }); return }
    const { date, start_time, end_time, break_minutes, notes } = req.body
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) { res.status(400).json({ error: 'Podaj datę RRRR-MM-DD' }); return }
    const brk = Number(break_minutes) || 0
    const patch: any = {
      start_time: start_time || null, end_time: end_time || null,
      break_minutes: brk, hours_worked: computeHours(start_time, end_time, brk),
      notes: notes ? String(notes).trim() : null, updated_at: now(),
    }
    const entry = await db.work_time_entries.upsertForDay(emp.id, String(date), patch, {
      id: uuidv4(), night_hours: 0, overtime_hours: 0,
      duty_start: null, duty_end: null, duty_place: null,
      created_by: (req as any).user?.id || null, created_at: now(),
    })
    res.json(entry)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ═══ Panel administratora ═══

// GET /api/hr/admin/overview — pracownicy + salda + oczekujące wnioski
router.get('/admin/overview', requireAdmin, async (req: Request, res: Response) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear()
    const employees: any[] = await db.employees.all()
    const pending: any[] = await db.leave_requests.all('pending')
    const rows = await Promise.all(employees.map(async e => ({
      employee: e,
      balance: await computeBalance(e.id, year),
      pending_count: pending.filter(p => p.employee_id === e.id).length,
    })))
    res.json({ year, rows })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// GET /api/hr/admin/leave-requests?status=
router.get('/admin/leave-requests', requireAdmin, async (req: Request, res: Response) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined
    res.json(await db.leave_requests.all(status))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/admin/leave-requests/:id/decide — zatwierdź/odrzuć
router.post('/admin/leave-requests/:id/decide', requireAdmin, async (req: Request, res: Response) => {
  try {
    const lr: any = await db.leave_requests.find(req.params.id)
    if (!lr) { res.status(404).json({ error: 'Wniosek nie znaleziony' }); return }
    if (lr.status !== 'pending') { res.status(400).json({ error: 'Wniosek został już rozpatrzony' }); return }
    const decision = req.body.decision === 'approved' ? 'approved' : 'rejected'
    if (decision === 'approved' && POOL_TYPES.includes(lr.type)) {
      const bal = await computeBalance(lr.employee_id, Number(lr.date_from.slice(0, 4)))
      if (lr.days_count > bal.remaining_days) {
        res.status(400).json({ error: `Wniosek (${lr.days_count} dni) przekracza dostępny urlop (${bal.remaining_days} dni) — skoryguj saldo lub odrzuć` }); return
      }
    }
    await db.leave_requests.update(lr.id, {
      status: decision,
      admin_comment: req.body.admin_comment ? String(req.body.admin_comment).trim() : null,
      decided_by: (req as any).user?.id || null,
      decided_at: now(), updated_at: now(),
    })
    res.json(await db.leave_requests.find(lr.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// PUT /api/hr/admin/balance/:employeeId/:year — ustaw wymiar początkowy / zaległy / korektę
router.put('/admin/balance/:employeeId/:year', requireAdmin, async (req: Request, res: Response) => {
  try {
    const year = Number(req.params.year)
    if (!year || year < 2000 || year > 2100) { res.status(400).json({ error: 'Nieprawidłowy rok' }); return }
    if (!await db.employees.find(req.params.employeeId)) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    const patch: any = { updated_at: now() }
    if (req.body.entitlement_days !== undefined) patch.entitlement_days = Number(req.body.entitlement_days) || 0
    if (req.body.carried_over_days !== undefined) patch.carried_over_days = Number(req.body.carried_over_days) || 0
    if (req.body.adjustment_days !== undefined) patch.adjustment_days = Number(req.body.adjustment_days) || 0
    if (req.body.adjustment_note !== undefined) patch.adjustment_note = req.body.adjustment_note ? String(req.body.adjustment_note).trim() : null
    await db.leave_balances.upsert(req.params.employeeId, year, patch, {
      id: uuidv4(), entitlement_days: 20, carried_over_days: 0, adjustment_days: 0, adjustment_note: null, created_at: now(),
    })
    res.json(await computeBalance(req.params.employeeId, year))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/admin/work-time/:employeeId — wpis/korekta ewidencji (pełne pola, w tym nocne/nadgodziny/dyżur)
router.post('/admin/work-time/:employeeId', requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!await db.employees.find(req.params.employeeId)) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    const { date, start_time, end_time, break_minutes, night_hours, overtime_hours, duty_start, duty_end, duty_place, notes } = req.body
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) { res.status(400).json({ error: 'Podaj datę RRRR-MM-DD' }); return }
    const brk = Number(break_minutes) || 0
    const patch: any = {
      start_time: start_time || null, end_time: end_time || null, break_minutes: brk,
      hours_worked: computeHours(start_time, end_time, brk),
      night_hours: Number(night_hours) || 0, overtime_hours: Number(overtime_hours) || 0,
      duty_start: duty_start || null, duty_end: duty_end || null,
      duty_place: duty_place ? String(duty_place).trim() : null,
      notes: notes ? String(notes).trim() : null, updated_at: now(),
    }
    const entry = await db.work_time_entries.upsertForDay(req.params.employeeId, String(date), patch, {
      id: uuidv4(), created_by: (req as any).user?.id || null, created_at: now(),
    })
    res.json(entry)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Ewidencja miesięczna (karta czasu pracy do okazania PIP) ──
async function buildEwidencja(employeeId: string, month: string) {
  const employee: any = await db.employees.find(employeeId)
  if (!employee) return null
  const year = Number(month.slice(0, 4))
  const mm = Number(month.slice(5, 7))
  const daysInMonth = new Date(year, mm, 0).getDate()
  const holidays = polishHolidays(year)
  const [entries, leaves] = await Promise.all([
    db.work_time_entries.forEmployeeMonth(employeeId, month),
    db.leave_requests.approvedInRange(employeeId, `${month}-01`, `${month}-${String(daysInMonth).padStart(2, '0')}`),
  ])
  const entryByDate = new Map((entries as any[]).map(e => [e.date, e]))
  const days = []
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`
    const dow = new Date(date + 'T00:00:00Z').getUTCDay()
    const isHoliday = holidays.has(date)
    const isWeekend = dow === 0 || dow === 6
    const entry = entryByDate.get(date) || null
    const leave = (leaves as any[]).find(l => l.date_from <= date && l.date_to >= date) || null
    days.push({
      date, day_of_week: dow, is_weekend: isWeekend, is_holiday: isHoliday,
      entry, leave: leave ? { id: leave.id, type: leave.type } : null,
    })
  }
  const sums = {
    hours_worked: (entries as any[]).reduce((s, e) => s + e.hours_worked, 0),
    night_hours: (entries as any[]).reduce((s, e) => s + e.night_hours, 0),
    overtime_hours: (entries as any[]).reduce((s, e) => s + e.overtime_hours, 0),
    days_worked: (entries as any[]).filter(e => e.hours_worked > 0).length,
    leave_days_by_type: {} as Record<string, number>,
  }
  for (const day of days) {
    if (day.leave && !day.is_weekend && !day.is_holiday) {
      sums.leave_days_by_type[day.leave.type] = (sums.leave_days_by_type[day.leave.type] || 0) + 1
    }
  }
  return { employee, month, days, sums }
}

// GET /api/hr/admin/ewidencja/:employeeId?month=YYYY-MM (admin)
router.get('/admin/ewidencja/:employeeId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const month = String(req.query.month || now().slice(0, 7))
    if (!/^\d{4}-\d{2}$/.test(month)) { res.status(400).json({ error: 'Podaj miesiąc RRRR-MM' }); return }
    const report = await buildEwidencja(req.params.employeeId, month)
    if (!report) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    res.json(report)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// GET /api/hr/me/ewidencja?month= — własna karta (art. 149 § 1 KP: udostępnienie pracownikowi na żądanie)
router.get('/me/ewidencja', async (req: Request, res: Response) => {
  try {
    const emp = await resolveEmployee(req)
    if (!emp) { res.json(null); return }
    const month = String(req.query.month || now().slice(0, 7))
    if (!/^\d{4}-\d{2}$/.test(month)) { res.status(400).json({ error: 'Podaj miesiąc RRRR-MM' }); return }
    res.json(await buildEwidencja(emp.id, month))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/admin/link-user/:employeeId — powiąż kartotekę z kontem logowania
router.post('/admin/link-user/:employeeId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const emp = await db.employees.find(req.params.employeeId)
    if (!emp) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    await db.employees.update(emp.id, { user_id: req.body.user_id || null, updated_at: now() })
    res.json(await db.employees.find(emp.id))
  } catch (e: any) {
    if (e?.code === 'P2002') { res.status(409).json({ error: 'To konto jest już powiązane z innym pracownikiem' }); return }
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
