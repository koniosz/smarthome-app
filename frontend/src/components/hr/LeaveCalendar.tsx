import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../ui/Modal'
import { hrApi, LEAVE_TYPE_LABELS } from '../../api/client'
import type { HrLeaveCalendar, HrLeaveCalendarDay, HrLeaveCalendarEmployee, HrLeaveCalendarLeave, LeaveType } from '../../api/client'
import CancelLeaveModal from './CancelLeaveModal'
import { inputCls, lblCls, STATUS_BADGE, fmt, fmtDate, todayIso } from './hrShared'

// Po zatwierdzeniu/dodaniu/przesunięciu urlopu backend usuwa wpisy auto-grafiku z tych dni,
// a ręczne wpisy z godzinami zwraca do decyzji admina.
function warnConflicts(r: { conflicting_entries?: Array<{ date: string; hours_worked: number }> } | undefined) {
  const c = r?.conflicting_entries
  if (c && c.length) alert(`Uwaga: w ewidencji są ręczne wpisy czasu pracy z dni tego urlopu (${c.map(x => `${fmtDate(x.date)}: ${x.hours_worked} h`).join(', ')}). Sprawdź i popraw je w zakładce „Ewidencja czasu pracy”.`)
}

// ═══ Kalendarz urlopów: pracownicy × dni miesiąca (jak w Calamari) ═══
// readOnly=true → „Kalendarz zespołu” dla pracownika: bez akcji; backend i tak maskuje typy jako 'absence'.

type CalType = LeaveType | 'absence'
type Sel = { leave: HrLeaveCalendarLeave; employee: HrLeaveCalendarEmployee }

const DOW_SHORT = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So']

// Skróty w komórce (1–3 znaki)
const TYPE_ABBR: Record<CalType, string> = {
  wypoczynkowy: 'W', na_zadanie: 'NŻ', okolicznosciowy: 'OK', bezplatny: 'BZ', opieka_dziecko: 'OP', opiekunczy: 'OPK',
  macierzynski: 'M', rodzicielski: 'R', ojcowski: 'O', wychowawczy: 'WY', chorobowe: 'L4', inna: 'I', absence: 'N',
}

