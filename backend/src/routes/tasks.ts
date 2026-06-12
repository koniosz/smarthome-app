import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { PrismaClient } from '@prisma/client'
import db from '../db'
import {
  graphConfigured, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
  type TaskForCalendar,
} from '../services/msgraph'

const prisma = new PrismaClient()
const router = Router()

function now() {
  return new Date().toISOString()
}

// ── Synchronizacja zadania z kalendarzem Outlook przypisanej osoby ────────────
// Wydarzenie żyje w kalendarzu pracownika (Employee.email). Zmiana przypisania
// przenosi wydarzenie do kalendarza nowej osoby. Błędy Graph nie blokują CRUD.
async function syncTaskToOutlook(task: any): Promise<void> {
  if (!graphConfigured()) return
  try {
    const assigneeEmail: string | null = task.assignee_id
      ? ((await prisma.employee.findUnique({ where: { id: task.assignee_id }, select: { email: true } }))?.email || null)
      : null

    const payload: TaskForCalendar = {
      title: task.title,
      date: task.date,
      time: task.time ?? '',
      type: task.type ?? 'work',
      done: Boolean(task.done),
      projectName: task.project?.name ?? null,
    }

    const prevOwner: string | null = task.outlook_event_owner ?? null
    const prevEvent: string | null = task.outlook_event_id ?? null

    let nextOwner: string | null = prevOwner
    let nextEvent: string | null = prevEvent

    if (prevEvent && prevOwner && prevOwner !== assigneeEmail) {
      // przypisanie zmienione → usuń z poprzedniego kalendarza
      await deleteCalendarEvent(prevOwner, prevEvent)
      nextOwner = null
      nextEvent = null
    }

    if (assigneeEmail) {
      if (nextEvent && nextOwner === assigneeEmail) {
        const ok = await updateCalendarEvent(assigneeEmail, nextEvent, payload)
        if (!ok) { // wydarzenie mogło zostać usunięte ręcznie w Outlooku — utwórz na nowo
          nextEvent = await createCalendarEvent(assigneeEmail, payload)
          nextOwner = nextEvent ? assigneeEmail : null
        }
      } else {
        nextEvent = await createCalendarEvent(assigneeEmail, payload)
        nextOwner = nextEvent ? assigneeEmail : null
      }
    }

    if (nextEvent !== prevEvent || nextOwner !== prevOwner) {
      await prisma.task.update({
        where: { id: task.id },
        data: { outlook_event_id: nextEvent, outlook_event_owner: nextOwner },
      })
    }
  } catch (err: any) {
    console.error('[Outlook] Synchronizacja zadania nieudana:', err?.message ?? err)
  }
}

// GET /api/tasks — all tasks with project + assignee info
router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await db.tasks.all())
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/tasks/outlook-status — czy integracja z Outlookiem jest skonfigurowana
router.get('/outlook-status', (_req: Request, res: Response) => {
  res.json({ configured: graphConfigured() })
})

// POST /api/tasks
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, project_id, date, time, type, assignee_id } = req.body
    if (!title || !String(title).trim()) {
      res.status(400).json({ error: 'Tytuł jest wymagany' }); return
    }
    if (!date) {
      res.status(400).json({ error: 'Data jest wymagana' }); return
    }
    const task = await db.tasks.insert({
      id: uuidv4(),
      title: String(title).trim(),
      project_id: project_id || null,
      date,
      time: time || '',
      type: type || 'work',
      assignee_id: assignee_id || null,
      done: false,
      created_at: now(),
      updated_at: now(),
    })
    // Outlook w tle — odpowiedź nie czeka na Graph
    syncTaskToOutlook(task)
    res.status(201).json(task)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/tasks/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.tasks.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Zadanie nie znalezione' }); return
    }
    const { title, project_id, date, time, type, assignee_id, done } = req.body
    const patch: any = { updated_at: now() }
    if (title !== undefined) patch.title = String(title).trim()
    if (project_id !== undefined) patch.project_id = project_id || null
    if (date !== undefined) patch.date = date
    if (time !== undefined) patch.time = time
    if (type !== undefined) patch.type = type
    if (assignee_id !== undefined) patch.assignee_id = assignee_id || null
    if (done !== undefined) patch.done = Boolean(done)
    const updated = await db.tasks.update(req.params.id, patch)
    syncTaskToOutlook({ ...updated, outlook_event_id: (existing as any).outlook_event_id, outlook_event_owner: (existing as any).outlook_event_owner })
    res.json(updated)
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
    if (existing.outlook_event_id && existing.outlook_event_owner) {
      await deleteCalendarEvent(existing.outlook_event_owner, existing.outlook_event_id)
    }
    await db.tasks.delete(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
