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
  internal: 'Wewnętrzne potrzeby',
}

// ── CFO financial taxonomy ────────────────────────────────────────────────────

export const COST_TAXONOMY: Record<string, { label: string; subcategories: Record<string, string> }> = {
  cogs:       { label: 'COGS — Koszt własny sprzedaży', subcategories: {
    hardware:               'Sprzęt (KNX/HDL/Control4…)',
    subcontractor:          'Podwykonawca',
    installation_material:  'Materiały instalacyjne',
    labor:                  'Robocizna własna',
  }},
  sales:      { label: 'Sprzedaż i Marketing', subcategories: {
    advertising:    'Reklama (Facebook/Google Ads)',
    commission:     'Prowizja / pośrednictwo',
    crm_software:   'CRM / narzędzia sprzedaży',
    marketing:      'Marketing ogólny',
  }},
  ga:         { label: 'G&A — Ogólno-administracyjne', subcategories: {
    rent:           'Czynsz biuro / magazyn',
    utilities:      'Media (prąd, internet, woda)',
    salary_admin:   'Wynagrodzenia — administracja',
    software:       'Oprogramowanie / licencje',
    accounting:     'Księgowość / doradztwo podatkowe',
    legal:          'Usługi prawne',
    office_supplies:'Materiały biurowe',
  }},
  operations: { label: 'Koszty Operacyjne', subcategories: {
    car_fuel:    'Paliwo',
    car_service: 'Serwis pojazdów',
    tools:       'Narzędzia i sprzęt operacyjny',
    insurance:   'Ubezpieczenie',
    travel:      'Podróże służbowe',
  }},
  financial:  { label: 'Koszty Finansowe', subcategories: {
    bank_fee: 'Opłaty bankowe',
    interest: 'Odsetki',
    leasing:  'Leasing',
    fx:       'Różnice kursowe',
  }},
}

const BUSINESS_UNITS: Record<string, string> = {
  shc:       'Smart Home Center',
  gatelynk:  'GateLynk',
  shared:    'Wspólne',
}

