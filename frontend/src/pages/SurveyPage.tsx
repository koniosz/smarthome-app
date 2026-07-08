import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { surveyApi } from '../api/client'
import type { ClientSurvey, ClientSurveyAttachment } from '../types'
import { SURVEY_CATEGORIES } from '../surveySpec'

// ── Ankieta Smart Home — specyfikacja v4 ────────────────────────────────────────
// 4 kroki: 1) Twój dom, 2) Wybór systemów (akordeony, 5 kategorii),
// 3) pytania dedykowane TYLKO dla zaznaczonych systemów, 4) priorytety (bez budżetu).
// Wartości wyborów zapisujemy jako polskie etykiety, liczby jako number (suwak/select).

interface SurveyResponses {
  // Krok 1
  building_type?: string
  building_state?: string
  area_m2?: string
  floors_count?: string
  rooms_count?: string
  location?: string
  completion_date?: string
  // Krok 2
  systems?: string[]
  // Krok 3 — szczegóły per system
  details?: Record<string, Record<string, any>>
  // Krok 4
  control_methods?: string[]
  automation_level?: string
  existing_systems?: string
  priorities?: string[]
  phasing?: string
  timeline_urgency?: string
  project_description?: string
}

// ── Komponenty pól ──────────────────────────────────────────────────────────────

function RadioCard({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect}
      className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all text-sm font-medium ${
        selected ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200 bg-white text-gray-700 hover:border-violet-300 hover:bg-violet-50/30'
      }`}>
      <span className={`inline-block w-4 h-4 rounded-full border-2 mr-2 align-middle transition-colors ${selected ? 'border-violet-500 bg-violet-500' : 'border-gray-300'}`} />
      {label}
    </button>
  )
}

function CheckCard({ label, selected, onToggle }: { label: string; selected: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all text-sm font-medium ${
        selected ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200 bg-white text-gray-700 hover:border-violet-300 hover:bg-violet-50/30'
      }`}>
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded border-2 mr-2 align-middle text-[10px] text-white transition-colors ${selected ? 'border-violet-500 bg-violet-500' : 'border-gray-300 bg-white'}`}>{selected ? '✓' : ''}</span>
      {label}
    </button>
  )
}

function YesNo({ value, onChange }: { value?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex gap-2">
      {[{ v: true, l: 'Tak' }, { v: false, l: 'Nie' }].map(o => (
        <button key={String(o.v)} type="button" onClick={() => onChange(o.v)}
          className={`px-5 py-2 rounded-xl border-2 text-sm font-semibold transition-all ${
            value === o.v ? (o.v ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-400 bg-gray-100 text-gray-700') : 'border-gray-200 bg-white text-gray-500 hover:border-violet-300'
          }`}>
          {o.l}
        </button>
      ))}
    </div>
  )
}

function NumSlider({ label, value, min, max, unit, onChange }: {
  label: string; value?: number; min: number; max: number; unit?: string; onChange: (v: number) => void
}) {
  const v = value ?? min
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-semibold text-gray-700">{label}</label>
        <span className="text-sm font-bold text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-2.5 py-0.5 tabular-nums">
          {v}{v === max ? '+' : ''}{unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input type="range" min={min} max={max} step={1} value={v}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-violet-600" />
      <div className="flex justify-between text-[11px] text-gray-400"><span>{min}</span><span>{max}+</span></div>
    </div>
  )
}

function Q({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-2">{label}</label>
      {children}
    </div>
  )
}

function MultiRow({ options, values, onToggle }: { options: string[]; values: string[]; onToggle: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(o => (
        <button key={o} type="button" onClick={() => onToggle(o)}
          className={`px-3.5 py-2 rounded-xl border-2 text-sm font-medium transition-all ${
            values.includes(o) ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200 bg-white text-gray-600 hover:border-violet-300'
          }`}>
          {values.includes(o) ? '✓ ' : ''}{o}
        </button>
      ))}
    </div>
  )
}

function SingleRow({ options, value, onChange }: { options: string[]; value?: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(o => (
        <button key={o} type="button" onClick={() => onChange(o)}
          className={`px-3.5 py-2 rounded-xl border-2 text-sm font-medium transition-all ${
            value === o ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-gray-200 bg-white text-gray-600 hover:border-violet-300'
          }`}>
          {o}
        </button>
      ))}
    </div>
  )
}

function StepIndicator({ step, total, labels }: { step: number; total: number; labels: string[] }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center">
          <div className="flex flex-col items-center">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all ${
              i + 1 < step ? 'bg-violet-600 border-violet-600 text-white' : i + 1 === step ? 'bg-white border-violet-600 text-violet-600' : 'bg-white border-gray-300 text-gray-400'
            }`}>
              {i + 1 < step ? '✓' : i + 1}
            </div>
            <span className={`text-[10px] mt-1 hidden sm:block ${i + 1 === step ? 'text-violet-700 font-semibold' : 'text-gray-400'}`}>{labels[i]}</span>
          </div>
          {i < total - 1 && <div className={`w-8 h-0.5 mb-4 transition-colors ${i + 1 < step ? 'bg-violet-500' : 'bg-gray-200'}`} />}
        </div>
      ))}
    </div>
  )
}

