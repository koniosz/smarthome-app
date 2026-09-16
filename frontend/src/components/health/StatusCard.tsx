// Duża karta statusu: zielona / żółta / czerwona + zdanie „headline” i „subline”
import { CircleCheck, TriangleAlert, CircleAlert, Clock } from 'lucide-react'
import type { HealthResponse } from '../../api/health'
import { money0, pct1, fmtDateTime } from './format'

const STYLE = {
  green: {
    box: 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800',
    text: 'text-green-800 dark:text-green-200',
    badge: 'bg-green-600 text-white',
    label: 'Dobrze',
    Icon: CircleCheck,
  },
  yellow: {
    box: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800',
    text: 'text-amber-800 dark:text-amber-200',
    badge: 'bg-amber-500 text-white',
    label: 'Uwaga',
    Icon: CircleAlert,
  },
  red: {
    box: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800',
    text: 'text-red-800 dark:text-red-200',
    badge: 'bg-red-600 text-white',
    label: 'Źle',
    Icon: TriangleAlert,
  },
} as const

export default function StatusCard({ data }: { data: HealthResponse }) {
  const s = STYLE[data.status] ?? STYLE.yellow
  const { Icon } = s
  const t = data.tiles
  return (
    <div className={`rounded-2xl border p-5 md:p-6 ${s.box}`}>
      <div className="flex items-start gap-4">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${s.badge}`}>
          <Icon size={26} strokeWidth={2.2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md ${s.badge}`}>{s.label}</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">{data.label}</span>
            <span className={`text-xs font-semibold ${data.complete ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {data.complete ? '• dane kompletne' : '• brakuje części danych'}
            </span>
          </div>
          <h2 className={`text-xl md:text-2xl font-bold mt-1.5 leading-snug ${s.text}`}>{data.headline}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{data.subline}</p>

          <div className="flex items-center gap-x-5 gap-y-1 flex-wrap mt-3 text-xs text-gray-600 dark:text-gray-300">
            <span title="Wynik po amortyzacji, odsetkach i podatku CIT">
              Wynik netto: <b className={t.net_result < 0 ? 'text-red-600 dark:text-red-400' : ''}>{money0(t.net_result)}</b>
            </span>
            <span title="EBITDA / przychód — ile groszy z każdej złotówki sprzedaży zostaje w firmie">
              Marża EBITDA: <b>{pct1(t.ebitda_pct)}</b>
            </span>
            <span className="inline-flex items-center gap-1 text-gray-400"><Clock size={12} /> policzone {fmtDateTime(data.generated_at)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
