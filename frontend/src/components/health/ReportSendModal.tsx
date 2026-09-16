// Modal „Wyślij raport teraz”: kind / period / force → wynik wysyłki
import { useState } from 'react'
import { Send } from 'lucide-react'
import { healthApi, type HealthKind, type ReportSendResult } from '../../api/health'
import { kindOf, toMonth, toQuarter, periodLabel } from './period'
import { ModalShell, inputCls, btnPrimary, btnSecondary, ErrorBox, OkBox, InfoBox } from './ui'

export default function ReportSendModal({ period: initial, onClose }: { period: string; onClose: () => void }) {
  const [kind, setKind] = useState<HealthKind>(kindOf(initial))
  const [period, setPeriod] = useState(initial)
  const [force, setForce] = useState(false)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<ReportSendResult | null>(null)

  const changeKind = (k: HealthKind) => {
    setKind(k)
    setPeriod(p => (k === 'quarterly' ? toQuarter(p) : toMonth(p)))
    setResult(null)
  }

  const valid = kind === 'quarterly' ? /^\d{4}-Q[1-4]$/.test(period) : /^\d{4}-(0[1-9]|1[0-2])$/.test(period)

  const send = async () => {
    if (!valid) { setErr(kind === 'quarterly' ? 'Podaj kwartał w formacie RRRR-Qn, np. 2026-Q3.' : 'Podaj miesiąc w formacie RRRR-MM, np. 2026-08.'); return }
    setSending(true); setErr(''); setResult(null)
    try {
      setResult(await healthApi.reportSend({ kind, period, force: force || undefined }))
    } catch (e: any) {
      setErr(e?.response?.data?.error ?? 'Nie udało się wysłać raportu.')
    } finally {
      setSending(false)
    }
  }

  return (
    <ModalShell title="Wyślij raport e-mail" subtitle="Odbiorcy: administratorzy, osoby z dostępem do płatności i dodatkowe adresy z ustawień." onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Rodzaj</label>
            <select value={kind} onChange={e => changeKind(e.target.value as HealthKind)} className={inputCls}>
              <option value="monthly">Miesięczny</option>
              <option value="quarterly">Kwartalny</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Okres</label>
            <input value={period} onChange={e => { setPeriod(e.target.value.trim()); setResult(null) }} placeholder={kind === 'quarterly' ? '2026-Q3' : '2026-08'} className={inputCls} />
            {valid && <div className="text-[11px] text-gray-400 mt-1">{periodLabel(period)}</div>}
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
          <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} className="mt-0.5 accent-violet-600" />
          <span>
            Wyślij pełny raport mimo braków danych
            <span className="block text-xs text-gray-400">Bez tej opcji, gdy brakuje np. wyciągu MT940, odbiorcy dostaną tylko informację „raport czeka na dane”.</span>
          </span>
        </label>

        {err && <ErrorBox>{err}</ErrorBox>}
        {result && (result.status === 'sent' ? (
          <OkBox>
            <b>Raport wysłany ✓</b>
            <div className="mt-1 text-xs">Do: {result.recipients.length ? result.recipients.join(', ') : '— (brak odbiorców)'}</div>
          </OkBox>
        ) : (
          <InfoBox>
            <b>{result.sent ? 'Wysłano informację o brakujących danych' : 'Raport niekompletny — nie wysłano'}</b>
            <div className="mt-1 text-xs">
              {result.recipients.length > 0 && <>Do: {result.recipients.join(', ')}. </>}
              Uzupełnij dane z sekcji „Do sprawdzenia” albo zaznacz „wyślij mimo braków”.
            </div>
          </InfoBox>
        ))}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className={btnSecondary}>{result ? 'Zamknij' : 'Anuluj'}</button>
          <button onClick={send} disabled={sending} className={btnPrimary}>
            <Send size={14} /> {sending ? 'Wysyłam…' : result ? 'Wyślij ponownie' : 'Wyślij teraz'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
