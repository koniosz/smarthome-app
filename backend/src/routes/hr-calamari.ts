/**
 * Import historii z Calamari (oficjalne REST API, klucz z Konfiguracja → Integracje → API).
 * - klucz API podaje admin per żądanie — NIE jest zapisywany w bazie ani logach
 * - dopasowanie pracowników po e-mailu (Calamari ↔ kartoteka Employee)
 * - urlopy: zaakceptowane wnioski → LeaveRequest (status approved, znacznik importu)
 * - czas pracy: wpisy timesheet → WorkTimeEntry (istniejące dni NIE są nadpisywane)
 * - idempotentne: ponowny import pomija już zaimportowane rekordy
 *
 * API Calamari (developers.calamari.dev): Basic auth (user: "calamari", pass: klucz),
 * limity 10 req/s · 720 req/h. Endpointy POST: /api/employees/v1/search,
 * /api/leave/request/v1/find {from,to,employee}, /api/clockin/timesheetentries/v1/find {from,to,employees[]}
 */
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import db, { prisma } from '../db'
import { requireAdmin } from '../middleware/auth'
import { workingDaysBetween } from './hr'

const router = Router()
const now = () => new Date().toISOString()

// Mapowanie nazw typów nieobecności Calamari → nasze LEAVE_TYPES (heurystyka po nazwie)
export function mapAbsenceType(name: string): string {
  const t = (name || '').toLowerCase()
  if (/żądanie|zadanie|on demand/.test(t)) return 'na_zadanie'
  if (/wypoczynk|urlop wypocz|vacation|holiday/.test(t)) return 'wypoczynkowy'
  if (/okolicznościow|okolicznosciow/.test(t)) return 'okolicznosciowy'
  if (/bezpłatn|bezplatn|unpaid/.test(t)) return 'bezplatny'
  if (/opiek.*dzieck|art\.?\s*188/.test(t)) return 'opieka_dziecko'
  if (/opiekuńcz|opiekuncz/.test(t)) return 'opiekunczy'
  if (/macierzyńsk|macierzynsk|maternity/.test(t)) return 'macierzynski'
  if (/rodzicielsk|parental/.test(t)) return 'rodzicielski'
  if (/ojcowsk|paternity/.test(t)) return 'ojcowski'
  if (/wychowawcz/.test(t)) return 'wychowawczy'
  if (/chorob|l4|zwolnienie lekarskie|sick/.test(t)) return 'chorobowe'
  return 'inna'
}

