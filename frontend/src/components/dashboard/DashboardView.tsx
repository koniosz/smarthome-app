import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { dashboardApi } from '../../api/client'
import type { DashboardStats, CarAlert, EmployeeAlert } from '../../types'
import { PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '../../types'
import { StatusBadge, TypeBadge, MarginBadge } from '../ui/StatusBadge'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
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

      {/* Due invoices alert */}
      {stats.invoices_due && stats.invoices_due.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-red-200 dark:border-red-800 p-5">
          <h2 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-3 flex items-center gap-2">
            💳 Faktury do opłacenia dziś
            <span className="ml-1 text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 px-2 py-0.5 rounded-full font-medium">
              {stats.invoices_due.length}
            </span>
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Masz {stats.invoices_due.length} {stats.invoices_due.length === 1 ? 'fakturę' : stats.invoices_due.length < 5 ? 'faktury' : 'faktur'} do opłacenia na łączną kwotę{' '}
            <strong className="text-red-600 dark:text-red-400">
              {fmt(stats.invoices_due.reduce((s, i) => s + i.gross_amount, 0))} PLN
            </strong>
          </p>
          <div className="space-y-2">
            {stats.invoices_due.map(inv => (
              <div key={inv.id} className="flex items-center justify-between bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{inv.seller_name ?? '—'}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {inv.invoice_number ?? '—'} · termin: {inv.payment_due_date ?? '—'}
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-4">
                  <div className="text-sm font-semibold text-red-600 dark:text-red-400">
                    {fmt(inv.gross_amount)} {inv.currency}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Employee medical/BHP alerts */}
      {stats.employee_alerts && stats.employee_alerts.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-blue-200 dark:border-blue-800 p-5">
          <h2 className="text-sm font-semibold text-blue-700 dark:text-blue-400 mb-3 flex items-center gap-2">
            👷 Przypomnienia — pracownicy
            <span className="ml-1 text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full font-medium">
              {stats.employee_alerts.length}
            </span>
          </h2>
          <div className="space-y-2">
            {stats.employee_alerts.map((alert: EmployeeAlert, i: number) => {
              const expired = alert.days_left < 0
              const urgent  = alert.days_left <= 3
              return (
                <div key={i} className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${expired ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800' : urgent ? 'bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800' : 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800'}`}>
                  <span className="text-xl flex-shrink-0">{alert.alert_type === 'medical_exam_date' ? '🩺' : '🦺'}</span>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-gray-800 dark:text-gray-100">{alert.alert_label}</span>
                    <span className="text-gray-400 dark:text-gray-500"> · 👤 {alert.employee_name}</span>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`font-semibold ${expired ? 'text-red-600 dark:text-red-400' : urgent ? 'text-orange-600 dark:text-orange-400' : 'text-blue-700 dark:text-blue-400'}`}>
                      {expired ? `Przeterminowane ${Math.abs(alert.days_left)} dni temu` : alert.days_left === 0 ? 'Wygasa DZIŚ' : `Za ${alert.days_left} ${alert.days_left === 1 ? 'dzień' : 'dni'}`}
                    </div>
                    <div className="text-xs text-gray-400">{new Date(alert.expires_at).toLocaleDateString('pl-PL')}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Car alerts */}
      {stats.car_alerts && stats.car_alerts.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-amber-200 dark:border-amber-800 p-5">
          <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400 mb-3 flex items-center gap-2">
            🚗 Przypomnienia — pojazdy służbowe
            <span className="ml-1 text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full font-medium">
              {stats.car_alerts.length}
            </span>
          </h2>
          <div className="space-y-2">
            {stats.car_alerts.map((alert: CarAlert, i: number) => {
              const expired = alert.days_left < 0
              const urgent  = alert.days_left <= 3
              return (
                <div
                  key={i}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
                    expired ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
                    : urgent ? 'bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800'
                    : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
                  }`}
                >
                  <span className="text-xl flex-shrink-0">
                    {alert.alert_type === 'car_inspection_date' ? '🔧' : '🛡'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-gray-800 dark:text-gray-100">{alert.alert_label}</span>
                    <span className="text-gray-500 dark:text-gray-400"> · {alert.car_name}{alert.serial_no ? ` (${alert.serial_no})` : ''}</span>
                    <span className="text-gray-400 dark:text-gray-500"> · 👤 {alert.employee_name}</span>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`font-semibold ${expired ? 'text-red-600 dark:text-red-400' : urgent ? 'text-orange-600 dark:text-orange-400' : 'text-amber-700 dark:text-amber-400'}`}>
                      {expired
                        ? `Przeterminowane ${Math.abs(alert.days_left)} dni temu`
                        : alert.days_left === 0
                          ? 'Wygasa DZIŚ'
                          : `Za ${alert.days_left} ${alert.days_left === 1 ? 'dzień' : 'dni'}`
                      }
                    </div>
                    <div className="text-xs text-gray-400">{new Date(alert.expires_at).toLocaleDateString('pl-PL')}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
