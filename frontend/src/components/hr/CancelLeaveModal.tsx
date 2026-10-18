import { useState } from 'react'
import { hrApi, LEAVE_TYPE_LABELS } from '../../api/client'
import type { HrLeaveRequest } from '../../api/client'
import { inputCls, fmt, fmtDate, todayIso } from './hrShared'

// Minimalny kształt wpisu potrzebny do anulowania — pasuje zarówno HrLeaveRequest (lista wniosków),
// jak i wpis z kalendarza urlopów (bez pól decided_*/created_at).
export type CancelLeaveTarget = Pick<HrLeaveRequest, 'id' | 'date_from' | 'date_to' | 'days_count'> & {
  type: string
  employee?: { name: string } | null
}

// Odwołanie z urlopu: przyszły → anulowanie w całości; trwający → skrócenie od wybranego dnia;
// zakończony → tylko świadomie („mimo to”, błędny wpis). Powód widzi pracownik.
export default function CancelLeaveModal({ request: r, onClose }: { request: CancelLeaveTarget; onClose: (saved: boolean) => void }) {
  const today = todayIso()
  const ended = r.date_to < today
  const inProgress = !ended && r.date_from < today
  const [effectiveFrom, setEffectiveFrom] = useState(inProgress ? today : r.date_from)
  const [reason, setReason] = useState('')
  const [force, setForce] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fullCancel = !inProgress || effectiveFrom <= r.date_from
  const typeLabel = (LEAVE_TYPE_LABELS as Record<string, string>)[r.type] ?? r.type

  const save = async () => {
    if (ended && !force) { setError('Zaznacz „anuluj mimo to”, jeśli wpis jest błędny.'); return }
    setSaving(true); setError('')
    try {
      const res = await hrApi.adminCancelLeave(r.id, { reason: reason.trim() || undefined, effective_from: inProgress ? effectiveFrom : undefined, force: ended ? true : undefined })
      alert(res.action === 'shortened'
        ? `Urlop skrócony do ${fmtDate(res.new_date_to!)} — do puli wróciło ${fmt(res.returned_days)} dni.`
        : `Urlop anulowany — do puli wróciło ${fmt(res.returned_days)} dni.`)
      onClose(true)
    } catch (e: any) { setError(e?.response?.data?.error || 'Nie udało się anulować.'); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && onClose(false)}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">{inProgress ? 'Odwołaj pracownika z urlopu' : 'Anuluj zatwierdzony urlop'}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{r.employee?.name ?? '—'} · {typeLabel} · {fmtDate(r.date_from)} – {fmtDate(r.date_to)} · {fmt(r.days_count)} dni rob.</p>
        </div>
        <div className="px-6 py-4 space-y-3">
          {ended ? (
            <div className="text-xs rounded-lg px-3 py-2 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 space-y-2">
              <p>Ten urlop już się zakończył — dni zostały wykorzystane. Anulowanie zwróci wszystkie {fmt(r.days_count)} dni do puli i usunie je z ewidencji. Rób to tylko dla błędnego wpisu.</p>
              <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} /> Rozumiem — anuluj mimo to</label>
            </div>
          ) : inProgress ? (
            <>
              <label className="block text-xs text-gray-500 dark:text-gray-400">Odwołaj od dnia
                <input type="date" value={effectiveFrom} min={r.date_from} max={r.date_to} onChange={e => setEffectiveFrom(e.target.value)} className={`${inputCls} mt-1`} />
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {fullCancel
                  ? 'Cały urlop zostanie anulowany — wszystkie dni wrócą do puli.'
                  : `Dni ${fmtDate(r.date_from)} – ${fmtDate(effectiveFrom)} (bez ostatniego) zostaną w ewidencji jako urlop. Od ${fmtDate(effectiveFrom)} pracownik jest w pracy, a niewykorzystane dni wracają do puli.`}
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">Urlop jeszcze się nie zaczął — zostanie anulowany w całości, {fmt(r.days_count)} dni wróci do puli. Wpis zostanie w historii jako „Anulowany”.</p>
          )}
          <label className="block text-xs text-gray-500 dark:text-gray-400">Powód (opcjonalnie — pracownik zobaczy go przy swoim wniosku)
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="np. awaria u klienta, potrzebna obecność" className={`${inputCls} mt-1`} />
          </label>
          {error && <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{error}</div>}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-2">
          <button onClick={() => onClose(false)} className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">Zamknij</button>
          <button onClick={save} disabled={saving || (ended && !force)} className="px-4 py-2 text-sm font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">
            {saving ? 'Zapisywanie…' : fullCancel ? 'Anuluj urlop' : 'Odwołaj od tego dnia'}
          </button>
        </div>
      </div>
    </div>
  )
}
