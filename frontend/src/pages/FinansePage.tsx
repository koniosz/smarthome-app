import { useState, useEffect, useCallback } from 'react'
import { ksefApi } from '../api/client'
import type { PnLReport, PnLCategoryData, KsefInvoiceAllocation } from '../types'

function fmt(n: number, digits = 2) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
}
function pct(n: number) { return `${n >= 0 ? '+' : ''}${fmt(n, 1)}%` }
function pctColor(n: number) {
  if (n >= 20) return 'text-green-600 dark:text-green-400'
  if (n >= 0)  return 'text-yellow-600 dark:text-yellow-400'
  return 'text-red-600 dark:text-red-400'
}

// ── Taxonomy labels (mirrored from AllocationPanel) ──────────────────────────
const COST_TAXONOMY: Record<string, { label: string; icon: string; subcategories: Record<string, string> }> = {
  cogs:       { label: 'COGS — Koszt własny sprzedaży', icon: '🏗️', subcategories: {
    hardware: 'Sprzęt', subcontractor: 'Podwykonawca',
    installation_material: 'Materiały instalacyjne', labor: 'Robocizna własna',
  }},
  sales:      { label: 'Sprzedaż i Marketing', icon: '📣', subcategories: {
    advertising: 'Reklama', commission: 'Prowizja', crm_software: 'CRM / narzędzia', marketing: 'Marketing ogólny',
  }},
  ga:         { label: 'G&A — Ogólno-administracyjne', icon: '🏢', subcategories: {
    rent: 'Czynsz', utilities: 'Media', salary_admin: 'Wynagrodzenia admin',
    software: 'Oprogramowanie', accounting: 'Księgowość', legal: 'Prawne', office_supplies: 'Biurowe',
  }},
  operations: { label: 'Koszty Operacyjne', icon: '⚙️', subcategories: {
    car_fuel: 'Paliwo', car_service: 'Serwis pojazdów', tools: 'Narzędzia',
    insurance: 'Ubezpieczenie', travel: 'Podróże',
  }},
  financial:  { label: 'Koszty Finansowe', icon: '💳', subcategories: {
    bank_fee: 'Opłaty bankowe', interest: 'Odsetki', leasing: 'Leasing', fx: 'Różnice kursowe',
  }},
}

const BU_LABELS: Record<string, string> = {
  shc: 'Smart Home Center', gatelynk: 'GateLynk', shared: 'Wspólne', all: 'Wszystkie',
}

// ── P&L Row ───────────────────────────────────────────────────────────────────
function PnLRow({
  label, amount, pct: pctVal, indent = 0, bold = false, highlight = '', note, expandable = false,
  expanded = false, onToggle, children,
}: {
  label: string; amount: number; pct?: number; indent?: number
  bold?: boolean; highlight?: string; note?: string; expandable?: boolean
  expanded?: boolean; onToggle?: () => void; children?: React.ReactNode
}) {
  const isNegative = amount < 0
  return (
    <>
      <tr
        className={`border-b border-gray-100 dark:border-gray-800 ${
          highlight === 'green' ? 'bg-green-50/60 dark:bg-green-950/20' :
          highlight === 'red'   ? 'bg-red-50/60 dark:bg-red-950/10' :
          highlight === 'blue'  ? 'bg-blue-50/60 dark:bg-blue-950/10' :
          highlight === 'amber' ? 'bg-amber-50/60 dark:bg-amber-950/10' :
          ''
        } ${expandable ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40' : ''}`}
        onClick={expandable ? onToggle : undefined}
      >
        <td className="py-2 pr-4" style={{ paddingLeft: `${12 + indent * 20}px` }}>
          <div className="flex items-center gap-1.5">
            {expandable && (
              <span className="text-gray-400 text-xs">{expanded ? '▾' : '▸'}</span>
            )}
            <span className={`text-sm ${bold ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`}>
              {label}
            </span>
            {note && <span className="text-xs text-gray-400 dark:text-gray-500">{note}</span>}
          </div>
        </td>
        <td className="py-2 text-right pr-6 tabular-nums">
          <span className={`text-sm ${bold ? 'font-semibold' : ''} ${isNegative ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-200'}`}>
            {fmt(amount)} PLN
          </span>
        </td>
        <td className="py-2 text-right pr-4 tabular-nums w-20">
          {pctVal !== undefined && (
            <span className={`text-xs font-medium ${pctColor(pctVal)}`}>
              {pct(pctVal)}
            </span>
          )}
        </td>
      </tr>
      {expanded && children}
    </>
  )
}