/** Auto-classifies allocation based on invoice seller_name + description. */
function autoClassify(sellerName: string | null, description: string | null): {
  cost_category: string; subcategory: string; business_unit: string
} {
  const text = `${sellerName ?? ''} ${description ?? ''}`.toLowerCase()

  // COGS / Hardware — smart home brands
  if (/\b(knx|hdl|eelectron|tyba|mdt|control4|hikvision|satel|fibaro|somfy|lutron|ajax|dahua|bosch hager|jung|gira|loxone|teletask|siemens)\b/.test(text))
    return { cost_category: 'cogs', subcategory: 'hardware', business_unit: 'shc' }

  // Sales — advertising platforms
  if (/\b(facebook|meta ads?|instagram ads?|google ads?|linkedin|allegro)\b/.test(text))
    return { cost_category: 'sales', subcategory: 'advertising', business_unit: 'gatelynk' }
  if (/\b(hubspot|pipedrive|salesforce|crm)\b/.test(text))
    return { cost_category: 'sales', subcategory: 'crm_software', business_unit: 'shared' }

  // G&A
  if (/czynsz|najem lok|wynajem.*biur|wynajem.*magazyn/.test(text))
    return { cost_category: 'ga', subcategory: 'rent', business_unit: 'shared' }
  if (/księgow|rachunkow|biuro rachunkow|doradca podatk|biuro podatkow/.test(text))
    return { cost_category: 'ga', subcategory: 'accounting', business_unit: 'shared' }
  if (/prawnik|kancelari|notariu/.test(text))
    return { cost_category: 'ga', subcategory: 'legal', business_unit: 'shared' }
  if (/\b(microsoft|adobe|apple|atlassian|slack|zoom)\b|licencja|subskrypcja/.test(text))
    return { cost_category: 'ga', subcategory: 'software', business_unit: 'shared' }

  // Operations
  if (/paliwo|\b(shell|orlen|bp|lotos|circle k|amic)\b|stacja paliw/.test(text))
    return { cost_category: 'operations', subcategory: 'car_fuel', business_unit: 'shared' }
  if (/serwis.*auto|warsztat|naprawa.*pojazd|auto.*serwis|auto.*naprawa/.test(text))
    return { cost_category: 'operations', subcategory: 'car_service', business_unit: 'shared' }
  if (/ubezpieczen/.test(text))
    return { cost_category: 'operations', subcategory: 'insurance', business_unit: 'shared' }

  // Financial
  if (/opłat.*bank|prowizja.*bank|przelew.*bank|\b(pko|mbank|santander|ing|bnp|alior|millennium)\b/.test(text))
    return { cost_category: 'financial', subcategory: 'bank_fee', business_unit: 'shared' }
  if (/leasing/.test(text))
    return { cost_category: 'financial', subcategory: 'leasing', business_unit: 'shared' }

  // Default: COGS hardware
  return { cost_category: 'cogs', subcategory: 'hardware', business_unit: 'shc' }
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

// PATCH /api/ksef/invoices/:id/due-date
router.patch('/invoices/:id/due-date', requireAuth, async (req: Request, res: Response) => {
  try {
    const { payment_due_date } = req.body
    const updated = await prisma.ksefInvoice.update({
      where: { id: req.params.id },
      data: { payment_due_date: payment_due_date ?? null },
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

// GET /api/ksef/pnl — raport P&L / EBITDA (requireAdmin)
// MUST be before /:id routes
router.get('/pnl', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, business_unit } = req.query

    // ── Costs: all KSeF allocations ──────────────────────────────────────────
    const allocWhere: any = {}
    if (business_unit && business_unit !== 'all') allocWhere.business_unit = String(business_unit)
    // Filter by invoice_date on the parent invoice
    if (dateFrom || dateTo) {
      const dateFilter: any = {}
      if (dateFrom) dateFilter.gte = String(dateFrom)
      if (dateTo)   dateFilter.lte = String(dateTo) + 'T23:59:59Z'
      allocWhere.created_at = dateFilter
    }

    const allocations = await prisma.ksefInvoiceAllocation.findMany({
      where: allocWhere,
      include: {
        invoice: { select: { invoice_number: true, seller_name: true, invoice_date: true, currency: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
    })

    // ── Revenue: ClientPayments ───────────────────────────────────────────────
    const payWhere: any = {}
    if (dateFrom || dateTo) {
      const df: any = {}
      if (dateFrom) df.gte = String(dateFrom)
      if (dateTo)   df.lte = String(dateTo)
      payWhere.date = df
    }
    const payments = await prisma.clientPayment.findMany({
      where: payWhere,
      include: { project: { select: { id: true, name: true } } },
    })

    // ── Group costs ───────────────────────────────────────────────────────────
    type CatTotals = { total: number; subcategories: Record<string, number>; by_bu: Record<string, number> }
    const grouped: Record<string, CatTotals> = {}
    for (const key of Object.keys(COST_TAXONOMY)) {
      grouped[key] = { total: 0, subcategories: {}, by_bu: { shc: 0, gatelynk: 0, shared: 0 } }
    }

    for (const alloc of allocations) {
      const cat = (alloc as any).cost_category ?? 'cogs'
      const sub = (alloc as any).subcategory ?? 'hardware'
      const bu  = (alloc as any).business_unit ?? 'shc'
      if (!grouped[cat]) grouped[cat] = { total: 0, subcategories: {}, by_bu: {} }
      grouped[cat].total += alloc.amount
      grouped[cat].subcategories[sub] = (grouped[cat].subcategories[sub] ?? 0) + alloc.amount
      grouped[cat].by_bu[bu] = (grouped[cat].by_bu[bu] ?? 0) + alloc.amount
    }

    const revenue      = payments.reduce((s, p) => s + p.amount, 0)
    const cogs         = grouped['cogs']?.total ?? 0
    const sales        = grouped['sales']?.total ?? 0
    const ga           = grouped['ga']?.total ?? 0
    const operations   = grouped['operations']?.total ?? 0
    const financial    = grouped['financial']?.total ?? 0
    const gross_margin = revenue - cogs
    const opex         = sales + ga + operations
    const ebitda       = gross_margin - opex
    const ebit         = ebitda - financial

    // Revenue by business unit (from project client payments — approximate via project_type)
    const revenueByProject = payments.reduce((acc: Record<string, number>, p) => {
      const key = p.project?.name ?? 'other'
      acc[key] = (acc[key] ?? 0) + p.amount
      return acc
    }, {})

    res.json({
      period:       { from: dateFrom ?? null, to: dateTo ?? null },
      business_unit: business_unit ?? 'all',
      revenue,
      revenue_by_project: revenueByProject,
      cogs:      grouped['cogs'],
      sales:     grouped['sales'],
      ga:        grouped['ga'],
      operations:grouped['operations'],
      financial: grouped['financial'],
      gross_margin,
      gross_margin_pct: revenue > 0 ? (gross_margin / revenue) * 100 : 0,
      opex,
      ebitda,
      ebitda_pct: revenue > 0 ? (ebitda / revenue) * 100 : 0,
      ebit,
      ebit_pct: revenue > 0 ? (ebit / revenue) * 100 : 0,
      allocation_count: allocations.length,
      payment_count:    payments.length,
      allocations,   // full drill-down data
    })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// GET /api/ksef/invoices/due-today — faktury z terminem płatności <= dziś (requireAdmin)
router.get('/invoices/due-today', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const todayStr = new Date().toISOString().split('T')[0]
    const invoices = await prisma.ksefInvoice.findMany({
      where: {
        payment_due_date: { not: null, lte: todayStr },
        payment_status:   { not: 'paid' },
      },
      select: {
        id: true, invoice_number: true, seller_name: true,
        gross_amount: true, currency: true, payment_due_date: true, payment_status: true,
      },
      orderBy: { payment_due_date: 'asc' },
    })
    res.json(invoices)
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
    const { project_id, amount, notes = '', category = 'materials', allocation_type = 'project',
            cost_category, subcategory, business_unit } = req.body
    if (!amount) { res.status(400).json({ error: 'Wymagane: amount' }); return }
    if (allocation_type === 'project' && !project_id) { res.status(400).json({ error: 'Wymagane: project_id dla alokacji projektowej' }); return }

    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }

    // Auto-classify if taxonomy fields not provided
    const classified = autoClassify(invoice.seller_name, notes || null)
    const finalCostCat  = cost_category  ?? classified.cost_category
    const finalSubcat   = subcategory    ?? classified.subcategory
    const finalBU       = business_unit  ?? classified.business_unit

    const { v4: uuidv4 } = require('uuid')
    const allocationId = uuidv4()
    const now = new Date().toISOString()

    const allocation = await prisma.ksefInvoiceAllocation.create({
      data: {
        id: allocationId,
        invoice_id: req.params.id,
        project_id: allocation_type === 'project' ? project_id : null,
        amount: parseFloat(amount),
        notes,
        category,
        allocation_type,
        cost_category: finalCostCat,
        subcategory:   finalSubcat,
        business_unit: finalBU,
        created_at: now,
        updated_at: now,
      },
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })

    if (allocation_type === 'project' && project_id) {
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
    }

    res.status(201).json(allocation)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// PATCH /api/ksef/allocations/:id — edytuj alokację
router.patch('/allocations/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { amount, notes, category, is_paid, cost_category, subcategory, business_unit } = req.body
    const existing = await prisma.ksefInvoiceAllocation.findUnique({
      where: { id: req.params.id },
      include: { invoice: true },
    })
    if (!existing) { res.status(404).json({ error: 'Alokacja nie znaleziona' }); return }

    const updateData: any = {
      updated_at: new Date().toISOString(),
    }
    if (amount        !== undefined) updateData.amount        = parseFloat(amount)
    if (notes         !== undefined) updateData.notes         = notes
    if (category      !== undefined) updateData.category      = category
    if (is_paid       !== undefined) updateData.is_paid       = Boolean(is_paid)
    if (cost_category !== undefined) updateData.cost_category = cost_category
    if (subcategory   !== undefined) updateData.subcategory   = subcategory
    if (business_unit !== undefined) updateData.business_unit = business_unit

    const updated = await prisma.ksefInvoiceAllocation.update({
      where: { id: req.params.id },
      data: updateData,
      include: { project: { select: { id: true, name: true, client_name: true } } },
    })

    // Zaktualizuj CostItem tylko dla alokacji projektowych
    if (existing.project_id && (existing as any).allocation_type !== 'internal') {
      await upsertCostItemForAllocation(
        req.params.id,
        existing.project_id,
        existing.invoice,
        parseFloat(amount ?? existing.amount),
        notes ?? existing.notes,
        category ?? (existing as any).category ?? 'materials',
      )
    }

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

    // Log aktywności (tylko dla alokacji projektowych z project_id)
    if (alloc && alloc.project_id) {
      const user = auditUser(req)
      await logKsefActivity(alloc.project_id, user, 'delete',
        `Usunięto alokację faktury KSeF: ${alloc.invoice.seller_name ?? ''} — ${alloc.amount.toFixed(2)} ${alloc.invoice.currency}`,
        req.params.id)
    }

    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

export default router
