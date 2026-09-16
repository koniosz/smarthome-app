// Jeden dokument w skrzynce: plik, sprzedawca, kwoty (waluta + PLN po kursie NBP), kategoria, pewność AI,
// ostrzeżenie o duplikacie i akcje: zatwierdź / popraw / odrzuć / odczytaj ponownie / przywróć odrzucony (+ usuń dla admina).
import { useEffect, useRef, useState } from 'react'
import { Paperclip, Check, Pencil, X, RefreshCw, RotateCcw, Trash2, ExternalLink, Loader2, AlertTriangle } from 'lucide-react'
import { api } from '../../api/client'
import { costDocumentsApi, approveConflict, type CostDocument } from '../../api/costInbox'
import { BUSINESS_UNITS, categoryForSubcategory } from '../../constants/costTaxonomy'
import DocumentEditor from './DocumentEditor'
import { money, fmt, fmtDate, fmtDateTime, errorMessage, Badge, Alert, cardCls, btnPrimary, btnSecondary, btnDanger, btnGhost, SubcategorySelect } from './shared'

const SOURCE_LABEL: Record<string, string> = { upload: 'wgrany ręcznie', email: 'z e-maila', mobile: 'z telefonu' }

// Odczyt AI biegnie w tle (POST / i POST /:id/reextract odpowiadają 202 ze statusem 'processing'):
// klient odpytuje GET /cost-documents/:id co 3 s, najwyżej 120 s.
const POLL_INTERVAL_MS = 3_000
const POLL_MAX_MS = 120_000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Czeka, aż dokument wyjdzie ze statusu 'processing'. Zwraca ostatni odczyt (po 120 s może to nadal być
 * 'processing' — np. serwer zrestartował się w trakcie odczytu) albo null, gdy `alive()` zgasło (komponent zniknął).
 */
async function pollUntilDone(id: string, alive: () => boolean): Promise<CostDocument | null> {
  const started = Date.now()
  let last: CostDocument | null = null
  while (alive() && Date.now() - started < POLL_MAX_MS) {
    await sleep(POLL_INTERVAL_MS)
    if (!alive()) return null
    try {
      last = await costDocumentsApi.get(id)
      if (last.status !== 'processing') return last
    } catch { /* chwilowy błąd sieci — próbujemy dalej */ }
  }
  return alive() ? last : null
}

/** Komunikat po zakończeniu odczytu — tylko gdy użytkownik musi coś zrobić. */
function doneNote(d: CostDocument): string | undefined {
  if (d.status === 'error') return 'AI nie odczytało dokumentu — uzupełnij dane ręcznie.'
  if (d.status === 'processing') return 'Odczyt nadal trwa — jeśli nie skończy się w ciągu minuty, kliknij „Odczytaj ponownie”.'
  return undefined
}

function dupHeadline(duplicate_of: string): string {
  if (duplicate_of.startsWith('ksef:')) return 'Ta faktura jest prawdopodobnie już w KSeF — zatwierdzenie policzyłoby koszt dwa razy.'
  if (duplicate_of.startsWith('mt940:')) return 'Prawdopodobnie ten sam koszt jest już na wyciągu bankowym.'
  if (duplicate_of.startsWith('document:')) return 'Taki dokument (ten sam numer i sprzedawca) już jest w skrzynce.'
  return 'Ten dokument wygląda na duplikat.'
}

function confidenceTone(c: number): 'green' | 'amber' | 'red' {
  return c >= 0.8 ? 'green' : c >= 0.5 ? 'amber' : 'red'
}

/** Kwota, która wejdzie do RZiS: netto w PLN; paragon bez VAT → brutto (tak liczy backend przy approve). */
function pnlAmount(doc: CostDocument): number {
  return doc.is_receipt && !doc.vat ? doc.gross_pln : doc.net_pln
}

