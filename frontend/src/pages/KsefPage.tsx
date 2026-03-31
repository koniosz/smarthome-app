import { useEffect, useState, useCallback } from 'react'
import { ksefApi, projectsApi } from '../api/client'
import type { KsefInvoice, KsefStatus, Project } from '../types'

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

function InvoiceRow({ invoice, projects, onUpdated, onRemoved }: {
  invoice: KsefInvoice
  projects: Project[]
  onUpdated: (inv: KsefInvoice) => void
  onRemoved: (id: string) => void
}) {
  const [assigning, setAssigning] = useState(false)

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
              onClick={() => setAssigning(true)}
              className="px-2 py-1 text-xs font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/20 rounded transition-colors"
            >
              {isAssigned ? 'Zmień' : 'Przypisz'}
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
      {assigning && (
        <AssignModal
          invoice={invoice}
          projects={projects}
          onClose={() => setAssigning(false)}
          onAssigned={upd => { onUpdated(upd); setAssigning(false) }}
        />
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
      <div className="flex items-center gap-2">
        <button
          onClick={handleDebug}
          disabled={debugging}
          className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
        >
          {debugging ? 'Diagnostyka…' : '🔍 Diagnostyka autoryzacji'}
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