// ── Krok 1 — Twój dom ───────────────────────────────────────────────────────────

function Step1({ data, onChange }: { data: SurveyResponses; onChange: (d: Partial<SurveyResponses>) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">🏠 Twój dom</h2>
        <p className="text-gray-500 text-sm">Podstawowe informacje o nieruchomości</p>
      </div>

      <Q label="Typ budynku">
        <div className="grid sm:grid-cols-2 gap-2">
          {['Dom wolnostojący', 'Dom szeregowy / bliźniak', 'Apartament / mieszkanie', 'Obiekt komercyjny / usługowy'].map(o => (
            <RadioCard key={o} label={o} selected={data.building_type === o} onSelect={() => onChange({ building_type: o })} />
          ))}
        </div>
      </Q>

      <Q label="Stan budynku">
        <div className="grid sm:grid-cols-3 gap-2">
          {['Nowy budynek (w budowie)', 'Remont / modernizacja', 'Jeszcze nie zdecydowany(-a)'].map(o => (
            <RadioCard key={o} label={o} selected={data.building_state === o} onSelect={() => onChange({ building_state: o })} />
          ))}
        </div>
      </Q>

      <div className="grid sm:grid-cols-3 gap-4">
        <Q label="Powierzchnia całkowita (m²)">
          <input type="number" min="0" inputMode="numeric" value={data.area_m2 ?? ''}
            onChange={e => onChange({ area_m2: e.target.value })}
            placeholder="np. 180"
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
        </Q>
        <Q label="Liczba kondygnacji">
          <select value={data.floors_count ?? ''} onChange={e => onChange({ floors_count: e.target.value })}
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-white focus:outline-none focus:border-violet-400">
            <option value="">— wybierz —</option>
            {['1', '2', '3', '4', '5+'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Q>
        <Q label="Liczba pokoi / stref">
          <select value={data.rooms_count ?? ''} onChange={e => onChange({ rooms_count: e.target.value })}
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm bg-white focus:outline-none focus:border-violet-400">
            <option value="">— wybierz —</option>
            {[...Array.from({ length: 15 }, (_, i) => String(i + 1)), '16–20', '20+'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Q>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Q label="Miasto / region">
          <input type="text" value={data.location ?? ''} onChange={e => onChange({ location: e.target.value })}
            placeholder="np. Warszawa i okolice"
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
        </Q>
        <Q label="Planowany termin realizacji">
          <input type="text" value={data.completion_date ?? ''} onChange={e => onChange({ completion_date: e.target.value })}
            placeholder="np. „jesień 2026”, „Q3 2026”"
            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
        </Q>
      </div>
    </div>
  )
}

// ── Krok 2 — Wybór systemów (akordeony) ─────────────────────────────────────────

function Step2({ data, onChange }: { data: SurveyResponses; onChange: (d: Partial<SurveyResponses>) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ komfort: true })
  const systems = data.systems ?? []
  const toggle = (key: string) => {
    onChange({ systems: systems.includes(key) ? systems.filter(s => s !== key) : [...systems, key] })
  }
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">⚡ Wybór systemów</h2>
        <p className="text-gray-500 text-sm">Zaznacz systemy smart home, którymi jesteś zainteresowany(-a) — możesz wybrać wiele</p>
      </div>

      {SURVEY_CATEGORIES.map(cat => {
        const selectedCount = cat.systems.filter(s => systems.includes(s.key)).length
        const isOpen = !!open[cat.key]
        return (
          <div key={cat.key} className="border-2 border-gray-200 rounded-2xl overflow-hidden">
            <button type="button" onClick={() => setOpen(p => ({ ...p, [cat.key]: !isOpen }))}
              className="w-full flex items-center justify-between px-4 py-3.5 bg-gray-50 hover:bg-violet-50/50 transition-colors">
              <span className="text-sm font-bold text-gray-800">{cat.icon} {cat.title}</span>
              <span className="flex items-center gap-2">
                {selectedCount > 0 && <span className="text-xs font-bold text-white bg-violet-600 rounded-full px-2 py-0.5">{selectedCount}</span>}
                <span className="text-gray-400 text-sm">{isOpen ? '▲' : '▼'}</span>
              </span>
            </button>
            {isOpen && (
              <div className="p-3 grid sm:grid-cols-2 gap-2 bg-white">
                {cat.systems.map(s => (
                  <CheckCard key={s.key} label={`${s.icon} ${s.label}`} selected={systems.includes(s.key)} onToggle={() => toggle(s.key)} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Krok 3 — Pytania dedykowane (warunkowe) ─────────────────────────────────────

function SystemSection({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="border-2 border-violet-100 rounded-2xl p-4 sm:p-5 space-y-4 bg-violet-50/30">
      <h3 className="text-base font-bold text-gray-800">{icon} {title}</h3>
      {children}
    </div>
  )
}

function ProjectQuestion({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  return (
    <Q label="Projekt systemu">
      <div className="grid sm:grid-cols-2 gap-2">
        {['Mam przygotowany projekt', 'Proszę o wykonanie projektu'].map(o => (
          <RadioCard key={o} label={o} selected={value === o} onSelect={() => onChange(o)} />
        ))}
      </div>
    </Q>
  )
}

function Step3({ data, onChange }: { data: SurveyResponses; onChange: (d: Partial<SurveyResponses>) => void }) {
  const systems = data.systems ?? []
  const details = data.details ?? {}
  const d = (sys: string) => details[sys] ?? {}
  const set = (sys: string, patch: Record<string, any>) =>
    onChange({ details: { ...details, [sys]: { ...d(sys), ...patch } } })
  const toggleIn = (sys: string, field: string, val: string) => {
    const cur: string[] = Array.isArray(d(sys)[field]) ? d(sys)[field] : []
    set(sys, { [field]: cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val] })
  }

  if (systems.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-5xl mb-3">🤷</div>
        <p className="text-gray-500">Nie wybrano żadnych systemów w poprzednim kroku — możesz wrócić i zaznaczyć interesujące Cię systemy, albo przejść dalej.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">🔧 Doprecyzujmy szczegóły</h2>
        <p className="text-gray-500 text-sm">Kilka pytań o systemy, które Cię interesują</p>
      </div>

      {systems.includes('lighting') && (
        <SystemSection icon="💡" title="Oświetlenie">
          <Q label="Rodzaj sterowania (możesz wybrać kilka)">
            <MultiRow options={['on/off', 'ściemnianie (dimming)', 'RGB', 'RGBW', 'zmienna temperatura barwowa (CCT)']}
              values={d('lighting').control_types ?? []} onToggle={v => toggleIn('lighting', 'control_types', v)} />
          </Q>
          <NumSlider label="Orientacyjna liczba obwodów/stref oświetleniowych" min={1} max={60}
            value={d('lighting').circuits_count} onChange={v => set('lighting', { circuits_count: v })} />
          <Q label="Automatyczne ustawianie światła na podstawie słońca i warunków zewnętrznych">
            <YesNo value={d('lighting').daylight_automation} onChange={v => set('lighting', { daylight_automation: v })} />
          </Q>
        </SystemSection>
      )}

      {systems.includes('heating') && (
        <SystemSection icon="🔥" title="Ogrzewanie">
          <Q label="Typ instalacji (możesz wybrać kilka)">
            <MultiRow options={['podłogówka', 'grzejniki', 'klimakonwektory']}
              values={d('heating').install_types ?? []} onToggle={v => toggleIn('heating', 'install_types', v)} />
          </Q>
          <Q label="Źródło ciepła">
            <SingleRow options={['pompa ciepła', 'gaz', 'piec na paliwo stałe', 'elektryczne', 'jeszcze nie zdecydowano']}
              value={d('heating').heat_source} onChange={v => set('heating', { heat_source: v })} />
          </Q>
          <NumSlider label="Orientacyjna liczba stref grzewczych (np. per pomieszczenie)" min={1} max={20}
            value={d('heating').zones_count} onChange={v => set('heating', { zones_count: v })} />
        </SystemSection>
      )}

      {systems.includes('cooling') && (
        <SystemSection icon="❄️" title="Klimatyzacja">
          <Q label="Typ">
            <SingleRow options={['klimakonwektory', 'klimatyzatory']}
              value={d('cooling').unit_type} onChange={v => set('cooling', { unit_type: v })} />
          </Q>
          <NumSlider label="Liczba pomieszczeń do klimatyzacji" min={1} max={15}
            value={d('cooling').rooms_count} onChange={v => set('cooling', { rooms_count: v })} />
          <Q label="Model/producent (opcjonalnie — jeśli już wiesz, jakie urządzenia chcesz)">
            <input type="text" value={d('cooling').brand ?? ''} onChange={e => set('cooling', { brand: e.target.value })}
              placeholder="np. Daikin, Mitsubishi…"
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400" />
          </Q>
        </SystemSection>
      )}

      {systems.includes('ventilation') && (
        <SystemSection icon="🌬️" title="Rekuperacja / wentylacja">
          <Q label="Czujniki jakości powietrza (CO₂, wilgotność)">
            <YesNo value={d('ventilation').air_quality_sensors} onChange={v => set('ventilation', { air_quality_sensors: v })} />
          </Q>
          <Q label="Automatyczne sterowanie na podstawie czujników">
            <YesNo value={d('ventilation').auto_control} onChange={v => set('ventilation', { auto_control: v })} />
          </Q>
        </SystemSection>
      )}

      {systems.includes('blinds') && (
        <SystemSection icon="🪟" title="Rolety / żaluzje / markizy">
          <Q label="Typ (możesz wybrać kilka)">
            <MultiRow options={['rolety zewnętrzne', 'żaluzje fasadowe', 'markizy', 'zasłony', 'rolety wewnętrzne dzień-noc']}
              values={d('blinds').types ?? []} onToggle={v => toggleIn('blinds', 'types', v)} />
          </Q>
          <NumSlider label="Orientacyjna liczba okien/otworów do zautomatyzowania" min={1} max={40}
            value={d('blinds').openings_count} onChange={v => set('blinds', { openings_count: v })} />
          <Q label="Czujniki wiatru/słońca do automatycznego chowania">
            <YesNo value={d('blinds').weather_sensors} onChange={v => set('blinds', { weather_sensors: v })} />
          </Q>
        </SystemSection>
      )}

      {systems.includes('pergola') && (
        <SystemSection icon="⛱️" title="Pergole / zadaszenia tarasowe">
          <Q label="Typ (możesz wybrać kilka)">
            <MultiRow options={['pergola bioklimatyczna', 'pergola tarasowa', 'markiza tarasowa']}
              values={d('pergola').types ?? []} onToggle={v => toggleIn('pergola', 'types', v)} />
          </Q>
          <Q label="Orientacyjna liczba sztuk i wymiary (jeśli znane)">
            <input type="text" value={d('pergola').count_dimensions ?? ''} onChange={e => set('pergola', { count_dimensions: e.target.value })}
              placeholder="np. 1 szt., 4×6 m"
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400" />
          </Q>
          <Q label="Czujnik deszczu/wiatru">
            <YesNo value={d('pergola').rain_wind_sensor} onChange={v => set('pergola', { rain_wind_sensor: v })} />
          </Q>
          <Q label="Integracja z oświetleniem lub ogrzewaniem zewnętrznym (grzejniki tarasowe)">
            <YesNo value={d('pergola').heat_light_integration} onChange={v => set('pergola', { heat_light_integration: v })} />
          </Q>
        </SystemSection>
      )}

      {systems.includes('alarm') && (
        <SystemSection icon="🚨" title="System alarmowy">
          <ProjectQuestion value={d('alarm').project} onChange={v => set('alarm', { project: v })} />
        </SystemSection>
      )}

      {systems.includes('gates') && (
        <SystemSection icon="🚪" title="Bramy">
          <Q label="Brama garażowa"><YesNo value={d('gates').garage} onChange={v => set('gates', { garage: v })} /></Q>
          <Q label="Brama wjazdowa"><YesNo value={d('gates').entry} onChange={v => set('gates', { entry: v })} /></Q>
        </SystemSection>
      )}

      {systems.includes('intercom') && (
        <SystemSection icon="📞" title="Wideodomofon">
          <NumSlider label="Liczba paneli zewnętrznych (przy furtce, bramie, drzwiach)" min={1} max={5}
            value={d('intercom').panels_count} onChange={v => set('intercom', { panels_count: v })} />
          <NumSlider label="Liczba monitorów/odbiorników wewnętrznych" min={1} max={8}
            value={d('intercom').monitors_count} onChange={v => set('intercom', { monitors_count: v })} />
          <Q label="Integracja z telefonem (odbieranie zdalne)">
            <YesNo value={d('intercom').phone_integration} onChange={v => set('intercom', { phone_integration: v })} />
          </Q>
          <Q label="Integracja z zamkiem/bramą (otwieranie z panelu)">
            <YesNo value={d('intercom').lock_integration} onChange={v => set('intercom', { lock_integration: v })} />
          </Q>
        </SystemSection>
      )}

      {systems.includes('cctv') && (
        <SystemSection icon="📷" title="Monitoring CCTV">
          <ProjectQuestion value={d('cctv').project} onChange={v => set('cctv', { project: v })} />
        </SystemSection>
      )}

      {systems.includes('network') && (
        <SystemSection icon="🌐" title="Sieć i WiFi">
          <ProjectQuestion value={d('network').project} onChange={v => set('network', { project: v })} />
        </SystemSection>
      )}

      {systems.includes('audio') && (
        <SystemSection icon="🔊" title="Multiroom Audio">
          <NumSlider label="Orientacyjna liczba stref audio (pomieszczeń)" min={1} max={12}
            value={d('audio').zones_count} onChange={v => set('audio', { zones_count: v })} />
          <Q label="Główne źródła (możesz wybrać kilka)">
            <MultiRow options={['streaming (Spotify/Tidal)', 'TV', 'radio', 'winyl', 'inne']}
              values={d('audio').sources ?? []} onToggle={v => toggleIn('audio', 'sources', v)} />
          </Q>
          <Q label="Integracja z centralnym systemem sterowania">
            <YesNo value={d('audio').central_integration} onChange={v => set('audio', { central_integration: v })} />
          </Q>
        </SystemSection>
      )}

      {systems.includes('av') && (
        <SystemSection icon="🎬" title="Kino domowe / AV">
          <Q label="Dedykowane pomieszczenie kina czy zabudowa w salonie">
            <SingleRow options={['dedykowane pomieszczenie kina', 'zabudowa w salonie']}
              value={d('av').room_type} onChange={v => set('av', { room_type: v })} />
          </Q>
          <Q label="Wybór wyświetlacza">
            <SingleRow options={['TV', 'Projektor']} value={d('av').display} onChange={v => set('av', { display: v })} />
          </Q>
          <Q label="Konfiguracja audio">
            <SingleRow options={['5.1', '7.1', 'z Atmos', 'jeszcze nie wiem']}
              value={d('av').audio_config} onChange={v => set('av', { audio_config: v })} />
          </Q>
          <Q label="Sterowanie jednym uniwersalnym pilotem/panelem">
            <YesNo value={d('av').universal_remote} onChange={v => set('av', { universal_remote: v })} />
          </Q>
        </SystemSection>
      )}

      {systems.includes('garden') && (
        <SystemSection icon="🌳" title="Instalacje ogrodowe">
          <Q label="Oświetlenie ogrodowe"><YesNo value={d('garden').garden_lighting} onChange={v => set('garden', { garden_lighting: v })} /></Q>
          <Q label="Podlewanie/nawadnianie — integracja ze smart home">
            <YesNo value={d('garden').irrigation} onChange={v => set('garden', { irrigation: v })} />
          </Q>
          {d('garden').irrigation === true && (
            <Q label="Jaki sterownik/producent nawadniania?">
              <input type="text" value={d('garden').irrigation_brand ?? ''} onChange={e => set('garden', { irrigation_brand: e.target.value })}
                placeholder="np. Hunter, Rain Bird…"
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400" />
            </Q>
          )}
        </SystemSection>
      )}

      {systems.includes('pv') && (
        <SystemSection icon="☀️" title="Fotowoltaika i zarządzanie energią">
          <Q label="Integracja z systemem smart home"><YesNo value={d('pv').smart_integration} onChange={v => set('pv', { smart_integration: v })} /></Q>
          <Q label="Podgląd wykresów produkcji/zużycia energii"><YesNo value={d('pv').energy_charts} onChange={v => set('pv', { energy_charts: v })} /></Q>
        </SystemSection>
      )}

      {systems.includes('ev') && (
        <SystemSection icon="🔌" title="Ładowarka EV">
          <Q label="Integracja z systemem smart home"><YesNo value={d('ev').smart_integration} onChange={v => set('ev', { smart_integration: v })} /></Q>
          <Q label="Podgląd wykresów produkcji/zużycia energii"><YesNo value={d('ev').energy_charts} onChange={v => set('ev', { energy_charts: v })} /></Q>
        </SystemSection>
      )}

      {systems.includes('spa') && (
        <SystemSection icon="🏊" title="Basen / SPA / sauna">
          <Q label="Rodzaj (możesz wybrać kilka)">
            <MultiRow options={['basen zewnętrzny', 'basen wewnętrzny', 'jacuzzi', 'sauna']}
              values={d('spa').types ?? []} onToggle={v => toggleIn('spa', 'types', v)} />
          </Q>
          <Q label="Zakres automatyzacji (możesz wybrać kilka)">
            <MultiRow options={['temperatura', 'filtracja', 'oświetlenie', 'harmonogram']}
              values={d('spa').automation ?? []} onToggle={v => toggleIn('spa', 'automation', v)} />
          </Q>
        </SystemSection>
      )}
    </div>
  )
}

// ── Krok 4 — Priorytety i oczekiwania ──────────────────────────────────────────

function Step4({ data, onChange, token, attachments, onAttachmentAdded }: {
  data: SurveyResponses
  onChange: (d: Partial<SurveyResponses>) => void
  token: string
  attachments: ClientSurveyAttachment[]
  onAttachmentAdded: (a: ClientSurveyAttachment) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const toggleMulti = (field: 'control_methods' | 'priorities', val: string) => {
    const cur = data[field] ?? []
    onChange({ [field]: cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val] } as any)
  }

  const uploadFile = useCallback(async (file: File) => {
    const MAX_UPLOAD_MB = 35 // limit backendu: 50mb JSON, base64 dodaje ~33% narzutu
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setUploadError(`Plik jest za duży (${(file.size / 1024 / 1024).toFixed(1)} MB). Maksymalny rozmiar to ${MAX_UPLOAD_MB} MB.`)
      return
    }
    setUploading(true); setUploadError('')
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const attachment = await surveyApi.publicAddAttachment(token, {
        file_name: file.name, mime_type: file.type || 'application/octet-stream',
        file_data: base64, file_size: file.size,
      })
      onAttachmentAdded(attachment)
    } catch { setUploadError('Błąd podczas przesyłania pliku. Spróbuj ponownie.') }
    finally { setUploading(false) }
  }, [token, onAttachmentAdded])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">🎯 Priorytety i oczekiwania</h2>
        <p className="text-gray-500 text-sm">Ostatni krok — powiedz nam, na czym Ci zależy</p>
      </div>

      <Q label="Preferowany sposób sterowania (możesz wybrać kilka)">
        <MultiRow options={['aplikacja mobilna', 'panele ścienne', 'sterowanie głosowe']}
          values={data.control_methods ?? []} onToggle={v => toggleMulti('control_methods', v)} />
      </Q>

      <Q label="Poziom automatyzacji">
        <div className="space-y-2">
          {['pełna automatyzacja (dom „myśli” za mnie)', 'częściowa (mam pełną kontrolę)', 'głównie zdalne sterowanie'].map(o => (
            <RadioCard key={o} label={o} selected={data.automation_level === o} onSelect={() => onChange({ automation_level: o })} />
          ))}
        </div>
      </Q>

      <Q label="Czy masz już jakieś systemy smart home?">
        <div className="space-y-2">
          {['nie, zaczynam od zera', 'mam już alarm', 'mam klimatyzację / ogrzewanie', 'mam kilka różnych systemów'].map(o => (
            <RadioCard key={o} label={o} selected={data.existing_systems === o} onSelect={() => onChange({ existing_systems: o })} />
          ))}
        </div>
      </Q>

      <Q label="Na czym najbardziej Ci zależy? (możesz wybrać kilka)">
        <MultiRow options={['bezpieczeństwo i ochrona', 'komfort i wygoda codzienna', 'oszczędność energii', 'nowoczesny wygląd i prestiż', 'prostota obsługi', 'możliwość rozbudowy w przyszłości']}
          values={data.priorities ?? []} onToggle={v => toggleMulti('priorities', v)} />
      </Q>

      <Q label="Podejście do realizacji">
        <div className="space-y-2">
          {['wszystko na raz (kompleksowo)', 'etapami — zaczynamy od priorytetów', 'tylko wybrane systemy na razie'].map(o => (
            <RadioCard key={o} label={o} selected={data.phasing === o} onSelect={() => onChange({ phasing: o })} />
          ))}
        </div>
      </Q>

      <Q label="Pilność realizacji">
        <div className="space-y-2">
          {['jak najszybciej (do 1 miesiąca)', 'w ciągu 3 miesięcy', 'do 6 miesięcy', 'za rok lub więcej', 'dopiero zbieram informacje'].map(o => (
            <RadioCard key={o} label={o} selected={data.timeline_urgency === o} onSelect={() => onChange({ timeline_urgency: o })} />
          ))}
        </div>
      </Q>

      <Q label="Opisz swój projekt — wizja, oczekiwania, szczególne wymagania, inspiracje">
        <textarea value={data.project_description ?? ''} onChange={e => onChange({ project_description: e.target.value })}
          rows={5}
          placeholder="Np. Rano automatycznie otwierają się rolety, dom wita ciepłym światłem… Opisz własnymi słowami, jak ma działać Twój smart home."
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 resize-none" />
      </Q>

      {/* Załączniki — rzuty/plany pomagają przygotować dokładniejszą wycenę */}
      <div className="border-2 border-dashed border-gray-200 rounded-2xl p-4">
        <label className="block text-sm font-semibold text-gray-700 mb-1">📎 Rzuty / plany budynku (opcjonalnie)</label>
        <p className="text-xs text-gray-400 mb-3">PDF, JPG, PNG, DWG — pomogą nam przygotować dokładniejszą wycenę</p>
        <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.gif,.bmp,.webp,.dwg,.dxf" multiple className="hidden"
          onChange={e => { const fs = e.target.files; if (fs) Array.from(fs).forEach(uploadFile) }} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
          className="px-4 py-2 rounded-xl border-2 border-violet-300 text-violet-700 text-sm font-semibold hover:bg-violet-50 disabled:opacity-50">
          {uploading ? 'Przesyłanie…' : '+ Dodaj pliki'}
        </button>
        {uploadError && <p className="text-xs text-red-500 mt-2">{uploadError}</p>}
        {attachments.length > 0 && (
          <ul className="mt-3 space-y-1">
            {attachments.map(a => (
              <li key={a.id} className="text-xs text-gray-600 flex items-center gap-2">
                <span>📄 {a.file_name}</span>
                <span className="text-green-500">✓ Przesłano</span>
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

const STEP_LABELS = ['Twój dom', 'Systemy', 'Szczegóły', 'Priorytety']

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
        setPageState(s.status === 'submitted' ? 'already_submitted' : 'form')
      })
      .catch((err: any) => {
        const status = err?.response?.status
        setPageState(status === 404 ? 'not_found' : 'error')
      })
  }, [token])

  const updateResponses = (patch: Partial<SurveyResponses>) => setResponses(prev => ({ ...prev, ...patch }))

  const handleSubmit = async () => {
    if (!token) return
    setSubmitting(true); setSubmitError('')
    try {
      await surveyApi.publicSubmit(token, responses)
      setPageState('submitted')
    } catch {
      setSubmitError('Wystąpił błąd podczas wysyłania ankiety. Spróbuj ponownie.')
    } finally { setSubmitting(false) }
  }

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

  if (pageState === 'error') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="text-6xl mb-4">⚠️</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Błąd połączenia</h1>
          <p className="text-gray-500 mb-4">Nie udało się załadować ankiety. Odśwież stronę lub spróbuj ponownie za chwilę.</p>
          <button onClick={() => { setPageState('loading'); window.location.reload() }}
            className="bg-violet-600 text-white px-6 py-2 rounded-xl font-semibold hover:bg-violet-700 transition-colors">
            Odśwież stronę
          </button>
        </div>
      </div>
    )
  }

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
          {projectName && <div className="text-sm text-violet-600 font-medium">{projectName}</div>}
        </div>
      </div>
    )
  }

  if (pageState === 'submitted') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
            <svg viewBox="0 0 24 24" className="w-10 h-10 text-green-500 fill-none stroke-current stroke-2">
              <polyline points="20,6 9,17 4,12" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Dziękujemy!</h1>
          <p className="text-gray-500">Twoja ankieta została przesłana. Na jej podstawie przygotujemy wstępną wycenę i skontaktujemy się z Tobą.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-indigo-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-sm font-bold tracking-widest text-violet-600 uppercase">Smart Home Center</div>
          <h1 className="text-xl font-bold text-gray-800 mt-1">Ankieta Smart Home</h1>
          {projectName && <p className="text-sm text-gray-500 mt-0.5">{projectName}</p>}
        </div>

        <StepIndicator step={step} total={4} labels={STEP_LABELS} />

        <div className="bg-white rounded-3xl shadow-xl p-5 sm:p-8">
          {step === 1 && <Step1 data={responses} onChange={updateResponses} />}
          {step === 2 && <Step2 data={responses} onChange={updateResponses} />}
          {step === 3 && <Step3 data={responses} onChange={updateResponses} />}
          {step === 4 && token && (
            <Step4 data={responses} onChange={updateResponses} token={token}
              attachments={attachments} onAttachmentAdded={a => setAttachments(prev => [...prev, a])} />
          )}

          {submitError && <p className="text-sm text-red-500 mt-4">{submitError}</p>}

          {/* Nawigacja */}
          <div className="flex items-center justify-between mt-8 pt-5 border-t border-gray-100">
            <button type="button" onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-gray-500 hover:bg-gray-100 disabled:opacity-0 transition-colors">
              ← Wstecz
            </button>
            {step < 4 ? (
              <button type="button" onClick={() => setStep(s => Math.min(4, s + 1))}
                className="px-7 py-2.5 rounded-xl text-sm font-bold bg-violet-600 text-white hover:bg-violet-700 shadow-md shadow-violet-200 transition-colors">
                Dalej →
              </button>
            ) : (
              <button type="button" onClick={handleSubmit} disabled={submitting}
                className="px-7 py-2.5 rounded-xl text-sm font-bold bg-green-600 text-white hover:bg-green-700 shadow-md shadow-green-200 transition-colors disabled:opacity-60">
                {submitting ? 'Wysyłanie…' : '✅ Wyślij ankietę'}
              </button>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-4">Smart Home Center Sp. z o.o. · Twoje dane wykorzystamy wyłącznie do przygotowania wyceny.</p>
      </div>
    </div>
  )
}
