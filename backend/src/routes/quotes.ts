import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

// Samodzielne wyceny (bez projektu). Po akceptacji klienta wycenę przekształcamy w projekt.
// Mount: /api/quotes (requireAuth). NIE jest project-scoped.
const router = Router()
const now = () => new Date().toISOString()

function computeTotal(items: any[]): number {
  return items.reduce((s: number, i: any) => {
    const base = (Number(i.qty) || 0) * (Number(i.unit_price) || 0)
    const disc = Math.max(0, Math.min(100, Number(i.discount_pct) || 0))
    return s + base * (1 - disc / 100)
  }, 0)
}
function computeGrandTotal(totalEquipment: number, discountPct: number, laborPct: number) {
  const disc = Math.max(-100, Math.min(100, discountPct || 0))
  const totalAfterDiscount = totalEquipment * (1 - disc / 100)
  const laborCost = totalAfterDiscount * ((laborPct ?? 100) / 100)
  return { total_after_discount: totalAfterDiscount, labor_cost: laborCost, grand_total: totalAfterDiscount + laborCost }
}
function enrichItems(rawItems: any[]) {
  return (rawItems as any[]).map((item: any, index: number) => {
    const qty = Number(item.qty) || 1
    const unit_price = Number(item.unit_price) || 0
    const disc = Math.max(0, Math.min(100, Number(item.discount_pct) || 0))
    return {
      id: item.id || uuidv4(),
      room: item.room || '',
      brand: item.brand || 'KNX',
      category: item.category || '',
      name: item.name || '',
      qty,
      unit: item.unit || 'szt.',
      unit_price,
      discount_pct: disc,
      total: qty * unit_price * (1 - disc / 100),
      catalog_item_id: item.catalog_item_id || null,
      sort_order: index,
    }
  })
}
const strip = (q: any) => { const { ai_analysis_raw, ...rest } = q || {}; return rest }

// GET /api/quotes — lista wycen samodzielnych
router.get('/', async (_req: Request, res: Response) => {
  try {
    const all = await db.ai_quotes.allStandalone()
    res.json((all as any[]).map(strip))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/quotes — utwórz wycenę samodzielną
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, client_name = '', client_contact = '', items: rawItems = [], rooms_detected = [], notes = '', description = {} } = req.body
    const items = enrichItems(rawItems)
    const totalNet = computeTotal(items)
    const { total_after_discount, labor_cost, grand_total } = computeGrandTotal(totalNet, 0, 100)
    const quote = {
      id: uuidv4(),
      project_id: null,
      name: (name && String(name).trim()) || 'Nowa wycena',
      client_name: String(client_name || '').trim(),
      client_contact: String(client_contact || '').trim(),
      status: 'draft',
      floor_plan_filenames: [], floor_plan_originals: [], floor_plan_filename: null, floor_plan_original: null,
      rooms_detected,
      description: { must_have: description.must_have || '', nice_to_have: description.nice_to_have || '', premium: description.premium || '' },
      items,
      total_net: totalNet,
      discount_pct: 0,
      total_after_discount,
      labor_cost_pct: 100,
      labor_cost,
      grand_total,
      notes,
      created_at: now(),
      updated_at: now(),
      created_by: (req as any).user?.id || '',
    }
    await db.ai_quotes.insert(quote)
    res.status(201).json(quote)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// GET /api/quotes/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const quote: any = await db.ai_quotes.find(req.params.id)
    if (!quote) { res.status(404).json({ error: 'Wycena nie znaleziona' }); return }
    res.json(strip(quote))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// PUT /api/quotes/:id — edycja (pozycje, rabat, robocizna, status, nazwa, klient)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const current: any = await db.ai_quotes.find(req.params.id)
    if (!current) { res.status(404).json({ error: 'Wycena nie znaleziona' }); return }

    const { status, notes, name, client_name, client_contact, items, rooms_detected, discount_pct, labor_cost_pct } = req.body
    const patch: any = { updated_at: now() }
    if (status !== undefined) patch.status = status
    if (notes !== undefined) patch.notes = notes
    if (name !== undefined) patch.name = String(name).trim() || 'Nowa wycena'
    if (client_name !== undefined) patch.client_name = String(client_name).trim()
    if (client_contact !== undefined) patch.client_contact = String(client_contact).trim()
    if (rooms_detected !== undefined) patch.rooms_detected = rooms_detected
    if (discount_pct !== undefined) patch.discount_pct = Math.max(-100, Math.min(100, Number(discount_pct) || 0))
    if (labor_cost_pct !== undefined) patch.labor_cost_pct = Math.max(0, Math.min(500, Number(labor_cost_pct) || 0))

    const effectiveDiscount = patch.discount_pct ?? current.discount_pct ?? 0
    const effectiveLabor = patch.labor_cost_pct ?? current.labor_cost_pct ?? 100
    if (items !== undefined) {
      patch.items = enrichItems(items)
      patch.total_net = computeTotal(patch.items)
    } else if (discount_pct !== undefined || labor_cost_pct !== undefined) {
      patch.total_net = computeTotal(current.items ?? [])
    }
    const totalNet = patch.total_net ?? current.total_net ?? 0
    const { total_after_discount, labor_cost, grand_total } = computeGrandTotal(totalNet, effectiveDiscount, effectiveLabor)
    patch.total_after_discount = total_after_discount
    patch.labor_cost = labor_cost
    patch.grand_total = grand_total

    await db.ai_quotes.update(req.params.id, patch)
    res.json(strip(await db.ai_quotes.find(req.params.id)))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// DELETE /api/quotes/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const quote = await db.ai_quotes.find(req.params.id)
    if (!quote) { res.status(404).json({ error: 'Wycena nie znaleziona' }); return }
    await db.ai_quotes.delete(req.params.id)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/quotes/:id/accept — klient zaakceptował → utwórz projekt z danych wyceny i podepnij wycenę
router.post('/:id/accept', async (req: Request, res: Response) => {
  try {
    const quote: any = await db.ai_quotes.find(req.params.id)
    if (!quote) { res.status(404).json({ error: 'Wycena nie znaleziona' }); return }
    if (quote.project_id) { res.status(409).json({ error: 'Wycena jest już powiązana z projektem.' }); return }

    const user = (req as any).user
    const project = {
      id: uuidv4(),
      name: quote.name || 'Projekt z wyceny',
      client_name: quote.client_name || '',
      client_contact: quote.client_contact || '',
      project_type: 'installation',
      status: 'contract_signed',           // zaakceptowana wycena → umowa
      budget_amount: quote.grand_total || 0,
      area_m2: null,
      smart_features: [],
      start_date: null,
      end_date: null,
      description: 'Projekt utworzony z zaakceptowanej wyceny.',
      created_at: now(),
      updated_at: now(),
      created_by: user?.id || null,
    }
    await db.projects.insert(project)
    if (user?.id && user.role !== 'admin') {
      await db.project_members.add(project.id, user.id)
    }
    // Podepnij wycenę do projektu + oznacz jako zatwierdzoną
    await db.ai_quotes.update(quote.id, { project_id: project.id, status: 'confirmed', updated_at: now() })
    res.status(201).json(project)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

export default router
