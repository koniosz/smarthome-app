import { useEffect, useState, useCallback } from 'react'
import { ksefApi, projectsApi } from '../api/client'
import type { KsefInvoice, KsefStatus, Project } from '../types'
import AllocationPanel from '../components/ksef/AllocationPanel'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function StatusBar({ status, onSync, syncing, dateFrom, onDateFromChange }: {
  status: KsefStatus | null
  onSync: () => void
  syncing: boolean
  dateFrom: string
  onDateFromChange: (v: string) => void
}) {
  if (!status) return null
  const lastSync = status.last_sync_at
    ? new Date(status.last_sync_at).toLocaleString('pl-PL')
    : 'Nigdy'

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <span className={`w-2.5 h-2.5 rounded-full ${status.configured ? 'bg-green-500' : 'bg-red-400'}`} />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          KSeF {status.env?.includes('prod') ? 'Produkcja' : 'Test'} 2.0
        </span>
        {status.nip && <span className="text-xs text-gray-400">NIP: {status.nip}</span>}
      </div>

      <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400 ml-auto">
        <span>📄 {status.invoice_count} faktur</span>
        <span className="text-orange-500 font-medium">⏳ {status.unassigned_count} nieprzypisanych</span>
        <span>Ostatnia sync: {lastSync}</span>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">Od:</label>
        <input
          type="date"
          value={dateFrom}
          onChange={e => onDateFromChange(e.target.value)}
          className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-violet-500"
        />
      </div>

      <button
        onClick={onSync}
        disabled={syncing || !status.configured}
        className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
      >
        {syncing ? (
          <><span className="animate-spin">⟳</span> Synchronizacja...</>
        ) : (
          <><span>⟳</span> Synchronizuj</>
        )}
      </button>

      {!status.configured && (
        <div className="w-full text-xs text-red-500 bg-red-50 dark:bg-red-950/20 px-3 py-2 rounded-lg">
          Brak konfiguracji. Ustaw zmienne środowiskowe: <code className="font-mono">KSEF_NIP</code>, <code className="font-mono">KSEF_TOKEN</code>
        </div>
      )}
    </div>
  )
}

function AssignModal({ invoice, projects, onClose, onAssigned }: {
  invoice: KsefInvoice
  projects: Project[]
  onClose: () => void
  onAssigned: (updated: KsefInvoice) => void
}) {
  const [projectId, setProjectId] = useState(invoice.project_id ?? '')
  const [notes, setNotes]         = useState(invoice.notes ?? '')
  const [saving, setSaving]       = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await ksefApi.assign(invoice.id, projectId || null, notes)
      onAssigned(updated)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">Przypisz fakturę do projektu</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {invoice.invoice_number ?? invoice.ksef_number} · {invoice.seller_name} · {fmt(invoice.gross_amount)} PLN
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Projekt</label>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
            >
              <option value="">— Nieprzypisana —</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.client_name})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notatka (opcjonalnie)</label>
            <textarea
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="np. materiały do salonu, robocizna - etap 2"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
          >Anuluj</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50"
          >
            {saving ? 'Zapisywanie...' : 'Zapisz'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface InvoiceLineItem {
  nr: string
  name: string
  unit: string
  qty: string
  unitPrice: string
  netValue: string
  vatRate: string
}

function parseInvoiceXml(xml: string): { fields: Record<string, string>; items: InvoiceLineItem[] } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')

  // getElementsByTagNameNS('*', tag) dopasowuje lokalną nazwę tagu niezależnie od namespace
  const el = (tag: string, parent: Element | Document = doc): string => {
    const hits = parent.getElementsByTagNameNS('*', tag)
    if (hits.length > 0) return hits[0].textContent?.trim() ?? ''
    // fallback bez namespace (np. brak xmlns w dokumencie)
    const hits2 = parent.getElementsByTagName(tag)
    return hits2.length > 0 ? hits2[0].textContent?.trim() ?? '' : ''
  }
  const elFirst = (tags: string[], parent: Element | Document = doc): string => {
    for (const tag of tags) { const v = el(tag, parent); if (v) return v }
    return ''
  }

  // Pozycje faktury
  const rowsNS  = doc.getElementsByTagNameNS('*', 'FaWiersz')
  const rows    = rowsNS.length > 0 ? rowsNS : doc.getElementsByTagName('FaWiersz')
  const items: InvoiceLineItem[] = Array.from(rows).map(row => ({
    nr:        elFirst(['NrWierszaFa', 'NrWiersza'], row),
    name:      el('P_7',  row),
    unit:      el('P_8A', row),
    qty:       el('P_8B', row),
    unitPrice: elFirst(['P_9A', 'P_9B'], row),
    netValue:  elFirst(['P_11', 'P_11A'], row),
    vatRate:   el('P_12', row),
  })).filter(i => i.name)

  const fields: Record<string, string> = {
    'Nr faktury':       el('P_2'),
    'Data wystawienia': el('P_1'),
    'Sprzedawca':       elFirst(['Nazwa']),
    'NIP sprzedawcy':   el('NIP'),
    'Wartość netto':    el('P_15'),
    'Kwota VAT':        el('P_16'),
    'Wartość brutto':   el('P_17'),
    'Waluta':           el('KodWaluty') || 'PLN',
  }

  return { fields, items }
}

