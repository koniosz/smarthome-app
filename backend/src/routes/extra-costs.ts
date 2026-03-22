import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

const router = Router({ mergeParams: true })

function now() {
  return new Date().toISOString()
}

// GET /api/projects/:projectId/extra-costs
router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await db.extra_costs.forProject(req.params.projectId))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/extra-costs/send
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids?: string[] }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'Brak pozycji do wysłania' }); return
    }
    const sentAt = now()
    for (const id of ids) {
      const item = await db.extra_costs.find(id)
      if (item && item.project_id === req.params.projectId) {
        await db.extra_costs.update(id, { status: 'sent', sent_at: sentAt, updated_at: sentAt })
      }
    }
    res.json({ sent: ids.length, sent_at: sentAt })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/extra-costs
router.post('/', async (req: Request, res: Response) => {
  try {
    const { description, quantity, unit_price, date, is_out_of_scope, notes } = req.body
    if (!description) { res.status(400).json({ error: 'Opis jest wymagany' }); return }

    const qty = Number(quantity) || 1
    const unitPrice = Number(unit_price) || 0
    const item = {
      id: uuidv4(),
      project_id: req.params.projectId,
      description: String(description).trim(),
      quantity: qty,
      unit_price: unitPrice,
      total_price: qty * unitPrice,
      date: date || new Date().toISOString().slice(0, 10),
      is_out_of_scope: Boolean(is_out_of_scope),
      status: 'pending',
      notes: String(notes || '').trim(),
      created_at: now(),
      updated_at: now(),
    }
    await db.extra_costs.insert(item)
    res.status(201).json(item)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/extra-costs/:id
export async function updateExtraCost(req: Request, res: Response): Promise<void> {
  try {
    const existing = await db.extra_costs.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }

    const { description, quantity, unit_price, date, is_out_of_scope, status, notes } = req.body
    const patch: any = { updated_at: now() }
    if (description !== undefined) patch.description = String(description).trim()
    if (quantity !== undefined) patch.quantity = Number(quantity) || 1
    if (unit_price !== undefined) patch.unit_price = Number(unit_price) || 0
    if (quantity !== undefined || unit_price !== undefined) {
      patch.total_price = (patch.quantity ?? existing.quantity) * (patch.unit_price ?? existing.unit_price)
    }
    if (date !== undefined) patch.date = date
    if (is_out_of_scope !== undefined) patch.is_out_of_scope = Boolean(is_out_of_scope)
    if (status !== undefined) patch.status = status
    if (notes !== undefined) patch.notes = String(notes).trim()

    await db.extra_costs.update(req.params.id, patch)
    res.json(await db.extra_costs.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// DELETE /api/extra-costs/:id
export async function deleteExtraCost(req: Request, res: Response): Promise<void> {
  try {
    const existing = await db.extra_costs.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    await db.extra_costs.delete(req.params.id)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

export default router
