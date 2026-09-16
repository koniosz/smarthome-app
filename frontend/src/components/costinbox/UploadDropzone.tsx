// Strefa upuszczania wielu plików (PDF/JPG/PNG/WEBP) → POST /cost-documents (wysyłka po kolei).
// Backend odpowiada od razu 202 ze statusem 'processing', a odczyt AI biegnie w tle — odpytujemy
// GET /cost-documents/:id co 3 s (do 120 s), aż status ≠ 'processing'. Zdjęcia, których API AI nie przyjmie
// (za duże / za wysoka rozdzielczość), zmniejszamy w przeglądarce przed wysyłką.
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Upload, FilePlus, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { api } from '../../api/client'
import { costDocumentsApi, type CostDocument } from '../../api/costInbox'
import { errorMessage, money, btnPrimary } from './shared'

const ACCEPT_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const ACCEPT_EXT = /\.(pdf|jpe?g|png|webp)$/i
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i
const MAX_BYTES = 10 * 1024 * 1024
// API Claude liczy limit 10 MB na obraz PO zakodowaniu base64 (≈ 7,5 MB surowych bajtów) i odrzuca bok > 8000 px.
// Backend wysyła plik bez skalowania, więc takie zdjęcie kończyłoby zawsze w zakładce „Błędy” — zmniejszamy je tutaj
// do ~2500 px dłuższego boku (większe AI i tak skaluje samo; mniejszy plik = szybszy upload).
const IMAGE_MAX_BYTES = 7 * 1024 * 1024
const IMAGE_MAX_SIDE = 8000
const IMAGE_TARGET_SIDE = 2500
const POLL_INTERVAL_MS = 3_000
const POLL_MAX_MS = 120_000

const NO_RESPONSE_MSG = 'Brak odpowiedzi serwera — dokument mógł już zostać przyjęty. Odśwież listę, zanim wyślesz go ponownie.'
const STILL_PROCESSING_MSG = 'Odczyt trwa dłużej niż zwykle — odśwież listę za chwilę; dokument pojawi się w „Do zatwierdzenia” albo „Błędy”.'

type ItemStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error'
interface QueueItem { key: string; name: string; status: ItemStatus; message?: string; doc?: CostDocument }

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms))

/** Obraz za duży dla API AI (rozmiar lub bok) → JPEG ≤ 2500 px; PDF, małe obrazy i pliki nie do zdekodowania — bez zmian. */
async function shrinkImageIfNeeded(file: File): Promise<File> {
  const isImage = file.type.startsWith('image/') || IMAGE_EXT.test(file.name)
  if (!isImage || typeof createImageBitmap !== 'function') return file
  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(file) } catch { return file }
  try {
    const side = Math.max(bmp.width, bmp.height)
    if (file.size <= IMAGE_MAX_BYTES && side <= IMAGE_MAX_SIDE) return file
    const scale = Math.min(1, IMAGE_TARGET_SIDE / side)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * scale))
    canvas.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.fillStyle = '#fff' // JPEG nie ma przezroczystości — PNG z alfą bez tła stałby się czarny
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified })
  } finally {
    bmp.close()
  }
}

/** Odpytuje GET /cost-documents/:id aż odczyt się skończy; null = limit czasu, dokument usunięty lub komponent odmontowany. */
async function waitForExtraction(id: string, alive: () => boolean): Promise<CostDocument | null> {
  const deadline = Date.now() + POLL_MAX_MS
  while (alive() && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    if (!alive()) break
    try {
      const { data } = await api.get<CostDocument>(`/cost-documents/${id}`)
      if (data.status !== 'processing') return data
    } catch (e) {
      if ((e as { response?: { status?: number } })?.response?.status === 404) break
      // chwilowy błąd sieci / 5xx — próbujemy dalej do limitu
    }
  }
  return null
}

