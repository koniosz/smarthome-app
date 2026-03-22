import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

const router = Router({ mergeParams: true })

function now() {
  return new Date().toISOString()
}

function auditUser(req: Request) {
  const u = (req as any).user
  return { user_id: u?.id ?? null, user_name: u?.display_name ?? u?.email ?? 'Nieznany' }
}

// GET /api/projects/:projectId/labor
router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await db.labor_entries.forProject(req.params.projectId))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/labor
router.post('/', async (req: Request, res: Response) => {
  try {
    const { worker_name, date, hours, hourly_rate, description } = req.body

    if (!worker_name) { res.status(400).json({ error: 'Imię pracownika jest wymagane' }); return }
    if (!await db.projects.find(req.params.projectId)) {
      res.status(404).json({ error: 'Projekt nie znaleziony' }); return
    }

    const entry = {
      id: uuidv4(),
      project_id: req.params.projectId,
      worker_name,
      date: date || new Date().toISOString().slice(0, 10),
      hours: hours || 0,
      hourly_rate: hourly_rate || 0,
      description: description || '',
      created_at: now(),
    }

    await db.labor_entries.insert(entry)
    await db.projects.update(req.params.projectId, { updated_at: now() })

    const { user_id, user_name } = auditUser(req)
    await db.cost_audit_log.insert({
      id: uuidv4(),
      project_id: req.params.projectId,
      action: 'add',
      entity: 'labor',
      entity_id: entry.id,
      description: `Dodano robociznę: ${worker_name} — ${hours || 0}h × ${hourly_rate || 0} PLN/h`,
      user_id,
      user_name,
      created_at: now(),
    })

    res.status(201).json(entry)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/labor/:id
export const updateLabor = async (req: Request, res: Response) => {
  try {
    const existing = await db.labor_entries.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Wpis nie znaleziony' }); return }

    const { worker_name, date, hours, hourly_rate, description } = req.body

    await db.labor_entries.update(req.params.id, {
      worker_name: worker_name ?? existing.worker_name,
      date: date ?? existing.date,
      hours: hours ?? existing.hours,
      hourly_rate: hourly_rate ?? existing.hourly_rate,
      description: description ?? existing.description,
    })

    await db.projects.update(existing.project_id, { updated_at: now() })

    const { user_id, user_name } = auditUser(req)
    const h = hours ?? existing.hours
    const rate = hourly_rate ?? existing.hourly_rate
    await db.cost_audit_log.insert({
      id: uuidv4(),
      project_id: existing.project_id,
      action: 'edit',
      entity: 'labor',
      entity_id: req.params.id,
      description: `Edytowano robociznę: ${worker_name ?? existing.worker_name} — ${h}h × ${rate} PLN/h`,
      user_id,
      user_name,
      created_at: now(),
    })

    res.json(await db.labor_entries.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// DELETE /api/labor/:id
export const deleteLabor = async (req: Request, res: Response) => {
  try {
    const existing = await db.labor_entries.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Wpis nie znaleziony' }); return }

    const { user_id, user_name } = auditUser(req)
    await db.cost_audit_log.insert({
      id: uuidv4(),
      project_id: existing.project_id,
      action: 'delete',
      entity: 'labor',
      entity_id: req.params.id,
      description: `Usunięto robociznę: ${existing.worker_name} — ${existing.hours}h`,
      user_id,
      user_name,
      created_at: now(),
    })

    await db.labor_entries.delete(req.params.id)
    await db.projects.update(existing.project_id, { updated_at: now() })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

export default router
