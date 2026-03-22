import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { QuoteBrand } from '../../types'
import { QUOTE_BRANDS, QUOTE_BRAND_COLORS, SMART_FEATURES } from '../../types'
import { projectsApi, aiQuotesApi } from '../../api/client'

type Step = 'config' | 'uploading' | 'analyzing' | 'error'

const BRAND_INFO: Record<QuoteBrand, { icon: string; desc: string; color: string }> = {
  KNX:       { icon: '🟠', desc: 'Oświetlenie DALI, rolety, ogrzewanie, panele dotykowe', color: 'border-orange-300 bg-orange-50 dark:bg-orange-950/20' },
  Control4:  { icon: '🔵', desc: 'Kontroler centralny, keypady, integracja AV', color: 'border-blue-300 bg-blue-50 dark:bg-blue-950/20' },
  Hikvision: { icon: '🔴', desc: 'Kamery IP, NVR, domofon, kontrola dostępu', color: 'border-red-300 bg-red-50 dark:bg-red-950/20' },
  Satel:     { icon: '🟢', desc: 'Centrala alarmowa, czujniki PIR, moduł GSM', color: 'border-green-300 bg-green-50 dark:bg-green-950/20' },
  Usługi:    { icon: '🔧', desc: 'Instalacja, programowanie, konfiguracja', color: 'border-slate-300 bg-slate-50 dark:bg-slate-900/20' },
}

