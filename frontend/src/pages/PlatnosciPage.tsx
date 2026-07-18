import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, CheckCircle2, RotateCcw, Search, AlertTriangle, Banknote, CalendarClock, ListChecks } from 'lucide-react'
import { payablesApi } from '../api/client'
import type { PayableSummary, PayableInvoice, PayableReviewItem, Mt940ImportResult } from '../types'
import { useAuth } from '../auth/AuthContext'

function money(n: number, currency = 'PLN') {
  return `${new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)} ${currency === 'PLN' ? 'zł' : currency}`
}
function fmtDate(s: string | null) {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

const SOURCE_LABEL: Record<string, string> = { mt940: 'MT940', przelewy24: 'P24', manual: 'ręcznie' }

type Tab = 'unpaid' | 'overdue' | 'paid' | 'all' | 'review'

export default function PlatnosciPage() {
  const { user } = useAuth()
  const canSee = user?.role === 'admin' || !!user?.can_view_payments

  const [tab, setTab] = useState<Tab>('unpaid')
  const [summary, setSummary] = useState<PayableSummary | null>(null)
  const [invoices, setInvoices] = useState<PayableInvoice[]>([])
  const [review, setReview] = useState<PayableReviewItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [importResult, setImportResult] = useState<Mt940ImportResult | null>(null)
  const [importError, setImportError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Sekwencer żądań: odpowiedź, która przyszła po nowszym żądaniu, jest ignorowana
  // (szybkie przełączanie zakładek / wpisywanie w szukajce nie nadpisze świeżych danych starymi)
  const reqSeq = useRef(0)

  const reload = useCallback(async (activeTab: Tab, q: string) => {
    const seq = ++reqSeq.current
    try {
      const [s, r] = await Promise.all([payablesApi.summary(), payablesApi.review()])
      if (seq !== reqSeq.current) return
      setSummary(s); setReview(r)
      if (activeTab !== 'review') {
        const inv = await payablesApi.invoices(activeTab, q)
        if (seq !== reqSeq.current) return
        setInvoices(inv)
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  // Jeden efekt na zakładkę + wyszukiwanie: zmiana zakładki ładuje od razu,
  // wpisywanie w szukajce z opóźnieniem 300 ms
  const prevTab = useRef<Tab | null>(null)
  useEffect(() => {
    if (!canSee) return
    const tabChanged = prevTab.current !== tab
    prevTab.current = tab
    if (tabChanged) setLoading(true)
    const t = setTimeout(() => { reload(tab, search).catch(() => setLoading(false)) }, tabChanged ? 0 : 300)
    return () => clearTimeout(t)
  }, [canSee, tab, search, reload])

  const handleImport = async (file: File) => {
    setUploading(true); setImportError(''); setImportResult(null)
    try {
      const result = await payablesApi.importMt940(file)
      setImportResult(result)
      await reload(tab, search)
      if (result.to_review > 0) setTab('review')
    } catch (e: any) {
      setImportError(e?.response?.data?.error ?? 'Błąd importu pliku MT940.')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const markPaid = async (inv: PayableInvoice) => {
    setBusyId(inv.id)
    try { await payablesApi.markPaid(inv.id); await reload(tab, search) }
    catch { alert('Nie udało się oznaczyć faktury.') }
    finally { setBusyId(null) }
  }

  const markUnpaid = async (inv: PayableInvoice) => {
    if (!confirm(`Cofnąć oznaczenie zapłaty faktury ${inv.invoice_number ?? ''}?`)) return
    setBusyId(inv.id)
    try { await payablesApi.markUnpaid(inv.id); await reload(tab, search) }
    catch { alert('Nie udało się cofnąć oznaczenia.') }
    finally { setBusyId(null) }
  }

  const assign = async (txId: string, invoiceId: string) => {
    setBusyId(txId)
    try { await payablesApi.assign(txId, invoiceId); await reload(tab, search) }
    catch { alert('Nie udało się przypisać płatności.') }
    finally { setBusyId(null) }
  }

  const dismiss = async (txId: string) => {
    setBusyId(txId)
    try { await payablesApi.dismiss(txId); await reload(tab, search) }
    catch { alert('Nie udało się odrzucić transakcji.') }
    finally { setBusyId(null) }
  }

  const [rematching, setRematching] = useState(false)
  const [rematchInfo, setRematchInfo] = useState('')
  const rematch = async () => {
    setRematching(true); setRematchInfo('')
    try {
      const r = await payablesApi.rematch()
      setRematchInfo(r.matched > 0
        ? `Automatycznie dopasowano ${r.matched} z ${r.checked} obciążeń — ${r.remaining} zostało do ręcznej decyzji.`
        : `Sprawdzono ${r.checked} obciążeń — żadne nie kwalifikuje się automatycznie.`)
      await reload(tab, search)
    } catch { setRematchInfo('Nie udało się ponowić dopasowania.') }
    finally { setRematching(false) }
  }

  if (!canSee) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        Brak dostępu do panelu płatności. Poproś administratora o nadanie uprawnienia.
      </div>
    )
  }

  const statusBadge = (inv: PayableInvoice) => {
    if (inv.payment_status === 'paid') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          ✓ Zapłacona{inv.payment_source ? ` · ${SOURCE_LABEL[inv.payment_source] ?? inv.payment_source}` : ''}
        </span>
      )
    }
    if (inv.overdue) {
      return <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-bold bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400">Po terminie</span>
    }
    return <span className="inline-flex px-2 py-0.5 rounded-md text-xs font-bold bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">Do zapłaty</span>
  }

  const kpi = (label: string, value: string, sub: string, tone: 'default' | 'red' | 'amber' | 'green' | 'violet', Icon: typeof Banknote) => {
    const tones = {
      default: 'text-gray-800 dark:text-gray-100',
      red: 'text-red-600 dark:text-red-400',
      amber: 'text-amber-600 dark:text-amber-400',
      green: 'text-green-600 dark:text-green-400',
      violet: 'text-violet-600 dark:text-violet-400',
    }
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex flex-col gap-1">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
          <Icon size={14} /> {label}
        </div>
        <div className={`text-xl font-bold ${tones[tone]}`}>{value}</div>
        <div className="text-xs text-gray-400">{sub}</div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {/* Nagłówek */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Płatności</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Faktury kosztowe z KSeF — pilnuj terminów i rozliczaj wyciągiem MT940</p>
        </div>
        <div>
          <input
            ref={fileRef} type="file" accept=".sta,.mt940,.txt,.940" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f) }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold disabled:opacity-60"
          >
            <Upload size={16} /> {uploading ? 'Przetwarzam wyciąg…' : 'Wgraj wyciąg MT940'}
          </button>
        </div>
      </div>

      {/* Wynik importu */}
      {importResult && (
        <div className="mb-4 p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-300">
          <div className="font-semibold mb-1">Wyciąg przetworzony ✓</div>
          <div>
            Zaimportowano <b>{importResult.imported}</b> transakcji
            {importResult.duplicates > 0 && <> · pominięto <b>{importResult.duplicates}</b> duplikatów</>}
            {' '}· automatycznie opłacono <b>{importResult.auto_matched}</b> faktur
            {importResult.to_review > 0 && <> · <b className="text-amber-700 dark:text-amber-400">{importResult.to_review} obciążeń do sprawdzenia</b></>}
          </div>
          {importResult.matched.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {importResult.matched.map(m => (
                <li key={m.invoice_id}>✓ {m.seller_name ?? '—'} · {m.invoice_number ?? '—'} · {money(m.amount)} <span className="text-green-600/70">({m.reasons.join(', ')})</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {importError && (
        <div className="mb-4 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
          {importError}
        </div>
      )}

      {/* KPI */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {kpi('Do zapłaty', money(summary.unpaid_sum), `${summary.unpaid_count} faktur`, 'default', Banknote)}
          {kpi('Po terminie', money(summary.overdue_sum), `${summary.overdue_count} faktur`, summary.overdue_count > 0 ? 'red' : 'default', AlertTriangle)}
          {kpi('Termin ≤ 7 dni', money(summary.due_soon_sum), `${summary.due_soon_count} faktur`, summary.due_soon_count > 0 ? 'amber' : 'default', CalendarClock)}
          {kpi('Zapłacone (ten mies.)', money(summary.paid_this_month_sum), `${summary.paid_this_month_count} faktur`, 'green', CheckCircle2)}
          {kpi('Do sprawdzenia', String(summary.review_count), 'obciążeń z wyciągów', summary.review_count > 0 ? 'violet' : 'default', ListChecks)}
        </div>
      )}

      {/* Zakładki + szukaj */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {([
          ['unpaid', 'Do zapłaty'],
          ['overdue', 'Po terminie'],
          ['paid', 'Zapłacone'],
          ['all', 'Wszystkie'],
        ] as [Tab, string][]).map(([t, lbl]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-2 rounded-lg text-sm font-semibold ${tab === t
              ? 'bg-violet-600 text-white'
              : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
          >
            {lbl}
          </button>
        ))}
        <button
          onClick={() => setTab('review')}
          className={`px-3.5 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 ${tab === 'review'
            ? 'bg-violet-600 text-white'
            : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
        >
          Do sprawdzenia
          {review.length > 0 && (
            <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${tab === 'review' ? 'bg-white/25 text-white' : 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'}`}>
              {review.length}
            </span>
          )}
        </button>
        <div className="flex-1" />
        {tab !== 'review' && (
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Sprzedawca, NIP, nr faktury…"
              className="pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 w-64"
            />
          </div>
        )}
      </div>

      {loading ? (
        <div className="p-10 text-center text-gray-400 text-sm">Ładowanie…</div>
      ) : tab === 'review' ? (
        /* ── Lista „do sprawdzenia" ── */
        review.length === 0 ? (
          <div className="p-10 text-center text-gray-400 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl">
            Brak obciążeń do sprawdzenia. Wgraj wyciąg MT940, aby rozliczyć płatności.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={rematch}
                disabled={rematching}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 text-sm font-semibold hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-60"
              >
                {rematching ? 'Dopasowuję…' : '⟳ Dopasuj automatycznie'}
              </button>
              <span className="text-xs text-gray-400">Ponownie ocenia zaległe obciążenia aktualnymi regułami (kwota + kontrahent)</span>
              {rematchInfo && <span className="text-xs font-semibold text-green-700 dark:text-green-400">{rematchInfo}</span>}
            </div>
            {review.map(tx => (
              <div key={tx.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-bold text-red-600 dark:text-red-400 whitespace-nowrap">{money(tx.amount)}</span>
                      <span className="text-xs text-gray-400">{fmtDate(tx.transaction_date)}</span>
                    </div>
                    {tx.counterparty && <div className="text-sm font-semibold text-gray-700 dark:text-gray-200 mt-1">{tx.counterparty}</div>}
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 break-words">{tx.description}</div>
                  </div>
                  <button
                    onClick={() => dismiss(tx.id)}
                    disabled={busyId === tx.id}
                    className="text-xs font-semibold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 whitespace-nowrap"
                  >
                    To nie faktura — odrzuć
                  </button>
                </div>
                <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
                  {tx.candidates.length === 0 ? (
                    <div className="text-xs text-gray-400">Brak pasujących nieopłaconych faktur.</div>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Pasujące faktury</div>
                      {tx.candidates.map(c => (
                        <div key={c.invoice.id} className="flex items-center gap-3 flex-wrap p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/60">
                          <div className="flex-1 min-w-[220px]">
                            <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                              {c.invoice.seller_name ?? '—'} <span className="text-gray-400 font-normal">· {c.invoice.invoice_number ?? 'bez numeru'}</span>
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              {money(c.invoice.gross_amount, c.invoice.currency)} · wyst. {fmtDate(c.invoice.invoice_date)} · termin {fmtDate(c.invoice.payment_due_date)}
                            </div>
                          </div>
                          <span className="text-xs font-bold text-violet-600 dark:text-violet-400 whitespace-nowrap" title={c.reasons.join(', ')}>
                            {Math.round(c.confidence * 100)}% ({c.reasons.join(', ')})
                          </span>
                          <button
                            onClick={() => assign(tx.id, c.invoice.id)}
                            disabled={busyId === tx.id}
                            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold disabled:opacity-60"
                          >
                            Przypisz i oznacz zapłaconą
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        /* ── Tabela faktur ── */
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-3 font-semibold">Sprzedawca</th>
                  <th className="px-4 py-3 font-semibold">Faktura</th>
                  <th className="px-4 py-3 font-semibold">Termin płatności</th>
                  <th className="px-4 py-3 font-semibold text-right">Kwota brutto</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                    {tab === 'unpaid' ? 'Brak faktur do zapłaty 🎉' : 'Brak faktur.'}
                  </td></tr>
                )}
                {invoices.map(inv => (
                  <tr key={inv.id} className="border-b border-gray-50 dark:border-gray-800/60 hover:bg-gray-50/60 dark:hover:bg-gray-800/40">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-gray-800 dark:text-gray-100">{inv.seller_name ?? '—'}</div>
                      {inv.seller_nip && <div className="text-xs text-gray-400">NIP {inv.seller_nip}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-700 dark:text-gray-200">{inv.invoice_number ?? '—'}</div>
                      <div className="text-xs text-gray-400">wyst. {fmtDate(inv.invoice_date)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={inv.overdue ? 'font-bold text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'}>
                        {fmtDate(inv.payment_due_date)}
                      </span>
                      {inv.payment_status === 'paid' && inv.paid_at && (
                        <div className="text-xs text-green-600 dark:text-green-400">zapł. {fmtDate(inv.paid_at)}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-gray-800 dark:text-gray-100 whitespace-nowrap">
                      {money(inv.gross_amount, inv.currency)}
                    </td>
                    <td className="px-4 py-3">{statusBadge(inv)}</td>
                    <td className="px-4 py-3 text-right">
                      {inv.payment_status === 'paid' ? (
                        <button
                          onClick={() => markUnpaid(inv)}
                          disabled={busyId === inv.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-60"
                        >
                          <RotateCcw size={12} /> Cofnij
                        </button>
                      ) : (
                        <button
                          onClick={() => markPaid(inv)}
                          disabled={busyId === inv.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold disabled:opacity-60"
                        >
                          <CheckCircle2 size={13} /> Oznacz zapłaconą
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
