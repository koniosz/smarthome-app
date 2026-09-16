// „Gotówka: najbliższe N dni” — linia salda dzień po dniu (SVG), najniższy punkt, ostrzeżenia, listy wpływów/wypływów (zwinięte)
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp, TriangleAlert, RefreshCw } from 'lucide-react'
import { cashflowApi, type CashflowResponse, type CashflowEntry, type CashflowRecurring } from '../../api/health'
import { money0, short, fmtDate, fmtDayMonth } from './format'
import { Card, Hint, ErrorBox, InfoBox } from './ui'

const W = 720, H = 200
const PAD = { top: 14, right: 12, bottom: 26, left: 54 }
const DAY_OPTIONS = [14, 30, 60, 90]

function BalanceChart({ cf }: { cf: CashflowResponse }) {
  const [hover, setHover] = useState<number | null>(null)
  const days = cf.days
  const n = days.length
  if (n === 0) return <div className="text-sm text-gray-400">Brak dni do pokazania.</div>

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const start = cf.cash.total_pln ?? 0
  const maxV = Math.max(1, start, ...days.map(d => d.balance))
  const minV = Math.min(0, start, ...days.map(d => d.balance))
  const span = maxV - minV || 1
  const y = (v: number) => PAD.top + ((maxV - v) / span) * plotH
  const x = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y0 = y(0)

  const line = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.balance).toFixed(1)}`).join(' ')
  const area = `${line} L${x(n - 1).toFixed(1)},${y0.toFixed(1)} L${x(0).toFixed(1)},${y0.toFixed(1)} Z`
  const minIdx = days.findIndex(d => d.date === cf.min.date)
  const ticks = Array.from(new Set([maxV, 0, minV].map(v => Math.round(v))))
  // Etykiety X: co ~5 punktów + ostatni
  const labelEvery = Math.max(1, Math.ceil(n / 7))
  const h = hover !== null ? days[hover] : null
  const negative = cf.min.balance < 0

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label="Prognoza salda gotówki"
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((e.clientX - rect.left) / rect.width) * W
          const i = Math.round(((px - PAD.left) / plotW) * (n - 1))
          setHover(Math.max(0, Math.min(n - 1, i)))
        }}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-gray-400 dark:stroke-gray-500' : 'stroke-gray-200 dark:stroke-gray-800'} strokeWidth={v === 0 ? 1.2 : 1} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" className="fill-gray-400 text-[10px]">{short(v)}</text>
          </g>
        ))}
        <path d={area} className={negative ? 'fill-amber-200/40 dark:fill-amber-900/20' : 'fill-violet-200/40 dark:fill-violet-900/20'} />
        <path d={line} fill="none" strokeWidth={2.2} strokeLinejoin="round" className={negative ? 'stroke-amber-500' : 'stroke-violet-600 dark:stroke-violet-400'} />
        {days.map((d, i) => (i % labelEvery === 0 || i === n - 1) && (
          <text key={d.date} x={x(i)} y={H - 8} textAnchor={i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'} className="fill-gray-400 text-[10px]">{fmtDayMonth(d.date)}</text>
        ))}
        {minIdx >= 0 && (
          <g>
            <circle cx={x(minIdx)} cy={y(cf.min.balance)} r={5} className={`${negative ? 'fill-red-500' : 'fill-violet-600 dark:fill-violet-400'} stroke-white dark:stroke-gray-900`} strokeWidth={1.5} />
            <text x={x(minIdx)} y={y(cf.min.balance) - 9} textAnchor={minIdx > n * 0.8 ? 'end' : minIdx < n * 0.2 ? 'start' : 'middle'}
              className={`text-[10px] font-bold ${negative ? 'fill-red-600 dark:fill-red-400' : 'fill-violet-700 dark:fill-violet-300'}`}>
              min {short(cf.min.balance)}
            </text>
          </g>
        )}
        {h && hover !== null && (
          <g className="pointer-events-none">
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className="stroke-gray-400 dark:stroke-gray-500" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.balance)} r={4} className="fill-gray-800 dark:fill-gray-100" />
          </g>
        )}
      </svg>
      <div className="min-h-[2.5rem] mt-1 text-xs text-gray-600 dark:text-gray-300 tabular-nums">
        {h ? (
          <>
            <b>{fmtDate(h.date)}</b> · saldo <b className={h.balance < 0 ? 'text-red-600 dark:text-red-400' : ''}>{money0(h.balance)}</b>
            {h.inflow > 0 && <> · wpływy <span className="text-green-700 dark:text-green-400">+{money0(h.inflow)}</span></>}
            {h.outflow > 0 && <> · wypływy <span className="text-red-600 dark:text-red-400">−{money0(h.outflow)}</span></>}
            {h.items.length > 0 && (
              <div className="text-gray-400 truncate" title={h.items.map(it => `${it.label}: ${money0(it.amount)}`).join(' · ')}>
                {h.items.slice(0, 4).map(it => `${it.label} (${money0(it.amount)})`).join(' · ')}{h.items.length > 4 ? ` · +${h.items.length - 4}` : ''}
              </div>
            )}
          </>
        ) : <span className="text-gray-400">Najedź na wykres, żeby zobaczyć, co wpływa i wychodzi danego dnia.</span>}
      </div>
    </div>
  )
}

function EntryList<T extends CashflowEntry | CashflowRecurring>({ title, items, open, onToggle, render, total }: {
  title: string; items: T[]; open: boolean; onToggle: () => void; render: (it: T) => ReactNode; total: number
}) {
  return (
    <div className="border border-gray-100 dark:border-gray-800 rounded-lg overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex-1">{title}</span>
        <span className="text-xs text-gray-400">{items.length} poz.</span>
        <span className="text-sm font-bold tabular-nums text-gray-800 dark:text-gray-100">{money0(total)}</span>
        {open ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>
      {open && (
        <div className="border-t border-gray-100 dark:border-gray-800 max-h-64 overflow-y-auto">
          {items.length === 0 ? <div className="px-3 py-3 text-xs text-gray-400">Brak pozycji.</div> : items.map((it, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-1.5 border-b border-gray-50 dark:border-gray-800/60 text-xs last:border-0">{render(it)}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CashForecastCard() {
  const navigate = useNavigate()
  const [days, setDays] = useState(30)
  const [cf, setCf] = useState<CashflowResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<{ in: boolean; out: boolean; rec: boolean }>({ in: false, out: false, rec: false })
  const seq = useRef(0)

  const load = useCallback(async () => {
    const my = ++seq.current
    setLoading(true); setError('')
    try {
      const d = await cashflowApi.get(days)
      if (my !== seq.current) return
      setCf(d)
    } catch (e: any) {
      if (my !== seq.current) return
      setError(e?.response?.data?.error ?? 'Nie udało się policzyć prognozy gotówki.')
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [days])

  useEffect(() => { load() }, [load])

  const sum = (xs: Array<{ amount: number }>) => xs.reduce((s, x) => s + x.amount, 0)

  return (
    <Card title={`Gotówka: najbliższe ${days} dni`} subtitle="Prognoza: saldo dziś + spodziewane wpłaty klientów − faktury do zapłacenia − stałe opłaty (pensje, ZUS, podatki, czynsz)."
      right={
        <div className="flex items-center gap-1">
          <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
            {DAY_OPTIONS.map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-2 py-1 rounded-md text-xs font-semibold ${days === d ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
                {d} dni
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading} title="Odśwież" className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      }>
      {error ? <ErrorBox>{error}</ErrorBox>
        : loading && !cf ? <div className="py-10 text-center text-sm text-gray-400">Liczę prognozę…</div>
        : !cf ? null : (
          <div className={loading ? 'opacity-60' : ''}>
            {!cf.has_balances && (
              <div className="mb-3">
                <InfoBox>
                  Brak sald bankowych — prognoza startuje od 0 zł.{' '}
                  <button onClick={() => navigate('/platnosci')} className="font-semibold underline">Wgraj wyciąg MT940 →</button>
                </InfoBox>
              </div>
            )}
            {cf.warnings.length > 0 && (
              <ul className="mb-3 space-y-1.5">
                {cf.warnings.map((w, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
                    <TriangleAlert size={15} className="flex-shrink-0 text-amber-600 dark:text-amber-400" /> {w}
                  </li>
                ))}
              </ul>
            )}

            <div className="grid grid-cols-3 gap-3 mb-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Dziś ({fmtDate(cf.as_of)})</div>
                <div className="text-base font-bold tabular-nums text-gray-800 dark:text-gray-100">{cf.cash.total_pln === null ? '—' : money0(cf.cash.total_pln)}</div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Najniżej ({fmtDate(cf.min.date)})</div>
                <div className={`text-base font-bold tabular-nums ${cf.min.balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{money0(cf.min.balance)}</div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Za {days} dni</div>
                <div className={`text-base font-bold tabular-nums ${cf.end_balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{money0(cf.end_balance)}</div>
              </div>
            </div>

            <BalanceChart cf={cf} />

            <div className="grid md:grid-cols-3 gap-2 mt-3">
              <EntryList title="Wpływy (klienci)" items={cf.receivables} total={sum(cf.receivables)} open={open.in} onToggle={() => setOpen(o => ({ ...o, in: !o.in }))}
                render={(it: CashflowEntry) => (
                  <>
                    <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-200" title={it.label}>{it.label}</span>
                    <span className={`whitespace-nowrap ${it.overdue ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>{it.overdue ? 'po terminie' : fmtDate(it.due_date)}</span>
                    <span className="tabular-nums font-semibold text-green-700 dark:text-green-400 whitespace-nowrap">+{money0(it.amount)}</span>
                  </>
                )} />
              <EntryList title="Wypływy (faktury)" items={cf.payables} total={sum(cf.payables)} open={open.out} onToggle={() => setOpen(o => ({ ...o, out: !o.out }))}
                render={(it: CashflowEntry) => (
                  <>
                    <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-200" title={it.label}>{it.label}</span>
                    <span className={`whitespace-nowrap ${it.overdue ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>{it.overdue ? 'po terminie' : fmtDate(it.due_date)}</span>
                    <span className="tabular-nums font-semibold text-red-600 dark:text-red-400 whitespace-nowrap">−{money0(it.amount)}</span>
                  </>
                )} />
              <EntryList title="Stałe opłaty (co miesiąc)" items={cf.recurring} total={sum(cf.recurring)} open={open.rec} onToggle={() => setOpen(o => ({ ...o, rec: !o.rec }))}
                render={(it: CashflowRecurring) => (
                  <>
                    <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-200" title={it.subcategory}>{it.label}</span>
                    <span className="text-gray-400 whitespace-nowrap">ok. {it.day_of_month}. dnia</span>
                    <span className="tabular-nums font-semibold text-red-600 dark:text-red-400 whitespace-nowrap">−{money0(it.amount)}</span>
                  </>
                )} />
            </div>
            <Hint>Faktury po terminie: zakładamy, że klient zapłaci za 7 dni, a my dostawcy za 3 dni. Stałe opłaty = średnia z ostatnich 3 miesięcy wyciągów.</Hint>
          </div>
        )}
    </Card>
  )
}
