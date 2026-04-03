import { useEffect, useRef, useState } from 'react'
import { bankApi } from '../../api/client'
import type { BankTransaction } from '../../types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPLN(n: number) {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency: 'PLN',
    minimumFractionDigits: 2,
  }).format(Math.abs(n))
}

function ConfidenceBar({ value }: { value: number }) {
  const pct  = Math.round(value * 100)
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 dark:text-gray-400">{pct}%</span>
    </div>
  )
}

// ─── Transaction table row ────────────────────────────────────────────────────

function TxRow({ tx }: { tx: BankTransaction }) {
  const isCredit = tx.amount >= 0
  return (
    <tr className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
      <td className="py-2 px-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{tx.transaction_date}</td>
      <td className="py-2 px-3 text-xs text-right tabular-nums whitespace-nowrap">
        <span className={isCredit ? 'text-green-600 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
          {isCredit ? '+' : '-'}{fmtPLN(tx.amount)}
        </span>
      </td>
      <td className="py-2 px-3 text-xs text-gray-700 dark:text-gray-300 max-w-[220px]">
        <div className="truncate" title={tx.description}>{tx.description || '—'}</div>
      </td>
      <td className="py-2 px-3 text-xs text-gray-500 dark:text-gray-400 max-w-[120px]">
        <div className="truncate" title={tx.counterparty}>{tx.counterparty || '—'}</div>
      </td>
      <td className="py-2 px-3">
        {tx.matched_invoice_id ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            Dopasowana
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            Niezidentyfikowana
          </span>
        )}
      </td>
      {tx.match_confidence != null && (
        <td className="py-2 px-3">
          <ConfidenceBar value={tx.match_confidence} />
        </td>
      )}
    </tr>
  )
}

// ─── Stats header ─────────────────────────────────────────────────────────────

function StatsHeader({ transactions }: { transactions: BankTransaction[] }) {
  const total   = transactions.length
  const matched = transactions.filter(t => t.matched_invoice_id).length
  const unmatched = total - matched
  return (
    <div className="flex flex-wrap gap-4 mb-4">
      <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800 px-3 py-2 rounded-lg">
        <span className="text-lg font-bold text-gray-800 dark:text-gray-100">{total}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">transakcji</span>
      </div>
      <div className="flex items-center gap-2 bg-green-50 dark:bg-green-900/20 px-3 py-2 rounded-lg">
        <span className="text-lg font-bold text-green-700 dark:text-green-400">{matched}</span>
        <span className="text-xs text-green-600 dark:text-green-500">dopasowanych</span>
      </div>
      <div className="flex items-center gap-2 bg-orange-50 dark:bg-orange-900/20 px-3 py-2 rounded-lg">
        <span className="text-lg font-bold text-orange-700 dark:text-orange-400">{unmatched}</span>
        <span className="text-xs text-orange-600 dark:text-orange-500">niezidentyfikowanych</span>
      </div>
    </div>
  )
}

// ─── Tab 1: MT940 Import ──────────────────────────────────────────────────────

