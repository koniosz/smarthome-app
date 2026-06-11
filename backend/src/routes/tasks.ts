import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

const router = Router()

function now() {
  return new Date().toISOString()
}

// GET /api/tasks — all tasks with project + assignee info
router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await db.tasks.all())
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
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
    res.json(await db.tasks.update(req.params.id, patch))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/tasks/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.tasks.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Zadanie nie znalezione' }); return
    }
    await db.tasks.delete(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
