// Porównanie: „vs poprzedni okres” i „vs rok temu” — strzałki ▲▼ z procentem
import type { HealthCmp, HealthResponse } from '../../api/health'
import { money0, pctChange } from './format'
import { Card, Hint } from './ui'

type Metric = { key: 'revenue' | 'costs' | 'ebitda'; label: string; upIsGood: boolean }
const METRICS: Metric[] = [
  { key: 'revenue', label: 'Przychód', upIsGood: true },
  { key: 'costs', label: 'Koszty', upIsGood: false },
  { key: 'ebitda', label: 'Zysk (EBITDA)', upIsGood: true },
]

function Delta({ cur, prev, upIsGood }: { cur: number; prev: number; upIsGood: boolean }) {
  const p = pctChange(cur, prev)
  if (p === null) return <span className="text-xs text-gray-400">brak bazy</span>
  const up = p >= 0
  const good = up === upIsGood
  const cls = Math.abs(p) < 0.05 ? 'text-gray-400' : good ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
  return (
    <span className={`text-xs font-bold tabular-nums ${cls}`}>
      {up ? '▲' : '▼'} {Math.abs(p) >= 1000 ? '>999' : Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0).replace('.', ',')} %
    </span>
  )
}

function Column({ title, cmp, cur }: { title: string; cmp: HealthCmp | null; cur: HealthResponse['tiles'] }) {
  return (
    <div className="flex-1 min-w-[180px]">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
        {title}{cmp && <span className="normal-case font-medium text-gray-400"> · {cmp.label}</span>}
      </div>
      {!cmp ? (
        <div className="text-sm text-gray-400">Brak danych do porównania.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {METRICS.map(m => (
              <tr key={m.key} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                <td className="py-1.5 text-gray-600 dark:text-gray-300">{m.label}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-400 whitespace-nowrap" title="wtedy">{money0(cmp[m.key])}</td>
                <td className="py-1.5 pl-3 text-right whitespace-nowrap"><Delta cur={cur[m.key]} prev={cmp[m.key]} upIsGood={m.upIsGood} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function CompareCard({ data }: { data: HealthResponse }) {
  return (
    <Card title="Jak wypada porównanie" subtitle="Zielona strzałka = zmiana na korzyść firmy (przychód i zysk w górę, koszty w dół).">
      <div className="flex gap-6 flex-wrap">
        <Column title="vs poprzedni okres" cmp={data.compare.prev} cur={data.tiles} />
        <Column title="vs rok temu" cmp={data.compare.yoy} cur={data.tiles} />
      </div>
      <Hint>Szara kwota to wartość z tamtego okresu. „Brak bazy” — wtedy było 0, więc procentu nie da się policzyć.</Hint>
    </Card>
  )
}
