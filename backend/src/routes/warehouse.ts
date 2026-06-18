import { Router, Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import * as XLSX from 'xlsx'
import db from '../db'

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

// ── GET / — lista pozycji ──
router.get('/', async (_req: Request, res: Response) => {
  try { res.json(await db.warehouse_items.all()) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── POST / — dodaj pozycję ──
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, sku, unit, unit_price, quantity, min_quantity, category, location, notes } = req.body
    if (!name || !String(name).trim()) { res.status(400).json({ error: 'Nazwa jest wymagana' }); return }
    const qty = Number(quantity) || 0
    const item = {
      id: uuidv4(),
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
    if (type === 'out' && qty > item.quantity) {
      res.status(400).json({ error: `Niewystarczający stan (dostępne: ${item.quantity} ${item.unit})` }); return
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

export default router
