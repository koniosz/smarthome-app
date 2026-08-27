import { Router, Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import * as XLSX from 'xlsx'
import db, { prisma } from '../db'

// Magazyn — pozycje + ruchy (przyjęcia/wydania) + import stanu początkowego z Excela.
// Mount: /api/warehouse (za requireAuth). Dostęp: admin lub user.can_view_warehouse.
const router = Router()
const now = () => new Date().toISOString()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// ── Gate: tylko admin lub użytkownik z nadanym dostępem ──
async function requireWarehouse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const u: any = await db.users.find((req as any).user?.id)
    if (!u || (u.role !== 'admin' && !u.can_view_warehouse)) {
      res.status(403).json({ error: 'Brak dostępu do magazynu' }); return
    }
    next()
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
}
router.use(requireWarehouse)

// ── Dostępność: stan − aktywne rezerwacje (obowiązujące dziś lub później) ──
const today = () => new Date().toISOString().slice(0, 10)
async function reservedQtyMap(): Promise<Map<string, number>> {
  const active: any[] = await db.stock_reservations.activeAll(today())
  const map = new Map<string, number>()
  for (const r of active) map.set(r.warehouse_item_id, (map.get(r.warehouse_item_id) || 0) + r.quantity)
  return map
}

// ── GET / — lista pozycji (ze stanem zarezerwowanym i dostępnym) ──
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [items, reserved] = await Promise.all([db.warehouse_items.all(), reservedQtyMap()])
    res.json((items as any[]).map(i => ({
      ...i,
      reserved_qty: reserved.get(i.id) || 0,
      available_qty: i.quantity - (reserved.get(i.id) || 0),
    })))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Magazyny (lokalizacje) ──
