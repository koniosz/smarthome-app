import { useState } from 'react'
import type { AiQuote } from '../../types'
import { QUOTE_STATUS_LABELS } from '../../types'
import AIQuoteUpload from './AIQuoteUpload'
import AIQuoteEditor from './AIQuoteEditor'

interface AIQuoteTabProps {
  projectId: string
  quotes: AiQuote[]
  onQuotesChanged: (quotes: AiQuote[]) => void
}

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

export default function AIQuoteTab({ projectId, quotes, onQuotesChanged }: AIQuoteTabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(quotes[0]?.id ?? null)
  const [showUpload, setShowUpload] = useState(false)

  const selected = quotes.find(q => q.id === selectedId) ?? null

  const handleCreated = (quote: AiQuote) => {
    const updated = [quote, ...quotes]
    onQuotesChanged(updated)
    setSelectedId(quote.id)
    setShowUpload(false)
  }

  const handleUpdated = (quote: AiQuote) => {
    onQuotesChanged(quotes.map(q => q.id === quote.id ? quote : q))
  }

  const handleDeleted = (quoteId: string) => {
    const remaining = quotes.filter(q => q.id !== quoteId)
    onQuotesChanged(remaining)
    setSelectedId(remaining[0]?.id ?? null)
    if (remaining.length === 0) setShowUpload(false)
  }

  // No quotes yet
  if (quotes.length === 0 && !showUpload) {
    return (
      <div className="text-center py-12">
        <div className="text-5xl mb-4">🤖</div>
        <h3 className="text-base font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Wycena AI
        </h3>
        <p className="text-sm text-gray-400 mb-6 max-w-sm mx-auto">
          Wgraj rzut mieszkania lub domu w formacie PDF, JPG lub PNG.
          AI wykryje pomieszczenia i zaproponuje komponenty KNX, Control4, Hikvision i Satel.
        </p>
        <AIQuoteUpload projectId={projectId} onCreated={handleCreated} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          🤖 Wyceny AI ({quotes.length})
        </h3>
        <button
          onClick={() => setShowUpload(s => !s)}
          className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
        >
          {showUpload ? '✕ Anuluj' : '➕ Nowa analiza'}
        </button>
      </div>

      {/* Upload panel (collapsible) */}
      {showUpload && (
        <div className="bg-gray-50 dark:bg-gray-800/40 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-4">
          <AIQuoteUpload projectId={projectId} onCreated={handleCreated} compact />
        </div>
      )}

      {/* Version list + editor split */}
      {quotes.length > 0 && (
        <div className="flex gap-4 items-start">
          {/* Version sidebar */}
          <div className="w-48 flex-shrink-0 space-y-1.5">
            {quotes.map(q => (
              <button
                key={q.id}
                onClick={() => { setSelectedId(q.id); setShowUpload(false) }}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors text-xs ${
                  selectedId === q.id
                    ? 'bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300'
                    : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-200 dark:hover:border-violet-800'
                }`}
              >
                <div className="font-medium truncate">
                  {QUOTE_STATUS_LABELS[q.status]}
                </div>
                <div className="text-gray-400 text-xs mt-0.5">
                  {new Date(q.created_at).toLocaleDateString('pl-PL')}
                </div>
                <div className="font-semibold text-gray-700 dark:text-gray-300 mt-0.5">
                  {fmt(q.total_net)} PLN
                </div>
                {q.rooms_detected && q.rooms_detected.length > 0 && (
                  <div className="text-gray-400 mt-0.5 text-xs truncate">
                    {q.rooms_detected.slice(0, 3).join(', ')}
                    {q.rooms_detected.length > 3 && ` +${q.rooms_detected.length - 3}`}
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Editor */}
          <div className="flex-1 min-w-0">
            {selected ? (
              <AIQuoteEditor
                projectId={projectId}
                quote={selected}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
              />
            ) : (
              <div className="text-center py-12 text-gray-400 text-sm">
                Wybierz wycenę z listy
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