function MT940Tab({ onTransactionsImported }: { onTransactionsImported: () => void }) {
  const [dragging, setDragging]   = useState(false)
  const [uploading, setUploading] = useState(false)
  const [matching, setMatching]   = useState(false)
  const [imported, setImported]   = useState<BankTransaction[]>([])
  const [matchResult, setMatchResult] = useState<{ matched: number; details: any[] } | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    setUploading(true)
    setError(null)
    setMatchResult(null)
    try {
      const res = await bankApi.importMT940(file)
      setImported(res.transactions)
      onTransactionsImported()
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message)
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleMatch = async () => {
    setMatching(true)
    setError(null)
    try {
      const res = await bankApi.match()
      setMatchResult(res)
      onTransactionsImported()
      // Refresh imported list with updated match status
      const all = await bankApi.transactions()
      setImported(all.filter(t => t.source === 'mt940'))
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message)
    } finally {
      setMatching(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20'
            : 'border-gray-200 dark:border-gray-700 hover:border-violet-300 hover:bg-gray-50 dark:hover:bg-gray-800/50'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".sta,.mt940,.txt"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
        />
        <div className="text-3xl mb-2">📥</div>
        {uploading ? (
          <p className="text-sm text-violet-600 dark:text-violet-400">Przetwarzanie pliku MT940…</p>
        ) : (
          <>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Przeciągnij plik MT940/STA z mBanku lub kliknij aby wybrać
            </p>
            <p className="text-xs text-gray-400 mt-1">Obsługiwane formaty: .sta, .mt940, .txt</p>
          </>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {imported.length > 0 && (
        <>
          <StatsHeader transactions={imported} />

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Zaimportowane transakcje ({imported.length})
            </h3>
            <button
              onClick={handleMatch}
              disabled={matching}
              className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {matching ? (
                <><span className="animate-spin">⟳</span> Dopasowywanie…</>
              ) : (
                <> Dopasuj do faktur KSeF</>
              )}
            </button>
          </div>

          {matchResult && (
            <div className={`px-4 py-3 rounded-lg text-sm ${matchResult.matched > 0
              ? 'bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400'
              : 'bg-orange-50 dark:bg-orange-950/20 text-orange-700 dark:text-orange-400'}`}>
              Dopasowano {matchResult.matched} {matchResult.matched === 1 ? 'transakcję' : 'transakcji'} do faktur KSeF
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="text-left px-3 py-2">Data</th>
                  <th className="text-right px-3 py-2">Kwota</th>
                  <th className="text-left px-3 py-2">Opis</th>
                  <th className="text-left px-3 py-2">Kontrahent</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {imported.map(tx => (
                  <TxRow key={tx.id} tx={tx} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Tab 2: Przelewy24 ────────────────────────────────────────────────────────

function P24Tab({ onTransactionsImported }: { onTransactionsImported: () => void }) {
  const [p24Status, setP24Status] = useState<{ configured: boolean; sandbox: boolean; merchantId: string } | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [syncing, setSyncing]     = useState(false)
  const [matching, setMatching]   = useState(false)
  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [matchResult, setMatchResult]   = useState<{ matched: number } | null>(null)
  const [error, setError]         = useState<string | null>(null)

  useEffect(() => {
    bankApi.p24Status()
      .then(setP24Status)
      .catch(() => setP24Status({ configured: false, sandbox: false, merchantId: '' }))
      .finally(() => setLoadingStatus(false))
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    setMatchResult(null)
    try {
      const res = await bankApi.p24Sync()
      setTransactions(res.transactions ?? [])
      onTransactionsImported()
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message)
    } finally {
      setSyncing(false)
    }
  }

  const handleMatch = async () => {
    setMatching(true)
    setError(null)
    try {
      const res = await bankApi.match()
      setMatchResult(res)
      onTransactionsImported()
      const all = await bankApi.transactions()
      setTransactions(all.filter(t => t.source === 'przelewy24'))
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message)
    } finally {
      setMatching(false)
    }
  }

  if (loadingStatus) {
    return <div className="py-8 text-center text-gray-400 text-sm">Sprawdzanie konfiguracji P24…</div>
  }

  return (
    <div className="space-y-4">
      {/* Status card */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${p24Status?.configured ? 'bg-green-500' : 'bg-red-400'}`} />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Przelewy24 {p24Status?.configured ? 'Skonfigurowane' : 'Nieskonfigurowane'}
          </span>
        </div>
        {p24Status?.configured && (
          <>
            <span className="text-xs text-gray-400">Merchant ID: {p24Status.merchantId}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${p24Status.sandbox
              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
              : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'}`}>
              {p24Status.sandbox ? 'Sandbox' : 'Produkcja'}
            </span>
          </>
        )}

        {p24Status?.configured ? (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="ml-auto px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {syncing ? (
              <><span className="animate-spin">⟳</span> Synchronizacja…</>
            ) : (
              <>Synchronizuj transakcje (ostatnie 30 dni)</>
            )}
          </button>
        ) : (
          <div className="w-full text-xs text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-900 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700">
            Ustaw zmienne <code className="font-mono text-violet-600 dark:text-violet-400">P24_MERCHANT_ID</code>,{' '}
            <code className="font-mono text-violet-600 dark:text-violet-400">P24_API_KEY</code>,{' '}
            <code className="font-mono text-violet-600 dark:text-violet-400">P24_CRC</code> w ustawieniach Render
          </div>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {transactions.length > 0 && (
        <>
          <StatsHeader transactions={transactions} />

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Transakcje P24 ({transactions.length})
            </h3>
            <button
              onClick={handleMatch}
              disabled={matching}
              className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {matching ? <><span className="animate-spin">⟳</span> Dopasowywanie…</> : ' Dopasuj do faktur KSeF'}
            </button>
          </div>

          {matchResult && (
            <div className="px-4 py-3 rounded-lg text-sm bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400">
              Dopasowano {matchResult.matched} transakcji
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="text-left px-3 py-2">Data</th>
                  <th className="text-right px-3 py-2">Kwota</th>
                  <th className="text-left px-3 py-2">Opis</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(tx => <TxRow key={tx.id} tx={tx} />)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Tab 3: History ───────────────────────────────────────────────────────────

function HistoryTab() {
  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [loading, setLoading]           = useState(true)
  const [filter, setFilter]             = useState<'all' | 'mt940' | 'przelewy24' | 'matched' | 'unmatched'>('all')
  const [clearing, setClearing]         = useState(false)
  const [error, setError]               = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const params: any = {}
      if (filter === 'mt940' || filter === 'przelewy24') params.source = filter
      if (filter === 'matched')   params.matched = 'true'
      if (filter === 'unmatched') params.matched = 'false'
      const data = await bankApi.transactions(params)
      setTransactions(data)
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter])

  const handleClear = async () => {
    if (!confirm('Usunąć wszystkie transakcje bankowe z bazy danych? Tej operacji nie można cofnąć.')) return
    setClearing(true)
    try {
      await bankApi.clearTransactions()
      setTransactions([])
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message)
    } finally {
      setClearing(false)
    }
  }

  const filterOptions: { key: typeof filter; label: string }[] = [
    { key: 'all',         label: 'Wszystkie' },
    { key: 'mt940',       label: 'MT940' },
    { key: 'przelewy24',  label: 'Przelewy24' },
    { key: 'matched',     label: 'Dopasowane' },
    { key: 'unmatched',   label: 'Niezidentyfikowane' },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
          {filterOptions.map(opt => (
            <button
              key={opt.key}
              onClick={() => setFilter(opt.key)}
              className={`px-3 py-1.5 font-medium transition-colors ${filter === opt.key
                ? 'bg-violet-600 text-white'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          onClick={handleClear}
          disabled={clearing || transactions.length === 0}
          className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors disabled:opacity-50"
        >
          {clearing ? 'Usuwanie…' : 'Wyczysc wszystko'}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {!loading && <StatsHeader transactions={transactions} />}

      {loading ? (
        <div className="py-8 text-center text-gray-400 text-sm">Ładowanie…</div>
      ) : transactions.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-3xl mb-2">💳</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Brak transakcji</div>
          <div className="text-xs text-gray-400 mt-1">Zaimportuj plik MT940 lub zsynchronizuj dane z Przelewy24</div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="text-left px-3 py-2">Data</th>
                <th className="text-right px-3 py-2">Kwota</th>
                <th className="text-left px-3 py-2">Opis</th>
                <th className="text-left px-3 py-2">Kontrahent</th>
                <th className="text-left px-3 py-2">Zrodlo</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="px-3 py-2">Pewnosc</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map(tx => (
                <tr key={tx.id} className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="py-2 px-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{tx.transaction_date}</td>
                  <td className="py-2 px-3 text-xs text-right tabular-nums whitespace-nowrap">
                    <span className={tx.amount >= 0
                      ? 'text-green-600 dark:text-green-400 font-medium'
                      : 'text-red-600 dark:text-red-400 font-medium'}>
                      {tx.amount >= 0 ? '+' : '-'}{fmtPLN(tx.amount)}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs text-gray-700 dark:text-gray-300 max-w-[200px]">
                    <div className="truncate" title={tx.description}>{tx.description || '—'}</div>
                  </td>
                  <td className="py-2 px-3 text-xs text-gray-500 dark:text-gray-400 max-w-[100px]">
                    <div className="truncate">{tx.counterparty || '—'}</div>
                  </td>
                  <td className="py-2 px-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      tx.source === 'mt940'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                    }`}>
                      {tx.source === 'mt940' ? 'MT940' : 'P24'}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    {tx.matched_invoice_id ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        Dopasowana
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        —
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    {tx.match_confidence != null && <ConfidenceBar value={tx.match_confidence} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void
  onPaymentsUpdated?: () => void
}

type TabKey = 'mt940' | 'p24' | 'history'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'mt940',   label: 'Import MT940' },
  { key: 'p24',     label: 'Przelewy24' },
  { key: 'history', label: 'Historia transakcji' },
]

export default function PaymentVerificationModal({ onClose, onPaymentsUpdated }: Props) {
  const [tab, setTab] = useState<TabKey>('mt940')

  const handleTransactionsImported = () => {
    onPaymentsUpdated?.()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-5xl mt-8 mb-8 flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Weryfikacja platnosci</h2>
            <p className="text-xs text-gray-400 mt-0.5">Dopasuj transakcje bankowe do faktur KSeF</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 px-6 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                tab === t.key
                  ? 'bg-violet-600 text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'mt940'   && <MT940Tab onTransactionsImported={handleTransactionsImported} />}
          {tab === 'p24'     && <P24Tab   onTransactionsImported={handleTransactionsImported} />}
          {tab === 'history' && <HistoryTab />}
        </div>
      </div>
    </div>
  )
}
