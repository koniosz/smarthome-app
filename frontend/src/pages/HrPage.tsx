import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/ui/Modal'
import { hrApi, LEAVE_TYPE_LABELS } from '../api/client'
import type { LeaveType, HrLeaveBalance, HrLeaveRequest, HrEwidencja } from '../api/client'
import type { Employee } from '../types'
import { useAuth } from '../auth/AuthContext'

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
const lblCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'
const DOW = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So']
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Oczekuje', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  approved: { label: '✓ Zatwierdzony', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  rejected: { label: '✗ Odrzucony', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  cancelled: { label: 'Anulowany', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
}

function fmt(n: number) { return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(n || 0) }
function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s); return isNaN(d.getTime()) ? s : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function thisMonth() { return new Date().toISOString().slice(0, 7) }

export default function HrPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [tab, setTab] = useState<'dane' | 'urlopy' | 'czas' | 'admin'>('dane')
  const [me, setMe] = useState<{ employee: Employee | null; balance?: HrLeaveBalance; requests?: HrLeaveRequest[] } | null>(null)
  const [loading, setLoading] = useState(true)

  const loadMe = () => hrApi.me().then(setMe).catch(() => setMe({ employee: null })).finally(() => setLoading(false))
  useEffect(() => { loadMe() }, [])

  const tabs = [
    { key: 'dane' as const, label: '👤 Moje dane' },
    { key: 'urlopy' as const, label: '🏖 Urlopy' },
    { key: 'czas' as const, label: '⏱ Czas pracy' },
    ...(isAdmin ? [{ key: 'admin' as const, label: '🛠 Administracja HR' }] : []),
  ]

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">HR</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">Twoje dane, urlopy i ewidencja czasu pracy</p>
      </div>

      <div className="flex gap-1 mb-5 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit flex-wrap">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${tab === t.key ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <div className="text-center py-16 text-gray-400">Ładowanie…</div> : (
        <>
          {tab !== 'admin' && !me?.employee && (
            <div className="text-center py-14 text-gray-500 dark:text-gray-400">
              <div className="text-4xl mb-3">🪪</div>
              <p className="text-sm">Brak powiązanej kartoteki pracownika dla Twojego konta ({user?.email}).<br />Poproś administratora o dodanie Cię w sekcji Pracownicy (z tym samym adresem e-mail).</p>
            </div>
          )}
          {tab === 'dane' && me?.employee && <MojeDane employee={me.employee} balance={me.balance} />}
          {tab === 'urlopy' && me?.employee && <Urlopy me={me} onChanged={loadMe} />}
          {tab === 'czas' && me?.employee && <CzasPracy />}
          {tab === 'admin' && isAdmin && <AdminHR />}
        </>
      )}
    </div>
  )
}

// ═══ Moje dane ═══
function MojeDane({ employee, balance }: { employee: Employee; balance?: HrLeaveBalance }) {
  const rows: Array<[string, string]> = [
    ['Imię i nazwisko', employee.name],
    ['Stanowisko', employee.position || '—'],
    ['E-mail', employee.email || '—'],
    ['Telefon', employee.phone || '—'],
    ['Adres', employee.address || '—'],
    ['Forma zatrudnienia', employee.employment_type === 'employment' ? 'Umowa o pracę' : employee.employment_type],
    ['Data rozpoczęcia', fmtDate(employee.start_date)],
    ['Badania lekarskie — ważne do', fmtDate(employee.medical_exam_date)],
    ['Szkolenie BHP — ważne do', fmtDate(employee.bhp_date)],
  ]
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-3">Dane pracownika</h2>
        <div className="space-y-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 text-sm border-b border-gray-50 dark:border-gray-800 pb-1.5">
              <span className="text-gray-500 dark:text-gray-400">{k}</span>
              <span className="font-medium text-gray-800 dark:text-gray-100 text-right">{v}</span>
            </div>
          ))}
        </div>
      </div>
      {balance && <BalanceCards balance={balance} />}
    </div>
  )
}