function calamariClient(tenant: string, apiKey: string) {
  const base = `https://${tenant.replace(/[^a-z0-9-]/gi, '')}.calamari.io`
  return axios.create({
    baseURL: base,
    auth: { username: 'calamari', password: apiKey },
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Stronicowane pobieranie (Calamari zwraca {currentPage, totalPages, ...})
async function fetchAllPages(client: ReturnType<typeof calamariClient>, url: string, body: any, listKeys: string[]): Promise<any[]> {
  const out: any[] = []
  for (let page = 0; page < 100; page++) {
    const { data } = await client.post(url, { ...body, page })
    let list: any[] | null = null
    for (const k of listKeys) if (Array.isArray(data?.[k])) { list = data[k]; break }
    if (!list && Array.isArray(data)) list = data
    if (!list) break
    out.push(...list)
    const total = Number(data?.totalPages ?? 1)
    if (page + 1 >= total) break
  }
  return out
}

// ── POST /api/hr/calamari/import ─────────────────────────────────────────────
// body: { tenant, api_key, date_from, date_to, dry_run, import_leaves, import_timesheets }
router.post('/import', requireAdmin, async (req: Request, res: Response) => {
  try {
    const tenant = String(req.body.tenant || '').trim()
    const apiKey = String(req.body.api_key || '').trim()
    const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date_from)) ? String(req.body.date_from) : '2015-01-01'
    const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date_to)) ? String(req.body.date_to) : now().slice(0, 10)
    const dryRun = req.body.dry_run !== false
    const doLeaves = req.body.import_leaves !== false
    const doTimesheets = req.body.import_timesheets !== false
    if (!tenant || !apiKey) { res.status(400).json({ error: 'Podaj nazwę firmy (tenant) i klucz API Calamari' }); return }

    const client = calamariClient(tenant, apiKey)

    // 1) Pracownicy z Calamari + mapowanie po e-mailu do naszych kartotek
    let calEmployees: any[]
    try {
      // search = także zarchiwizowani pracownicy (historia byłych pracowników)
      calEmployees = await fetchAllPages(client, '/api/employees/v1/search', {}, ['employees'])
    } catch (e: any) {
      const st = e?.response?.status
      if (st === 401 || st === 403) { res.status(400).json({ error: 'Calamari odrzuciło klucz API (401/403) — sprawdź klucz i nazwę firmy' }); return }
      res.status(502).json({ error: `Nie udało się połączyć z Calamari (${st ?? e?.code ?? 'błąd sieci'}) — sprawdź nazwę firmy (https://NAZWA.calamari.io)` })
      return
    }

    const ourEmployees: any[] = await db.employees.all()
    const byEmail = new Map<string, any>()
    for (const e of ourEmployees) if (e.email) byEmail.set(String(e.email).toLowerCase(), e)

    const matched: Array<{ calamari: string; employee: any }> = []
    const unmatched: string[] = []
    for (const ce of calEmployees) {
      const email = String(ce.email || '').toLowerCase()
      const emp = email ? byEmail.get(email) : null
      if (emp) matched.push({ calamari: email, employee: emp })
      else unmatched.push(`${ce.firstName ?? ''} ${ce.lastName ?? ''} <${ce.email ?? 'brak e-maila'}>`.trim())
    }
    const empByEmail = new Map(matched.map(m => [m.calamari, m.employee]))

    const result: any = {
      dry_run: dryRun,
      range: { from: dateFrom, to: dateTo },
      employees: { calamari: calEmployees.length, matched: matched.length, unmatched },
      leaves: { fetched: 0, imported: 0, skipped_existing: 0, skipped_unmatched: 0, by_type: {} as Record<string, number> },
      timesheets: { fetched: 0, imported: 0, skipped_existing: 0, skipped_unmatched: 0 },
    }

    // 2) Urlopy (zaakceptowane) → LeaveRequest
    if (doLeaves) {
      // per pracownik — udokumentowane body {from, to, employee}; pracownik znany z żądania
      const leaves: any[] = []
      for (const m of matched) {
        const { data } = await client.post('/api/leave/request/v1/find', { from: dateFrom, to: dateTo, dateFrom, dateTo, employee: m.calamari })
        const list: any[] = Array.isArray(data) ? data : (data?.leaveRequests ?? data?.requests ?? data?.items ?? [])
        for (const lv of list) leaves.push({ ...lv, __email: m.calamari })
      }
      result.leaves.fetched = leaves.length

      const existing: any[] = await prisma.leaveRequest.findMany({
        select: { employee_id: true, date_from: true, date_to: true, type: true },
      })
      const existsKey = new Set(existing.map(l => `${l.employee_id}|${l.date_from}|${l.date_to}|${l.type}`))

      for (const lv of leaves) {
        const status = String(lv.status ?? lv.state ?? '').toUpperCase()
        if (status && !['ACCEPTED', 'APPROVED'].includes(status)) continue
        const email = String(lv.__email ?? lv.employee?.email ?? lv.employee ?? '').toLowerCase()
        const emp = empByEmail.get(email)
        if (!emp) { result.leaves.skipped_unmatched++; continue }
        const from = String(lv.from ?? lv.startDate ?? '').slice(0, 10)
        const to = String(lv.to ?? lv.endDate ?? from).slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) continue
        const typeName = String(lv.absenceTypeName ?? lv.absenceType?.name ?? lv.type ?? '')
        const type = mapAbsenceType(typeName)
        result.leaves.by_type[type] = (result.leaves.by_type[type] || 0) + 1

        const key = `${emp.id}|${from}|${to}|${type}`
        if (existsKey.has(key)) { result.leaves.skipped_existing++; continue }
        existsKey.add(key)

        if (!dryRun) {
          await prisma.leaveRequest.create({ data: {
            id: uuidv4(), employee_id: emp.id, type,
            date_from: from, date_to: to,
            days_count: workingDaysBetween(from, to),
            status: 'approved',
            comment: typeName && type === 'inna' ? `Calamari: ${typeName}` : null,
            admin_comment: 'Import z Calamari',
            decided_by: 'import-calamari', decided_at: now(), created_at: now(),
          }})
        }
        result.leaves.imported++
      }
    }

    // 3) Czas pracy (timesheet) → WorkTimeEntry (bez nadpisywania istniejących dni)
    if (doTimesheets) {
      // per pracownik i per rok — pracownik znany z żądania, zakres bezpieczny dla API
      const entries: any[] = []
      const yFrom = parseInt(dateFrom.slice(0, 4)), yTo = parseInt(dateTo.slice(0, 4))
      for (const m of matched) {
        for (let y = yFrom; y <= yTo; y++) {
          const from = y === yFrom ? dateFrom : `${y}-01-01`
          const to = y === yTo ? dateTo : `${y}-12-31`
          const { data } = await client.post('/api/clockin/timesheetentries/v1/find', { from, to, dateFrom: from, dateTo: to, employees: [m.calamari] })
          const list: any[] = Array.isArray(data) ? data : (data?.entries ?? data?.timesheetEntries ?? data?.items ?? [])
          for (const en of list) entries.push({ ...en, __email: m.calamari })
        }
      }
      result.timesheets.fetched = entries.length

      const existingWt: any[] = await prisma.workTimeEntry.findMany({ select: { employee_id: true, date: true } })
      const wtKey = new Set(existingWt.map(w => `${w.employee_id}|${w.date}`))

      // agregacja wpisów per pracownik+dzień (kilka odbić w ciągu dnia → jeden wpis, suma godzin)
      const perDay = new Map<string, { emp: any; date: string; start: string; end: string; minutes: number }>()
      for (const en of entries) {
        const email = String(en.__email ?? en.person?.email ?? en.employee?.email ?? en.employee ?? '').toLowerCase()
        const emp = empByEmail.get(email)
        if (!emp) { result.timesheets.skipped_unmatched++; continue }
        const started = String(en.started ?? en.startDateTime ?? en.start ?? '')
        const finished = String(en.finished ?? en.endDateTime ?? en.end ?? '')
        const date = started.slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !finished) continue
        const sT = started.slice(11, 16) || '00:00'
        const eT = finished.slice(11, 16) || '00:00'
        const mins = Math.max(0, (new Date(finished).getTime() - new Date(started).getTime()) / 60000)
        const key = `${emp.id}|${date}`
        const cur = perDay.get(key)
        if (!cur) perDay.set(key, { emp, date, start: sT, end: eT, minutes: mins })
        else {
          cur.minutes += mins
          if (sT < cur.start) cur.start = sT
          if (eT > cur.end) cur.end = eT
        }
      }

      for (const { emp, date, start, end, minutes } of perDay.values()) {
        if (wtKey.has(`${emp.id}|${date}`)) { result.timesheets.skipped_existing++; continue }
        if (!dryRun) {
          await prisma.workTimeEntry.create({ data: {
            id: uuidv4(), employee_id: emp.id, date,
            start_time: start, end_time: end, break_minutes: 0,
            hours_worked: Math.round(minutes / 6) / 10,
            night_hours: 0, overtime_hours: 0,
            notes: 'Import z Calamari', created_by: 'import-calamari', created_at: now(),
          }})
        }
        result.timesheets.imported++
      }
    }

    res.json(result)
  } catch (e: any) {
    const st = e?.response?.status
    console.error('[hr-calamari/import]', st ?? '', e?.message)
    res.status(500).json({ error: st ? `Calamari HTTP ${st}: ${JSON.stringify(e?.response?.data ?? '').slice(0, 200)}` : (e?.message ?? 'Błąd importu') })
  }
})

export default router
