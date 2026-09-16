// Wykres 12 miesięcy: słupki przychód/koszty + linia EBITDA — czysty SVG, bez bibliotek
import { useState } from 'react'
import type { HealthTrendPoint } from '../../api/health'
import { money0, short } from './format'
import { Card, Hint } from './ui'

const W = 720, H = 240
const PAD = { top: 14, right: 12, bottom: 28, left: 54 }

export default function TrendChart({ trend, highlight }: { trend: HealthTrendPoint[]; highlight?: { from: string; to: string } }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = trend.length
  if (n === 0) {
    return <Card title="Ostatnie 12 miesięcy"><div className="text-sm text-gray-400">Brak danych do wykresu.</div></Card>
  }

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const maxV = Math.max(1, ...trend.map(t => Math.max(t.revenue, t.costs, t.ebitda)))
  const minV = Math.min(0, ...trend.map(t => t.ebitda))
  const span = maxV - minV || 1
  const y = (v: number) => PAD.top + ((maxV - v) / span) * plotH
  const y0 = y(0)
  const group = plotW / n
  const barW = Math.min(18, group * 0.28)
  const cx = (i: number) => PAD.left + group * i + group / 2

  // Linie siatki: max, połowa, 0, min (bez duplikatów)
  const ticks = Array.from(new Set([maxV, maxV / 2, 0, minV].map(v => Math.round(v))))
  const linePath = trend.map((t, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${y(t.ebitda).toFixed(1)}`).join(' ')
  const h = hover !== null ? trend[hover] : null

  return (
    <Card title="Ostatnie 12 miesięcy" subtitle="Słupki: ile sprzedaliście i ile wydaliście. Linia: zysk EBITDA. Najedź na miesiąc, żeby zobaczyć kwoty."
      right={h && (
        <div className="text-xs text-right tabular-nums text-gray-600 dark:text-gray-300 whitespace-nowrap">
          <b>{h.label}</b> · przychód {money0(h.revenue)} · koszty {money0(h.costs)} · EBITDA <span className={h.ebitda < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}>{money0(h.ebitda)}</span>
        </div>
      )}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label="Wykres przychodów, kosztów i EBITDA za 12 miesięcy"
        onMouseLeave={() => setHover(null)}>
        {/* Siatka + etykiety osi Y */}
        {ticks.map(v => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-gray-400 dark:stroke-gray-500' : 'stroke-gray-200 dark:stroke-gray-800'} strokeWidth={v === 0 ? 1.2 : 1} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" className="fill-gray-400 text-[10px]">{short(v)}</text>
          </g>
        ))}
        {trend.map((t, i) => {
          const inRange = highlight && t.period >= highlight.from && t.period <= highlight.to
          const active = hover === i
          return (
            <g key={t.period} onMouseEnter={() => setHover(i)}>
              {/* Tło miesiąca (podświetlenie wybranego okresu / hover) */}
              <rect x={PAD.left + group * i} y={PAD.top} width={group} height={plotH}
                className={active ? 'fill-violet-100/70 dark:fill-violet-900/30' : inRange ? 'fill-violet-50 dark:fill-violet-950/30' : 'fill-transparent'} />
              {/* Przychód */}
              <rect x={cx(i) - barW - 1} y={y(Math.max(0, t.revenue))} width={barW} height={Math.max(0, y0 - y(Math.max(0, t.revenue)))} rx={2}
                className="fill-violet-500 dark:fill-violet-400" />
              {/* Koszty */}
              <rect x={cx(i) + 1} y={y(Math.max(0, t.costs))} width={barW} height={Math.max(0, y0 - y(Math.max(0, t.costs)))} rx={2}
                className="fill-gray-300 dark:fill-gray-600" />
              <text x={cx(i)} y={H - 8} textAnchor="middle" className={`text-[10px] font-semibold ${inRange ? 'fill-violet-600 dark:fill-violet-300' : 'fill-gray-400'}`}>{t.label}</text>
              <title>{`${t.label}: przychód ${money0(t.revenue)}, koszty ${money0(t.costs)}, EBITDA ${money0(t.ebitda)}`}</title>
            </g>
          )
        })}
        {/* Linia EBITDA */}
        <path d={linePath} fill="none" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" className="stroke-green-600 dark:stroke-green-400 pointer-events-none" />
        {trend.map((t, i) => (
          <circle key={t.period} cx={cx(i)} cy={y(t.ebitda)} r={hover === i ? 5 : 3.5}
            className={`pointer-events-none stroke-white dark:stroke-gray-900 ${t.ebitda < 0 ? 'fill-red-500' : 'fill-green-600 dark:fill-green-400'}`} strokeWidth={1.5} />
        ))}
      </svg>
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-violet-500 dark:bg-violet-400 inline-block" /> Przychód</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-gray-300 dark:bg-gray-600 inline-block" /> Koszty</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-0.5 bg-green-600 dark:bg-green-400 inline-block" /> Zysk EBITDA (czerwona kropka = strata)</span>
      </div>
      <Hint>Gdy fioletowy słupek jest wyższy od szarego, miesiąc był na plusie. Jasne tło = wybrany okres.</Hint>
    </Card>
  )
}
