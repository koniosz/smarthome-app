import { useEffect, useRef, useState } from 'react'
import Modal from '../components/ui/Modal'
import { warehouseApi } from '../api/client'
import type { WarehouseItem, StockMovement } from '../api/client'
import { useAuth } from '../auth/AuthContext'

function fmt(n: number) { return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(n || 0) }
function fmtDate(s: string) { const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' }) }

const MOVE_LABEL: Record<string, string> = { in: '➕ Przyjęcie', out: '➖ Wydanie', initial: '📥 Stan początkowy', adjust: '✏️ Korekta' }
const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
const lblCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'

export default function MagazynPage() {
  const { user } = useAuth()
  const canSee = user?.role === 'admin' || !!user?.can_view_warehouse

  const [items, setItems] = useState<WarehouseItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showItem, setShowItem] = useState(false)
  const [editItem, setEditItem] = useState<WarehouseItem | null>(null)
  const [moveItem, setMoveItem] = useState<WarehouseItem | null>(null)
  const [histItem, setHistItem] = useState<WarehouseItem | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => { setLoading(true); warehouseApi.list().then(setItems).catch(() => setItems([])).finally(() => setLoading(false)) }
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
    try {
      const res = await warehouseApi.importExcel(file)
      alert(`Zaimportowano ${res.imported} pozycji.`)
      load()
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Błąd importu pliku.')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
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
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {items.length} pozycji · wartość {fmt(totalValue)} PLN{lowStock.length ? ` · ⚠️ ${lowStock.length} poniżej minimum` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f) }} />
          <button onClick={() => fileRef.current?.click()} disabled={importing}
            className="px-3 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50">
            {importing ? 'Importuję…' : '📊 Import Excel (stan pocz.)'}
          </button>
          <button onClick={() => { setEditItem(null); setShowItem(true) }}
            className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors">
            + Dodaj pozycję
          </button>
        </div>
      </div>

      <input className={`${inputCls} mb-4 max-w-md`} placeholder="Szukaj: nazwa, SKU, kategoria, lokalizacja…"
        value={search} onChange={e => setSearch(e.target.value)} />

      {loading ? (
        <div className="text-center py-16 text-gray-400">Ładowanie…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-sm">{items.length === 0 ? 'Magazyn jest pusty. Dodaj pozycję lub zaimportuj stan początkowy z Excela.' : 'Brak pozycji spełniających kryteria.'}</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Nazwa</th>
                <th className="text-left px-3 py-2 font-medium">SKU</th>
                <th className="text-left px-3 py-2 font-medium">Kat./Lok.</th>
                <th className="text-right px-3 py-2 font-medium">Stan</th>
                <th className="text-right px-3 py-2 font-medium">Cena</th>
                <th className="text-right px-3 py-2 font-medium">Wartość</th>
                <th className="text-right px-3 py-2 font-medium">Akcje</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(it => {
                const low = it.min_quantity > 0 && it.quantity <= it.min_quantity
                return (
                  <tr key={it.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{it.name}</td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{it.sku || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">{[it.category, it.location].filter(Boolean).join(' · ') || '—'}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${low ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>
                      {low && <span title={`min. ${fmt(it.min_quantity)}`}>⚠️ </span>}{fmt(it.quantity)} {it.unit}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{fmt(it.unit_price)}</td>
                    <td className="px-3 py-2 text-right font-medium text-gray-700 dark:text-gray-200">{fmt(it.quantity * it.unit_price)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setMoveItem(it)} className="px-2 py-1 text-xs bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 rounded hover:bg-violet-100">Ruch</button>
                        <button onClick={() => setHistItem(it)} className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800">Historia</button>
                        <button onClick={() => { setEditItem(it); setShowItem(true) }} className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800">✏️</button>
                        <button onClick={() => del(it)} className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-950/20">🗑</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showItem && <ItemModal item={editItem} onClose={() => setShowItem(false)} onSaved={() => { setShowItem(false); load() }} />}
      {moveItem && <MoveModal item={moveItem} onClose={() => setMoveItem(null)} onSaved={() => { setMoveItem(null); load() }} />}
      {histItem && <HistoryModal item={histItem} onClose={() => setHistItem(null)} />}
    </div>
  )
}

// ── Dodaj / edytuj pozycję ──
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
      const payload = {
        name: f.name.trim(), sku: f.sku.trim() || null, unit: f.unit.trim() || 'szt.',
        unit_price: parseFloat(f.unit_price) || 0, min_quantity: parseFloat(f.min_quantity) || 0,
        category: f.category.trim() || null, location: f.location.trim() || null,
      }
      if (editing && item) await warehouseApi.update(item.id, payload)
      else await warehouseApi.create({ ...payload, quantity: parseFloat(f.quantity) || 0 })
      onSaved()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu.') } finally { setSaving(false) }
  }

  return (
    <Modal title={editing ? 'Edytuj pozycję' : 'Dodaj pozycję'} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><label className={lblCls}>Nazwa *</label><input className={inputCls} value={f.name} onChange={e => set('name', e.target.value)} autoFocus /></div>
          <div><label className={lblCls}>SKU / Kod</label><input className={inputCls} value={f.sku} onChange={e => set('sku', e.target.value)} /></div>
          <div><label className={lblCls}>Jednostka</label><input className={inputCls} value={f.unit} onChange={e => set('unit', e.target.value)} placeholder="szt." /></div>
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

// ── Przyjęcie / wydanie ──
function MoveModal({ item, onClose, onSaved }: { item: WarehouseItem; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<'in' | 'out'>('in')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [projectRef, setProjectRef] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    const q = parseFloat(qty)
    if (!(q > 0)) { setErr('Podaj ilość większą od zera'); return }
    setSaving(true); setErr('')
    try {
      await warehouseApi.move(item.id, { type, quantity: q, reason: reason.trim() || undefined, project_ref: projectRef.trim() || undefined })
      onSaved()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu ruchu.') } finally { setSaving(false) }
  }

  return (
    <Modal title={`Ruch magazynowy — ${item.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">Stan bieżący: <strong>{fmt(item.quantity)} {item.unit}</strong></p>
        <div className="flex gap-2">
          <button onClick={() => setType('in')} className={`flex-1 py-2 text-sm font-medium rounded-lg border ${type === 'in' ? 'bg-green-600 text-white border-green-600' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>➕ Przyjmij</button>
          <button onClick={() => setType('out')} className={`flex-1 py-2 text-sm font-medium rounded-lg border ${type === 'out' ? 'bg-red-600 text-white border-red-600' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}>➖ Wydaj</button>
        </div>
        <div><label className={lblCls}>Ilość ({item.unit}) *</label><input type="number" min="0" step="0.01" className={inputCls} value={qty} onChange={e => setQty(e.target.value)} autoFocus /></div>
        <div><label className={lblCls}>Powód / dokument</label><input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} placeholder="np. PZ 12/2026, zwrot, korekta" /></div>
        {type === 'out' && <div><label className={lblCls}>Projekt (opcjonalnie)</label><input className={inputCls} value={projectRef} onChange={e => setProjectRef(e.target.value)} placeholder="np. Apartament Kowalski" /></div>}
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
                <span className={`font-semibold ${m.type === 'out' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                  {m.type === 'out' ? '−' : '+'}{fmt(m.quantity)} {item.unit}
                </span>
                <span className="text-xs text-gray-400 flex-1 truncate">{[m.reason, m.project_ref].filter(Boolean).join(' · ')}</span>
                <span className="text-xs text-gray-400">{fmtDate(m.created_at)}</span>
              </div>
            ))}
          </div>
        )}
    </Modal>
  )
}
