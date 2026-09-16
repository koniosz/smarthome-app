// Strona „Kondycja firmy” — jednym rzutem oka: czy firma zarabia, gdzie idą pieniądze, czy starczy gotówki.
// Dane: GET /finance/health (sekcja A), /finance/cashflow (B.5), /finance/inventory (C).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Mail, Eye, Settings, RefreshCw } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { healthApi, inventoryApi, type HealthResponse, type InventoryResponse, type ReportSettings } from '../api/health'
import { defaultPeriod, shiftPeriod, toMonth, toQuarter, kindOf, periodLabel, periodRange, yearOf, isFuture } from '../components/health/period'
import { btnPrimary, btnSecondary, btnGhost, ErrorBox } from '../components/health/ui'
import { fmt0 } from '../components/health/format'
import StatusCard from '../components/health/StatusCard'
import Tiles from '../components/health/Tiles'
import CompareCard from '../components/health/CompareCard'
import TrendChart from '../components/health/TrendChart'
import CostBreakdown from '../components/health/CostBreakdown'
import TaxesCard from '../components/health/TaxesCard'
import ChecksList from '../components/health/ChecksList'
import InventoryCard from '../components/health/InventoryCard'
import CashForecastCard from '../components/health/CashForecastCard'
import ReportSendModal from '../components/health/ReportSendModal'
import ReportPreviewModal from '../components/health/ReportPreviewModal'
import ReportSettingsModal from '../components/health/ReportSettingsModal'

type Modal = null | 'send' | 'preview' | 'settings'

