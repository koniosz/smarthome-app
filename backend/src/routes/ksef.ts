import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAdmin } from '../middleware/auth'
import { syncInvoices, getStatus, debugAuth } from '../services/ksef'

const prisma = new PrismaClient()
const router = Router()

// Wszystkie endpointy KSeF tylko dla admina
router.use(requireAdmin)

// GET /api/ksef/debug-auth — diagnostyka autoryzacji (szczegółowe błędy)
router.get('/debug-auth', async (_req: Request, res: Response) => {
  try {
    const result = await debugAuth()
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/ksef/status — status połączenia i konfiguracji
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getStatus()
    res.json(status)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/ksef/sync — ręczna synchronizacja (opcjonalnie z dateFrom)
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const { dateFrom } = req.body
    const result = await syncInvoices(dateFrom ? new Date(dateFrom) : undefined)
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/ksef/invoices — lista faktur z filtrami
router.get('/invoices', async (req: Request, res: Response) => {
  try {
    const { assigned, search, page = '1', limit = '50' } = req.query

    const where: any = {}

    if (assigned === 'true')  where.project_id = { not: null }
    if (assigned === 'false') where.project_id = null

    if (search) {
      const s = String(search)
      where.OR = [
        { invoice_number: { contains: s, mode: 'insensitive' } },
        { seller_name:    { contains: s, mode: 'insensitive' } },
        { seller_nip:     { contains: s, mode: 'insensitive' } },
        { ksef_number:    { contains: s, mode: 'insensitive' } },
      ]
    }

    const skip = (parseInt(String(page)) - 1) * parseInt(String(limit))
    const take = parseInt(String(limit))

    const [invoices, total] = await Promise.all([
      prisma.ksefInvoice.findMany({
        where,
        orderBy: { invoice_date: 'desc' },
        skip,
        take,
        include: { project: { select: { id: true, name: true, client_name: true } } },
      }),
      prisma.ksefInvoice.count({ where }),
    ])

    res.json({ invoices, total, page: parseInt(String(page)), limit: take })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/ksef/invoices/:id/assign — przypisz fakturę do projektu
router.patch('/invoices/:id/assign', async (req: Request, res: Response) => {
  try {
    const { project_id, notes } = req.body
    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }

    const updated = await prisma.ksefInvoice.update({
      where: { id: req.params.id },
      data: {
        project_id: project_id || null,
        notes: notes ?? invoice.notes,
      },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })
    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/ksef/invoices/:id/notes — zaktualizuj notatkę
router.patch('/invoices/:id/notes', async (req: Request, res: Response) => {
  try {
    const { notes } = req.body
    const updated = await prisma.ksefInvoice.update({
      where: { id: req.params.id },
      data:  { notes },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })
    res.json(updated)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/ksef/invoices/:id — usuń fakturę z bazy (nie z KSeF)
router.delete('/invoices/:id', async (req: Request, res: Response) => {
  try {
    await prisma.ksefInvoice.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
