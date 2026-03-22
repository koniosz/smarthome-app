import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Project, ProductCatalogItem, QuoteBrand } from '../../types'
import { QUOTE_BRANDS, QUOTE_BRAND_COLORS, SMART_FEATURES } from '../../types'
import { projectsApi, aiQuotesApi, productCatalogApi } from '../../api/client'

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Room { id: string; name: string }
interface Floor { id: string; name: string; rooms: Room[] }
interface WizardItem {
  catalog_item_id: string
  room: string
  brand: QuoteBrand
  category: string
  name: string
  qty: number
  unit: string
  unit_price: number
}
interface WizardData {
  // Step 1
  name: string; client_name: string; client_contact: string
  start_date: string; end_date: string; area: string; description: string
  // Step 2
  systems: QuoteBrand[]; smart_features: string[]
  // Step 3
  floors: Floor[]
  // Step 4
  items: WizardItem[]
}

const FLOOR_PRESETS = ['Piwnica', 'Parter', 'Piętro 1', 'Piętro 2', 'Poddasze', 'Garaż', 'Ogród', 'Pergola', 'Taras']
const ROOM_PRESETS: Record<string, string[]> = {
  'Piwnica':   ['Kotłownia', 'Pralnia', 'Schowek', 'Garaż', 'Siłownia', 'Sala kinowa'],
  'Parter':    ['Salon', 'Kuchnia', 'Jadalnia', 'Przedpokój', 'Hol', 'WC', 'Gabinet', 'Garderoba', 'Kotłownia'],
  'Piętro 1':  ['Sypialnia główna', 'Sypialnia 2', 'Sypialnia 3', 'Pokój dziecięcy', 'Łazienka główna', 'Łazienka 2', 'WC', 'Korytarz', 'Garderoba'],
  'Piętro 2':  ['Sypialnia 4', 'Sypialnia 5', 'Łazienka 3', 'WC', 'Korytarz', 'Strych'],
  'Poddasze':  ['Strych', 'Sypialnia', 'Łazienka', 'Salon', 'Gabinet'],
  'Garaż':     ['Garaż 2-stanowiskowy', 'Garaż 1-stanowiskowy'],
  'Ogród':     ['Taras', 'Pergola', 'Basen', 'Altana'],
  'Pergola':   ['Strefa wypoczynku', 'Kuchnia zewnętrzna'],
  'Taras':     ['Taras główny', 'Taras boczny'],
}

let _uid = 0
const uid = () => `w-${++_uid}`