export default function KondycjaPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'
  const canSee = isAdmin || !!user?.can_view_payments

  const [period, setPeriod] = useState(() => defaultPeriod())
  const kind = kindOf(period)
  const [data, setData] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inventory, setInventory] = useState<InventoryResponse | null>(null)
  // Ustawienia raportu — karta „Magazyn” musi wiedzieć, czy zmiana stanu magazynu wchodzi do RZiS (inventory_in_pnl);
  // HealthResponse tego nie zwraca, a przy wyłączonej opcji kafle/RZiS liczą pełne zakupy bez korekty magazynowej.
  const [settings, setSettings] = useState<ReportSettings | null>(null)
  const [modal, setModal] = useState<Modal>(null)

  // Sekwencer żądań — odpowiedź dla nieaktualnego okresu jest ignorowana
  const seq = useRef(0)
  const invSeq = useRef(0)
  const settingsSeq = useRef(0)

  const load = useCallback(async () => {
    const my = ++seq.current
    setLoading(true); setError('')
    try {
      const d = await healthApi.get(period)
      if (my !== seq.current) return
      setData(d)
    } catch (e: any) {
      if (my !== seq.current) return
      setError(e?.response?.data?.error ?? 'Nie udało się policzyć kondycji firmy.')
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [period])

  useEffect(() => { if (canSee) load() }, [canSee, load])

  // Ustawienia raportu (GET dostępny dla requirePayments, nie tylko admina) — cicho: brak = nieznany tryb magazynu
  const loadSettings = useCallback(() => {
    const my = ++settingsSeq.current
    healthApi.reportSettings()
      .then(s => { if (my === settingsSeq.current) setSettings(s) })
      .catch(() => { if (my === settingsSeq.current) setSettings(null) })
  }, [])
  useEffect(() => { if (canSee) loadSettings() }, [canSee, loadSettings])

  // Magazyn — per rok (cicho: brak danych = brak karty)
  const year = yearOf(period)
  useEffect(() => {
    if (!canSee) return
    const my = ++invSeq.current
    inventoryApi.get(year)
      .then(r => { if (my === invSeq.current) setInventory(r) })
      .catch(() => { if (my === invSeq.current) setInventory(null) })
  }, [canSee, year])

  const switchKind = (k: 'monthly' | 'quarterly') => {
    if (k === kind) return
    setPeriod(p => (k === 'quarterly' ? toQuarter(p) : toMonth(p)))
  }
  const next = shiftPeriod(period, 1)
  const canGoNext = !isFuture(next)

  if (!canSee) {
    return <div className="p-8 text-center text-gray-500 dark:text-gray-400">Brak dostępu. Poproś administratora o nadanie uprawnienia (💳).</div>
  }

  const range = data && data.period === period ? data.range : periodRange(period)
  const label = data && data.period === period ? data.label : periodLabel(period)
  const totalCosts = data ? data.tiles.costs : 0

  return (
    <div className="p-6 max-w-[1150px] mx-auto" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {/* Nagłówek */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Kondycja firmy</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Czy zarabiamy, na co idą pieniądze i czy starczy gotówki — bez księgowego żargonu.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setModal('send')} className={btnPrimary}><Mail size={15} /> Wyślij raport teraz</button>
          <button onClick={() => setModal('preview')} className={btnSecondary}><Eye size={15} /> Podgląd raportu</button>
          <button onClick={() => setModal('settings')} className={btnSecondary} title={isAdmin ? 'Ustawienia wysyłki raportu' : 'Podgląd ustawień (zmienia administrator)'}>
            <Settings size={15} /> Ustawienia raportu
          </button>
          <button onClick={() => navigate('/rentownosc')} className={btnGhost}>Pełny RZiS →</button>
        </div>
      </div>

      {/* Sterowanie okresem */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
          {([['monthly', 'Miesiąc'], ['quarterly', 'Kwartał']] as const).map(([k, l]) => (
            <button key={k} onClick={() => switchKind(k)}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold ${kind === k ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-1 py-1">
          <button onClick={() => setPeriod(p => shiftPeriod(p, -1))} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label="Poprzedni okres"><ChevronLeft size={15} /></button>
          <span className="text-sm font-bold text-gray-800 dark:text-gray-100 px-2 min-w-[150px] text-center">{label}</span>
          <button onClick={() => canGoNext && setPeriod(next)} disabled={!canGoNext} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30" aria-label="Następny okres"><ChevronRight size={15} /></button>
        </div>
        <button onClick={() => setPeriod(defaultPeriod())} className="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline">ostatni miesiąc</button>
        <div className="flex-1" />
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {loading ? 'liczę…' : 'odśwież'}
        </button>
      </div>

      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}

      {loading && !data ? (
        <div className="p-10 text-center text-gray-400 text-sm">Liczę kondycję firmy…</div>
      ) : !data ? null : (
        <div className={`space-y-4 ${loading ? 'opacity-60 pointer-events-none' : ''}`}>
          <StatusCard data={data} />
          <Tiles data={data} />

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1"><CompareCard data={data} /></div>
            <div className="lg:col-span-2"><TrendChart trend={data.trend} highlight={range} /></div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <CostBreakdown items={data.cost_breakdown} total={totalCosts} />
            <div className="space-y-4">
              <TaxesCard taxes={data.taxes} yearLabel={String(year)} />
              {inventory && inventory.year === year && (
                <InventoryCard inv={inventory} range={range} inPnl={settings?.inventory_in_pnl} />
              )}
            </div>
          </div>

          <ChecksList checks={data.checks} />

          {/* Należności / zobowiązania — kontekst dla prognozy */}
          <div className="grid md:grid-cols-2 gap-3">
            {[
              { key: 'rec', label: 'Klienci są nam winni', value: data.cash.receivables, overdue: data.cash.overdue_receivables, hint: 'Faktury sprzedażowe, za które klienci jeszcze nie zapłacili.' },
              { key: 'pay', label: 'My jesteśmy winni dostawcom', value: data.cash.payables, overdue: data.cash.overdue_payables, hint: 'Faktury kosztowe z KSeF, których jeszcze nie opłaciliśmy.' },
            ].map(b => (
              <div key={b.key} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{b.label}</div>
                  <div className="text-lg font-bold tabular-nums text-gray-800 dark:text-gray-100">{fmt0(b.value)} zł</div>
                  <div className="text-xs text-gray-400 dark:text-gray-500 leading-snug">{b.hint}</div>
                </div>
                {b.overdue > 0 && (
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs text-red-500 font-semibold">z tego po terminie</div>
                    <div className="text-sm font-bold tabular-nums text-red-600 dark:text-red-400">{fmt0(b.overdue)} zł</div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <CashForecastCard />

          <div className="text-xs text-gray-400 pb-4">
            Liczby zarządcze, netto (bez VAT). Ostateczne rozliczenia robi biuro rachunkowe. Pełne zestawienie: <button onClick={() => navigate('/rentownosc')} className="text-violet-600 dark:text-violet-400 font-semibold hover:underline">Rentowność (RZiS) →</button>
          </div>
        </div>
      )}

      {modal === 'send' && <ReportSendModal period={period} onClose={() => setModal(null)} />}
      {modal === 'preview' && <ReportPreviewModal kind={kind} period={period} onClose={() => setModal(null)} onSend={() => setModal('send')} />}
      {modal === 'settings' && <ReportSettingsModal isAdmin={!!isAdmin} onClose={saved => { setModal(null); if (saved) { load(); loadSettings() } }} />}
    </div>
  )
}
