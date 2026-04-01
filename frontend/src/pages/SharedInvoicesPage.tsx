import { useEffect, useState, useCallback } from 'react'
import { ksefApi } from '../api/client'
import type { KsefInvoice } from '../types'
import AllocationPanel from '../components/ksef/AllocationPanel'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

interface InvoiceLineItem { nr: string; name: string; unit: string; qty: string; unitPrice: string; netValue: string; vatRate: string }

function parseXml(xml: string): { fields: Record<string, string>; items: InvoiceLineItem[] } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')

  const el = (tag: string, parent: Element | Document = doc): string => {
    const hits = parent.getElementsByTagNameNS('*', tag)
    if (hits.length > 0) return hits[0].textContent?.trim() ?? ''
    const hits2 = parent.getElementsByTagName(tag)
    return hits2.length > 0 ? hits2[0].textContent?.trim() ?? '' : ''
  }
  const elFirst = (tags: string[], parent: Element | Document = doc): string => {
    for (const tag of tags) { const v = el(tag, parent); if (v) return v }
    return ''
  }

  const rowsNS = doc.getElementsByTagNameNS('*', 'FaWiersz')
  const rows   = rowsNS.length > 0 ? rowsNS : doc.getElementsByTagName('FaWiersz')
  const items: InvoiceLineItem[] = Array.from(rows).map(row => ({
    nr:        elFirst(['NrWierszaFa', 'NrWiersza'], row),
    name:      el('P_7',  row),
    unit:      el('P_8A', row),
    qty:       el('P_8B', row),
    unitPrice: elFirst(['P_9A', 'P_9B'], row),
    netValue:  elFirst(['P_11', 'P_11A'], row),
    vatRate:   el('P_12', row),
  })).filter(i => i.name)

  const fields = {
    'Nr faktury': el('P_2'), 'Data': el('P_1'), 'Sprzedawca': elFirst(['Nazwa']),
    'Netto': el('P_15'), 'VAT': el('P_16'), 'Brutto': el('P_17'),
  }
  return { fields, items }
}

function InvoiceCard({ invoice, onUpdated }: {
  invoice: KsefInvoice
  onUpdated: (inv: KsefInvoice) => void
}) {
  const [expanded, setExpanded]       = useState(false)
  const [xml, setXml]                 = useState<string | null>(null)
  const [loadingXml, setLoadingXml]   = useState(false)
  const [showAllocations, setShowAllocations] = useState(false)

  const loadXml = async () => {
    if (xml) { setExpanded(e => !e); return }
    setLoadingXml(true)
    try {
      const data = await ksefApi.getSharedXml(invoice.id)
      setXml(data)
      setExpanded(true)
    } catch (e) { /* ignore */ } finally { setLoadingXml(false) }
  }

  const { fields, items } = xml ? parseXml(xml) : { fields: {}, items: [] }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Header row */}
      <div className="flex items-start justify-between p-4 gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-800 dark:text-gray-100 text-sm">{invoice.seller_name || '—'}</span>
            <span className="text-xs text-gray-400">{invoice.seller_nip}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap text-xs text-gray-500 dark:text-gray-400">
            <span>Nr: {invoice.invoice_number || '—'}</span>
            <span>Data: {invoice.invoice_date || '—'}</span>
            <span className="font-semibold text-gray-800 dark:text-gray-100 text-sm">{fmt(invoice.gross_amount)} {invoice.currency}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {invoice.project ? (
            <span className="text-xs px-2 py-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded-full">✓ {invoice.project.name}</span>
          ) : (
            <span className="text-xs px-2 py-1 bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400 rounded-full">Nieprzypisana</span>
          )}
          <button
            onClick={() => setShowAllocations(v => !v)}
            className={`px-2.5 py-1 text-xs font-medium border rounded-lg transition-colors ${showAllocations
              ? 'bg-violet-600 border-violet-600 text-white'
              : 'text-violet-600 dark:text-violet-400 border-violet-200 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/20'}`}
          >
            {showAllocations ? '▲ Alokacje' : '▼ Alokacje'}
          </button>
          <button
            onClick={loadXml}
            disabled={loadingXml}
            className="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            {loadingXml ? '…' : expanded ? '▲ Zwiń' : '▼ Pozycje'}
          </button>
        </div>
      </div>

      {/* Allocation panel */}
      {showAllocations && (
        <div className="px-4 pb-4 border-t border-violet-100 dark:border-violet-900/30 pt-3 bg-violet-50/30 dark:bg-violet-950/10">
          <AllocationPanel invoice={invoice} />
        </div>
      )}

      {/* Line items */}
      {expanded && xml && (
        <div className="border-t border-gray-100 dark:border-gray-800 p-4">
          {items.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-850">
              <table className="w-full text-xs text-gray-800 dark:text-gray-100">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-300">
                    <th className="text-left px-3 py-2 font-semibold">Nazwa towaru/usługi</th>
                    <th className="text-right px-3 py-2 font-semibold">Ilość</th>
                    <th className="text-left px-3 py-2 font-semibold">J.m.</th>
                    <th className="text-right px-3 py-2 font-semibold">Cena netto</th>
                    <th className="text-right px-3 py-2 font-semibold">Wartość netto</th>
                    <th className="text-right px-3 py-2 font-semibold">VAT%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {items.map((item, i) => (
                    <tr key={i} className="bg-white dark:bg-gray-800">
                      <td className="px-3 py-2 font-medium">{item.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.qty}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{item.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.unitPrice}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{item.netValue}</td>
                      <td className="px-3 py-2 text-right text-gray-500 dark:text-gray-400">{item.vatRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-xs text-gray-400 text-center py-4">Brak pozycji w XML lub nieznany format</div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SharedInvoicesPage() {
  const [invoices, setInvoices] = useState<KsefInvoice[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const LIMIT = 20

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await ksefApi.sharedInvoices({ search: search || undefined, page, limit: LIMIT })
      setInvoices(res.invoices)
      setTotal(res.total)
    } finally { setLoading(false) }
  }, [search, page])

  useEffect(() => { load() }, [load])

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">📄 Faktury do przypisania</h1>
        <p className="text-xs text-gray-400 mt-0.5">Faktury udostępnione przez administratora — przypisz do projektu</p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Szukaj (sprzedawca, nr faktury…)"
          className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
        />
        <span className="text-xs text-gray-400 whitespace-nowrap">{total} faktur</span>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Ładowanie…</div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📄</div>
          <div className="text-sm font-medium">Brak udostępnionych faktur</div>
          <div className="text-xs mt-1">Administrator musi najpierw udostępnić faktury</div>
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map(inv => (
            <InvoiceCard
              key={inv.id}
              invoice={inv}
              onUpdated={updated => setInvoices(prev => prev.map(i => i.id === updated.id ? updated : i))}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800">← Poprzednia</button>
          <span className="text-sm text-gray-500">Strona {page} z {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800">Następna →</button>
        </div>
      )}
    </div>
  )
}
