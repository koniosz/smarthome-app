import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

const router = Router({ mergeParams: true })

function now() { return new Date().toISOString() }

// GET /api/projects/:projectId/payments
router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await db.client_payments.forProject(req.params.projectId))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/payments
router.post('/', async (req: Request, res: Response) => {
  try {
    const { amount, date, description, invoice_number, payment_type } = req.body

    if (!amount || isNaN(parseFloat(amount))) {
      res.status(400).json({ error: 'Kwota jest wymagana' }); return
    }
    if (!await db.projects.find(req.params.projectId)) {
      res.status(404).json({ error: 'Projekt nie znaleziony' }); return
    }

    const payment = {
      id: uuidv4(),
      project_id: req.params.projectId,
      amount: parseFloat(amount),
      date: date || new Date().toISOString().slice(0, 10),
      description: description || '',
      invoice_number: invoice_number || '',
      payment_type: payment_type || 'standard',
      created_at: now(),
    }

    await db.client_payments.insert(payment)
    await db.projects.update(req.params.projectId, { updated_at: now() })
    res.status(201).json(payment)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/payments/:id
export const updatePayment = async (req: Request, res: Response) => {
  try {
    const existing = await db.client_payments.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Płatność nie znaleziona' }); return }

    const { amount, date, description, invoice_number, payment_type } = req.body
    await db.client_payments.update(req.params.id, {
      amount: amount !== undefined ? parseFloat(amount) : existing.amount,
      date: date ?? existing.date,
      description: description ?? existing.description,
      invoice_number: invoice_number ?? existing.invoice_number,
      payment_type: payment_type ?? existing.payment_type,
    })
    await db.projects.update(existing.project_id, { updated_at: now() })
    res.json(await db.client_payments.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// DELETE /api/payments/:id
export const deletePayment = async (req: Request, res: Response) => {
  try {
    const existing = await db.client_payments.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Płatność nie znaleziona' }); return }
    await db.client_payments.delete(req.params.id)
    await db.projects.update(existing.project_id, { updated_at: now() })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

export default router
