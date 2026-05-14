import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { surveyApi } from '../api/client'
import type { ClientSurvey, ClientSurveyAttachment } from '../types'

// ── Types ──────────────────────────────────────────────────────────────────────

interface SurveyResponses {
  // Step 1
  building_type?: string
  is_new_build?: string
  area_m2?: string
  floors_count?: string
  rooms_count?: string
  location?: string
  completion_date?: string
  // Step 2
  systems?: string[]
  // Step 3
  control_preference?: string
  automation_level?: string
  priority_system?: string
  integration_existing?: string
  // Step 4
  budget_range?: string
  phasing?: string
  timeline_urgency?: string
  // Step 5
  dream_description?: string
  previous_experience?: string
  additional_notes?: string
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SYSTEMS = [
  { key: 'lighting', icon: '💡', title: 'Inteligentne oświetlenie', desc: 'Automatyczne sceny, harmonogramy, RGB, integracja z roletami' },
  { key: 'hvac', icon: '🌡️', title: 'Ogrzewanie i klimatyzacja', desc: 'Integracja z kotłem, klimą, podłogówką, rekuperacją' },
  { key: 'blinds', icon: '🪟', title: 'Rolety i żaluzje', desc: 'Automatyczne sterowanie, reagowanie na pogodę i słońce' },
  { key: 'alarm', icon: '🚨', title: 'System alarmowy', desc: 'Czujniki ruchu, dymu, zalania, CO, syreny' },
  { key: 'access', icon: '🔐', title: 'Kontrola dostępu', desc: 'Inteligentne zamki, wideodomofon, bramka wjazdowa' },
  { key: 'cctv', icon: '📷', title: 'Monitoring CCTV', desc: 'Kamery IP, nagrywanie ciągłe, podgląd zdalny 24/7' },
  { key: 'audio', icon: '🔊', title: 'Multiroom Audio', desc: 'Muzyka we wszystkich pomieszczeniach, sterowanie strefami' },
  { key: 'av', icon: '🎬', title: 'Home Cinema / AV', desc: 'Kino domowe, matryca AV, sterowanie projektorami' },
  { key: 'garden', icon: '🌿', title: 'Ogród i zewnętrze', desc: 'Nawadnianie, oświetlenie zewnętrzne, pergola elektryczna' },
  { key: 'ev', icon: '⚡', title: 'Ładowarka EV', desc: 'Inteligentna stacja ładowania samochodu elektrycznego' },
  { key: 'pv', icon: '☀️', title: 'Fotowoltaika / energia', desc: 'Integracja z PV, magazyn energii, zarządzanie mocą' },
  { key: 'voice', icon: '🎙️', title: 'Sterowanie głosowe', desc: 'Kompatybilność z Alexa, Google Assistant, Apple HomeKit' },
  { key: 'spa', icon: '🏊', title: 'Strefa SPA', desc: 'Automatyczne sterowanie basenem, jacuzzi i sauną — temperatura, filtracja, oświetlenie, harmonogramy, integracja z systemem Smart Home' },
  { key: 'ai_monitoring', icon: '🤖', title: 'AI Concierge', desc: 'Pełny monitoring z wielu kamer: rozpoznawanie obiektów, osób i sytuacji, wnioskowanie i bieżące douczanie lokalnego AI, które zna cały obszar otoczenia domu. Dane przechowywane wyłącznie lokalnie — dostęp tylko dla Ciebie.' },
]

const BUDGET_OPTIONS = [
  { value: 'do_20k', label: 'do 20 000 PLN', icon: '🌱' },
  { value: '20k_50k', label: '20 000–50 000 PLN', icon: '🏡' },
  { value: '50k_100k', label: '50 000–100 000 PLN', icon: '🏠' },
  { value: '100k_200k', label: '100 000–200 000 PLN', icon: '🏰' },
  { value: 'powyzej_200k', label: 'powyżej 200 000 PLN', icon: '🏯' },
  { value: 'nie_podaje', label: 'Wolę nie podawać', icon: '🔒' },
]

// ── Sub-components ─────────────────────────────────────────────────────────────

function RadioCard({ label, value, selected, onChange }: {
  label: string; value: string; selected: boolean; onChange: (v: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all text-sm font-medium ${
        selected
          ? 'border-violet-500 bg-violet-50 text-violet-700'
          : 'border-gray-200 bg-white text-gray-700 hover:border-violet-300 hover:bg-violet-50/30'
      }`}
    >
      <span className={`inline-block w-4 h-4 rounded-full border-2 mr-2 align-middle transition-colors ${
        selected ? 'border-violet-500 bg-violet-500' : 'border-gray-300'
      }`} />
      {label}
    </button>
  )
}

function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all ${
            i + 1 < step
              ? 'bg-violet-600 border-violet-600 text-white'
              : i + 1 === step
              ? 'bg-white border-violet-600 text-violet-600'
              : 'bg-white border-gray-300 text-gray-400'
          }`}>
            {i + 1 < step ? '✓' : i + 1}
          </div>
          {i < total - 1 && (
            <div className={`w-8 h-0.5 transition-colors ${i + 1 < step ? 'bg-violet-500' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Step 1 ─────────────────────────────────────────────────────────────────────

function Step1({ data, onChange }: { data: SurveyResponses; onChange: (d: Partial<SurveyResponses>) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">🏠 Twój dom</h2>
        <p className="text-gray-500 text-sm">Opowiedz nam o nieruchomości, którą chcesz wyposażyć</p>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Typ budynku</label>
        <div className="space-y-2">
          {['Dom wolnostojący', 'Dom szeregowy/bliźniak', 'Apartament/mieszkanie', 'Obiekt komercyjny/usługowy'].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.building_type === opt} onChange={v => onChange({ building_type: v })} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Stan budynku</label>
        <div className="space-y-2">
          {['Nowy budynek (w budowie)', 'Remont/modernizacja', 'Jeszcze nie zdecydowany(-a)'].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.is_new_build === opt} onChange={v => onChange({ is_new_build: v })} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Powierzchnia całkowita (m²)</label>
          <input
            type="number"
            min={0}
            value={data.area_m2 ?? ''}
            onChange={e => onChange({ area_m2: e.target.value })}
            placeholder="np. 180"
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Liczba kondygnacji</label>
          <input
            type="number"
            min={1}
            value={data.floors_count ?? ''}
            onChange={e => onChange({ floors_count: e.target.value })}
            placeholder="np. 2"
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Liczba pokoi / stref</label>
          <input
            type="number"
            min={1}
            value={data.rooms_count ?? ''}
            onChange={e => onChange({ rooms_count: e.target.value })}
            placeholder="np. 8"
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Miasto / region</label>
          <input
            type="text"
            value={data.location ?? ''}
            onChange={e => onChange({ location: e.target.value })}
            placeholder="np. Kraków"
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1">Planowany termin realizacji</label>
        <input
          type="text"
          value={data.completion_date ?? ''}
          onChange={e => onChange({ completion_date: e.target.value })}
          placeholder="np. jesień 2026, Q3 2026"
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
        />
      </div>
    </div>
  )
}

// ── Step 2 ─────────────────────────────────────────────────────────────────────

function Step2({ data, onChange }: { data: SurveyResponses; onChange: (d: Partial<SurveyResponses>) => void }) {
  const selected = data.systems ?? []

  const toggle = (key: string) => {
    if (selected.includes(key)) {
      onChange({ systems: selected.filter(s => s !== key) })
    } else {
      onChange({ systems: [...selected, key] })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">⚡ Systemy Smart Home</h2>
        <p className="text-gray-500 text-sm">Zaznacz wszystkie systemy, które Cię interesują</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SYSTEMS.map(s => {
          const active = selected.includes(s.key)
          const isAI = s.key === 'ai_monitoring'
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              className={`text-left p-4 rounded-xl border-2 transition-all ${isAI ? 'sm:col-span-2' : ''} ${
                active
                  ? isAI
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-violet-500 bg-violet-50'
                  : isAI
                    ? 'border-indigo-200 bg-gradient-to-r from-indigo-50/60 to-violet-50/60 hover:border-indigo-400'
                    : 'border-gray-200 bg-white hover:border-violet-300 hover:bg-violet-50/30'
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl">{s.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className={`text-sm font-semibold ${active ? (isAI ? 'text-indigo-700' : 'text-violet-700') : 'text-gray-800'}`}>
                      {s.title}
                    </span>
                    {isAI && (
                      <>
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">AI</span>
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">🔒 100% lokalnie</span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 leading-snug">{s.desc}</div>
                </div>
                <div className={`w-5 h-5 rounded flex items-center justify-center border-2 shrink-0 mt-0.5 transition-colors ${
                  active
                    ? isAI ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-violet-600 border-violet-600 text-white'
                    : 'border-gray-300'
                }`}>
                  {active && <svg viewBox="0 0 12 9" className="w-3 h-3 fill-none stroke-current stroke-2"><polyline points="1,4 4.5,7.5 11,1" /></svg>}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {selected.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-violet-600">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-violet-100 font-bold text-xs">{selected.length}</span>
          wybrane systemy
        </div>
      )}
    </div>
  )
}

// ── Step 3 ─────────────────────────────────────────────────────────────────────

function Step3({ data, onChange }: { data: SurveyResponses; onChange: (d: Partial<SurveyResponses>) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">🎛️ Preferencje</h2>
        <p className="text-gray-500 text-sm">Powiedz nam jak wolisz sterować swoim domem</p>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Preferowany sposób sterowania</label>
        <div className="space-y-2">
          {[
            'Głównie aplikacja mobilna',
            'Przyciski/panele ścienne',
            'Sterowanie głosowe',
            'Kombinacja wszystkich',
          ].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.control_preference === opt} onChange={v => onChange({ control_preference: v })} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Poziom automatyzacji</label>
        <div className="space-y-2">
          {[
            'Pełna automatyzacja (dom "myśli" za mnie)',
            'Częściowa (mam pełną kontrolę)',
            'Głównie zdalne sterowanie',
          ].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.automation_level === opt} onChange={v => onChange({ automation_level: v })} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Co jest dla Ciebie priorytetem?</label>
        <div className="space-y-2">
          {[
            'Bezpieczeństwo i ochrona',
            'Komfort i wygoda',
            'Oszczędność energii',
            'Prestiż i nowoczesność',
            'Wszystko jednakowo ważne',
          ].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.priority_system === opt} onChange={v => onChange({ priority_system: v })} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Czy masz już jakieś systemy?</label>
        <div className="space-y-2">
          {[
            'Nie, zaczynam od zera',
            'Mam już alarm',
            'Mam klimatyzację/ogrzewanie',
            'Mam kilka różnych systemów',
          ].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.integration_existing === opt} onChange={v => onChange({ integration_existing: v })} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Step 4 ─────────────────────────────────────────────────────────────────────

function Step4({ data, onChange }: { data: SurveyResponses; onChange: (d: Partial<SurveyResponses>) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">💰 Budżet i harmonogram</h2>
        <p className="text-gray-500 text-sm">Pomoże nam dostosować propozycję do Twoich możliwości</p>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-3">Szacowany budżet na Smart Home</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {BUDGET_OPTIONS.map(opt => {
            const active = data.budget_range === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ budget_range: opt.value })}
                className={`p-4 rounded-xl border-2 transition-all text-center ${
                  active
                    ? 'border-violet-500 bg-violet-50'
                    : 'border-gray-200 bg-white hover:border-violet-300 hover:bg-violet-50/30'
                }`}
              >
                <div className="text-2xl mb-1">{opt.icon}</div>
                <div className={`text-xs font-semibold ${active ? 'text-violet-700' : 'text-gray-700'}`}>{opt.label}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Podejście do realizacji</label>
        <div className="space-y-2">
          {[
            'Wszystko na raz (kompleksowo)',
            'Etapami — zaczniemy od priorytetów',
            'Tylko wybrane systemy na razie',
          ].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.phasing === opt} onChange={v => onChange({ phasing: v })} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Pilność realizacji</label>
        <div className="space-y-2">
          {[
            'Jak najszybciej (do 1 miesiąca)',
            'W ciągu 3 miesięcy',
            'Do 6 miesięcy',
            'Za rok lub więcej',
            'Dopiero zbieram informacje',
          ].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.timeline_urgency === opt} onChange={v => onChange({ timeline_urgency: v })} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Step 5 ─────────────────────────────────────────────────────────────────────

function Step5({
  data,
  onChange,
  token,
  attachments,
  onAttachmentAdded,
}: {
  data: SurveyResponses
  onChange: (d: Partial<SurveyResponses>) => void
  token: string
  attachments: ClientSurveyAttachment[]
  onAttachmentAdded: (a: ClientSurveyAttachment) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const ACCEPTED = '.pdf,.jpg,.jpeg,.png,.gif,.bmp,.webp,.dwg,.dxf'

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true)
    setUploadError('')
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const attachment = await surveyApi.publicAddAttachment(token, {
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_data: base64,
        file_size: file.size,
      })
      onAttachmentAdded(attachment)
    } catch {
      setUploadError('Błąd podczas przesyłania pliku. Spróbuj ponownie.')
    } finally {
      setUploading(false)
    }
  }, [token, onAttachmentAdded])

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    Array.from(files).forEach(uploadFile)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">📎 Szczegóły i plany</h2>
        <p className="text-gray-500 text-sm">Opisz swoje marzenia i dołącz dokumenty</p>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1">Opisz swój wymarzony inteligentny dom</label>
        <textarea
          value={data.dream_description ?? ''}
          onChange={e => onChange({ dream_description: e.target.value })}
          rows={5}
          placeholder="Np. Rano automatycznie otwierają się rolety, włącza kawa, łazienka jest już ciepła... Opisz jakie scenariusze i automacje chciałbyś(-abyś) mieć."
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 resize-none"
        />
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Twoje doświadczenie z Smart Home</label>
        <div className="space-y-2">
          {[
            'To będzie moje pierwsze doświadczenie',
            'Miałem(-am) prosty system (Philips Hue, Nest itp.)',
            'Mam doświadczenie z zaawansowanymi systemami',
          ].map(opt => (
            <RadioCard key={opt} label={opt} value={opt} selected={data.previous_experience === opt} onChange={v => onChange({ previous_experience: v })} />
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1">Dodatkowe uwagi, pytania, specjalne wymagania (opcjonalnie)</label>
        <textarea
          value={data.additional_notes ?? ''}
          onChange={e => onChange({ additional_notes: e.target.value })}
          rows={3}
          placeholder="Cokolwiek jeszcze chcesz nam przekazać..."
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 resize-none"
        />
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Dołącz plany / rysunki / zdjęcia</label>
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer ${
            dragging
              ? 'border-violet-400 bg-violet-50'
              : 'border-gray-300 bg-gray-50 hover:border-violet-300 hover:bg-violet-50/30'
          }`}
          onClick={() => fileRef.current?.click()}
        >
          <div className="text-3xl mb-2">📁</div>
          <p className="text-sm text-gray-600 font-medium">Przeciągnij pliki tutaj lub kliknij, aby wybrać</p>
          <p className="text-xs text-gray-400 mt-1">PDF, JPG, PNG, DWG, DXF — każdy plik do 50 MB</p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPTED}
            className="hidden"
            onChange={e => handleFiles(e.target.files)}
          />
        </div>

        {uploading && (
          <div className="mt-2 flex items-center gap-2 text-sm text-violet-600">
            <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
            Przesyłanie pliku...
          </div>
        )}

        {uploadError && (
          <p className="mt-2 text-sm text-red-500">{uploadError}</p>
        )}

        {attachments.length > 0 && (
          <ul className="mt-3 space-y-2">
            {attachments.map(a => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2.5 bg-white border border-gray-200 rounded-xl">
                <span className="text-lg">
                  {a.mime_type.startsWith('image/') ? '🖼️' : a.file_name.endsWith('.pdf') ? '📄' : '📎'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{a.file_name}</p>
                  <p className="text-xs text-gray-400">{formatBytes(a.file_size)}</p>
                </div>
                <span className="text-green-500 text-sm">✓ Przesłano</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Main SurveyPage ────────────────────────────────────────────────────────────

type PageState = 'loading' | 'not_found' | 'error' | 'already_submitted' | 'form' | 'submitted'

const STEP_LABELS = [
  'Twój dom',
  'Systemy',
  'Preferencje',
  'Budżet',
  'Szczegóły',
]

export default function SurveyPage() {
  const { token } = useParams<{ token: string }>()
  const [pageState, setPageState] = useState<PageState>('loading')
  const [survey, setSurvey] = useState<ClientSurvey | null>(null)
  const [projectName, setProjectName] = useState('')
  const [step, setStep] = useState(1)
  const [responses, setResponses] = useState<SurveyResponses>({})
  const [attachments, setAttachments] = useState<ClientSurveyAttachment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    if (!token) { setPageState('not_found'); return }
    surveyApi.publicGet(token)
      .then(({ survey: s, project_name }) => {
        setSurvey(s)
        setProjectName(project_name)
        setAttachments(s.attachments ?? [])
        if (s.status === 'submitted') {
          setPageState('already_submitted')
        } else {
          setPageState('form')
        }
      })
      .catch((err: any) => {
        const status = err?.response?.status
        setPageState(status === 404 ? 'not_found' : 'error')
      })
  }, [token])

  const updateResponses = (patch: Partial<SurveyResponses>) => {
    setResponses(prev => ({ ...prev, ...patch }))
  }

  const handleNext = () => {
    if (step < 5) setStep(s => s + 1)
  }

  const handlePrev = () => {
    if (step > 1) setStep(s => s - 1)
  }

  const handleSubmit = async () => {
    if (!token) return
    setSubmitting(true)
    setSubmitError('')
    try {
      await surveyApi.publicSubmit(token, responses)
      setPageState('submitted')
    } catch {
      setSubmitError('Wystąpił błąd podczas wysyłania ankiety. Spróbuj ponownie.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-violet-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Ładowanie ankiety...</p>
        </div>
      </div>
    )
  }

  // ── Not found ────────────────────────────────────────────────────────────────
  if (pageState === 'not_found') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="text-6xl mb-4">🔍</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Ankieta nie znaleziona</h1>
          <p className="text-gray-500">Link do ankiety jest nieprawidłowy lub wygasł. Skontaktuj się z firmą, która przesłała Ci tę ankietę.</p>
        </div>
      </div>
    )
  }

  // ── Server error ─────────────────────────────────────────────────────────────
  if (pageState === 'error') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="text-6xl mb-4">⚠️</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Błąd połączenia</h1>
          <p className="text-gray-500 mb-4">Nie udało się załadować ankiety. Odśwież stronę lub spróbuj ponownie za chwilę.</p>
          <button
            onClick={() => { setPageState('loading'); window.location.reload() }}
            className="bg-violet-600 text-white px-6 py-2 rounded-xl font-semibold hover:bg-violet-700 transition-colors"
          >
            Odśwież stronę
          </button>
        </div>
      </div>
    )
  }

  // ── Already submitted ────────────────────────────────────────────────────────
  if (pageState === 'already_submitted') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="text-6xl mb-4">✅</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Ankieta została już wypełniona</h1>
          <p className="text-gray-500 mb-4">
            Dziękujemy! Twoja ankieta została już przesłana{survey?.submitted_at ? ` ${new Date(survey.submitted_at).toLocaleDateString('pl-PL')}` : ''}.
            Skontaktujemy się z Tobą wkrótce.
          </p>
          {projectName && (
            <div className="text-sm text-violet-600 font-medium">{projectName}</div>
          )}
        </div>
      </div>
    )
  }

  // ── Submitted (thank you) ────────────────────────────────────────────────────
  if (pageState === 'submitted') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
            <svg viewBox="0 0 24 24" className="w-10 h-10 text-green-500 fill-none stroke-current stroke-2">
              <polyline points="20,6 9,17 4,12" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-800 mb-3">Dziękujemy za wypełnienie ankiety!</h1>
          <p className="text-gray-500 mb-4">
            Twoje odpowiedzi zostały przesłane. Nasz zespół przeanalizuje Twoje potrzeby i skontaktuje się z Tobą w&nbsp;celu omówienia propozycji.
          </p>
          {projectName && (
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-violet-50 text-violet-700 text-sm font-medium">
              🏠 {projectName}
            </div>
          )}
          <div className="mt-6 p-4 bg-gray-50 rounded-xl text-left">
            <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide mb-2">Co dalej?</p>
            <ul className="text-sm text-gray-600 space-y-1.5">
              <li>📞 Skontaktujemy się z Tobą telefonicznie lub mailowo</li>
              <li>📋 Przygotujemy spersonalizowaną ofertę</li>
              <li>🏠 Umówimy wizję lokalną (jeśli potrzebna)</li>
            </ul>
          </div>
        </div>
      </div>
    )
  }

  // ── Form ─────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-violet-700 to-violet-500 text-white px-4 py-6">
        <div className="max-w-2xl mx-auto text-center">
          {projectName && (
            <p className="text-violet-200 text-sm font-medium mb-1">{projectName}</p>
          )}
          <h1 className="text-2xl font-bold">Ankieta Smart Home</h1>
          {survey?.client_name && (
            <p className="text-violet-200 text-sm mt-1">Witaj, {survey.client_name}! Wypełnienie zajmie ok. 5 minut.</p>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="bg-white shadow-sm">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
            <span className="font-medium text-violet-600">Krok {step} z {STEP_LABELS.length}: {STEP_LABELS[step - 1]}</span>
            <span>{Math.round((step / STEP_LABELS.length) * 100)}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-violet-500 to-violet-600 rounded-full transition-all duration-500"
              style={{ width: `${(step / STEP_LABELS.length) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Form content */}
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-8">
          <StepIndicator step={step} total={STEP_LABELS.length} />

          {step === 1 && <Step1 data={responses} onChange={updateResponses} />}
          {step === 2 && <Step2 data={responses} onChange={updateResponses} />}
          {step === 3 && <Step3 data={responses} onChange={updateResponses} />}
          {step === 4 && <Step4 data={responses} onChange={updateResponses} />}
          {step === 5 && (
            <Step5
              data={responses}
              onChange={updateResponses}
              token={token!}
              attachments={attachments}
              onAttachmentAdded={a => setAttachments(prev => [...prev, a])}
            />
          )}

          {submitError && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {submitError}
            </div>
          )}

          {/* Navigation buttons */}
          <div className="flex items-center justify-between mt-8 pt-6 border-t border-gray-100">
            <button
              type="button"
              onClick={handlePrev}
              disabled={step === 1}
              className="px-5 py-2.5 text-sm font-medium text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              ← Poprzedni
            </button>

            {step < 5 ? (
              <button
                type="button"
                onClick={handleNext}
                className="px-6 py-2.5 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-xl transition-colors"
              >
                Następny →
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="px-6 py-2.5 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-xl disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {submitting && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                {submitting ? 'Wysyłanie...' : '✓ Wyślij ankietę'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
