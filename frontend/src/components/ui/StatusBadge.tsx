import type { ProjectStatus, ProjectType } from '../../types'
import { PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '../../types'

const STATUS_COLORS: Record<ProjectStatus, string> = {
  offer_submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  negotiation:     'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  ordering:        'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  installation:    'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  closing:         'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  cancelled:       'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
}

const TYPE_COLORS: Record<ProjectType, string> = {
  installation: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  developer: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  service: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  purchase: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
}

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}>
      {PROJECT_STATUS_LABELS[status]}
    </span>
  )
}

export function TypeBadge({ type }: { type: ProjectType }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[type]}`}>
      {PROJECT_TYPE_LABELS[type]}
    </span>
  )
}

export function MarginBadge({ pct }: { pct: number }) {
  let cls = 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  if (pct < 0) cls = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  else if (pct < 10) cls = 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
  else if (pct < 25) cls = 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {pct.toFixed(1)}%
    </span>
  )
}
