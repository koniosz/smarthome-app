import { useEffect, useState } from 'react'
import { ksefApi, projectsApi } from '../../api/client'
import type { KsefInvoiceAllocation, KsefInvoice, Project } from '../../types'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

// ── Legacy project-cost category (for CostItem creation) ─────────────────────
const CATEGORIES = [
  { value: 'materials',     label: 'Materiały',      color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  { value: 'subcontractor', label: 'Podwykonawca',   color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  { value: 'other',         label: 'Inne',            color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
]

function CategoryBadge({ category }: { category: string }) {
  const cat = CATEGORIES.find(c => c.value === category) ?? CATEGORIES[0]
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cat.color}`}>
      {cat.label}
    </span>
  )
}

function CategorySelect({ value, onChange, className = '' }: {
  value: string
  onChange: (v: string) => void
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500 ${className}`}
    >
      {CATEGORIES.map(c => (
        <option key={c.value} value={c.value}>{c.label}</option>
      ))}
    </select>
  )
}

// ── CFO financial taxonomy ────────────────────────────────────────────────────
const COST_TAXONOMY: Record<string, { label: string; icon: string; subcategories: Record<string, string> }> = {
  cogs:       { label: 'COGS', icon: '🏗️', subcategories: {
    hardware:               'Sprzęt krajowy (KNX/HDL/Control4…)',
    hardware_eu:            '🇪🇺 Sprzęt z UE (WNT)',
    hardware_noneu:         '🌏 Sprzęt spoza UE (import)',
    import_duty:            '🛃 Cło i opłaty celne',
    import_freight:         '🚢 Fracht / spedycja importowa',
    import_agency:          '📋 Agencja celna / obsługa importu',
    import_vat:             '🧾 VAT importowy (nieodliczalny)',
    subcontractor:          'Podwykonawca',
    installation_material:  'Materiały instalacyjne',
    labor:                  'Robocizna własna',
  }},
  sales:      { label: 'Sprzedaż', icon: '📣', subcategories: {
    advertising:   'Reklama (Facebook/Google)',
    commission:    'Prowizja / pośrednictwo',
    crm_software:  'CRM / narzędzia sprzedaży',
    marketing:     'Marketing ogólny',
  }},
  ga:         { label: 'G&A', icon: '🏢', subcategories: {
    rent:           'Czynsz biuro / magazyn',
    utilities:      'Media (prąd, internet)',
    salary_admin:   'Wynagrodzenia — admin',
    software:       'Oprogramowanie / licencje',
    accounting:     'Księgowość / doradztwo',
    legal:          'Usługi prawne',
    office_supplies:'Materiały biurowe',
  }},
  operations: { label: 'Operacje', icon: '⚙️', subcategories: {
    car_fuel:    'Paliwo',
    car_service: 'Serwis pojazdów',
    tools:       'Narzędzia i sprzęt',
    insurance:   'Ubezpieczenie',
    travel:      'Podróże służbowe',
  }},
  financial:  { label: 'Finansowe', icon: '💳', subcategories: {
    bank_fee: 'Opłaty bankowe',
    interest: 'Odsetki',
    leasing:  'Leasing',
    fx:       'Różnice kursowe / przewalutowanie',
  }},
}

const REVENUE_TAXONOMY: Record<string, { label: string; icon: string }> = {
  installation_complete: { label: 'Instalacja kompletna',       icon: '🏠' },
  installation_partial:  { label: 'Instalacja częściowa',       icon: '🔧' },
  hardware_sale:         { label: 'Sprzedaż sprzętu',           icon: '📦' },
  service_maintenance:   { label: 'Serwis / konserwacja',       icon: '🛠️' },
  additional_works:      { label: 'Prace dodatkowe (aneks)',     icon: '➕' },
  consulting:            { label: 'Doradztwo / projekt',        icon: '💡' },
  gatelynk_license:      { label: 'GateLynk — licencja/SaaS',  icon: '🔑' },
  other_revenue:         { label: 'Pozostałe przychody',        icon: '💰' },
}