function BalanceCards({ balance }: { balance: HrLeaveBalance }) {
  const cards = [
    { label: `Dostępny urlop ${balance.year}`, value: `${fmt(balance.remaining_days)} dni`, sub: `z ${fmt(balance.total_days)} (wymiar ${fmt(balance.entitlement_days)}${balance.carried_over_days ? ` + zaległy ${fmt(balance.carried_over_days)}` : ''}${balance.adjustment_days ? ` + korekta ${fmt(balance.adjustment_days)}` : ''})`, accent: 'text-green-600 dark:text-green-400' },
    { label: 'Wykorzystano', value: `${fmt(balance.used_days)} dni`, sub: 'zatwierdzone wnioski', accent: 'text-gray-800 dark:text-gray-100' },
    { label: 'Na żądanie (art. 167²)', value: `${fmt(balance.on_demand_used)} / ${balance.on_demand_limit}`, sub: 'w ramach puli urlopowej', accent: 'text-violet-600 dark:text-violet-400' },
  ]
  return (
    <div className="space-y-3">
      {cards.map(c => (
        <div key={c.label} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{c.label}</div>
          <div className={`text-2xl font-bold ${c.accent}`}>{c.value}</div>
          <div className="text-xs text-gray-400">{c.sub}</div>
        </div>
      ))}
      {balance.carried_over_days > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
          ⚠️ Urlop zaległy należy wykorzystać do 30 września (art. 168 KP).
        </div>
      )}
    </div>
  )
}

