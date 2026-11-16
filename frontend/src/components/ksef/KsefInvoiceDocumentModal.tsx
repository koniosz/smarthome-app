import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Download, Loader2, Printer, RotateCcw } from 'lucide-react'
import type { KsefInvoiceDocumentPayload } from '../../types'

// ─── Pełny podgląd faktury z KSeF ─────────────────────────────────────────────
// Backend renderuje z XML faktury (FA(2)/FA(3)) kompletny dokument HTML; tutaj pokazujemy go
// w iframe (zawsze białym — niezależnie od trybu ciemnego aplikacji) i pozwalamy wydrukować
// lub zapisać do PDF przez systemowe okno drukowania.
//
// Rodzic, który trzyma modal stale zamontowany i podmienia fakturę, powinien podać
// `key={invoice.id}` — dokument ładuje się raz na zamontowanie (+ „Spróbuj ponownie”).

interface Props {
  heading: string
  subheading?: string
  load: () => Promise<KsefInvoiceDocumentPayload>
  downloadXml?: () => Promise<Blob | string>   // opcjonalny przycisk „Pobierz XML”
  onClose: () => void
}

type DocState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: string }
  | { status: 'ready'; payload: KsefInvoiceDocumentPayload }

const LOAD_ERROR = 'Nie udało się pobrać faktury z KSeF. Spróbuj ponownie za chwilę.'
const XML_ERROR = 'Nie udało się pobrać pliku XML z KSeF.'

// Błędy, przy których ponowna próba nic nie zmieni: faktury nie da się wyrenderować (zły XML)
// albo nie ma numeru KSeF — wtedy nie pokazujemy „Spróbuj ponownie”.
const NON_RETRYABLE_CODES = new Set(['unparseable', 'no_ksef_number', 'xml_too_large'])

// Ctrl/⌘+P — skrót drukowania przeglądarki (z Shift też: w Chrome to „drukuj przez okno systemowe”)
const isPrintShortcut = (e: KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && typeof e.key === 'string' && e.key.toLowerCase() === 'p'

// Komunikat { error, code } z odpowiedzi serwera. Obsługuje JSON, tekst i Blob
// (pobieranie XML idzie z responseType 'blob' / 'text', więc błąd też przychodzi w tej postaci).
// Eksportowany — korzystają z niego także starsze przyciski XML (Płatności, Faktury do przypisania).
export async function readServerError(err: unknown, fallback: string): Promise<{ message: string; code?: string }> {
  try {
    let body: any = (err as any)?.response?.data
    if (typeof Blob !== 'undefined' && body instanceof Blob) body = await body.text()
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
    if (body && typeof body.error === 'string' && body.error.trim()) {
      return { message: body.error.trim(), code: typeof body.code === 'string' ? body.code : undefined }
    }
  } catch { /* nieczytelna odpowiedź — komunikat ogólny */ }
  return { message: fallback }
}

const safeFileBase = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[\s._]+|[\s._]+$/g, '')

// Nazwa pliku, gdy serwer jej nie podał (np. stan błędu): z nagłówka „Faktura FV/12/2026” → „faktura-FV_12_2026”
function fallbackFileBase(heading: string): string {
  const core = heading.replace(/^\s*faktura\s*/i, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+|[._]+$/g, '')
  return core ? `faktura-${core}` : 'faktura-ksef'
}

// Wydruk awaryjny odbywa się w zwykłym oknie tej samej domeny — BEZ piaskownicy iframe — więc zanim
// wpiszemy tam HTML, usuwamy z niego to, co mogłoby się wykonać. Uwaga: ten filtr to czarna lista
// „na ile się da” i NIE jest równoważny sandboxowi z podglądu. Właściwą ochroną w tym oknie jest
// polityka CSP samego dokumentu (<meta http-equiv="Content-Security-Policy">, default-src 'none'),
// dlatego jej NIE usuwamy — wycinamy tylko pozostałe meta http-equiv (refresh itp.).
// Dokument z serwera i tak jest bez skryptów (backend escapuje każdą wartość).
function stripActiveContent(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll(
      'script, iframe, frame, object, embed, base, meta[http-equiv]:not([http-equiv="Content-Security-Policy" i])',
    ).forEach(el => el.remove())
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        const isUrl = name === 'href' || name === 'src' || name === 'action' || name === 'formaction' || name === 'xlink:href'
        if (name.startsWith('on') || (isUrl && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name)
      }
    })
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
  } catch {
    return ''
  }
}

