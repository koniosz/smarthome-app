import { useRef, useState } from 'react'
import { aiQuotesApi } from '../../api/client'

interface AIQuoteUploadProps {
  projectId: string
  onCreated: (quote: import('../../types').AiQuote) => void
  compact?: boolean
}

type UploadState = 'idle' | 'uploading' | 'analyzing' | 'error'

const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls']
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel']
const MAX_SIZE_MB = 20

// ── Scope options ────────────────────────────────────────────────────────────
interface ScopeItem {
  id: string
  label: string
  icon: string
  group: string
}

const SCOPE_GROUPS = ['Oświetlenie', 'HVAC', 'Zasłony i rolety', 'Bezpieczeństwo', 'AV i integracje', 'Czujniki i inne']

const SCOPE_ITEMS: ScopeItem[] = [
  // Oświetlenie
  { id: 'oswietlenie_onoff',    label: 'Oświetlenie On/Off',        icon: '💡', group: 'Oświetlenie' },
  { id: 'oswietlenie_dali',     label: 'Oświetlenie DALI',          icon: '🌟', group: 'Oświetlenie' },
  { id: 'led_rgbw',             label: 'Paski LED RGBW',            icon: '🌈', group: 'Oświetlenie' },
  // HVAC
  { id: 'ogrzewanie',           label: 'Ogrzewanie',                icon: '🔥', group: 'HVAC' },
  { id: 'wentylacja',           label: 'Wentylacja / Rekuperacja',  icon: '🌬️', group: 'HVAC' },
  { id: 'klimatyzacja',         label: 'Klimatyzacja',              icon: '❄️', group: 'HVAC' },
  // Zasłony i rolety
  { id: 'zaslony_wewnetrzne',   label: 'Zasłony wewnętrzne',        icon: '🪟', group: 'Zasłony i rolety' },
  { id: 'rolety_zewnetrzne',    label: 'Rolety / Żaluzje zewn.',    icon: '🏠', group: 'Zasłony i rolety' },
  // Bezpieczeństwo
  { id: 'system_alarmowy',      label: 'System alarmowy',           icon: '🚨', group: 'Bezpieczeństwo' },
  { id: 'kamery_cctv',          label: 'Kamery CCTV',               icon: '📷', group: 'Bezpieczeństwo' },
  { id: 'domofon',              label: 'Domofon / Wideofon',        icon: '🔔', group: 'Bezpieczeństwo' },
  // AV i integracje
  { id: 'audio',                label: 'Integracja z Audio',        icon: '🎵', group: 'AV i integracje' },
  { id: 'video',                label: 'Integracja z Video/TV',     icon: '📺', group: 'AV i integracje' },
  // Czujniki i inne
  { id: 'czujniki_zalania',     label: 'Czujniki zalania',          icon: '💧', group: 'Czujniki i inne' },
  { id: 'stacja_pogodowa',      label: 'Stacja pogodowa',           icon: '🌤️', group: 'Czujniki i inne' },
  { id: 'podgrzewane_lustra',   label: 'Podgrzewane lustra',        icon: '🪞', group: 'Czujniki i inne' },
  { id: 'czujniki_obecnosci',   label: 'Czujniki obecności KNX',   icon: '👁️', group: 'Czujniki i inne' },
]

const ALL_IDS = SCOPE_ITEMS.map(s => s.id)

// ─────────────────────────────────────────────────────────────────────────────

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return '📄'
  if (ext === 'xlsx' || ext === 'xls') return '📊'
  return '🖼️'
}

function fmtSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function AIQuoteUpload({ projectId, onCreated, compact = false }: AIQuoteUploadProps) {
  const [state, setState] = useState<UploadState>('idle')
  const [uploadPct, setUploadPct] = useState(0)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [selectedScope, setSelectedScope] = useState<Set<string>>(new Set(ALL_IDS))
  const [userNotes, setUserNotes] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const validateFile = (f: File) => {
    const ext = '.' + f.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXT.includes(ext) && !ALLOWED_MIME.includes(f.type)) return 'Niedozwolony format'
    if (f.size > MAX_SIZE_MB * 1024 * 1024) return `Plik za duży (max ${MAX_SIZE_MB} MB)`
    return null
  }

  const addFiles = (incoming: FileList | File[]) => {
    const list = Array.from(incoming)
    for (const f of list) {
      const err = validateFile(f)
      if (err) { setError(`${f.name}: ${err}`); setState('error'); return }
    }
    setSelectedFiles(prev => {
      const names = new Set(prev.map(f => f.name))
      return [...prev, ...list.filter(f => !names.has(f.name))]
    })
    setError('')
    setState('idle')
  }

  const removeFile = (name: string) => {
    setSelectedFiles(prev => prev.filter(f => f.name !== name))
  }

  const toggleScope = (id: string) => {
    setSelectedScope(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelectedScope(new Set(ALL_IDS))
  const deselectAll = () => setSelectedScope(new Set())

  const handleAnalyze = async () => {
    if (selectedFiles.length === 0) return
    setError('')
    setState('uploading')
    setUploadPct(0)

    // Map selected scope IDs to human-readable feature names for the AI prompt
    const features = SCOPE_ITEMS
      .filter(s => selectedScope.has(s.id))
      .map(s => s.label)

    try {
      const quote = await aiQuotesApi.analyze(
        projectId,
        selectedFiles,
        pct => { setUploadPct(pct); if (pct >= 100) setState('analyzing') },
        undefined,
        features,
        userNotes.trim() || undefined,
      )
      onCreated(quote)
      setState('idle')
      setSelectedFiles([])
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Błąd analizy'
      setError(msg)
      setState('error')
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files)
    e.target.value = ''
  }

  if (state === 'uploading') {
    return (
      <div className={`flex flex-col items-center justify-center gap-4 ${compact ? 'py-8' : 'py-16'}`}>
        <div className="w-16 h-16 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-3xl">📤</div>
        <div className="text-sm font-medium text-gray-600 dark:text-gray-400">Wgrywanie plików…</div>
        <div className="w-64 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div className="h-full bg-violet-500 rounded-full transition-all duration-300" style={{ width: `${uploadPct}%` }} />
        </div>
        <div className="text-xs text-gray-400">{uploadPct}%</div>
      </div>
    )
  }

  if (state === 'analyzing') {
    return (
      <div className={`flex flex-col items-center justify-center gap-4 ${compact ? 'py-8' : 'py-16'}`}>
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-4 border-violet-200 dark:border-violet-800" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-violet-500 animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center text-2xl">🤖</div>
        </div>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">AI analizuje pliki…</div>
        <div className="text-xs text-gray-400 text-center max-w-xs">
          Wykrywam pomieszczenia i dobieram komponenty KNX, Control4, Hikvision, Satel.<br />
          Może to potrwać ~20–90 sekund.
        </div>
      </div>
    )
  }

  const allSelected = selectedScope.size === ALL_IDS.length
  const noneSelected = selectedScope.size === 0

  return (
    <div className={compact ? '' : 'py-4'}>
      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onClick={() => inputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-xl cursor-pointer transition-colors
          flex flex-col items-center justify-center gap-3 text-center
          ${compact ? 'py-6 px-6' : 'py-12 px-8'}
          ${dragging
            ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20'
            : 'border-gray-300 dark:border-gray-600 hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/10'
          }
        `}
      >
        <div className="text-4xl">{dragging ? '📂' : '🗺️'}</div>
        <div>
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {dragging ? 'Upuść pliki tutaj' : 'Wgraj rzuty mieszkania / domu'}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            PDF, JPG, PNG, XLSX · wiele plików · max {MAX_SIZE_MB} MB każdy
          </div>
        </div>
        <button
          type="button"
          className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium rounded-lg transition-colors"
          onClick={e => { e.stopPropagation(); inputRef.current?.click() }}
        >
          Wybierz pliki
        </button>
      </div>

      {/* Selected files list */}
      {selectedFiles.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {selectedFiles.map(f => (
            <div key={f.name} className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/60 rounded-lg text-xs">
              <span className="text-base">{fileIcon(f.name)}</span>
              <span className="flex-1 truncate text-gray-700 dark:text-gray-300">{f.name}</span>
              <span className="text-gray-400 shrink-0">{fmtSize(f.size)}</span>
              <button
                onClick={() => removeFile(f.name)}
                className="text-red-400 hover:text-red-600 ml-1 font-bold"
                title="Usuń"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* ── Wytyczne / dodatkowe instrukcje ───────────────────────────────── */}
      <div className="mt-4">
        <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-1.5">
          📝 Wytyczne dla AI <span className="normal-case font-normal text-gray-400">(opcjonalne)</span>
        </label>
        <textarea
          value={userNotes}
          onChange={e => setUserNotes(e.target.value)}
          rows={4}
          placeholder={`Opisz czego oczekujesz od projektu, np.:\n• Dom 250m² z garażem, 4 sypialnie\n• Klient chce sterowanie DALI + rolety zewnętrzne na każdym oknie\n• Brak audio, priorytet: bezpieczeństwo Satel + kamery Hikvision\n• Budżet ok. 80 000 zł netto`}
          className="w-full px-3 py-2.5 text-sm rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none focus:border-violet-400 dark:focus:border-violet-500 focus:ring-1 focus:ring-violet-300 dark:focus:ring-violet-700 resize-none transition-colors"
        />
        {userNotes.trim().length > 0 && (
          <div className="flex items-center justify-between mt-1">
            <p className="text-xs text-violet-600 dark:text-violet-400">
              ✓ Wytyczne zostaną uwzględnione w analizie AI
            </p>
            <button
              onClick={() => setUserNotes('')}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors"
            >
              Wyczyść
            </button>
          </div>
        )}
      </div>

      {/* ── Scope selector ─────────────────────────────────────────────────── */}
      <div className="mt-4 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            ⚙️ Zakres instalacji
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">
              {selectedScope.size}/{ALL_IDS.length} wybranych
            </span>
            <button
              onClick={allSelected ? deselectAll : selectAll}
              className="text-xs text-violet-600 dark:text-violet-400 hover:underline font-medium"
            >
              {allSelected ? 'Odznacz wszystkie' : 'Zaznacz wszystkie'}
            </button>
          </div>
        </div>

        {/* Groups */}
        <div className="p-3 space-y-3">
          {SCOPE_GROUPS.map(group => {
            const groupItems = SCOPE_ITEMS.filter(s => s.group === group)
            const checkedCount = groupItems.filter(s => selectedScope.has(s.id)).length
            const allGroupChecked = checkedCount === groupItems.length

            const toggleGroup = () => {
              setSelectedScope(prev => {
                const next = new Set(prev)
                if (allGroupChecked) {
                  groupItems.forEach(s => next.delete(s.id))
                } else {
                  groupItems.forEach(s => next.add(s.id))
                }
                return next
              })
            }

            return (
              <div key={group}>
                {/* Group label */}
                <button
                  onClick={toggleGroup}
                  className="flex items-center gap-1.5 mb-1.5 group"
                >
                  <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                    allGroupChecked
                      ? 'bg-violet-600 border-violet-600'
                      : checkedCount > 0
                        ? 'bg-violet-200 dark:bg-violet-900/40 border-violet-400'
                        : 'border-gray-300 dark:border-gray-600'
                  }`}>
                    {allGroupChecked && <span className="text-white text-[8px] leading-none font-bold">✓</span>}
                    {!allGroupChecked && checkedCount > 0 && <span className="text-violet-600 dark:text-violet-400 text-[8px] leading-none font-bold">–</span>}
                  </div>
                  <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
                    {group}
                  </span>
                  <span className="text-xs text-gray-300 dark:text-gray-600">
                    ({checkedCount}/{groupItems.length})
                  </span>
                </button>

                {/* Items grid */}
                <div className="grid grid-cols-2 gap-1 pl-1">
                  {groupItems.map(item => {
                    const checked = selectedScope.has(item.id)
                    return (
                      <button
                        key={item.id}
                        onClick={() => toggleScope(item.id)}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-all text-xs ${
                          checked
                            ? 'bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-700 text-violet-800 dark:text-violet-200'
                            : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        <div className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                          checked
                            ? 'bg-violet-600 border-violet-600'
                            : 'border-gray-300 dark:border-gray-600'
                        }`}>
                          {checked && <span className="text-white text-[8px] leading-none font-bold">✓</span>}
                        </div>
                        <span className="text-base leading-none">{item.icon}</span>
                        <span className="leading-tight">{item.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Analyze button */}
      {selectedFiles.length > 0 && (
        <div className="flex items-center justify-between pt-3">
          <span className="text-xs text-gray-400">
            {selectedFiles.length} plik{selectedFiles.length !== 1 ? 'i' : ''}
            {' · '}
            {noneSelected
              ? <span className="text-red-500">Brak wybranych systemów</span>
              : <span>{selectedScope.size} systemów</span>
            }
          </span>
          <button
            onClick={handleAnalyze}
            disabled={noneSelected}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition-colors"
          >
            🤖 Analizuj AI
          </button>
        </div>
      )}

      {selectedFiles.length === 0 && (
        <div className="flex items-center justify-end pt-3">
          <span className="text-xs text-gray-400">
            {noneSelected
              ? <span className="text-amber-500">⚠️ Zaznacz przynajmniej jeden system</span>
              : <span>{selectedScope.size} systemów wybranych · Wgraj pliki aby rozpocząć analizę</span>
            }
          </span>
        </div>
      )}

      {state === 'error' && error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3">
          <span>❌</span>
          <span className="flex-1">{error}</span>
          <button className="ml-auto text-xs underline" onClick={() => setState('idle')}>OK</button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls"
        multiple
        className="hidden"
        onChange={onInputChange}
      />
    </div>
  )
}