// ═══ Urlopy ═══
function Urlopy({ me, onChanged }: { me: { employee: Employee | null; balance?: HrLeaveBalance; requests?: HrLeaveRequest[] }; onChanged: () => void }) {
  const [showNew, setShowNew] = useState(false)
  const requests = me.requests ?? []
  return (
    <div className="space-y-4">
      {me.balance && <div className="grid sm:grid-cols-3 gap-3"><BalanceCards balance={me.balance} /></div>}
      <div className="flex justify-end">
        <button onClick={() => setShowNew(true)} className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">+ Wniosek urlopowy</button>
      </div>
      {requests.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">Brak wniosków. Złóż pierwszy wniosek urlopowy.</div>
      ) : (
        <div className="space-y-2">
          {requests.map(r => {
            const st = STATUS_BADGE[r.status] ?? STATUS_BADGE.pending
            return (
              <div key={r.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3.5 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-800 dark:text-gray-100">{LEAVE_TYPE_LABELS[r.type] ?? r.type}</div>
                  <div className="text-xs text-gray-400">{fmtDate(r.date_from)} – {fmtDate(r.date_to)} · {fmt(r.days_count)} dni rob.{r.comment ? ` · ${r.comment}` : ''}</div>
                  {r.admin_comment && <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Komentarz: {r.admin_comment}</div>}
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                {r.status === 'pending' && (
                  <button onClick={async () => { if (window.confirm('Anulować wniosek?')) { await hrApi.cancelLeave(r.id); onChanged() } }}
                    className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-500 rounded hover:bg-gray-100 dark:hover:bg-gray-800">Anuluj</button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {showNew && <NewLeaveModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); onChanged() }} />}
    </div>
  )
}

function NewLeaveModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<LeaveType>('wypoczynkowy')
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10))
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const save = async () => {
    setSaving(true); setErr('')
    try { await hrApi.createLeave({ type, date_from: from, date_to: to, comment: comment.trim() || undefined }); onSaved() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu wniosku.') } finally { setSaving(false) }
  }
  return (
    <Modal title="Nowy wniosek urlopowy" onClose={onClose}>
      <div className="space-y-4">
        <div><label className={lblCls}>Rodzaj</label>
          <select className={inputCls} value={type} onChange={e => setType(e.target.value as LeaveType)}>
            {(Object.entries(LEAVE_TYPE_LABELS) as [LeaveType, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={lblCls}>Od</label><input type="date" className={inputCls} value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div><label className={lblCls}>Do</label><input type="date" className={inputCls} value={to} onChange={e => setTo(e.target.value)} /></div>
        </div>
        <div><label className={lblCls}>Komentarz (opcjonalnie)</label><input className={inputCls} value={comment} onChange={e => setComment(e.target.value)} placeholder="np. urlop rodzinny" /></div>
        <p className="text-xs text-gray-400">Liczba dni liczona automatycznie — dni robocze bez sobót, niedziel i świąt.</p>
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Wysyłanie…' : 'Złóż wniosek'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ═══ Czas pracy (pracownik) ═══
function CzasPracy() {
  const [month, setMonth] = useState(thisMonth())
  const [ew, setEw] = useState<HrEwidencja | null>(null)
  const [loading, setLoading] = useState(true)
  const [logDay, setLogDay] = useState<string | null>(null)

  const load = () => { setLoading(true); hrApi.myEwidencja(month).then(setEw).catch(() => setEw(null)).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [month])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <input type="month" className={`${inputCls} w-44`} value={month} onChange={e => setMonth(e.target.value)} />
        <button onClick={() => setLogDay(new Date().toISOString().slice(0, 10))}
          className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">⏱ Rejestruj dzień pracy</button>
      </div>
      {loading ? <div className="text-center py-10 text-gray-400">Ładowanie…</div>
        : !ew ? <div className="text-center py-10 text-gray-400 text-sm">Brak danych.</div>
        : <EwidencjaTable ew={ew} onEditDay={d => setLogDay(d)} />}
      {logDay && <LogDayModal date={logDay} entry={ew?.days.find(d => d.date === logDay)?.entry ?? null} onClose={() => setLogDay(null)} onSaved={() => { setLogDay(null); load() }} />}
    </div>
  )
}

function LogDayModal({ date, entry, onClose, onSaved }: { date: string; entry: any; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(date)
  const [start, setStart] = useState(entry?.start_time ?? '08:00')
  const [end, setEnd] = useState(entry?.end_time ?? '16:00')
  const [brk, setBrk] = useState(String(entry?.break_minutes ?? 0))
  const [notes, setNotes] = useState(entry?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const save = async () => {
    setSaving(true); setErr('')
    try { await hrApi.logWorkTime({ date: d, start_time: start, end_time: end, break_minutes: Number(brk) || 0, notes: notes.trim() || undefined }); onSaved() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu.') } finally { setSaving(false) }
  }
  return (
    <Modal title="Rejestracja czasu pracy" onClose={onClose}>
      <div className="space-y-4">
        <div><label className={lblCls}>Data</label><input type="date" className={inputCls} value={d} onChange={e => setD(e.target.value)} /></div>
        <div className="grid grid-cols-3 gap-3">
          <div><label className={lblCls}>Rozpoczęcie</label><input type="time" className={inputCls} value={start} onChange={e => setStart(e.target.value)} /></div>
          <div><label className={lblCls}>Zakończenie</label><input type="time" className={inputCls} value={end} onChange={e => setEnd(e.target.value)} /></div>
          <div><label className={lblCls}>Przerwa (min)</label><input type="number" min="0" className={inputCls} value={brk} onChange={e => setBrk(e.target.value)} /></div>
        </div>
        <div><label className={lblCls}>Uwagi</label><input className={inputCls} value={notes} onChange={e => setNotes(e.target.value)} placeholder="np. praca na obiekcie X" /></div>
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Zapisz'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ═══ Tabela ewidencji (wspólna: pracownik + admin) ═══
function EwidencjaTable({ ew, onEditDay, adminEdit }: { ew: HrEwidencja; onEditDay?: (date: string) => void; adminEdit?: (date: string) => void }) {
  return (
    <div>
      <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
            <tr>
              <th className="text-left px-2 py-2 font-medium">Data</th>
              <th className="text-left px-2 py-2 font-medium">Dzień</th>
              <th className="text-center px-2 py-2 font-medium">Od–do</th>
              <th className="text-right px-2 py-2 font-medium">Godz.</th>
              <th className="text-right px-2 py-2 font-medium">Nocne</th>
              <th className="text-right px-2 py-2 font-medium">Nadg.</th>
              <th className="text-left px-2 py-2 font-medium">Dyżur (miejsce)</th>
              <th className="text-left px-2 py-2 font-medium">Nieobecność / uwagi</th>
              {(onEditDay || adminEdit) && <th className="w-14"></th>}
            </tr>
          </thead>
          <tbody>
            {ew.days.map(d => {
              const off = d.is_weekend || d.is_holiday
              const e = d.entry
              return (
                <tr key={d.date} className={`border-t border-gray-100 dark:border-gray-800 ${off ? 'bg-gray-50/70 dark:bg-gray-800/30' : ''}`}>
                  <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">{d.date.slice(8)}.{d.date.slice(5, 7)}</td>
                  <td className={`px-2 py-1.5 ${off ? 'text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>{DOW[d.day_of_week]}{d.is_holiday ? ' 🎌' : ''}</td>
                  <td className="px-2 py-1.5 text-center text-gray-700 dark:text-gray-300">{e?.start_time && e?.end_time ? `${e.start_time}–${e.end_time}` : '—'}</td>
                  <td className="px-2 py-1.5 text-right font-medium text-gray-800 dark:text-gray-100">{e && e.hours_worked > 0 ? fmt(e.hours_worked) : ''}</td>
                  <td className="px-2 py-1.5 text-right text-gray-500">{e && e.night_hours > 0 ? fmt(e.night_hours) : ''}</td>
                  <td className="px-2 py-1.5 text-right text-gray-500">{e && e.overtime_hours > 0 ? fmt(e.overtime_hours) : ''}</td>
                  <td className="px-2 py-1.5 text-xs text-gray-500">{e?.duty_start ? `${e.duty_start}–${e.duty_end ?? '?'} (${e.duty_place ?? '—'})` : ''}</td>
                  <td className="px-2 py-1.5 text-xs">
                    {d.leave ? <span className="text-violet-600 dark:text-violet-400 font-medium">{LEAVE_TYPE_LABELS[d.leave.type] ?? d.leave.type}</span> : null}
                    {e?.notes ? <span className="text-gray-400"> {e.notes}</span> : null}
                  </td>
                  {(onEditDay || adminEdit) && (
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => (adminEdit ?? onEditDay)!(d.date)} className="text-xs text-gray-400 hover:text-violet-600">✏️</button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 font-medium text-gray-700 dark:text-gray-200">
              <td colSpan={3} className="px-2 py-2 text-right text-xs">Razem ({ew.sums.days_worked} dni przepracowanych):</td>
              <td className="px-2 py-2 text-right">{fmt(ew.sums.hours_worked)}</td>
              <td className="px-2 py-2 text-right">{fmt(ew.sums.night_hours)}</td>
              <td className="px-2 py-2 text-right">{fmt(ew.sums.overtime_hours)}</td>
              <td colSpan={3} className="px-2 py-2 text-xs text-gray-500">
                {Object.entries(ew.sums.leave_days_by_type).map(([t, n]) => `${LEAVE_TYPE_LABELS[t as LeaveType] ?? t}: ${n} dni`).join(' · ')}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// ═══ Administracja HR ═══
function AdminHR() {
  const [sub, setSub] = useState<'wnioski' | 'salda' | 'ewidencja'>('wnioski')
  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit">
        {([['wnioski', 'Wnioski urlopowe'], ['salda', 'Salda urlopowe'], ['ewidencja', 'Ewidencja czasu pracy']] as const).map(([k, v]) => (
          <button key={k} onClick={() => setSub(k)}
            className={`px-3.5 py-1.5 text-sm font-medium rounded-md transition-colors ${sub === k ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
            {v}
          </button>
        ))}
      </div>
      {sub === 'wnioski' && <AdminWnioski />}
      {sub === 'salda' && <AdminSalda />}
      {sub === 'ewidencja' && <AdminEwidencja />}
    </div>
  )
}

function AdminWnioski() {
  const [status, setStatus] = useState('pending')
  const [list, setList] = useState<HrLeaveRequest[]>([])
  const [loading, setLoading] = useState(true)
  const load = () => { setLoading(true); hrApi.adminRequests(status === 'all' ? undefined : status).then(setList).catch(() => setList([])).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [status])

  const decide = async (r: HrLeaveRequest, decision: 'approved' | 'rejected') => {
    const comment = decision === 'rejected' ? (window.prompt('Powód odrzucenia (opcjonalnie):') ?? '') : ''
    try { await hrApi.decide(r.id, decision, comment || undefined); load() }
    catch (e: any) { alert(e?.response?.data?.error || 'Błąd.') }
  }
  return (
    <div className="space-y-3">
      <select className={`${inputCls} w-56`} value={status} onChange={e => setStatus(e.target.value)}>
        <option value="pending">Oczekujące</option><option value="approved">Zatwierdzone</option>
        <option value="rejected">Odrzucone</option><option value="all">Wszystkie</option>
      </select>
      {loading ? <div className="text-center py-8 text-gray-400">Ładowanie…</div>
        : list.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">Brak wniosków.</div>
        : (
          <div className="space-y-2">
            {list.map(r => {
              const st = STATUS_BADGE[r.status] ?? STATUS_BADGE.pending
              return (
                <div key={r.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3.5 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-800 dark:text-gray-100">{r.employee?.name ?? '—'} · {LEAVE_TYPE_LABELS[r.type] ?? r.type}</div>
                    <div className="text-xs text-gray-400">{fmtDate(r.date_from)} – {fmtDate(r.date_to)} · {fmt(r.days_count)} dni rob.{r.comment ? ` · „${r.comment}"` : ''}</div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                  {r.status === 'pending' && (
                    <div className="flex gap-1.5">
                      <button onClick={() => decide(r, 'approved')} className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg">✓ Zatwierdź</button>
                      <button onClick={() => decide(r, 'rejected')} className="px-3 py-1.5 text-xs font-medium border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg">✗ Odrzuć</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}

function AdminSalda() {
  const [year, setYear] = useState(new Date().getFullYear())
  const [rows, setRows] = useState<Array<{ employee: Employee; balance: HrLeaveBalance; pending_count: number }>>([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState<{ employee: Employee; balance: HrLeaveBalance } | null>(null)
  const load = () => { setLoading(true); hrApi.adminOverview(year).then(d => setRows(d.rows)).catch(() => setRows([])).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [year])
  return (
    <div className="space-y-3">
      <select className={`${inputCls} w-32`} value={year} onChange={e => setYear(Number(e.target.value))}>
        {[year - 1, year, year + 1].filter((v, i, a) => a.indexOf(v) === i).map(y => <option key={y} value={y}>{y}</option>)}
      </select>
      {loading ? <div className="text-center py-8 text-gray-400">Ładowanie…</div> : (
        <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Pracownik</th>
                <th className="text-right px-3 py-2 font-medium">Wymiar</th>
                <th className="text-right px-3 py-2 font-medium">Zaległy</th>
                <th className="text-right px-3 py-2 font-medium">Korekta</th>
                <th className="text-right px-3 py-2 font-medium">Wykorzystane</th>
                <th className="text-right px-3 py-2 font-medium">Pozostało</th>
                <th className="text-right px-3 py-2 font-medium">Na żądanie</th>
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ employee, balance, pending_count }) => (
                <tr key={employee.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{employee.name}{pending_count > 0 && <span className="ml-2 text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 py-0.5 rounded-full">{pending_count} wniosk.</span>}</td>
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{fmt(balance.entitlement_days)}</td>
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{fmt(balance.carried_over_days)}</td>
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{balance.adjustment_days ? fmt(balance.adjustment_days) : '—'}</td>
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{fmt(balance.used_days)}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${balance.remaining_days < 0 ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>{fmt(balance.remaining_days)}</td>
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{fmt(balance.on_demand_used)}/{balance.on_demand_limit}</td>
                  <td className="px-3 py-2 text-right"><button onClick={() => setEdit({ employee, balance })} className="text-xs text-gray-400 hover:text-violet-600">✏️ Edytuj</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <EditBalanceModal year={year} employee={edit.employee} balance={edit.balance} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load() }} />}
    </div>
  )
}

function EditBalanceModal({ year, employee, balance, onClose, onSaved }: { year: number; employee: Employee; balance: HrLeaveBalance; onClose: () => void; onSaved: () => void }) {
  const [ent, setEnt] = useState(String(balance.entitlement_days))
  const [carried, setCarried] = useState(String(balance.carried_over_days))
  const [adj, setAdj] = useState(String(balance.adjustment_days))
  const [note, setNote] = useState(balance.adjustment_note ?? '')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await hrApi.setBalance(employee.id, year, {
        entitlement_days: Number(ent) || 0, carried_over_days: Number(carried) || 0,
        adjustment_days: Number(adj) || 0, adjustment_note: note.trim() || undefined,
      })
      onSaved()
    } catch { alert('Błąd zapisu.') } finally { setSaving(false) }
  }
  return (
    <Modal title={`Saldo urlopowe ${year} — ${employee.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div><label className={lblCls}>Wymiar (20/26)</label><input type="number" step="0.5" className={inputCls} value={ent} onChange={e => setEnt(e.target.value)} /></div>
          <div><label className={lblCls}>Zaległy</label><input type="number" step="0.5" className={inputCls} value={carried} onChange={e => setCarried(e.target.value)} /></div>
          <div><label className={lblCls}>Korekta (+/−)</label><input type="number" step="0.5" className={inputCls} value={adj} onChange={e => setAdj(e.target.value)} /></div>
        </div>
        <div><label className={lblCls}>Notatka do korekty</label><input className={inputCls} value={note} onChange={e => setNote(e.target.value)} placeholder="np. przeniesienie z Calamari" /></div>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Zapisz'}</button>
        </div>
      </div>
    </Modal>
  )
}

function AdminEwidencja() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [month, setMonth] = useState(thisMonth())
  const [ew, setEw] = useState<HrEwidencja | null>(null)
  const [loading, setLoading] = useState(false)
  const [editDay, setEditDay] = useState<string | null>(null)

  useEffect(() => {
    hrApi.adminOverview().then(d => {
      setEmployees(d.rows.map(r => r.employee))
      if (d.rows.length && !employeeId) setEmployeeId(d.rows[0].employee.id)
    }).catch(() => {})
  }, [])
  const load = () => {
    if (!employeeId) return
    setLoading(true)
    hrApi.adminEwidencja(employeeId, month).then(setEw).catch(() => setEw(null)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [employeeId, month])

  const monthName = useMemo(() => {
    const d = new Date(month + '-01T00:00:00')
    return isNaN(d.getTime()) ? month : d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
  }, [month])

  const printCard = () => {
    if (!ew) return
    const rows = ew.days.map(d => {
      const e = d.entry
      const off = d.is_weekend || d.is_holiday
      return `<tr style="${off ? 'background:#f3f4f6;color:#9ca3af' : ''}">
        <td>${d.date.slice(8)}.${d.date.slice(5, 7)}</td><td>${DOW[d.day_of_week]}${d.is_holiday ? ' (święto)' : ''}</td>
        <td style="text-align:center">${e?.start_time && e?.end_time ? `${e.start_time}–${e.end_time}` : ''}</td>
        <td style="text-align:right">${e && e.hours_worked > 0 ? fmt(e.hours_worked) : ''}</td>
        <td style="text-align:right">${e && e.night_hours > 0 ? fmt(e.night_hours) : ''}</td>
        <td style="text-align:right">${e && e.overtime_hours > 0 ? fmt(e.overtime_hours) : ''}</td>
        <td>${e?.duty_start ? `${e.duty_start}–${e.duty_end ?? ''} ${e.duty_place ?? ''}` : ''}</td>
        <td>${d.leave ? (LEAVE_TYPE_LABELS[d.leave.type] ?? d.leave.type) : ''}${e?.notes ? ` ${e.notes}` : ''}</td>
      </tr>`
    }).join('')
    const leaveSums = Object.entries(ew.sums.leave_days_by_type).map(([t, n]) => `${LEAVE_TYPE_LABELS[t as LeaveType] ?? t}: ${n} dni`).join(' · ')
    const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><title>Ewidencja czasu pracy — ${ew.employee.name} — ${monthName}</title>
      <style>body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#111;margin:24px}h1{font-size:16px;margin:0 0 2px}h2{font-size:13px;font-weight:400;color:#555;margin:0 0 14px}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:4px 6px;font-size:11px}th{background:#f3f4f6;text-align:left}tfoot td{font-weight:700;background:#f9fafb}
      .meta{margin:10px 0 14px;font-size:11px;color:#444}</style></head><body>
      <h1>Karta ewidencji czasu pracy</h1><h2>${ew.employee.name}${ew.employee.position ? ' — ' + ew.employee.position : ''} · ${monthName}</h2>
      <div class="meta">Prowadzona zgodnie z art. 149 Kodeksu pracy oraz § 6 rozporządzenia MRPiPS z 10.12.2018 r. w sprawie dokumentacji pracowniczej.</div>
      <table><thead><tr><th>Data</th><th>Dzień</th><th>Od–do</th><th>Godziny</th><th>Nocne</th><th>Nadgodz.</th><th>Dyżur (miejsce)</th><th>Nieobecność / uwagi</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3">Razem (${ew.sums.days_worked} dni przepracowanych)</td><td style="text-align:right">${fmt(ew.sums.hours_worked)}</td><td style="text-align:right">${fmt(ew.sums.night_hours)}</td><td style="text-align:right">${fmt(ew.sums.overtime_hours)}</td><td colspan="2">${leaveSums || '—'}</td></tr></tfoot></table>
      <div style="margin-top:36px;display:flex;justify-content:space-between;font-size:11px;color:#555"><div style="border-top:1px solid #999;padding-top:4px;width:40%">Podpis pracownika</div><div style="border-top:1px solid #999;padding-top:4px;width:40%">Podpis pracodawcy</div></div>
      <script>window.print()</script></body></html>`
    const w = window.open('', '_blank')
    if (w) { w.document.write(html); w.document.close() }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <select className={`${inputCls} w-64`} value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
          {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <input type="month" className={`${inputCls} w-44`} value={month} onChange={e => setMonth(e.target.value)} />
        <button onClick={printCard} disabled={!ew}
          className="px-3 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg disabled:opacity-50">🖨 Drukuj kartę (PIP)</button>
      </div>
      {loading ? <div className="text-center py-8 text-gray-400">Ładowanie…</div>
        : ew ? <EwidencjaTable ew={ew} adminEdit={d => setEditDay(d)} /> : <div className="text-center py-8 text-gray-400 text-sm">Wybierz pracownika.</div>}
      {editDay && ew && (
        <AdminEditDayModal employeeId={employeeId} date={editDay} entry={ew.days.find(x => x.date === editDay)?.entry ?? null}
          onClose={() => setEditDay(null)} onSaved={() => { setEditDay(null); load() }} />
      )}
    </div>
  )
}

function AdminEditDayModal({ employeeId, date, entry, onClose, onSaved }: { employeeId: string; date: string; entry: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    start: entry?.start_time ?? '', end: entry?.end_time ?? '', brk: String(entry?.break_minutes ?? 0),
    night: String(entry?.night_hours ?? 0), overtime: String(entry?.overtime_hours ?? 0),
    dutyStart: entry?.duty_start ?? '', dutyEnd: entry?.duty_end ?? '', dutyPlace: entry?.duty_place ?? '',
    notes: entry?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }))
  const save = async () => {
    setSaving(true)
    try {
      await hrApi.adminUpsertWorkTime(employeeId, {
        date, start_time: f.start || undefined, end_time: f.end || undefined, break_minutes: Number(f.brk) || 0,
        night_hours: Number(f.night) || 0, overtime_hours: Number(f.overtime) || 0,
        duty_start: f.dutyStart || undefined, duty_end: f.dutyEnd || undefined, duty_place: f.dutyPlace || undefined,
        notes: f.notes || undefined,
      } as any)
      onSaved()
    } catch { alert('Błąd zapisu.') } finally { setSaving(false) }
  }
  return (
    <Modal title={`Ewidencja — ${fmtDate(date)}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div><label className={lblCls}>Rozpoczęcie</label><input type="time" className={inputCls} value={f.start} onChange={e => set('start', e.target.value)} /></div>
          <div><label className={lblCls}>Zakończenie</label><input type="time" className={inputCls} value={f.end} onChange={e => set('end', e.target.value)} /></div>
          <div><label className={lblCls}>Przerwa (min)</label><input type="number" min="0" className={inputCls} value={f.brk} onChange={e => set('brk', e.target.value)} /></div>
          <div><label className={lblCls}>Godziny nocne</label><input type="number" min="0" step="0.5" className={inputCls} value={f.night} onChange={e => set('night', e.target.value)} /></div>
          <div><label className={lblCls}>Nadgodziny</label><input type="number" min="0" step="0.5" className={inputCls} value={f.overtime} onChange={e => set('overtime', e.target.value)} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><label className={lblCls}>Dyżur od</label><input type="time" className={inputCls} value={f.dutyStart} onChange={e => set('dutyStart', e.target.value)} /></div>
          <div><label className={lblCls}>Dyżur do</label><input type="time" className={inputCls} value={f.dutyEnd} onChange={e => set('dutyEnd', e.target.value)} /></div>
          <div><label className={lblCls}>Miejsce dyżuru</label><input className={inputCls} value={f.dutyPlace} onChange={e => set('dutyPlace', e.target.value)} /></div>
        </div>
        <div><label className={lblCls}>Uwagi</label><input className={inputCls} value={f.notes} onChange={e => set('notes', e.target.value)} /></div>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Zapisz'}</button>
        </div>
      </div>
    </Modal>
  )
}
