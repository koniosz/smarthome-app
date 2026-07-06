import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'
import {
  graphConfigured, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  listCalendarEvents, type TaskForCalendar,
} from '../services/msgraph'

const router = Router()

function now() {
  return new Date().toISOString()
}

// Normalizuj listę przypisanych z body (akceptuje assignee_ids[] lub stare assignee_id)
function readAssigneeIds(body: any): string[] | undefined {
  if (Array.isArray(body.assignee_ids)) {
    const ids = body.assignee_ids.filter((x: any) => typeof x === 'string' && !!x) as string[]
    return Array.from(new Set(ids))
  }
  if (body.assignee_id !== undefined) {
    return body.assignee_id ? [body.assignee_id] : []
  }
  return undefined // pole nieobecne → nie zmieniaj przypisań
}

// ── Synchronizacja zadania z kalendarzami Outlook wszystkich przypisanych osób ──
// Każdy przypisany pracownik ma własne wydarzenie w swoim kalendarzu (TaskAssignee).
// Błędy Graph nie blokują CRUD zadań.
async function syncTaskToOutlook(taskId: string): Promise<void> {
  if (!graphConfigured()) return
  try {
    const task: any = await db.tasks.find(taskId)
    if (!task) return

    const payload: TaskForCalendar = {
      title: task.title,
      date: task.date,
      time: task.time ?? '',
      endTime: task.end_time ?? '',
      type: task.type ?? 'work',
      done: Boolean(task.done),
      projectName: task.project?.name ?? null,
    }

    for (const a of task.assignees as any[]) {
      const email: string | null = a.employee?.email || null
      const prevEvent: string | null = a.outlook_event_id ?? null
      const prevOwner: string | null = a.outlook_event_owner ?? null

      if (!email) {
        // brak maila pracownika — nie da się utworzyć wydarzenia; posprzątaj ewentualny ślad
        if (prevEvent && prevOwner) { await deleteCalendarEvent(prevOwner, prevEvent); await db.tasks.setAssigneeEvent(a.id, null, null) }
        continue
      }

      if (prevEvent && prevOwner === email) {
        const ok = await updateCalendarEvent(email, prevEvent, payload)
        if (!ok) {
          const ev = await createCalendarEvent(email, payload)
          await db.tasks.setAssigneeEvent(a.id, ev, ev ? email : null)
        }
      } else {
        if (prevEvent && prevOwner) await deleteCalendarEvent(prevOwner, prevEvent) // mail się zmienił
        const ev = await createCalendarEvent(email, payload)
        await db.tasks.setAssigneeEvent(a.id, ev, ev ? email : null)
      }
    }
  } catch (err: any) {
    console.error('[Outlook] Synchronizacja zadania nieudana:', err?.message ?? err)
  }
}

// GET /api/tasks
router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await db.tasks.all())
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/tasks/outlook-events?from=YYYY-MM-DD&to=YYYY-MM-DD
// Warstwa wydarzeń kalendarza (tylko do odczytu): wydarzenia z Outlooka pracowników
// oraz ZATWIERDZONE urlopy/nieobecności z modułu HR (id z prefiksem 'leave:').
const LEAVE_CAL_LABELS: Record<string, string> = {
  wypoczynkowy: 'Urlop wypoczynkowy', na_zadanie: 'Urlop na żądanie', okolicznosciowy: 'Urlop okolicznościowy',
  bezplatny: 'Urlop bezpłatny', opieka_dziecko: 'Opieka nad dzieckiem', opiekunczy: 'Urlop opiekuńczy',
  macierzynski: 'Urlop macierzyński', rodzicielski: 'Urlop rodzicielski', ojcowski: 'Urlop ojcowski',
  wychowawczy: 'Urlop wychowawczy', chorobowe: 'Chorobowe (L4)', inna: 'Nieobecność',
}
router.get('/outlook-events', async (req: Request, res: Response) => {
  try {
    const from = String(req.query.from ?? '').slice(0, 10)
    const to   = String(req.query.to ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ error: 'Wymagane: from, to (YYYY-MM-DD)' }); return
    }

    // Zatwierdzone urlopy → wydarzenia całodniowe per dzień (niezależnie od konfiguracji Outlooka)
    const leaveEvents: any[] = []
    try {
      const leaves: any[] = await db.leave_requests.approvedOverlapping(from, to)
      for (const l of leaves) {
        const start = l.date_from > from ? l.date_from : from
        const end = l.date_to < to ? l.date_to : to
        for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
          const date = d.toISOString().slice(0, 10)
          leaveEvents.push({
            id: `leave:${l.id}:${date}`,
            employee_id: l.employee_id,
            employee_name: l.employee?.name ?? '',
            subject: `🏖 ${LEAVE_CAL_LABELS[l.type] ?? 'Nieobecność'} — ${l.employee?.name ?? ''}`,
            date,
            start_time: '',
            end_time: '',
            is_all_day: true,
          })
        }
      }
    } catch { /* moduł HR opcjonalny — nie blokuj warstwy Outlook */ }

    let outlookEvents: any[] = []
    if (graphConfigured()) {
      const employees = (await db.employees.all()).filter((e: any) => e.email)
      const perEmployee = await Promise.all(
        employees.map(async (e: any) => {
          const evs = await listCalendarEvents(e.email, from, to)
          return evs.map(ev => ({
            id: `${e.id}:${ev.id}`,
            employee_id: e.id,
            employee_name: e.name,
            subject: ev.subject,
            date: ev.date,
            start_time: ev.startTime,
            end_time: ev.endTime,
            is_all_day: ev.isAllDay,
          }))
        }),
      )
      outlookEvents = perEmployee.flat()
    }

    res.json({ events: [...leaveEvents, ...outlookEvents] })
  } catch (e) {
    res.json({ events: [] })
  }
})

