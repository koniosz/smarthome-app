import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { v4 as uuidv4 } from 'uuid'
import { requireAdmin, requireAuth } from '../middleware/auth'
import { syncInvoices, getStatus, debugAuth } from '../services/ksef'
import db from '../db'

const prisma = new PrismaClient()
const router = Router()

function auditUser(req: Request) {
  const u = (req as any).user
  return { user_id: u?.id ?? null, user_name: u?.display_name ?? u?.email ?? 'System' }
}

async function logKsefActivity(projectId: string, user: { user_id: string | null; user_name: string }, action: string, description: string, entityId?: string) {
  await db.cost_audit_log.insert({
    id: uuidv4(), project_id: projectId, action, entity: 'ksef',
    entity_id: entityId ?? null, description, user_id: user.user_id,
    user_name: user.user_name, created_at: new Date().toISOString(),
  })
}

const CATEGORIES_PL: Record<string, string> = {
  materials: 'Materiały',
  subcontractor: 'Podwykonawca',
  other: 'Inne',
}

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

// ── Alokacje faktury do projektów ─────────────────────────────────────────────
// Alokacja = przypisanie konkretnej kwoty z faktury do projektu + tworzenie CostItem

async function upsertCostItemForAllocation(
  allocationId: string,
  projectId: string,
  invoice: { invoice_number: string | null; seller_name: string | null; invoice_date: string | null; ksef_number: string | null },
  amount: number,
  notes: string,
  category: string = 'materials',
) {
  const description = [invoice.seller_name, invoice.invoice_number].filter(Boolean).join(' — ') || 'Faktura KSeF'
  const existing = await prisma.costItem.findFirst({ where: { ksef_allocation_id: allocationId } })
  if (existing) {
    return prisma.costItem.update({
      where: { id: existing.id },
      data: { category, unit_price: amount, total_price: amount, description, notes: notes || undefined, invoice_number: invoice.invoice_number ?? '', date: invoice.invoice_date ?? new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() } as any,
    })
  }
  return prisma.costItem.create({
    data: {
      id:                 require('uuid').v4(),
      project_id:         projectId,
      category,
      description,
      quantity:           1,
      unit_price:         amount,
      total_price:        amount,
      supplier:           invoice.seller_name ?? '',
      invoice_number:     invoice.invoice_number ?? '',
      date:               invoice.invoice_date ?? new Date().toISOString().split('T')[0],
      created_at:         new Date().toISOString(),
      ksef_allocation_id: allocationId,
    },
  })
}

// GET /api/ksef/invoices/:id/allocations
router.get('/invoices/:id/allocations', requireAuth, async (req: Request, res: Response) => {
  try {
    const allocations = await prisma.ksefInvoiceAllocation.findMany({
      where: { invoice_id: req.params.id },
      include: { project: { select: { id: true, name: true, client_name: true } } },
      orderBy: { created_at: 'asc' },
    })
    res.json(allocations)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// POST /api/ksef/invoices/:id/allocations — dodaj alokację
router.post('/invoices/:id/allocations', requireAuth, async (req: Request, res: Response) => {
  try {
    const { project_id, amount, notes = '', category = 'materials' } = req.body
    if (!project_id || !amount) { res.status(400).json({ error: 'Wymagane: project_id, amount' }); return }

    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }

    const { v4: uuidv4 } = require('uuid')
    const allocationId = uuidv4()
    const now = new Date().toISOString()

    const allocation = await prisma.ksefInvoiceAllocation.create({
      data: { id: allocationId, invoice_id: req.params.id, project_id, amount: parseFloat(amount), notes, category, created_at: now, updated_at: now },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })

    // Utwórz CostItem w projekcie
    await upsertCostItemForAllocation(allocationId, project_id, invoice, parseFloat(amount), notes, category)

    // Zaktualizuj project_id faktury (na pierwszy projekt jeśli jeszcze nie ustawiony)
    if (!invoice.project_id) {
      await prisma.ksefInvoice.update({ where: { id: req.params.id }, data: { project_id } })
    }

    // Log aktywności
    const user = auditUser(req)
    await logKsefActivity(project_id, user, 'add',
      `Przypisano fakturę KSeF: ${invoice.seller_name ?? ''} ${invoice.invoice_number ?? ''} — ${parseFloat(amount).toFixed(2)} ${invoice.currency} (${CATEGORIES_PL[category] ?? category})`,
      allocationId)

    res.status(201).json(allocation)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// PATCH /api/ksef/allocations/:id — edytuj alokację
router.patch('/allocations/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { amount, notes, category } = req.body
    const existing = await prisma.ksefInvoiceAllocation.findUnique({
      where: { id: req.params.id },
      include: { invoice: true },
    })
    if (!existing) { res.status(404).json({ error: 'Alokacja nie znaleziona' }); return }

    const updated = await prisma.ksefInvoiceAllocation.update({
      where: { id: req.params.id },
      data: {
        amount:   amount   !== undefined ? parseFloat(amount) : undefined,
        notes:    notes    ?? undefined,
        category: category ?? undefined,
        updated_at: new Date().toISOString(),
      },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })

    // Zaktualizuj CostItem
    await upsertCostItemForAllocation(
      req.params.id,
      existing.project_id,
      existing.invoice,
      parseFloat(amount ?? existing.amount),
      notes ?? existing.notes,
      category ?? (existing as any).category ?? 'materials',
    )

    res.json(updated)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/ksef/allocations/:id — usuń alokację i powiązany CostItem
router.delete('/allocations/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const alloc = await prisma.ksefInvoiceAllocation.findUnique({
      where: { id: req.params.id },
      include: { invoice: true, project: { select: { id: true, name: true } } },
    })

    // Usuń powiązany CostItem
    const costItem = await prisma.costItem.findFirst({ where: { ksef_allocation_id: req.params.id } })
    if (costItem) await prisma.costItem.delete({ where: { id: costItem.id } })

    await prisma.ksefInvoiceAllocation.delete({ where: { id: req.params.id } })

    // Log aktywności
    if (alloc) {
      const user = auditUser(req)
      await logKsefActivity(alloc.project_id, user, 'delete',
        `Usunięto alokację faktury KSeF: ${alloc.invoice.seller_name ?? ''} — ${alloc.amount.toFixed(2)} ${alloc.invoice.currency}`,
        req.params.id)
    }

    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

export default router