// Paleta per typ: solid = zatwierdzony, soft = oczekujący (jaśniejsze tło + przerywana ramka), dot = próbka w legendzie.
// Klasy muszą być literałami, żeby Tailwind je wygenerował.
const TYPE_STYLE: Record<CalType, { solid: string; soft: string; dot: string }> = {
  wypoczynkowy:    { solid: 'bg-violet-500 text-white',  soft: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-200 border-violet-500',   dot: 'bg-violet-500' },
  na_zadanie:      { solid: 'bg-indigo-500 text-white',  soft: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-200 border-indigo-500',   dot: 'bg-indigo-500' },
  chorobowe:       { solid: 'bg-red-500 text-white',     soft: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-200 border-red-500',                  dot: 'bg-red-500' },
  okolicznosciowy: { solid: 'bg-amber-500 text-white',   soft: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-200 border-amber-500',        dot: 'bg-amber-500' },
  bezplatny:       { solid: 'bg-gray-400 dark:bg-gray-500 text-white', soft: 'bg-gray-100 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200 border-gray-400', dot: 'bg-gray-400 dark:bg-gray-500' },
  opieka_dziecko:  { solid: 'bg-emerald-500 text-white', soft: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-200 border-emerald-500', dot: 'bg-emerald-500' },
  opiekunczy:      { solid: 'bg-green-600 text-white',   soft: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200 border-green-600',        dot: 'bg-green-600' },
  macierzynski:    { solid: 'bg-pink-500 text-white',    soft: 'bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-200 border-pink-500',             dot: 'bg-pink-500' },
  rodzicielski:    { solid: 'bg-pink-400 text-white',    soft: 'bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-200 border-pink-400',             dot: 'bg-pink-400' },
  ojcowski:        { solid: 'bg-rose-500 text-white',    soft: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-200 border-rose-500',             dot: 'bg-rose-500' },
  wychowawczy:     { solid: 'bg-fuchsia-500 text-white', soft: 'bg-fuchsia-100 dark:bg-fuchsia-900/40 text-fuchsia-700 dark:text-fuchsia-200 border-fuchsia-500', dot: 'bg-fuchsia-500' },
  inna:            { solid: 'bg-slate-500 text-white',   soft: 'bg-slate-100 dark:bg-slate-700/60 text-slate-700 dark:text-slate-200 border-slate-500',        dot: 'bg-slate-500' },
  absence:         { solid: 'bg-slate-500 text-white',   soft: 'bg-slate-100 dark:bg-slate-700/60 text-slate-700 dark:text-slate-200 border-slate-500',        dot: 'bg-slate-500' },
}
const CANCELLED_STYLE = 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 line-through'
// Przy nakładających się wpisach w tym samym dniu pokazujemy „najmocniejszy” status
const STATUS_RANK: Record<HrLeaveCalendarLeave['status'], number> = { approved: 0, pending: 1, cancelled: 2 }

function typeLabel(t: string) { return t === 'absence' ? 'Nieobecność' : ((LEAVE_TYPE_LABELS as Record<string, string>)[t] ?? t) }
function styleOf(t: string) { return TYPE_STYLE[t as CalType] ?? TYPE_STYLE.inna }
function abbrOf(t: string) { return TYPE_ABBR[t as CalType] ?? '?' }
function addMonths(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function monthTitle(month: string) {
  const [y, m] = month.split('-').map(Number)
  const s = new Date(y, m - 1, 1).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}
// Dzień tygodnia liczony lokalnie z daty (niezależnie od konwencji `dow` backendu)
function dowOf(date: string) { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).getDay() }
function leaveTitle(emp: HrLeaveCalendarEmployee, l: HrLeaveCalendarLeave) {
  const lines = [emp.name, typeLabel(l.type), `${fmtDate(l.date_from)} – ${fmtDate(l.date_to)} · ${fmt(l.days_count)} dni rob.`, `Status: ${STATUS_BADGE[l.status]?.label ?? l.status}`]
  if (l.comment) lines.push(`Komentarz: ${l.comment}`)
  if (l.admin_comment) lines.push(`Komentarz admina: ${l.admin_comment}`)
  return lines.join('\n')
}

const navBtn = 'w-8 h-8 flex items-center justify-center text-lg rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
const smallBtn = 'px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
const primaryBtn = 'px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50'
const ghostBtn = 'px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg'

export default function LeaveCalendar({ readOnly }: { readOnly: boolean }) {
  const [month, setMonth] = useState(() => todayIso().slice(0, 7))
  const [includeCancelled, setIncludeCancelled] = useState(false)
  const [data, setData] = useState<HrLeaveCalendar | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Sekwencer żądań — przy szybkim klikaniu ‹ › ignorujemy spóźnione odpowiedzi
  const seq = useRef(0)

  const withCancelled = !readOnly && includeCancelled
  const load = useCallback(() => {
    const id = ++seq.current
    setLoading(true); setError('')
    hrApi.leaveCalendar(month, withCancelled)
      .then(d => { if (id !== seq.current) return; setData(d); setLoading(false) })
      .catch((e: any) => { if (id !== seq.current) return; setError(e?.response?.data?.error || 'Nie udało się pobrać kalendarza.'); setLoading(false) })
  }, [month, withCancelled])
  useEffect(() => { load() }, [load])

  const canEdit = !readOnly && !!data && !data.read_only

  const [details, setDetails] = useState<Sel | null>(null)
  const [editing, setEditing] = useState<Sel | null>(null)
  const [cancelling, setCancelling] = useState<Sel | null>(null)
  const [creating, setCreating] = useState<{ employee_id: string; date: string } | null>(null)
  const afterAction = () => { setDetails(null); setEditing(null); setCancelling(null); setCreating(null); load() }

  // Indeks: pracownik → data → wpis (urlopy spoza miesiąca przycinamy do zakresu)
  const grid = useMemo(() => {
    const map = new Map<string, Map<string, HrLeaveCalendarLeave>>()
    if (!data) return map
    for (const l of data.leaves) {
      let m = map.get(l.employee_id)
      if (!m) { m = new Map(); map.set(l.employee_id, m) }
      for (const d of data.days) {
        if (d.date < l.date_from || d.date > l.date_to) continue
        const cur = m.get(d.date)
        if (!cur || STATUS_RANK[l.status] < STATUS_RANK[cur.status]) m.set(d.date, l)
      }
    }
    return map
  }, [data])

  // Liczba dni roboczych urlopu (approved) w miesiącu per pracownik — do nawiasu przy nazwisku
  const approvedDays = useMemo(() => {
    const out: Record<string, number> = {}
    if (!data) return out
    for (const emp of data.employees) {
      const m = grid.get(emp.id); let n = 0
      if (m) for (const d of data.days) { if (d.is_weekend || d.is_holiday) continue; const l = m.get(d.date); if (l?.status === 'approved') n++ }
      out[emp.id] = n
    }
    return out
  }, [data, grid])

  // Legenda: tylko typy występujące w miesiącu (dla pracownika i tak zamaskowane)
  const legendTypes = useMemo(() => {
    if (!data) return [] as CalType[]
    const present = new Set(data.leaves.map(l => l.type))
    const order: CalType[] = [...(Object.keys(LEAVE_TYPE_LABELS) as LeaveType[]), 'absence']
    return order.filter(t => present.has(t))
  }, [data])

  const defaultCreateDate = () => {
    if (!data) return todayIso()
    if (data.today >= data.from && data.today <= data.to) return data.today
    return data.days.find(d => !d.is_weekend && !d.is_holiday)?.date ?? data.from
  }

  const renderCell = (emp: HrLeaveCalendarEmployee, d: HrLeaveCalendarDay, idx: number, days: HrLeaveCalendarDay[]) => {
    const m = grid.get(emp.id)
    const leave = m?.get(d.date)
    const off = d.is_weekend || d.is_holiday
    const isToday = d.date === data!.today
    const tdBase = `p-0 border-b border-gray-100 dark:border-gray-800 ${isToday ? 'bg-violet-50 dark:bg-violet-900/25' : off ? 'bg-gray-100/80 dark:bg-gray-800/60' : ''}`
    if (!leave) {
      const clickable = canEdit && !off
      return (
        <td key={d.date} className={`${tdBase} ${clickable ? 'cursor-pointer hover:bg-violet-100 dark:hover:bg-violet-900/40' : ''}`}
          title={clickable ? `${emp.name} · ${fmtDate(d.date)} — kliknij, aby dodać nieobecność` : (d.holiday_name || undefined)}
          onClick={clickable ? () => setCreating({ employee_id: emp.id, date: d.date }) : undefined}>
          <div className="h-8 w-8" />
        </td>
      )
    }
    const prev = idx > 0 ? m?.get(days[idx - 1].date) : undefined
    const next = idx < days.length - 1 ? m?.get(days[idx + 1].date) : undefined
    const isStart = prev?.id !== leave.id
    const isEnd = next?.id !== leave.id
    const st = styleOf(leave.type)
    const look = leave.status === 'cancelled' ? CANCELLED_STYLE
      : leave.status === 'pending' ? `${st.soft} border-y border-dashed ${isStart ? 'border-l' : ''} ${isEnd ? 'border-r' : ''}`
      : st.solid
    const bar = `h-6 my-1 flex items-center justify-center text-[10px] font-bold leading-none select-none ${look} ${isStart ? 'rounded-l-md ml-0.5' : ''} ${isEnd ? 'rounded-r-md mr-0.5' : ''} ${off ? 'opacity-40' : ''}`
    return (
      <td key={d.date} className={`${tdBase} ${canEdit ? 'cursor-pointer' : ''}`} title={leaveTitle(emp, leave)}
        onClick={canEdit ? () => setDetails({ leave, employee: emp }) : undefined}>
        <div className={bar}>{off ? '' : abbrOf(leave.type)}</div>
      </td>
    )
  }

  return (
    <div className="space-y-3">
      {/* Nagłówek: nawigacja po miesiącach + akcje */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button onClick={() => setMonth(m => addMonths(m, -1))} className={navBtn} aria-label="Poprzedni miesiąc" title="Poprzedni miesiąc">‹</button>
          <div className="min-w-[170px] text-center text-sm font-semibold text-gray-800 dark:text-gray-100">{monthTitle(month)}</div>
          <button onClick={() => setMonth(m => addMonths(m, 1))} className={navBtn} aria-label="Następny miesiąc" title="Następny miesiąc">›</button>
        </div>
        <button onClick={() => setMonth(todayIso().slice(0, 7))} className={smallBtn}>Dziś</button>
        {loading && data && <span className="text-xs text-gray-400">Odświeżanie…</span>}
        <div className="flex-1" />
        {!readOnly && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={includeCancelled} onChange={e => setIncludeCancelled(e.target.checked)} /> pokaż anulowane
          </label>
        )}
        {canEdit && (
          <button onClick={() => setCreating({ employee_id: data!.employees[0]?.id ?? '', date: defaultCreateDate() })} disabled={!data || data.employees.length === 0}
            className="px-3.5 py-1.5 text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">+ Dodaj nieobecność</button>
        )}
      </div>

      {error ? (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="flex-1">{error}</span>
          <button onClick={load} className={smallBtn}>Spróbuj ponownie</button>
        </div>
      ) : !data ? (
        <div className="text-center py-10 text-gray-400">Ładowanie…</div>
      ) : data.employees.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">Brak aktywnych pracowników w tym miesiącu.</div>
      ) : (
        <>
          {/* Siatka: sticky pierwsza kolumna + sticky nagłówek dni; kontener przewija się w obu osiach */}
          <div className={`border border-gray-200 dark:border-gray-800 rounded-xl overflow-auto max-h-[75vh] ${loading ? 'opacity-70' : ''}`}>
            <table className="border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-30 bg-gray-50 dark:bg-gray-800 text-left px-3 py-2 min-w-[180px] font-medium text-gray-500 dark:text-gray-400 border-b border-r border-gray-200 dark:border-gray-700">
                    Pracownik <span className="font-normal text-gray-400">(dni urlopu)</span>
                  </th>
                  {data.days.map(d => {
                    const off = d.is_weekend || d.is_holiday
                    const isToday = d.date === data.today
                    const cls = isToday ? 'bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-200'
                      : off ? 'bg-gray-100 dark:bg-gray-800 text-red-400 dark:text-red-400/80'
                      : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                    return (
                      <th key={d.date} className={`sticky top-0 z-20 w-8 min-w-[32px] px-0 py-1 text-center font-medium border-b border-gray-200 dark:border-gray-700 ${cls}`}
                        title={d.is_holiday ? `${d.holiday_name ?? 'Święto'} · ${fmtDate(d.date)}` : fmtDate(d.date)}>
                        <div className="text-[11px] font-semibold leading-tight">{Number(d.date.slice(8))}</div>
                        <div className="text-[9px] font-normal leading-tight">{DOW_SHORT[dowOf(d.date)]}{d.is_holiday ? '*' : ''}</div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {data.employees.map(emp => (
                  <tr key={emp.id}>
                    <td className="sticky left-0 z-10 bg-white dark:bg-gray-900 px-3 py-1 border-b border-r border-gray-100 dark:border-gray-800 whitespace-nowrap" title={emp.position || undefined}>
                      <span className="font-medium text-gray-800 dark:text-gray-100">{emp.name}</span>
                      <span className="text-gray-400 ml-1">({approvedDays[emp.id] ?? 0})</span>
                    </td>
                    {data.days.map((d, i) => renderCell(emp, d, i, data.days))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 font-medium text-gray-500 dark:text-gray-400 border-t border-r border-gray-200 dark:border-gray-700 whitespace-nowrap">Nieobecni</td>
                  {data.days.map(d => {
                    const n = data.absent_per_day[d.date] ?? 0
                    const off = d.is_weekend || d.is_holiday
                    const cls = n >= 2 ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 font-bold'
                      : n === 1 ? 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-medium'
                      : off ? 'bg-gray-100 dark:bg-gray-800 text-gray-300 dark:text-gray-600' : 'bg-gray-50 dark:bg-gray-800 text-gray-300 dark:text-gray-600'
                    return (
                      <td key={d.date} className={`text-center py-1.5 border-t border-gray-200 dark:border-gray-700 ${cls}`}
                        title={n ? `${fmtDate(d.date)}: nieobecnych ${n}` : undefined}>{n || '·'}</td>
                    )
                  })}
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Legenda */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            {legendTypes.map(t => (
              <span key={t} className="flex items-center gap-1.5">
                <span className={`inline-block w-3 h-3 rounded-sm ${styleOf(t).dot}`} />
                <span><b>{abbrOf(t)}</b> – {typeLabel(t)}</span>
              </span>
            ))}
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm border border-dashed border-gray-500" /> oczekujący</span>
            {withCancelled && <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-gray-200 dark:bg-gray-700" /> <span className="line-through">anulowany</span></span>}
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700" /> weekend / święto (*)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-violet-100 dark:bg-violet-900/50" /> dziś</span>
            {canEdit && <span className="text-gray-400">Kliknij wpis — szczegóły i akcje; pusty dzień roboczy — dodaj nieobecność.</span>}
          </div>
        </>
      )}

      {/* Modale (tylko admin) */}
      {canEdit && details && (
        <LeaveDetailsModal sel={details} onClose={() => setDetails(null)} onChanged={afterAction}
          onEdit={() => { setEditing(details); setDetails(null) }}
          onCancelLeave={() => { setCancelling(details); setDetails(null) }} />
      )}
      {canEdit && editing && <EditLeaveModal sel={editing} onClose={() => setEditing(null)} onSaved={afterAction} />}
      {canEdit && cancelling && (
        <CancelLeaveModal request={{ ...cancelling.leave, employee: { name: cancelling.employee.name } }}
          onClose={saved => { setCancelling(null); if (saved) load() }} />
      )}
      {canEdit && creating && data && (
        <CreateLeaveModal employees={data.employees} employeeId={creating.employee_id} date={creating.date}
          onClose={() => setCreating(null)} onSaved={afterAction} />
      )}
    </div>
  )
}

// ═══ Szczegóły wpisu + akcje admina ═══
function LeaveDetailsModal({ sel, onClose, onChanged, onEdit, onCancelLeave }: {
  sel: Sel; onClose: () => void; onChanged: () => void; onEdit: () => void; onCancelLeave: () => void
}) {
  const { leave: l, employee: emp } = sel
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const st = STATUS_BADGE[l.status] ?? STATUS_BADGE.pending
  const today = todayIso()
  const inProgress = l.date_from <= today && l.date_to >= today

  const decide = async (decision: 'approved' | 'rejected') => {
    let comment: string | undefined
    if (decision === 'rejected') {
      const p = window.prompt('Powód odrzucenia (opcjonalnie):')
      if (p === null) return // anulowano
      comment = p.trim() || undefined
    }
    setBusy(true); setErr('')
    try { const r = await hrApi.decide(l.id, decision, comment); warnConflicts(r); onChanged() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Błąd.'); setBusy(false) }
  }

  return (
    <Modal title="Nieobecność" onClose={onClose}>
      <div className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-800 dark:text-gray-100">{emp.name}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <span className={`inline-block w-3 h-3 rounded-sm ${styleOf(l.type).dot}`} /> {typeLabel(l.type)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{fmtDate(l.date_from)} – {fmtDate(l.date_to)} · {fmt(l.days_count)} dni rob.</div>
          {l.comment && <div className="text-xs text-gray-600 dark:text-gray-300">Komentarz: „{l.comment}”</div>}
          {l.admin_comment && <div className="text-xs text-amber-600 dark:text-amber-400">Komentarz admina: {l.admin_comment}</div>}
        </div>
        {err && <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{err}</div>}
        <div className="flex flex-wrap gap-2 justify-end">
          {l.status === 'pending' && (
            <>
              <button onClick={() => decide('approved')} disabled={busy} className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50">✓ Zatwierdź</button>
              <button onClick={() => decide('rejected')} disabled={busy} className="px-3 py-1.5 text-xs font-medium border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg disabled:opacity-50">✗ Odrzuć</button>
            </>
          )}
          {l.status !== 'cancelled' && (
            <button onClick={onEdit} disabled={busy} className="px-3 py-1.5 text-xs font-medium border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30 rounded-lg disabled:opacity-50">✎ Edytuj termin / typ</button>
          )}
          {l.status === 'approved' && (
            <button onClick={onCancelLeave} disabled={busy} title="Niewykorzystane dni wracają do puli, wpis zostaje w historii"
              className="px-3 py-1.5 text-xs font-medium border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 rounded-lg disabled:opacity-50">
              {inProgress ? '↩ Odwołaj z urlopu' : '↩ Anuluj urlop'}
            </button>
          )}
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Zamknij</button>
        </div>
      </div>
    </Modal>
  )
}

// ═══ Edycja terminu / typu / komentarzy (tylko pending/approved) ═══
function EditLeaveModal({ sel, onClose, onSaved }: { sel: Sel; onClose: () => void; onSaved: () => void }) {
  const { leave: l, employee: emp } = sel
  const [type, setType] = useState<LeaveType>(l.type === 'absence' ? 'inna' : l.type)
  const [from, setFrom] = useState(l.date_from)
  const [to, setTo] = useState(l.date_to)
  const [comment, setComment] = useState(l.comment ?? '')
  const [adminComment, setAdminComment] = useState(l.admin_comment ?? '')
  const [force, setForce] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  // Zatwierdzony urlop, który już trwa / minął: zmiana terminu tylko dla błędnego wpisu (do odwołania służy „Odwołaj z urlopu”)
  const started = l.status === 'approved' && l.date_from < todayIso()
  const rangeChanged = from !== l.date_from || to !== l.date_to

  const save = async () => {
    // Wysyłamy tylko zmienione pola
    const patch: Parameters<typeof hrApi.adminUpdateLeave>[1] = {}
    if (from !== l.date_from) patch.date_from = from
    if (to !== l.date_to) patch.date_to = to
    if (started && rangeChanged) { if (!force) { setErr('Zaznacz „wpis jest błędny”, żeby zmienić termin urlopu, który już trwa lub minął.'); return } patch.force = true }
    if (type !== l.type) patch.type = type
    if (comment.trim() !== (l.comment ?? '')) patch.comment = comment.trim()
    if (adminComment.trim() !== (l.admin_comment ?? '')) patch.admin_comment = adminComment.trim()
    if (Object.keys(patch).length === 0) { onClose(); return }
    if (to < from) { setErr('Data „do” nie może być wcześniejsza niż „od”.'); return }
    setSaving(true); setErr('')
    try { const r = await hrApi.adminUpdateLeave(l.id, patch); warnConflicts(r); onSaved() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu.'); setSaving(false) }
  }

  return (
    <Modal title="Edytuj nieobecność" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-gray-500 dark:text-gray-400">{emp.name} · obecnie {fmtDate(l.date_from)} – {fmtDate(l.date_to)} · {fmt(l.days_count)} dni rob.</p>
        <div><label className={lblCls}>Rodzaj</label>
          <select className={inputCls} value={type} onChange={e => setType(e.target.value as LeaveType)}>
            {(Object.entries(LEAVE_TYPE_LABELS) as [LeaveType, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={lblCls}>Od</label><input type="date" className={inputCls} value={from} onChange={e => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value) }} /></div>
          <div><label className={lblCls}>Do</label><input type="date" className={inputCls} value={to} min={from} onChange={e => setTo(e.target.value)} /></div>
        </div>
        <div><label className={lblCls}>Komentarz pracownika</label><input className={inputCls} value={comment} onChange={e => setComment(e.target.value)} /></div>
        <div><label className={lblCls}>Komentarz admina (widzi pracownik)</label><input className={inputCls} value={adminComment} onChange={e => setAdminComment(e.target.value)} /></div>
        <p className="text-xs text-gray-400">Liczba dni roboczych i saldo przeliczą się automatycznie.</p>
        {started && rangeChanged && (
          <div className="text-xs rounded-lg px-3 py-2 bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300 space-y-2">
            <p>Ten urlop już trwa lub się zakończył — dni do dziś zostały wykorzystane. Żeby odwołać pracownika z urlopu, użyj „Odwołaj z urlopu”. Zmiana terminu jest tylko dla błędnego wpisu.</p>
            <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} /> Wpis jest błędny — zmień termin mimo to</label>
          </div>
        )}
        {err && <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className={ghostBtn}>Anuluj</button>
          <button onClick={save} disabled={saving} className={primaryBtn}>{saving ? 'Zapisywanie…' : 'Zapisz'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ═══ Admin dodaje nieobecność za pracownika ═══
function CreateLeaveModal({ employees, employeeId, date, onClose, onSaved }: {
  employees: HrLeaveCalendarEmployee[]; employeeId: string; date: string; onClose: () => void; onSaved: () => void
}) {
  const [empId, setEmpId] = useState(employeeId || employees[0]?.id || '')
  const [type, setType] = useState<LeaveType>('wypoczynkowy')
  const [from, setFrom] = useState(date)
  const [to, setTo] = useState(date)
  const [comment, setComment] = useState('')
  const [status, setStatus] = useState<'approved' | 'pending'>('approved')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!empId) { setErr('Wybierz pracownika.'); return }
    if (to < from) { setErr('Data „do” nie może być wcześniejsza niż „od”.'); return }
    setSaving(true); setErr('')
    try { const r = await hrApi.adminCreateLeave({ employee_id: empId, type, date_from: from, date_to: to, comment: comment.trim() || undefined, status }); warnConflicts(r); onSaved() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu.'); setSaving(false) }
  }

  return (
    <Modal title="Dodaj nieobecność" onClose={onClose}>
      <div className="space-y-4">
        <div><label className={lblCls}>Pracownik</label>
          <select className={inputCls} value={empId} onChange={e => setEmpId(e.target.value)}>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.position ? ` — ${e.position}` : ''}</option>)}
          </select>
        </div>
        <div><label className={lblCls}>Rodzaj</label>
          <select className={inputCls} value={type} onChange={e => setType(e.target.value as LeaveType)}>
            {(Object.entries(LEAVE_TYPE_LABELS) as [LeaveType, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={lblCls}>Od</label><input type="date" className={inputCls} value={from} onChange={e => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value) }} /></div>
          <div><label className={lblCls}>Do</label><input type="date" className={inputCls} value={to} min={from} onChange={e => setTo(e.target.value)} /></div>
        </div>
        <div><label className={lblCls}>Komentarz (opcjonalnie)</label><input className={inputCls} value={comment} onChange={e => setComment(e.target.value)} placeholder="np. zgłoszone telefonicznie" /></div>
        <div><label className={lblCls}>Status</label>
          <div className="flex gap-4 text-sm text-gray-700 dark:text-gray-200">
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="leave-status" checked={status === 'approved'} onChange={() => setStatus('approved')} /> Zatwierdzony</label>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="leave-status" checked={status === 'pending'} onChange={() => setStatus('pending')} /> Oczekujący</label>
          </div>
        </div>
        <p className="text-xs text-gray-400">Dni robocze liczone automatycznie — bez sobót, niedziel i świąt.</p>
        {err && <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className={ghostBtn}>Anuluj</button>
          <button onClick={save} disabled={saving} className={primaryBtn}>{saving ? 'Zapisywanie…' : 'Dodaj'}</button>
        </div>
      </div>
    </Modal>
  )
}
