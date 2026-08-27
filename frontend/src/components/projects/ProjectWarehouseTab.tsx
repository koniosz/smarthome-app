import { useEffect, useMemo, useState } from 'react'
import { projectWarehouseApi } from '../../api/client'
import type { WarehouseDoc, ProjectWarehouseDoc, ProjectWarehousePickItem } from '../../api/client'

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'

function fmt(n: number) { return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0) }
function fmtDate(s?: string | null) {
  if (!s) return '—'
  const [y, m, d] = String(s).slice(0, 10).split('-')
  return d ? `${d}.${m}.${y}` : s
}

// Zakładka "Magazyn" w projekcie: lista pobrań (MM) i wydań (WZ) + pobranie towaru
// z magazynu przez KAŻDEGO pracownika (tworzy MM do magazynu "Projekty").
export default function ProjectWarehouseTab({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<ProjectWarehouseDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [pickOpen, setPickOpen] = useState(false)

  const load = () => projectWarehouseApi.docs(projectId).then(d => { setDocs(d); setLoading(false) }).catch(() => setLoading(false))
  useEffect(() => { load() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">Pobrania z magazynu</h3>
          <p className="text-xs text-gray-400">Lista towaru zabranego pod ten projekt (dokumenty MM → magazyn „Projekty"). Przy fakturze zmienią się w WZ.</p>
        </div>
        <button onClick={() => setPickOpen(true)}
          className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">
          📦 Pobierz z magazynu
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-gray-400 text-sm">Ładowanie…</div>
      ) : docs.length === 0 ? (
        <div className="py-10 text-center text-gray-400 text-sm">
          Brak pobrań. Kliknij „📦 Pobierz z magazynu" i zrób listę tego, co zabierasz na projekt.
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map(d => (
            <div key={d.id} className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-900">
              <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 flex-wrap">
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${d.type === 'MM' ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}>{d.type}</span>
                <span className="text-sm font-bold text-gray-800 dark:text-gray-100">{d.number}</span>
                <span className="text-xs text-gray-400">{fmtDate(d.date)}</span>
                <div className="flex-1" />
                <span className="text-sm font-bold text-gray-800 dark:text-gray-100 tabular-nums">{fmt(d.total_net)} PLN <span className="text-xs font-normal text-gray-400">netto</span></span>
              </div>
              {d.lines.map(l => (
                <div key={l.id} className="flex items-center gap-3 px-4 py-1.5 text-sm border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                  <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-200">{l.name}{l.sku ? <span className="text-gray-400 text-xs"> · {l.sku}</span> : ''}</span>
                  <span className="text-xs text-gray-400 whitespace-nowrap tabular-nums">{fmt(l.quantity || 0)} {l.unit} × {fmt(l.unit_price || 0)}</span>
                  {l.invoiced && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 whitespace-nowrap">
                      ✓ faktura {l.invoiced.number ?? '(szkic)'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {pickOpen && <PickModal projectId={projectId} onClose={(saved) => { setPickOpen(false); if (saved) load() }} />}
    </div>
  )
}

// ── Modal pobrania: szukaj w magazynie, ustaw ilości, zapisz (MM) ─────────────
function PickModal({ projectId, onClose }: { projectId: string; onClose: (saved: boolean) => void }) {
  const [items, setItems] = useState<ProjectWarehousePickItem[]>([])
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Map<string, number>>(new Map())
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { projectWarehouseApi.items(projectId).then(setItems).catch(() => {}) }, [projectId])

  const q = query.trim().toLowerCase()
  const results = useMemo(() =>
    q ? items.filter(i => `${i.name} ${i.sku ?? ''}`.toLowerCase().includes(q)).slice(0, 20) : [],
  [q, items])

  const pickedList = [...picked.entries()]
    .map(([id, qty]) => ({ item: items.find(i => i.id === id)!, qty }))
    .filter(p => p.item)

  const setQty = (id: string, qty: number) => setPicked(prev => {
    const next = new Map(prev)
    if (qty <= 0) next.delete(id); else next.set(id, qty)
    return next
  })

  const save = async () => {
    if (pickedList.length === 0) { setErr('Dodaj przynajmniej jedną pozycję.'); return }
    for (const p of pickedList) {
      if (p.qty > p.item.available) { setErr(`„${p.item.name}": dostępne tylko ${p.item.available} ${p.item.unit}.`); return }
    }
    setSaving(true); setErr('')
    try {
      await projectWarehouseApi.pick(projectId, pickedList.map(p => ({ warehouse_item_id: p.item.id, quantity: p.qty })))
      onClose(true)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Nie udało się zapisać pobrania.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && onClose(false)}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900 z-10">
          <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">Pobierz z magazynu</h2>
          <p className="text-xs text-gray-400">Lista tego, co zabierasz pod projekt — powstanie dokument MM do magazynu „Projekty".</p>
        </div>
        <div className="p-6 space-y-4">
          <input className={inputCls} placeholder="Szukaj towaru w magazynie…" value={query} onChange={e => setQuery(e.target.value)} autoFocus />
          {results.length > 0 && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg max-h-48 overflow-y-auto">
              {results.map(i => (
                <button key={i.id} type="button"
                  onClick={() => { setQty(i.id, (picked.get(i.id) || 0) + 1); setQuery('') }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-violet-50 dark:hover:bg-violet-950/30 border-b border-gray-50 dark:border-gray-800 last:border-0 flex items-center justify-between gap-2">
                  <span className="truncate">{i.name}{i.sku ? <span className="text-gray-400 text-xs"> · {i.sku}</span> : ''}</span>
                  <span className="text-xs text-gray-400 shrink-0">{i.warehouse_name} · dost. {fmt(i.available)} {i.unit}</span>
                </button>
              ))}
            </div>
          )}

          {pickedList.length > 0 && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
                  <tr><th className="text-left px-3 py-1.5 font-medium">Pozycja</th><th className="px-2 py-1.5 font-medium w-24">Ilość</th><th className="px-2 py-1.5 font-medium w-28 text-right">Dostępne</th><th className="w-8"></th></tr>
                </thead>
                <tbody>
                  {pickedList.map(({ item, qty }) => (
                    <tr key={item.id} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-3 py-1.5 text-gray-800 dark:text-gray-100">{item.name}</td>
                      <td className="px-2 py-1.5">
                        <input type="number" min="0" step="0.01" className="w-20 px-1.5 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-right"
                          value={qty} onChange={e => setQty(item.id, parseFloat(e.target.value) || 0)} />
                      </td>
                      <td className={`px-2 py-1.5 text-right text-xs ${qty > item.available ? 'text-red-500 font-bold' : 'text-gray-400'}`}>{fmt(item.available)} {item.unit}</td>
                      <td className="px-2 py-1.5 text-center"><button onClick={() => setQty(item.id, 0)} className="text-red-400 hover:text-red-600 text-xs">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" onClick={() => document.querySelector<HTMLInputElement>('input[placeholder="Szukaj towaru w magazynie…"]')?.focus()}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 text-sm font-semibold text-gray-500 dark:text-gray-400 hover:border-violet-400 hover:text-violet-600">
            ＋ {pickedList.length === 0 ? 'Dodaj pozycję — zacznij pisać w wyszukiwarce' : 'Dodaj kolejną pozycję'}
          </button>

          {err && <div className="text-sm text-red-500">{err}</div>}
          <div className="flex justify-end gap-3">
            <button onClick={() => onClose(false)} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
            <button onClick={save} disabled={saving}
              className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">
              {saving ? 'Zapisywanie…' : 'Zapisz pobranie (MM)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
