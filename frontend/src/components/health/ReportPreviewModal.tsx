// Modal „Podgląd raportu”: ten sam HTML co e-mail, w iframe (srcDoc)
import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { healthApi, type HealthKind, type ReportPreview } from '../../api/health'
import { ModalShell, btnPrimary, btnSecondary, ErrorBox, InfoBox } from './ui'

export default function ReportPreviewModal({ kind, period, onClose, onSend }: {
  kind: HealthKind; period: string; onClose: () => void; onSend: () => void
}) {
  const [preview, setPreview] = useState<ReportPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true); setErr('')
    healthApi.reportPreview(kind, period)
      .then(p => { if (alive) setPreview(p) })
      .catch((e: any) => { if (alive) setErr(e?.response?.data?.error ?? 'Nie udało się wygenerować podglądu.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [kind, period])

  return (
    <ModalShell title="Podgląd raportu e-mail" subtitle={preview?.subject ?? `${kind === 'quarterly' ? 'Raport kwartalny' : 'Raport miesięczny'} · ${period}`} onClose={onClose} width="max-w-3xl">
      {loading ? (
        <div className="py-16 text-center text-sm text-gray-400">Generuję podgląd…</div>
      ) : err ? (
        <ErrorBox>{err}</ErrorBox>
      ) : preview && (
        <div className="space-y-3">
          {!preview.complete && (
            <InfoBox>
              <b>Raport niekompletny.</b> Brakuje: {preview.missing.length ? preview.missing.join('; ') : 'część danych'}.
              Bez opcji „wyślij mimo braków” odbiorcy dostaną tylko powiadomienie o brakach.
            </InfoBox>
          )}
          <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white">
            <iframe title="Podgląd raportu" srcDoc={preview.html} sandbox="" className="w-full bg-white" style={{ height: '65vh' }} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={btnSecondary}>Zamknij</button>
            <button onClick={onSend} className={btnPrimary}><Send size={14} /> Wyślij ten raport</button>
          </div>
        </div>
      )}
    </ModalShell>
  )
}
