import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Upload, Landmark, X } from 'lucide-react'
import { financeApi } from '../api/client'
import type { PnlLines, PnlResponse, FixedAsset, SalesImportResult } from '../types'
import { useAuth } from '../auth/AuthContext'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)
}
function fmt0(n: number) {
  return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(n || 0)
}

const MONTH_LABELS = ['Sty', 'Lut', 'Mar', 'Kwi', 'Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź', 'Lis', 'Gru']
const BU_OPTIONS = [['all', 'Cała spółka'], ['shc', 'Smart Home Center'], ['gatelynk', 'GateLynk'], ['shared', 'Wspólne']] as const

type ViewMode = 'month' | 'quarters' | 'trend'

// ── Wiersz RZiS ───────────────────────────────────────────────────────────────
function Row({ label, value, pctVal, bold, indent, tone, note }: {
  label: string; value: number; pctVal?: number; bold?: boolean; indent?: boolean
  tone?: 'green' | 'red' | 'blue' | 'amber'; note?: string
}) {
  const bg = tone === 'green' ? 'bg-green-50/70 dark:bg-green-950/20'
    : tone === 'blue' ? 'bg-blue-50/70 dark:bg-blue-950/20'
    : tone === 'amber' ? 'bg-amber-50/70 dark:bg-amber-950/20'
    : tone === 'red' ? 'bg-red-50/70 dark:bg-red-950/20' : ''
  return (
    <tr className={`border-b border-gray-100 dark:border-gray-800 ${bg}`}>
      <td className={`py-2.5 ${indent ? 'pl-9' : 'pl-4'}`}>
        <span className={`text-sm ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : indent ? 'text-gray-500 dark:text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>{label}</span>
        {note && <span className="ml-2 text-xs text-gray-400">{note}</span>}
      </td>
      <td className="py-2.5 pr-4 text-right tabular-nums whitespace-nowrap">
        <span className={`text-sm ${bold ? 'font-bold' : ''} ${value < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{fmt(value)} zł</span>
      </td>
      <td className="py-2.5 pr-4 text-right tabular-nums w-20">
        {pctVal !== undefined && (
          <span className={`text-xs font-bold ${pctVal >= 20 ? 'text-green-600 dark:text-green-400' : pctVal >= 0 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
            {fmt(pctVal).replace(',00', '')}%
          </span>
        )}
      </td>
    </tr>
  )
}

// ── Tabela RZiS dla jednego okresu ────────────────────────────────────────────
function PnlTable({ L }: { L: PnlLines }) {
  return (
    <table className="w-full">
      <tbody>
        <Row label="Przychody netto" value={L.revenue} bold tone="blue" note={L.provisional ? '• wstępne (brak importu Firmao)' : '• potwierdzone Firmao'} />
        {L.revenue_firmao > 0 && <Row label="Firmao (rejestr sprzedaży)" value={L.revenue_firmao} indent />}
        {L.revenue_ksef > 0 && <Row label="KSeF (B2B)" value={L.revenue_ksef} indent />}
        {L.revenue_module > 0 && <Row label="Moduł faktur (B2C)" value={L.revenue_module} indent />}
        {L.revenue_advances > 0 && <Row label="w tym faktury zaliczkowe" value={L.revenue_advances} indent />}
        <Row label="Koszt własny sprzedaży (COGS)" value={-L.cogs} />
        <Row label="Marża brutto" value={L.gross_margin} pctVal={L.gross_margin_pct} bold tone="green" />
        <Row label="Koszty operacyjne (OPEX)" value={-L.opex} />
        {L.opex_sales > 0 && <Row label="Sprzedaż i marketing" value={-L.opex_sales} indent />}
        {L.opex_ga > 0 && <Row label="G&A (pensje, ZUS, czynsz, biuro)" value={-L.opex_ga} indent />}
        {L.opex_operations > 0 && <Row label="Operacyjne (auta, narzędzia)" value={-L.opex_operations} indent />}
        {L.opex_leasing > 0 && <Row label="Leasing (operacyjny)" value={-L.opex_leasing} indent />}
        <Row label="EBITDA" value={L.ebitda} pctVal={L.ebitda_pct} bold tone={L.ebitda >= 0 ? 'green' : 'red'} />
        <Row label="Amortyzacja" value={-L.depreciation} />
        <Row label="EBIT" value={L.ebit} bold />
        <Row label="Koszty finansowe (odsetki, prowizje)" value={-L.financial_costs} />
        <Row label="CIT (zaliczki)" value={-L.cit} />
        <Row label="Wynik netto (szacunkowy)" value={L.net_result} bold tone={L.net_result >= 0 ? 'green' : 'red'} />
      </tbody>
    </table>
  )
}

export default function RentownoscPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const canSee = user?.role === 'admin' || !!user?.can_view_payments

  const nowDate = new Date()
  const [year, setYear] = useState(nowDate.getFullYear())
  const [bu, setBU] = useState('all')
  const [view, setView] = useState<ViewMode>('month')
  const [monthIdx, setMonthIdx] = useState(nowDate.getMonth()) // 0-11
  const [data, setData] = useState<PnlResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [uploading, setUploading] = useState(false)
  const [importResult, setImportResult] = useState<SalesImportResult | null>(null)
  const [importError, setImportError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [assetsOpen, setAssetsOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await financeApi.pnl(year, bu)) }
    catch (e: any) { setError(e?.response?.data?.error ?? 'Błąd ładowania danych') }
    finally { setLoading(false) }
  }, [year, bu])

  useEffect(() => { if (canSee) load() }, [canSee, load])

  const handleImport = async (file: File) => {
    setUploading(true); setImportError(''); setImportResult(null)
    try {
      const result = await financeApi.importSales(file)
      setImportResult(result)
      await load()
    } catch (e: any) {
      setImportError(e?.response?.data?.error ?? 'Błąd importu pliku.')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (!canSee) {
    return <div className="p-8 text-center text-gray-500 dark:text-gray-400">Brak dostępu. Poproś administratora o nadanie uprawnienia (💳).</div>
  }

  const month = data?.months[monthIdx]
  const trendMax = data ? Math.max(...data.months.map(m => Math.max(m.revenue, 1))) : 1

  return (
    <div className="p-6 max-w-[1150px] mx-auto" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {/* Nagłówek */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Rentowność spółki</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Rachunek wyników (memoriał, netto) · EBITDA · {year}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f) }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold disabled:opacity-60">
            <Upload size={15} /> {uploading ? 'Importuję…' : 'Wgraj sprzedaż z Firmao'}
          </button>
          <button onClick={() => setAssetsOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800">
            <Landmark size={15} /> Środki trwałe
          </button>
          {user?.role === 'admin' && (
            <button onClick={() => navigate('/finanse')}
              className="px-3 py-2.5 rounded-lg text-sm font-semibold text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30">
              Szczegóły kosztów →
            </button>
          )}
        </div>
      </div>

      {/* Wynik importu */}
      {importResult && (
        <div className="mb-4 p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-300">
          <b>Rejestr sprzedaży wczytany ✓</b> — nowych: <b>{importResult.inserted}</b>, zaktualizowanych: <b>{importResult.updated}</b>
          {importResult.skipped > 0 && <> · pominięto {importResult.skipped}</>}
          {' '}· zdeduplikowano z KSeF: {importResult.dedup_ksef}, z modułem: {importResult.dedup_module}
          {importResult.suspects > 0 && <> · <b className="text-amber-700 dark:text-amber-400">{importResult.suspects} podejrzanych duplikatów</b></>}
          {' '}· miesiące: {importResult.periods.join(', ')}
        </div>
      )}
      {importError && (
        <div className="mb-4 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">{importError}</div>
      )}
      {error && <div className="mb-4 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {data?.revenue_scope === 'company_wide' && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300">
          ⚠ Filtr jednostki dotyczy <b>tylko kosztów</b> — przychody (i przez to marże/EBITDA) liczone są dla całej spółki, bo rejestr sprzedaży nie ma podziału na jednostki.
        </div>
      )}

      {/* Sterowanie: rok / BU / widok */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-1 py-1">
          <button onClick={() => setYear(y => y - 1)} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"><ChevronLeft size={15} /></button>
          <span className="text-sm font-bold text-gray-800 dark:text-gray-100 px-2 tabular-nums">{year}</span>
          <button onClick={() => setYear(y => y + 1)} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"><ChevronRight size={15} /></button>
        </div>
        <select value={bu} onChange={e => setBU(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100">
          {BU_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
          {([['month', 'Miesiąc'], ['quarters', 'Kwartały'], ['trend', 'Trend 12 mies.']] as [ViewMode, string][]).map(([v, l]) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold ${view === v ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* Jakość danych */}
        {data && (
          <div className="flex items-center gap-2 text-xs">
            {data.quality.unallocated_ksef_invoices > 0 && (
              <span className="px-2 py-1 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-semibold" title="Faktury kosztowe KSeF bez przypisanej kategorii — nie są ujęte w kosztach RZiS">
                ⚠ {data.quality.unallocated_ksef_invoices} faktur bez kategorii
              </span>
            )}
            {data.quality.suspect_sales_records > 0 && (
              <span className="px-2 py-1 rounded-md bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 font-semibold" title="Rekordy Firmao dopasowane do KSeF tylko po kwocie — sprawdź, czy nie liczą się podwójnie">
                ⚠ {data.quality.suspect_sales_records} podejrzanych duplikatów
              </span>
            )}
            <span className="px-2 py-1 rounded-md bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 font-semibold" title="Miesiące z wgranym rejestrem Firmao">
              Firmao: {data.firmao_months.filter(m => m.startsWith(String(year))).length}/12 mies.
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="p-10 text-center text-gray-400 text-sm">Ładowanie…</div>
      ) : !data ? null : view === 'month' ? (
        <>
          {/* Wybór miesiąca */}
          <div className="flex gap-1 mb-4 flex-wrap">
            {MONTH_LABELS.map((l, i) => {
              const hasFirmao = data.firmao_months.includes(data.months[i].period)
              return (
                <button key={l} onClick={() => setMonthIdx(i)}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-bold ${monthIdx === i
                    ? 'bg-violet-600 text-white'
                    : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                  title={hasFirmao ? 'Przychody potwierdzone Firmao' : 'Przychody wstępne (KSeF + moduł)'}>
                  {l}{hasFirmao ? ' ✓' : ''}
                </button>
              )
            })}
          </div>

          {month && (
            <>
              {/* KPI miesiąca */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {[
                  ['Przychody', month.revenue, ''],
                  ['EBITDA', month.ebitda, `${fmt(month.ebitda_pct).replace(',00', '')}%`],
                  ['Marża brutto', month.gross_margin, `${fmt(month.gross_margin_pct).replace(',00', '')}%`],
                  ['Wynik netto', month.net_result, ''],
                ].map(([label, val, sub]) => (
                  <div key={label as string} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</div>
                    <div className={`text-lg font-bold mt-1 ${(val as number) < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{fmt0(val as number)} zł</div>
                    {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
                  </div>
                ))}
              </div>

              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 text-sm font-bold text-gray-800 dark:text-gray-100">
                  RZiS — {MONTH_LABELS[monthIdx]} {year}
                  {month.provisional && <span className="ml-2 text-xs font-semibold text-amber-600 dark:text-amber-400">przychody wstępne — wgraj rejestr Firmao</span>}
                </div>
                <PnlTable L={month} />
              </div>
            </>
          )}
        </>
      ) : view === 'quarters' ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-3 text-left font-semibold">Linia</th>
                  {data.quarters.map(q => <th key={q.quarter} className="px-4 py-3 text-right font-semibold">{q.quarter}</th>)}
                  <th className="px-4 py-3 text-right font-semibold text-violet-600 dark:text-violet-400">YTD</th>
                </tr>
              </thead>
              <tbody>
                {([
                  ['Przychody netto', (l: PnlLines) => l.revenue, true],
                  ['COGS', (l: PnlLines) => -l.cogs, false],
                  ['Marża brutto', (l: PnlLines) => l.gross_margin, true],
                  ['OPEX', (l: PnlLines) => -l.opex, false],
                  ['EBITDA', (l: PnlLines) => l.ebitda, true],
                  ['EBITDA %', (l: PnlLines) => l.ebitda_pct, false],
                  ['Amortyzacja', (l: PnlLines) => -l.depreciation, false],
                  ['EBIT', (l: PnlLines) => l.ebit, true],
                  ['Koszty finansowe', (l: PnlLines) => -l.financial_costs, false],
                  ['CIT', (l: PnlLines) => -l.cit, false],
                  ['Wynik netto', (l: PnlLines) => l.net_result, true],
                ] as [string, (l: PnlLines) => number, boolean][]).map(([label, get, bold]) => (
                  <tr key={label} className="border-b border-gray-50 dark:border-gray-800/60">
                    <td className={`px-4 py-2.5 ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'}`}>{label}</td>
                    {[...data.quarters, data.ytd].map((q, i) => {
                      const v = get(q)
                      const isPct = label === 'EBITDA %'
                      return (
                        <td key={i} className={`px-4 py-2.5 text-right tabular-nums ${bold ? 'font-bold' : ''} ${v < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'} ${i === 4 ? 'bg-violet-50/50 dark:bg-violet-950/20' : ''}`}>
                          {isPct ? `${fmt(v).replace(',00', '')}%` : `${fmt0(v)} zł`}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Trend 12 miesięcy */
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="text-sm font-bold text-gray-800 dark:text-gray-100 mb-4">Przychody i EBITDA miesięcznie — {year}</div>
          <div className="grid grid-cols-12 gap-2 items-end" style={{ height: 180 }}>
            {data.months.map((m, i) => (
              <div key={m.period} className="flex flex-col items-center justify-end h-full gap-1" title={`${MONTH_LABELS[i]}: przychód ${fmt0(m.revenue)} zł, EBITDA ${fmt0(m.ebitda)} zł`}>
                <div className="w-full flex items-end justify-center gap-0.5 flex-1">
                  <div className="w-2/5 bg-violet-400 dark:bg-violet-500 rounded-t" style={{ height: `${Math.max(2, m.revenue / trendMax * 100)}%` }} />
                  <div className={`w-2/5 rounded-t ${m.ebitda >= 0 ? 'bg-green-400 dark:bg-green-500' : 'bg-red-400 dark:bg-red-500'}`}
                    style={{ height: `${Math.max(2, Math.abs(m.ebitda) / trendMax * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-12 gap-2 mt-1">
            {MONTH_LABELS.map(l => <div key={l} className="text-center text-[10px] font-bold text-gray-400">{l}</div>)}
          </div>
          <div className="flex items-center gap-4 mt-3 text-xs text-gray-500 dark:text-gray-400">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-violet-400 dark:bg-violet-500 inline-block" /> Przychody</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-green-400 dark:bg-green-500 inline-block" /> EBITDA</span>
          </div>
          {/* Kompaktowa tabela pod wykresem */}
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="py-1.5 text-left font-semibold pr-2"></th>
                  {MONTH_LABELS.map(l => <th key={l} className="py-1.5 text-right font-semibold px-1">{l}</th>)}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {([['Przychody', (m: PnlLines) => m.revenue], ['EBITDA', (m: PnlLines) => m.ebitda], ['EBITDA %', (m: PnlLines) => m.ebitda_pct]] as [string, (m: PnlLines) => number][]).map(([label, get]) => (
                  <tr key={label} className="border-b border-gray-50 dark:border-gray-800/50">
                    <td className="py-1.5 pr-2 font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">{label}</td>
                    {data.months.map(m => {
                      const v = get(m)
                      return <td key={m.period} className={`py-1.5 px-1 text-right ${v < 0 ? 'text-red-500' : 'text-gray-700 dark:text-gray-300'}`}>
                        {label === 'EBITDA %' ? `${fmt(v).replace(',00', '')}%` : fmt0(v / 1000) + 'k'}
                      </td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {assetsOpen && <FixedAssetsModal onClose={() => { setAssetsOpen(false); load() }} />}
    </div>
  )
}

// ── Modal środków trwałych ────────────────────────────────────────────────────
function FixedAssetsModal({ onClose }: { onClose: () => void }) {
  const [assets, setAssets] = useState<FixedAsset[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [months, setMonths] = useState('60')
  const [start, setStart] = useState(new Date().toISOString().slice(0, 7))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const reload = () => financeApi.fixedAssets().then(setAssets).catch(() => {})
  useEffect(() => { reload() }, [])

  const add = async () => {
    const num = parseFloat(value.replace(/[\s  ]/g, '').replace(',', '.'))
    if (!name.trim() || isNaN(num) || num <= 0) { setErr('Podaj nazwę i wartość.'); return }
    setSaving(true); setErr('')
    try {
      await financeApi.addFixedAsset({ name: name.trim(), value_net: num, depreciation_months: parseInt(months) || 60, start_period: start })
      setName(''); setValue('')
      await reload()
    } catch { setErr('Nie udało się dodać środka trwałego.') }
    finally { setSaving(false) }
  }

  const remove = async (a: FixedAsset) => {
    if (!confirm(`Usunąć środek trwały "${a.name}"?`)) return
    await financeApi.deleteFixedAsset(a.id)
    await reload()
  }

  const inputCls = 'px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900">
          <div>
            <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">Środki trwałe</h2>
            <p className="text-xs text-gray-400">Amortyzacja liniowa — odpis trafia automatycznie do RZiS</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-4">
          {/* Dodawanie */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Nazwa</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="np. Samochód dostawczy" className={`${inputCls} w-full`} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Wartość netto</label>
              <input value={value} onChange={e => setValue(e.target.value)} placeholder="120000" inputMode="decimal" className={`${inputCls} w-full`} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Mies. amortyzacji</label>
              <input value={months} onChange={e => setMonths(e.target.value)} inputMode="numeric" className={`${inputCls} w-full`} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Od miesiąca</label>
              <input type="month" value={start} onChange={e => setStart(e.target.value)} className={`${inputCls} w-full`} />
            </div>
          </div>
          {err && <div className="text-xs text-red-600 dark:text-red-400 font-semibold">{err}</div>}
          <button onClick={add} disabled={saving}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold disabled:opacity-60">
            {saving ? 'Zapisuję…' : '+ Dodaj środek trwały'}
          </button>

          {/* Lista */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
            {assets.length === 0 ? (
              <div className="text-sm text-gray-400">Brak środków trwałych — amortyzacja w RZiS wynosi 0.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase text-gray-400 border-b border-gray-100 dark:border-gray-800">
                    <th className="py-2 text-left font-semibold">Nazwa</th>
                    <th className="py-2 text-right font-semibold">Wartość</th>
                    <th className="py-2 text-right font-semibold">Odpis/mies.</th>
                    <th className="py-2 text-right font-semibold">Okres</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map(a => (
                    <tr key={a.id} className="border-b border-gray-50 dark:border-gray-800/60">
                      <td className="py-2 text-gray-800 dark:text-gray-100 font-semibold">{a.name}</td>
                      <td className="py-2 text-right tabular-nums text-gray-700 dark:text-gray-200">{fmt(a.value_net)} zł</td>
                      <td className="py-2 text-right tabular-nums text-gray-700 dark:text-gray-200">{fmt(a.value_net / a.depreciation_months)} zł</td>
                      <td className="py-2 text-right text-xs text-gray-400">{a.start_period} · {a.depreciation_months} mies.</td>
                      <td className="py-2 text-right">
                        <button onClick={() => remove(a)} className="text-xs text-gray-400 hover:text-red-500 font-semibold">Usuń</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
