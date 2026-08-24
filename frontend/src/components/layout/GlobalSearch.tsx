import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, CornerDownLeft } from 'lucide-react'
import { api } from '../../api/client'
import { useAuth } from '../../auth/AuthContext'

interface SearchItem { id: string; title: string; subtitle: string }
interface SearchGroup { type: string; label: string; items: SearchItem[] }

const GROUP_ICON: Record<string, string> = {
  projects: '📁', products: '📦', invoices: '📄', sales_invoices: '🧾',
  warehouse: '🏬', employees: '👥', tasks: '🗓', todos: '🔒',
}

// Trasa docelowa po wybraniu wyniku (projekty mają widok szczegółów, reszta → moduł)
function routeFor(type: string, item: SearchItem, isAdmin: boolean): string {
  switch (type) {
    case 'projects': return `/projects/${item.id}`
    case 'products': return '/product-catalog'
    case 'invoices': return isAdmin ? '/ksef' : '/faktury'
    case 'sales_invoices': return '/ksef'
    case 'warehouse': return '/magazyn'
    case 'employees': return '/employees'
    default: return '/'
  }
}

export default function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [q, setQ] = useState('')
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const reqSeq = useRef(0)

  // płaska lista do nawigacji klawiaturą
  const flat: Array<{ group: SearchGroup; item: SearchItem }> = []
  for (const g of groups) for (const it of g.items) flat.push({ group: g, item: it })

  useEffect(() => {
    if (open) { setQ(''); setGroups([]); setSel(0); setTimeout(() => inputRef.current?.focus(), 30) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const query = q.trim()
    if (query.length < 2) { setGroups([]); setLoading(false); return }
    setLoading(true)
    const seq = ++reqSeq.current
    const t = setTimeout(() => {
      api.get('/search', { params: { q: query } })
        .then(r => { if (seq === reqSeq.current) { setGroups(r.data.groups ?? []); setSel(0) } })
        .catch(() => { if (seq === reqSeq.current) setGroups([]) })
        .finally(() => { if (seq === reqSeq.current) setLoading(false) })
    }, 250)
    return () => clearTimeout(t)
  }, [q, open])

  const pick = useCallback((entry: { group: SearchGroup; item: SearchItem } | undefined) => {
    if (!entry) return
    onClose()
    navigate(routeFor(entry.group.type, entry.item, user?.role === 'admin'))
  }, [navigate, onClose, user?.role])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, flat.length - 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
      else if (e.key === 'Enter') { e.preventDefault(); pick(flat[sel]) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, flat.length, sel, pick]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  let idx = -1
  return (
    <div className="fixed inset-0 z-[100] bg-black/40 flex items-start justify-center pt-[12vh] px-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800">
          <Search size={17} className="text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Szukaj: klienci, projekty, produkty, faktury, pracownicy…"
            className="flex-1 text-[15px] bg-transparent outline-none text-gray-800 dark:text-gray-100 placeholder-gray-400"
          />
          <kbd className="text-[10px] font-bold text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {q.trim().length < 2 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">Wpisz min. 2 znaki — szukam po wszystkich modułach, do których masz dostęp.</div>
          ) : loading && groups.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">Szukam…</div>
          ) : groups.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">Brak wyników dla „{q.trim()}".</div>
          ) : (
            groups.map(g => (
              <div key={g.type}>
                <div className="px-4 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wide text-gray-400">
                  {GROUP_ICON[g.type] ?? ''} {g.label}
                </div>
                {g.items.map(item => {
                  idx++
                  const active = idx === sel
                  const myIdx = idx
                  return (
                    <button
                      key={`${g.type}:${item.id}`}
                      onClick={() => pick({ group: g, item })}
                      onMouseEnter={() => setSel(myIdx)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${active ? 'bg-violet-50 dark:bg-violet-950/40' : ''}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-semibold truncate ${active ? 'text-violet-800 dark:text-violet-200' : 'text-gray-800 dark:text-gray-100'}`}>{item.title}</div>
                        {item.subtitle && <div className="text-xs text-gray-400 truncate">{item.subtitle}</div>}
                      </div>
                      {active && <CornerDownLeft size={14} className="text-violet-400 flex-shrink-0" />}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 dark:border-gray-800 text-[11px] text-gray-400">
          <span><kbd className="font-bold">↑↓</kbd> nawigacja</span>
          <span><kbd className="font-bold">Enter</kbd> otwórz</span>
          <span className="ml-auto">wyniki wg Twoich uprawnień</span>
        </div>
      </div>
    </div>
  )
}