function SubcategoryRows({ data, catKey, revenue }: { data: PnLCategoryData; catKey: string; revenue: number }) {
  const catDef = COST_TAXONOMY[catKey]
  if (!catDef || data.total === 0) return null
  return (
    <>
      {Object.entries(data.subcategories).map(([sub, amt]) => {
        if (amt === 0) return null
        const subLabel = catDef.subcategories[sub] ?? sub
        return (
          <PnLRow
            key={sub}
            label={subLabel}
            amount={-amt}
            pct={revenue > 0 ? -(amt / revenue) * 100 : 0}
            indent={2}
          />
        )
      })}
      {/* By business unit */}
      <tr className="border-b border-gray-100 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-800/20">
        <td className="py-1.5 pr-4" style={{ paddingLeft: '72px' }}>
          <div className="flex gap-3">
            {Object.entries(data.by_bu).map(([bu, amt]) => amt > 0 && (
              <span key={bu} className="text-[11px] text-gray-500 dark:text-gray-500">
                {BU_LABELS[bu] ?? bu}: <span className="font-medium text-gray-600 dark:text-gray-400">{fmt(amt)}</span>
              </span>
            ))}
          </div>
        </td>
        <td /><td />
      </tr>
    </>
  )
}

// ── Drill-down table ──────────────────────────────────────────────────────────
function DrillDown({ allocations, catFilter }: { allocations: KsefInvoiceAllocation[]; catFilter: string }) {
  const filtered = allocations.filter(a => (a.cost_category ?? 'cogs') === catFilter)
  if (filtered.length === 0) return <p className="text-xs text-gray-400 px-4 py-2">Brak alokacji</p>
  return (
    <div className="overflow-x-auto mt-2 mb-4 mx-4">
      <table className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
            <th className="text-left px-3 py-1.5">Faktura / Sprzedawca</th>
            <th className="text-left px-3 py-1.5">Podkategoria</th>
            <th className="text-left px-3 py-1.5">Jednostka</th>
            <th className="text-left px-3 py-1.5">Data</th>
            <th className="text-right px-3 py-1.5">Kwota</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(a => {
            const catDef = COST_TAXONOMY[a.cost_category ?? 'cogs']
            const subLabel = catDef?.subcategories[a.subcategory ?? ''] ?? a.subcategory ?? '—'
            return (
              <tr key={a.id} className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <td className="px-3 py-1.5">
                  <div className="font-medium text-gray-700 dark:text-gray-300">
                    {a.invoice?.seller_name ?? (a.project?.name ?? '—')}
                  </div>
                  {a.invoice?.invoice_number && <div className="text-gray-400">{a.invoice.invoice_number}</div>}
                  {a.notes && <div className="text-gray-400 italic">{a.notes}</div>}
                </td>
                <td className="px-3 py-1.5 text-gray-500">{subLabel}</td>
                <td className="px-3 py-1.5 text-gray-500">{BU_LABELS[a.business_unit ?? 'shc'] ?? a.business_unit}</td>
                <td className="px-3 py-1.5 text-gray-500">{a.invoice?.invoice_date ?? a.created_at?.slice(0, 10) ?? '—'}</td>
                <td className="px-3 py-1.5 text-right font-medium text-gray-800 dark:text-gray-200 tabular-nums">
                  {fmt(a.amount)} {a.invoice?.currency ?? 'PLN'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FinansePage() {
  const thisYear = new Date().getFullYear()
  const [dateFrom, setDateFrom] = useState(`${thisYear}-01-01`)
  const [dateTo,   setDateTo]   = useState(`${thisYear}-12-31`)
  const [bu,       setBU]       = useState('all')
  const [loading,  setLoading]  = useState(false)
  const [report,   setReport]   = useState<PnLReport | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [expandedCat, setExpandedCat] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await ksefApi.pnl({ dateFrom, dateTo, business_unit: bu === 'all' ? undefined : bu })
      setReport(data)
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message)
    } finally { setLoading(false) }
  }, [dateFrom, dateTo, bu])

  useEffect(() => { load() }, [load])

  const toggleCat = (cat: string) => setExpandedCat(p => p === cat ? null : cat)

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">📊 Raport P&amp;L / EBITDA</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Zarządcze koszty i marżowość według klasyfikacji CFO
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Business unit filter */}
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            {(['all', 'shc', 'gatelynk', 'shared'] as const).map(b => (
              <button
                key={b}
                onClick={() => setBU(b)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  bu === b
                    ? 'bg-violet-600 text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                {BU_LABELS[b]}
              </button>
            ))}
          </div>
          {/* Date range */}
          <input
            type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100"
          />
          <span className="text-gray-400 text-xs">—</span>
          <input
            type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100"
          />
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50"
          >
            {loading ? 'Ładowanie…' : '🔄 Odśwież'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-sm text-red-700 dark:text-red-400">
          ❌ {error}
        </div>
      )}

      {report && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Przychody" value={report.revenue} sub={`${report.payment_count} płatności`} color="blue" />
            <KpiCard label="Marża brutto" value={report.gross_margin} sub={pct(report.gross_margin_pct)} color={report.gross_margin >= 0 ? 'green' : 'red'} />
            <KpiCard label="EBITDA" value={report.ebitda} sub={pct(report.ebitda_pct)} color={report.ebitda >= 0 ? 'green' : 'red'} />
            <KpiCard label="EBIT" value={report.ebit} sub={pct(report.ebit_pct)} color={report.ebit >= 0 ? 'green' : 'red'} />
          </div>

          {/* P&L Table */}
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                Rachunek Zysków i Strat — {BU_LABELS[report.business_unit]} ({report.period.from ?? '—'} → {report.period.to ?? '—'})
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Kliknij wiersz kategorii, aby rozwinąć pozycje i faktury. Łącznie {report.allocation_count} alokacji.
              </p>
            </div>

            <table className="w-full">
              <colgroup>
                <col />
                <col className="w-44" />
                <col className="w-20" />
              </colgroup>
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  <th className="text-left py-2 px-4">Pozycja</th>
                  <th className="text-right py-2 pr-6">Kwota</th>
                  <th className="text-right py-2 pr-4">% przychodów</th>
                </tr>
              </thead>
              <tbody>
                {/* Revenue */}
                <PnLRow
                  label="🟢 Przychody ze sprzedaży"
                  amount={report.revenue}
                  pct={100}
                  bold
                  highlight="blue"
                />

                {/* COGS */}
                <PnLRow
                  label={`${COST_TAXONOMY.cogs.icon} COGS — Koszt własny sprzedaży`}
                  amount={-report.cogs.total}
                  pct={report.revenue > 0 ? -(report.cogs.total / report.revenue) * 100 : 0}
                  expandable
                  expanded={expandedCat === 'cogs'}
                  onToggle={() => toggleCat('cogs')}
                  bold
                />
                {expandedCat === 'cogs' && (
                  <>
                    <SubcategoryRows data={report.cogs} catKey="cogs" revenue={report.revenue} />
                    <tr><td colSpan={3}><DrillDown allocations={report.allocations} catFilter="cogs" /></td></tr>
                  </>
                )}

                {/* Gross Margin */}
                <PnLRow
                  label="📐 Marża brutto (Gross Margin)"
                  amount={report.gross_margin}
                  pct={report.gross_margin_pct}
                  bold
                  highlight={report.gross_margin >= 0 ? 'green' : 'red'}
                />

                {/* OPEX separator */}
                <tr>
                  <td colSpan={3} className="py-1 px-4">
                    <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
                      — Koszty operacyjne (OPEX) —
                    </div>
                  </td>
                </tr>

                {/* Sales */}
                <PnLRow
                  label={`${COST_TAXONOMY.sales.icon} Sprzedaż i Marketing`}
                  amount={-report.sales.total}
                  pct={report.revenue > 0 ? -(report.sales.total / report.revenue) * 100 : 0}
                  expandable
                  expanded={expandedCat === 'sales'}
                  onToggle={() => toggleCat('sales')}
                />
                {expandedCat === 'sales' && (
                  <>
                    <SubcategoryRows data={report.sales} catKey="sales" revenue={report.revenue} />
                    <tr><td colSpan={3}><DrillDown allocations={report.allocations} catFilter="sales" /></td></tr>
                  </>
                )}

                {/* G&A */}
                <PnLRow
                  label={`${COST_TAXONOMY.ga.icon} G&A — Ogólno-administracyjne`}
                  amount={-report.ga.total}
                  pct={report.revenue > 0 ? -(report.ga.total / report.revenue) * 100 : 0}
                  expandable
                  expanded={expandedCat === 'ga'}
                  onToggle={() => toggleCat('ga')}
                />
                {expandedCat === 'ga' && (
                  <>
                    <SubcategoryRows data={report.ga} catKey="ga" revenue={report.revenue} />
                    <tr><td colSpan={3}><DrillDown allocations={report.allocations} catFilter="ga" /></td></tr>
                  </>
                )}

                {/* Operations */}
                <PnLRow
                  label={`${COST_TAXONOMY.operations.icon} Koszty Operacyjne`}
                  amount={-report.operations.total}
                  pct={report.revenue > 0 ? -(report.operations.total / report.revenue) * 100 : 0}
                  expandable
                  expanded={expandedCat === 'operations'}
                  onToggle={() => toggleCat('operations')}
                />
                {expandedCat === 'operations' && (
                  <>
                    <SubcategoryRows data={report.operations} catKey="operations" revenue={report.revenue} />
                    <tr><td colSpan={3}><DrillDown allocations={report.allocations} catFilter="operations" /></td></tr>
                  </>
                )}

                {/* OPEX total */}
                <PnLRow
                  label="Σ OPEX"
                  amount={-report.opex}
                  pct={report.revenue > 0 ? -(report.opex / report.revenue) * 100 : 0}
                  indent={0}
                  note="(Sprzedaż + G&A + Operacje)"
                />

                {/* EBITDA */}
                <PnLRow
                  label="⚡ EBITDA"
                  amount={report.ebitda}
                  pct={report.ebitda_pct}
                  bold
                  highlight={report.ebitda >= 0 ? 'green' : 'red'}
                />

                {/* Financial */}
                <PnLRow
                  label={`${COST_TAXONOMY.financial.icon} Koszty Finansowe`}
                  amount={-report.financial.total}
                  pct={report.revenue > 0 ? -(report.financial.total / report.revenue) * 100 : 0}
                  expandable
                  expanded={expandedCat === 'financial'}
                  onToggle={() => toggleCat('financial')}
                />
                {expandedCat === 'financial' && (
                  <>
                    <SubcategoryRows data={report.financial} catKey="financial" revenue={report.revenue} />
                    <tr><td colSpan={3}><DrillDown allocations={report.allocations} catFilter="financial" /></td></tr>
                  </>
                )}

                {/* EBIT */}
                <PnLRow
                  label="🏁 EBIT (Wynik operacyjny)"
                  amount={report.ebit}
                  pct={report.ebit_pct}
                  bold
                  highlight={report.ebit >= 0 ? 'green' : 'red'}
                />
              </tbody>
            </table>
          </div>

          {/* Revenue by project breakdown */}
          {Object.keys(report.revenue_by_project).length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-5">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">💰 Przychody według projektów</h3>
              <div className="space-y-2">
                {Object.entries(report.revenue_by_project)
                  .sort(([, a], [, b]) => b - a)
                  .map(([name, amount]) => (
                    <div key={name} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{name}</span>
                          <span className="text-xs font-medium text-gray-800 dark:text-gray-200 tabular-nums ml-2 shrink-0">
                            {fmt(amount)} PLN
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: report.revenue > 0 ? `${(amount / report.revenue) * 100}%` : '0%' }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Info note */}
          {report.allocation_count === 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
              ℹ️ Brak alokacji faktur KSeF w wybranym okresie. Dodaj alokacje w zakładce KSeF → Faktury, aby zobaczyć koszty w raporcie.
            </div>
          )}

          {/* Legenda kategorii */}
          <CategoryLegend />
        </>
      )}

      {loading && !report && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-4 border-violet-500 border-t-transparent rounded-full" />
        </div>
      )}
    </div>
  )
}

