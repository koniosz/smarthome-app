// Skrzynka dokumentów: zakładki statusów (Do zatwierdzenia / Zatwierdzone / Odrzucone / Błędy), upload i lista.
import { useCallback, useEffect, useRef, useState } from 'react'
import { costDocumentsApi, type CostDocument, type CostDocumentStats } from '../../api/costInbox'
import UploadDropzone from './UploadDropzone'
import DocumentRow from './DocumentRow'
import { errorMessage, Alert } from './shared'

type Tab = 'pending' | 'approved' | 'rejected' | 'error'

const TABS: Array<{ key: Tab; label: string; icon: string; empty: string }> = [
  { key: 'pending',  label: 'Do zatwierdzenia', icon: '⏳', empty: 'Nic do zatwierdzenia. Wrzuć pliki powyżej albo przekaż faktury na skrzynkę e-mail.' },
  { key: 'approved', label: 'Zatwierdzone',     icon: '✓',  empty: 'Brak zatwierdzonych dokumentów.' },
  { key: 'rejected', label: 'Odrzucone',        icon: '✕',  empty: 'Brak odrzuconych dokumentów.' },
  { key: 'error',    label: 'Błędy',            icon: '⚠',  empty: 'Brak dokumentów z błędem odczytu.' },
]

export default function DocumentsInbox({ isAdmin, onStats }: { isAdmin: boolean; onStats?: (s: CostDocumentStats) => void }) {
  const [tab, setTab] = useState<Tab>('pending')
  const [docs, setDocs] = useState<CostDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stats, setStats] = useState<CostDocumentStats | null>(null)
  const [notice, setNotice] = useState('')
  const seq = useRef(0)
  const noticeTimer = useRef<number | undefined>(undefined)

  const flash = useCallback((msg: string) => {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4000)
  }, [])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  const loadStats = useCallback(() => {
    costDocumentsApi.stats().then(s => { setStats(s); onStats?.(s) }).catch(() => {})
  }, [onStats])

  // Sekwencer — odpowiedź nieaktualnej zakładki jest ignorowana
  const load = useCallback(async (t: Tab) => {
    const my = ++seq.current
    setLoading(true); setError('')
    try {
      const list = await costDocumentsApi.list(t)
      if (my !== seq.current) return
      setDocs(list)
    } catch (e) {
      if (my !== seq.current) return
      setError(errorMessage(e, 'Nie udało się pobrać dokumentów.'))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load(tab) }, [tab, load])
  useEffect(() => { loadStats() }, [loadStats])

  // Zakładka, na której backend listuje dokument o danym statusie ('processing' idzie razem z 'pending' — GET /?status=pending).
  const tabOf = (status: string): Tab | undefined => status === 'processing' ? 'pending' : TABS.find(t => t.key === status)?.key

  const onChanged = (d: CostDocument, note?: string) => {
    const target = tabOf(d.status)
    setDocs(prev => target === tab ? prev.map(x => x.id === d.id ? d : x) : prev.filter(x => x.id !== d.id))
    if (note) flash(target !== tab ? `${note} Dokument przeniesiony do „${TABS.find(t => t.key === target)?.label ?? d.status}”.` : note)
    loadStats()
  }
  const onRemoved = (id: string) => { setDocs(prev => prev.filter(x => x.id !== id)); flash('Dokument usunięty.'); loadStats() }
  // Wołane dwa razy: po 202 (status 'processing' — lista „Do zatwierdzenia” obejmuje takie dokumenty, jak GET /?status=pending)
  // i po zakończeniu odczytu (pending/error) — wiersz jest podmieniany albo przenoszony poza bieżącą zakładkę.
  const onUploaded = (d: CostDocument) => {
    const belongs = d.status === tab || (d.status === 'processing' && tab === 'pending')
    setDocs(prev => belongs ? [d, ...prev.filter(x => x.id !== d.id)] : prev.filter(x => x.id !== d.id))
    loadStats()
  }
  // Upload bez odpowiedzi serwera (timeout / proxy) — dokument mógł już powstać; pokaż aktualną listę, zanim ktoś wyśle go ponownie
  const onUploadFailed = () => { void load(tab); loadStats() }

  const count = (t: Tab): number | null => {
    // Otwarta zakładka: liczba faktycznie pokazanych wierszy (w „Do zatwierdzenia” także dokumenty w trakcie odczytu,
    // których /stats.pending nie liczy) — licznik nie może się rozjeżdżać z listą pod nim.
    if (t === tab && !loading) return docs.length
    if (t === 'pending') return stats?.pending ?? null
    if (t === 'error') return stats?.error ?? null
    return null
  }

  const current = TABS.find(t => t.key === tab)!

  return (
    <div className="space-y-4">
      <UploadDropzone onUploaded={onUploaded} onUploadFailed={onUploadFailed} />

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5 flex-wrap">
          {TABS.map(t => {
            const n = count(t.key)
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-md text-sm font-semibold whitespace-nowrap ${tab === t.key
                  ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                {t.icon} {t.label}{n !== null && n > 0 ? ` (${n})` : ''}
              </button>
            )
          })}
        </div>
        <div className="flex-1" />
        {stats && (
          <span className="text-xs text-gray-400" title="Dokumenty zatwierdzone w ostatnich 30 dniach">
            zatwierdzone w 30 dni: <b className="text-gray-600 dark:text-gray-300">{stats.approved_30d}</b>
          </span>
        )}
        <button onClick={() => { void load(tab); loadStats() }} className="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline">odśwież</button>
      </div>

      {notice && <Alert tone="green">{notice}</Alert>}
      {error && <Alert tone="red">{error}</Alert>}

      {loading ? (
        <div className="p-10 text-center text-gray-400 text-sm">Ładowanie…</div>
      ) : docs.length === 0 ? (
        <div className="p-10 text-center text-gray-400 text-sm bg-white dark:bg-gray-900 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl">{current.empty}</div>
      ) : (
        <div className="space-y-3">
          {docs.map(d => <DocumentRow key={d.id} doc={d} isAdmin={isAdmin} onChanged={onChanged} onRemoved={onRemoved} />)}
        </div>
      )}
    </div>
  )
}
