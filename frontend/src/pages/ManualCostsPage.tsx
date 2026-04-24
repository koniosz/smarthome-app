import { useState, useEffect, useCallback, useRef } from 'react'
import { manualCostsApi } from '../api/client'
import type { ManualCost } from '../types'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

// ── Taksonomia ────────────────────────────────────────────────────────────────
const COST_CATS: Record<string, { label: string; icon: string }> = {
  ga:         { label: 'G&A',        icon: '🏢' },
  financial:  { label: 'Finansowe',  icon: '💳' },
  cogs:       { label: 'COGS',       icon: '🏗️' },
  operations: { label: 'Operacje',   icon: '⚙️' },
}

const SUBCATS: Record<string, Record<string, string>> = {
  ga: {
    salary_gross:    'Wynagrodzenia brutto (UoP)',
    salary_b2b:      'Wynagrodzenia B2B / faktury',
    salary_civil:    'Wynagrodzenia UoD / UoZ',
    zus_employer:    'ZUS pracodawcy',
    rent:            'Czynsz biuro / magazyn',
    utilities:       'Media (prąd, internet)',
    software:        'Oprogramowanie / licencje',
    accounting:      'Księgowość / doradztwo',
    legal:           'Usługi prawne',
    office_supplies: 'Materiały biurowe',
  },
  financial: {
    tax_vat:     'VAT do US',
    tax_income:  'CIT / PIT do US',
    tax_other:   'Inne podatki i opłaty',
    bank_fee:    'Opłaty bankowe',
    interest:    'Odsetki',
    leasing:     'Leasing',
    fx:          'Różnice kursowe',
  },
  cogs: {
    hardware:              'Sprzęt krajowy',
    hardware_eu:           '🇪🇺 Sprzęt z UE (WNT)',
    hardware_noneu:        '🌏 Sprzęt spoza UE (import)',
    import_duty:           '🛃 Cło i opłaty celne',
    import_freight:        '🚢 Fracht / spedycja',
    import_agency:         '📋 Agencja celna',
    subcontractor:         'Podwykonawca',
    installation_material: 'Materiały instalacyjne',
  },
  operations: {
    car_fuel:    'Paliwo',
    car_service: 'Serwis pojazdów',
    insurance:   'Ubezpieczenie',
    travel:      'Podróże służbowe',
    tools:       'Narzędzia',
  },
}

const BU_LABELS: Record<string, string> = {
  shc: 'Smart Home Center', gatelynk: 'GateLynk', shared: 'Wspólne',
}

const CAT_COLORS: Record<string, string> = {
  ga:         'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  financial:  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  cogs:       'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  operations: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
}

const SOURCE_COLORS: Record<string, string> = {
  manual: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  mt940:  'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300',
}

// ── Quick-entry presets ───────────────────────────────────────────────────────
const PRESETS = [
  { label: '💰 Pensja UoP',     cost_category: 'ga',        subcategory: 'salary_gross',  business_unit: 'shared' },
  { label: '🏛️ ZUS',            cost_category: 'ga',        subcategory: 'zus_employer',  business_unit: 'shared' },
  { label: '🧾 VAT do US',      cost_category: 'financial', subcategory: 'tax_vat',       business_unit: 'shared' },
  { label: '📊 CIT/PIT do US',  cost_category: 'financial', subcategory: 'tax_income',    business_unit: 'shared' },
  { label: '🇪🇺 Faktura z UE',  cost_category: 'cogs',      subcategory: 'hardware_eu',   business_unit: 'shc'    },
  { label: '🌏 Import spoza UE',cost_category: 'cogs',      subcategory: 'hardware_noneu',business_unit: 'shc'    },
  { label: '🛃 Cło',            cost_category: 'cogs',      subcategory: 'import_duty',   business_unit: 'shc'    },
  { label: '🚢 Fracht',         cost_category: 'cogs',      subcategory: 'import_freight',business_unit: 'shc'    },
]

