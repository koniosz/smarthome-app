import { Router, Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

// Faktury sprzedażowe (BETA).
// Szkic → wystawienie (numer FV/RRRR/MM/NNN) → opłacona / anulowana.
// Struktura danych przygotowana pod KSeF FA(3); WYSYŁKA DO KSeF WYŁĄCZONA
// (od 04.2026 KSeF jest obowiązkowy dla faktur B2B — włączenie wysyłki wymaga
// świadomej decyzji i osobnego modułu ksef-send; pola ksef_status/ksef_number gotowe).
// Mount: /api/sales-invoices (requireAuth + requireAdmin poniżej).
const router = Router()
const now = () => new Date().toISOString()

// Bramka: admin lub użytkownik z nadanym uprawnieniem can_view_invoices (świeży odczyt z bazy)
async function requireInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const u: any = await db.users.find((req as any).user?.id)
    if (!u || (u.role !== 'admin' && !u.can_view_invoices)) {
      res.status(403).json({ error: 'Brak dostępu do fakturowania' }); return
    }
    next()
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
}
router.use(requireInvoices)

const VAT_RATES = [0, 5, 8, 23]

function normalizeItems(raw: any[]): any[] {
  return (Array.isArray(raw) ? raw : [])
    .map((i: any, idx: number) => {
      const qty = Number(i.qty) || 0
      const price = Number(i.unit_price) || 0
      const rate = VAT_RATES.includes(Number(i.vat_rate)) ? Number(i.vat_rate) : 23
      const net = Math.round(qty * price * 100) / 100
      const vat = Math.round(net * rate) / 100
      return {
        name: String(i.name || '').trim(),
        qty, unit: i.unit ? String(i.unit).trim() : 'szt.',
        unit_price: price, vat_rate: rate,
        total_net: net, total_vat: vat, total_gross: Math.round((net + vat) * 100) / 100,
        sort_order: idx,
      }
    })
    .filter(i => i.name && i.qty > 0)
}

function computeTotals(items: any[]) {
  const byRate = new Map<number, { net: number; vat: number; gross: number }>()
  for (const i of items) {
    const b = byRate.get(i.vat_rate) || { net: 0, vat: 0, gross: 0 }
    b.net += i.total_net; b.vat += i.total_vat; b.gross += i.total_gross
    byRate.set(i.vat_rate, b)
  }
  const round = (n: number) => Math.round(n * 100) / 100
  const breakdown = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, b]) => ({ rate, net: round(b.net), vat: round(b.vat), gross: round(b.gross) }))
  return {
    total_net: round(breakdown.reduce((s, b) => s + b.net, 0)),
    total_vat: round(breakdown.reduce((s, b) => s + b.vat, 0)),
    total_gross: round(breakdown.reduce((s, b) => s + b.gross, 0)),
    vat_breakdown: breakdown,
  }
}

