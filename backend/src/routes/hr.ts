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

// Nazwy świąt (do podpowiedzi w kalendarzu)
export function polishHolidayNames(year: number): Map<string, string> {
  const easter = easterSunday(year)
  const m = new Map<string, string>([
    [`${year}-01-01`, 'Nowy Rok'], [`${year}-01-06`, 'Trzech Króli'], [`${year}-05-01`, 'Święto Pracy'], [`${year}-05-03`, 'Święto Konstytucji 3 Maja'],
    [`${year}-08-15`, 'Wniebowzięcie NMP'], [`${year}-11-01`, 'Wszystkich Świętych'], [`${year}-11-11`, 'Święto Niepodległości'],
    [`${year}-12-25`, 'Boże Narodzenie'], [`${year}-12-26`, 'Drugi dzień Bożego Narodzenia'],
    [isoDate(easter), 'Wielkanoc'], [isoDate(addDaysUTC(easter, 1)), 'Poniedziałek Wielkanocny'],
    [isoDate(addDaysUTC(easter, 49)), 'Zielone Świątki'], [isoDate(addDaysUTC(easter, 60)), 'Boże Ciało'],
  ])
  if (year >= 2025) m.set(`${year}-12-24`, 'Wigilia')
  return m
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
    const mine: any[] = await db.leave_requests.overlapping(String(date_from), String(date_to), ['approved', 'pending'], emp.id)
    if (mine.length) {
      res.status(400).json({ error: `Masz już ${mine[0].status === 'pending' ? 'wniosek' : 'urlop'} w tym terminie (${mine[0].date_from} – ${mine[0].date_to})` }); return
    }

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
    if (decision === 'approved') {
      // saldo, limit „na żądanie” i nakładanie z już zatwierdzonym urlopem (inny oczekujący nie blokuje)
      const v = await validateLeaveRange(lr.employee_id, lr.type, lr.date_from, lr.date_to, { excludeId: lr.id, countsAgainstPool: true, overlapStatuses: ['approved'] })
      if ('error' in v) { res.status(400).json({ error: `${v.error} — skoryguj saldo/termin lub odrzuć` }); return }
    }
    await db.leave_requests.update(lr.id, {
      status: decision,
      admin_comment: req.body.admin_comment ? String(req.body.admin_comment).trim() : null,
      decided_by: (req as any).user?.id || null,
      decided_at: now(), updated_at: now(),
    })
    const conflicting_entries = decision === 'approved' ? await reconcileWorkTime(lr.employee_id, lr.date_from, lr.date_to) : []
    res.json({ ...(await db.leave_requests.find(lr.id)), conflicting_entries })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// Dzisiejsza data wg Europe/Warsaw (serwer na Render działa w UTC)
function warsawToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function addDaysIso(date: string, n: number): string { return isoDate(addDaysUTC(new Date(date + 'T00:00:00Z'), n)) }

// POST /api/hr/admin/leave-requests/:id/cancel { reason?, effective_from?, force? }
// Odwołanie pracownika z urlopu (zmienił zdanie / potrzebny w pracy — art. 167 KP).
// - wniosek oczekujący → status „cancelled”
// - urlop zatwierdzony, który jeszcze się nie zaczął → „cancelled” (wszystkie dni wracają do puli)
// - urlop W TRAKCIE → SKRÓCENIE: date_to = effective_from − 1 dzień, status zostaje „approved”;
//   dni już wykorzystane zostają w ewidencji jako urlop, reszta wraca do puli (saldo/ewidencja/auto-grafik
//   liczą się z wniosków „approved”, więc nic więcej nie trzeba sprzątać)
// - urlop ZAKOŃCZONY → 400, chyba że force=true (błędny wpis; wszystkie dni wracają — świadoma decyzja)
// Ślad zatwierdzenia (decided_by/decided_at) zostaje; powód dopisywany do admin_comment (widoczny dla pracownika).
router.post('/admin/leave-requests/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
  try {
    const lr: any = await db.leave_requests.find(req.params.id)
    if (!lr) { res.status(404).json({ error: 'Wniosek nie znaleziony' }); return }
    if (!['approved', 'pending'].includes(lr.status)) {
      res.status(400).json({ error: `Nie można anulować wniosku ze statusem „${lr.status}”` }); return
    }
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : ''
    const today = warsawToday()
    const prevNote = lr.admin_comment ? ` · wcześniej: „${lr.admin_comment}”` : ''
    const fullCancel = async (label: string) => {
      await db.leave_requests.update(lr.id, {
        status: 'cancelled',
        admin_comment: `${label} ${today} przez administratora${reason ? ': ' + reason : ''}${prevNote}`,
        ...(lr.status === 'pending' ? { decided_by: (req as any).user?.id || null, decided_at: now() } : {}),
        updated_at: now(),
      })
      res.json({ ...(await db.leave_requests.find(lr.id)), action: 'cancelled', returned_days: lr.days_count })
    }

    if (lr.status === 'pending') { await fullCancel('Anulowano'); return }

    const force = req.body?.force === true
    if (lr.date_to < today && !force) {
      res.status(400).json({ error: 'Ten urlop już się zakończył — dni zostały wykorzystane. Jeśli wpis jest błędny, anuluj z opcją „mimo to” (wszystkie dni wrócą do puli i znikną z ewidencji).' }); return
    }
    let eff = force ? lr.date_from : (req.body?.effective_from ? String(req.body.effective_from) : today)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) { res.status(400).json({ error: 'Podaj datę odwołania w formacie RRRR-MM-DD' }); return }
    if (eff > lr.date_to) { res.status(400).json({ error: 'Data odwołania jest po zakończeniu urlopu' }); return }
    if (eff < lr.date_from) eff = lr.date_from

    if (eff <= lr.date_from) { await fullCancel('Anulowano'); return }

    // Skrócenie: urlop trwa — dni przed datą odwołania zostają urlopem
    const newTo = addDaysIso(eff, -1)
    const days = workingDaysBetween(lr.date_from, newTo)
    if (days <= 0) { await fullCancel('Anulowano'); return }
    const returned = Math.max(0, Math.round((lr.days_count - days) * 100) / 100)
    await db.leave_requests.update(lr.id, {
      date_to: newTo, days_count: days,
      admin_comment: `Odwołany z urlopu od ${eff} (skrócono z ${lr.date_to} do ${newTo}, do puli wróciło ${returned} dni)${reason ? ': ' + reason : ''}${prevNote}`,
      updated_at: now(),
    })
    res.json({ ...(await db.leave_requests.find(lr.id)), action: 'shortened', new_date_to: newTo, returned_days: returned })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// DELETE /api/hr/admin/leave-requests/:id — usuń wpis bez śladu. Tylko odrzucone/anulowane wpisy
// wprowadzone ręcznie (błędny wpis). Zatwierdzony urlop można wyłącznie anulować (historia — art. 94 pkt 9b KP);
// wpisu z importu Calamari nie usuwamy — wróciłby przy następnym imporcie (klucz deduplikacji).
router.delete('/admin/leave-requests/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const lr: any = await db.leave_requests.find(req.params.id)
    if (!lr) { res.status(404).json({ error: 'Wniosek nie znaleziony' }); return }
    if (lr.status === 'approved' || lr.status === 'pending') {
      res.status(400).json({ error: 'Zatwierdzony lub oczekujący wniosek można tylko anulować — zostaje w historii' }); return
    }
    if (lr.decided_by === 'import-calamari' || String(lr.admin_comment || '').startsWith('Import z Calamari')) {
      res.status(400).json({ error: 'Wpis z importu Calamari — zostaw jako anulowany; usunięty wróciłby przy następnym imporcie' }); return
    }
    await db.leave_requests.remove(lr.id)
    res.json({ ok: true, id: lr.id, status_before: lr.status })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// Walidacja zakresu urlopu (wspólna dla dodawania/edycji przez admina): format dat, dni robocze,
// nakładanie się z innymi wnioskami pracownika (approved/pending), saldo i limit „na żądanie”
// dla urlopów zatwierdzonych (z pominięciem edytowanego wniosku).
async function validateLeaveRange(employeeId: string, type: string, from: string, to: string,
  opts: { excludeId?: string; countsAgainstPool: boolean; overlapStatuses?: string[]; skipOverlap?: boolean }): Promise<{ days: number } | { error: string }> {
  if (!(LEAVE_TYPES as readonly string[]).includes(type)) return { error: 'Nieprawidłowy typ nieobecności' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: 'Podaj daty w formacie RRRR-MM-DD' }
  if (from > to) return { error: 'Data „od” jest po dacie „do”' }
  const days = workingDaysBetween(from, to)
  if (days <= 0) return { error: 'Wybrany zakres nie zawiera dni roboczych' }
  const others = opts.skipOverlap ? [] : (await db.leave_requests.overlapping(from, to, opts.overlapStatuses ?? ['approved', 'pending'], employeeId)).filter((l: any) => l.id !== opts.excludeId)
  if (others.length) {
    const o: any = others[0]
    return { error: `Nakłada się na inny wniosek (${o.date_from} – ${o.date_to}, ${o.status === 'pending' ? 'oczekujący' : 'zatwierdzony'})` }
  }
  if (opts.countsAgainstPool && POOL_TYPES.includes(type)) {
    const year = Number(from.slice(0, 4))
    const bal = await computeBalance(employeeId, year)
    let remaining = bal.remaining_days, onDemandUsed = bal.on_demand_used
    let prevDays = 0, prevOnDemand = 0 // dotychczasowe zużycie edytowanego wniosku (saldo ujemne nie blokuje skracania/przesuwania)
    if (opts.excludeId) {
      const cur: any = await db.leave_requests.find(opts.excludeId)
      if (cur && cur.status === 'approved' && POOL_TYPES.includes(cur.type) && cur.date_from.startsWith(String(year))) {
        remaining += cur.days_count; prevDays = cur.days_count
        if (cur.type === 'na_zadanie') { onDemandUsed -= cur.days_count; prevOnDemand = cur.days_count }
      }
    }
    if (days > prevDays && days > remaining) return { error: `Nieobecność (${days} dni) przekracza dostępny urlop (${remaining} dni) — skoryguj saldo` }
    if (type === 'na_zadanie' && days > prevOnDemand && onDemandUsed + days > ON_DEMAND_LIMIT) return { error: `Urlop na żądanie: limit ${ON_DEMAND_LIMIT} dni/rok (wykorzystano ${onDemandUsed})` }
  }
  return { days }
}

// Po zatwierdzeniu/dodaniu/przesunięciu urlopu: dni urlopu nie mogą być jednocześnie „przepracowane”.
// Wpisy z auto-grafiku (syntetyczne) usuwamy; wpisy ręczne z godzinami zwracamy jako konflikt do decyzji admina.
async function reconcileWorkTime(employeeId: string, from: string, to: string): Promise<Array<{ date: string; hours_worked: number }>> {
  const entries: any[] = await db.work_time_entries.forEmployeeRange(employeeId, from, to)
  const conflicts: Array<{ date: string; hours_worked: number }> = []
  for (const e of entries) {
    if (e.created_by === 'auto-grafik') await db.work_time_entries.delete(e.id)
    else if ((e.hours_worked || 0) > 0) conflicts.push({ date: e.date, hours_worked: e.hours_worked })
  }
  return conflicts
}
const isCalamariImport = (lr: any) => lr.decided_by === 'import-calamari' || String(lr.admin_comment || '').startsWith('Import z Calamari')

// GET /api/hr/leave-calendar?month=YYYY-MM&include_cancelled=true — siatka pracownicy × dni.
// Admin: pełne typy i statusy (approved/pending [+cancelled]); pracownik: tylko zatwierdzone,
// typ zamaskowany (urlop wypoczynkowy/na żądanie = „wypoczynkowy”, reszta = „absence”) — bez danych wrażliwych (L4 itp.).
router.get('/leave-calendar', async (req: Request, res: Response) => {
  try {
    const month = String(req.query.month ?? '').slice(0, 7) || warsawToday().slice(0, 7)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { res.status(400).json({ error: 'Podaj miesiąc RRRR-MM' }); return }
    const isAdmin = (req as any).user?.role === 'admin'
    const includeCancelled = isAdmin && String(req.query.include_cancelled) === 'true'
    const year = Number(month.slice(0, 4)), mm = Number(month.slice(5, 7))
    const daysInMonth = new Date(Date.UTC(year, mm, 0)).getUTCDate()
    const from = `${month}-01`, to = `${month}-${String(daysInMonth).padStart(2, '0')}`
    const holidays = polishHolidayNames(year)
    const days = []
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`
      const dow = new Date(date + 'T00:00:00Z').getUTCDay()
      const hn = holidays.get(date)
      days.push({ date, dow, is_weekend: dow === 0 || dow === 6, is_holiday: !!hn, ...(hn ? { holiday_name: hn } : {}) })
    }
    const statuses = isAdmin ? ['approved', 'pending', ...(includeCancelled ? ['cancelled'] : [])] : ['approved']
    const [emps, leaves] = await Promise.all([db.employees.all(), db.leave_requests.overlapping(from, to, statuses)])
    const employees = (emps as any[])
      .filter(e => (!e.end_date || e.end_date >= from) && (!e.start_date || e.start_date <= to))
      .map(e => ({ id: e.id, name: e.name, position: e.position || null }))
    const empIds = new Set(employees.map(e => e.id))
    const absentSet: Record<string, Set<string>> = {}
    for (const l of leaves as any[]) {
      if (l.status !== 'approved' || !empIds.has(l.employee_id)) continue
      for (const d of days) if (!d.is_weekend && !d.is_holiday && l.date_from <= d.date && l.date_to >= d.date) (absentSet[d.date] ??= new Set()).add(l.employee_id)
    }
    const absent: Record<string, number> = Object.fromEntries(Object.entries(absentSet).map(([k, v]) => [k, v.size]))
    res.json({
      month, from, to, today: warsawToday(), read_only: !isAdmin, days, employees,
      leaves: (leaves as any[]).filter(l => empIds.has(l.employee_id)).map(l => ({
        id: l.id, employee_id: l.employee_id,
        type: isAdmin ? l.type : (POOL_TYPES.includes(l.type) ? 'wypoczynkowy' : 'absence'),
        status: l.status, date_from: l.date_from, date_to: l.date_to, days_count: l.days_count,
        comment: isAdmin ? (l.comment ?? null) : null, admin_comment: isAdmin ? (l.admin_comment ?? null) : null,
      })),
      absent_per_day: absent,
    })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/admin/leave-requests — admin dodaje nieobecność pracownikowi (domyślnie od razu zatwierdzona)
router.post('/admin/leave-requests', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { employee_id, type, date_from, date_to, comment } = req.body ?? {}
    const emp: any = employee_id ? await db.employees.find(String(employee_id)) : null
    if (!emp) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    const status = req.body?.status === 'pending' ? 'pending' : 'approved'
    // saldo/limit sprawdzamy także dla „oczekującego” — i tak ma zostać zatwierdzony
    const v = await validateLeaveRange(emp.id, String(type), String(date_from), String(date_to), { countsAgainstPool: true })
    if ('error' in v) { res.status(400).json({ error: v.error }); return }
    const item = {
      id: uuidv4(), employee_id: emp.id, type: String(type), date_from: String(date_from), date_to: String(date_to), days_count: v.days,
      status, comment: comment ? String(comment).trim().slice(0, 500) : null,
      admin_comment: 'Dodano przez administratora', decided_by: status === 'approved' ? ((req as any).user?.id || null) : null,
      decided_at: status === 'approved' ? now() : null, created_at: now(), updated_at: now(),
    }
    await db.leave_requests.insert(item)
    const conflicting_entries = status === 'approved' ? await reconcileWorkTime(emp.id, item.date_from, item.date_to) : []
    res.status(201).json({ ...item, conflicting_entries })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// PUT /api/hr/admin/leave-requests/:id — zmiana terminu / typu / komentarza (tylko pending lub approved)
router.put('/admin/leave-requests/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const lr: any = await db.leave_requests.find(req.params.id)
    if (!lr) { res.status(404).json({ error: 'Wniosek nie znaleziony' }); return }
    if (!['approved', 'pending'].includes(lr.status)) { res.status(400).json({ error: `Nie można edytować wniosku ze statusem „${lr.status}”` }); return }
    const type = req.body?.type ? String(req.body.type) : lr.type
    const from = req.body?.date_from ? String(req.body.date_from) : lr.date_from
    const to = req.body?.date_to ? String(req.body.date_to) : lr.date_to
    const rangeChanged = from !== lr.date_from || to !== lr.date_to
    const changed = type !== lr.type || rangeChanged
    if (changed && isCalamariImport(lr)) {
      res.status(400).json({ error: 'Wpis z importu Calamari — zmiana terminu/typu wróciłaby przy następnym imporcie. Anuluj ten wpis (zostaje w historii) i dodaj nowy.' }); return
    }
    const today = warsawToday()
    if (rangeChanged && lr.status === 'approved' && lr.date_from < today && req.body?.force !== true) {
      res.status(400).json({ error: lr.date_to < today
        ? 'Ten urlop już się zakończył — dni zostały wykorzystane. Zmiana terminu tylko dla błędnego wpisu (zaznacz „wpis jest błędny”).'
        : 'Ten urlop już trwa. Żeby odwołać pracownika z urlopu, użyj „Odwołaj z urlopu”; zmiana terminu tylko dla błędnego wpisu (zaznacz „wpis jest błędny”).' }); return
    }
    const v = await validateLeaveRange(lr.employee_id, type, from, to, { excludeId: lr.id, countsAgainstPool: true, skipOverlap: !rangeChanged })
    if ('error' in v) { res.status(400).json({ error: v.error }); return }
    const note = changed ? `Zmieniono przez administratora ${warsawToday()}: ${lr.date_from} – ${lr.date_to} (${lr.type}) → ${from} – ${to} (${type})` : ''
    const adminComment = req.body?.admin_comment !== undefined ? String(req.body.admin_comment).trim().slice(0, 500) : (lr.admin_comment ?? '')
    await db.leave_requests.update(lr.id, {
      type, date_from: from, date_to: to, days_count: v.days,
      comment: req.body?.comment !== undefined ? (String(req.body.comment).trim().slice(0, 500) || null) : lr.comment,
      admin_comment: [adminComment, note].filter(Boolean).join(' · ') || null,
      updated_at: now(),
    })
    const conflicting_entries = lr.status === 'approved' && rangeChanged ? await reconcileWorkTime(lr.employee_id, from, to) : []
    res.json({ ...(await db.leave_requests.find(lr.id)), conflicting_entries })
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
    const userId = req.body.user_id || null
    if (userId) {
      // unikalność powiązania pilnowana w kodzie (brak constraintu w DB)
      const existing: any = await db.employees.findByUserId(userId)
      if (existing && existing.id !== emp.id) {
        res.status(409).json({ error: `To konto jest już powiązane z pracownikiem: ${existing.name}` }); return
      }
    }
    await db.employees.update(emp.id, { user_id: userId, updated_at: now() })
    res.json(await db.employees.find(emp.id))
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ═══ Auto-wypełnianie ewidencji z grafiku (opcja: stałe godziny pracy) ═══
// Tworzy wpisy TYLKO dla dni roboczych bez święta, bez zatwierdzonego urlopu
// i bez istniejącego wpisu; wyłącznie dni zakończone (do wczoraj włącznie).
// Wpisy oznaczane created_by='auto-grafik' — pozostają w pełni edytowalne (korekty).

async function fillScheduleForEmployee(emp: any, from: string, to: string): Promise<number> {
  // ogranicz do okresu zatrudnienia
  const effFrom = emp.start_date && emp.start_date > from ? emp.start_date : from
  const effTo = emp.end_date && emp.end_date < to ? emp.end_date : to
  if (effFrom > effTo) return 0

  const [existing, leaves] = await Promise.all([
    db.work_time_entries.forEmployeeRange(emp.id, effFrom, effTo),
    db.leave_requests.approvedInRange(emp.id, effFrom, effTo),
  ])
  const existingDates = new Set((existing as any[]).map(e => e.date))
  const holidayCache = new Map<number, Set<string>>()
  const brk = Number(emp.work_break_minutes) || 0
  const hours = computeHours(emp.work_start, emp.work_end, brk)
  if (hours <= 0) return 0

  let created = 0
  const start = new Date(effFrom + 'T00:00:00Z')
  const end = new Date(effTo + 'T00:00:00Z')
  for (let d = new Date(start); d <= end; d = addDaysUTC(d, 1)) {
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const date = isoDate(d)
    const y = d.getUTCFullYear()
    if (!holidayCache.has(y)) holidayCache.set(y, polishHolidays(y))
    if (holidayCache.get(y)!.has(date)) continue
    if (existingDates.has(date)) continue
    if ((leaves as any[]).some(l => l.date_from <= date && l.date_to >= date)) continue
    await db.work_time_entries.upsertForDay(emp.id, date, {
      start_time: emp.work_start, end_time: emp.work_end, break_minutes: brk,
      hours_worked: hours, updated_at: now(),
    }, {
      id: uuidv4(), night_hours: 0, overtime_hours: 0,
      duty_start: null, duty_end: null, duty_place: null,
      notes: null, created_by: 'auto-grafik', created_at: now(),
    })
    created++
  }
  return created
}

// Dzienny job (wołany z index.ts): uzupełnia ostatnie `daysBack` dni do wczoraj włącznie.
export async function fillScheduleEntries(daysBack = 7): Promise<void> {
  try {
    const employees: any[] = await db.employees.all()
    const enabled = employees.filter(e => e.auto_time_enabled)
    if (enabled.length === 0) return
    const yesterday = isoDate(addDaysUTC(new Date(), -1))
    const from = isoDate(addDaysUTC(new Date(), -daysBack))
    let total = 0
    for (const emp of enabled) total += await fillScheduleForEmployee(emp, from, yesterday)
    if (total > 0) console.log(`[HR grafik] Auto-uzupełniono ${total} wpisów ewidencji (${enabled.length} pracowników)`)
  } catch (e: any) {
    console.error('[HR grafik] Błąd auto-uzupełniania:', e?.message ?? e)
  }
}

// PUT /api/hr/admin/schedule/:employeeId — konfiguracja grafiku pracownika
router.put('/admin/schedule/:employeeId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const emp = await db.employees.find(req.params.employeeId)
    if (!emp) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    const patch: any = { updated_at: now() }
    if (req.body.auto_time_enabled !== undefined) patch.auto_time_enabled = Boolean(req.body.auto_time_enabled)
    if (req.body.work_start !== undefined) {
      if (toMin(req.body.work_start) === null) { res.status(400).json({ error: 'Godzina rozpoczęcia w formacie HH:MM' }); return }
      patch.work_start = req.body.work_start
    }
    if (req.body.work_end !== undefined) {
      if (toMin(req.body.work_end) === null) { res.status(400).json({ error: 'Godzina zakończenia w formacie HH:MM' }); return }
      patch.work_end = req.body.work_end
    }
    if (req.body.work_break_minutes !== undefined) patch.work_break_minutes = Number(req.body.work_break_minutes) || 0
    await db.employees.update(emp.id, patch)
    res.json(await db.employees.find(emp.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/hr/admin/fill-schedule/:employeeId { month } — uzupełnij miesiąc z grafiku (do wczoraj)
router.post('/admin/fill-schedule/:employeeId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const emp: any = await db.employees.find(req.params.employeeId)
    if (!emp) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    const month = String(req.body.month || '')
    if (!/^\d{4}-\d{2}$/.test(month)) { res.status(400).json({ error: 'Podaj miesiąc RRRR-MM' }); return }
    const year = Number(month.slice(0, 4)), mm = Number(month.slice(5, 7))
    const lastDay = `${month}-${String(new Date(year, mm, 0).getDate()).padStart(2, '0')}`
    const yesterday = isoDate(addDaysUTC(new Date(), -1))
    const to = lastDay < yesterday ? lastDay : yesterday
    if (`${month}-01` > to) { res.status(400).json({ error: 'Można uzupełniać tylko dni zakończone (do wczoraj)' }); return }
    const created = await fillScheduleForEmployee(emp, `${month}-01`, to)
    res.json({ created, from: `${month}-01`, to })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

export default router