// ── Category Legend ───────────────────────────────────────────────────────────
const LEGEND_DATA: Array<{
  key: string; icon: string; label: string; when: string; examples: string; color: string
}> = [
  {
    key: 'cogs', icon: '🏗️', label: 'COGS — Koszt własny sprzedaży',
    color: 'border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20',
    when: 'Koszty bezpośrednio związane z realizacją projektu dla klienta',
    examples: 'Sprzęt KNX / HDL / Control4, materiały instalacyjne, podwykonawcy robót elektycznych',
  },
  {
    key: 'sales', icon: '📣', label: 'Sprzedaż i Marketing',
    color: 'border-pink-200 dark:border-pink-800 bg-pink-50/60 dark:bg-pink-950/20',
    when: 'Koszty pozyskiwania klientów i promocji firmy',
    examples: 'Facebook Ads, Google Ads, prowizja dla pośrednika, HubSpot CRM, targi branżowe',
  },
  {
    key: 'ga', icon: '🏢', label: 'G&A — Ogólno-administracyjne',
    color: 'border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/20',
    when: 'Koszty utrzymania biura, administracji i zarządzania firmą',
    examples: 'Czynsz biura, księgowość, licencje (Microsoft 365), system urlopowy, usługi prawne, materiały biurowe',
  },
  {
    key: 'operations', icon: '⚙️', label: 'Koszty Operacyjne',
    color: 'border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-950/20',
    when: 'Koszty codziennego funkcjonowania — transport, narzędzia, ubezpieczenia',
    examples: 'Paliwo, serwis samochodów firmowych, narzędzia monterskie, ubezpieczenie floty, delegacje',
  },
  {
    key: 'financial', icon: '💳', label: 'Koszty Finansowe',
    color: 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20',
    when: 'Koszty wynikające z obsługi finansowej, kredytów i instrumentów bankowych',
    examples: 'Prowizje i opłaty bankowe, odsetki od kredytu obrotowego, raty leasingowe, różnice kursowe',
  },
]

