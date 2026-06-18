import { useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../components/ui/Modal'
import { warehouseApi, productCatalogApi, projectsApi } from '../api/client'
import type { WarehouseItem, StockMovement, WarehouseDoc, WarehouseDocLineInput } from '../api/client'
import type { ProductCatalogItem, Project } from '../types'
import { useAuth } from '../auth/AuthContext'

function fmt(n: number) { return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(n || 0) }
function fmtDate(s: string) { const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' }) }

const MOVE_LABEL: Record<string, string> = { in: '➕ Przyjęcie', out: '➖ Wydanie', initial: '📥 Stan początkowy', adjust: '✏️ Korekta' }
const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
const lblCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'

export default function MagazynPage() {
  const { user } = useAuth()
  const canSee = user?.role === 'admin' || !!user?.can_view_warehouse

  const [view, setView] = useState<'stany' | 'dokumenty'>('stany')
  const [items, setItems] = useState<WarehouseItem[]>([])
  const [docs, setDocs] = useState<WarehouseDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showItem, setShowItem] = useState(false)
  const [editItem, setEditItem] = useState<WarehouseItem | null>(null)
  const [moveItem, setMoveItem] = useState<WarehouseItem | null>(null)
  const [histItem, setHistItem] = useState<WarehouseItem | null>(null)
  const [docType, setDocType] = useState<'WZ' | 'PZ' | null>(null)
  const [assignDoc, setAssignDoc] = useState<WarehouseDoc | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    Promise.all([warehouseApi.list(), warehouseApi.docsList()])
      .then(([its, ds]) => { setItems(its); setDocs(ds) })
      .catch(() => { setItems([]); setDocs([]) })
      .finally(() => setLoading(false))
  }
  useEffect(() => { if (canSee) load() }, [canSee])

  if (!canSee) {
    return <div className="p-10 text-center text-gray-500 dark:text-gray-400">Brak dostępu do magazynu. Skontaktuj się z administratorem.</div>
  }

  const q = search.trim().toLowerCase()
  const filtered = items.filter(i => !q || `${i.name} ${i.sku ?? ''} ${i.category ?? ''} ${i.location ?? ''}`.toLowerCase().includes(q))
  const totalValue = items.reduce((s, i) => s + i.quantity * i.unit_price, 0)
  const lowStock = items.filter(i => i.min_quantity > 0 && i.quantity <= i.min_quantity)

  const onImport = async (file: File) => {
    setImporting(true)
    try { const res = await warehouseApi.importExcel(file); alert(`Zaimportowano ${res.imported} pozycji.`); load() }
    catch (e: any) { alert(e?.response?.data?.error || 'Błąd importu pliku.') }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const del = async (it: WarehouseItem) => {
    if (!window.confirm(`Usunąć pozycję „${it.name}" wraz z historią ruchów?`)) return
    try { await warehouseApi.delete(it.id); load() } catch { alert('Nie udało się usunąć.') }
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Magazyn</h1>
          {view === 'stany'
            ? <p className="text-sm text-gray-500 dark:text-gray-400">{items.length} pozycji · wartość {fmt(totalValue)} PLN{lowStock.length ? ` · ⚠️ ${lowStock.length} poniżej minimum` : ''}</p>
            : <p className="text-sm text-gray-500 dark:text-gray-400">{docs.length} dokumentów WZ/PZ</p>}
        </div>
        <div className="flex items-center gap-2">
          {view === 'stany' ? (
            <>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f) }} />
              <button onClick={() => fileRef.current?.click()} disabled={importing} className="px-3 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg disabled:opacity-50">{importing ? 'Importuję…' : '📊 Import Excel'}</button>
              <button onClick={() => { setEditItem(null); setShowItem(true) }} className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">+ Dodaj pozycję</button>
            </>
          ) : (
            <>
              <button onClick={() => setDocType('PZ')} className="px-3 py-2 text-sm font-semibold bg-green-600 hover:bg-green-700 text-white rounded-lg">+ Nowy PZ</button>
              <button onClick={() => setDocType('WZ')} className="px-3 py-2 text-sm font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded-lg">+ Nowy WZ</button>
            </>
          )}
        </div>
      </div>

      {/* Toggle */}
      <div className="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit">
        {(['stany', 'dokumenty'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${view === v ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
            {v === 'stany' ? 'Stany magazynowe' : 'Dokumenty WZ/PZ'}
          </button>
        ))}
      </div>

      {loading ? <div className="text-center py-16 text-gray-400">Ładowanie…</div> : view === 'stany' ? (
        <>
          <input className={`${inputCls} mb-4 max-w-md`} placeholder="Szukaj: nazwa, SKU, kategoria, lokalizacja…" value={search} onChange={e => setSearch(e.target.value)} />
          {filtered.length === 0 ? (
            <div className="text-center py-16 text-gray-400"><div className="text-4xl mb-3">📦</div><p className="text-sm">{items.length === 0 ? 'Magazyn pusty. Dodaj pozycję lub zaimportuj stan z Excela.' : 'Brak pozycji.'}</p></div>
          ) : (
            <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-xl">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
                  <tr><th className="text-left px-3 py-2 font-medium">Nazwa</th><th className="text-left px-3 py-2 font-medium">SKU</th><th className="text-left px-3 py-2 font-medium">Kat./Lok.</th><th className="text-right px-3 py-2 font-medium">Stan</th><th className="text-right px-3 py-2 font-medium">Cena</th><th className="text-right px-3 py-2 font-medium">Wartość</th><th className="text-right px-3 py-2 font-medium">Akcje</th></tr>
                </thead>
                <tbody>
                  {filtered.map(it => {
                    const low = it.min_quantity > 0 && it.quantity <= it.min_quantity
                    return (
                      <tr key={it.id} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{it.name}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{it.sku || '—'}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">{[it.category, it.location].filter(Boolean).join(' · ') || '—'}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${low ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{low && '⚠️ '}{fmt(it.quantity)} {it.unit}</td>
                        <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{fmt(it.unit_price)}</td>
                        <td className="px-3 py-2 text-right font-medium text-gray-700 dark:text-gray-200">{fmt(it.quantity * it.unit_price)}</td>
                        <td className="px-3 py-2"><div className="flex items-center justify-end gap-1">
                          <button onClick={() => setMoveItem(it)} className="px-2 py-1 text-xs bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 rounded hover:bg-violet-100">Ruch</button>
                          <button onClick={() => setHistItem(it)} className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800">Historia</button>
                          <button onClick={() => { setEditItem(it); setShowItem(true) }} className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded">✏️</button>
                          <button onClick={() => del(it)} className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50">🗑</button>
                        </div></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <DocsTable docs={docs} onAssign={setAssignDoc} />
      )}

      {showItem && <ItemModal item={editItem} onClose={() => setShowItem(false)} onSaved={() => { setShowItem(false); load() }} />}
      {moveItem && <MoveModal item={moveItem} onClose={() => setMoveItem(null)} onSaved={() => { setMoveItem(null); load() }} />}
      {histItem && <HistoryModal item={histItem} onClose={() => setHistItem(null)} />}
      {docType && <DocBuilderModal type={docType} items={items} onClose={() => setDocType(null)} onSaved={() => { setDocType(null); load() }} />}
      {assignDoc && <AssignProjectModal doc={assignDoc} onClose={() => setAssignDoc(null)} onSaved={() => { setAssignDoc(null); load() }} />}
    </div>
  )
}

// ── Dokumenty: tabela ──
function DocsTable({ docs, onAssign }: { docs: WarehouseDoc[]; onAssign: (d: WarehouseDoc) => void }) {
  if (docs.length === 0) return <div className="text-center py-16 text-gray-400"><div className="text-4xl mb-3">📄</div><p className="text-sm">Brak dokumentów. Utwórz PZ (przyjęcie) lub WZ (wydanie).</p></div>
  return (
    <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-xl">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
          <tr><th className="text-left px-3 py-2 font-medium">Typ</th><th className="text-left px-3 py-2 font-medium">Numer</th><th className="text-left px-3 py-2 font-medium">Data</th><th className="text-left px-3 py-2 font-medium">Kontrahent</th><th className="text-right px-3 py-2 font-medium">Wartość</th><th className="text-left px-3 py-2 font-medium">Projekt</th><th className="text-right px-3 py-2 font-medium"></th></tr>
        </thead>
        <tbody>
          {docs.map(d => (
            <tr key={d.id} className="border-t border-gray-100 dark:border-gray-800">
              <td className="px-3 py-2"><span className={`text-xs font-semibold px-2 py-0.5 rounded ${d.type === 'WZ' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'}`}>{d.type}</span></td>
              <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{d.number}</td>
              <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{fmtDate(d.date)}</td>
              <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{d.contractor || '—'}</td>
              <td className="px-3 py-2 text-right font-medium text-gray-700 dark:text-gray-200">{fmt(d.total_net)} PLN</td>
              <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">{d.project_id ? '✓ przypisany' : '—'}</td>
              <td className="px-3 py-2 text-right">
                {d.type === 'WZ' && !d.project_id && (
                  <button onClick={() => onAssign(d)} className="px-2.5 py-1 text-xs font-medium bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 rounded hover:bg-violet-100">→ Do projektu (koszt)</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Wyszukiwarka katalogu/magazynu (dla pozycji i dokumentów) ──
function CatalogSearch({ warehouseItems, onlyWarehouse, onPick }: {
  warehouseItems: WarehouseItem[]; onlyWarehouse?: boolean; onPick: (l: WarehouseDocLineInput) => void
}) {
  const [catalog, setCatalog] = useState<ProductCatalogItem[]>([])
  const [query, setQuery] = useState('')
  useEffect(() => { if (!onlyWarehouse) productCatalogApi.listAll().then(setCatalog).catch(() => {}) }, [onlyWarehouse])

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!q) return []
    const wh = warehouseItems.filter(i => `${i.name} ${i.sku ?? ''}`.toLowerCase().includes(q))
      .map(i => ({ src: 'mag' as const, warehouse_item_id: i.id, name: i.name, sku: i.sku ?? '', unit: i.unit, unit_price: i.unit_price }))
    const cat = onlyWarehouse ? [] : catalog.filter(c => `${c.name} ${c.sku ?? ''}`.toLowerCase().includes(q))
      .map(c => ({ src: 'kat' as const, warehouse_item_id: null, name: c.name, sku: c.sku ?? '', unit: c.unit || 'szt.', unit_price: c.unit_price }))
    const seen = new Set(wh.map(w => (w.sku || w.name).toLowerCase()))
    return [...wh, ...cat.filter(c => !seen.has((c.sku || c.name).toLowerCase()))].slice(0, 30)
  }, [q, warehouseItems, catalog, onlyWarehouse])

  return (
    <div>
      <input className={inputCls} placeholder={onlyWarehouse ? 'Szukaj pozycji w magazynie…' : 'Szukaj w katalogu produktów / magazynie…'} value={query} onChange={e => setQuery(e.target.value)} />
      {results.length > 0 && (
        <div className="mt-1 border border-gray-200 dark:border-gray-700 rounded-lg max-h-56 overflow-y-auto bg-white dark:bg-gray-800">
          {results.map((r, i) => (
            <button key={i} type="button"
              onClick={() => { onPick({ warehouse_item_id: r.warehouse_item_id, name: r.name, sku: r.sku || null, quantity: 1, unit: r.unit, unit_price: r.unit_price }); setQuery('') }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-violet-50 dark:hover:bg-violet-950/30 border-b border-gray-50 dark:border-gray-800 last:border-0 flex items-center justify-between gap-2">
              <span className="truncate"><span className={`text-[10px] mr-1.5 px-1 py-0.5 rounded ${r.src === 'mag' ? 'bg-violet-100 text-violet-600' : 'bg-gray-100 text-gray-500'}`}>{r.src === 'mag' ? 'MAG' : 'KAT'}</span>{r.name}{r.sku ? ` · ${r.sku}` : ''}</span>
              <span className="text-xs text-gray-400 shrink-0">{fmt(r.unit_price)} PLN</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Dodaj / edytuj pozycję (z wyszukiwaniem w katalogu) ──
function ItemModal({ item, onClose, onSaved }: { item: WarehouseItem | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!item
  const [f, setF] = useState({
    name: item?.name ?? '', sku: item?.sku ?? '', unit: item?.unit ?? 'szt.',
    unit_price: String(item?.unit_price ?? ''), quantity: String(item?.quantity ?? '0'),
    min_quantity: String(item?.min_quantity ?? '0'), category: item?.category ?? '', location: item?.location ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }))

  const save = async () => {
    if (!f.name.trim()) { setErr('Nazwa jest wymagana'); return }
    setSaving(true); setErr('')
    try {
      const payload = { name: f.name.trim(), sku: f.sku.trim() || null, unit: f.unit.trim() || 'szt.', unit_price: parseFloat(f.unit_price) || 0, min_quantity: parseFloat(f.min_quantity) || 0, category: f.category.trim() || null, location: f.location.trim() || null }
      if (editing && item) await warehouseApi.update(item.id, payload)
      else await warehouseApi.create({ ...payload, quantity: parseFloat(f.quantity) || 0 })
      onSaved()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu.') } finally { setSaving(false) }
  }

  return (
    <Modal title={editing ? 'Edytuj pozycję' : 'Dodaj pozycję'} onClose={onClose} wide>
      <div className="space-y-4">
        {!editing && (
          <div><label className={lblCls}>Z katalogu produktów</label>
            <CatalogSearch warehouseItems={[]} onPick={l => setF(p => ({ ...p, name: l.name, sku: l.sku ?? '', unit: l.unit ?? 'szt.', unit_price: String(l.unit_price ?? '') }))} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><label className={lblCls}>Nazwa *</label><input className={inputCls} value={f.name} onChange={e => set('name', e.target.value)} /></div>
          <div><label className={lblCls}>SKU / Kod</label><input className={inputCls} value={f.sku} onChange={e => set('sku', e.target.value)} /></div>
          <div><label className={lblCls}>Jednostka</label><input className={inputCls} value={f.unit} onChange={e => set('unit', e.target.value)} /></div>
          <div><label className={lblCls}>Cena jedn. (PLN)</label><input type="number" min="0" step="0.01" className={inputCls} value={f.unit_price} onChange={e => set('unit_price', e.target.value)} /></div>
          {!editing && <div><label className={lblCls}>Stan początkowy</label><input type="number" min="0" step="0.01" className={inputCls} value={f.quantity} onChange={e => set('quantity', e.target.value)} /></div>}
          <div><label className={lblCls}>Stan minimalny</label><input type="number" min="0" step="0.01" className={inputCls} value={f.min_quantity} onChange={e => set('min_quantity', e.target.value)} /></div>
          <div><label className={lblCls}>Kategoria</label><input className={inputCls} value={f.category} onChange={e => set('category', e.target.value)} /></div>
          <div className={editing ? '' : 'col-span-2'}><label className={lblCls}>Lokalizacja</label><input className={inputCls} value={f.location} onChange={e => set('location', e.target.value)} /></div>
        </div>
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Zapisz'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Budowanie dokumentu WZ/PZ ──
function DocBuilderModal({ type, items, onClose, onSaved }: { type: 'WZ' | 'PZ'; items: WarehouseItem[]; onClose: () => void; onSaved: () => void }) {
  const [contractor, setContractor] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState<WarehouseDocLineInput[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const addLine = (l: WarehouseDocLineInput) => setLines(prev => {
    const i = prev.findIndex(x => (x.warehouse_item_id && x.warehouse_item_id === l.warehouse_item_id) || (!x.warehouse_item_id && x.name === l.name))
    if (i >= 0) { const c = [...prev]; c[i] = { ...c[i], quantity: (c[i].quantity || 0) + 1 }; return c }
    return [...prev, l]
  })
  const setLine = (i: number, patch: Partial<WarehouseDocLineInput>) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  const total = lines.reduce((s, l) => s + (l.quantity || 0) * (l.unit_price || 0), 0)

  const save = async () => {
    if (lines.length === 0) { setErr('Dodaj przynajmniej jedną pozycję'); return }
    setSaving(true); setErr('')
    try {
      await warehouseApi.docCreate({ type, date, contractor: contractor.trim() || undefined, lines: lines.map(l => ({ ...l, quantity: Number(l.quantity) || 0, unit_price: Number(l.unit_price) || 0 })) })
      onSaved()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu dokumentu.') } finally { setSaving(false) }
  }

  return (
    <Modal title={type === 'WZ' ? 'Nowy dokument WZ (wydanie)' : 'Nowy dokument PZ (przyjęcie)'} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div><label className={lblCls}>{type === 'WZ' ? 'Odbiorca' : 'Dostawca'}</label><input className={inputCls} value={contractor} onChange={e => setContractor(e.target.value)} placeholder="kontrahent" /></div>
          <div><label className={lblCls}>Data</label><input type="date" className={inputCls} value={date} onChange={e => setDate(e.target.value)} /></div>
        </div>
        <div><label className={lblCls}>Dodaj pozycję {type === 'WZ' ? '(z magazynu)' : '(z katalogu lub magazynu)'}</label>
          <CatalogSearch warehouseItems={items} onlyWarehouse={type === 'WZ'} onPick={addLine} />
        </div>
        {lines.length > 0 && (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400"><tr><th className="text-left px-2 py-1.5 font-medium">Pozycja</th><th className="px-2 py-1.5 font-medium w-20">Ilość</th><th className="px-2 py-1.5 font-medium w-24">Cena</th><th className="text-right px-2 py-1.5 font-medium w-24">Wartość</th><th className="w-8"></th></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-2 py-1.5 text-gray-800 dark:text-gray-100">{l.name}{l.sku ? <span className="text-gray-400 text-xs"> · {l.sku}</span> : ''}</td>
                    <td className="px-2 py-1.5"><input type="number" min="0" step="0.01" className="w-16 px-1.5 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-right" value={l.quantity} onChange={e => setLine(i, { quantity: parseFloat(e.target.value) || 0 })} /></td>
                    <td className="px-2 py-1.5"><input type="number" min="0" step="0.01" className="w-20 px-1.5 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-right" value={l.unit_price} onChange={e => setLine(i, { unit_price: parseFloat(e.target.value) || 0 })} /></td>
                    <td className="px-2 py-1.5 text-right text-gray-700 dark:text-gray-200">{fmt((l.quantity || 0) * (l.unit_price || 0))}</td>
                    <td className="px-2 py-1.5 text-center"><button onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400 hover:text-red-600 text-xs">✕</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-gray-200 dark:border-gray-700"><td colSpan={3} className="px-2 py-2 text-right font-medium text-gray-600 dark:text-gray-400">Razem netto</td><td className="px-2 py-2 text-right font-bold text-violet-700 dark:text-violet-300">{fmt(total)} PLN</td><td></td></tr></tfoot>
            </table>
          </div>
        )}
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : `Utwórz ${type}`}</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Przypisz WZ do projektu (koszt) ──
function AssignProjectModal({ doc, onClose, onSaved }: { doc: WarehouseDoc; onClose: () => void; onSaved: () => void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { projectsApi.list().then(p => setProjects(p.filter(x => x.status !== 'cancelled'))).catch(() => {}) }, [])

  const save = async () => {
    if (!projectId) { setErr('Wybierz projekt'); return }
    setSaving(true); setErr('')
    try { await warehouseApi.assignDoc(doc.id, projectId); alert(`WZ ${doc.number} dodany jako koszt projektu (${fmt(doc.total_net)} PLN).`); onSaved() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Nie udało się przypisać.') } finally { setSaving(false) }
  }

  return (
    <Modal title={`Przenieś WZ ${doc.number} do projektu`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">WZ zostanie zapisany jako koszt projektu (kategoria „WZ"): <strong>{fmt(doc.total_net)} PLN</strong>.</p>
        <div><label className={lblCls}>Projekt</label>
          <select className={inputCls} value={projectId} onChange={e => setProjectId(e.target.value)}>
            <option value="">— wybierz —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.client_name ? ` — ${p.client_name}` : ''}</option>)}
          </select>
        </div>
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving || !projectId} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Przenieś do projektu'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Przyjęcie / wydanie pojedynczej pozycji ──
function MoveModal({ item, onClose, onSaved }: { item: WarehouseItem; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<'in' | 'out'>('in')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [projectRef, setProjectRef] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    const qn = parseFloat(qty)
    if (!(qn > 0)) { setErr('Podaj ilość większą od zera'); return }
    setSaving(true); setErr('')
    try { await warehouseApi.move(item.id, { type, quantity: qn, reason: reason.trim() || undefined, project_ref: projectRef.trim() || undefined }); onSaved() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu ruchu.') } finally { setSaving(false) }
  }

  return (
    <Modal title={`Ruch — ${item.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">Stan bieżący: <strong>{fmt(item.quantity)} {item.unit}</strong></p>
        <div className="flex gap-2">
          <button onClick={() => setType('in')} className={`flex-1 py-2 text-sm font-medium rounded-lg border ${type === 'in' ? 'bg-green-600 text-white border-green-600' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>➕ Przyjmij</button>
          <button onClick={() => setType('out')} className={`flex-1 py-2 text-sm font-medium rounded-lg border ${type === 'out' ? 'bg-red-600 text-white border-red-600' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>➖ Wydaj</button>
        </div>
        <div><label className={lblCls}>Ilość ({item.unit}) *</label><input type="number" min="0" step="0.01" className={inputCls} value={qty} onChange={e => setQty(e.target.value)} autoFocus /></div>
        <div><label className={lblCls}>Powód / dokument</label><input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} placeholder="np. korekta, zwrot" /></div>
        {type === 'out' && <div><label className={lblCls}>Projekt (opcjonalnie)</label><input className={inputCls} value={projectRef} onChange={e => setProjectRef(e.target.value)} /></div>}
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Zapisz ruch'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Historia ruchów ──
function HistoryModal({ item, onClose }: { item: WarehouseItem; onClose: () => void }) {
  const [moves, setMoves] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { warehouseApi.movements(item.id).then(setMoves).catch(() => setMoves([])).finally(() => setLoading(false)) }, [item.id])
  return (
    <Modal title={`Historia — ${item.name}`} onClose={onClose} wide>
      {loading ? <div className="text-center py-8 text-gray-400">Ładowanie…</div>
        : moves.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">Brak ruchów.</div>
        : (
          <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
            {moves.map(m => (
              <div key={m.id} className="flex items-center justify-between gap-3 text-sm border-b border-gray-100 dark:border-gray-800 py-2">
                <span className="text-gray-700 dark:text-gray-200">{MOVE_LABEL[m.type] ?? m.type}</span>
                <span className={`font-semibold ${m.type === 'out' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{m.type === 'out' ? '−' : '+'}{fmt(m.quantity)} {item.unit}</span>
                <span className="text-xs text-gray-400 flex-1 truncate">{[m.reason, m.project_ref].filter(Boolean).join(' · ')}</span>
                <span className="text-xs text-gray-400">{fmtDate(m.created_at)}</span>
              </div>
            ))}
          </div>
        )}
    </Modal>
  )
}