// ── Form component ────────────────────────────────────────────────────────────
function CostForm({ initial, onSave, onCancel, saving }: {
  initial?: Partial<ManualCost>
  onSave: (data: Partial<ManualCost>) => void
  onCancel: () => void
  saving: boolean
}) {
  const [date,          setDate]          = useState(initial?.date ?? new Date().toISOString().slice(0, 10))
  const [description,   setDescription]   = useState(initial?.description ?? '')
  const [amount,        setAmount]        = useState(initial?.amount?.toString() ?? '')
  const [currency,      setCurrency]      = useState(initial?.currency ?? 'PLN')
  const [cost_category, setCostCategory]  = useState(initial?.cost_category ?? 'ga')
  const [subcategory,   setSubcategory]   = useState(initial?.subcategory ?? 'salary_gross')
  const [business_unit, setBusinessUnit]  = useState(initial?.business_unit ?? 'shared')
  const [period,        setPeriod]        = useState(initial?.period ?? '')
  const [notes,         setNotes]         = useState(initial?.notes ?? '')
  const [reference,     setReference]     = useState(initial?.reference ?? '')

  const subs = SUBCATS[cost_category] ?? {}
  const selectCls = 'px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500'

  function applyPreset(p: typeof PRESETS[0]) {
    setCostCategory(p.cost_category)
    setSubcategory(p.subcategory)
    setBusinessUnit(p.business_unit)
  }

  return (
    <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 space-y-3">
      {/* Szybkie presety */}
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">Szybki wybór:</p>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(p => (
            <button
              key={p.subcategory}
              type="button"
              onClick={() => applyPreset(p)}
              className={`px-2 py-1 text-xs rounded-lg border transition-colors ${
                subcategory === p.subcategory
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Data</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className={`w-full ${selectCls}`} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Kwota</label>
          <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0.00" className={`w-full ${selectCls}`} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Waluta</label>
          <select value={currency} onChange={e => setCurrency(e.target.value)} className={`w-full ${selectCls}`}>
            {['PLN','EUR','USD','GBP','CHF','CZK'].map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Okres (YYYY-MM)</label>
          <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
            className={`w-full ${selectCls}`} />
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-0.5">Opis *</label>
        <input type="text" value={description} onChange={e => setDescription(e.target.value)}
          placeholder="np. Wynagrodzenie styczeń 2026 — Jan Kowalski" className={`w-full ${selectCls}`} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Kategoria</label>
          <select value={cost_category} onChange={e => {
            setCostCategory(e.target.value)
            setSubcategory(Object.keys(SUBCATS[e.target.value] ?? {})[0] ?? '')
          }} className={`w-full ${selectCls}`}>
            {Object.entries(COST_CATS).map(([k, v]) => (
              <option key={k} value={k}>{v.icon} {v.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Podkategoria</label>
          <select value={subcategory} onChange={e => setSubcategory(e.target.value)} className={`w-full ${selectCls}`}>
            {Object.entries(subs).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Jednostka</label>
          <select value={business_unit} onChange={e => setBusinessUnit(e.target.value)} className={`w-full ${selectCls}`}>
            {Object.entries(BU_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Referencja / nr dok.</label>
          <input type="text" value={reference} onChange={e => setReference(e.target.value)}
            placeholder="np. ZUS/01/2026" className={`w-full ${selectCls}`} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Notatka</label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="opcjonalnie" className={`w-full ${selectCls}`} />
        </div>
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg">
          Anuluj
        </button>
        <button
          onClick={() => onSave({ date, description, amount: parseFloat(amount), currency, cost_category, subcategory, business_unit, period: period || null, notes, reference })}
          disabled={saving || !description || !amount}
          className="px-4 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50"
        >
          {saving ? 'Zapisuję…' : 'Zapisz koszt'}
        </button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ManualCostsPage() {
  const thisYear = new Date().getFullYear()
  const [costs,      setCosts]      = useState<ManualCost[]>([])
  const [loading,    setLoading]    = useState(true)
  const [adding,     setAdding]     = useState(false)
  const [editingId,  setEditingId]  = useState<string | null>(null)
  const [saving,     setSaving]     = useState(false)
  const [importing,  setImporting]  = useState(false)
  const [catFilter,  setCatFilter]  = useState('all')
  const [dateFrom,   setDateFrom]   = useState(`${thisYear}-01-01`)
  const [dateTo,     setDateTo]     = useState(`${thisYear}-12-31`)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await manualCostsApi.list({
        dateFrom, dateTo,
        cost_category: catFilter === 'all' ? undefined : catFilter,
      })
      setCosts(data)
    } finally { setLoading(false) }
  }, [dateFrom, dateTo, catFilter])

  useEffect(() => { load() }, [load])

  const handleAdd = async (data: Partial<ManualCost>) => {
    setSaving(true)
    try {
      const created = await manualCostsApi.create(data)
      setCosts(prev => [created, ...prev])
      setAdding(false)
    } catch (e: any) { alert(e.response?.data?.error ?? e.message) }
    finally { setSaving(false) }
  }

  const handleUpdate = async (id: string, data: Partial<ManualCost>) => {
    setSaving(true)
    try {
      const updated = await manualCostsApi.update(id, data)
      setCosts(prev => prev.map(c => c.id === id ? updated : c))
      setEditingId(null)
    } catch (e: any) { alert(e.response?.data?.error ?? e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć ten koszt?')) return
    await manualCostsApi.remove(id)
    setCosts(prev => prev.filter(c => c.id !== id))
  }

  const handleMt940 = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    try {
      const text = await file.text()
      const result = await manualCostsApi.importMt940(text)
      alert(result.message)
      load()
    } catch (err: any) {
      alert('Błąd importu: ' + (err.response?.data?.error ?? err.message))
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const total = costs.reduce((s, c) => s + c.amount, 0)

  // Podsumowanie wg kategorii
  const summary: Record<string, number> = {}
  for (const c of costs) {
    summary[c.cost_category] = (summary[c.cost_category] ?? 0) + c.amount
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">📋 Inne koszty</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Pensje, ZUS, podatki, faktury zagraniczne — wpis ręczny lub import MT940
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100" />
          <span className="text-gray-400 text-xs">—</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100" />

          {/* MT940 import */}
          <input ref={fileRef} type="file" accept=".sta,.txt,.mt940,.940" className="hidden" onChange={handleMt940} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-950/20 rounded-lg transition-colors disabled:opacity-50"
            title="Wgraj wyciąg bankowy MT940 (.sta, .txt) — transakcje wychodzące zostaną auto-sklasyfikowane"
          >
            {importing ? '⟳ Importuję…' : '🏦 Import MT940'}
          </button>

          <button
            onClick={() => setAdding(true)}
            className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg"
          >
            + Dodaj koszt
          </button>
        </div>
      </div>

      {/* Karty podsumowania */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Object.entries(COST_CATS).map(([k, v]) => (
          <div key={k}
            onClick={() => setCatFilter(c => c === k ? 'all' : k)}
            className={`bg-white dark:bg-gray-900 rounded-xl border p-3 cursor-pointer transition-all ${
              catFilter === k ? 'border-violet-400 ring-1 ring-violet-400' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
            }`}
          >
            <div className="text-lg">{v.icon}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{v.label}</div>
            <div className="text-sm font-semibold text-gray-800 dark:text-gray-100 tabular-nums mt-0.5">
              {fmt(summary[k] ?? 0)} PLN
            </div>
          </div>
        ))}
      </div>

      {/* Formularz dodawania */}
      {adding && (
        <CostForm
          onSave={handleAdd}
          onCancel={() => setAdding(false)}
          saving={saving}
        />
      )}

      {/* Lista */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
              Koszty ({costs.length}) — Suma: {fmt(total)} PLN
            </h2>
          </div>
          {/* Filtr kategorii */}
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
            <button onClick={() => setCatFilter('all')}
              className={`px-2.5 py-1 transition-colors ${catFilter === 'all' ? 'bg-violet-600 text-white' : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
              Wszystkie
            </button>
            {Object.entries(COST_CATS).map(([k, v]) => (
              <button key={k} onClick={() => setCatFilter(c => c === k ? 'all' : k)}
                className={`px-2.5 py-1 transition-colors ${catFilter === k ? 'bg-violet-600 text-white' : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                {v.icon}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-center py-10 text-sm text-gray-400">Ładowanie…</div>
        ) : costs.length === 0 ? (
          <div className="text-center py-12 text-sm text-gray-400">
            <div className="text-3xl mb-2">📋</div>
            <div>Brak kosztów w tym okresie.</div>
            <div className="text-xs mt-1">Dodaj ręcznie lub wgraj wyciąg MT940.</div>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                <th className="text-left py-2 px-4">Data / Opis</th>
                <th className="text-left py-2 px-3">Kategoria</th>
                <th className="text-right py-2 px-4">Kwota</th>
                <th className="py-2 px-3 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {costs.map(cost => (
                editingId === cost.id ? (
                  <tr key={cost.id} className="border-b border-gray-100 dark:border-gray-800">
                    <td colSpan={4} className="px-4 py-2">
                      <CostForm
                        initial={cost}
                        onSave={data => handleUpdate(cost.id, data)}
                        onCancel={() => setEditingId(null)}
                        saving={saving}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={cost.id} className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors group">
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 whitespace-nowrap">{cost.date}</span>
                        {cost.period && (
                          <span className="text-[10px] bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 px-1 py-0.5 rounded">
                            {cost.period}
                          </span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${SOURCE_COLORS[cost.source]}`}>
                          {cost.source === 'mt940' ? '🏦 MT940' : '✏️ ręczny'}
                        </span>
                      </div>
                      <div className="text-sm text-gray-800 dark:text-gray-100 mt-0.5">{cost.description}</div>
                      {cost.reference && (
                        <div className="text-xs text-gray-400 mt-0.5 font-mono">{cost.reference}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${CAT_COLORS[cost.cost_category] ?? ''}`}>
                        {COST_CATS[cost.cost_category]?.icon} {SUBCATS[cost.cost_category]?.[cost.subcategory] ?? cost.subcategory}
                      </span>
                      <div className="text-[10px] text-gray-400 mt-0.5">{BU_LABELS[cost.business_unit]}</div>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 tabular-nums">
                        {fmt(cost.amount)} {cost.currency}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setEditingId(cost.id)}
                          className="p-1 text-gray-400 hover:text-violet-600 rounded transition-colors" title="Edytuj">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button onClick={() => handleDelete(cost.id)}
                          className="p-1 text-gray-300 hover:text-red-500 rounded transition-colors" title="Usuń">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
