import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { dashboardApi } from '../../api/client'
import type { DashboardStats } from '../../types'
import { PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '../../types'
import { StatusBadge, TypeBadge, MarginBadge } from '../ui/StatusBadge'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

function fmtProfit(n: number) {
  const abs = Math.abs(n)
  const str = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(abs)
  return (n < 0 ? '−' : '+') + str
}

function ProfitBadge({ value, suffix = ' PLN' }: { value: number; suffix?: string }) {
  const isPos = value >= 0
  return (
    <span className={`font-semibold tabular-nums ${isPos ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
      {fmtProfit(value)}{suffix}
    </span>
  )
}

export default function DashboardView() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    dashboardApi.get()
      .then(setStats)
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Ładowanie...</div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-500">Błąd połączenia z backendem</div>
      </div>
    )
  }

  const marginColor = stats.average_margin_pct < 0
    ? 'text-red-500'
    : stats.average_margin_pct < 10
      ? 'text-orange-500'
      : stats.average_margin_pct < 25
        ? 'text-yellow-600'
        : 'text-green-600'

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Wszystkie projekty</div>
          <div className="text-3xl font-bold text-gray-800 dark:text-gray-100">{stats.total_projects}</div>
          <div className="text-xs text-gray-400 mt-1">{stats.active_projects} aktywnych</div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Łączna wartość ofert</div>
          <div className="text-2xl font-bold text-gray-800 dark:text-gray-100">{fmt(stats.total_budget)}</div>
          <div className="text-xs text-gray-400 mt-1">PLN (aktywne projekty)</div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Łączne koszty</div>
          <div className="text-2xl font-bold text-gray-800 dark:text-gray-100">{fmt(stats.total_costs)}</div>
          <div className="text-xs text-gray-400 mt-1">PLN (aktywne projekty)</div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Średnia marża</div>
          <div className={`text-3xl font-bold ${marginColor}`}>
            {stats.average_margin_pct.toFixed(1)}%
          </div>
          <div className="text-xs text-gray-400 mt-1">aktywne projekty</div>
        </div>
      </div>

      {/* Profit / Loss KPI */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className={`rounded-xl border p-5 ${stats.total_profit >= 0
          ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800'
          : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'}`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{stats.total_profit >= 0 ? '📈' : '📉'}</span>
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Zysk / Strata całkowita</div>
          </div>
          <div className={`text-3xl font-bold tabular-nums ${stats.total_profit >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {fmtProfit(stats.total_profit)} PLN
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Przychody {fmt(stats.total_payments || stats.total_budget)} PLN − Koszty {fmt(stats.total_costs)} PLN
          </div>
        </div>

        <div className={`rounded-xl border p-5 ${stats.daily_profit >= 0
          ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800'
          : 'bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800'}`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">📅</span>
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Zysk / Strata dzienna (łącznie)</div>
          </div>
          <div className={`text-3xl font-bold tabular-nums ${stats.daily_profit >= 0 ? 'text-blue-700 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'}`}>
            {fmtProfit(stats.daily_profit)} PLN/dzień
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Suma dziennych zysków z {stats.active_projects} aktywnych projektów
          </div>
        </div>
      </div>

      {/* Over budget alert */}
      {stats.over_budget_count > 0 && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">🚨</span>
            <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">
              Projekty z przekroczonym budżetem ({stats.over_budget_count})
            </h2>
          </div>
          <div className="space-y-2">
            {stats.over_budget_projects.map(p => (
              <div
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-lg px-3 py-2 cursor-pointer hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors border border-red-100 dark:border-red-900"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <StatusBadge status={p.status} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{p.name}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{p.client_name}</div>
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-4">
                  <div className="text-sm font-semibold text-red-600 dark:text-red-400">
                    {fmt(p.cost_total)} PLN kosztów
                  </div>
                  <div className="text-xs text-gray-500">
                    budżet: {fmt(p.budget_amount)} PLN
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* By status */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
            <span>📊</span> Projekty wg statusu
          </h2>
          <div className="space-y-2">
            {Object.entries(stats.by_status).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <StatusBadge status={status as any} />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{count}</span>
              </div>
            ))}
            {Object.keys(stats.by_status).length === 0 && (
              <div className="text-sm text-gray-400">Brak projektów</div>
            )}
          </div>
        </div>

        {/* By type */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
            <span>🏷️</span> Projekty wg typu
          </h2>
          <div className="space-y-2">
            {Object.entries(stats.by_type).map(([type, count]) => (
              <div key={type} className="flex items-center justify-between">
                <TypeBadge type={type as any} />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{count}</span>
              </div>
            ))}
            {Object.keys(stats.by_type).length === 0 && (
              <div className="text-sm text-gray-400">Brak projektów</div>
            )}
          </div>
        </div>
      </div>

      {/* Profit / Loss per project table */}
      {stats.profit_by_project.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
            <span>💰</span> Zysk / Strata per projekt (aktywne)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="text-left py-2 pr-4">Projekt</th>
                  <th className="text-right py-2 pr-4">Przychód</th>
                  <th className="text-right py-2 pr-4">Koszty</th>
                  <th className="text-right py-2 pr-4">Zysk/Strata</th>
                  <th className="text-right py-2 pr-4">Marża</th>
                  <th className="text-right py-2">Dziennie</th>
                </tr>
              </thead>
              <tbody>
                {stats.profit_by_project.map(p => (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/projects/${p.id}`)}
                    className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 pr-4">
                      <div className="font-medium text-gray-800 dark:text-gray-100">{p.name}</div>
                      <div className="text-xs text-gray-400">{p.client_name} · {p.days_running} dni</div>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-gray-600 dark:text-gray-400 tabular-nums">
                      {fmt(p.payments_total > 0 ? p.payments_total : p.budget_amount)}
                    </td>
                    <td className="py-2.5 pr-4 text-right text-gray-600 dark:text-gray-400 tabular-nums">
                      {fmt(p.cost_total)}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <ProfitBadge value={p.profit_pln} />
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className={`text-xs font-semibold ${p.profit_pct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                        {p.profit_pct >= 0 ? '+' : ''}{p.profit_pct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2.5 text-right">
                      <ProfitBadge value={p.daily_profit} suffix=" PLN" />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 dark:border-gray-700 font-semibold text-gray-700 dark:text-gray-300">
                  <td className="pt-2 pr-4 text-xs">SUMA</td>
                  <td className="pt-2 pr-4 text-right tabular-nums text-sm">{fmt(stats.total_payments || stats.total_budget)}</td>
                  <td className="pt-2 pr-4 text-right tabular-nums text-sm">{fmt(stats.total_costs)}</td>
                  <td className="pt-2 pr-4 text-right"><ProfitBadge value={stats.total_profit} /></td>
                  <td className="pt-2 pr-4 text-right">
                    <span className={`text-xs font-bold ${stats.average_margin_pct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                      {stats.average_margin_pct >= 0 ? '+' : ''}{stats.average_margin_pct.toFixed(1)}%
                    </span>
                  </td>
                  <td className="pt-2 text-right"><ProfitBadge value={stats.daily_profit} suffix=" PLN" /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Recent projects */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
          <span>🕐</span> Ostatnie projekty
          <button
            onClick={() => navigate('/projects')}
            className="ml-auto text-xs text-violet-600 dark:text-violet-400 hover:underline"
          >
            Zobacz wszystkie →
          </button>
        </h2>
        {stats.recent_projects.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 text-center">
            Brak projektów. <button onClick={() => navigate('/projects')} className="text-violet-600 dark:text-violet-400 hover:underline">Dodaj pierwszy projekt →</button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="text-left py-2 pr-4">Projekt</th>
                  <th className="text-left py-2 pr-4">Typ</th>
                  <th className="text-left py-2 pr-4">Status</th>
                  <th className="text-right py-2 pr-4">Budżet</th>
                  <th className="text-right py-2 pr-4">Koszty</th>
                  <th className="text-right py-2">Marża</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent_projects.map(p => (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/projects/${p.id}`)}
                    className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 pr-4">
                      <div className="font-medium text-gray-800 dark:text-gray-100">{p.name}</div>
                      <div className="text-xs text-gray-400">{p.client_name}</div>
                    </td>
                    <td className="py-2.5 pr-4"><TypeBadge type={p.project_type} /></td>
                    <td className="py-2.5 pr-4"><StatusBadge status={p.status} /></td>
                    <td className="py-2.5 pr-4 text-right text-gray-700 dark:text-gray-300">{fmt(p.budget_amount)}</td>
                    <td className="py-2.5 pr-4 text-right text-gray-700 dark:text-gray-300">{fmt(p.cost_total)}</td>
                    <td className="py-2.5 text-right"><MarginBadge pct={p.margin_pct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