export default function UploadDropzone({ onUploaded, onUploadFailed }: {
  onUploaded: (doc: CostDocument) => void
  /** Upload bez odpowiedzi serwera (timeout / proxy) — dokument mógł już powstać, rodzic odświeża listę. */
  onUploadFailed?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(false)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const busyRef = useRef(false)
  const pendingRef = useRef<Array<{ key: string; file: File }>>([])
  const aliveRef = useRef(true)
  // Kolejka działa w jednym długim wywołaniu — callbacki trzymamy w ref, żeby zawsze były aktualne
  const onUploadedRef = useRef(onUploaded)
  onUploadedRef.current = onUploaded
  const onUploadFailedRef = useRef(onUploadFailed)
  onUploadFailedRef.current = onUploadFailed

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const patch = (key: string, p: Partial<QueueItem>) =>
    setQueue(q => q.map(it => it.key === key ? { ...it, ...p } : it))

  const pump = async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      while (pendingRef.current.length) {
        const { key, file } = pendingRef.current.shift()!
        patch(key, { status: 'uploading' })
        let doc: CostDocument
        try {
          doc = await costDocumentsApi.upload(await shrinkImageIfNeeded(file))
        } catch (e) {
          // Brak odpowiedzi (timeout axios, sieć) albo 5xx bez JSON (502/504 z proxy): serwer mógł już zapisać dokument
          // i czytać go w tle — „spróbuj ponownie” dawałoby drugi egzemplarz i podwójny koszt po zatwierdzeniu obu.
          const err = e as { response?: { status?: number; data?: { error?: string } } }
          const maybeAccepted = !err?.response || (Number(err.response.status) >= 500 && !err.response.data?.error)
          patch(key, { status: 'error', message: maybeAccepted ? NO_RESPONSE_MSG : errorMessage(e, 'Nie udało się wysłać pliku.') })
          if (maybeAccepted) onUploadFailedRef.current?.()
          continue
        }
        onUploadedRef.current(doc)
        if (doc.status !== 'processing') { patch(key, { status: 'done', doc }); continue }
        patch(key, { status: 'processing', doc })
        // Odpytywanie nie blokuje kolejki — następny plik idzie od razu (odczyt AI i tak biegnie na serwerze w tle).
        void waitForExtraction(doc.id, () => aliveRef.current).then(final => {
          if (!aliveRef.current) return
          patch(key, { status: 'done', doc: final ?? doc })
          if (final) onUploadedRef.current(final)
        })
      }
    } finally {
      busyRef.current = false
    }
  }

  const addFiles = (files: FileList | File[]) => {
    const items: QueueItem[] = []
    for (const file of Array.from(files)) {
      const key = `${file.name}|${file.size}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`
      const okType = ACCEPT_MIME.includes(file.type) || ACCEPT_EXT.test(file.name)
      if (!okType) { items.push({ key, name: file.name, status: 'error', message: 'Dozwolone: PDF, JPG, PNG, WEBP.' }); continue }
      if (file.size > MAX_BYTES) { items.push({ key, name: file.name, status: 'error', message: 'Plik większy niż 10 MB.' }); continue }
      items.push({ key, name: file.name, status: 'queued' })
      pendingRef.current.push({ key, file })
    }
    setQueue(q => [...items, ...q].slice(0, 30))
    void pump()
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); setActive(false)
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  const uploading = queue.some(q => q.status === 'uploading' || q.status === 'queued')
  const busy = uploading || queue.some(q => q.status === 'processing')

  return (
    <div>
      <div
        onDragOver={e => { e.preventDefault(); setActive(true) }}
        onDragLeave={() => setActive(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${active
          ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/30'
          : 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-violet-400 dark:hover:border-violet-600'}`}
      >
        <input ref={inputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
          className="hidden" onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
        <Upload size={26} className="mx-auto text-violet-500 mb-2" />
        <div className="text-sm font-bold text-gray-800 dark:text-gray-100">Upuść tu faktury lub paragony (PDF, JPG, PNG)</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Możesz wrzucić kilka plików naraz. System odczyta sprzedawcę, kwoty i datę (AI), przeliczy walutę po kursie NBP i sprawdzi, czy to nie duplikat.
        </div>
        <button type="button" onClick={e => { e.stopPropagation(); inputRef.current?.click() }} className={`${btnPrimary} mt-3`} disabled={uploading}>
          <FilePlus size={15} /> {uploading ? 'Wysyłam…' : 'Wybierz pliki'}
        </button>
      </div>

      {queue.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {queue.map(it => (
            <div key={it.key} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 text-sm">
              {it.status === 'uploading' || it.status === 'processing' ? <Loader2 size={15} className="animate-spin text-violet-500 flex-shrink-0" />
                : it.status === 'done' ? <CheckCircle2 size={15} className="text-green-500 flex-shrink-0" />
                : it.status === 'error' ? <XCircle size={15} className="text-red-500 flex-shrink-0" />
                : <span className="w-[15px] h-[15px] rounded-full border-2 border-gray-300 dark:border-gray-600 flex-shrink-0" />}
              <span className="font-semibold text-gray-700 dark:text-gray-200 truncate min-w-0 flex-1" title={it.name}>{it.name}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {it.status === 'queued' && 'w kolejce'}
                {it.status === 'uploading' && 'wysyłam…'}
                {it.status === 'processing' && 'Odczytywanie… (AI czyta dokument, zwykle do 60 s)'}
                {it.status === 'error' && <span className="text-red-600 dark:text-red-400">{it.message}</span>}
                {it.status === 'done' && it.doc && (
                  it.doc.status === 'error'
                    ? <span className="text-amber-600 dark:text-amber-400">wgrany, ale AI nie odczytało — uzupełnij ręcznie (zakładka „Błędy”)</span>
                    : it.doc.status === 'processing'
                      ? <span className="text-amber-600 dark:text-amber-400">{STILL_PROCESSING_MSG}</span>
                      : <>{it.doc.seller_name || 'nieznany sprzedawca'} · {money(it.doc.gross, it.doc.currency)} · {it.doc.doc_date || 'bez daty'} → czeka na zatwierdzenie</>
                )}
              </span>
            </div>
          ))}
          {!busy && (
            <button onClick={() => setQueue([])} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 font-semibold px-1">wyczyść listę</button>
          )}
        </div>
      )}
    </div>
  )
}
