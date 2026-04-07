import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import ExcelJS from 'exceljs'
import type { AiQuote, AiQuoteItem, QuoteBrand, ProductCatalogItem } from '../../types'
import { QUOTE_BRAND_COLORS, QUOTE_BRANDS, QUOTE_STATUS_LABELS } from '../../types'
import { aiQuotesApi, productCatalogApi, api } from '../../api/client'

interface AIQuoteEditorProps {
  projectId: string
  quote: AiQuote
  onUpdated: (q: AiQuote) => void
  onDeleted: (quoteId: string) => void
}

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtInt(n: number) {
  return new Intl.NumberFormat('pl-PL').format(Math.round(n))
}

let _tempId = 0
function tempId() { return `tmp-${++_tempId}` }

function itemTotal(item: AiQuoteItem) {
  return (item.qty || 0) * (item.unit_price || 0) * (1 - (item.discount_pct || 0) / 100)
}

export default function AIQuoteEditor({ projectId, quote, onUpdated, onDeleted }: AIQuoteEditorProps) {
  const navigate = useNavigate()
  const [items, setItems] = useState<AiQuoteItem[]>(
    quote.items.map(i => ({ ...i, discount_pct: i.discount_pct ?? 0 }))
  )
  const [notes, setNotes] = useState(quote.notes || '')
  const [status, setStatus] = useState(quote.status)
  const [discountPct, setDiscountPct] = useState(quote.discount_pct ?? 0)
  const [laborPct, setLaborPct] = useState(quote.labor_cost_pct ?? 100)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuf, setEditBuf] = useState<Partial<AiQuoteItem>>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [refineSuggestion, setRefineSuggestion] = useState('')
  const [refineLoading, setRefineLoading] = useState(false)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [refineHistory, setRefineHistory] = useState<Array<{ suggestion: string; appliedAt: string; itemsBefore: number; itemsAfter: number }>>([])
  const [refineHistoryOpen, setRefineHistoryOpen] = useState(false)

  // ── Approve as example ────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'rooms' | 'flat'>('rooms')

  const [approveModalOpen, setApproveModalOpen] = useState(false)
  const [approveForm, setApproveForm] = useState({
    title: '',
    project_type: 'residential',
    area_m2: '',
    human_notes: '',
  })
  const [approveSaving, setApproveSaving] = useState(false)
  const [approveSuccess, setApproveSuccess] = useState(false)

  // ── Services Panel ────────────────────────────────────────────────────────
  const [servicesCatalog, setServicesCatalog] = useState<ProductCatalogItem[]>([])
  const [serviceHours, setServiceHours] = useState({ knx: 0, control4: 0, satel: 0, cameras: 0 })
  const [servicesPanelOpen, setServicesPanelOpen] = useState(false)

  useEffect(() => {
    productCatalogApi.list('Usługi').then(setServicesCatalog).catch(() => {})
  }, [])

  // Pre-populate hours from existing Usługi items in the quote
  useEffect(() => {
    const uslugiItems = quote.items.filter(i => i.brand === 'Usługi' && i.unit === 'h')
    const find = (keywords: string[]) => {
      const it = uslugiItems.find(i => keywords.some(k => i.name.toLowerCase().includes(k.toLowerCase())))
      return it ? (it.qty || 0) : 0
    }
    setServiceHours({
      knx:      find(['KNX']),
      control4: find(['Control4']),
      satel:    find(['SATEL', 'Satel']),
      cameras:  find(['kamer', 'Hikvision', 'CCTV']),
    })
  }, [quote.id])

  const findRate = (keywords: string[]) =>
    servicesCatalog.find(c => keywords.some(k => c.name.toLowerCase().includes(k.toLowerCase())))

  const applyServices = () => {
    const instCatalog = findRate(['Instalacja pojedynczego punktu'])
    const knxCatalog  = findRate(['KNX'])
    const c4Catalog   = findRate(['Control4'])
    const satCatalog  = findRate(['SATEL', 'Satel'])
    const camCatalog  = findRate(['kamer', 'Hikvision'])

    // Policz urządzenia (bez Usługi)
    const deviceCount = items
      .filter(i => i.brand !== 'Usługi')
      .reduce((s, i) => s + (Number(i.qty) || 1), 0)

    const newServiceItems: AiQuoteItem[] = []
    let sortBase = items.filter(i => i.brand !== 'Usługi').length

    const addItem = (catalog: ProductCatalogItem | undefined, name: string, qty: number, unit: string) => {
      if (!catalog || qty <= 0) return
      const unit_price = catalog.unit_price || 0
      newServiceItems.push({
        id: tempId(),
        room: 'Usługi / Instalacja',
        brand: 'Usługi',
        category: catalog.category,
        name,
        qty,
        unit,
        unit_price,
        discount_pct: 0,
        total: qty * unit_price,
        catalog_item_id: catalog.id,
        sort_order: sortBase++,
      })
    }

    addItem(instCatalog, instCatalog?.name ?? 'Instalacja punktów', deviceCount, 'szt.')
    addItem(knxCatalog,  knxCatalog?.name  ?? 'Programowanie KNX',      serviceHours.knx,      'h')
    addItem(c4Catalog,   c4Catalog?.name   ?? 'Programowanie Control4',  serviceHours.control4, 'h')
    addItem(satCatalog,  satCatalog?.name  ?? 'Programowanie SATEL',     serviceHours.satel,    'h')
    addItem(camCatalog,  camCatalog?.name  ?? 'Programowanie kamer',     serviceHours.cameras,  'h')

    setItems(prev => [...prev.filter(i => i.brand !== 'Usługi'), ...newServiceItems])
    setDirty(true)
  }

  // Totals
  const totalEquipment = items.reduce((s, i) => s + itemTotal(i), 0)
  const totalAfterDiscount = totalEquipment * (1 - discountPct / 100)
  const laborCost = totalAfterDiscount * (laborPct / 100)
  const grandTotal = totalAfterDiscount + laborCost

  const rooms = Array.from(new Set(items.map(i => i.room)))

  // ── Flat / aggregated view ────────────────────────────────────────────────
  // Items with the same name+brand+unit_price are merged (qty summed)
  // Then grouped by category
  type AggItem = { key: string; name: string; brand: QuoteBrand; category: string; unit: string; qty: number; unit_price: number; discount_pct: number; total: number }

  const aggregatedItems: AggItem[] = (() => {
    const map = new Map<string, AggItem>()
    for (const item of items) {
      const key = `${item.brand}||${item.category}||${item.name}||${item.unit_price}`
      if (map.has(key)) {
        const existing = map.get(key)!
        existing.qty += item.qty
        existing.total += itemTotal(item)
      } else {
        map.set(key, {
          key,
          name: item.name,
          brand: item.brand,
          category: item.category,
          unit: item.unit,
          qty: item.qty,
          unit_price: item.unit_price,
          discount_pct: item.discount_pct ?? 0,
          total: itemTotal(item),
        })
      }
    }
    return Array.from(map.values())
  })()

  // Sections: "Instalacja / Rozdzielnia" room → first section, then by category
  const SECTION_ORDER = [
    'Instalacja / Rozdzielnia',
    'Sterowanie oświetleniem',
    'Sterowanie żaluzjami',
    'Sterowanie HVAC',
    'HVAC',
    'Panel dotykowy',
    'Czujnik',
    'Czujniki',
    'Bezpieczeństwo',
    'Alarm',
    'Monitoring',
    'CCTV',
    'Audio / Video',
    'Wizualizacja',
    'Sieć',
    'WiFi',
    'Domofon',
    'Inne',
    'Usługi',
  ]

  const flatCategories: Map<string, AggItem[]> = (() => {
    // Group by category
    const map = new Map<string, AggItem[]>()
    for (const item of aggregatedItems) {
      if (!map.has(item.category)) map.set(item.category, [])
      map.get(item.category)!.push(item)
    }
    // Sort: known sections first, rest alphabetically
    const sorted = new Map<string, AggItem[]>()
    const known = SECTION_ORDER.filter(s => map.has(s))
    const rest = Array.from(map.keys()).filter(k => !SECTION_ORDER.includes(k)).sort()
    for (const k of [...known, ...rest]) sorted.set(k, map.get(k)!)
    return sorted
  })()

  const brandTotals = QUOTE_BRANDS.reduce<Record<string, number>>((acc, b) => {
    acc[b] = items.filter(i => i.brand === b).reduce((s, i) => s + itemTotal(i), 0)
    return acc
  }, {})

  const startEdit = (item: AiQuoteItem) => {
    setEditingId(item.id)
    setEditBuf({ ...item })
  }

  const cancelEdit = () => { setEditingId(null); setEditBuf({}) }

  const commitEdit = () => {
    if (!editingId) return
    setItems(prev => prev.map(i => {
      if (i.id !== editingId) return i
      const qty = Number(editBuf.qty ?? i.qty) || 0
      const unit_price = Number(editBuf.unit_price ?? i.unit_price) || 0
      const discount_pct = Math.max(0, Math.min(100, Number(editBuf.discount_pct ?? i.discount_pct) || 0))
      return { ...i, ...editBuf, qty, unit_price, discount_pct, total: qty * unit_price * (1 - discount_pct / 100) }
    }))
    setEditingId(null)
    setEditBuf({})
    setDirty(true)
  }

  const addRow = () => {
    const newItem: AiQuoteItem = {
      id: tempId(), room: rooms[0] || 'Salon', brand: 'KNX', category: '',
      name: 'Nowa pozycja', qty: 1, unit: 'szt.', unit_price: 0,
      discount_pct: 0, total: 0, catalog_item_id: null, sort_order: items.length,
    }
    setItems(prev => [...prev, newItem])
    setDirty(true)
    startEdit(newItem)
  }

  const deleteRow = (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
    if (editingId === id) cancelEdit()
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await aiQuotesApi.update(projectId, quote.id, {
        items, notes, status,
        discount_pct: discountPct,
        labor_cost_pct: laborPct,
      } as any)
      onUpdated(updated)
      setDirty(false)
    } catch {
      alert('Błąd zapisu. Spróbuj ponownie.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Usunąć tę wycenę? Operacja jest nieodwracalna.')) return
    setDeleting(true)
    try {
      await aiQuotesApi.delete(projectId, quote.id)
      onDeleted(quote.id)
    } catch {
      alert('Błąd usuwania.')
      setDeleting(false)
    }
  }

  const handlePrint = () => {
    navigate(`/projects/${projectId}/ai-quotes/${quote.id}/print`)
  }

  const handleExcelExport = async () => {
    const date = new Date().toISOString().slice(0, 10)
    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const NCOLS = 8
    // Rabat per-pozycja + globalny są wliczone w ceny (klient nie widzi rabatów)
    const effPrice = (item: AiQuoteItem) =>
      (item.unit_price || 0) * (1 - (item.discount_pct || 0) / 100) * (1 - discountPct / 100)
    const effTotal = (item: AiQuoteItem) => (item.qty || 0) * effPrice(item)

    // ── Logo: pobierz webp → konwertuj na PNG przez canvas ────────────────
    const logoBase64: string | null = await (async () => {
      try {
        const resp = await fetch('/logo_wh2.webp')
        const blob = await resp.blob()
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#1e293b'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(bitmap, 0, 0)
        return canvas.toDataURL('image/png').split(',')[1]
      } catch { return null }
    })()

    const wb = new (ExcelJS as any).Workbook()
    const ws = wb.addWorksheet('Wycena', { views: [{ state: 'frozen', ySplit: 7 }] })

    // ── Paleta kolorów (ARGB) ─────────────────────────────────────────────
    const C = {
      title:  { bg: 'FF4C1D95', fg: 'FFFFFFFF' },
      header: { bg: 'FF7C3AED', fg: 'FFFFFFFF' },
      floors: {
        'Parter':                   { bg: 'FFF97316', fg: 'FFFFFFFF', roomBg: 'FFFED7AA', roomFg: 'FF7C2D12' },
        'Piętro 1':                 { bg: 'FF3B82F6', fg: 'FFFFFFFF', roomBg: 'FFBFDBFE', roomFg: 'FF1E3A5F' },
        'Piętro 2':                 { bg: 'FF0EA5E9', fg: 'FFFFFFFF', roomBg: 'FFE0F2FE', roomFg: 'FF0C4A6E' },
        'Poddasze':                 { bg: 'FF10B981', fg: 'FFFFFFFF', roomBg: 'FFA7F3D0', roomFg: 'FF064E3B' },
        'Piwnica':                  { bg: 'FF6B7280', fg: 'FFFFFFFF', roomBg: 'FFE5E7EB', roomFg: 'FF1F2937' },
        'Na zewnątrz':              { bg: 'FF84CC16', fg: 'FFFFFFFF', roomBg: 'FFD9F99D', roomFg: 'FF365314' },
        'Instalacja / Rozdzielnia': { bg: 'FF8B5CF6', fg: 'FFFFFFFF', roomBg: 'FFEDE9FE', roomFg: 'FF4C1D95' },
        'Inne':                     { bg: 'FF9CA3AF', fg: 'FFFFFFFF', roomBg: 'FFF3F4F6', roomFg: 'FF374151' },
      } as Record<string, { bg: string; fg: string; roomBg: string; roomFg: string }>,
      rowEven: 'FFFFFFFF',
      rowOdd:  'FFF9FAFB',
      grand:   { bg: 'FF4C1D95', fg: 'FFFFFFFF' },
    }

    const thinBorder = { style: 'thin', color: { argb: 'FFD1D5DB' } }
    const allBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder }

    // Helper: ustaw komórkę ze stylem
    const sc = (
      row: number, col: number, value: any,
      opts: { bg?: string; fg?: string; bold?: boolean; sz?: number; italic?: boolean; ha?: string } = {}
    ) => {
      const cell = ws.getCell(row, col)
      cell.value = value
      if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } }
      cell.font = { bold: opts.bold ?? false, italic: opts.italic ?? false,
                    size: opts.sz ?? 10, color: { argb: opts.fg ?? 'FF111827' } }
      cell.alignment = { horizontal: (opts.ha ?? 'left') as any, vertical: 'middle' }
      cell.border = allBorders
    }

    // ── Wykrywanie pięter ─────────────────────────────────────────────────
    const FLOOR_KW: [string, string][] = [
      ['parter', 'Parter'], ['salon', 'Parter'], ['kuchni', 'Parter'],
      ['jadalni', 'Parter'], ['hol', 'Parter'], ['przedpok', 'Parter'],
      ['wiatrołap', 'Parter'], ['wc', 'Parter'], ['garaż', 'Parter'],
      ['toalet', 'Parter'], ['gabinet', 'Parter'],
      ['piętro 2', 'Piętro 2'], ['drugie', 'Piętro 2'],
      ['piętro', 'Piętro 1'], ['sypialnia', 'Piętro 1'],
      ['łazienka', 'Piętro 1'], ['garderoba', 'Piętro 1'],
      ['dzieci', 'Piętro 1'], ['korytarz', 'Piętro 1'],
      ['poddasze', 'Poddasze'], ['strych', 'Poddasze'],
      ['piwnica', 'Piwnica'], ['suterena', 'Piwnica'],
      ['taras', 'Na zewnątrz'], ['ogród', 'Na zewnątrz'], ['balkon', 'Na zewnątrz'],
      ['instalacja', 'Instalacja / Rozdzielnia'],
      ['rozdzielnia', 'Instalacja / Rozdzielnia'],
      ['technicz', 'Instalacja / Rozdzielnia'],
    ]
    const detectFloor = (room: string) => {
      const lo = room.toLowerCase()
      for (const [kw, fl] of FLOOR_KW) if (lo.includes(kw)) return fl
      return 'Inne'
    }

    // ── Grupowanie: piętro → pokój → pozycje ─────────────────────────────
    const FLOOR_ORDER = ['Parter','Piętro 1','Piętro 2','Poddasze',
      'Piwnica','Na zewnątrz','Instalacja / Rozdzielnia','Inne']
    const floorGroups = new Map<string, Map<string, AiQuoteItem[]>>()
    for (const item of [...items].sort((a, b) =>
      a.room.localeCompare(b.room, 'pl') || a.brand.localeCompare(b.brand))) {
      const fl = detectFloor(item.room)
      if (!floorGroups.has(fl)) floorGroups.set(fl, new Map())
      const rm = floorGroups.get(fl)!
      if (!rm.has(item.room)) rm.set(item.room, [])
      rm.get(item.room)!.push(item)
    }
    const sortedFloors = FLOOR_ORDER.filter(f => floorGroups.has(f))

    let R = 1 // ExcelJS — 1-indexed

    // ── Logo row ───────────────────────────────────────────────────────────
    for (let c = 1; c <= NCOLS; c++) {
      ws.getCell(R, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }
    }
    ws.mergeCells(R, 1, R, NCOLS); ws.getRow(R).height = 54
    if (logoBase64) {
      const logoImgId = wb.addImage({ base64: logoBase64, extension: 'png' })
      ws.addImage(logoImgId, { tl: { col: 0, row: R - 1 } as any, ext: { width: 220, height: 52 } })
    }
    R++

    // ── Tytuł ─────────────────────────────────────────────────────────────
    sc(R, 1, 'WYCENA SMART HOME', { bg: C.title.bg, fg: C.title.fg, bold: true, sz: 16, ha: 'center' })
    ws.mergeCells(R, 1, R, NCOLS); ws.getRow(R).height = 34; R++

    sc(R, 1, `Data wyceny: ${date}`, { bg: 'FFF3F4F6', fg: 'FF6B7280', italic: true, ha: 'center' })
    ws.mergeCells(R, 1, R, NCOLS); ws.getRow(R).height = 18; R++

    // ── Adnotacje ─────────────────────────────────────────────────────────
    sc(R, 1, 'Wszystkie ceny są cenami netto w PLN', { bg: 'FFFFFBEB', fg: 'FF92400E', italic: true, ha: 'center' })
    ws.mergeCells(R, 1, R, NCOLS); ws.getRow(R).height = 16; R++

    sc(R, 1, `Wycena ważna do: ${validUntil}`, { bg: 'FFFFFBEB', fg: 'FF92400E', bold: true, ha: 'center' })
    ws.mergeCells(R, 1, R, NCOLS); ws.getRow(R).height = 16; R++

    R++ // pusty wiersz

    // ── Nagłówki kolumn ───────────────────────────────────────────────────
    const colLabels = ['Pomieszczenie','Marka','Kategoria','Nazwa produktu',
      'Ilość','Jedn.','Cena netto PLN','Wartość netto PLN']
    colLabels.forEach((lbl, i) => sc(R, i + 1, lbl, { bg: C.header.bg, fg: C.header.fg, bold: true, ha: 'center' }))
    ws.getRow(R).height = 22; R++

    // ── Piętra / Pokoje / Pozycje ─────────────────────────────────────────
    for (const floor of sortedFloors) {
      const fc = C.floors[floor] ?? C.floors['Inne']

      // Nagłówek piętra
      sc(R, 1, `  ${floor.toUpperCase()}`, { bg: fc.bg, fg: fc.fg, bold: true, sz: 12 })
      ws.mergeCells(R, 1, R, NCOLS); ws.getRow(R).height = 24; R++

      let floorTotal = 0

      for (const [room, roomItems] of floorGroups.get(floor)!) {
        // Nagłówek pokoju
        sc(R, 1, `    ${room}`, { bg: fc.roomBg, fg: fc.roomFg, bold: true })
        ws.mergeCells(R, 1, R, NCOLS); ws.getRow(R).height = 18; R++

        let roomTotal = 0
        roomItems.forEach((item, idx) => {
          const rowBg = idx % 2 === 0 ? C.rowEven : C.rowOdd
          const total = itemTotal(item)
          roomTotal += total; floorTotal += total

          sc(R, 1, item.room,                    { bg: rowBg })
          sc(R, 2, item.brand,                   { bg: rowBg, bold: true })
          sc(R, 3, item.category,                { bg: rowBg })
          sc(R, 4, item.name,                    { bg: rowBg })
          sc(R, 5, item.qty,                     { bg: rowBg, ha: 'right' })
          sc(R, 6, item.unit,                    { bg: rowBg, ha: 'center' })
          sc(R, 7, Math.round(effPrice(item)),   { bg: rowBg, ha: 'right' })
          sc(R, 8, Math.round(effTotal(item)),   { bg: rowBg, bold: true, ha: 'right' })
          ws.getRow(R).height = 16; R++
        })

        // Subtotal pokoju
        for (let c = 1; c <= 6; c++) sc(R, c, '', { bg: fc.roomBg })
        sc(R, 7, `Razem ${room}:`, { bg: fc.roomBg, fg: fc.roomFg, bold: true, italic: true, ha: 'right' })
        sc(R, 8, Math.round(roomTotal), { bg: fc.roomBg, fg: fc.roomFg, bold: true, ha: 'right' })
        ws.getRow(R).height = 16; R++
      }

      // Subtotal piętra
      for (let c = 1; c <= 6; c++) sc(R, c, '', { bg: fc.bg })
      sc(R, 7, `RAZEM ${floor}:`, { bg: fc.bg, fg: fc.fg, bold: true, sz: 11, ha: 'right' })
      sc(R, 8, Math.round(floorTotal), { bg: fc.bg, fg: fc.fg, bold: true, sz: 11, ha: 'right' })
      ws.getRow(R).height = 22; R++
      R++ // odstęp
    }

    // ── Podsumowanie finansowe ────────────────────────────────────────────
    const sumRow = (label: string, val: number, bold = false) => {
      const master = ws.getCell(R, 1)
      master.value = label
      master.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } }
      master.font = { bold, size: 10, color: { argb: 'FF374151' } }
      master.alignment = { horizontal: 'right', vertical: 'middle' }
      master.border = allBorders
      ws.mergeCells(R, 1, R, 7)
      sc(R, 8, Math.round(val), { bg: 'FFF9FAFB', fg: 'FF111827', bold, ha: 'right' })
      ws.getRow(R).height = 18; R++
    }
    // Ceny w wycenie już zawierają rabaty — pokazujemy tylko wartości końcowe
    const excelEquipment = items.reduce((s, i) => s + effTotal(i), 0)
    const excelLaborCost = excelEquipment * (laborPct / 100)
    const excelGrandTotal = excelEquipment + excelLaborCost
    sumRow('Wartość sprzętu netto:', excelEquipment)
    sumRow(`Robocizna (${laborPct}%):`, excelLaborCost)
    R++ // pusty wiersz

    // Grand Total
    const gtMaster = ws.getCell(R, 1)
    gtMaster.value = 'GRAND TOTAL (PLN):'
    gtMaster.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.grand.bg } }
    gtMaster.font = { bold: true, size: 13, color: { argb: C.grand.fg } }
    gtMaster.alignment = { horizontal: 'right', vertical: 'middle' }
    gtMaster.border = allBorders
    ws.mergeCells(R, 1, R, 7)
    sc(R, 8, Math.round(excelGrandTotal), { bg: C.grand.bg, fg: C.grand.fg, bold: true, sz: 14, ha: 'right' })
    ws.getRow(R).height = 30

    // ── Szerokości kolumn ─────────────────────────────────────────────────
    ws.columns = [
      { width: 22 }, { width: 10 }, { width: 20 }, { width: 42 },
      { width: 7  }, { width: 7  }, { width: 14 }, { width: 16 },
    ]

    // ── Arkusze per brand ────────────────────────────────────────────────
    const BRAND_COLORS: Record<string, { bg: string; fg: string }> = {
      KNX:       { bg: 'FFF97316', fg: 'FFFFFFFF' },
      Control4:  { bg: 'FF3B82F6', fg: 'FFFFFFFF' },
      Hikvision: { bg: 'FFEF4444', fg: 'FFFFFFFF' },
      Satel:     { bg: 'FF22C55E', fg: 'FFFFFFFF' },
    }
    const brandGroups = new Map<string, typeof items>()
    for (const item of items) {
      if (!brandGroups.has(item.brand)) brandGroups.set(item.brand, [])
      brandGroups.get(item.brand)!.push(item)
    }
    for (const [brand, brandItems] of brandGroups) {
      const bc = BRAND_COLORS[brand] ?? { bg: 'FF6B7280', fg: 'FFFFFFFF' }
      const wsBrand = wb.addWorksheet(brand)
      let BR = 1

      // Tytuł sekcji
      const btCell = wsBrand.getCell(BR, 1)
      btCell.value = brand.toUpperCase()
      btCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bc.bg } }
      btCell.font = { bold: true, size: 14, color: { argb: bc.fg } }
      btCell.alignment = { horizontal: 'center', vertical: 'middle' }
      btCell.border = allBorders
      wsBrand.mergeCells(BR, 1, BR, NCOLS); wsBrand.getRow(BR).height = 30; BR++

      // Nagłówki
      colLabels.forEach((lbl, i) => {
        const hc = wsBrand.getCell(BR, i + 1)
        hc.value = lbl
        hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bc.bg } }
        hc.font = { bold: true, size: 10, color: { argb: bc.fg } }
        hc.alignment = { horizontal: 'center', vertical: 'middle' }
        hc.border = allBorders
      })
      wsBrand.getRow(BR).height = 20; BR++

      // Grupuj po kategorii
      const catMap = new Map<string, typeof brandItems>()
      for (const item of brandItems) {
        if (!catMap.has(item.category)) catMap.set(item.category, [])
        catMap.get(item.category)!.push(item)
      }
      let brandTotal = 0
      for (const [cat, catItems] of catMap) {
        // Nagłówek kategorii
        const chCell = wsBrand.getCell(BR, 1)
        chCell.value = `  ${cat}`
        chCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
        chCell.font = { bold: true, size: 10, color: { argb: 'FF374151' } }
        chCell.alignment = { horizontal: 'left', vertical: 'middle' }
        chCell.border = allBorders
        wsBrand.mergeCells(BR, 1, BR, NCOLS); wsBrand.getRow(BR).height = 18; BR++

        catItems.forEach((item, idx) => {
          const rowBg = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF9FAFB'
          const total = itemTotal(item)
          brandTotal += total
          const scB = (col: number, val: any, opts: any = {}) => {
            const cell = wsBrand.getCell(BR, col)
            cell.value = val
            if (opts.bg ?? rowBg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg ?? rowBg } }
            cell.font = { bold: opts.bold ?? false, size: 10, color: { argb: opts.fg ?? 'FF111827' } }
            cell.alignment = { horizontal: (opts.ha ?? 'left') as any, vertical: 'middle' }
            cell.border = allBorders
          }
          scB(1, item.room); scB(2, item.brand, { bold: true }); scB(3, item.category)
          scB(4, item.name); scB(5, item.qty, { ha: 'right' }); scB(6, item.unit, { ha: 'center' })
          scB(7, Math.round(effPrice(item)), { ha: 'right' })
          scB(8, Math.round(effTotal(item)), { bold: true, ha: 'right' })
          wsBrand.getRow(BR).height = 16; BR++
        })
      }

      // Suma sekcji
      for (let c = 1; c <= 7; c++) {
        const cell = wsBrand.getCell(BR, c)
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bc.bg } }
        cell.border = allBorders
        if (c === 7) { cell.value = `RAZEM ${brand}:`; cell.font = { bold: true, size: 11, color: { argb: bc.fg } }; cell.alignment = { horizontal: 'right' } }
      }
      const brandEffTotal = brandItems.reduce((s, i) => s + effTotal(i), 0)
      const bsCell = wsBrand.getCell(BR, 8)
      bsCell.value = Math.round(brandEffTotal)
      bsCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bc.bg } }
      bsCell.font = { bold: true, size: 12, color: { argb: bc.fg } }
      bsCell.alignment = { horizontal: 'right', vertical: 'middle' }
      bsCell.border = allBorders
      wsBrand.getRow(BR).height = 24

      wsBrand.columns = [
        { width: 22 }, { width: 10 }, { width: 20 }, { width: 42 },
        { width: 7  }, { width: 7  }, { width: 14 }, { width: 16 },
      ]
    }

    // ── Arkusz 2: Podsumowanie z sekcjami i linkami ───────────────────────
    const ws2 = wb.addWorksheet('Podsumowanie')
    ws2.columns = [{ width: 32 }, { width: 20 }]

    const s2sc = (row: number, col: number, value: any, opts: any = {}) => {
      const cell = ws2.getCell(row, col)
      cell.value = value
      if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } }
      cell.font = { bold: opts.bold ?? false, size: opts.sz ?? 10, color: { argb: opts.fg ?? 'FF111827' } }
      cell.alignment = { horizontal: (opts.ha ?? 'left') as any, vertical: 'middle' }
      if (opts.border !== false) cell.border = allBorders
    }

    let SR = 1
    // Logo row
    for (let c = 1; c <= 2; c++) {
      ws2.getCell(SR, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }
    }
    ws2.mergeCells(SR, 1, SR, 2); ws2.getRow(SR).height = 54
    if (logoBase64) {
      const logoImgId2 = wb.addImage({ base64: logoBase64, extension: 'png' })
      ws2.addImage(logoImgId2, { tl: { col: 0, row: SR - 1 } as any, ext: { width: 220, height: 52 } })
    }
    SR++

    // Tytuł
    const s2title = ws2.getCell(SR, 1)
    s2title.value = 'Wycena Smart Home — Podsumowanie'
    s2title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4C1D95' } }
    s2title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
    s2title.alignment = { horizontal: 'center', vertical: 'middle' }
    s2title.border = allBorders
    ws2.mergeCells(SR, 1, SR, 2); ws2.getRow(SR).height = 30; SR++

    s2sc(SR, 1, 'Data', { bg: 'FFF3F4F6', fg: 'FF6B7280' })
    s2sc(SR, 2, date,   { bg: 'FFF3F4F6', fg: 'FF6B7280', ha: 'right' })
    ws2.getRow(SR).height = 18; SR++

    // Adnotacje
    const ann1 = ws2.getCell(SR, 1)
    ann1.value = 'Wszystkie ceny są cenami netto w PLN'
    ann1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } }
    ann1.font = { italic: true, size: 10, color: { argb: 'FF92400E' } }
    ann1.alignment = { horizontal: 'center', vertical: 'middle' }
    ann1.border = allBorders
    ws2.mergeCells(SR, 1, SR, 2); ws2.getRow(SR).height = 16; SR++

    const ann2 = ws2.getCell(SR, 1)
    ann2.value = `Wycena ważna do: ${validUntil}`
    ann2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } }
    ann2.font = { bold: true, size: 10, color: { argb: 'FF92400E' } }
    ann2.alignment = { horizontal: 'center', vertical: 'middle' }
    ann2.border = allBorders
    ws2.mergeCells(SR, 1, SR, 2); ws2.getRow(SR).height = 16; SR++

    SR++ // odstęp

    // Nagłówek sekcji
    s2sc(SR, 1, 'Sekcja', { bg: 'FF7C3AED', fg: 'FFFFFFFF', bold: true, ha: 'center' })
    s2sc(SR, 2, 'Wartość netto PLN', { bg: 'FF7C3AED', fg: 'FFFFFFFF', bold: true, ha: 'center' })
    ws2.getRow(SR).height = 22; SR++

    // Sumy per brand po uwzględnieniu rabatów
    const brandEffTotals = new Map<string, number>()
    for (const [brand, brandItems2] of brandGroups) {
      brandEffTotals.set(brand, brandItems2.reduce((s, i) => s + effTotal(i), 0))
    }

    for (const [brand, total] of brandEffTotals) {
      const bc = BRAND_COLORS[brand] ?? { bg: 'FF6B7280', fg: 'FFFFFFFF' }
      const linkCell = ws2.getCell(SR, 1)
      linkCell.value = { text: brand, hyperlink: `#${brand}!A1` }
      linkCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bc.bg } }
      linkCell.font = { bold: true, size: 11, color: { argb: bc.fg }, underline: true }
      linkCell.alignment = { horizontal: 'left', vertical: 'middle' }
      linkCell.border = allBorders
      s2sc(SR, 2, Math.round(total), { bg: bc.bg, fg: bc.fg, bold: true, ha: 'right', sz: 11 })
      ws2.getRow(SR).height = 22; SR++
    }
    SR++ // odstęp

    // Ceny zawierają już wszystkie rabaty — nie pokazujemy pozycji rabatowych
    const s2Equipment = items.reduce((s, i) => s + effTotal(i), 0)
    const s2Labor = s2Equipment * (laborPct / 100)
    const s2Grand = s2Equipment + s2Labor

    s2sc(SR, 1, 'Wartość sprzętu netto', { bg: 'FFF9FAFB', bold: false })
    s2sc(SR, 2, Math.round(s2Equipment), { bg: 'FFF9FAFB', ha: 'right' }); SR++

    s2sc(SR, 1, `Robocizna (${laborPct}%)`, { bg: 'FFF9FAFB' })
    s2sc(SR, 2, Math.round(s2Labor), { bg: 'FFF9FAFB', ha: 'right' }); SR++
    SR++

    // Grand Total
    const gtA = ws2.getCell(SR, 1)
    gtA.value = 'GRAND TOTAL (PLN)'
    gtA.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4C1D95' } }
    gtA.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }
    gtA.alignment = { horizontal: 'left', vertical: 'middle' }
    gtA.border = allBorders
    const gtB = ws2.getCell(SR, 2)
    gtB.value = Math.round(s2Grand)
    gtB.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4C1D95' } }
    gtB.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }
    gtB.alignment = { horizontal: 'right', vertical: 'middle' }
    gtB.border = allBorders
    ws2.getRow(SR).height = 28

    // ── Download ──────────────────────────────────────────────────────────
    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer as ArrayBuffer],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `wycena_${projectId}_${date}.xlsx`
    document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  const handleEtsExport = async () => {
    try {
      const blob = await aiQuotesApi.exportEts(projectId, quote.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `projekt_KNX_${projectId}.knxproj`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      alert('Błąd generowania pliku KNX ETS.')
    }
  }

  const handleApproveAsExample = async () => {
    if (!approveForm.title.trim()) return
    setApproveSaving(true)
    try {
      const brands = Array.from(new Set(items.map(i => i.brand).filter(Boolean)))
      await api.post('/api/ai-quote-examples', {
        title: approveForm.title.trim(),
        project_type: approveForm.project_type,
        brands,
        area_m2: approveForm.area_m2 ? Number(approveForm.area_m2) : null,
        rooms_count: Array.from(new Set(items.map(i => i.room))).length,
        ai_prompt: quote.notes || null,
        ai_items: null,
        final_items: items,
        final_total_net: totalEquipment,
        human_notes: approveForm.human_notes.trim() || null,
        source_quote_id: quote.id,
      })
      setApproveSuccess(true)
      setTimeout(() => {
        setApproveModalOpen(false)
        setApproveSuccess(false)
        setApproveForm({ title: '', project_type: 'residential', area_m2: '', human_notes: '' })
      }, 1500)
    } catch {
      alert('Błąd zapisu wzorca. Spróbuj ponownie.')
    } finally {
      setApproveSaving(false)
    }
  }

  const handleRefine = async () => {
    const text = refineSuggestion.trim()
    if (!text) return
    setRefineLoading(true)
    setRefineError(null)
    const itemsBefore = items.length
    try {
      const updated = await aiQuotesApi.refine(projectId, quote.id, text)
      setItems(updated.items.map(i => ({ ...i, discount_pct: i.discount_pct ?? 0 })))
      setRefineHistory(prev => [{
        suggestion: text,
        appliedAt: new Date().toLocaleString('pl-PL'),
        itemsBefore,
        itemsAfter: updated.items.length,
      }, ...prev].slice(0, 20))
      setRefineSuggestion('')
      setDirty(true)
      onUpdated(updated)
    } catch (err: any) {
      setRefineError(err?.response?.data?.error ?? err?.message ?? 'Błąd połączenia z AI.')
    } finally {
      setRefineLoading(false)
    }
  }

  const hasKnxItems = items.some(i => i.brand === 'KNX')

  const BrandBadge = ({ brand }: { brand: QuoteBrand }) => (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${QUOTE_BRAND_COLORS[brand]}`}>
      {brand}
    </span>
  )

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">Status:</span>
          <select
            value={status}
            onChange={e => { setStatus(e.target.value as AiQuote['status']); setDirty(true) }}
            className="text-xs border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
          >
            {(Object.entries(QUOTE_STATUS_LABELS) as [AiQuote['status'], string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          {/* Floor plan links */}
          {(quote.floor_plan_filenames?.length
            ? quote.floor_plan_filenames.map((fn, i) => ({ fn, name: quote.floor_plan_originals?.[i] || fn }))
            : quote.floor_plan_filename ? [{ fn: quote.floor_plan_filename, name: quote.floor_plan_original || quote.floor_plan_filename }] : []
          ).map(({ fn, name }) => (
            <a key={fn} href={aiQuotesApi.floorPlanUrl(fn)} target="_blank" rel="noopener noreferrer"
              className="text-xs text-violet-600 dark:text-violet-400 hover:underline truncate max-w-[120px]" title={name}>
              📎 {name}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-500">● Niezapisane zmiany</span>}
          <button onClick={handlePrint}
            className="px-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
            📄 PDF
          </button>
          <button onClick={handleExcelExport}
            className="px-3 py-1.5 text-xs border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/20 rounded-lg transition-colors">
            📊 Excel
          </button>
          {hasKnxItems && (
            <button onClick={handleEtsExport}
              className="px-3 py-1.5 text-xs border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/20 rounded-lg transition-colors">
              🏗 KNX ETS
            </button>
          )}
          <button onClick={handleSave} disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Zapisuję…' : '💾 Zapisz'}
          </button>
          <button
            onClick={() => setApproveModalOpen(true)}
            title="Zatwierdź tę wycenę jako wzorzec dla przyszłych wycen AI"
            className="px-3 py-1.5 text-xs border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded-lg transition-colors">
            🧠 Wzorzec AI
          </button>
          <button onClick={handleDelete} disabled={deleting}
            className="px-3 py-1.5 text-xs border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors disabled:opacity-50">
            🗑
          </button>
        </div>
      </div>

      {/* View mode toggle */}
      <div className="flex items-center gap-1 text-xs">
        <button
          onClick={() => setViewMode('rooms')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${viewMode === 'rooms' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
        >
          🏠 Widok pomieszczeń
        </button>
        <button
          onClick={() => setViewMode('flat')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${viewMode === 'flat' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
        >
          📋 Lista zbiorcza
        </button>
      </div>

      {/* Items table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
        {viewMode === 'flat' ? (
          /* ── FLAT / AGGREGATED VIEW ─────────────────────────────────────── */
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 text-left">
                <th className="px-3 py-2 font-medium w-24">Marka</th>
                <th className="px-3 py-2 font-medium">Nazwa produktu</th>
                <th className="px-3 py-2 font-medium w-16 text-right">Ilość</th>
                <th className="px-3 py-2 font-medium w-12">J.m.</th>
                <th className="px-3 py-2 font-medium w-24 text-right">Cena netto</th>
                <th className="px-3 py-2 font-medium w-16 text-right">Rab.%</th>
                <th className="px-3 py-2 font-medium w-24 text-right">Razem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {Array.from(flatCategories.entries()).map(([category, catItems]) => {
                const catTotal = catItems.reduce((s, i) => s + i.total, 0)
                return (
                  <>
                    <tr key={`cat-${category}`} className="bg-gray-50 dark:bg-gray-800/40">
                      <td colSpan={7} className="px-3 py-2 font-semibold text-gray-700 dark:text-gray-200 text-xs">
                        {category}
                        <span className="ml-2 font-normal text-gray-400">({catItems.length} pozycji)</span>
                      </td>
                    </tr>
                    {catItems
                      .sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name, 'pl'))
                      .map(item => (
                        <tr key={item.key} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                          <td className="px-3 py-2"><BrandBadge brand={item.brand} /></td>
                          <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{item.name}</td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-800 dark:text-gray-100">{item.qty}</td>
                          <td className="px-3 py-2 text-gray-400">{item.unit}</td>
                          <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmtInt(item.unit_price)}</td>
                          <td className="px-3 py-2 text-right">
                            {item.discount_pct > 0
                              ? <span className="text-amber-600 dark:text-amber-400 font-medium">{item.discount_pct}%</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>
                            }
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-gray-700 dark:text-gray-200">{fmtInt(item.total)}</td>
                        </tr>
                      ))}
                    <tr key={`cat-total-${category}`} className="bg-gray-50/70 dark:bg-gray-800/20">
                      <td colSpan={6} className="px-3 py-1.5 text-right text-xs text-gray-500 dark:text-gray-400 italic">Razem {category}:</td>
                      <td className="px-3 py-1.5 text-right text-xs font-semibold text-gray-700 dark:text-gray-200">{fmtInt(catTotal)}</td>
                    </tr>
                  </>
                )
              })}
            </tbody>
          </table>
        ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 text-left">
              <th className="px-3 py-2 font-medium w-28">Pomieszczenie</th>
              <th className="px-3 py-2 font-medium w-24">Marka</th>
              <th className="px-3 py-2 font-medium w-28">Kategoria</th>
              <th className="px-3 py-2 font-medium">Produkt</th>
              <th className="px-3 py-2 font-medium w-14 text-right">Ilość</th>
              <th className="px-3 py-2 font-medium w-12">J.m.</th>
              <th className="px-3 py-2 font-medium w-24 text-right">Cena netto</th>
              <th className="px-3 py-2 font-medium w-16 text-right">Rab.%</th>
              <th className="px-3 py-2 font-medium w-24 text-right">Razem</th>
              <th className="px-3 py-2 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rooms.map(room => (
              <>
                <tr key={`room-${room}`} className="bg-gray-50 dark:bg-gray-800/40">
                  <td colSpan={10} className="px-3 py-1.5 font-semibold text-gray-600 dark:text-gray-300 text-xs">
                    🏠 {room}
                  </td>
                </tr>
                {items.filter(i => i.room === room).map(item => (
                  <tr key={item.id}
                    className={`group hover:bg-gray-50 dark:hover:bg-gray-800/30 ${editingId === item.id ? 'bg-violet-50 dark:bg-violet-950/10' : ''}`}>
                    {editingId === item.id ? (
                      <>
                        <td className="px-2 py-1">
                          <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.room ?? item.room}
                            onChange={e => setEditBuf(b => ({ ...b, room: e.target.value }))} />
                        </td>
                        <td className="px-2 py-1">
                          <select className="w-full border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.brand ?? item.brand}
                            onChange={e => setEditBuf(b => ({ ...b, brand: e.target.value as QuoteBrand }))}>
                            {QUOTE_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.category ?? item.category}
                            onChange={e => setEditBuf(b => ({ ...b, category: e.target.value }))} />
                        </td>
                        <td className="px-2 py-1">
                          <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.name ?? item.name}
                            onChange={e => setEditBuf(b => ({ ...b, name: e.target.value }))} />
                        </td>
                        <td className="px-2 py-1">
                          <input type="number" min="0" step="1"
                            className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs text-right bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.qty ?? item.qty}
                            onChange={e => setEditBuf(b => ({ ...b, qty: Number(e.target.value) }))} />
                        </td>
                        <td className="px-2 py-1">
                          <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.unit ?? item.unit}
                            onChange={e => setEditBuf(b => ({ ...b, unit: e.target.value }))} />
                        </td>
                        <td className="px-2 py-1">
                          <input type="number" min="0" step="1"
                            className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs text-right bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.unit_price ?? item.unit_price}
                            onChange={e => setEditBuf(b => ({ ...b, unit_price: Number(e.target.value) }))} />
                        </td>
                        <td className="px-2 py-1">
                          <input type="number" min="0" max="100" step="1"
                            className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs text-right bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={editBuf.discount_pct ?? item.discount_pct ?? 0}
                            onChange={e => setEditBuf(b => ({ ...b, discount_pct: Number(e.target.value) }))} />
                        </td>
                        <td className="px-3 py-1 text-right font-medium text-gray-500">
                          {fmtInt(
                            (Number(editBuf.qty ?? item.qty) || 0) *
                            (Number(editBuf.unit_price ?? item.unit_price) || 0) *
                            (1 - (Number(editBuf.discount_pct ?? item.discount_pct) || 0) / 100)
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <div className="flex gap-1">
                            <button onClick={commitEdit}
                              className="px-1.5 py-0.5 bg-green-600 hover:bg-green-700 text-white rounded text-xs" title="Zatwierdź">✓</button>
                            <button onClick={cancelEdit}
                              className="px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded text-xs" title="Anuluj">✕</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{item.room}</td>
                        <td className="px-3 py-2"><BrandBadge brand={item.brand} /></td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{item.category}</td>
                        <td className="px-3 py-2 text-gray-700 dark:text-gray-300 cursor-pointer hover:text-violet-600 dark:hover:text-violet-400"
                          onClick={() => startEdit(item)}>{item.name}</td>
                        <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">{item.qty}</td>
                        <td className="px-3 py-2 text-gray-400">{item.unit}</td>
                        <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmtInt(item.unit_price)}</td>
                        <td className="px-3 py-2 text-right">
                          {(item.discount_pct || 0) > 0
                            ? <span className="text-amber-600 dark:text-amber-400 font-medium">{item.discount_pct}%</span>
                            : <span className="text-gray-300 dark:text-gray-600">—</span>
                          }
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-gray-700 dark:text-gray-200">{fmtInt(itemTotal(item))}</td>
                        <td className="px-2 py-2">
                          <button onClick={() => deleteRow(item.id)}
                            className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity px-1" title="Usuń">×</button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
        )}
      </div>

      {/* Add row */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <button onClick={addRow} className="text-xs text-violet-600 dark:text-violet-400 hover:underline flex items-center gap-1">
          + Dodaj pozycję
        </button>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Sprzęt (przed rabatami): <span className="font-semibold text-gray-700 dark:text-gray-200">{fmtInt(totalEquipment)} PLN</span>
        </div>
      </div>

      {/* Brand summary */}
      {totalEquipment > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {QUOTE_BRANDS.map(brand => brandTotals[brand] > 0 && (
            <div key={brand} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3 bg-white dark:bg-gray-900">
              <div className="flex items-center gap-1.5 mb-1">
                <BrandBadge brand={brand} />
              </div>
              <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">{fmtInt(brandTotals[brand])} PLN</div>
              <div className="text-xs text-gray-400">
                {totalEquipment > 0 ? ((brandTotals[brand] / totalEquipment) * 100).toFixed(0) : 0}%
              </div>
            </div>
          ))}
        </div>
      )}

      {/* AI Token usage badge */}
      {(quote.tokens_input || quote.tokens_output) && (() => {
        const tin  = quote.tokens_input  ?? 0
        const tout = quote.tokens_output ?? 0
        const costUsd = quote.cost_usd ?? (tin * 3 + tout * 15) / 1_000_000
        const costPln = costUsd * 4.0
        return (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-violet-100 dark:border-violet-900/40 bg-violet-50 dark:bg-violet-950/20 text-xs text-violet-700 dark:text-violet-300 flex-wrap">
            <span className="font-semibold text-violet-500 dark:text-violet-400">🤖 AI</span>
            <span className="text-gray-400 dark:text-gray-600">|</span>
            <span>Wejście: <span className="font-semibold">{tin.toLocaleString('pl-PL')}</span> tok.</span>
            <span className="text-gray-400 dark:text-gray-600">|</span>
            <span>Wyjście: <span className="font-semibold">{tout.toLocaleString('pl-PL')}</span> tok.</span>
            <span className="text-gray-400 dark:text-gray-600">|</span>
            <span>Łącznie: <span className="font-semibold text-violet-600 dark:text-violet-300">{(tin + tout).toLocaleString('pl-PL')}</span> tok.</span>
            <span className="text-gray-400 dark:text-gray-600">|</span>
            <span>Koszt: <span className="font-semibold text-green-600 dark:text-green-400">~{costPln.toFixed(2)} PLN</span>
              <span className="text-gray-400 ml-1">(${costUsd.toFixed(4)})</span>
            </span>
          </div>
        )
      })()}

      {/* Discount + Labor panel */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50 text-xs font-semibold text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
          Podsumowanie finansowe
        </div>
        <div className="p-4 space-y-3">
          {/* Global discount / markup */}
          <div className="flex items-center justify-between gap-4">
            <label className="text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
              {discountPct < 0
                ? <span className="text-emerald-600 dark:text-emerald-400 font-medium">Narzut na sprzęt (%)</span>
                : 'Rabat / narzut na sprzęt (%)'}
              <span className="block text-gray-400 font-normal">ujemny = narzut, dodatni = rabat</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number" min="-100" max="100" step="1"
                className={`w-20 border rounded-md px-2 py-1 text-xs text-right bg-white dark:bg-gray-800 ${
                  discountPct < 0
                    ? 'border-emerald-400 dark:border-emerald-600 text-emerald-700 dark:text-emerald-300'
                    : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
                }`}
                value={discountPct}
                onChange={e => { setDiscountPct(Math.max(-100, Math.min(100, Number(e.target.value) || 0))); setDirty(true) }}
              />
              <span className="text-xs text-gray-400">%</span>
            </div>
          </div>

          {/* Labor % */}
          <div className="flex items-center justify-between gap-4">
            <label className="text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
              Robocizna (% wartości sprzętu)
              <span className="block text-gray-400 font-normal">domyślnie 100% = 1:1 do sprzętu</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number" min="0" max="500" step="5"
                className="w-20 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-xs text-right bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={laborPct}
                onChange={e => { setLaborPct(Math.max(0, Number(e.target.value) || 0)); setDirty(true) }}
              />
              <span className="text-xs text-gray-400">%</span>
            </div>
          </div>

          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 space-y-1.5">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Wartość sprzętu netto</span>
              <span>{fmtInt(totalEquipment)} PLN</span>
            </div>
            {discountPct !== 0 && (
              <div className={`flex justify-between text-xs ${discountPct < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                <span>{discountPct < 0 ? `Narzut (${Math.abs(discountPct)}%)` : `Rabat globalny (${discountPct}%)`}</span>
                <span>{discountPct < 0 ? '+ ' : '− '}{fmtInt(Math.abs(totalEquipment - totalAfterDiscount))} PLN</span>
              </div>
            )}
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Sprzęt po rabacie</span>
              <span>{fmtInt(totalAfterDiscount)} PLN</span>
            </div>
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Robocizna ({laborPct}%)</span>
              <span>{fmtInt(laborCost)} PLN</span>
            </div>
            <div className="flex justify-between text-sm font-bold text-gray-800 dark:text-gray-100 pt-1 border-t border-gray-100 dark:border-gray-800">
              <span>RAZEM</span>
              <span className="text-violet-700 dark:text-violet-300">{fmtInt(grandTotal)} PLN</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Services Panel ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-gray-900 overflow-hidden">
        <button
          className="w-full px-4 py-3 flex items-center justify-between bg-slate-50 dark:bg-slate-800/50 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          onClick={() => setServicesPanelOpen(o => !o)}
        >
          <span className="flex items-center gap-2">🔧 Kosztorys usług (instalacja + programowanie)</span>
          <span>{servicesPanelOpen ? '▲' : '▼'}</span>
        </button>
        {servicesPanelOpen && (() => {
          const instCat   = findRate(['Instalacja pojedynczego punktu'])
          const knxCat    = findRate(['KNX'])
          const c4Cat     = findRate(['Control4'])
          const satCat    = findRate(['SATEL', 'Satel'])
          const camCat    = findRate(['kamer', 'Hikvision'])
          const deviceCount = items.filter(i => i.brand !== 'Usługi').reduce((s, i) => s + (Number(i.qty) || 1), 0)

          const serviceRows = [
            {
              label: 'Instalacja punktów',
              desc: instCat?.name ?? '— brak w katalogu',
              qty: deviceCount, unit: 'szt.',
              rate: instCat?.unit_price ?? 0,
              total: deviceCount * (instCat?.unit_price ?? 0),
              rateOk: !!instCat,
            },
            {
              label: 'Programowanie KNX',
              desc: knxCat?.name ?? '— brak w katalogu',
              qty: serviceHours.knx, unit: 'h',
              rate: knxCat?.unit_price ?? 0,
              total: serviceHours.knx * (knxCat?.unit_price ?? 0),
              rateOk: !!knxCat,
              key: 'knx' as const,
            },
            {
              label: 'Programowanie Control4',
              desc: c4Cat?.name ?? '— brak w katalogu',
              qty: serviceHours.control4, unit: 'h',
              rate: c4Cat?.unit_price ?? 0,
              total: serviceHours.control4 * (c4Cat?.unit_price ?? 0),
              rateOk: !!c4Cat,
              key: 'control4' as const,
            },
            {
              label: 'Programowanie SATEL',
              desc: satCat?.name ?? '— brak w katalogu',
              qty: serviceHours.satel, unit: 'h',
              rate: satCat?.unit_price ?? 0,
              total: serviceHours.satel * (satCat?.unit_price ?? 0),
              rateOk: !!satCat,
              key: 'satel' as const,
            },
            {
              label: 'Programowanie kamer',
              desc: camCat?.name ?? '— brak w katalogu',
              qty: serviceHours.cameras, unit: 'h',
              rate: camCat?.unit_price ?? 0,
              total: serviceHours.cameras * (camCat?.unit_price ?? 0),
              rateOk: !!camCat,
              key: 'cameras' as const,
            },
          ]
          const servicesTotal = serviceRows.reduce((s, r) => s + r.total, 0)
          const noRates = serviceRows.every(r => !r.rateOk || r.rate === 0)

          return (
            <div className="p-4 space-y-4">
              {noRates && (
                <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                  ⚠️ Ustaw stawki usług w <strong>Katalogu produktów → Usługi</strong>, aby kalkulator działał poprawnie.
                </div>
              )}
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                    <th className="text-left pb-2 font-medium">Usługa</th>
                    <th className="text-right pb-2 font-medium w-20">Ilość</th>
                    <th className="text-right pb-2 font-medium w-14">J.m.</th>
                    <th className="text-right pb-2 font-medium w-24">Stawka PLN</th>
                    <th className="text-right pb-2 font-medium w-24">Wartość PLN</th>
                  </tr>
                </thead>
                <tbody>
                  {serviceRows.map((row, idx) => (
                    <tr key={idx} className="border-b border-gray-50 dark:border-gray-800/50">
                      <td className="py-2">
                        <div className="font-medium text-gray-700 dark:text-gray-300">{row.label}</div>
                        <div className="text-gray-400 truncate max-w-xs">{row.desc}</div>
                      </td>
                      <td className="py-2 text-right">
                        {'key' in row ? (
                          <input
                            type="number" min="0" step="1"
                            className="w-16 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-right text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                            value={serviceHours[row.key as keyof typeof serviceHours]}
                            onChange={e => setServiceHours(h => ({ ...h, [row.key!]: Math.max(0, Number(e.target.value) || 0) }))}
                          />
                        ) : (
                          <span className="font-medium text-gray-700 dark:text-gray-300">{row.qty}</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-gray-500 dark:text-gray-400">{row.unit}</td>
                      <td className="py-2 text-right text-gray-500 dark:text-gray-400">
                        {row.rate > 0 ? fmtInt(row.rate) : <span className="text-red-400">—</span>}
                      </td>
                      <td className="py-2 text-right font-semibold text-gray-700 dark:text-gray-300">
                        {row.total > 0 ? fmtInt(row.total) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-200 dark:border-gray-700">
                    <td colSpan={4} className="pt-2 text-right text-xs font-semibold text-gray-600 dark:text-gray-400">Suma usług:</td>
                    <td className="pt-2 text-right text-sm font-bold text-slate-700 dark:text-slate-200">{fmtInt(servicesTotal)} PLN</td>
                  </tr>
                </tfoot>
              </table>
              <button
                onClick={applyServices}
                className="w-full py-2 text-xs font-medium bg-slate-700 hover:bg-slate-800 text-white rounded-lg transition-colors"
              >
                ✅ Zastosuj usługi do wyceny (zastąpi istniejące pozycje Usługi)
              </button>
            </div>
          )
        })()}
      </div>

      {/* Description sections */}
      {quote.description && (quote.description.must_have || quote.description.nice_to_have || quote.description.premium) && (
        <div className="space-y-2">
          {[
            { key: 'must_have', label: '✅ Instalacja bazowa (koniecznie)', color: 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/20', badge: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
            { key: 'nice_to_have', label: '💡 Rekomendowane rozszerzenia', color: 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
            { key: 'premium', label: '⭐ Funkcjonalności premium', color: 'border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/20', badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
          ].map(({ key, label, color, badge }) => {
            const text = quote.description?.[key as keyof typeof quote.description]
            if (!text) return null
            return (
              <div key={key} className={`rounded-xl border p-4 ${color}`}>
                <div className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold mb-2 ${badge}`}>{label}</div>
                <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">{text}</p>
              </div>
            )
          })}
        </div>
      )}

      {/* Notes */}
      <div>
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">Notatki</label>
        <textarea
          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 resize-none"
          rows={3}
          placeholder="Dodatkowe uwagi do wyceny…"
          value={notes}
          onChange={e => { setNotes(e.target.value); setDirty(true) }}
        />
      </div>

      {/* ── AI Refinement Panel ─────────────────────────────────────────── */}
      <div className="rounded-2xl border border-violet-200 dark:border-violet-800/50 bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-950/20 dark:to-indigo-950/10 overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 flex items-center gap-3 border-b border-violet-100 dark:border-violet-800/30">
          <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400 text-base">
            🤖
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-violet-900 dark:text-violet-100">Korekty AI</div>
            <div className="text-xs text-violet-500 dark:text-violet-400">
              Opisz co zmienić — AI zmodyfikuje wycenę automatycznie
            </div>
          </div>
          {refineHistory.length > 0 && (
            <button
              onClick={() => setRefineHistoryOpen(o => !o)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors"
            >
              <span>Historia ({refineHistory.length})</span>
              <span>{refineHistoryOpen ? '▲' : '▼'}</span>
            </button>
          )}
        </div>

        {/* History */}
        {refineHistoryOpen && refineHistory.length > 0 && (
          <div className="border-b border-violet-100 dark:border-violet-800/30 px-4 py-3 space-y-2 max-h-48 overflow-y-auto">
            {refineHistory.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className="w-5 h-5 rounded-full bg-violet-200 dark:bg-violet-800 flex items-center justify-center text-violet-700 dark:text-violet-300 font-bold flex-shrink-0 mt-0.5">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-gray-700 dark:text-gray-300 font-medium leading-snug line-clamp-2">
                    "{entry.suggestion}"
                  </p>
                  <p className="text-gray-400 dark:text-gray-500 mt-0.5">
                    {entry.appliedAt} · {entry.itemsBefore} → {entry.itemsAfter} pozycji
                  </p>
                </div>
                <span className="text-green-500 flex-shrink-0 mt-0.5">✓</span>
              </div>
            ))}
          </div>
        )}

        {/* Input area */}
        <div className="p-4 space-y-3">
          {/* Example chips */}
          <div className="flex flex-wrap gap-1.5">
            {[
              'Zamień sterownik HDL DALI na M/DA6.10.1',
              'Dodaj stację pogodową na tarasie',
              'Usuń kamery wewnętrzne z sypialni',
              'Zwiększ ilość czujników ruchu Satel o 2',
              'Zamień panel 4" na panel 7" w salonie',
              'Dodaj podgrzewane lustro w każdej łazience',
            ].map(example => (
              <button
                key={example}
                onClick={() => setRefineSuggestion(example)}
                className="px-2 py-1 rounded-full text-xs bg-white dark:bg-gray-800 border border-violet-200 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 hover:border-violet-400 transition-all"
              >
                {example}
              </button>
            ))}
          </div>

          <div className="relative">
            <textarea
              className={`w-full text-sm border rounded-xl px-4 py-3 pr-12 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 resize-none transition-all focus:outline-none focus:ring-2 ${
                refineLoading
                  ? 'border-violet-300 dark:border-violet-600 ring-2 ring-violet-200 dark:ring-violet-800'
                  : 'border-gray-200 dark:border-gray-700 focus:border-violet-400 focus:ring-violet-200 dark:focus:border-violet-600 dark:focus:ring-violet-800/50'
              }`}
              rows={3}
              placeholder="np. &quot;Zamień sterownik A na sterownik B&quot;, &quot;Dodaj 2 kamery zewnętrzne&quot;, &quot;Usuń system alarmowy&quot;…"
              value={refineSuggestion}
              onChange={e => { setRefineSuggestion(e.target.value); setRefineError(null) }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !refineLoading) {
                  e.preventDefault()
                  handleRefine()
                }
              }}
              disabled={refineLoading}
            />
            {refineSuggestion && !refineLoading && (
              <button
                onClick={() => setRefineSuggestion('')}
                className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-xs"
              >✕</button>
            )}
          </div>

          {refineError && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40 text-xs text-red-600 dark:text-red-400">
              <span className="text-base leading-none flex-shrink-0">⚠️</span>
              <span>{refineError}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {refineLoading
                ? '⏳ AI analizuje i modyfikuje wycenę…'
                : 'Cmd/Ctrl+Enter aby zastosować'}
            </p>
            <button
              onClick={handleRefine}
              disabled={!refineSuggestion.trim() || refineLoading}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                refineLoading
                  ? 'bg-violet-400 dark:bg-violet-700 text-white cursor-not-allowed'
                  : !refineSuggestion.trim()
                  ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 cursor-not-allowed'
                  : 'bg-violet-600 hover:bg-violet-700 active:scale-95 text-white shadow-sm shadow-violet-200 dark:shadow-violet-900/50'
              }`}
            >
              {refineLoading ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Modyfikuję…
                </>
              ) : (
                <>✨ Zastosuj zmiany</>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Modal: Zatwierdź jako wzorzec AI ──────────────────────────────── */}
      {approveModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md border border-gray-200 dark:border-gray-700">
            <div className="p-5 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                🧠 Zatwierdź jako wzorzec AI
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Ta wycena ({items.length} pozycji) zostanie zapisana jako przykład dla przyszłych wycen AI.
                Claude będzie z niej korzystał przy kolejnych projektach.
              </p>
            </div>

            {approveSuccess ? (
              <div className="p-8 text-center">
                <div className="text-4xl mb-2">✅</div>
                <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Wzorzec zapisany!</p>
                <p className="text-xs text-gray-500 mt-1">Claude użyje go przy następnych wycenach.</p>
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Tytuł wzorca <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="np. Dom jednorodzinny 280m² KNX + Satel + Control4"
                    value={approveForm.title}
                    onChange={e => setApproveForm(f => ({ ...f, title: e.target.value }))}
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Typ projektu</label>
                    <select
                      value={approveForm.project_type}
                      onChange={e => setApproveForm(f => ({ ...f, project_type: e.target.value }))}
                      className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                    >
                      <option value="residential">Dom jednorodzinny</option>
                      <option value="apartment">Apartament / mieszkanie</option>
                      <option value="commercial">Biuro / komercyjny</option>
                      <option value="other">Inny</option>
                    </select>
                  </div>
                  <div className="w-28">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Powierzchnia m²</label>
                    <input
                      type="number"
                      placeholder="np. 280"
                      value={approveForm.area_m2}
                      onChange={e => setApproveForm(f => ({ ...f, area_m2: e.target.value }))}
                      className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Co poprawiłeś i dlaczego? <span className="text-gray-400">(opcjonalne, ale cenne dla AI)</span>
                  </label>
                  <textarea
                    rows={3}
                    placeholder="np. AI pominęło sterowanie żaluzjami i alarm Satel. Dodałem ręcznie 8 siłowników żaluzji i centralę alarmową z klawiaturami."
                    value={approveForm.human_notes}
                    onChange={e => setApproveForm(f => ({ ...f, human_notes: e.target.value }))}
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 outline-none resize-none"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Te uwagi trafią bezpośrednio do Claude jako wskazówki na co zwrócić uwagę.
                  </p>
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setApproveModalOpen(false)}
                    className="flex-1 px-4 py-2 text-sm border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors"
                  >
                    Anuluj
                  </button>
                  <button
                    onClick={handleApproveAsExample}
                    disabled={approveSaving || !approveForm.title.trim()}
                    className="flex-1 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {approveSaving ? 'Zapisuję…' : '🧠 Zapisz wzorzec'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
