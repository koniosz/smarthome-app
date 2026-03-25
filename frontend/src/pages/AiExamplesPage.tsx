import { useState, useEffect } from 'react'
import { api } from '../api/client'

interface AiQuoteExample {
  id: string
  title: string
  project_type: string
  brands: string[]
  area_m2: number | null
  rooms_count: number | null
  final_items: any[]
  final_total_net: number | null
  human_notes: string | null
  approved_by_name: string | null
  created_at: string
}

const PROJECT_TYPE_LABELS: Record<string, string> = {
  residential: 'Dom jednorodzinny',
  apartment: 'Apartament / mieszkanie',
  commercial: 'Biuro / komercyjny',
  other: 'Inny',
}

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

export default function AiExamplesPage() {
  const [examples, setExamples] = useState<AiQuoteExample[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    api.get('/api/ai-quote-examples')
      .then(r => setExamples(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Usunąć wzorzec "${title}"?\n\nClaude przestanie go używać przy nowych wycenach.`)) return
    setDeleting(id)
    try {
      await api.delete(`/api/ai-quote-examples/${id}`)
      setExamples(prev => prev.filter(e => e.id !== id))
    } catch {
      alert('Błąd usuwania. Spróbuj ponownie.')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            🧠 Wzorce AI
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Zatwierdzone wyceny używane jako przykłady przy generowaniu nowych ofert AI.
            Claude uczy się z nich doboru urządzeń i zakresu instalacji.
          </p>
        </div>
        <div className="text-right">
          <span className="text-2xl font-bold text-violet-600 dark:text-violet-400">{examples.length}</span>
          <p className="text-xs text-gray-500">wzorców</p>
        </div>
      </div>

      {/* Info box */}
      <div className="bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-xl p-4 text-sm text-violet-800 dark:text-violet-300 flex gap-3">
        <span className="text-lg flex-shrink-0">💡</span>
        <div>
          <strong>Jak to działa?</strong> Przy każdej nowej wycenie AI, Claude automatycznie dostaje
          do 3 ostatnich wzorców jako przykłady. Im więcej wzorców, tym lepiej Claude rozumie specyfikę
          Twojej firmy — dobór urządzeń, zakres instalacji, typowe konfiguracje.
          <br/>
          <strong>Aby dodać wzorzec</strong> — otwórz gotową wycenę AI i kliknij przycisk <span className="font-mono bg-violet-100 dark:bg-violet-900 px-1 rounded">🧠 Wzorzec AI</span>.
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-violet-600 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Empty state */}
      {!loading && examples.length === 0 && (
        <div className="text-center py-16 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700">
          <div className="text-5xl mb-3">🧠</div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">Brak wzorców</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            Otwórz dowolną wycenę AI, popraw ją ręcznie jeśli trzeba,
            a następnie kliknij <strong>"🧠 Wzorzec AI"</strong> aby zapisać ją jako przykład dla Claude.
          </p>
        </div>
      )}

      {/* Examples list */}
      {!loading && examples.length > 0 && (
        <div className="space-y-3">
          {examples.map((ex, idx) => (
            <div key={ex.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              {/* Header row */}
              <div className="flex items-center gap-3 p-4">
                <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center text-violet-600 dark:text-violet-400 font-bold text-sm flex-shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-gray-900 dark:text-white text-sm">{ex.title}</h3>
                    <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded-full">
                      {PROJECT_TYPE_LABELS[ex.project_type] || ex.project_type}
                    </span>
                    {ex.area_m2 && (
                      <span className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full">
                        {ex.area_m2} m²
                      </span>
                    )}
                    {ex.brands && ex.brands.slice(0, 4).map((b: string) => (
                      <span key={b} className="text-xs bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400 px-2 py-0.5 rounded-full">
                        {b}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
                    <span>{ex.final_items?.length || 0} pozycji</span>
                    {ex.final_total_net && <span>{fmt(ex.final_total_net)} PLN netto</span>}
                    {ex.rooms_count && <span>{ex.rooms_count} pomieszczeń</span>}
                    <span>{new Date(ex.created_at).toLocaleDateString('pl-PL')}</span>
                    {ex.approved_by_name && <span>przez {ex.approved_by_name}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => setExpanded(expanded === ex.id ? null : ex.id)}
                    className="text-xs text-violet-600 dark:text-violet-400 hover:underline"
                  >
                    {expanded === ex.id ? 'Zwiń' : 'Podgląd'}
                  </button>
                  <button
                    onClick={() => handleDelete(ex.id, ex.title)}
                    disabled={deleting === ex.id}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors disabled:opacity-50"
                    title="Usuń wzorzec"
                  >
                    🗑
                  </button>
                </div>
              </div>

              {/* Human notes */}
              {ex.human_notes && (
                <div className="px-4 pb-3">
                  <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300">
                    <strong>Uwagi autora:</strong> {ex.human_notes}
                  </div>
                </div>
              )}

              {/* Expanded items */}
              {expanded === ex.id && ex.final_items && ex.final_items.length > 0 && (
                <div className="border-t border-gray-100 dark:border-gray-800">
                  <div className="p-3 max-h-72 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-400 dark:text-gray-500 text-left">
                          <th className="pb-1 pr-3">Pomieszczenie</th>
                          <th className="pb-1 pr-3">Nazwa</th>
                          <th className="pb-1 pr-3 text-right">Qty</th>
                          <th className="pb-1 text-right">Cena jedn.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {ex.final_items.map((item: any, i: number) => (
                          <tr key={i} className="text-gray-700 dark:text-gray-300">
                            <td className="py-1 pr-3 text-gray-400 dark:text-gray-500 truncate max-w-[100px]">{item.room}</td>
                            <td className="py-1 pr-3 truncate max-w-[260px]" title={item.name}>{item.name}</td>
                            <td className="py-1 pr-3 text-right">{item.qty}</td>
                            <td className="py-1 text-right font-mono">{fmt(item.unit_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
