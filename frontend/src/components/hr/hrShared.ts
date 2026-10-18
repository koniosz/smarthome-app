// Wspólne drobiazgi UI dla modułu HR (HrPage + komponenty w components/hr)

export const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
export const lblCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'

export const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Oczekuje', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  approved: { label: '✓ Zatwierdzony', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  rejected: { label: '✗ Odrzucony', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  cancelled: { label: 'Anulowany', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
}

export function fmt(n: number) { return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(n || 0) }
export function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s); return isNaN(d.getTime()) ? s : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
// Dzisiejsza data w lokalnej strefie jako YYYY-MM-DD (sv-SE daje dokładnie ten format)
export function todayIso() { return new Date().toLocaleDateString('sv-SE') }
