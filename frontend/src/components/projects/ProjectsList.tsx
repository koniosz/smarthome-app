import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { projectsApi, accessRequestsApi } from '../../api/client'
import { useAuth } from '../../auth/AuthContext'
import type { Project, ProjectType, ProjectStatus } from '../../types'
import { PROJECT_TYPE_LABELS, PROJECT_STATUS_LABELS } from '../../types'
import { StatusBadge, TypeBadge, MarginBadge } from '../ui/StatusBadge'
import AddProjectModal from './AddProjectModal'
import NewProjectDialog from '../project-wizard/NewProjectDialog'
import ProjectWizard from '../project-wizard/ProjectWizard'
import AIProjectWizard from '../project-wizard/AIProjectWizard'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
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
      .sort((a, b) => {
        if (sortBy === 'margin_pct') return (a.margin_pct ?? 0) - (b.margin_pct ?? 0)
        if (sortBy === 'budget_amount') return (b.budget_amount ?? 0) - (a.budget_amount ?? 0)
        return b.created_at.localeCompare(a.created_at)
      })

  const filteredMember = applyFiltersSort(memberProjects)
  const filteredNonMember = applyFiltersSort(nonMemberProjects)
  const allFiltered = [...filteredMember, ...filteredNonMember]

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
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Ładowanie...</div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">Projekty</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {memberProjects.length} {memberProjects.length === 1 ? 'projekt' : 'projektów'} z dostępem
            {!isAdmin && nonMemberProjects.length > 0 && (
              <span className="text-gray-400"> · {nonMemberProjects.length} bez dostępu</span>
            )}
          </p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors flex items-center gap-2"
        >
          <span>+</span> Nowy projekt
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select
          className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none"
          value={filterType}
          onChange={e => setFilterType(e.target.value as any)}
        >
          <option value="">Wszystkie typy</option>
          {(Object.entries(PROJECT_TYPE_LABELS) as [ProjectType, string][]).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>

        <select
          className="px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none"
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value as any)}
        >
          <option value="">Wszystkie statusy</option>
          {(Object.entries(PROJECT_STATUS_LABELS) as [ProjectStatus, string][]).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">Sortuj:</span>
          {[
            { key: 'created_at' as const, label: 'Najnowsze' },
            { key: 'margin_pct' as const, label: 'Marża ↑' },
            { key: 'budget_amount' as const, label: 'Budżet ↓' },
          ].map(s => (
            <button
              key={s.key}
              onClick={() => setSortBy(s.key)}
              className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                sortBy === s.key
                  ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {allFiltered.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center">
          <div className="text-4xl mb-3">📁</div>
          <div className="text-gray-500 dark:text-gray-400 text-sm">
            {projects.length === 0
              ? 'Brak projektów. Kliknij "Nowy projekt" aby zacząć.'
              : 'Brak wyników dla wybranych filtrów.'}
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-4 py-3">Projekt / Klient</th>
                <th className="text-left px-4 py-3">Typ</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Budżet</th>
                <th className="text-right px-4 py-3">Koszty</th>
                <th className="text-right px-4 py-3">Marża</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {allFiltered.map(p => {
                const isMember = p.user_is_member !== false
                const isOverBudget = isMember && (p.cost_total ?? 0) > p.budget_amount && p.budget_amount > 0
                const hasPending = p.has_pending_request === true
                const isRequesting = requestingAccess[p.id] === true

                if (!isMember) {
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-gray-50 dark:border-gray-800 opacity-50 hover:opacity-70 transition-opacity bg-gray-50/50 dark:bg-gray-800/20"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-400 flex-shrink-0">🔒</span>
                          <div>
                            <div className="font-medium text-gray-600 dark:text-gray-400">{p.name}</div>
                            <div className="text-xs text-gray-400">{p.client_name || '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3"><TypeBadge type={p.project_type} /></td>
                      <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                      <td className="px-4 py-3 text-right text-gray-300 dark:text-gray-600 text-xs">—</td>
                      <td className="px-4 py-3 text-right text-gray-300 dark:text-gray-600 text-xs">—</td>
                      <td className="px-4 py-3 text-right text-gray-300 dark:text-gray-600 text-xs">—</td>
                      <td className="px-4 py-3 text-right">
                        {hasPending ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 whitespace-nowrap">
                            ⏳ Wniosek wysłany
                          </span>
                        ) : (
                          <button
                            onClick={() => handleRequestAccess(p.id)}
                            disabled={isRequesting}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors disabled:opacity-50 whitespace-nowrap"
                          >
                            {isRequesting ? '⏳ Wysyłam…' : '🔑 Poproś o dostęp'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                }

                return (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/projects/${p.id}`)}
                    className={`border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors ${
                      isOverBudget ? 'bg-red-50/30 dark:bg-red-950/10' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isOverBudget && <span title="Przekroczony budżet">🚨</span>}
                        <div>
                          <div className="font-medium text-gray-800 dark:text-gray-100">{p.name}</div>
                          <div className="text-xs text-gray-400">{p.client_name || '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><TypeBadge type={p.project_type} /></td>
                    <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                    <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300 font-medium">
                      {fmt(p.budget_amount)}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${
                      isOverBudget ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'
                    }`}>
                      {fmt(p.cost_total ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {p.budget_amount > 0
                        ? <MarginBadge pct={p.margin_pct ?? 0} />
                        : <span className="text-xs text-gray-400">—</span>
                      }
                    </td>
                    <td className="px-4 py-3 text-gray-400">→</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Choice dialog */}
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
