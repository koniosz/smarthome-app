import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { quotesApi } from '../api/client'
import type { AiQuote } from '../types'
import { QUOTE_STATUS_LABELS } from '../types'
import ProjectWizard from '../components/project-wizard/ProjectWizard'
import AIQuoteEditor from '../components/ai-quote/AIQuoteEditor'

function fmtInt(n: number) { return new Intl.NumberFormat('pl-PL').format(Math.round(n || 0)) }
function fmtDate(s: string) {
  const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function WycenaPage() {
  const navigate = useNavigate()
  const [quotes, setQuotes] = useState<AiQuote[]>([])
  const [loading, setLoading] = useState(true)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [selected, setSelected] = useState<AiQuote | null>(null)
  const [accepting, setAccepting] = useState<string | null>(null)

  const load = () => { setLoading(true); quotesApi.list().then(setQuotes).catch(() => setQuotes([])).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  const accept = async (q: AiQuote) => {
    if (!window.confirm(`Zaakceptować wycenę „${q.name || 'bez nazwy'}" i utworzyć z niej projekt?\nBudżet projektu = ${fmtInt(q.grand_total)} PLN.`)) return
    setAccepting(q.id)
    try {
      const project = await quotesApi.accept(q.id)
      navigate(`/projects/${project.id}`)
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Nie udało się utworzyć projektu z wyceny.')
    } finally { setAccepting(null) }
  }

  const del = async (q: AiQuote) => {
    if (!window.confirm(`Usunąć wycenę „${q.name || 'bez nazwy'}"?`)) return
    try { await quotesApi.delete(q.id); if (selected?.id === q.id) setSelected(null); load() }
    catch { alert('Nie udało się usunąć wyceny.') }
  }

  // ── Widok pojedynczej wyceny (edytor) ──
  if (selected) {
    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <button onClick={() => { setSelected(null); load() }}
            className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">← Wszystkie wyceny</button>
          <button onClick={() => accept(selected)} disabled={accepting === selected.id}
            className="px-4 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg transition-colors">
            {accepting === selected.id ? 'Tworzę projekt…' : '✅ Akceptuj → utwórz projekt'}
          </button>
        </div>
        <AIQuoteEditor
          projectId={null}
          quote={selected}
          onUpdated={q => setSelected(q)}
          onDeleted={() => { setSelected(null); load() }}
        />
      </div>
    )
  }

  // ── Lista wycen ──
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Wycena</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Samodzielne wyceny — po akceptacji klienta zamieniasz je w projekt</p>
        </div>
        <button onClick={() => setWizardOpen(true)}
          className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors">
          + Nowa wycena
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400">Ładowanie…</div>
      ) : quotes.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📝</div>
          <p className="text-sm">Brak wycen. Kliknij „Nowa wycena", aby utworzyć pierwszą.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {quotes.map(q => {
            const confirmed = q.status === 'confirmed'
            return (
              <div key={q.id}
                className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center gap-4 hover:border-violet-300 dark:hover:border-violet-700 transition-colors">
                <button onClick={() => setSelected(q)} className="flex-1 text-left min-w-0">
                  <div className="font-semibold text-gray-800 dark:text-gray-100 truncate">{q.name || 'Wycena bez nazwy'}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {q.client_name || 'Brak klienta'}{q.items?.length ? ` · ${q.items.length} poz.` : ''} · {fmtDate(q.created_at)}
                  </div>
                </button>
                <div className="text-right shrink-0">
                  <div className="font-bold text-violet-700 dark:text-violet-300">{fmtInt(q.grand_total)} PLN</div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${confirmed ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                    {QUOTE_STATUS_LABELS[q.status] ?? q.status}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => accept(q)} disabled={accepting === q.id}
                    title="Akceptuj i utwórz projekt"
                    className="px-3 py-1.5 text-xs font-medium bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 rounded-lg transition-colors disabled:opacity-50">
                    {accepting === q.id ? '…' : '✅ Akceptuj'}
                  </button>
                  <button onClick={() => del(q)} title="Usuń"
                    className="px-2.5 py-1.5 text-xs border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors">🗑</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {wizardOpen && (
        <ProjectWizard
          mode="quote"
          onClose={() => setWizardOpen(false)}
          onCreated={() => {}}
          onQuoteCreated={q => { setWizardOpen(false); load(); setSelected(q) }}
        />
      )}
    </div>
  )
}