const BTN_PRIMARY = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed'
const BTN_SOFT = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 rounded-lg hover:bg-violet-100 dark:hover:bg-violet-900/40 whitespace-nowrap disabled:opacity-60'
const BTN_PLAIN = 'px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 whitespace-nowrap'

export default function KsefInvoiceDocumentModal({ heading, subheading, load, downloadXml, onClose }: Props) {
  const [state, setState] = useState<DocState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)          // „Spróbuj ponownie” = kolejna próba
  const [downloading, setDownloading] = useState(false)
  const [notice, setNotice] = useState('')            // drobny komunikat pod nagłówkiem (wydruk / XML)
  const [frameReady, setFrameReady] = useState(false) // iframe wczytał dokument (wcześniej jest w nim about:blank)

  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const aliveRef = useRef(true)
  const backdropDownRef = useRef(false)
  const restoreTitleRef = useRef<(() => void) | null>(null)
  const printRef = useRef<() => void>(() => {})       // aktualny handlePrint — dla skrótu Ctrl/⌘+P

  // Rodzice podają `load` / `onClose` jako nowe funkcje przy każdym renderze — trzymamy najnowsze
  // w refach, żeby re-render rodzica nie pobierał faktury z KSeF od nowa.
  const loadRef = useRef(load)
  const onCloseRef = useRef(onClose)
  useEffect(() => { loadRef.current = load; onCloseRef.current = onClose })

  // Życie komponentu: flaga dla operacji asynchronicznych + przywrócenie tytułu karty przy zamknięciu
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      restoreTitleRef.current?.()
    }
  }, [])

  // Pobranie dokumentu. `cancelled` odcina spóźnione odpowiedzi (zamknięcie modala, ponowna próba).
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setFrameReady(false)   // nowa próba = nowa ramka; druk dopiero po jej zdarzeniu `load`
    setNotice('')
    loadRef.current()
      .then(payload => {
        if (cancelled) return
        if (!payload || typeof payload.html !== 'string' || !payload.html.trim()) {
          setState({ status: 'error', message: 'Serwer nie zwrócił dokumentu faktury. Spróbuj ponownie.' })
          return
        }
        setState({ status: 'ready', payload })
      })
      .catch(async err => {
        const { message, code } = await readServerError(err, LOAD_ERROR)
        if (!cancelled) setState({ status: 'error', message, code })
      })
    return () => { cancelled = true }
  }, [attempt])

  // Klawisze przy otwartym modalu — nasłuch w fazie capture, czyli przed nasłuchami reszty aplikacji:
  //  • Ctrl/⌘+K nie otwiera wyszukiwarki globalnej nad fakturą (Esc zamknąłby wtedy fakturę pod spodem,
  //    a wyszukiwarka zostałaby na wierzchu),
  //  • Ctrl/⌘+P drukuje FAKTURĘ (to samo co przycisk), a nie stronę aplikacji pod modalem,
  //  • Esc zamyka tylko ten modal (leży nad innymi, np. nad szybkim podglądem w Płatnościach).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && typeof e.key === 'string' && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (isPrintShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) printRef.current()
        return
      }
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Tło pod modalem nie przewija się; po zamknięciu wraca poprzednie ustawienie
  useEffect(() => {
    const { body } = document
    const prev = body.style.overflow
    body.style.overflow = 'hidden'
    return () => { body.style.overflow = prev }
  }, [])

  // Fokus do modala (klawiatura trafia do aplikacji, nie pod spód), a po zamknięciu z powrotem
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus({ preventScroll: true })
    return () => { try { prev?.focus({ preventScroll: true }) } catch { /* element mógł zniknąć */ } }
  }, [])

  const payload = state.status === 'ready' ? state.payload : null
  const retryable = state.status === 'error' && !NON_RETRYABLE_CODES.has(state.code ?? '')
  const fileBase =safeFileBase(payload?.filename ?? '') || fallbackFileBase(heading)

  // Ramka wczytała dokument faktury → można drukować. Gdy fokus jest w dokumencie faktury, klawisze
  // nie docierają do okna aplikacji — Esc i Ctrl/⌘+P łapiemy też tam. (Safari nie wywołuje nasłuchów
  // w ramce bez allow-scripts: tam po kliknięciu w fakturę zostają przyciski w nagłówku.)
  const handleFrameLoad = () => {
    setFrameReady(true)
    try {
      iframeRef.current?.contentDocument?.addEventListener('keydown', e => {
        if (isPrintShortcut(e)) {
          e.preventDefault()
          e.stopPropagation()
          if (!e.repeat) printRef.current()
          return
        }
        if (e.key === 'Escape') onCloseRef.current()
      })
    } catch { /* brak dostępu do dokumentu — zostaje przycisk „Zamknij” */ }
  }

  // ── Wydruk / zapis do PDF ──
  // Przeglądarka podpowiada nazwę pliku PDF z tytułu karty (Chrome) albo z tytułu drukowanego
  // dokumentu (Firefox, Safari), więc na czas drukowania ustawiamy oba, a potem przywracamy.
  const beginPrintTitle = (name: string, frame: HTMLIFrameElement | null) => {
    restoreTitleRef.current?.()
    let frameWin: Window | null = null
    let frameDoc: Document | null = null
    try { frameWin = frame?.contentWindow ?? null; frameDoc = frame?.contentDocument ?? null } catch { /* brak dostępu */ }

    const prevTitle = document.title
    const prevFrameTitle = frameDoc?.title ?? ''
    document.title = name
    try { if (frameDoc) frameDoc.title = name } catch { /* tytuł ramki jest tylko dodatkiem */ }

    let timer = 0
    let done = false
    const restore = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      window.removeEventListener('afterprint', restore)
      try { frameWin?.removeEventListener('afterprint', restore) } catch { /* ramka już nie istnieje */ }
      // nie nadpisuj tytułu, jeśli aplikacja zmieniła go w międzyczasie
      if (document.title === name) document.title = prevTitle
      try { if (frameDoc && frameDoc.title === name) frameDoc.title = prevFrameTitle } catch { /* jw. */ }
      if (restoreTitleRef.current === restore) restoreTitleRef.current = null
    }
    window.addEventListener('afterprint', restore)
    try { frameWin?.addEventListener('afterprint', restore) } catch { /* zostaje timer awaryjny */ }
    restoreTitleRef.current = restore
    return {
      restore,
      fallbackAfter: (ms: number) => {
        if (done) return   // `afterprint` już posprzątał
        window.clearTimeout(timer)
        timer = window.setTimeout(restore, ms)
      },
    }
  }

  // Wydruk awaryjny: nowe okno z samym dokumentem faktury
  const printInNewWindow = (html: string, name: string) => {
    const clean = stripActiveContent(html)
    const w = clean ? window.open('', '_blank') : null
    if (!w) {
      setNotice(clean
        ? 'Przeglądarka zablokowała okno wydruku. Zezwól tej stronie na wyskakujące okna i spróbuj ponownie.'
        : 'Nie udało się przygotować wydruku tej faktury.')
      return
    }
    try {
      w.document.open()
      w.document.write(clean)
      w.document.close()
      try { w.document.title = name } catch { /* nazwa pliku będzie domyślna */ }
      let fired = false
      const go = () => {
        if (fired) return
        fired = true
        try { w.focus(); w.print() } catch { /* okno zostaje otwarte — można wydrukować ręcznie (Ctrl+P) */ }
      }
      w.addEventListener('load', go)
      // po wydruku (albo anulowaniu) zamknij okno pomocnicze — użytkownik wraca prosto do aplikacji
      w.addEventListener('afterprint', () => { try { w.close() } catch { /* zostaje otwarte */ } })
      window.setTimeout(go, 400)
    } catch {
      setNotice('Nie udało się otworzyć okna wydruku. Spróbuj ponownie.')
    }
  }

  const handlePrint = () => {
    // bez wczytanej ramki print() trafiłby w początkowy, pusty about:blank
    if (!payload || !frameReady) return
    setNotice('')
    // nazwa z serwera („faktura-<numer>”) → ten sam rdzeń co plik XML; w razie braku tytuł dokumentu
    const name = safeFileBase(payload.filename ?? '') || (payload.title ?? '').trim() || fileBase
    const session = beginPrintTitle(name, iframeRef.current)
    try {
      const win = iframeRef.current?.contentWindow
      if (!win) throw new Error('Podgląd faktury nie jest gotowy')
      const startedAt = Date.now()
      win.focus()
      win.print()
      // Chrome i Firefox wstrzymują skrypt do zamknięcia okna drukowania — wtedy tytuł można przywrócić
      // od razu. Safari wraca natychmiast (okno dopiero się otwiera): czekamy na `afterprint`,
      // a timer jest tylko zabezpieczeniem, gdyby zdarzenie nie przyszło.
      session.fallbackAfter(Date.now() - startedAt > 800 ? 300 : 120_000)
      // Fokus z ramki wraca do modala — inaczej Esc trafiałby do dokumentu faktury, gdzie Safari
      // nie wywołuje naszych nasłuchów, i modal dałoby się zamknąć tylko przyciskiem.
      panelRef.current?.focus({ preventScroll: true })
    } catch {
      session.restore()
      printInNewWindow(payload.html, name)
    }
  }
  // Skrót Ctrl/⌘+P (nasłuchy klawiszy żyją dłużej niż jeden render) zawsze woła aktualną wersję
  useEffect(() => { printRef.current = handlePrint })

  // ── Pobranie oryginalnego XML (działa także w stanie błędu, np. gdy faktury nie dało się wyrenderować) ──
  const handleDownloadXml = async () => {
    if (!downloadXml || downloading) return
    setDownloading(true)
    setNotice('')
    try {
      const data = await downloadXml()
      const blob = typeof data === 'string' ? new Blob([data], { type: 'application/xml' }) : data
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${fileBase}.xml`
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // zwolnij adres dopiero, gdy przeglądarka zdąży rozpocząć pobieranie
      window.setTimeout(() => URL.revokeObjectURL(url), 1500)
    } catch (err) {
      const { message } = await readServerError(err, XML_ERROR)
      if (aliveRef.current) setNotice(message)
    } finally {
      if (aliveRef.current) setDownloading(false)
    }
  }

  const xmlButton = (className: string) => downloadXml && (
    <button type="button" onClick={handleDownloadXml} disabled={downloading} className={className}>
      <Download size={13} /> {downloading ? 'Pobieram…' : 'Pobierz XML'}
    </button>
  )

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-0 sm:p-4"
      onMouseDown={e => { backdropDownRef.current = e.target === e.currentTarget }}
      onClick={e => {
        e.stopPropagation()
        // zamykamy tylko, gdy kliknięcie zaczęło się i skończyło na tle (nie przy przeciąganiu z wnętrza)
        if (e.target === e.currentTarget && backdropDownRef.current) onClose()
        backdropDownRef.current = false
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-white dark:bg-gray-900 sm:rounded-2xl shadow-2xl w-full max-w-5xl h-full sm:h-[92vh] flex flex-col overflow-hidden outline-none"
      >
        {/* Nagłówek. Telefon: tytuł + „Zamknij” w pierwszym rzędzie, akcje pod spodem; od sm wszystko w jednym rzędzie */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">{heading}</h2>
            {subheading && <div className="text-xs text-gray-400 truncate">{subheading}</div>}
          </div>
          <div className="order-3 sm:order-2 basis-full sm:basis-auto flex flex-wrap items-center gap-2">
            <button type="button" onClick={handlePrint} disabled={!payload || !frameReady} className={BTN_PRIMARY}>
              <Printer size={13} /> Drukuj / zapisz PDF
            </button>
            {xmlButton(BTN_SOFT)}
          </div>
          <button type="button" onClick={onClose} className={`order-2 sm:order-3 flex-shrink-0 ${BTN_PLAIN}`}>Zamknij</button>
        </div>

        {notice && (
          <div role="alert" className="px-4 sm:px-5 py-2 text-xs font-medium text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-900/40 flex-shrink-0">
            {notice}
          </div>
        )}

        {state.status === 'loading' && (
          <div role="status" aria-live="polite" className="relative flex-1 min-h-0 overflow-hidden bg-gray-100 dark:bg-gray-950 p-4 sm:p-6">
            {/* Szkielet kartki — sygnalizuje, że za chwilę pojawi się dokument */}
            <div className="mx-auto h-full max-w-3xl rounded-lg bg-white shadow-sm p-6 sm:p-10 overflow-hidden">
              <div className="animate-pulse space-y-6">
                <div className="flex justify-between gap-6">
                  <div className="space-y-2 flex-1"><div className="h-4 w-2/3 rounded bg-gray-200" /><div className="h-3 w-1/2 rounded bg-gray-100" /></div>
                  <div className="space-y-2 w-1/3"><div className="h-5 rounded bg-gray-200" /><div className="h-3 w-2/3 ml-auto rounded bg-gray-100" /></div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-24 rounded-lg bg-gray-100" />
                  <div className="h-24 rounded-lg bg-gray-100" />
                </div>
                <div className="space-y-2">
                  <div className="h-6 rounded bg-gray-200" />
                  {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-5 rounded bg-gray-100" />)}
                </div>
                <div className="ml-auto h-16 w-1/3 rounded-lg bg-gray-100" />
              </div>
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-white shadow-lg border border-gray-100 text-sm font-semibold text-gray-700">
                <Loader2 size={17} className="animate-spin text-violet-600" /> Pobieram fakturę z KSeF…
              </div>
            </div>
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-6">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-3 w-11 h-11 rounded-full bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center">
                <AlertTriangle size={20} />
              </div>
              <div className="text-sm font-bold text-gray-800 dark:text-gray-100">Nie udało się wyświetlić faktury</div>
              <p role="alert" className="mt-1.5 text-sm text-gray-600 dark:text-gray-300 break-words">{state.message}</p>
              {state.code === 'unparseable' && downloadXml && (
                <p className="mt-1.5 text-xs text-gray-400">Oryginalny plik XML faktury nadal możesz pobrać.</p>
              )}
              {(retryable || (state.code === 'unparseable' && downloadXml)) && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {/* ponowna próba tylko tam, gdzie może się udać (nie przy złym XML ani braku numeru KSeF) */}
                  {retryable && (
                    <button type="button" onClick={() => setAttempt(a => a + 1)} className={BTN_PRIMARY}>
                      <RotateCcw size={13} /> Spróbuj ponownie
                    </button>
                  )}
                  {/* XML jest zawsze w nagłówku; tu powtarzamy go tylko, gdy to jedyne sensowne wyjście */}
                  {state.code === 'unparseable' && xmlButton(BTN_SOFT)}
                </div>
              )}
            </div>
          </div>
        )}

        {payload && (
          /* Piaskownica bez allow-scripts: dokument jest tylko do czytania i druku. allow-same-origin
             + allow-modals są potrzebne, żeby aplikacja mogła wywołać print() na oknie ramki.
             Ramka zawsze biała — faktura nie dziedziczy trybu ciemnego. */
          <iframe
            ref={iframeRef}
            title={payload.title || heading}
            srcDoc={payload.html}
            sandbox="allow-same-origin allow-modals"
            onLoad={handleFrameLoad}
            className="flex-1 min-h-0 w-full bg-white"
            style={{ border: 0, background: '#ffffff', colorScheme: 'light' }}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
