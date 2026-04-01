import { useEffect, useState, useCallback } from 'react'
import { ksefApi, projectsApi } from '../api/client'
import type { KsefInvoice, Project } from '../types'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

interface InvoiceLineItem { nr: string; name: string; unit: string; qty: string; unitPrice: string; netValue: string; vatRate: string }

function parseXml(xml: string): { fields: Record<string, string>; items: InvoiceLineItem[] } {
  const get = (tag: string, scope?: string) => {
    const src = scope ?? xml
    const m = src.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'))
    return m ? m[1].trim() : ''
  }
  const itemBlocks = [...xml.matchAll(/<FaWiersz>([\s\S]*?)<\/FaWiersz>/gi)]
  const items: InvoiceLineItem[] = itemBlocks.map(m => ({
    nr: get('NrWierszaFa', m[1]), name: get('P_7', m[1]), unit: get('P_8A', m[1]),
    qty: get('P_8B', m[1]), unitPrice: get('P_9A', m[1]), netValue: get('P_11', m[1]), vatRate: get('P_12', m[1]),
  })).filter(i => i.name)
  const fields = {
    'Nr faktury': get('P_2'), 'Data': get('P_1'), 'Sprzedawca': get('Nazwa'),
    'Netto': get('P_15'), 'VAT': get('P_16'), 'Brutto': get('P_17'),
  }
  return { fields, items }
}

function InvoiceCard({ invoice, projects, onUpdated }: {
  invoice: KsefInvoice
  projects: Project[]
  onUpdated: (inv: KsefInvoice) => void
}) {
  const [expanded, setExpanded]   = useState(false)
  const [xml, setXml]             = useState<string | null>(null)
  const [loadingXml, setLoadingXml] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [projectId, setProjectId] = useState(invoice.project_id ?? '')
  const [notes, setNotes]         = useState(invoice.notes ?? '')
  const [saving, setSaving]       = useState(false)

  const loadXml = async () => {
    if (xml) { setExpanded(e => !e); return }
    setLoadingXml(true)
    try {
      const data = await ksefApi.getSharedXml(invoice.id)
      setXml(data)
      setExpanded(true)
    } catch (e) { /* ignore */ } finally { setLoadingXml(false) }
  }

  const handleAssign = async () => {
    setSaving(true)
    try {
      const updated = await ksefApi.assignShared(invoice.id, projectId || null, notes)
      onUpdated(updated)
      setAssigning(false)
    } finally { setSaving(false) }
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
            onClick={() => setAssigning(a => !a)}
            className="px-2.5 py-1 text-xs font-medium text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/20 rounded-lg transition-colors"
          >
            {invoice.project ? 'Zmień projekt' : 'Przypisz'}
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

      {/* Assign panel */}
      {assigning && (
        <div className="px-4 pb-4 border-t border-gray-50 dark:border-gray-800 pt-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Projekt</label>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
            >
              <option value="">— Nieprzypisana —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.client_name})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notatka</label>
            <input type="text" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={notes} onChange={e => setNotes(e.target.value)} placeholder="np. materiały do salonu" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setAssigning(false)} className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
            <button onClick={handleAssign} disabled={saving} className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisuję…' : 'Zapisz'}</button>
          </div>
        </div>
      )}

      {/* Line items */}
      {expanded && xml && (
        <div className="border-t border-gray-100 dark:border-gray-800 p-4">
          {items.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="text-left px-3 py-2">Nazwa towaru/usługi</th>
                    <th className="text-right px-3 py-2">Ilość</th>
                    <th className="text-left px-3 py-2">J.m.</th>
                    <th className="text-right px-3 py-2">Cena netto</th>
                    <th className="text-right px-3 py-2">Wartość netto</th>
                    <th className="text-right px-3 py-2">VAT%</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={i} className="border-t border-gray-50 dark:border-gray-800">
                      <td className="px-3 py-2 text-gray-800 dark:text-gray-100 font-medium">{item.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.qty}</td>
                      <td className="px-3 py-2 text-gray-500">{item.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.unitPrice}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{item.netValue}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{item.vatRate}%</td>
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
  const [projects, setProjects] = useState<Project[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const LIMIT = 20

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, projs] = await Promise.all([
        ksefApi.sharedInvoices({ search: search || undefined, page, limit: LIMIT }),
        projectsApi.list(),
      ])
      setInvoices(res.invoices)
      setTotal(res.total)
      setProjects(projs)
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
              projects={projects}
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