// GET /api/sales-invoices
router.get('/', async (_req: Request, res: Response) => {
  try { res.json(await db.sales_invoices.all()) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/sales-invoices — utwórz szkic
router.post('/', async (req: Request, res: Response) => {
  try {
    const items = normalizeItems(req.body.items)
    if (!String(req.body.buyer_name || '').trim()) { res.status(400).json({ error: 'Nazwa nabywcy jest wymagana' }); return }
    if (items.length === 0) { res.status(400).json({ error: 'Dodaj przynajmniej jedną pozycję' }); return }
    const totals = computeTotals(items)
    const inv = {
      id: uuidv4(), number: null, status: 'draft',
      issue_date: req.body.issue_date || null,
      sale_date: req.body.sale_date || null,
      due_date: req.body.due_date || null,
      payment_method: req.body.payment_method ? String(req.body.payment_method).trim() : 'przelew',
      buyer_name: String(req.body.buyer_name).trim(),
      buyer_nip: req.body.buyer_nip ? String(req.body.buyer_nip).trim() : null,
      buyer_address: req.body.buyer_address ? String(req.body.buyer_address).trim() : null,
      buyer_email: req.body.buyer_email ? String(req.body.buyer_email).trim() : null,
      items, ...totals,
      notes: req.body.notes ? String(req.body.notes).trim() : null,
      project_id: req.body.project_id || null,
      quote_id: req.body.quote_id || null,
      warehouse_doc_id: req.body.warehouse_doc_id || null,
      ksef_status: 'not_sent', ksef_number: null, paid_at: null,
      created_by: (req as any).user?.id || null,
      created_at: now(), updated_at: now(),
    }
    await db.sales_invoices.insert(inv)
    res.status(201).json(inv)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// PUT /api/sales-invoices/:id — edycja tylko szkicu
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const inv: any = await db.sales_invoices.find(req.params.id)
    if (!inv) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (inv.status !== 'draft') { res.status(400).json({ error: 'Edytować można tylko szkic — wystawiona faktura jest zablokowana' }); return }
    const patch: any = { updated_at: now() }
    for (const f of ['buyer_name', 'buyer_nip', 'buyer_address', 'buyer_email', 'payment_method', 'notes', 'issue_date', 'sale_date', 'due_date'] as const) {
      if (req.body[f] !== undefined) patch[f] = req.body[f] ? String(req.body[f]).trim() : null
    }
    if (patch.buyer_name === null) { res.status(400).json({ error: 'Nazwa nabywcy jest wymagana' }); return }
    if (req.body.items !== undefined) {
      const items = normalizeItems(req.body.items)
      if (items.length === 0) { res.status(400).json({ error: 'Dodaj przynajmniej jedną pozycję' }); return }
      Object.assign(patch, { items }, computeTotals(items))
    }
    await db.sales_invoices.update(inv.id, patch)
    res.json(await db.sales_invoices.find(inv.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/sales-invoices/:id/issue — wystaw (nadaje numer)
router.post('/:id/issue', async (req: Request, res: Response) => {
  try {
    const inv: any = await db.sales_invoices.find(req.params.id)
    if (!inv) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (inv.status !== 'draft') { res.status(400).json({ error: 'Faktura została już wystawiona' }); return }
    const d = new Date()
    const prefix = `FV/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/`
    const count = await db.sales_invoices.countForPrefix(prefix)
    const number = `${prefix}${String(count + 1).padStart(3, '0')}`
    const issueDate = inv.issue_date || now().slice(0, 10)
    await db.sales_invoices.update(inv.id, {
      number, status: 'issued',
      issue_date: issueDate,
      sale_date: inv.sale_date || issueDate,
      due_date: inv.due_date || null,
      updated_at: now(),
    })
    res.json(await db.sales_invoices.find(inv.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/sales-invoices/:id/mark-paid
router.post('/:id/mark-paid', async (req: Request, res: Response) => {
  try {
    const inv: any = await db.sales_invoices.find(req.params.id)
    if (!inv) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (inv.status !== 'issued') { res.status(400).json({ error: 'Tylko wystawioną fakturę można oznaczyć jako opłaconą' }); return }
    await db.sales_invoices.update(inv.id, { status: 'paid', paid_at: now(), updated_at: now() })
    res.json(await db.sales_invoices.find(inv.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/sales-invoices/:id/cancel — anulowanie (faktura zostaje w rejestrze)
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const inv: any = await db.sales_invoices.find(req.params.id)
    if (!inv) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (inv.status === 'draft') { res.status(400).json({ error: 'Szkic można po prostu usunąć' }); return }
    if (inv.status === 'cancelled') { res.status(400).json({ error: 'Faktura jest już anulowana' }); return }
    await db.sales_invoices.update(inv.id, { status: 'cancelled', updated_at: now() })
    res.json(await db.sales_invoices.find(inv.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// DELETE /api/sales-invoices/:id — tylko szkic
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const inv: any = await db.sales_invoices.find(req.params.id)
    if (!inv) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (inv.status !== 'draft') { res.status(400).json({ error: 'Wystawionej faktury nie można usunąć — użyj anulowania' }); return }
    await db.sales_invoices.delete(inv.id)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

export default router