const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls']
const MAX_MB = 20

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return '📄'
  if (ext === 'xlsx' || ext === 'xls') return '📊'
  return '🖼️'
}
function fmtSize(b: number) {
  return b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`
}

interface Props { onClose: () => void }

export default function AIProjectWizard({ onClose }: Props) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('config')
  const [uploadPct, setUploadPct] = useState(0)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [clientName, setClientName] = useState('')
  const [clientContact, setClientContact] = useState('')
  const [area, setArea] = useState('')
  const [systems, setSystems] = useState<QuoteBrand[]>(['KNX', 'Hikvision', 'Satel'])
  const [features, setFeatures] = useState<string[]>([])
  const [files, setFiles] = useState<File[]>([])

  const toggleSystem = (b: QuoteBrand) =>
    setSystems(s => s.includes(b) ? s.filter(x => x !== b) : [...s, b])
  const toggleFeature = (k: string) =>
    setFeatures(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k])

  const addFiles = (incoming: FileList | File[]) => {
    const list = Array.from(incoming)
    for (const f of list) {
      const ext = '.' + f.name.split('.').pop()?.toLowerCase()
      if (!ALLOWED_EXT.includes(ext)) { setError(`Niedozwolony format: ${f.name}`); return }
      if (f.size > MAX_MB * 1024 * 1024) { setError(`Plik za duży (max ${MAX_MB} MB): ${f.name}`); return }
    }
    setFiles(prev => {
      const names = new Set(prev.map(f => f.name))
      return [...prev, ...list.filter(f => !names.has(f.name))]
    })
    setError('')
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const canSubmit = name.trim().length > 0 && systems.length > 0 && files.length > 0

  const handleSubmit = async () => {
    if (!canSubmit) return
    setError('')
    setStep('uploading')
    setUploadPct(0)
    try {
      // 1. Create project
      const project = await projectsApi.create({
        name: name.trim(),
        client_name: clientName,
        client_contact: clientContact,
        area_m2: area ? Number(area) : null,
        smart_features: features,
        project_type: 'installation',
        status: 'offer_submitted',
        budget_amount: 0,
        description: '',
        start_date: null,
        end_date: null,
      })

      // 2. Analyze files with selected systems
      await aiQuotesApi.analyze(project.id, files, (pct) => {
        setUploadPct(pct)
        if (pct >= 100) setStep('analyzing')
      }, systems, features)

      navigate(`/projects/${project.id}`)
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Błąd analizy'
      setError(msg)
      setStep('error')
    }
  }

  // ── Loading screens ───────────────────────────────────────────────────────────
  if (step === 'uploading') return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-10 flex flex-col items-center gap-5 w-80">
        <div className="text-4xl">📤</div>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Wgrywanie plików…</div>
        <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${uploadPct}%` }} />
        </div>
        <div className="text-xs text-gray-400">{uploadPct}%</div>
      </div>
    </div>
  )

  if (step === 'analyzing') return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-10 flex flex-col items-center gap-5 w-96 text-center">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-4 border-violet-200 dark:border-violet-800" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-violet-500 animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center text-2xl">🤖</div>
        </div>
        <div className="text-sm font-bold text-gray-700 dark:text-gray-300">AI analizuje rzut…</div>
        <div className="text-xs text-gray-400 leading-relaxed">
          Wykrywam pomieszczenia i dobieram urządzenia<br />
          dla systemów: <span className="font-medium text-gray-600 dark:text-gray-300">{systems.join(', ')}</span>.<br />
          Może to potrwać ~30–90 sekund.
        </div>
      </div>
    </div>
  )

  // ── Config form ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">🤖</span>
            <div>
              <div className="font-bold text-gray-800 dark:text-gray-100 text-sm">Wycena AI z rzutu</div>
              <div className="text-xs text-gray-400">Wskaż systemy → wgraj pliki → AI wyceni projekt</div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl font-bold">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Project info */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Dane projektu</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Nazwa projektu *</label>
                <input
                  className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
                  placeholder="np. Dom Kowalski – Kraków"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Inwestor</label>
                <input
                  className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
                  placeholder="Jan Kowalski"
                  value={clientName}
                  onChange={e => setClientName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Kontakt</label>
                <input
                  className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
                  placeholder="+48 600 000 000"
                  value={clientContact}
                  onChange={e => setClientContact(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Powierzchnia (m²)</label>
                <input
                  type="number" min="10" step="5"
                  className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
                  placeholder="np. 180"
                  value={area}
                  onChange={e => setArea(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Systems */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Systemy do wyceny *</div>
            <div className="grid grid-cols-2 gap-2">
              {QUOTE_BRANDS.map(brand => {
                const active = systems.includes(brand)
                const info = BRAND_INFO[brand]
                return (
                  <button
                    key={brand}
                    onClick={() => toggleSystem(brand)}
                    className={`flex items-start gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                      active ? `${info.color} border-current` : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-lg mt-0.5">{info.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-bold ${active ? QUOTE_BRAND_COLORS[brand].split(' ')[1] : 'text-gray-700 dark:text-gray-300'}`}>{brand}</span>
                        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${active ? 'border-violet-500 bg-violet-500' : 'border-gray-300 dark:border-gray-600'}`}>
                          {active && <span className="text-white text-xs leading-none">✓</span>}
                        </span>
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5 leading-tight">{info.desc}</div>
                    </div>
                  </button>
                )
              })}
            </div>
            {systems.length === 0 && (
              <div className="text-xs text-red-500">Wybierz co najmniej jeden system.</div>
            )}
          </div>

          {/* Features */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Funkcje do uwzględnienia
              <span className="ml-1 font-normal normal-case text-gray-400">(opcjonalnie — pomaga AI lepiej dobrać urządzenia)</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {SMART_FEATURES.map(f => {
                const active = features.includes(f.key)
                return (
                  <button
                    key={f.key}
                    onClick={() => toggleFeature(f.key)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-all ${
                      active ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-300 font-medium' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-300'
                    }`}
                  >
                    <span>{f.icon}</span><span>{f.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* File upload */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Pliki do analizy *</div>
            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl cursor-pointer transition-colors flex flex-col items-center justify-center gap-2 py-6 px-4 text-center ${
                dragging ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/10'
              }`}
            >
              <span className="text-3xl">{dragging ? '📂' : '🗺️'}</span>
              <div>
                <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {dragging ? 'Upuść pliki tutaj' : 'Wgraj rzuty — parter, piętro, lub dane Excel'}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">PDF, JPG, PNG, XLSX · wiele plików · max {MAX_MB} MB każdy</div>
              </div>
              <button
                type="button"
                className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium rounded-lg transition-colors"
                onClick={e => { e.stopPropagation(); inputRef.current?.click() }}
              >
                Wybierz pliki
              </button>
            </div>

            {files.length > 0 && (
              <div className="space-y-1">
                {files.map(f => (
                  <div key={f.name} className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-800/60 rounded-lg text-xs">
                    <span>{fileIcon(f.name)}</span>
                    <span className="flex-1 truncate text-gray-700 dark:text-gray-300">{f.name}</span>
                    <span className="text-gray-400 shrink-0">{fmtSize(f.size)}</span>
                    <button onClick={() => setFiles(prev => prev.filter(x => x.name !== f.name))} className="text-red-400 hover:text-red-600 font-bold">×</button>
                  </div>
                ))}
              </div>
            )}

            {step === 'error' && error && (
              <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
                <span>❌</span><span className="flex-1">{error}</span>
                <button onClick={() => setStep('config')} className="underline shrink-0">OK</button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 dark:border-gray-800 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
            Anuluj
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-6 py-2 text-sm font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white rounded-lg transition-colors flex items-center gap-2"
          >
            🤖 Stwórz projekt i analizuj AI
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls"
          className="hidden"
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
        />
      </div>
    </div>
  )
}
