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

// GET /api/projects/:projectId/costs
router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await db.cost_items.forProject(req.params.projectId))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/projects/:projectId/costs/audit-log
router.get('/audit-log', async (req: Request, res: Response) => {
  try {
    res.json(await db.cost_audit_log.forProject(req.params.projectId))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/costs
router.post('/', async (req: Request, res: Response) => {
  try {
    const { category, description, quantity, unit_price, supplier, invoice_number, date } = req.body

    if (!description) { res.status(400).json({ error: 'Opis jest wymagany' }); return }
    if (!await db.projects.find(req.params.projectId)) {
      res.status(404).json({ error: 'Projekt nie znaleziony' }); return
    }

    const qty = quantity || 1
    const price = unit_price || 0
    const item = {
      id: uuidv4(),
      project_id: req.params.projectId,
      category: category || 'materials',
      description,
      quantity: qty,
      unit_price: price,
      total_price: qty * price,
      supplier: supplier || '',
      invoice_number: invoice_number || '',
      date: date || new Date().toISOString().slice(0, 10),
      created_at: now(),
    }

    await db.cost_items.insert(item)
    await db.projects.update(req.params.projectId, { updated_at: now() })

    const { user_id, user_name } = auditUser(req)
    await db.cost_audit_log.insert({
      id: uuidv4(),
      project_id: req.params.projectId,
      action: 'add',
      entity: 'cost',
      entity_id: item.id,
      description: `Dodano koszt: ${description} (${category || 'materials'}) — ${qty * price} PLN`,
      user_id,
      user_name,
      created_at: now(),
    })

    res.status(201).json(item)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/costs/:id
export const updateCost = async (req: Request, res: Response) => {
  try {
    const existing = await db.cost_items.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Pozycja nie znaleziona' }); return }

    const { category, description, quantity, unit_price, supplier, invoice_number, date } = req.body
    const qty = quantity ?? existing.quantity
    const price = unit_price ?? existing.unit_price

    await db.cost_items.update(req.params.id, {
      category: category ?? existing.category,
      description: description ?? existing.description,
      quantity: qty,
      unit_price: price,
      total_price: qty * price,
      supplier: supplier ?? existing.supplier,
      invoice_number: invoice_number ?? existing.invoice_number,
      date: date ?? existing.date,
    })

    await db.projects.update(existing.project_id, { updated_at: now() })

    const { user_id, user_name } = auditUser(req)
    await db.cost_audit_log.insert({
      id: uuidv4(),
      project_id: existing.project_id,
      action: 'edit',
      entity: 'cost',
      entity_id: req.params.id,
      description: `Edytowano koszt: ${description ?? existing.description} — ${qty * price} PLN`,
      user_id,
      user_name,
      created_at: now(),
    })

    res.json(await db.cost_items.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// DELETE /api/costs/:id
export const deleteCost = async (req: Request, res: Response) => {
  try {
    const existing = await db.cost_items.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Pozycja nie znaleziona' }); return }

    const { user_id, user_name } = auditUser(req)
    await db.cost_audit_log.insert({
      id: uuidv4(),
      project_id: existing.project_id,
      action: 'delete',
      entity: 'cost',
      entity_id: req.params.id,
      description: `Usunięto koszt: ${existing.description} — ${existing.total_price} PLN`,
      user_id,
      user_name,
      created_at: now(),
    })

    await db.cost_items.delete(req.params.id)
    await db.projects.update(existing.project_id, { updated_at: now() })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

export default router
