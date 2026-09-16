// „Do sprawdzenia”: lista checków z ikoną wg severity i przyciskiem „Przejdź →”
import { useNavigate } from 'react-router-dom'
import { TriangleAlert, CircleAlert, Info, CircleCheck, ArrowRight } from 'lucide-react'
import type { HealthCheck } from '../../api/health'
import { useAuth } from '../../auth/AuthContext'
import { Card, Hint } from './ui'

// Trasy owinięte w AdminRoute (App.tsx) — dla nie-admina (księgowa z can_view_payments)
// AdminRoute robi ciche <Navigate to="/" />, więc zamiast martwego przycisku pokazujemy tekst.
const ADMIN_ONLY_PATHS = ['/finanse', '/ksef', '/inne-koszty', '/employees', '/admin', '/ai-examples']
const isAdminOnlyLink = (link: string) =>
  ADMIN_ONLY_PATHS.some(p => link === p || link.startsWith(p + '/') || link.startsWith(p + '?'))

const SEV = {
  error: { Icon: TriangleAlert, cls: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900', label: 'Brak danych' },
  warn: { Icon: CircleAlert, cls: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900', label: 'Do sprawdzenia' },
  info: { Icon: Info, cls: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900', label: 'Informacja' },
} as const

export default function ChecksList({ checks }: { checks: HealthCheck[] }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const order = { error: 0, warn: 1, info: 2 }
  const sorted = [...checks].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
  const errors = checks.filter(c => c.severity === 'error').length

  return (
    <Card title="Do sprawdzenia" subtitle={errors > 0
      ? `${errors} ${errors === 1 ? 'brak blokuje' : 'braki blokują'} pełny raport — uzupełnij dane, a liczby będą wiarygodne.`
      : 'Czerwone = brakuje danych do wyniku. Żółte = warto zerknąć. Niebieskie = drobiazg.'}>
      {sorted.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 font-semibold">
          <CircleCheck size={16} /> Wszystko w porządku — nie ma nic do poprawienia.
        </div>
      ) : (
        <ul className="space-y-2">
          {sorted.map(c => {
            const s = SEV[c.severity] ?? SEV.info
            const { Icon } = s
            return (
              <li key={c.key} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${s.bg}`}>
                <Icon size={18} className={`flex-shrink-0 ${s.cls}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800 dark:text-gray-100">
                    {c.message}
                    {typeof c.count === 'number' && c.count > 0 && (
                      <span className="ml-2 text-[11px] font-bold px-1.5 py-0.5 rounded bg-white/70 dark:bg-gray-900/60 text-gray-600 dark:text-gray-300">{c.count}</span>
                    )}
                  </div>
                  <div className={`text-[11px] font-semibold ${s.cls}`}>{s.label}</div>
                </div>
                {c.link && (!isAdmin && isAdminOnlyLink(c.link) ? (
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap" title="Ta strona jest dostępna tylko dla administratora">
                    poproś administratora
                  </span>
                ) : (
                  <button onClick={() => navigate(c.link!)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold text-violet-700 dark:text-violet-300 bg-white dark:bg-gray-900 border border-violet-200 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/40 whitespace-nowrap">
                    Przejdź <ArrowRight size={12} />
                  </button>
                ))}
              </li>
            )
          })}
        </ul>
      )}
      <Hint>Raport e-mail wysyła się automatycznie tylko wtedy, gdy nie ma czerwonych pozycji.</Hint>
    </Card>
  )
}