// POST /api/tasks
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, project_id, date, time, end_time, type } = req.body
    if (!title || !String(title).trim()) {
      res.status(400).json({ error: 'Tytuł jest wymagany' }); return
    }
    if (!date) {
      res.status(400).json({ error: 'Data jest wymagana' }); return
    }
    const assigneeIds = readAssigneeIds(req.body) ?? []
    const id = uuidv4()
    await db.tasks.insert({
      id,
      title: String(title).trim(),
      project_id: project_id || null,
      date,
      time: time || '',
      end_time: end_time || '',
      type: type || 'work',
      done: false,
      created_at: now(),
      updated_at: now(),
    })
    for (const empId of assigneeIds) {
      await db.tasks.addAssignee(id, empId, now())
    }
    const task = await db.tasks.find(id)
    syncTaskToOutlook(id) // w tle
    res.status(201).json(task)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/tasks/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existing: any = await db.tasks.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Zadanie nie znalezione' }); return
    }
    const { title, project_id, date, time, end_time, type, done } = req.body
    const patch: any = { updated_at: now() }
    if (title !== undefined) patch.title = String(title).trim()
    if (project_id !== undefined) patch.project_id = project_id || null
    if (date !== undefined) patch.date = date
    if (time !== undefined) patch.time = time
    if (end_time !== undefined) patch.end_time = end_time
    if (type !== undefined) patch.type = type
    if (done !== undefined) patch.done = Boolean(done)
    await db.tasks.update(req.params.id, patch)

    // Zmiana listy przypisanych (jeśli podano)
    const wanted = readAssigneeIds(req.body)
    if (wanted) {
      const current: any[] = existing.assignees ?? []
      const currentIds = current.map(a => a.employee_id)
      // usuń tych, których nie ma na nowej liście — skasuj ich wydarzenie z Outlooka
      for (const a of current) {
        if (!wanted.includes(a.employee_id)) {
          if (a.outlook_event_id && a.outlook_event_owner) {
            await deleteCalendarEvent(a.outlook_event_owner, a.outlook_event_id)
          }
          await db.tasks.removeAssignee(a.id)
        }
      }
      // dodaj nowych
      for (const empId of wanted) {
        if (!currentIds.includes(empId)) await db.tasks.addAssignee(req.params.id, empId, now())
      }
    }

    const task = await db.tasks.find(req.params.id)
    syncTaskToOutlook(req.params.id) // w tle — zaktualizuje istniejące i utworzy nowe wydarzenia
    res.json(task)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/tasks/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing: any = await db.tasks.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Zadanie nie znalezione' }); return
    }
    for (const a of existing.assignees ?? []) {
      if (a.outlook_event_id && a.outlook_event_owner) {
        await deleteCalendarEvent(a.outlook_event_owner, a.outlook_event_id)
      }
    }
    await db.tasks.delete(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