router.get('/warehouses', async (_req: Request, res: Response) => {
  try { res.json(await db.warehouse_locations.all()) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})
router.post('/warehouses', async (req: Request, res: Response) => {
  try {
    const name = String(req.body.name || '').trim()
    if (!name) { res.status(400).json({ error: 'Nazwa magazynu jest wymagana' }); return }
    const item = { id: uuidv4(), name, created_at: now() }
    await db.warehouse_locations.insert(item)
    res.status(201).json(item)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Rezerwacje towaru (1–7 dni) ──
router.get('/reservations', async (_req: Request, res: Response) => {
  try {
    const list: any[] = await db.stock_reservations.recent(150)
    const t = today()
    res.json(list.map(r => ({
      ...r,
      effective_status: r.status === 'active' && r.date_to < t ? 'expired' : r.status,
    })))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})
router.post('/reservations/:id/release', async (req: Request, res: Response) => {
  try {
    const r: any = await db.stock_reservations.find(req.params.id)
    if (!r) { res.status(404).json({ error: 'Rezerwacja nie znaleziona' }); return }
    if (r.status !== 'active') { res.status(400).json({ error: 'Rezerwacja nie jest aktywna' }); return }
    await db.stock_reservations.update(r.id, { status: 'released', updated_at: now() })
    res.json(await db.stock_reservations.find(r.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── POST / — dodaj pozycję ──
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, sku, unit, unit_price, quantity, min_quantity, category, location, notes, warehouse_id } = req.body
    if (!name || !String(name).trim()) { res.status(400).json({ error: 'Nazwa jest wymagana' }); return }
    const qty = Number(quantity) || 0
    const item = {
      id: uuidv4(),
      warehouse_id: warehouse_id || null,
      name: String(name).trim(),
      sku: sku ? String(sku).trim() : null,
      unit: unit ? String(unit).trim() : 'szt.',
      unit_price: Number(unit_price) || 0,
      quantity: qty,
      min_quantity: Number(min_quantity) || 0,
      category: category ? String(category).trim() : null,
      location: location ? String(location).trim() : null,
      notes: notes ? String(notes).trim() : null,
      created_at: now(),
      updated_at: now(),
    }
    await db.warehouse_items.insert(item)
    if (qty !== 0) {
      await db.stock_movements.insert({
        id: uuidv4(), warehouse_item_id: item.id, type: 'initial', quantity: qty,
        unit_price: item.unit_price, reason: 'Stan początkowy', project_ref: null,
        created_by: (req as any).user?.id || null, created_at: now(),
      })
    }
    res.status(201).json(item)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── PUT /:id — edytuj pozycję (dane, nie ilość) ──
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.warehouse_items.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Pozycja nie znaleziona' }); return }
    const patch: any = { updated_at: now() }
    for (const f of ['name', 'sku', 'unit', 'category', 'location', 'notes'] as const) {
      if (req.body[f] !== undefined) patch[f] = req.body[f] ? String(req.body[f]).trim() : null
    }
    if (req.body.unit_price !== undefined) patch.unit_price = Number(req.body.unit_price) || 0
    if (req.body.min_quantity !== undefined) patch.min_quantity = Number(req.body.min_quantity) || 0
    if (req.body.warehouse_id !== undefined) patch.warehouse_id = req.body.warehouse_id || null
    await db.warehouse_items.update(req.params.id, patch)
    res.json(await db.warehouse_items.find(req.params.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── DELETE /:id ──
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.warehouse_items.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Pozycja nie znaleziona' }); return }
    await db.warehouse_items.delete(req.params.id)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── GET /:id/movements — historia ruchów pozycji ──
router.get('/:id/movements', async (req: Request, res: Response) => {
  try { res.json(await db.stock_movements.forItem(req.params.id)) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── POST /:id/move — przyjęcie/wydanie ──
router.post('/:id/move', async (req: Request, res: Response) => {
  try {
    const item: any = await db.warehouse_items.find(req.params.id)
    if (!item) { res.status(404).json({ error: 'Pozycja nie znaleziona' }); return }
    const type = req.body.type === 'out' ? 'out' : 'in'
    const qty = Number(req.body.quantity) || 0
    if (qty <= 0) { res.status(400).json({ error: 'Podaj ilość większą od zera' }); return }
    if (type === 'out') {
      const reserved = (await reservedQtyMap()).get(item.id) || 0
      const available = item.quantity - reserved
      if (qty > available) {
        res.status(400).json({ error: `Niewystarczający stan dostępny: ${available} ${item.unit} (stan ${item.quantity}, zarezerwowane ${reserved})` }); return
      }
    }
    const newQty = type === 'in' ? item.quantity + qty : item.quantity - qty
    await db.warehouse_items.update(item.id, { quantity: newQty, updated_at: now() })
    await db.stock_movements.insert({
      id: uuidv4(), warehouse_item_id: item.id, type, quantity: qty,
      unit_price: req.body.unit_price !== undefined ? Number(req.body.unit_price) || 0 : item.unit_price,
      reason: req.body.reason ? String(req.body.reason).trim() : null,
      project_ref: req.body.project_ref ? String(req.body.project_ref).trim() : null,
      created_by: (req as any).user?.id || null, created_at: now(),
    })
    res.json(await db.warehouse_items.find(item.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── POST /:id/reserve — rezerwacja towaru na okres (max 7 dni) ──
router.post('/:id/reserve', async (req: Request, res: Response) => {
  try {
    const item: any = await db.warehouse_items.find(req.params.id)
    if (!item) { res.status(404).json({ error: 'Pozycja nie znaleziona' }); return }
    const qty = Number(req.body.quantity) || 0
    if (qty <= 0) { res.status(400).json({ error: 'Podaj ilość większą od zera' }); return }
    const from = String(req.body.date_from || today())
    const to = String(req.body.date_to || from)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ error: 'Daty w formacie RRRR-MM-DD' }); return
    }
    const spanDays = Math.round((new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000) + 1
    if (spanDays < 1) { res.status(400).json({ error: 'Data „do" nie może być przed datą „od"' }); return }
    if (spanDays > 7) { res.status(400).json({ error: 'Rezerwacja może trwać maksymalnie 7 dni' }); return }
    if (to < today()) { res.status(400).json({ error: 'Rezerwacja nie może kończyć się w przeszłości' }); return }

    const reserved = (await reservedQtyMap()).get(item.id) || 0
    const available = item.quantity - reserved
    if (qty > available) {
      res.status(400).json({ error: `Dostępne do rezerwacji: ${available} ${item.unit} (stan ${item.quantity}, już zarezerwowane ${reserved})` }); return
    }
    const r = {
      id: uuidv4(), warehouse_item_id: item.id, quantity: qty,
      date_from: from, date_to: to,
      reason: req.body.reason ? String(req.body.reason).trim() : null,
      project_ref: req.body.project_ref ? String(req.body.project_ref).trim() : null,
      reserved_by: (req as any).user?.id || null,
      status: 'active', created_at: now(), updated_at: now(),
    }
    await db.stock_reservations.insert(r)
    res.status(201).json(r)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── POST /import — stan początkowy z Excela ──
const HEADERS: Record<string, string[]> = {
  name: ['nazwa', 'name', 'produkt', 'towar', 'opis'],
  sku: ['sku', 'kod', 'indeks', 'symbol', 'kod produktu', 'nr katalogowy'],
  quantity: ['ilość', 'ilosc', 'quantity', 'qty', 'stan', 'stan początkowy', 'stan poczatkowy'],
  unit: ['jednostka', 'jm', 'j.m.', 'unit', 'jedn'],
  unit_price: ['cena', 'cena jedn', 'cena jednostkowa', 'price', 'cena netto', 'wartość'],
  category: ['kategoria', 'category', 'grupa'],
  location: ['lokalizacja', 'location', 'miejsce', 'regał', 'regal'],
}
function matchCol(header: string): string | null {
  const h = String(header || '').trim().toLowerCase()
  for (const [field, aliases] of Object.entries(HEADERS)) {
    if (aliases.some(a => h === a || h.startsWith(a))) return field
  }
  return null
}
router.post('/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Brak pliku' }); return }
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false, defval: '' })
    if (rows.length < 2) { res.status(400).json({ error: 'Plik jest pusty lub bez danych' }); return }

    // znajdź wiersz nagłówka (pierwszy z kolumną „nazwa")
    let headerRow = -1, colMap: Record<number, string> = {}
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const map: Record<number, string> = {}
      rows[r].forEach((cell: any, c: number) => { const f = matchCol(cell); if (f) map[c] = f })
      if (Object.values(map).includes('name')) { headerRow = r; colMap = map; break }
    }
    if (headerRow < 0) { res.status(400).json({ error: 'Nie znaleziono kolumny „Nazwa". Wymagane kolumny: Nazwa, Ilość (opcjonalnie SKU, Jednostka, Cena).' }); return }

    let imported = 0
    const ts = now()
    const createdBy = (req as any).user?.id || null
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r]
      const get = (field: string) => {
        const col = Object.keys(colMap).find(c => colMap[Number(c)] === field)
        return col !== undefined ? row[Number(col)] : ''
      }
      const name = String(get('name') || '').trim()
      if (!name) continue
      const qty = Number(String(get('quantity')).toString().replace(',', '.')) || 0
      const price = Number(String(get('unit_price')).toString().replace(/[^\d.,-]/g, '').replace(',', '.')) || 0
      const id = uuidv4()
      await db.warehouse_items.insert({
        id, name,
        sku: String(get('sku') || '').trim() || null,
        unit: String(get('unit') || '').trim() || 'szt.',
        unit_price: price,
        quantity: qty,
        min_quantity: 0,
        category: String(get('category') || '').trim() || null,
        location: String(get('location') || '').trim() || null,
        notes: null,
        created_at: ts, updated_at: ts,
      })
      if (qty !== 0) {
        await db.stock_movements.insert({
          id: uuidv4(), warehouse_item_id: id, type: 'initial', quantity: qty,
          unit_price: price, reason: 'Import stanu początkowego (Excel)', project_ref: null,
          created_by: createdBy, created_at: ts,
        })
      }
      imported++
    }
    res.json({ imported })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Błąd importu' })
  }
})

// ─── Dokumenty WZ / PZ ──────────────────────────────────────────────────────────

// GET /api/warehouse/docs — lista dokumentów
router.get('/docs', async (_req: Request, res: Response) => {
  try { res.json(await db.warehouse_docs.all()) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// GET /api/warehouse/docs/:id — dokument z pozycjami
router.get('/docs/:id', async (req: Request, res: Response) => {
  try {
    const doc = await db.warehouse_docs.find(req.params.id)
    if (!doc) { res.status(404).json({ error: 'Dokument nie znaleziony' }); return }
    res.json(doc)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/warehouse/docs — utwórz WZ/PZ/MM, zaktualizuj stany + ruchy
// WZ respektuje rezerwacje (wydanie tylko do stanu dostępnego).
// MM: przesunięcie międzymagazynowe — zdejmuje ze źródła, dodaje w magazynie docelowym (dopasowanie po SKU/nazwie).
// Błąd domenowy tworzenia dokumentu (status HTTP + komunikat po polsku)
export class DocError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export interface DocInput {
  type: 'WZ' | 'PZ' | 'MM'
  date?: string
  contractor?: string | null
  notes?: string | null
  source_warehouse_id?: string | null
  target_warehouse_id?: string | null
  project_id?: string | null
  linked_mm_ids?: string[] | null
  lines: any[]
}

// Magazyn "Projekty" musi zawsze istnieć — towar pobrany pod projekty trafia tam przez MM
export async function ensureProjectsWarehouse(): Promise<any> {
  const all: any[] = await db.warehouse_locations.all()
  const existing = all.find(w => String(w.name).trim().toLowerCase() === 'projekty')
  if (existing) return existing
  const w = { id: uuidv4(), name: 'Projekty', created_at: now() }
  await db.warehouse_locations.insert(w)
  return w
}

// Wspólna logika WZ/PZ/MM (numeracja, walidacja stanów, ruchy magazynowe) —
// używana przez POST /docs, pobrania z projektu i WZ generowany przy fakturze.
export async function createWarehouseDoc(input: DocInput, userId: string | null): Promise<any> {
    const type = ['WZ', 'PZ', 'MM'].includes(input.type) ? input.type : 'PZ'
    const rawLines: any[] = Array.isArray(input.lines) ? input.lines : []
    const date = (input.date && String(input.date)) || now().slice(0, 10)
    const ts = now()
    const sourceWh = input.source_warehouse_id || null   // MM
    const targetWh = input.target_warehouse_id || null   // MM / PZ (magazyn przyjęcia)

    if (type === 'MM' && String(sourceWh || '') === String(targetWh || '')) {
      throw new DocError(400, 'MM: magazyn źródłowy i docelowy muszą być różne')
    }

    const allItems: any[] = await db.warehouse_items.all()
    const reserved = await reservedQtyMap()

    // walidacja + rozwiązanie pozycji
    const resolved: { raw: any; qty: number; price: number; item: any | null }[] = []
    const requested = new Map<string, number>() // kumulacja żądań per pozycja w tym dokumencie
    for (const l of rawLines) {
      const qty = Number(l.quantity) || 0
      if (qty <= 0) continue
      const price = Number(l.unit_price) || 0
      let item = l.warehouse_item_id ? allItems.find(i => i.id === l.warehouse_item_id) : null
      if (!item && l.sku) item = allItems.find(i => i.sku && i.sku === String(l.sku).trim())

      if (type === 'WZ' || type === 'MM') {
        const label = type === 'MM' ? 'MM przesuwa' : 'WZ wydaje'
        if (!item) throw new DocError(400, `Pozycja „${l.name}" nie istnieje w magazynie — ${label} tylko istniejący towar`)
        if (type === 'MM' && String(item.warehouse_id || '') !== String(sourceWh || '')) {
          throw new DocError(400, `Pozycja „${item.name}" nie znajduje się w magazynie źródłowym`)
        }
        const already = requested.get(item.id) || 0
        const avail = item.quantity - (reserved.get(item.id) || 0) - already
        if (qty > avail) {
          throw new DocError(400, `Niewystarczający stan dostępny: ${item.name} — ${avail} ${item.unit} (stan ${item.quantity}, zarezerwowane ${reserved.get(item.id) || 0})`)
        }
        requested.set(item.id, already + qty)
      }
      resolved.push({ raw: l, qty, price, item })
    }
    if (resolved.length === 0) throw new DocError(400, 'Dodaj przynajmniej jedną pozycję')

    // numer dokumentu: RRRR/MM/NNN/TYP
    const d = new Date()
    const prefix = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/`
    const count = await db.warehouse_docs.countForPrefix(prefix, type)
    const number = `${prefix}${String(count + 1).padStart(3, '0')}/${type}`

    const total = resolved.reduce((s, r) => s + r.qty * r.price, 0)
    const docId = uuidv4()
    await db.warehouse_docs.insert({
      id: docId, type, number, date,
      contractor: input.contractor ? String(input.contractor).trim() : null,
      project_id: input.project_id || null, cost_item_id: null,
      linked_mm_ids: input.linked_mm_ids && input.linked_mm_ids.length ? (input.linked_mm_ids as any) : undefined,
      source_warehouse_id: type === 'MM' ? sourceWh : null,
      target_warehouse_id: (type === 'MM' || type === 'PZ') ? targetWh : null,
      total_net: total,
      notes: input.notes ? String(input.notes).trim() : null,
      created_by: userId, created_at: ts,
    })

    for (const r of resolved) {
      let item = r.item
      if (type === 'PZ') {
        if (!item) {
          item = {
            id: uuidv4(), warehouse_id: targetWh, name: String(r.raw.name || 'Pozycja').trim(), sku: r.raw.sku ? String(r.raw.sku).trim() : null,
            unit: r.raw.unit ? String(r.raw.unit).trim() : 'szt.', unit_price: r.price, quantity: 0, min_quantity: 0,
            category: null, location: null, notes: null, created_at: ts, updated_at: ts,
          }
          await db.warehouse_items.insert(item)
        }
        await db.warehouse_items.update(item.id, { quantity: item.quantity + r.qty, updated_at: ts })
        item.quantity += r.qty
        await db.stock_movements.insert({
          id: uuidv4(), warehouse_item_id: item.id, type: 'in',
          quantity: r.qty, unit_price: r.price, reason: `${type} ${number}`, project_ref: null,
          created_by: userId, created_at: ts,
        })
      } else if (type === 'WZ') {
        await db.warehouse_items.update(item.id, { quantity: item.quantity - r.qty, updated_at: ts })
        item.quantity -= r.qty
        await db.stock_movements.insert({
          id: uuidv4(), warehouse_item_id: item.id, type: 'out',
          quantity: r.qty, unit_price: r.price, reason: `${type} ${number}`, project_ref: null,
          created_by: userId, created_at: ts,
        })
      } else {
        // MM: zdejmij ze źródła
        await db.warehouse_items.update(item.id, { quantity: item.quantity - r.qty, updated_at: ts })
        item.quantity -= r.qty
        await db.stock_movements.insert({
          id: uuidv4(), warehouse_item_id: item.id, type: 'out',
          quantity: r.qty, unit_price: r.price, reason: `MM ${number} → magazyn docelowy`, project_ref: null,
          created_by: userId, created_at: ts,
        })
        // dodaj w magazynie docelowym (dopasowanie po SKU, potem po nazwie)
        let target = allItems.find(i =>
          String(i.warehouse_id || '') === String(targetWh || '') && (
            (item.sku && i.sku && i.sku === item.sku) || (!item.sku && i.name === item.name)
          ))
        if (!target) {
          target = {
            id: uuidv4(), warehouse_id: targetWh, name: item.name, sku: item.sku,
            unit: item.unit, unit_price: item.unit_price, quantity: 0, min_quantity: 0,
            category: item.category, location: null, notes: null, created_at: ts, updated_at: ts,
          }
          await db.warehouse_items.insert(target)
          allItems.push(target)
        }
        await db.warehouse_items.update(target.id, { quantity: target.quantity + r.qty, updated_at: ts })
        target.quantity += r.qty
        await db.stock_movements.insert({
          id: uuidv4(), warehouse_item_id: target.id, type: 'in',
          quantity: r.qty, unit_price: r.price, reason: `MM ${number} ← magazyn źródłowy`, project_ref: null,
          created_by: userId, created_at: ts,
        })
      }
      await db.warehouse_doc_lines.insert({
        id: uuidv4(), doc_id: docId, warehouse_item_id: item.id,
        name: String(r.raw.name || item.name).trim(), sku: r.raw.sku ? String(r.raw.sku).trim() : (item.sku || null),
        quantity: r.qty, unit: r.raw.unit ? String(r.raw.unit).trim() : (item.unit || 'szt.'),
        unit_price: r.price, total: r.qty * r.price,
      })
    }

    return await db.warehouse_docs.find(docId)
}

router.post('/docs', async (req: Request, res: Response) => {
  try {
    const doc = await createWarehouseDoc({
      type: req.body.type, date: req.body.date, contractor: req.body.contractor,
      notes: req.body.notes, source_warehouse_id: req.body.source_warehouse_id,
      target_warehouse_id: req.body.target_warehouse_id, lines: req.body.lines,
    }, (req as any).user?.id || null)
    res.status(201).json(doc)
  } catch (e: any) {
    if (e instanceof DocError) { res.status(e.status).json({ error: e.message }); return }
    res.status(500).json({ error: e?.message ?? 'Błąd serwera' })
  }
})

// POST /api/warehouse/docs/:id/assign-project — przenieś WZ do projektu jako koszt
router.post('/docs/:id/assign-project', async (req: Request, res: Response) => {
  try {
    const doc: any = await db.warehouse_docs.find(req.params.id)
    if (!doc) { res.status(404).json({ error: 'Dokument nie znaleziony' }); return }
    if (doc.type !== 'WZ') { res.status(400).json({ error: 'Tylko WZ można przypisać do projektu' }); return }
    if (doc.project_id) { res.status(409).json({ error: 'WZ jest już przypisany do projektu' }); return }
    const project = await db.projects.find(req.body.project_id)
    if (!project) { res.status(404).json({ error: 'Projekt nie znaleziony' }); return }

    const ts = now()
    const costId = uuidv4()
    await db.cost_items.insert({
      id: costId, project_id: project.id, category: 'wz',
      description: `WZ ${doc.number}`, quantity: 1, unit_price: doc.total_net, total_price: doc.total_net,
      supplier: doc.contractor || '', invoice_number: doc.number, date: doc.date, created_at: ts,
    })
    await db.projects.update(project.id, { updated_at: ts })
    await db.warehouse_docs.update(doc.id, { project_id: project.id, cost_item_id: costId })
    res.json(await db.warehouse_docs.find(doc.id))
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Błąd serwera' })
  }
})

// ── Faktury zakupowe z KSeF → generowanie PZ ─────────────────────────────────
// Za requireWarehouse (magazynier nie musi być adminem). Tylko odczyt: lista
// faktur incoming + ich pozycje (cache/XML z ksef-lineitems).

// GET /api/warehouse/ksef-invoices?search=
router.get('/ksef-invoices', async (req: Request, res: Response) => {
  try {
    const search = String(req.query.search ?? '').trim()
    const c = { contains: search, mode: 'insensitive' as const }
    const invoices = await prisma.ksefInvoice.findMany({
      where: {
        invoice_direction: 'incoming',
        ...(search ? { OR: [{ invoice_number: c }, { seller_name: c }] } : {}),
      },
      select: { id: true, invoice_number: true, seller_name: true, invoice_date: true, net_amount: true, gross_amount: true },
      orderBy: { invoice_date: 'desc' },
      take: 15,
    })
    res.json(invoices)
  } catch (e) {
    console.error('[warehouse/ksef-invoices]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/warehouse/ksef-invoices/:id/line-items
router.get('/ksef-invoices/:id/line-items', async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.ksefInvoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, invoice_number: true, seller_name: true, invoice_date: true, invoice_direction: true },
    })
    if (!invoice || invoice.invoice_direction === 'outgoing') { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    const { getInvoiceLineItems } = await import('../services/ksef-lineitems')
    const items = await getInvoiceLineItems(invoice.id)
    res.json({ invoice, items })
  } catch (e: any) {
    console.error('[warehouse/ksef-invoice-lines]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd serwera' })
  }
})

export default router