function FilePreviewModal({ name, url, mime, onClose }: { name: string; url: string; mime: string; onClose: () => void }) {
  const isImage = mime.startsWith('image/')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          <div className="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">📎 {name}</div>
          <div className="flex items-center gap-2">
            <button onClick={() => window.open(url, '_blank', 'noopener')} className={btnSecondary}><ExternalLink size={14} /> Otwórz w nowej karcie</button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1"><X size={18} /></button>
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-gray-100 dark:bg-gray-950 flex items-center justify-center">
          {isImage
            ? <img src={url} alt={name} className="max-w-full max-h-full object-contain" />
            : <iframe src={url} title={name} className="w-full h-full bg-white" />}
        </div>
      </div>
    </div>
  )
}

type Busy = '' | 'approve' | 'reject' | 'reextract' | 'reopen' | 'delete' | 'quick' | 'file'

export default function DocumentRow({ doc, isAdmin, onChanged, onRemoved }: {
  doc: CostDocument
  isAdmin: boolean
  onChanged: (doc: CostDocument, note?: string) => void
  onRemoved: (id: string) => void
}) {
  const [busy, setBusy] = useState<Busy>('')
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState('')
  const [dup, setDup] = useState<{ duplicate_of: string; note: string } | null>(null)
  const [preview, setPreview] = useState<{ url: string; mime: string } | null>(null)
  // Odczyt trwa dłużej niż 120 s odpytywania — dokument prawdopodobnie utknął (restart serwera w trakcie)
  const [stale, setStale] = useState(false)
  const aliveRef = useRef(true)
  // Rodzic podaje onChanged jako nową funkcję przy każdym renderze — trzymamy w ref, żeby odpytywanie nie restartowało się
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  useEffect(() => () => { aliveRef.current = false }, [])

  useEffect(() => {
    setDup(doc.duplicate_of ? { duplicate_of: doc.duplicate_of, note: doc.duplicate_note } : null)
  }, [doc.duplicate_of, doc.duplicate_note])

  // Zwolnij URL podglądu, gdy zmienia się albo komponent znika
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])

  // Dokument „w toku” (z listy albo świeżo wgrany): odpytuj, aż status ≠ 'processing', i podmień wiersz u rodzica.
  useEffect(() => {
    if (doc.status !== 'processing') return
    let active = true
    setStale(false)
    void pollUntilDone(doc.id, () => active && aliveRef.current).then(fresh => {
      if (!active || !fresh) return
      if (fresh.status === 'processing') setStale(true)
      else onChangedRef.current(fresh, doneNote(fresh))
    })
    return () => { active = false }
  }, [doc.status, doc.id])

  const run = async (kind: Busy, fn: () => Promise<void>, fallback: string) => {
    setBusy(kind); setErr('')
    try { await fn() } catch (e) { setErr(errorMessage(e, fallback)) } finally { setBusy('') }
  }

  const approve = (force = false) => run('approve', async () => {
    try {
      onChanged(await costDocumentsApi.approve(doc.id, { force }), 'Zatwierdzono — koszt wszedł do rentowności.')
    } catch (e) {
      const c = approveConflict(e)
      if (!c) throw e
      setDup({ duplicate_of: c.duplicate_of, note: c.duplicate_note || c.error })
    }
  }, 'Nie udało się zatwierdzić dokumentu.')

  const reject = () => {
    const q = doc.status === 'approved'
      ? 'Cofnąć zatwierdzenie? Koszt zniknie z rentowności. Powód (opcjonalnie):'
      : 'Powód odrzucenia (opcjonalnie):'
    const reason = window.prompt(q, '')
    if (reason === null) return
    void run('reject', async () => onChanged(await costDocumentsApi.reject(doc.id, reason), 'Dokument odrzucony.'), 'Nie udało się odrzucić dokumentu.')
  }

  const reextract = () => run('reextract', async () => {
    // 202 → status 'processing': czekamy na wynik w miejscu (przycisk pokazuje „Odczytuję…”), jak przy dawnym odczycie synchronicznym
    let d = await costDocumentsApi.reextract(doc.id)
    if (d.status === 'processing') d = (await pollUntilDone(doc.id, () => aliveRef.current)) ?? d
    if (!aliveRef.current) return
    if (d.status === 'processing') setStale(true)
    onChanged(d, d.status === 'pending' ? 'Dokument odczytany ponownie.' : doneNote(d))
  }, 'Ponowny odczyt nie powiódł się.')

  /** Odrzucony (także po „Cofnij zatwierdzenie”) wraca do sprawdzenia: POST /:id/reopen → status 'pending'. */
  const reopen = () => run('reopen', async () => {
    const d = await api.post<CostDocument>(`/cost-documents/${doc.id}/reopen`).then(r => r.data)
    onChanged(d, 'Dokument przywrócony do sprawdzenia.')
  }, 'Nie udało się przywrócić dokumentu.')

  const remove = () => {
    if (!window.confirm(`Usunąć dokument „${doc.file_name || doc.doc_number || doc.id}” bezpowrotnie?`)) return
    void run('delete', async () => { await costDocumentsApi.remove(doc.id); onRemoved(doc.id) }, 'Nie udało się usunąć dokumentu.')
  }

  const quick = (patch: { subcategory?: string; cost_category?: string; business_unit?: string }) =>
    run('quick', async () => onChanged(await costDocumentsApi.update(doc.id, patch)), 'Nie udało się zapisać zmiany.')

  const openFile = () => run('file', async () => {
    const blob = await costDocumentsApi.file(doc.id)
    const mime = blob.type || doc.mime_type || 'application/octet-stream'
    setPreview({ url: URL.createObjectURL(blob), mime })
  }, 'Nie udało się pobrać pliku.')

  const status = doc.status
  const isProcessing = status === 'processing'
  const canApprove = status === 'pending'
  const canEdit = status === 'pending' || status === 'error'
  // Backend pozwala odrzucić i odczytać ponownie także dokument „w toku” — to jedyna droga odzyskania
  // odczytu przerwanego restartem serwera (bez tego nie-admin nie ma żadnej akcji, a koszt nigdy nie wejdzie do RZiS).
  const canReject = status === 'pending' || status === 'error' || status === 'approved' || isProcessing
  const canReextract = status === 'pending' || status === 'error' || isProcessing
  const canReopen = status === 'rejected'
  const locked = !!busy || !canEdit
  const isForeign = (doc.currency || 'PLN').toUpperCase() !== 'PLN'
  const ext = (doc.file_name.split('.').pop() || doc.mime_type.split('/').pop() || '').toUpperCase().slice(0, 4)
  const extracted = (doc.extracted ?? null) as { description?: unknown } | null
  const aiDesc = typeof extracted?.description === 'string' ? extracted.description : ''

  return (
    <div className={`${cardCls} p-4 ${status === 'error' ? 'border-red-200 dark:border-red-900/60' : ''}`}>
      <div className="flex gap-4 flex-wrap md:flex-nowrap">
        {/* Plik */}
        <button onClick={openFile} disabled={busy === 'file'} title={doc.file_name || 'Pokaż plik'}
          className="w-20 h-20 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:border-violet-400 dark:hover:border-violet-600 flex flex-col items-center justify-center flex-shrink-0 text-gray-500 dark:text-gray-300">
          {busy === 'file' ? <Loader2 size={20} className="animate-spin text-violet-500" /> : <Paperclip size={20} />}
          <span className="text-[11px] font-bold mt-1">📎 plik</span>
          {ext && <span className="text-[10px] text-gray-400">{ext}</span>}
        </button>

        {/* Dane */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-gray-800 dark:text-gray-100 truncate max-w-full">
              {doc.seller_name || <span className="text-gray-400 italic font-normal">nieznany sprzedawca</span>}
            </span>
            {doc.seller_country && <Badge tone="gray" title="Kraj sprzedawcy">{doc.seller_country}</Badge>}
            {doc.seller_nip && <span className="text-xs text-gray-400">NIP {doc.seller_nip}</span>}
            {doc.is_receipt && <Badge tone="blue" title="Paragon / rachunek — do kosztów wchodzi brutto">paragon</Badge>}
            <Badge tone="gray" title={doc.created_by ? `dodał(a): ${doc.created_by}` : undefined}>{SOURCE_LABEL[doc.source] ?? doc.source}</Badge>
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-300 mt-0.5">
            <span className="font-semibold">{doc.doc_number || 'bez numeru'}</span> · {fmtDate(doc.doc_date)}
            {doc.source === 'email' && (doc.email_from || doc.email_subject) && (
              <span className="text-xs text-gray-400"> · ✉ {doc.email_from}{doc.email_subject ? ` „${doc.email_subject}”` : ''}</span>
            )}
          </div>
          {aiDesc && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate" title={aiDesc}>{aiDesc}</div>}

          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <SubcategorySelect compact value={doc.subcategory} disabled={locked}
              onChange={sub => quick({ subcategory: sub, cost_category: categoryForSubcategory(sub) })} />
            <select value={doc.business_unit} disabled={locked} onChange={e => quick({ business_unit: e.target.value })}
              className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-60">
              {Object.entries(BUSINESS_UNITS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              {!(doc.business_unit in BUSINESS_UNITS) && <option value={doc.business_unit}>{doc.business_unit}</option>}
            </select>
            {!isProcessing && (
              <Badge tone={confidenceTone(doc.confidence)} title="Jak pewne jest AI, że dobrze odczytało dokument. Poniżej 80 % — sprawdź kwoty.">
                pewność AI {Math.round((doc.confidence || 0) * 100)} %
              </Badge>
            )}
          </div>
        </div>

        {/* Kwoty */}
        <div className="text-right flex-shrink-0 md:min-w-[190px]">
          <div className="text-lg font-bold tabular-nums text-gray-800 dark:text-gray-100">{money(doc.gross, doc.currency)}</div>
          <div className="text-xs text-gray-400 tabular-nums">brutto · netto {fmt(doc.net)} · VAT {fmt(doc.vat)}</div>
          {isForeign && (doc.fx_rate > 0
            ? <div className="text-xs text-gray-600 dark:text-gray-300 mt-1 tabular-nums">≈ {money(doc.gross_pln)} · kurs NBP {doc.fx_rate.toFixed(4)} z {fmtDate(doc.fx_date)}</div>
            : <div className="text-xs text-red-600 dark:text-red-400 mt-1">brak kursu NBP — sprawdź datę i walutę</div>)}
          <div className="text-xs font-semibold text-violet-700 dark:text-violet-300 mt-1 tabular-nums"
            title="Kwota, która wejdzie do kosztów w rentowności: netto w PLN (paragon bez VAT → brutto)">
            do RZiS: {money(pnlAmount(doc))}
          </div>
        </div>
      </div>

      {/* Status / notatki */}
      {isProcessing && (
        <div className="mt-3">
          <Alert tone="blue">
            <span className="inline-flex items-center gap-2">
              {stale ? <AlertTriangle size={14} className="flex-shrink-0" /> : <Loader2 size={14} className="animate-spin flex-shrink-0" />}
              {stale
                ? <>Odczyt trwa podejrzanie długo (np. serwer zrestartował się w trakcie). Kliknij „Odczytaj ponownie” albo odrzuć dokument.</>
                : <>Odczytywanie… AI czyta dokument — zwykle do minuty. Jeśli trwa dłużej, kliknij „Odczytaj ponownie”.</>}
            </span>
          </Alert>
        </div>
      )}
      {status === 'error' && (
        <div className="mt-3">
          <Alert tone="red">AI nie odczytało dokumentu{doc.extract_error ? `: ${doc.extract_error}` : ''}. Kliknij „Popraw” i uzupełnij dane ręcznie albo spróbuj „Odczytaj ponownie”.</Alert>
        </div>
      )}
      {status === 'approved' && (
        <div className="mt-3 text-xs font-semibold text-green-700 dark:text-green-400">
          ✓ zatwierdzony{doc.reviewed_by ? ` przez ${doc.reviewed_by}` : ''} · {fmtDateTime(doc.reviewed_at)} — koszt liczy się w rentowności
        </div>
      )}
      {status === 'rejected' && (
        <div className="mt-3 text-xs font-semibold text-gray-500 dark:text-gray-400">
          ✕ odrzucony{doc.reviewed_by ? ` przez ${doc.reviewed_by}` : ''} · {fmtDateTime(doc.reviewed_at)}{doc.notes ? ` · ${doc.notes}` : ''}
        </div>
      )}
      {doc.notes && status !== 'rejected' && <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">📝 {doc.notes}</div>}

      {/* Duplikat */}
      {dup && (status === 'pending' || status === 'error') && !editing && (
        <div className="mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-3 flex-wrap">
          <AlertTriangle size={16} className="flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold">{dupHeadline(dup.duplicate_of)}</div>
            {dup.note && <div className="text-xs mt-0.5">{dup.note}</div>}
          </div>
          <button onClick={() => approve(true)} disabled={!!busy} className={btnSecondary}>
            {busy === 'approve' ? 'Zatwierdzam…' : 'Zatwierdź mimo to'}
          </button>
        </div>
      )}

      {err && <div className="mt-3 text-xs font-semibold text-red-600 dark:text-red-400">{err}</div>}

      {/* Akcje */}
      {editing ? (
        <DocumentEditor doc={doc} onCancel={() => setEditing(false)}
          onSaved={(d, approved) => { setEditing(false); onChanged(d, approved ? 'Zapisano i zatwierdzono.' : 'Zapisano zmiany.') }} />
      ) : (
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {canApprove && (
            <button onClick={() => approve(false)} disabled={!!busy} className={btnPrimary}>
              <Check size={14} /> {busy === 'approve' ? 'Zatwierdzam…' : 'Zatwierdź'}
            </button>
          )}
          {canEdit && <button onClick={() => setEditing(true)} disabled={!!busy} className={btnSecondary}><Pencil size={14} /> Popraw</button>}
          {canReject && (
            <button onClick={reject} disabled={!!busy} className={btnDanger}>
              <X size={14} /> {busy === 'reject' ? 'Odrzucam…' : status === 'approved' ? 'Cofnij zatwierdzenie' : 'Odrzuć'}
            </button>
          )}
          {canReextract && (
            <button onClick={reextract} disabled={!!busy} className={btnSecondary}>
              <RefreshCw size={14} className={busy === 'reextract' ? 'animate-spin' : ''} /> {busy === 'reextract' ? 'Odczytuję…' : 'Odczytaj ponownie'}
            </button>
          )}
          {canReopen && (
            <button onClick={reopen} disabled={!!busy} className={btnSecondary} title="Dokument wraca do zakładki „Do zatwierdzenia” — można go poprawić i zatwierdzić">
              <RotateCcw size={14} /> {busy === 'reopen' ? 'Przywracam…' : 'Przywróć do sprawdzenia'}
            </button>
          )}
          <div className="flex-1" />
          <span className="text-[11px] text-gray-400" title="Data dodania do skrzynki">{fmtDateTime(doc.created_at)}</span>
          {isAdmin && <button onClick={remove} disabled={!!busy} className={btnGhost}><Trash2 size={13} /> Usuń</button>}
        </div>
      )}

      {preview && <FilePreviewModal name={doc.file_name || 'dokument'} url={preview.url} mime={preview.mime} onClose={() => setPreview(null)} />}
    </div>
  )
}
