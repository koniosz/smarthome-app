import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, ChevronRight } from 'lucide-react'
import { projectsApi, accessRequestsApi } from '../../api/client'
import { useAuth } from '../../auth/AuthContext'
import type { Project, ProjectType, ProjectStatus } from '../../types'
import { PROJECT_TYPE_LABELS, PROJECT_STATUS_LABELS } from '../../types'
import AddProjectModal from './AddProjectModal'
import NewProjectDialog from '../project-wizard/NewProjectDialog'
import ProjectWizard from '../project-wizard/ProjectWizard'
import AIProjectWizard from '../project-wizard/AIProjectWizard'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

const STATUS_CHIP_CONFIG: {
  key: ProjectStatus | ''
  label: string
}[] = [
  { key: '', label: 'Wszystkie' },
  { key: 'offer_submitted', label: 'Złożenie oferty' },
  { key: 'negotiation', label: 'Negocjacje' },
  { key: 'installation', label: 'Instalacja w toku' },
  { key: 'closing', label: 'Zakończony' },
]

const STATUS_PILL: Record<ProjectStatus, { bg: string; color: string; label: string }> = {
  offer_submitted: { bg: '#eff6ff', color: '#1d4ed8', label: '1 · Złożenie oferty' },
  negotiation:     { bg: '#f5f3ff', color: '#6d28d9', label: '2 · Negocjacje' },
  ordering:        { bg: '#fffbeb', color: '#b45309', label: '3 · Zamówienie' },
  installation:    { bg: '#fffbeb', color: '#b45309', label: '4 · Instalacja w toku' },
  closing:         { bg: '#f0fdf4', color: '#15803d', label: '5 · Zakończony' },
  cancelled:       { bg: '#fef2f2', color: '#b91c1c', label: '0 · Anulowany' },
}

