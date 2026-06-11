import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarPlus, Plus, ArrowRight, TrendingUp, Briefcase, Receipt, BarChart3, AlertTriangle, CreditCard, HardHat, Car, Wrench, Shield, Stethoscope } from 'lucide-react'
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
      <div
        style={{ backgroundColor: '#f8fafc', minHeight: '100vh' }}
        className="flex items-center justify-center h-64"
      >
        <div style={{ color: '#94a3b8', fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14 }}>
          Ładowanie...
        </div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div
        style={{ backgroundColor: '#f8fafc', minHeight: '100vh' }}
        className="flex items-center justify-center h-64"
      >
        <div style={{ color: '#dc2626', fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14 }}>
          Błąd połączenia z backendem
        </div>
      </div>
    )
  }

  const avgMarginColor =
    stats.average_margin_pct < 0
      ? '#dc2626'
      : stats.average_margin_pct < 10
        ? '#f59e0b'
        : '#16a34a'

  return (
    <div
      style={{
        backgroundColor: '#f8fafc',
        minHeight: '100vh',
        fontFamily: "'IBM Plex Sans', sans-serif",
        paddingTop: 36,
        paddingLeft: 32,
        paddingRight: 32,
        paddingBottom: 64,
      }}
    >
      <div style={{ maxWidth: 1280, margin: '0 auto' }}>

        {/* ── Page Header ── */}
        <div className="flex items-start justify-between" style={{ marginBottom: 32 }}>
          <div>
            <h1
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: '#0f172a',
                letterSpacing: '-0.01em',
                margin: 0,
                lineHeight: 1.25,
              }}
            >
              Dzień dobry!
            </h1>
            <p style={{ fontSize: 14, color: '#64748b', marginTop: 4, marginBottom: 0 }}>
              Masz{' '}
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#0f172a' }}>
                {stats.active_projects}
              </span>{' '}
              aktywnych projektów
            </p>
          </div>
          <div className="flex items-center" style={{ gap: 10 }}>
            <button
              onClick={() => navigate('/projects')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: '10px 18px',
                fontSize: 14,
                fontWeight: 600,
                color: '#2563eb',
                cursor: 'pointer',
                fontFamily: "'IBM Plex Sans', sans-serif",
              }}
            >
              <CalendarPlus size={16} color="#2563eb" />
              Nowe zadanie
            </button>
            <button
              onClick={() => navigate('/projects/new')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                backgroundColor: '#2563eb',
                border: 'none',
                borderRadius: 8,
                padding: '10px 18px',
                fontSize: 14,
                fontWeight: 600,
                color: '#ffffff',
                cursor: 'pointer',
                boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
                fontFamily: "'IBM Plex Sans', sans-serif",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#1d4ed8' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2563eb' }}
            >
              <Plus size={16} color="#ffffff" />
              Nowy projekt
            </button>
          </div>
        </div>

        {/* ── KPI Cards ── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 20,
            marginBottom: 28,
          }}
        >
          {/* Aktywne projekty */}
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              padding: '22px 24px',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Aktywne projekty</span>
              <div
                style={{
                  width: 36,
                  height: 36,
                  backgroundColor: '#eff6ff',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Briefcase size={18} color="#2563eb" />
              </div>
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                color: '#0f172a',
                letterSpacing: '-0.02em',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
                marginBottom: 6,
              }}
            >
              {stats.active_projects}
            </div>
            <div style={{ fontSize: 13, color: '#16a34a', fontWeight: 500 }}>
              {stats.total_projects} łącznie
            </div>
          </div>

          {/* Wartość ofert */}
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              padding: '22px 24px',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Wartość ofert</span>
              <div
                style={{
                  width: 36,
                  height: 36,
                  backgroundColor: '#f0fdf4',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <TrendingUp size={18} color="#16a34a" />
              </div>
            </div>
            <div className="flex items-baseline" style={{ gap: 5, marginBottom: 6 }}>
              <span
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  color: '#0f172a',
                  letterSpacing: '-0.02em',
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1,
                }}
              >
                {fmt(stats.total_budget)}
              </span>
              <span style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8' }}>PLN</span>
            </div>
            <div style={{ fontSize: 13, color: '#64748b' }}>aktywne projekty</div>
          </div>

          {/* Łączne koszty */}
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              padding: '22px 24px',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Łączne koszty</span>
              <div
                style={{
                  width: 36,
                  height: 36,
                  backgroundColor: '#fffbeb',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Receipt size={18} color="#f59e0b" />
              </div>
            </div>
            <div className="flex items-baseline" style={{ gap: 5, marginBottom: 6 }}>
              <span
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  color: '#0f172a',
                  letterSpacing: '-0.02em',
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1,
                }}
              >
                {fmt(stats.total_costs)}
              </span>
              <span style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8' }}>PLN</span>
            </div>
            <div style={{ fontSize: 13, color: '#64748b' }}>aktywne projekty</div>
          </div>

          {/* Średnia marża */}
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              padding: '22px 24px',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Średnia marża</span>
              <div
                style={{
                  width: 36,
                  height: 36,
                  backgroundColor: '#f5f3ff',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <BarChart3 size={18} color="#7c3aed" />
              </div>
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                color: avgMarginColor,
                letterSpacing: '-0.02em',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
                marginBottom: 6,
              }}
            >
              {stats.average_margin_pct.toFixed(1)}%
            </div>
            <div style={{ fontSize: 13, color: '#64748b' }}>aktywnych projektów</div>
          </div>
        </div>

        {/* ── Over budget alert ── */}
        {stats.over_budget_count > 0 && (
          <div
            style={{
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 12,
              padding: '18px 24px',
              marginBottom: 24,
            }}
          >
            <div className="flex items-center" style={{ gap: 8, marginBottom: 14 }}>
              <AlertTriangle size={16} color="#b91c1c" />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#b91c1c' }}>
                Projekty z przekroczonym budżetem ({stats.over_budget_count})
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stats.over_budget_projects.map(p => (
                <div
                  key={p.id}
                  onClick={() => navigate(`/projects/${p.id}`)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: '#ffffff',
                    border: '1px solid #fecaca',
                    borderRadius: 8,
                    padding: '10px 16px',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#fef2f2' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#ffffff' }}
                >
                  <div className="flex items-center" style={{ gap: 12, minWidth: 0 }}>
                    <StatusBadge status={p.status} />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: '#0f172a',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.name}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>{p.client_name}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#b91c1c',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {fmt(p.cost_total)} PLN kosztów
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                      budżet: {fmt(p.budget_amount)} PLN
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Bottom section: Ostatnie projekty + By Status / Type ── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 24,
            marginBottom: 24,
          }}
        >
          {/* Ostatnie projekty */}
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            <div
              className="flex items-center justify-between"
              style={{ padding: '18px 24px 0 24px', marginBottom: 4 }}
            >
              <span style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Ostatnie projekty</span>
              <button
                onClick={() => navigate('/projects')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#2563eb',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontFamily: "'IBM Plex Sans', sans-serif",
                }}
              >
                Zobacz wszystkie
                <ArrowRight size={14} />
              </button>
            </div>

            {stats.recent_projects.length === 0 ? (
              <div style={{ padding: '32px 24px', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
                Brak projektów.{' '}
                <button
                  onClick={() => navigate('/projects')}
                  style={{
                    color: '#2563eb',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 600,
                    fontFamily: "'IBM Plex Sans', sans-serif",
                  }}
                >
                  Dodaj pierwszy projekt →
                </button>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {(['Projekt', 'Typ', 'Status', 'Budżet', 'Marża'] as const).map((col, i) => (
                        <th
                          key={col}
                          style={{
                            padding: '10px 24px',
                            textAlign: i >= 3 ? 'right' : 'left',
                            fontSize: 12,
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            color: '#94a3b8',
                            borderBottom: '1px solid #f1f5f9',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recent_projects.map((p, idx) => (
                      <tr
                        key={p.id}
                        onClick={() => navigate(`/projects/${p.id}`)}
                        style={{
                          borderBottom: idx < stats.recent_projects.length - 1 ? '1px solid #f1f5f9' : 'none',
                          cursor: 'pointer',
                          transition: 'background-color 0.12s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8fafc' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '' }}
                      >
                        <td style={{ padding: '16px 24px' }}>
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: '#0f172a',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 200,
                            }}
                          >
                            {p.name}
                          </div>
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{p.client_name}</div>
                        </td>
                        <td style={{ padding: '16px 24px' }}>
                          <TypeBadge type={p.project_type} />
                        </td>
                        <td style={{ padding: '16px 24px' }}>
                          <StatusBadge status={p.status} />
                        </td>
                        <td
                          style={{
                            padding: '16px 24px',
                            textAlign: 'right',
                            fontSize: 14,
                            color: '#0f172a',
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {fmt(p.budget_amount)}{' '}
                          <span style={{ color: '#94a3b8', fontSize: 12 }}>PLN</span>
                        </td>
                        <td style={{ padding: '16px 24px', textAlign: 'right' }}>
                          <MarginBadge pct={p.margin_pct} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Right column: By Status + By Type */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* By status */}
            <div
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '18px 24px',
                flex: 1,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 16px 0' }}>
                Projekty wg statusu
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Object.entries(stats.by_status).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between">
                    <StatusBadge status={status as any} />
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#0f172a',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {count}
                    </span>
                  </div>
                ))}
                {Object.keys(stats.by_status).length === 0 && (
                  <div style={{ fontSize: 14, color: '#94a3b8' }}>Brak projektów</div>
                )}
              </div>
            </div>

            {/* By type */}
            <div
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '18px 24px',
                flex: 1,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 16px 0' }}>
                Projekty wg typu
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Object.entries(stats.by_type).map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between">
                    <TypeBadge type={type as any} />
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#0f172a',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {count}
                    </span>
                  </div>
                ))}
                {Object.keys(stats.by_type).length === 0 && (
                  <div style={{ fontSize: 14, color: '#94a3b8' }}>Brak projektów</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Due invoices alert ── */}
        {stats.invoices_due && stats.invoices_due.length > 0 && (
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #fecaca',
              borderRadius: 12,
              padding: '18px 24px',
              marginBottom: 24,
            }}
          >
            <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
              <CreditCard size={16} color="#b91c1c" />
              <span style={{ fontSize: 16, fontWeight: 600, color: '#b91c1c' }}>
                Faktury do opłacenia dziś
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  backgroundColor: '#fef2f2',
                  color: '#b91c1c',
                  border: '1px solid #fecaca',
                  borderRadius: 999,
                  padding: '2px 10px',
                  marginLeft: 4,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {stats.invoices_due.length}
              </span>
            </div>
            <p style={{ fontSize: 13, color: '#64748b', marginTop: 0, marginBottom: 14 }}>
              Masz{' '}
              {stats.invoices_due.length}{' '}
              {stats.invoices_due.length === 1 ? 'fakturę' : stats.invoices_due.length < 5 ? 'faktury' : 'faktur'}{' '}
              do opłacenia na łączną kwotę{' '}
              <strong
                style={{ color: '#b91c1c', fontVariantNumeric: 'tabular-nums' }}
              >
                {fmt(stats.invoices_due.reduce((s, i) => s + i.gross_amount, 0))} PLN
              </strong>
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stats.invoices_due.map(inv => (
                <div
                  key={inv.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 8,
                    padding: '10px 16px',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#0f172a',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {inv.seller_name ?? '—'}
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                      {inv.invoice_number ?? '—'} · termin: {inv.payment_due_date ?? '—'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: '#b91c1c',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {fmt(inv.gross_amount)} {inv.currency}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Employee alerts ── */}
        {stats.employee_alerts && stats.employee_alerts.length > 0 && (
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #93c5fd',
              borderRadius: 12,
              padding: '18px 24px',
              marginBottom: 24,
            }}
          >
            <div className="flex items-center" style={{ gap: 8, marginBottom: 16 }}>
              <HardHat size={16} color="#1d4ed8" />
              <span style={{ fontSize: 16, fontWeight: 600, color: '#1d4ed8' }}>
                Przypomnienia — pracownicy
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  backgroundColor: '#eff6ff',
                  color: '#1d4ed8',
                  border: '1px solid #93c5fd',
                  borderRadius: 999,
                  padding: '2px 10px',
                  marginLeft: 4,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {stats.employee_alerts.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stats.employee_alerts.map((alert: EmployeeAlert, i: number) => {
                const expired = alert.days_left < 0
                const urgent = alert.days_left <= 3
                const bgColor = expired ? '#fef2f2' : urgent ? '#fffbeb' : '#eff6ff'
                const borderColor = expired ? '#fecaca' : urgent ? '#fde68a' : '#93c5fd'
                const labelColor = expired ? '#b91c1c' : urgent ? '#b45309' : '#1d4ed8'
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderRadius: 8,
                      border: `1px solid ${borderColor}`,
                      backgroundColor: bgColor,
                    }}
                  >
                    <div
                      style={{
                        flexShrink: 0,
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        backgroundColor: '#ffffff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1px solid ${borderColor}`,
                      }}
                    >
                      {alert.alert_type === 'medical_exam_date'
                        ? <Stethoscope size={16} color={labelColor} />
                        : <Shield size={16} color={labelColor} />
                      }
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{alert.alert_label}</span>
                      <span style={{ fontSize: 13, color: '#64748b' }}> · {alert.employee_name}</span>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: labelColor }}>
                        {expired
                          ? `Przeterminowane ${Math.abs(alert.days_left)} dni temu`
                          : alert.days_left === 0
                            ? 'Wygasa DZIŚ'
                            : `Za ${alert.days_left} ${alert.days_left === 1 ? 'dzień' : 'dni'}`
                        }
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(alert.expires_at).toLocaleDateString('pl-PL')}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Car alerts ── */}
        {stats.car_alerts && stats.car_alerts.length > 0 && (
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #fde68a',
              borderRadius: 12,
              padding: '18px 24px',
              marginBottom: 24,
            }}
          >
            <div className="flex items-center" style={{ gap: 8, marginBottom: 16 }}>
              <Car size={16} color="#b45309" />
              <span style={{ fontSize: 16, fontWeight: 600, color: '#b45309' }}>
                Przypomnienia — pojazdy służbowe
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  backgroundColor: '#fffbeb',
                  color: '#b45309',
                  border: '1px solid #fde68a',
                  borderRadius: 999,
                  padding: '2px 10px',
                  marginLeft: 4,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {stats.car_alerts.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stats.car_alerts.map((alert: CarAlert, i: number) => {
                const expired = alert.days_left < 0
                const urgent = alert.days_left <= 3
                const bgColor = expired ? '#fef2f2' : urgent ? '#fffbeb' : '#fffbeb'
                const borderColor = expired ? '#fecaca' : urgent ? '#fde68a' : '#fde68a'
                const labelColor = expired ? '#b91c1c' : urgent ? '#b45309' : '#b45309'
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderRadius: 8,
                      border: `1px solid ${borderColor}`,
                      backgroundColor: bgColor,
                    }}
                  >
                    <div
                      style={{
                        flexShrink: 0,
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        backgroundColor: '#ffffff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1px solid ${borderColor}`,
                      }}
                    >
                      {alert.alert_type === 'car_inspection_date'
                        ? <Wrench size={16} color={labelColor} />
                        : <Shield size={16} color={labelColor} />
                      }
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{alert.alert_label}</span>
                      <span style={{ fontSize: 13, color: '#64748b' }}>
                        {' '}· {alert.car_name}{alert.serial_no ? ` (${alert.serial_no})` : ''}
                      </span>
                      <span style={{ fontSize: 13, color: '#94a3b8' }}> · {alert.employee_name}</span>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: labelColor }}>
                        {expired
                          ? `Przeterminowane ${Math.abs(alert.days_left)} dni temu`
                          : alert.days_left === 0
                            ? 'Wygasa DZIŚ'
                            : `Za ${alert.days_left} ${alert.days_left === 1 ? 'dzień' : 'dni'}`
                        }
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(alert.expires_at).toLocaleDateString('pl-PL')}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
