import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

const router = Router()

function now() { return new Date().toISOString() }

// GET /api/employees
router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await db.employees.all())
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/employees
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, hourly_rate } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'Imię i nazwisko jest wymagane' }); return }

    const employee = {
      id: uuidv4(),
      name: name.trim(),
      hourly_rate: parseFloat(hourly_rate) || 0,
      created_at: now(),
    }
    await db.employees.insert(employee)
    res.status(201).json(employee)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/employees/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.employees.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }

    const { name, hourly_rate } = req.body
    await db.employees.update(req.params.id, {
      name: name?.trim() ?? existing.name,
      hourly_rate: hourly_rate !== undefined ? parseFloat(hourly_rate) : existing.hourly_rate,
    })
    res.json(await db.employees.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/employees/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.employees.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Pracownik nie znaleziony' }); return }
    await db.employees.delete(req.params.id)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