function stepLabel(s: number) {
  return ['Dane projektu', 'Systemy', 'Struktura domu', 'Urządzenia'][s - 1] ?? ''
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function ProjectWizard({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (p: Project) => void
}) {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [catalog, setCatalog] = useState<ProductCatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [data, setData] = useState<WizardData>({
    name: '', client_name: '', client_contact: '', start_date: '', end_date: '',
    area: '', description: '', systems: ['KNX'], smart_features: [],
    floors: [{ id: uid(), name: 'Parter', rooms: [{ id: uid(), name: 'Salon' }, { id: uid(), name: 'Kuchnia' }] }],
    items: [],
  })

  useEffect(() => {
    if (step === 4 && catalog.length === 0) {
      setCatalogLoading(true)
      productCatalogApi.listAll().then(c => { setCatalog(c); setCatalogLoading(false) }).catch(() => setCatalogLoading(false))
    }
  }, [step])

  const update = (patch: Partial<WizardData>) => setData(d => ({ ...d, ...patch }))

  // ── Step 1 validation ──
  const step1Valid = data.name.trim().length > 0

  // ── Save ──────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true)
    try {
      const allRooms = data.floors.flatMap(f => f.rooms.map(r => `${f.name} / ${r.name}`))
      // Create project
      const project = await projectsApi.create({
        name: data.name,
        client_name: data.client_name,
        client_contact: data.client_contact,
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        area_m2: data.area ? Number(data.area) : null,
        description: data.description,
        smart_features: data.smart_features,
        project_type: 'installation',
        status: 'offer_submitted',
        budget_amount: 0,
      })
      // Create quote from wizard items if any
      if (data.items.length > 0) {
        await aiQuotesApi.createManual(project.id, {
          items: data.items,
          rooms_detected: allRooms,
          notes: `Wycena stworzona kreatorem. Systemy: ${data.systems.join(', ')}.`,
        })
      }
      onCreated(project)
      navigate(`/projects/${project.id}`)
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Błąd zapisu projektu.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">🧙‍♂️</span>
            <div>
              <div className="font-bold text-gray-800 dark:text-gray-100 text-sm">Kreator projektu</div>
              <div className="text-xs text-gray-400">Krok {step} / 4 — {stepLabel(step)}</div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl font-bold">×</button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-1 px-6 pt-4 shrink-0">
          {[1, 2, 3, 4].map(s => (
            <div key={s} className={`flex-1 h-1.5 rounded-full transition-colors ${s <= step ? 'bg-violet-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && <Step1 data={data} update={update} />}
          {step === 2 && <Step2 data={data} update={update} />}
          {step === 3 && <Step3 data={data} update={update} />}
          {step === 4 && <Step4 data={data} update={update} catalog={catalog} loading={catalogLoading} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 dark:border-gray-800 shrink-0">
          <button
            onClick={() => step > 1 ? setStep(s => s - 1) : onClose()}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            {step === 1 ? 'Anuluj' : '← Wstecz'}
          </button>
          <div className="flex items-center gap-3">
            {step < 4 ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={step === 1 && !step1Valid}
                className="px-5 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                Dalej →
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {saving ? 'Tworzę projekt…' : '✅ Utwórz projekt'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Step 1: Dane projektu ─────────────────────────────────────────────────────
function Step1({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nazwa projektu *</label>
          <input
            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
            placeholder="np. Dom jednorodzinny Kowalski – Warszawa"
            value={data.name}
            onChange={e => update({ name: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Inwestor / Klient</label>
          <input
            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
            placeholder="Jan Kowalski"
            value={data.client_name}
            onChange={e => update({ client_name: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Kontakt (telefon / e-mail)</label>
          <input
            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
            placeholder="+48 600 000 000 / jan@email.pl"
            value={data.client_contact}
            onChange={e => update({ client_contact: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Planowany start prac</label>
          <input
            type="date"
            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={data.start_date}
            onChange={e => update({ start_date: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Planowane zakończenie</label>
          <input
            type="date"
            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
            value={data.end_date}
            onChange={e => update({ end_date: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Powierzchnia domu (m²)</label>
          <input
            type="number" min="10" step="5"
            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
            placeholder="np. 180"
            value={data.area}
            onChange={e => update({ area: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Opis projektu / Notatki</label>
          <textarea
            rows={3}
            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none"
            placeholder="Dodatkowe informacje o projekcie…"
            value={data.description}
            onChange={e => update({ description: e.target.value })}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Step 2: Systemy ───────────────────────────────────────────────────────────
const BRAND_INFO: Record<QuoteBrand, { icon: string; desc: string }> = {
  KNX:       { icon: '🟠', desc: 'Oświetlenie, rolety, ogrzewanie, wentylacja, audio' },
  Control4:  { icon: '🔵', desc: 'Centralny kontroler, keypady, integracja AV' },
  Hikvision: { icon: '🔴', desc: 'Kamery IP, NVR, domofon, kontrola dostępu' },
  Satel:     { icon: '🟢', desc: 'Centrala alarmowa, czujniki PIR, moduł GSM' },
  Usługi:    { icon: '🔧', desc: 'Instalacja, programowanie, konfiguracja' },
}

function Step2({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const toggleSystem = (b: QuoteBrand) => {
    update({ systems: data.systems.includes(b) ? data.systems.filter(x => x !== b) : [...data.systems, b] })
  }
  const toggleFeature = (key: string) => {
    update({ smart_features: data.smart_features.includes(key) ? data.smart_features.filter(x => x !== key) : [...data.smart_features, key] })
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Systemy smart home</div>
        <div className="grid grid-cols-2 gap-3">
          {QUOTE_BRANDS.map(brand => {
            const active = data.systems.includes(brand)
            return (
              <button
                key={brand}
                onClick={() => toggleSystem(brand)}
                className={`flex items-start gap-3 p-4 rounded-xl border-2 transition-all text-left ${
                  active ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                <span className="text-xl mt-0.5">{BRAND_INFO[brand].icon}</span>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${QUOTE_BRAND_COLORS[brand].split(' ')[1]}`}>{brand}</span>
                    <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? 'border-violet-500 bg-violet-500' : 'border-gray-300 dark:border-gray-600'}`}>
                      {active && <span className="text-white text-xs">✓</span>}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{BRAND_INFO[brand].desc}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Funkcje smart home</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {SMART_FEATURES.map(f => {
            const active = data.smart_features.includes(f.key)
            return (
              <button
                key={f.key}
                onClick={() => toggleFeature(f.key)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-all ${
                  active ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-300 font-medium' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                <span>{f.icon}</span>
                <span>{f.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Step 3: Struktura domu ────────────────────────────────────────────────────
function Step3({ data, update }: { data: WizardData; update: (p: Partial<WizardData>) => void }) {
  const [newFloorName, setNewFloorName] = useState('')
  const [newRoomInputs, setNewRoomInputs] = useState<Record<string, string>>({})

  const addFloor = (name: string) => {
    if (!name.trim()) return
    update({ floors: [...data.floors, { id: uid(), name: name.trim(), rooms: [] }] })
    setNewFloorName('')
  }

  const removeFloor = (fid: string) => update({ floors: data.floors.filter(f => f.id !== fid) })

  const addRoom = (fid: string, name: string) => {
    if (!name.trim()) return
    update({
      floors: data.floors.map(f => f.id !== fid ? f : {
        ...f, rooms: [...f.rooms, { id: uid(), name: name.trim() }],
      }),
    })
    setNewRoomInputs(prev => ({ ...prev, [fid]: '' }))
  }

  const removeRoom = (fid: string, rid: string) => {
    update({ floors: data.floors.map(f => f.id !== fid ? f : { ...f, rooms: f.rooms.filter(r => r.id !== rid) }) })
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-gray-400">Zdefiniuj kondygnacje i pomieszczenia. Możesz skorzystać z gotowych szablonów lub wpisać własne nazwy.</p>

      {/* Existing floors */}
      {data.floors.map(floor => (
        <div key={floor.id} className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/60 px-4 py-2.5">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">🏢 {floor.name}</span>
            <button onClick={() => removeFloor(floor.id)} className="text-gray-400 hover:text-red-500 text-sm transition-colors">✕</button>
          </div>
          <div className="p-3 space-y-2">
            {/* Room list */}
            <div className="flex flex-wrap gap-1.5">
              {floor.rooms.map(room => (
                <span key={room.id} className="inline-flex items-center gap-1 px-2.5 py-1 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded-lg text-xs font-medium">
                  {room.name}
                  <button onClick={() => removeRoom(floor.id, room.id)} className="hover:text-red-500 ml-0.5 leading-none">×</button>
                </span>
              ))}
            </div>
            {/* Room presets */}
            {(ROOM_PRESETS[floor.name] || ROOM_PRESETS['Parter']).filter(r => !floor.rooms.find(x => x.name === r)).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {(ROOM_PRESETS[floor.name] || ROOM_PRESETS['Parter'])
                  .filter(r => !floor.rooms.find(x => x.name === r))
                  .map(r => (
                    <button
                      key={r}
                      onClick={() => addRoom(floor.id, r)}
                      className="px-2 py-0.5 text-xs border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-violet-400 hover:text-violet-600 rounded-md transition-colors"
                    >
                      + {r}
                    </button>
                  ))}
              </div>
            )}
            {/* Custom room input */}
            <div className="flex gap-2">
              <input
                className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-violet-400"
                placeholder="Własna nazwa pomieszczenia…"
                value={newRoomInputs[floor.id] || ''}
                onChange={e => setNewRoomInputs(prev => ({ ...prev, [floor.id]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') addRoom(floor.id, newRoomInputs[floor.id] || '') }}
              />
              <button
                onClick={() => addRoom(floor.id, newRoomInputs[floor.id] || '')}
                className="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
              >+ Dodaj</button>
            </div>
          </div>
        </div>
      ))}

      {/* Add floor */}
      <div className="rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-700 p-4">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Dodaj kondygnację</div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {FLOOR_PRESETS.filter(fp => !data.floors.find(f => f.name === fp)).map(fp => (
            <button
              key={fp}
              onClick={() => addFloor(fp)}
              className="px-2.5 py-1 text-xs border border-dashed border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-violet-400 hover:text-violet-600 rounded-lg transition-colors"
            >
              + {fp}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-violet-400"
            placeholder="Własna nazwa kondygnacji…"
            value={newFloorName}
            onChange={e => setNewFloorName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addFloor(newFloorName) }}
          />
          <button
            onClick={() => addFloor(newFloorName)}
            className="px-3 py-1.5 text-xs bg-gray-700 dark:bg-gray-600 hover:bg-gray-800 text-white rounded-lg transition-colors"
          >+ Dodaj</button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 4: Urządzenia z katalogu ─────────────────────────────────────────────
function Step4({ data, update, catalog, loading }: {
  data: WizardData
  update: (p: Partial<WizardData>) => void
  catalog: ProductCatalogItem[]
  loading: boolean
}) {
  const [expandedRoom, setExpandedRoom] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [brandFilter, setBrandFilter] = useState<QuoteBrand | 'all'>('all')

  const allRooms = data.floors.flatMap(f =>
    f.rooms.map(r => ({ key: `${f.name} / ${r.name}`, label: r.name, floor: f.name }))
  )

  const filteredCatalog = catalog.filter(c => {
    const brandOk = brandFilter === 'all' ? data.systems.includes(c.brand) : c.brand === brandFilter
    const searchOk = !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.category.toLowerCase().includes(search.toLowerCase())
    return brandOk && searchOk && c.active
  })

  const getItemsForRoom = (roomKey: string) => data.items.filter(i => i.room === roomKey)

  const addItem = (roomKey: string, cat: ProductCatalogItem) => {
    const existing = data.items.find(i => i.room === roomKey && i.catalog_item_id === cat.id)
    if (existing) {
      update({ items: data.items.map(i => i.room === roomKey && i.catalog_item_id === cat.id ? { ...i, qty: i.qty + 1 } : i) })
    } else {
      update({
        items: [...data.items, {
          catalog_item_id: cat.id, room: roomKey, brand: cat.brand,
          category: cat.category, name: cat.name, qty: 1, unit: cat.unit, unit_price: cat.unit_price,
        }],
      })
    }
  }

  const updateQty = (roomKey: string, itemId: string, qty: number) => {
    if (qty <= 0) {
      update({ items: data.items.filter(i => !(i.room === roomKey && i.catalog_item_id === itemId)) })
    } else {
      update({ items: data.items.map(i => i.room === roomKey && i.catalog_item_id === itemId ? { ...i, qty } : i) })
    }
  }

  const totalItems = data.items.reduce((s, i) => s + i.qty * i.unit_price, 0)

  if (loading) return (
    <div className="flex items-center justify-center py-16 text-gray-400">
      <div className="text-center">
        <div className="text-3xl mb-2">⏳</div>
        <div className="text-sm">Ładowanie katalogu…</div>
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      {data.items.length > 0 && (
        <div className="flex items-center justify-between bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-xl px-4 py-2.5">
          <span className="text-xs text-violet-700 dark:text-violet-300 font-medium">
            {data.items.reduce((s, i) => s + i.qty, 0)} pozycji w wycenie
          </span>
          <span className="text-sm font-bold text-violet-700 dark:text-violet-300">
            {new Intl.NumberFormat('pl-PL').format(Math.round(totalItems))} PLN
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Left: rooms */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-1">Pomieszczenia</div>
          {allRooms.length === 0 && (
            <div className="text-xs text-gray-400 italic py-4 text-center">Brak pomieszczeń — wróć do kroku 3.</div>
          )}
          {allRooms.map(({ key, label, floor }) => {
            const roomItems = getItemsForRoom(key)
            const isExpanded = expandedRoom === key
            return (
              <div key={key} className={`rounded-xl border transition-colors ${isExpanded ? 'border-violet-400 dark:border-violet-500' : 'border-gray-200 dark:border-gray-700'}`}>
                <button
                  onClick={() => setExpandedRoom(isExpanded ? null : key)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                >
                  <div>
                    <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">{label}</div>
                    <div className="text-xs text-gray-400">{floor}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {roomItems.length > 0 && (
                      <span className="text-xs bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 px-1.5 py-0.5 rounded-md font-medium">
                        {roomItems.reduce((s, i) => s + i.qty, 0)} szt.
                      </span>
                    )}
                    <span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </button>
                {isExpanded && roomItems.length > 0 && (
                  <div className="border-t border-gray-100 dark:border-gray-800 px-3 pb-2 pt-1 space-y-1">
                    {roomItems.map(it => (
                      <div key={it.catalog_item_id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-gray-700 dark:text-gray-300 flex-1 truncate">{it.name}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => updateQty(key, it.catalog_item_id, it.qty - 1)} className="w-5 h-5 rounded border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:bg-red-50 hover:border-red-300">−</button>
                          <span className="w-5 text-center font-medium">{it.qty}</span>
                          <button onClick={() => updateQty(key, it.catalog_item_id, it.qty + 1)} className="w-5 h-5 rounded border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:bg-green-50 hover:border-green-300">+</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Right: catalog */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-1">Katalog produktów</div>
          {/* Filters */}
          <div className="flex gap-1.5">
            <input
              className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-violet-400"
              placeholder="Szukaj…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select
              className="border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              value={brandFilter}
              onChange={e => setBrandFilter(e.target.value as any)}
            >
              <option value="all">Wszystkie</option>
              {data.systems.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          {!expandedRoom && (
            <div className="text-xs text-gray-400 italic py-2 text-center">← Wybierz pomieszczenie</div>
          )}

          {expandedRoom && (
            <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
              {filteredCatalog.length === 0 && (
                <div className="text-xs text-gray-400 italic py-4 text-center">Brak produktów w katalogu.<br/>Przejdź do Administracji → Katalog i dodaj produkty.</div>
              )}
              {filteredCatalog.map(cat => {
                const alreadyInRoom = data.items.find(i => i.room === expandedRoom && i.catalog_item_id === cat.id)
                return (
                  <div key={cat.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-100 dark:border-gray-800 hover:border-violet-300 dark:hover:border-violet-700 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{cat.name}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`text-xs px-1 py-0 rounded font-medium border ${QUOTE_BRAND_COLORS[cat.brand]}`}>{cat.brand}</span>
                        <span className="text-xs text-gray-400">{cat.category}</span>
                        <span className="text-xs text-gray-500 ml-auto">{new Intl.NumberFormat('pl-PL').format(cat.unit_price)} PLN</span>
                      </div>
                    </div>
                    <button
                      onClick={() => addItem(expandedRoom, cat)}
                      className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold transition-colors ${
                        alreadyInRoom ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400 hover:bg-violet-200' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-violet-100 hover:text-violet-600 dark:hover:bg-violet-900/30'
                      }`}
                      title="Dodaj do pomieszczenia"
                    >
                      {alreadyInRoom ? `+${alreadyInRoom.qty}` : '+'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
