import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { requireAdmin, requireAuth } from '../middleware/auth'
import { syncInvoices, getStatus, debugAuth } from '../services/ksef'

const prisma = new PrismaClient()
const router = Router()

// ── Admin-only endpoints ──────────────────────────────────────────────────────

// GET /api/ksef/debug-auth
router.get('/debug-auth', requireAdmin, async (_req: Request, res: Response) => {
  try { res.json(await debugAuth()) } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// GET /api/ksef/status
router.get('/status', requireAdmin, async (_req: Request, res: Response) => {
  try { res.json(await getStatus()) } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// POST /api/ksef/sync
router.post('/sync', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { dateFrom } = req.body
    res.json(await syncInvoices(dateFrom ? new Date(dateFrom) : undefined))
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// GET /api/ksef/invoices (admin — all invoices)
router.get('/invoices', requireAdmin, async (req: Request, res: Response) => {
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
      prisma.ksefInvoice.findMany({ where, orderBy: { invoice_date: 'desc' }, skip, take, include: { project: { select: { id: true, name: true, client_name: true } } } }),
      prisma.ksefInvoice.count({ where }),
    ])
    res.json({ invoices, total, page: parseInt(String(page)), limit: take })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// GET /api/ksef/invoices/:id/xml — pobierz XML faktury z KSeF
router.get('/invoices/:id/xml', requireAdmin, async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (!invoice.ksef_number) { res.status(400).json({ error: 'Brak numeru KSeF' }); return }
    const { getActiveSession } = await import('../services/ksef')
    const axios = (await import('axios')).default
    const xmlRes = await axios.get(
      `https://api.ksef.mf.gov.pl/v2/invoices/ksef/${encodeURIComponent(invoice.ksef_number)}`,
      { headers: { Authorization: `Bearer ${await getActiveSession()}` }, responseType: 'text', timeout: 15000 },
    )
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename="faktura-${invoice.invoice_number ?? invoice.ksef_number}.xml"`)
    res.send(xmlRes.data)
  } catch (err: any) {
    const msg = err?.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message
    res.status(500).json({ error: msg })
  }
})

// PATCH /api/ksef/invoices/:id/assign
router.patch('/invoices/:id/assign', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { project_id, notes } = req.body
    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    const updated = await prisma.ksefInvoice.update({
      where: { id: req.params.id },
      data: { project_id: project_id || null, notes: notes ?? invoice.notes },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })
    res.json(updated)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// PATCH /api/ksef/invoices/:id/notes
router.patch('/invoices/:id/notes', requireAdmin, async (req: Request, res: Response) => {
  try {
    const updated = await prisma.ksefInvoice.update({
      where: { id: req.params.id },
      data: { notes: req.body.notes },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })
    res.json(updated)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// PATCH /api/ksef/invoices/:id/share — toggle udostępniania
router.patch('/invoices/:id/share', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { is_shared } = req.body
    const updated = await prisma.ksefInvoice.update({
      where: { id: req.params.id },
      data: { is_shared: Boolean(is_shared) },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })
    res.json(updated)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/ksef/invoices/:id
router.delete('/invoices/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.ksefInvoice.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/ksef/invoices — reset all
router.delete('/invoices', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { count } = await prisma.ksefInvoice.deleteMany()
    await prisma.ksefSession.updateMany({ data: { last_sync_at: null } })
    res.json({ success: true, deleted: count })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ── User-accessible endpoints (requireAuth, not requireAdmin) ─────────────────

// GET /api/ksef/shared — udostępnione faktury dla wszystkich zalogowanych userów
router.get('/shared', requireAuth, async (req: Request, res: Response) => {
  try {
    const { search, page = '1', limit = '50' } = req.query
    const where: any = { is_shared: true }
    if (search) {
      const s = String(search)
      where.OR = [
        { invoice_number: { contains: s, mode: 'insensitive' } },
        { seller_name:    { contains: s, mode: 'insensitive' } },
        { seller_nip:     { contains: s, mode: 'insensitive' } },
      ]
    }
    const skip = (parseInt(String(page)) - 1) * parseInt(String(limit))
    const take = parseInt(String(limit))
    const [invoices, total] = await Promise.all([
      prisma.ksefInvoice.findMany({ where, orderBy: { invoice_date: 'desc' }, skip, take, include: { project: { select: { id: true, name: true, client_name: true } } } }),
      prisma.ksefInvoice.count({ where }),
    ])
    res.json({ invoices, total, page: parseInt(String(page)), limit: take })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// GET /api/ksef/shared/:id/xml — podgląd XML dla userów (tylko udostępnione)
router.get('/shared/:id/xml', requireAuth, async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice || !invoice.is_shared) { res.status(404).json({ error: 'Faktura nie znaleziona lub nieudostępniona' }); return }
    if (!invoice.ksef_number) { res.status(400).json({ error: 'Brak numeru KSeF' }); return }
    const { getActiveSession } = await import('../services/ksef')
    const axios = (await import('axios')).default
    const xmlRes = await axios.get(
      `https://api.ksef.mf.gov.pl/v2/invoices/ksef/${encodeURIComponent(invoice.ksef_number)}`,
      { headers: { Authorization: `Bearer ${await getActiveSession()}` }, responseType: 'text', timeout: 15000 },
    )
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename="faktura-${invoice.invoice_number ?? invoice.ksef_number}.xml"`)
    res.send(xmlRes.data)
  } catch (err: any) {
    const msg = err?.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message
    res.status(500).json({ error: msg })
  }
})

// PATCH /api/ksef/shared/:id/assign — user przypisuje fakturę do swojego projektu
router.patch('/shared/:id/assign', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    const { project_id, notes } = req.body
    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice || !invoice.is_shared) { res.status(404).json({ error: 'Faktura nie znaleziona lub nieudostępniona' }); return }

    // Sprawdź czy user ma dostęp do projektu
    if (project_id) {
      const member = await prisma.projectMember.findFirst({ where: { project_id, user_id: user.id } })
      const project = await prisma.project.findFirst({ where: { id: project_id, created_by: user.id } })
      if (!member && !project && user.role !== 'admin') {
        res.status(403).json({ error: 'Brak dostępu do tego projektu' }); return
      }
    }

    const updated = await prisma.ksefInvoice.update({
      where: { id: req.params.id },
      data: { project_id: project_id || null, notes: notes ?? invoice.notes },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })
    res.json(updated)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

export default router