const BU_LEGEND = [
  { label: 'Smart Home Center (SHC)', desc: 'Projekty inteligentnych instalacji dla klientów końcowych — KNX, HDL, Hikvision, Satel' },
  { label: 'GateLynk', desc: 'Platforma / produkt SaaS, marketing cyfrowy, sprzedaż online' },
  { label: 'Wspólne', desc: 'Koszty wspólne obu działalności — biuro, administracja, kadry, finanse' },
]

function CategoryLegend() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">📖 Legenda kategorii CFO</span>
          <span className="text-xs text-gray-400">— czego dotyczy każda kategoria</span>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
          {/* Cost categories */}
          <div className="p-5 space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Typy kosztów (wpływają na P&amp;L)</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {LEGEND_DATA.map(item => (
                <div key={item.key} className={`rounded-xl border p-3 ${item.color}`}>
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
                    {item.icon} {item.label}
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 mb-1.5">{item.when}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500 italic">
                    Przykłady: {item.examples}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Business units */}
          <div className="p-5 space-y-3">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Jednostki biznesowe (Business Unit)</h3>
            <div className="grid gap-2 sm:grid-cols-3">
              {BU_LEGEND.map(bu => (
                <div key={bu.label} className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 bg-gray-50/60 dark:bg-gray-800/30">
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">{bu.label}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{bu.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* P&L flow */}
          <div className="px-5 py-4 bg-gray-50/60 dark:bg-gray-800/20">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Schemat rachunku P&amp;L</h3>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {[
                { label: 'Przychody', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
                { label: '− COGS', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
                { label: '= Marża brutto', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
                { label: '− Sales − G&A − Operacje', color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
                { label: '= EBITDA', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
                { label: '− Koszty finansowe', color: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400' },
                { label: '= EBIT', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
              ].map(item => (
                <span key={item.label} className={`px-2 py-0.5 rounded-full font-medium ${item.color}`}>
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function KpiCard({ label, value, sub, color }: { label: string; value: number; sub: string; color: string }) {
  const colors: Record<string, string> = {
    blue:  'bg-blue-50 dark:bg-blue-950/30 border-blue-100 dark:border-blue-800',
    green: 'bg-green-50 dark:bg-green-950/30 border-green-100 dark:border-green-800',
    red:   'bg-red-50 dark:bg-red-950/30 border-red-100 dark:border-red-800',
    amber: 'bg-amber-50 dark:bg-amber-950/30 border-amber-100 dark:border-amber-800',
  }
  const textColors: Record<string, string> = {
    blue:  'text-blue-700 dark:text-blue-300',
    green: 'text-green-700 dark:text-green-400',
    red:   'text-red-600 dark:text-red-400',
    amber: 'text-amber-700 dark:text-amber-400',
  }
  return (
    <div className={`rounded-xl border p-4 ${colors[color] ?? colors.blue}`}>
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-lg font-bold mt-1 tabular-nums ${textColors[color] ?? ''}`}>
        {fmt(value)} PLN
      </p>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>
    </div>
  )
}