const BUSINESS_UNITS = [
  { value: 'shc',      label: 'Smart Home Center', color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
  { value: 'gatelynk', label: 'GateLynk',          color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  { value: 'shared',   label: 'Wspólne',            color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
]

const COST_CAT_COLORS: Record<string, string> = {
  cogs:       'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  sales:      'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
  ga:         'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  operations: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  financial:  'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
}

function FinancialBadges({ alloc }: { alloc: KsefInvoiceAllocation }) {
  const cat  = alloc.cost_category ?? 'cogs'
  const sub  = alloc.subcategory   ?? 'hardware'
  const bu   = alloc.business_unit ?? 'shc'
  const catDef = COST_TAXONOMY[cat]
  const buDef  = BUSINESS_UNITS.find(b => b.value === bu)
  if (!catDef) return null
  return (
    <span className="flex items-center gap-1 flex-wrap">
      <span className={`inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium ${COST_CAT_COLORS[cat] ?? ''}`}>
        {catDef.icon} {catDef.label}
      </span>
      <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate max-w-[100px]">
        {catDef.subcategories[sub] ?? sub}
      </span>
      {buDef && (
        <span className={`inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium ${buDef.color}`}>
          {buDef.label}
        </span>
      )}
    </span>
  )
}

const CATEGORY_LEGEND: Record<string, { examples: string; when: string }> = {
  cogs:       { when: 'Koszty bezpośrednio związane z realizacją projektu dla klienta (w tym import)', examples: 'Sprzęt KNX/HDL krajowy, sprzęt z UE (WNT), import z Chin, cło, agencja celna, fracht morski' },
  sales:      { when: 'Koszty pozyskiwania klientów i promocji firmy', examples: 'Facebook Ads, Google Ads, prowizja dla pośrednika, CRM (HubSpot)' },
  ga:         { when: 'Koszty utrzymania biura i zarządzania firmą', examples: 'Czynsz biura, księgowość, licencje (Microsoft 365), system urlopowy, usługi prawne' },
  operations: { when: 'Koszty codziennego funkcjonowania operacyjnego', examples: 'Paliwo, serwis samochodów, narzędzia, ubezpieczenia, delegacje' },
  financial:  { when: 'Koszty wynikające z obsługi finansowej i zadłużenia', examples: 'Opłaty bankowe, odsetki od kredytu, leasing, różnice kursowe przy imporcie' },
}

function FinancialTaxonomyPicker({ cost_category, subcategory, business_unit, onChange }: {
  cost_category: string
  subcategory: string
  business_unit: string
  onChange: (cat: string, sub: string, bu: string) => void
}) {
  const [legendOpen, setLegendOpen] = useState(false)
  const catDef = COST_TAXONOMY[cost_category]
  const selectCls = 'w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500'

  return (
    <div className="space-y-1.5 rounded-lg border border-dashed border-violet-200 dark:border-violet-800 p-2 bg-violet-50/40 dark:bg-violet-950/10">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide">📊 Klasyfikacja P&amp;L (CFO)</p>
        <button
          type="button"
          onClick={() => setLegendOpen(o => !o)}
          className="text-[10px] text-violet-500 dark:text-violet-400 hover:underline flex items-center gap-0.5"
        >
          {legendOpen ? '▾' : '▸'} Legenda kategorii
        </button>
      </div>

      {/* Legenda */}
      {legendOpen && (
        <div className="rounded-lg border border-violet-100 dark:border-violet-900 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800 text-[11px]">
          {Object.entries(COST_TAXONOMY).map(([k, v]) => {
            const leg = CATEGORY_LEGEND[k]
            return (
              <div key={k} className={`px-3 py-2 ${cost_category === k ? 'bg-violet-50 dark:bg-violet-950/20' : ''}`}>
                <div className="font-semibold text-gray-700 dark:text-gray-300">{v.icon} {v.label}</div>
                <div className="text-gray-500 dark:text-gray-400 mt-0.5">{leg?.when}</div>
                <div className="text-gray-400 dark:text-gray-500 italic mt-0.5">Przykłady: {leg?.examples}</div>
              </div>
            )
          })}
          <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/40">
            <div className="font-semibold text-gray-700 dark:text-gray-300">🏢 Jednostki biznesowe</div>
            <div className="text-gray-500 dark:text-gray-400 mt-0.5">
              <span className="font-medium">Smart Home Center</span> — projekty smart home dla klientów końcowych
              &nbsp;·&nbsp;
              <span className="font-medium">GateLynk</span> — platforma / SaaS / marketing cyfrowy
              &nbsp;·&nbsp;
              <span className="font-medium">Wspólne</span> — koszty wspólne obu działalności (biuro, księgowość, itp.)
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5">
        {/* Cost category */}
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Typ kosztu</label>
          <select
            value={cost_category}
            onChange={e => {
              const newCat = e.target.value
              const firstSub = Object.keys(COST_TAXONOMY[newCat]?.subcategories ?? {})[0] ?? 'hardware'
              onChange(newCat, firstSub, business_unit)
            }}
            className={selectCls}
          >
            {Object.entries(COST_TAXONOMY).map(([k, v]) => (
              <option key={k} value={k}>{v.icon} {v.label}</option>
            ))}
          </select>
        </div>
        {/* Subcategory */}
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Podkategoria</label>
          <select
            value={subcategory}
            onChange={e => onChange(cost_category, e.target.value, business_unit)}
            className={selectCls}
          >
            {Object.entries(catDef?.subcategories ?? {}).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        {/* Business unit */}
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Jednostka</label>
          <select
            value={business_unit}
            onChange={e => onChange(cost_category, subcategory, e.target.value)}
            className={selectCls}
          >
            {BUSINESS_UNITS.map(b => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

function RevenueTaxonomyPicker({ subcategory, business_unit, onChange }: {
  subcategory: string
  business_unit: string
  onChange: (sub: string, bu: string) => void
}) {
  const selectCls = 'w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-green-500'
  return (
    <div className="space-y-1.5 rounded-lg border border-dashed border-green-200 dark:border-green-800 p-2 bg-green-50/40 dark:bg-green-950/10">
      <p className="text-[10px] font-semibold text-green-700 dark:text-green-400 uppercase tracking-wide">💚 Klasyfikacja Przychodu (P&amp;L)</p>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Typ przychodu</label>
          <select value={subcategory} onChange={e => onChange(e.target.value, business_unit)} className={selectCls}>
            {Object.entries(REVENUE_TAXONOMY).map(([k, v]) => (
              <option key={k} value={k}>{v.icon} {v.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 dark:text-gray-400 mb-0.5">Jednostka</label>
          <select value={business_unit} onChange={e => onChange(subcategory, e.target.value)} className={selectCls}>
            {BUSINESS_UNITS.map(b => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

function RevenueBadges({ alloc }: { alloc: KsefInvoiceAllocation }) {
  const sub  = alloc.subcategory   ?? 'installation_complete'
  const bu   = alloc.business_unit ?? 'shc'
  const revDef = REVENUE_TAXONOMY[sub]
  const buDef  = BUSINESS_UNITS.find(b => b.value === bu)
  return (
    <span className="flex items-center gap-1 flex-wrap">
      <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        {revDef?.icon ?? '💰'} {revDef?.label ?? sub}
      </span>
      {buDef && (
        <span className={`inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium ${buDef.color}`}>
          {buDef.label}
        </span>
      )}
    </span>
  )
}

interface AllocationPanelProps {
  invoice: KsefInvoice
  isAdmin?: boolean
}

export default function AllocationPanel({ invoice, isAdmin = false }: AllocationPanelProps) {
  const isOutgoing = invoice.invoice_direction === 'outgoing'

  const [allocations, setAllocations] = useState<KsefInvoiceAllocation[]>([])
  const [projects, setProjects]       = useState<Project[]>([])
  const [loading, setLoading]         = useState(true)
  const [adding, setAdding]           = useState(false)
  const [editingId, setEditingId]     = useState<string | null>(null)

  // Form state
  const [newProjectId, setNewProjectId]   = useState('')
  const [newAmount, setNewAmount]         = useState('')
  const [newNotes, setNewNotes]           = useState('')
  const [newCategory, setNewCategory]     = useState('materials')
  const [newAllocType, setNewAllocType]   = useState<'project' | 'internal' | 'revenue'>(isOutgoing ? 'revenue' : 'project')
  const [newCostCat, setNewCostCat]       = useState(isOutgoing ? 'revenue' : 'cogs')
  const [newSubcat, setNewSubcat]         = useState(isOutgoing ? 'installation_complete' : 'hardware')
  const [newBU, setNewBU]                 = useState('shc')
  const [saving, setSaving]               = useState(false)

  useEffect(() => {
    Promise.all([
      ksefApi.getAllocations(invoice.id),
      projectsApi.list(),
    ]).then(([allocs, projs]) => {
      setAllocations(allocs)
      setProjects(projs)
    }).finally(() => setLoading(false))
  }, [invoice.id])

  const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0)
  const remaining      = invoice.gross_amount - totalAllocated

  const handleAdd = async () => {
    if (!newAmount) return
    if (!isOutgoing && newAllocType === 'project' && !newProjectId) return
    setSaving(true)
    try {
      const effectiveAllocType = isOutgoing ? 'revenue' : newAllocType
      const effectiveCostCat   = isOutgoing ? 'revenue' : newCostCat
      const alloc = await ksefApi.addAllocation(
        invoice.id,
        (!isOutgoing && newAllocType === 'project') ? newProjectId : (newProjectId || null),
        parseFloat(newAmount),
        newNotes,
        newCategory,
        effectiveAllocType,
        effectiveCostCat,
        newSubcat,
        newBU,
      )
      setAllocations(prev => [...prev, alloc])
      setAdding(false)
      setNewProjectId('')
      setNewAmount('')
      setNewNotes('')
      setNewCategory('materials')
      setNewAllocType(isOutgoing ? 'revenue' : 'project')
      setNewCostCat(isOutgoing ? 'revenue' : 'cogs')
      setNewSubcat(isOutgoing ? 'installation_complete' : 'hardware')
      setNewBU('shc')
    } catch (e: any) {
      alert(e.response?.data?.error ?? e.message)
    } finally { setSaving(false) }
  }

  const handleUpdate = async (
    alloc: KsefInvoiceAllocation,
    amount: string, notes: string, category: string,
    cost_category: string, subcategory: string, business_unit: string,
  ) => {
    setSaving(true)
    try {
      const updated = await ksefApi.updateAllocation(alloc.id, parseFloat(amount), notes, category, undefined, cost_category, subcategory, business_unit)
      setAllocations(prev => prev.map(a => a.id === updated.id ? updated : a))
      setEditingId(null)
    } catch (e: any) {
      alert(e.response?.data?.error ?? e.message)
    } finally { setSaving(false) }
  }

  const handleTogglePaid = async (alloc: KsefInvoiceAllocation) => {
    try {
      const updated = await ksefApi.toggleInternalAllocationPaid(alloc.id, !alloc.is_paid)
      setAllocations(prev => prev.map(a => a.id === updated.id ? updated : a))
    } catch (e: any) {
      alert(e.response?.data?.error ?? e.message)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć alokację? Koszt w projekcie zostanie również usunięty.')) return
    try {
      await ksefApi.deleteAllocation(id)
      setAllocations(prev => prev.filter(a => a.id !== id))
    } catch (e: any) {
      alert(e.response?.data?.error ?? e.message)
    }
  }

  if (loading) return <div className="text-xs text-gray-400 py-2">Ładowanie alokacji…</div>

  return (
    <div className="space-y-3">
      {/* Pasek postępu kwoty */}
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-gray-500 dark:text-gray-400">
          Przypisano: <span className="font-semibold text-gray-700 dark:text-gray-200">{fmt(totalAllocated)}</span> / {fmt(invoice.gross_amount)} {invoice.currency}
        </span>
        <span className={remaining < -0.01 ? 'text-red-500 font-semibold' : remaining > 0.01 ? 'text-orange-500' : 'text-green-500 font-semibold'}>
          {remaining > 0.01 ? `Pozostało: ${fmt(remaining)}` : remaining < -0.01 ? `Przekroczono o ${fmt(-remaining)}` : '✓ Całość przypisana'}
        </span>
      </div>
      {invoice.gross_amount > 0 && (
        <div className="w-full h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${totalAllocated > invoice.gross_amount ? 'bg-red-500' : 'bg-violet-500'}`}
            style={{ width: `${Math.min(100, (totalAllocated / invoice.gross_amount) * 100)}%` }}
          />
        </div>
      )}

      {/* Lista alokacji */}
      {allocations.length > 0 && (
        <div className="space-y-1">
          {allocations.map(alloc => (
            <AllocationRow
              key={alloc.id}
              alloc={alloc}
              currency={invoice.currency}
              isEditing={editingId === alloc.id}
              onEdit={() => setEditingId(alloc.id)}
              onCancel={() => setEditingId(null)}
              onSave={(amt, notes, category, cost_category, subcategory, business_unit) =>
                handleUpdate(alloc, amt, notes, category, cost_category, subcategory, business_unit)}
              onDelete={() => handleDelete(alloc.id)}
              onTogglePaid={() => handleTogglePaid(alloc)}
              saving={saving}
            />
          ))}
        </div>
      )}

      {/* Formularz dodawania */}
      {adding ? (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-2">
          {/* Wiersz 0: Typ alokacji (tylko dla faktur zakupowych) */}
          {!isOutgoing && (
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Typ alokacji</label>
            <select
              className="w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
              value={newAllocType}
              onChange={e => setNewAllocType(e.target.value as 'project' | 'internal')}
            >
              <option value="project">Projekt</option>
              <option value="internal">🏢 Wewnętrzne potrzeby prowadzenia działalności</option>
            </select>
          </div>
          )}

          {/* Wiersz 1: Projekt */}
          {(isOutgoing || newAllocType === 'project') && (
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              {isOutgoing ? 'Projekt (opcjonalnie — powiąż z projektem)' : 'Projekt'}
            </label>
            <select
              className="w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
              value={newProjectId}
              onChange={e => setNewProjectId(e.target.value)}
            >
              <option value="">— wybierz projekt —</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.client_name})</option>
              ))}
            </select>
          </div>
          )}

          {/* Wiersz 2: Kwota + Kategoria */}
          <div className={isOutgoing ? '' : 'grid grid-cols-2 gap-2'}>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Kwota ({invoice.currency})</label>
              <input
                type="number"
                step="0.01"
                min="0"
                className="w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
                value={newAmount}
                onChange={e => setNewAmount(e.target.value)}
                placeholder={remaining > 0 ? fmt(remaining) : '0.00'}
              />
            </div>
            {!isOutgoing && (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Kategoria kosztu</label>
              <CategorySelect value={newCategory} onChange={setNewCategory} className="w-full" />
            </div>
            )}
          </div>

          {/* Wiersz 3: Notatka */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Notatka (opcjonalnie)</label>
            <input
              type="text"
              className="w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
              value={newNotes}
              onChange={e => setNewNotes(e.target.value)}
              placeholder="np. materiały do salonu"
            />
          </div>

          {/* Wiersz 4: Klasyfikacja P&L */}
          {isOutgoing ? (
            <RevenueTaxonomyPicker
              subcategory={newSubcat}
              business_unit={newBU}
              onChange={(sub, bu) => { setNewSubcat(sub); setNewBU(bu) }}
            />
          ) : (
            <FinancialTaxonomyPicker
              cost_category={newCostCat}
              subcategory={newSubcat}
              business_unit={newBU}
              onChange={(cat, sub, bu) => { setNewCostCat(cat); setNewSubcat(sub); setNewBU(bu) }}
            />
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setAdding(false)
                setNewProjectId('')
                setNewAmount('')
                setNewNotes('')
                setNewCategory('materials')
                setNewAllocType(isOutgoing ? 'revenue' : 'project')
                setNewCostCat(isOutgoing ? 'revenue' : 'cogs')
                setNewSubcat(isOutgoing ? 'installation_complete' : 'hardware')
                setNewBU('shc')
              }}
              className="px-3 py-1 text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg"
            >
              Anuluj
            </button>
            <button
              onClick={handleAdd}
              disabled={saving || !newAmount || (!isOutgoing && newAllocType === 'project' && !newProjectId)}
              className={`px-3 py-1 text-xs font-medium text-white rounded-lg disabled:opacity-50 ${isOutgoing ? 'bg-green-600 hover:bg-green-700' : 'bg-violet-600 hover:bg-violet-700'}`}
            >
              {saving ? 'Zapisuję…' : isOutgoing ? 'Dodaj przychód' : 'Dodaj alokację'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setAdding(true); setNewAmount(remaining > 0 ? remaining.toFixed(2) : '') }}
          className={`w-full py-1.5 text-xs border border-dashed rounded-lg transition-colors ${isOutgoing ? 'text-green-600 dark:text-green-400 border-green-300 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-950/20' : 'text-violet-600 dark:text-violet-400 border-violet-300 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/20'}`}
        >
          {isOutgoing ? '+ Klasyfikuj przychód' : '+ Przypisz kwotę do projektu'}
        </button>
      )}
    </div>
  )
}

function AllocationRow({ alloc, currency, isEditing, onEdit, onCancel, onSave, onDelete, onTogglePaid, saving }: {
  alloc: KsefInvoiceAllocation
  currency: string
  isEditing: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (amount: string, notes: string, category: string, cost_category: string, subcategory: string, business_unit: string) => void
  onDelete: () => void
  onTogglePaid: () => void
  saving: boolean
}) {
  const [amount, setAmount]         = useState(alloc.amount.toFixed(2))
  const [notes, setNotes]           = useState(alloc.notes)
  const [category, setCategory]     = useState(alloc.category || 'materials')
  const [costCat, setCostCat]       = useState(alloc.cost_category || 'cogs')
  const [subcat, setSubcat]         = useState(alloc.subcategory || 'hardware')
  const [bu, setBU]                 = useState(alloc.business_unit || 'shc')

  if (isEditing) {
    return (
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-400 mb-0.5">Kwota ({currency})</label>
            <input
              type="number"
              step="0.01"
              className="w-full px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-0.5">Kat. projektu</label>
            <CategorySelect value={category} onChange={setCategory} className="w-full" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-0.5">Notatka</label>
          <input
            type="text"
            className="w-full px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>
        <FinancialTaxonomyPicker
          cost_category={costCat}
          subcategory={subcat}
          business_unit={bu}
          onChange={(c, s, b) => { setCostCat(c); setSubcat(s); setBU(b) }}
        />
        <div className="flex gap-1.5 justify-end">
          <button onClick={onCancel} className="px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">Anuluj</button>
          <button
            onClick={() => onSave(amount, notes, category, costCat, subcat, bu)}
            disabled={saving}
            className="px-2 py-0.5 text-xs font-medium bg-violet-600 text-white rounded disabled:opacity-50"
          >
            Zapisz
          </button>
        </div>
      </div>
    )
  }

  const isInternal = alloc.allocation_type === 'internal'

  return (
    <div className="py-1.5 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 group">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
          {isInternal ? (
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 truncate">🏢 Wewnętrzne</span>
          ) : (
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{alloc.project?.name ?? '—'}</span>
          )}
          <CategoryBadge category={alloc.category || 'materials'} />
          {alloc.notes && <span className="text-xs text-gray-400 truncate">· {alloc.notes}</span>}
          {isInternal && (
            <button
              onClick={onTogglePaid}
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
                alloc.is_paid
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200'
                  : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200'
              }`}
              title="Kliknij aby zmienić status"
            >
              {alloc.is_paid ? '✅ Opłacono' : '💳 Nieopłacono'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-xs font-semibold tabular-nums text-gray-800 dark:text-gray-100">{fmt(alloc.amount)} {currency}</span>
          <button
            onClick={onEdit}
            className="p-0.5 text-gray-300 hover:text-violet-500 dark:text-gray-600 opacity-0 group-hover:opacity-100 transition-all"
            title="Edytuj"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-0.5 text-gray-300 hover:text-red-500 dark:text-gray-600 opacity-0 group-hover:opacity-100 transition-all"
            title="Usuń"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>
      {/* CFO taxonomy tags */}
      <div className="ml-4 mt-0.5">
        {alloc.allocation_type === 'revenue' ? (
          <RevenueBadges alloc={alloc} />
        ) : (
          <FinancialBadges alloc={alloc} />
        )}
      </div>
    </div>
  )
}
