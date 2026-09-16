// Wspólne formatery i drobne elementy UI dla skrzynki kosztów spoza KSeF.
import type { ReactNode } from 'react'
import { SUBCATEGORY_OPTIONS, COST_CATEGORY_ORDER, COST_CATEGORY_LABELS } from '../../constants/costTaxonomy'

const PLN = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function fmt(n: number | null | undefined): string {
  return PLN.format(Number(n) || 0)
}

export function money(n: number | null | undefined, currency = 'PLN'): string {
  const cur = (currency || 'PLN').toUpperCase()
  return cur === 'PLN' ? `${fmt(n)} zł` : `${fmt(n)} ${cur}`
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return d ? `${d}.${m}.${y}` : s
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Parsuje liczbę wpisaną po polsku („12 500,50") — NaN gdy nie da się odczytać. */
export function parseNum(s: string): number {
  const cleaned = String(s ?? '').replace(/[\s  ]/g, '').replace(',', '.')
  if (cleaned === '' || cleaned === '-') return NaN
  return Number(cleaned)
}

/** Komunikat błędu z odpowiedzi axios (po polsku z backendu) lub fallback. */
export function errorMessage(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { error?: string } }; code?: string; message?: string }
  if (err?.response?.data?.error) return err.response.data.error
  if (err?.code === 'ECONNABORTED') return 'Przekroczono czas oczekiwania — spróbuj ponownie.'
  return fallback
}

export function currentMonth(offsetMonths = 0): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + offsetMonths)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ── Klasy Tailwind (jasny + ciemny) ──────────────────────────────────────────
export const inputCls = 'px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full disabled:opacity-60'
export const labelCls = 'block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1'
export const cardCls = 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl'
export const btnPrimary = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed'
export const btnSecondary = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed'
export const btnDanger = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-white dark:bg-gray-900 text-red-600 dark:text-red-400 text-sm font-semibold hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-60 disabled:cursor-not-allowed'
export const btnGhost = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-60'

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet'

const TONE_CLS: Record<Tone, string> = {
  green:  'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  amber:  'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  red:    'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  blue:   'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  gray:   'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
}

export function Badge({ tone = 'gray', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap ${TONE_CLS[tone]}`}>
      {children}
    </span>
  )
}

export function Alert({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'blue'; children: ReactNode }) {
  const cls = tone === 'green' ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300'
    : tone === 'amber' ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
    : tone === 'red' ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
    : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300'
  return <div className={`p-3 rounded-xl border text-sm ${cls}`}>{children}</div>
}

/** Select podkategorii z grupami (optgroup) — wartość = klucz podkategorii. */

export function SubcategorySelect({ value, onChange, disabled, className, compact }: {
  value: string; onChange: (subcategory: string) => void; disabled?: boolean; className?: string; compact?: boolean
}) {
  const known = SUBCATEGORY_OPTIONS.some(o => o.value === value)
  return (
    <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      className={className ?? (compact ? 'px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 max-w-[220px] disabled:opacity-60' : inputCls)}>
      {!known && value && <option value={value}>{value}</option>}
      {COST_CATEGORY_ORDER.map(cat => (
        <optgroup key={cat} label={COST_CATEGORY_LABELS[cat]}>
          {SUBCATEGORY_OPTIONS.filter(o => o.cost_category === cat).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
