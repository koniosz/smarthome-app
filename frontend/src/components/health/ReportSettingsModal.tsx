// Modal „Ustawienia raportu”: nazwa firmy, wysyłka wł., dzień, e-maile, stawka CIT, magazyn w RZiS + log wysyłek
import { useEffect, useState } from 'react'
import { healthApi, type ReportSettings, type ReportSettingsInput, type ReportDispatch } from '../../api/health'
import { fmtDateTime } from './format'
import { ModalShell, inputCls, btnPrimary, btnSecondary, ErrorBox, OkBox } from './ui'

const STATUS_LABEL: Record<ReportDispatch['status'], { label: string; cls: string }> = {
  sending: { label: 'wysyłanie…', cls: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  sent: { label: 'wysłany', cls: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  incomplete: { label: 'brak danych', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  failed: { label: 'błąd', cls: 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400' },
}

export default function ReportSettingsModal({ isAdmin, onClose }: { isAdmin: boolean; onClose: (saved: boolean) => void }) {
  const [settings, setSettings] = useState<ReportSettings | null>(null)
  const [form, setForm] = useState<ReportSettingsInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let alive = true
    healthApi.reportSettings()
      .then(s => {
        if (!alive) return
        setSettings(s)
        const { log: _log, ...rest } = s
        setForm(rest)
      })
      .catch((e: any) => { if (alive) setErr(e?.response?.data?.error ?? 'Nie udało się pobrać ustawień.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const set = <K extends keyof ReportSettingsInput>(k: K, v: ReportSettingsInput[K]) => {
    setForm(f => (f ? { ...f, [k]: v } : f)); setDirty(true); setOk('')
  }

  const save = async () => {
    if (!form) return
    const day = Number(form.report_day)
    if (!Number.isInteger(day) || day < 1 || day > 28) { setErr('Dzień wysyłki musi być liczbą od 1 do 28.'); return }
    const cit = Number(form.cit_rate)
    if (isNaN(cit) || cit < 0 || cit > 40) { setErr('Stawka CIT musi być w zakresie 0–40 %.'); return }
    const emails = form.report_emails.split(',').map(s => s.trim()).filter(Boolean)
    const bad = emails.find(e => !e.includes('@'))
    if (bad) { setErr(`Niepoprawny adres e-mail: „${bad}”.`); return }
    setSaving(true); setErr(''); setOk('')
    try {
      await healthApi.saveReportSettings({ ...form, report_day: day, cit_rate: cit, report_emails: emails.join(', ') })
      const fresh = await healthApi.reportSettings().catch(() => null)
      if (fresh) { setSettings(fresh); const { log: _log, ...rest } = fresh; setForm(rest) }
      setDirty(false)
      setOk('Zapisano. Stawka CIT i magazyn w RZiS wpływają na liczby — strona odświeży się po zamknięciu.')
    } catch (e: any) {
      setErr(e?.response?.status === 403 ? 'Tylko administrator może zmieniać ustawienia.' : (e?.response?.data?.error ?? 'Nie udało się zapisać ustawień.'))
    } finally {
      setSaving(false)
    }
  }

  const labelCls = 'block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1'
  const savedOnce = ok !== ''

  return (
    <ModalShell title="Ustawienia raportu" subtitle="Raport „Kondycja firmy” wysyła się automatycznie e-mailem po zakończeniu miesiąca (i kwartału)." onClose={() => onClose(savedOnce)} width="max-w-2xl">
      {loading ? (
        <div className="py-10 text-center text-sm text-gray-400">Ładowanie…</div>
      ) : !form ? (
        err ? <ErrorBox>{err}</ErrorBox> : null
      ) : (
        <div className="space-y-5">
          {!isAdmin && (
            <div className="text-xs text-gray-400">Podgląd ustawień. Zmieniać może tylko administrator.</div>
          )}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className={labelCls}>Nazwa firmy (w nagłówku raportu)</label>
              <input value={form.company_name} onChange={e => set('company_name', e.target.value)} disabled={!isAdmin} placeholder="np. Nazwa firmy sp. z o.o." className={inputCls} />
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200 md:col-span-2 cursor-pointer">
              <input type="checkbox" checked={form.reports_enabled} onChange={e => set('reports_enabled', e.target.checked)} disabled={!isAdmin} className="mt-0.5 accent-violet-600" />
              <span>
                Wysyłaj raporty automatycznie
                <span className="block text-xs text-gray-400">Miesięczny — za poprzedni miesiąc; kwartalny — w styczniu, kwietniu, lipcu i październiku. Gdy brakuje danych, przychodzi lista braków zamiast raportu.</span>
              </span>
            </label>
            <div>
              <label className={labelCls}>Dzień miesiąca wysyłki (1–28)</label>
              <input type="number" min={1} max={28} value={form.report_day} onChange={e => set('report_day', Number(e.target.value))} disabled={!isAdmin} className={inputCls} />
              <div className="text-[11px] text-gray-400 mt-1">Daj księgowej czas na zaksięgowanie — np. 10.</div>
            </div>
            <div>
              <label className={labelCls}>Stawka CIT do szacunków</label>
              <select value={String(form.cit_rate)} onChange={e => set('cit_rate', Number(e.target.value))} disabled={!isAdmin} className={inputCls}>
                <option value="9">9 % — mały podatnik</option>
                <option value="19">19 % — standardowa</option>
                {![9, 19].includes(Number(form.cit_rate)) && <option value={String(form.cit_rate)}>{form.cit_rate} %</option>}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Dodatkowi odbiorcy (e-maile po przecinku)</label>
              <input value={form.report_emails} onChange={e => set('report_emails', e.target.value)} disabled={!isAdmin} placeholder="ksiegowa@biuro.pl, wspolnik@firma.pl" className={inputCls} />
              <div className="text-[11px] text-gray-400 mt-1">Administratorzy i osoby z dostępem do płatności dostają raport zawsze.</div>
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200 md:col-span-2 cursor-pointer">
              <input type="checkbox" checked={form.inventory_in_pnl} onChange={e => set('inventory_in_pnl', e.target.checked)} disabled={!isAdmin} className="mt-0.5 accent-violet-600" />
              <span>
                Uwzględniaj zmianę stanu magazynu w RZiS
                <span className="block text-xs text-gray-400">Włączone: towar kupiony na magazyn nie jest kosztem, dopóki nie zostanie sprzedany (dokładniej, ale wymaga wyceny magazynu).</span>
              </span>
            </label>
          </div>

          {err && <ErrorBox>{err}</ErrorBox>}
          {ok && <OkBox>{ok}</OkBox>}

          {isAdmin && (
            <div className="flex justify-end gap-2">
              <button onClick={() => onClose(savedOnce)} className={btnSecondary}>Zamknij</button>
              <button onClick={save} disabled={saving || !dirty} className={btnPrimary}>{saving ? 'Zapisuję…' : 'Zapisz ustawienia'}</button>
            </div>
          )}

          {/* Log wysyłek */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
            <div className="text-sm font-bold text-gray-800 dark:text-gray-100 mb-2">Ostatnie wysyłki</div>
            {!settings || settings.log.length === 0 ? (
              <div className="text-sm text-gray-400">Jeszcze nic nie wysłano.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-100 dark:border-gray-800">
                      <th className="py-1.5 text-left font-semibold">Kiedy</th>
                      <th className="py-1.5 text-left font-semibold">Raport</th>
                      <th className="py-1.5 text-left font-semibold">Status</th>
                      <th className="py-1.5 text-left font-semibold">Odbiorcy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.log.map(l => {
                      const st = STATUS_LABEL[l.status] ?? { label: l.status, cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' }
                      return (
                        <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60">
                          <td className="py-1.5 pr-2 whitespace-nowrap text-gray-500 dark:text-gray-400 tabular-nums">{fmtDateTime(l.created_at)}</td>
                          <td className="py-1.5 pr-2 whitespace-nowrap text-gray-800 dark:text-gray-100 font-semibold">{l.kind === 'quarterly' ? 'kwartalny' : 'miesięczny'} · {l.period}</td>
                          <td className="py-1.5 pr-2"><span className={`px-1.5 py-0.5 rounded font-bold ${st.cls}`}>{st.label}</span></td>
                          <td className="py-1.5 text-gray-500 dark:text-gray-400 truncate max-w-[220px]" title={l.recipients}>{l.recipients || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  )
}