function InvoicePreviewModal({ invoice, onClose }: {
  invoice: KsefInvoice
  onClose: () => void
}) {
  const [xml, setXml]         = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    ksefApi.getXml(invoice.id)
      .then(x => setXml(x))
      .catch(e => setError(e.response?.data?.error ?? e.message))
      .finally(() => setLoading(false))
  }, [invoice.id])

  const handleDownload = () => {
    if (!xml) return
    const blob = new Blob([xml], { type: 'application/xml' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `faktura-${invoice.invoice_number ?? invoice.ksef_number ?? 'ksef'}.xml`
    a.click()
    URL.revokeObjectURL(url)
  }

  const { fields, items } = xml ? parseInvoiceXml(xml) : { fields: {}, items: [] }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Podgląd faktury</h2>
            <p className="text-xs text-gray-400 mt-0.5">{invoice.invoice_number ?? invoice.ksef_number}</p>
          </div>
          <div className="flex items-center gap-2">
            {xml && (
              <button
                onClick={handleDownload}
                className="px-3 py-1.5 text-xs font-medium text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/20 rounded-lg transition-colors"
              >
                ⬇ Pobierz XML
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && <div className="text-center py-12 text-gray-400 text-sm">Pobieranie z KSeF…</div>}
          {error   && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 px-4 py-3 rounded-lg">{error}</div>}

          {xml && (
            <div className="space-y-4">
              {/* Kluczowe pola */}
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(fields).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="bg-gray-50 dark:bg-gray-800 px-3 py-2 rounded-lg">
                    <div className="text-xs text-gray-400 mb-0.5">{k}</div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{v}</div>
                  </div>
                ))}
              </div>

              {/* Pozycje faktury */}
              {items.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Pozycje faktury ({items.length})</h3>
                  <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-700">
                    <table className="w-full text-xs text-gray-800 dark:text-gray-100">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-300">
                          <th className="text-left px-3 py-2 font-semibold">Nazwa towaru/usługi</th>
                          <th className="text-right px-3 py-2 font-semibold">Ilość</th>
                          <th className="text-left px-3 py-2 font-semibold">J.m.</th>
                          <th className="text-right px-3 py-2 font-semibold">Cena netto</th>
                          <th className="text-right px-3 py-2 font-semibold">Wartość netto</th>
                          <th className="text-right px-3 py-2 font-semibold">VAT %</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                        {items.map((item, i) => (
                          <tr key={i} className="bg-white dark:bg-gray-800">
                            <td className="px-3 py-2 font-medium max-w-[200px]">{item.name}</td>
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
                </div>
              )}

              {/* Dane z naszej bazy */}
              <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">Dane z bazy</h3>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ['Sprzedawca', invoice.seller_name],
                    ['NIP sprzedawcy', invoice.seller_nip],
                    ['Netto', `${fmt(invoice.net_amount)} ${invoice.currency}`],
                    ['VAT', `${fmt(invoice.vat_amount)} ${invoice.currency}`],
                    ['Brutto', `${fmt(invoice.gross_amount)} ${invoice.currency}`],
                    ['Data wystawienia', invoice.invoice_date],
                    ['Numer KSeF', invoice.ksef_number],
                  ].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k as string} className="bg-gray-50 dark:bg-gray-800 px-3 py-2 rounded-lg">
                      <div className="text-xs text-gray-400 mb-0.5">{k}</div>
                      <div className="text-sm text-gray-700 dark:text-gray-300 break-all">{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Raw XML (zwijany) */}
              <details className="border border-gray-100 dark:border-gray-800 rounded-lg">
                <summary className="px-4 py-2 text-xs text-gray-400 cursor-pointer hover:text-gray-600 select-none">Surowy XML</summary>
                <pre className="px-4 py-3 text-xs font-mono text-gray-600 dark:text-gray-400 overflow-x-auto max-h-64 overflow-y-auto bg-gray-50 dark:bg-gray-800 rounded-b-lg whitespace-pre-wrap break-all">
                  {xml}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function InvoiceRow({ invoice, projects, onUpdated, onRemoved }: {
  invoice: KsefInvoice
  projects: Project[]
  onUpdated: (inv: KsefInvoice) => void
  onRemoved: (id: string) => void
}) {
  const [showAllocations, setShowAllocations] = useState(false)
  const [previewing, setPreviewing]           = useState(false)

  const handleRemove = async () => {
    if (!confirm('Usunąć tę fakturę z bazy? (Nie usuwa jej z KSeF)')) return
    await ksefApi.remove(invoice.id)
    onRemoved(invoice.id)
  }

  const isAssigned = !!invoice.project_id

  return (
    <>
      <tr className="group border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
        <td className="py-2.5 pr-3">
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
            {invoice.invoice_number ?? '—'}
          </div>
          <div className="text-xs text-gray-400 font-mono truncate max-w-[180px]" title={invoice.ksef_number ?? ''}>
            KSeF: {invoice.ksef_number ? invoice.ksef_number.slice(0, 20) + '…' : '—'}
          </div>
        </td>
        <td className="py-2.5 pr-3">
          <div className="text-sm text-gray-700 dark:text-gray-300">{invoice.seller_name ?? '—'}</div>
          <div className="text-xs text-gray-400">{invoice.seller_nip ?? ''}</div>
        </td>
        <td className="py-2.5 pr-3 text-right">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100 tabular-nums">
            {fmt(invoice.gross_amount)} {invoice.currency}
          </div>
          <div className="text-xs text-gray-400 tabular-nums">
            Netto: {fmt(invoice.net_amount)} / VAT: {fmt(invoice.vat_amount)}
          </div>
        </td>
        <td className="py-2.5 pr-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {invoice.invoice_date ?? '—'}
        </td>
        <td className="py-2.5 pr-3">
          {isAssigned ? (
            <div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                ✓ {invoice.project?.name ?? 'Projekt'}
              </span>
              {invoice.notes && (
                <div className="text-xs text-gray-400 mt-0.5 truncate max-w-[160px]">{invoice.notes}</div>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400">
              Nieprzypisana
            </span>
          )}
        </td>
        <td className="py-2.5">
          <div className="flex items-center gap-1">
            <button
              onClick={async () => {
                const updated = await ksefApi.share(invoice.id, !invoice.is_shared)
                onUpdated(updated)
              }}
              className={`p-1 rounded transition-colors ${invoice.is_shared
                ? 'text-green-500 dark:text-green-400 hover:text-green-700'
                : 'text-gray-300 dark:text-gray-600 hover:text-green-500'}`}
              title={invoice.is_shared ? 'Cofnij udostępnienie' : 'Udostępnij użytkownikom'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
            <button
              onClick={() => setPreviewing(true)}
              className="p-1 text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 rounded transition-colors"
              title="Podgląd faktury"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
            <button
              onClick={() => setShowAllocations(v => !v)}
              className={`px-2 py-1 text-xs font-medium rounded transition-colors ${showAllocations
                ? 'bg-violet-600 text-white'
                : 'text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/20'}`}
            >
              {showAllocations ? '▲ Alokacje' : '▼ Alokacje'}
            </button>
            <button
              onClick={handleRemove}
              className="p-1 text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 rounded transition-colors"
              title="Usuń z bazy"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </td>
      </tr>
      {showAllocations && (
        <tr className="border-b border-violet-100 dark:border-violet-900/30 bg-violet-50/30 dark:bg-violet-950/10">
          <td colSpan={6} className="px-4 py-3">
            <AllocationPanel invoice={invoice} isAdmin={true} />
          </td>
        </tr>
      )}
      {previewing && (
        <InvoicePreviewModal invoice={invoice} onClose={() => setPreviewing(false)} />
      )}
    </>
  )
}

export default function KsefPage() {
  const [status, setStatus]     = useState<KsefStatus | null>(null)
  const [invoices, setInvoices] = useState<KsefInvoice[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [syncing, setSyncing]   = useState(false)
  const [syncMsg, setSyncMsg]   = useState<string | null>(null)
  const [tab, setTab]           = useState<'all' | 'unassigned' | 'assigned'>('all')
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const [debugInfo, setDebugInfo] = useState<any>(null)
  const [debugging, setDebugging] = useState(false)
  const [dateFrom, setDateFrom]   = useState('2024-01-01')
  const LIMIT = 50

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const assigned = tab === 'all' ? undefined : tab === 'assigned'
      const [res, st, projs] = await Promise.all([
        ksefApi.invoices({ assigned, search: search || undefined, page, limit: LIMIT }),
        ksefApi.status(),
        projectsApi.list(),
      ])
      setInvoices(res.invoices)
      setTotal(res.total)
      setStatus(st)
      setProjects(projs)
    } finally {
      setLoading(false)
    }
  }, [tab, search, page])

  useEffect(() => { load() }, [load])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const result = await ksefApi.sync(dateFrom || undefined)
      const errTxt = result.errors.length ? `\nBłędy: ${result.errors.join(' | ')}` : ''
      setSyncMsg(`✓ Pobrano ${result.fetched}, zapisano ${result.saved} nowych faktur${errTxt}`)
      await load()
    } catch (err: any) {
      setSyncMsg(`✗ Błąd: ${err.response?.data?.error ?? err.message}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleDebug = async () => {
    setDebugging(true)
    setDebugInfo(null)
    try {
      const result = await ksefApi.debugAuth()
      setDebugInfo(result)
    } catch (err: any) {
      setDebugInfo({ error: err.response?.data ?? err.message })
    } finally {
      setDebugging(false)
    }
  }

  const handleUpdated = (updated: KsefInvoice) => {
    setInvoices(prev => prev.map(i => i.id === updated.id ? updated : i))
    // Odśwież status (zmiana liczby nieprzypisanych)
    ksefApi.status().then(setStatus).catch(() => {})
  }

  const handleRemoved = (id: string) => {
    setInvoices(prev => prev.filter(i => i.id !== id))
    setTotal(t => t - 1)
    ksefApi.status().then(setStatus).catch(() => {})
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">📋 KSeF — Faktury zakupowe</h1>
          <p className="text-xs text-gray-400 mt-0.5">Faktury pobrane z Krajowego Systemu e-Faktur</p>
        </div>
      </div>

      <StatusBar status={status} onSync={handleSync} syncing={syncing} dateFrom={dateFrom} onDateFromChange={setDateFrom} />

      {syncMsg && (
        <div className={`text-sm px-4 py-2 rounded-lg ${syncMsg.startsWith('✓')
          ? 'bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400'
          : 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400'}`}>
          {syncMsg}
        </div>
      )}

      {/* Debug panel */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleDebug}
          disabled={debugging}
          className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
        >
          {debugging ? 'Diagnostyka…' : '🔍 Diagnostyka autoryzacji'}
        </button>
        <button
          onClick={async () => {
            if (!confirm('Usunąć wszystkie faktury z bazy i zresetować synchronizację?')) return
            const r = await ksefApi.removeAll()
            setSyncMsg(`✓ Usunięto ${r.deleted} faktur. Kliknij Synchronizuj aby pobrać ponownie.`)
            await load()
          }}
          className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors"
        >
          🗑 Resetuj bazę faktur
        </button>
        {debugInfo && (
          <button onClick={() => setDebugInfo(null)} className="text-xs text-gray-400 hover:text-gray-600">Zamknij</button>
        )}
      </div>
      {debugInfo && (
        <div className="bg-gray-900 text-green-400 text-xs font-mono p-4 rounded-xl overflow-x-auto max-h-64 overflow-y-auto">
          <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
        </div>
      )}

      {/* Filtry */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-sm">
          {(['all', 'unassigned', 'assigned'] as const).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setPage(1) }}
              className={`px-3 py-1.5 font-medium transition-colors ${tab === t
                ? 'bg-violet-600 text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
            >
              {t === 'all' ? 'Wszystkie' : t === 'unassigned' ? '⏳ Nieprzypisane' : '✓ Przypisane'}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Szukaj (nr faktury, NIP, sprzedawca…)"
          className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
        />

        <span className="text-xs text-gray-400">{total} faktur</span>
      </div>

      {/* Tabela */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-gray-400 text-sm">Ładowanie…</div>
        ) : invoices.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <div className="text-4xl mb-3">📋</div>
            <div className="text-sm font-medium">Brak faktur</div>
            <div className="text-xs mt-1">
              {status?.configured
                ? 'Kliknij "Synchronizuj teraz" aby pobrać faktury z KSeF'
                : 'Skonfiguruj zmienne środowiskowe KSEF_NIP i KSEF_TOKEN'}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                  <th className="text-left px-4 py-3 pr-3">Nr faktury / KSeF</th>
                  <th className="text-left py-3 pr-3">Sprzedawca</th>
                  <th className="text-right py-3 pr-3">Kwota</th>
                  <th className="text-left py-3 pr-3">Data</th>
                  <th className="text-left py-3 pr-3">Projekt</th>
                  <th className="py-3">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <InvoiceRow
                    key={inv.id}
                    invoice={inv}
                    projects={projects}
                    onUpdated={handleUpdated}
                    onRemoved={handleRemoved}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Paginacja */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800"
          >← Poprzednia</button>
          <span className="text-sm text-gray-500">Strona {page} z {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800"
          >Następna →</button>
        </div>
      )}
    </div>
  )
}