export default function ProjectsList() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [showWizard, setShowWizard] = useState(false)
  const [showAIWizard, setShowAIWizard] = useState(false)
  const [filterType, setFilterType] = useState<ProjectType | ''>('')
  const [filterStatus, setFilterStatus] = useState<ProjectStatus | ''>('')
  const [sortBy, setSortBy] = useState<'created_at' | 'margin_pct' | 'budget_amount'>('created_at')
  const [requestingAccess, setRequestingAccess] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const load = () => {
    projectsApi.list().then(data => {
      setProjects(data)
      setLoading(false)
    })
  }

  useEffect(() => { load() }, [])

  const memberProjects = projects.filter(p => p.user_is_member !== false)
  const nonMemberProjects = isAdmin ? [] : projects.filter(p => p.user_is_member === false)

  const applyFiltersSort = (list: Project[]) =>
    list
      .filter(p => !filterType || p.project_type === filterType)
      .filter(p => !filterStatus || p.status === filterStatus)
      .filter(p => {
        if (!query.trim()) return true
        const q = query.toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          (p.client_name ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => {
        if (sortBy === 'margin_pct') return (a.margin_pct ?? 0) - (b.margin_pct ?? 0)
        if (sortBy === 'budget_amount') return (b.budget_amount ?? 0) - (a.budget_amount ?? 0)
        return b.created_at.localeCompare(a.created_at)
      })

  const filteredMember = applyFiltersSort(memberProjects)
  const filteredNonMember = applyFiltersSort(nonMemberProjects)
  const allFiltered = [...filteredMember, ...filteredNonMember]

  const isFiltered = !!filterStatus || !!filterType || !!query.trim()
  const totalBudget = memberProjects.reduce((acc, p) => acc + (p.budget_amount ?? 0), 0)

  const countForChip = (chipKey: ProjectStatus | '') => {
    return memberProjects.filter(p => !chipKey || p.status === chipKey).length
  }

  const handleRequestAccess = async (projectId: string) => {
    setRequestingAccess(prev => ({ ...prev, [projectId]: true }))
    try {
      await accessRequestsApi.request(projectId)
      setProjects(prev => prev.map(p =>
        p.id === projectId ? { ...p, has_pending_request: true } : p
      ))
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Nie udało się wysłać wniosku.')
    } finally {
      setRequestingAccess(prev => ({ ...prev, [projectId]: false }))
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
        <span style={{ fontSize: 14, color: '#94a3b8' }}>Ładowanie…</span>
      </div>
    )
  }

  return (
    <div style={{ padding: '36px 32px 64px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', letterSpacing: '-0.01em', margin: 0, lineHeight: 1.2 }}>
            Projekty
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', margin: '4px 0 0' }}>
            {isFiltered
              ? `${allFiltered.length} projektów (z ${memberProjects.length})`
              : `${memberProjects.length} projektów · łączna wartość ofert ${fmt(totalBudget)} PLN`
            }
          </p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 18px',
            fontSize: 14,
            fontWeight: 600,
            color: '#ffffff',
            background: '#2563eb',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#1d4ed8')}
          onMouseLeave={e => (e.currentTarget.style.background = '#2563eb')}
        >
          <Plus size={16} />
          Nowy projekt
        </button>
      </div>

      {/* Filters Row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {/* Search */}
        <div style={{ position: 'relative', width: 300 }}>
          <Search
            size={15}
            style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', pointerEvents: 'none' }}
          />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Szukaj projektu lub klienta…"
            style={{
              width: '100%',
              padding: '10px 14px 10px 36px',
              fontSize: 14,
              color: '#0f172a',
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            onFocus={e => {
              e.currentTarget.style.borderColor = '#2563eb'
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)'
            }}
            onBlur={e => {
              e.currentTarget.style.borderColor = '#e2e8f0'
              e.currentTarget.style.boxShadow = 'none'
            }}
          />
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 24, background: '#e2e8f0', flexShrink: 0 }} />

        {/* Status Chips */}
        {STATUS_CHIP_CONFIG.map(chip => {
          const count = countForChip(chip.key)
          const active = filterStatus === chip.key
          return (
            <button
              key={chip.key === '' ? 'all' : chip.key}
              onClick={() => setFilterStatus(chip.key as ProjectStatus | '')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px',
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 999,
                border: active ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                background: active ? '#eff6ff' : '#ffffff',
                color: active ? '#2563eb' : '#475569',
                cursor: 'pointer',
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {chip.label}
              <span style={{
                fontSize: 12,
                fontWeight: 600,
                color: active ? '#2563eb' : '#94a3b8',
                background: active ? 'rgba(37,99,235,0.1)' : '#f1f5f9',
                borderRadius: 999,
                padding: '0 6px',
                minWidth: 20,
                textAlign: 'center',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Table Card */}
      <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>

        {/* Column Headers */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '2.2fr 0.9fr 1.4fr 1fr 1fr 0.8fr 40px',
          padding: '0 24px',
          borderBottom: '1px solid #f1f5f9',
          background: '#f8fafc',
        }}>
          {['Projekt', 'Typ', 'Status', 'Budżet', 'Koszty', 'Marża', ''].map((col, i) => (
            <div
              key={i}
              style={{
                padding: '12px 0',
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: '#94a3b8',
                textAlign: i >= 3 && i <= 5 ? 'right' : 'left',
              }}
            >
              {col}
            </div>
          ))}
        </div>

        {/* Rows */}
        {allFiltered.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>
            Brak projektów spełniających kryteria.
          </div>
        ) : (
          allFiltered.map((p, idx) => {
            const isMember = p.user_is_member !== false
            const isOverBudget = isMember && (p.cost_total ?? 0) > p.budget_amount && p.budget_amount > 0
            const hasPending = p.has_pending_request === true
            const isRequesting = requestingAccess[p.id] === true
            const pill = STATUS_PILL[p.status]
            const isLast = idx === allFiltered.length - 1

            if (!isMember) {
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2.2fr 0.9fr 1.4fr 1fr 1fr 0.8fr 40px',
                    padding: '16px 24px',
                    borderBottom: isLast ? 'none' : '1px solid #f1f5f9',
                    opacity: 0.55,
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#475569' }}>{p.name}</div>
                    <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{p.client_name || '—'}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#475569' }}>
                    {PROJECT_TYPE_LABELS[p.project_type] ?? p.project_type}
                  </div>
                  <div>
                    <span style={{
                      display: 'inline-block',
                      fontSize: 13,
                      fontWeight: 600,
                      borderRadius: 999,
                      padding: '3px 10px',
                      background: pill?.bg ?? '#f1f5f9',
                      color: pill?.color ?? '#64748b',
                    }}>
                      {pill?.label ?? PROJECT_STATUS_LABELS[p.status]}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 14, color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>—</div>
                  <div style={{ textAlign: 'right', fontSize: 14, color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>—</div>
                  <div style={{ textAlign: 'right', fontSize: 14, color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>—</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    {hasPending ? (
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '4px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                        borderRadius: 999,
                        background: '#eff6ff',
                        color: '#1d4ed8',
                        border: '1px solid #93c5fd',
                        whiteSpace: 'nowrap',
                      }}>
                        Wniosek wysłany
                      </span>
                    ) : (
                      <button
                        onClick={() => handleRequestAccess(p.id)}
                        disabled={isRequesting}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '4px 10px',
                          fontSize: 12,
                          fontWeight: 600,
                          borderRadius: 999,
                          background: '#f5f3ff',
                          color: '#6d28d9',
                          border: '1px solid #ddd6fe',
                          cursor: isRequesting ? 'not-allowed' : 'pointer',
                          opacity: isRequesting ? 0.6 : 1,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {isRequesting ? 'Wysyłam…' : 'Poproś o dostęp'}
                      </button>
                    )}
                  </div>
                </div>
              )
            }

            return (
              <div
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2.2fr 0.9fr 1.4fr 1fr 1fr 0.8fr 40px',
                  padding: '16px 24px',
                  borderBottom: isLast ? 'none' : '1px solid #f1f5f9',
                  cursor: 'pointer',
                  alignItems: 'center',
                  background: isOverBudget ? 'rgba(254,242,242,0.5)' : '#ffffff',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => {
                  if (!isOverBudget) e.currentTarget.style.background = '#f8fafc'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = isOverBudget ? 'rgba(254,242,242,0.5)' : '#ffffff'
                }}
              >
                {/* Projekt */}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{p.name}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{p.client_name || '—'}</div>
                </div>

                {/* Typ */}
                <div style={{ fontSize: 13, fontWeight: 500, color: '#475569' }}>
                  {PROJECT_TYPE_LABELS[p.project_type] ?? p.project_type}
                </div>

                {/* Status */}
                <div>
                  <span style={{
                    display: 'inline-block',
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 999,
                    padding: '3px 10px',
                    background: pill?.bg ?? '#f1f5f9',
                    color: pill?.color ?? '#64748b',
                  }}>
                    {pill?.label ?? PROJECT_STATUS_LABELS[p.status]}
                  </span>
                </div>

                {/* Budżet */}
                <div style={{ textAlign: 'right', fontSize: 14, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(p.budget_amount)}
                </div>

                {/* Koszty */}
                <div style={{
                  textAlign: 'right',
                  fontSize: 14,
                  color: isOverBudget ? '#dc2626' : '#64748b',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {fmt(p.cost_total ?? 0)}
                </div>

                {/* Marża */}
                <div style={{
                  textAlign: 'right',
                  fontSize: 14,
                  fontWeight: 600,
                  color: (p.margin_pct ?? 0) > 0 ? '#16a34a' : '#64748b',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {p.budget_amount > 0
                    ? `${(p.margin_pct ?? 0).toFixed(1)}%`
                    : '—'
                  }
                </div>

                {/* Chevron */}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <ChevronRight size={16} color="#cbd5e1" />
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Modals */}
      {showDialog && (
        <NewProjectDialog
          onClose={() => setShowDialog(false)}
          onCreated={() => load()}
          onOpenWizard={() => { setShowDialog(false); setShowWizard(true) }}
          onOpenAI={() => { setShowDialog(false); setShowAIWizard(true) }}
        />
      )}
      {showWizard && (
        <ProjectWizard
          onClose={() => setShowWizard(false)}
          onCreated={() => { setShowWizard(false); load() }}
        />
      )}
      {showAIWizard && (
        <AIProjectWizard
          onClose={() => setShowAIWizard(false)}
        />
      )}
      {showAdd && (
        <AddProjectModal
          onClose={() => setShowAdd(false)}
          onCreated={() => load()}
        />
      )}
    </div>
  )
}
