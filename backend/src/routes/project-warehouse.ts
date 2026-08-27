/**
 * Pobrania magazynowe pod projekt — dostępne dla KAŻDEGO zalogowanego pracownika
 * (bez flagi can_view_warehouse): monter na budowie robi listę tego, co zabiera.
 *
 * Pobranie tworzy dokument MM: magazyn źródłowy → magazyn "Projekty" (auto-tworzony),
 * z project_id. Przy wystawianiu faktury z tych MM generuje się WZ (sales-invoices).
 */
import { Router, Request, Response } from 'express'
import db, { prisma } from '../db'
import { createWarehouseDoc, ensureProjectsWarehouse, DocError } from './warehouse'

const router = Router({ mergeParams: true })

// ── GET /api/projects/:projectId/warehouse-items — pozycje do wyboru (odczyt) ──
router.get('/warehouse-items', async (_req: Request, res: Response) => {
  try {
    const [items, locations, reservations] = await Promise.all([
      db.warehouse_items.all(),
      db.warehouse_locations.all(),
      db.stock_reservations.activeAll(new Date().toISOString().slice(0, 10)),
    ])
    const reserved = new Map<string, number>()
    for (const r of reservations as any[]) reserved.set(r.warehouse_item_id, (reserved.get(r.warehouse_item_id) || 0) + r.quantity)
    const projectsWh = (locations as any[]).find(w => String(w.name).trim().toLowerCase() === 'projekty')
    const whName = new Map((locations as any[]).map(w => [w.id, w.name]))
    res.json((items as any[])
      // nie oferujemy pozycji już leżących w magazynie "Projekty"
      .filter(i => !projectsWh || String(i.warehouse_id || '') !== projectsWh.id)
      .map(i => ({
        id: i.id, name: i.name, sku: i.sku, unit: i.unit, unit_price: i.unit_price,
        warehouse_id: i.warehouse_id, warehouse_name: i.warehouse_id ? (whName.get(i.warehouse_id) ?? '?') : 'Główny',
        available: i.quantity - (reserved.get(i.id) || 0),
      }))
      .filter(i => i.available > 0))
  } catch (e) {
    console.error('[project-warehouse/items]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── GET /api/projects/:projectId/warehouse-docs — dokumenty MM/WZ projektu ────
router.get('/warehouse-docs', async (req: Request, res: Response) => {
  try {
    const docs = await prisma.warehouseDoc.findMany({
      where: { project_id: req.params.projectId },
      include: { lines: true },
      orderBy: { created_at: 'desc' },
    })
    // które pozycje MM są już podpięte pod fakturę (przez linked_mm_line_ids szkiców/wystawionych)
    const invoices = await prisma.salesInvoice.findMany({
      where: { project_id: req.params.projectId, status: { in: ['draft', 'issued', 'paid'] } },
      select: { id: true, number: true, status: true, linked_mm_line_ids: true },
    })
    const usedLines = new Map<string, { invoice_id: string; number: string | null }>()
    for (const inv of invoices as any[]) {
      for (const lineId of (Array.isArray(inv.linked_mm_line_ids) ? inv.linked_mm_line_ids : [])) {
        usedLines.set(String(lineId), { invoice_id: inv.id, number: inv.number })
      }
    }
    res.json((docs as any[]).map(d => ({
      ...d,
      lines: d.lines.map((l: any) => ({ ...l, invoiced: usedLines.get(l.id) ?? null })),
    })))
  } catch (e) {
    console.error('[project-warehouse/docs]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/projects/:projectId/warehouse-pick — pobranie z magazynu (MM) ───
router.post('/warehouse-pick', async (req: Request, res: Response) => {
  try {
    const project: any = await db.projects.find(req.params.projectId)
    if (!project) { res.status(404).json({ error: 'Projekt nie znaleziony' }); return }

    const rawLines: Array<{ warehouse_item_id: string; quantity: number }> =
      Array.isArray(req.body.lines) ? req.body.lines : []
    if (!rawLines.length) { res.status(400).json({ error: 'Dodaj przynajmniej jedną pozycję' }); return }

    const items: any[] = await db.warehouse_items.all()
    const projectsWh = await ensureProjectsWarehouse()

    // Pre-walidacja WSZYSTKICH pozycji (kumulatywnie) PRZED utworzeniem pierwszego MM —
    // pobranie z kilku magazynów tworzy kilka dokumentów i częściowy zapis byłby
    // niespójny (stan przesunięty, a odpowiedź z błędem)
    const reservations: any[] = await db.stock_reservations.activeAll(new Date().toISOString().slice(0, 10))
    const reserved = new Map<string, number>()
    for (const r of reservations) reserved.set(r.warehouse_item_id, (reserved.get(r.warehouse_item_id) || 0) + r.quantity)
    const requested = new Map<string, number>()
    for (const l of rawLines) {
      const item = items.find(i => i.id === l.warehouse_item_id)
      if (!item) { res.status(400).json({ error: 'Pozycja nie istnieje w magazynie' }); return }
      const qty = Number(l.quantity) || 0
      if (qty <= 0) { res.status(400).json({ error: `Podaj ilość większą od zera: ${item.name}` }); return }
      const already = requested.get(item.id) || 0
      const avail = item.quantity - (reserved.get(item.id) || 0) - already
      if (qty > avail) { res.status(400).json({ error: `Niewystarczający stan dostępny: ${item.name} — ${avail} ${item.unit}` }); return }
      requested.set(item.id, already + qty)
    }

    // MM ma jeden magazyn źródłowy — grupujemy pobrania wg magazynu pozycji
    const bySource = new Map<string, any[]>()
    for (const l of rawLines) {
      const item = items.find(i => i.id === l.warehouse_item_id)!
      const key = String(item.warehouse_id || '')
      const list = bySource.get(key) ?? []
      list.push({ warehouse_item_id: item.id, name: item.name, sku: item.sku, quantity: Number(l.quantity) || 0, unit: item.unit, unit_price: item.unit_price })
      bySource.set(key, list)
    }

    const userId = (req as any).user?.id || null
    const created: any[] = []
    for (const [sourceWh, lines] of bySource) {
      const doc = await createWarehouseDoc({
        type: 'MM',
        source_warehouse_id: sourceWh || null,
        target_warehouse_id: projectsWh.id,
        contractor: project.name,
        notes: `Pobranie pod projekt: ${project.name}`,
        project_id: project.id,
        lines,
      }, userId)
      created.push(doc)
    }
    res.status(201).json({ docs: created })
  } catch (e: any) {
    if (e instanceof DocError) { res.status(e.status).json({ error: e.message }); return }
    console.error('[project-warehouse/pick]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
