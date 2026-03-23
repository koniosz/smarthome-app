import { useEffect, useRef, useState } from 'react'
import type { ProductCatalogItem, QuoteBrand } from '../types'
import { QUOTE_BRANDS, QUOTE_BRAND_COLORS, KNX_MANUFACTURERS } from '../types'
import { productCatalogApi } from '../api/client'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

const EMPTY_FORM: Partial<ProductCatalogItem> = {
  sku: '', brand: 'KNX', manufacturer: 'HDL', category: '', name: '', unit: 'szt.', unit_price: 0, description: '',
}

// Suggested manufacturers for each brand
const BRAND_MANUFACTURERS: Record<string, string[]> = {
  KNX: KNX_MANUFACTURERS as unknown as string[],
  Control4: ['Control4'],
  Hikvision: ['Hikvision'],
  Satel: ['Satel'],
}

// ─── Import Modal ──────────────────────────────────────────────────────────────
function ImportModal({
  onClose,
  defaultBrand,
  defaultManufacturer,
  onImported,
}: {
  onClose: () => void
  defaultBrand: QuoteBrand
  defaultManufacturer: string
  onImported: () => void
}) {
  const [brand, setBrand] = useState<QuoteBrand>(defaultBrand)
  const [manufacturer, setManufacturer] = useState(defaultManufacturer)
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<{ imported: number; replaced: number; brand: string; manufacturer: string } | null>(null)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const suggestions = BRAND_MANUFACTURERS[brand] ?? [brand]

  const handleFile = (f: File) => {
    const ext = f.name.toLowerCase().split('.').pop()
    if (!['xlsx', 'xls', 'pdf'].includes(ext ?? '')) {
      setError('Obsługiwane formaty: .xlsx, .xls, .pdf')
      return
    }
    setFile(f)
    setError('')
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }

  const handleImport = async () => {
    if (!file) { setError('Wybierz plik cennika.'); return }
    if (!manufacturer.trim()) { setError('Podaj nazwę producenta.'); return }
    setLoading(true)
    setError('')
    setProgress(10)
    try {
      const res = await productCatalogApi.importPricelist(file, brand, manufacturer.trim(), pct => {
        setProgress(10 + Math.round(pct * 0.4))
      })
      setProgress(100)
      setResult(res)
      onImported()
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Błąd importu. Sprawdź format pliku i spróbuj ponownie.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">📥 Importuj cennik producenta</h2>
            <p className="text-xs text-gray-400 mt-0.5">Prześlij plik Excel lub PDF — AI automatycznie wyodrębni produkty</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none">✕</button>
        </div>

        {result ? (
          /* Success state */
          <div className="px-6 py-8 text-center">
            <div className="text-5xl mb-4">✅</div>
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">Import zakończony!</h3>
            <p className="text-gray-600 dark:text-gray-400 text-sm mb-1">
              Zaimportowano <strong>{result.imported}</strong> produktów dla <strong>{result.brand} / {manufacturer}</strong>
            </p>
            {result.replaced > 0 && (
              <p className="text-gray-400 text-xs">Zastąpiono {result.replaced} poprzednich pozycji.</p>
            )}
            <button onClick={onClose}
              className="mt-6 px-6 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-lg transition-colors">
              Zamknij
            </button>
          </div>
        ) : (
          /* Form state */
          <div className="px-6 py-5 space-y-4">
            {/* Brand + Manufacturer */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Marka</label>
                <select
                  value={brand}
                  onChange={e => {
                    const b = e.target.value as QuoteBrand
                    setBrand(b)
                    setManufacturer(BRAND_MANUFACTURERS[b]?.[0] ?? b)
                  }}
                  className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                >
                  {QUOTE_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Producent</label>
                <input
                  list="mfr-suggestions"
                  value={manufacturer}
                  onChange={e => setManufacturer(e.target.value)}
                  placeholder="np. Eelectron"
                  className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                />
                <datalist id="mfr-suggestions">
                  {suggestions.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
            </div>

            {/* File drop zone */}
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Plik cennika</label>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                  dragOver
                    ? 'border-violet-400 bg-violet-50 dark:bg-violet-900/20'
                    : file
                      ? 'border-green-400 bg-green-50 dark:bg-green-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-violet-300 dark:hover:border-violet-600 hover:bg-gray-50 dark:hover:bg-gray-800/40'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.pdf"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                />
                {file ? (
                  <div>
                    <div className="text-2xl mb-1">{file.name.endsWith('.pdf') ? '📄' : '📊'}</div>
                    <p className="text-sm font-medium text-green-700 dark:text-green-400">{file.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{(file.size / 1024).toFixed(0)} KB — kliknij aby zmienić</p>
                  </div>
                ) : (
                  <div>
                    <div className="text-3xl mb-2">📂</div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Przeciągnij plik lub <span className="text-violet-600 dark:text-violet-400 font-medium">kliknij aby wybrać</span></p>
                    <p className="text-xs text-gray-400 mt-1">Excel (.xlsx, .xls) lub PDF — max 50 MB</p>
                  </div>
                )}
              </div>
            </div>

            {/* Warning about replacement */}
            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-700 dark:text-amber-400">
              <span className="mt-0.5 flex-shrink-0">⚠️</span>
              <span>Istniejące produkty <strong>{brand} / {manufacturer || '…'}</strong> zostaną zastąpione produktami z importowanego cennika.</span>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-400">
                <span className="mt-0.5">❌</span>
                <span>{error}</span>
              </div>
            )}

            {/* Progress bar */}
            {loading && (
              <div>
                <div className="flex justify-between text-xs text-gray-400 mb-1">
                  <span>AI analizuje cennik…</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                  <div className="bg-violet-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
          </div>
        )}

        {!result && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 dark:border-gray-800">
            <button onClick={onClose} disabled={loading}
              className="px-4 py-2 text-sm border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50">
              Anuluj
            </button>
            <button onClick={handleImport} disabled={loading || !file}
              className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-2">
              {loading ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Importuję…
                </>
              ) : '📥 Importuj i zastąp'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function ProductCatalogPage() {
  const [items, setItems] = useState<ProductCatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [brandFilter, setBrandFilter] = useState<QuoteBrand | 'all'>('all')
  const [mfrFilter, setMfrFilter] = useState<string>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuf, setEditBuf] = useState<Partial<ProductCatalogItem>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState<Partial<ProductCatalogItem>>(EMPTY_FORM)
  const [seeding, setSeeding] = useState(false)
  const [seedMsg, setSeedMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importDefaultBrand, setImportDefaultBrand] = useState<QuoteBrand>('KNX')
  const [importDefaultMfr, setImportDefaultMfr] = useState<string>('HDL')

  const load = () => {
    setLoading(true)
    productCatalogApi.listAll().then(data => {
      setItems(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  // When brand filter changes, reset manufacturer filter
  const handleBrandChange = (b: QuoteBrand | 'all') => {
    setBrandFilter(b)
    setMfrFilter('all')
  }

  // Manufacturers available for current brand filter
  const availableManufacturers = (() => {
    if (brandFilter === 'all') return []
    const brandItems = items.filter(i => i.brand === brandFilter && i.active !== false)
    const mfrs = Array.from(new Set(brandItems.map(i => i.manufacturer || i.brand)))
    return mfrs.sort()
  })()

  const filtered = (() => {
    let list = items
    if (brandFilter !== 'all') list = list.filter(i => i.brand === brandFilter)
    if (mfrFilter !== 'all') list = list.filter(i => (i.manufacturer || i.brand) === mfrFilter)
    return list
  })()

  const active = filtered.filter(i => i.active !== false)
  const inactive = filtered.filter(i => i.active === false)

  const handleSeed = async () => {
    setSeeding(true)
    setSeedMsg('')
    try {
      const res = await productCatalogApi.seed()
      if (res.already_seeded) {
        setSeedMsg(`Katalog już zawiera ${res.count} pozycji.`)
      } else {
        setSeedMsg(`Dodano ${res.seeded} domyślnych produktów (HDL/KNX, Control4, Hikvision, Satel)!`)
        load()
      }
    } catch {
      setSeedMsg('Błąd podczas ładowania katalogu.')
    } finally {
      setSeeding(false)
    }
  }

  const openImport = (brand?: QuoteBrand, mfr?: string) => {
    const b: QuoteBrand = brand ?? (brandFilter !== 'all' ? brandFilter : 'KNX')
    const m = mfr ?? (mfrFilter !== 'all' ? mfrFilter : (BRAND_MANUFACTURERS[b]?.[0] ?? b))
    setImportDefaultBrand(b)
    setImportDefaultMfr(m)
    setShowImport(true)
  }

  const handleDeletePricelist = async (brand: QuoteBrand, manufacturer: string) => {
    const cnt = items.filter(i => i.brand === brand && (i.manufacturer || i.brand) === manufacturer && i.active !== false).length
    if (!confirm(`Usunąć cały cennik "${manufacturer}" (${brand})?\n\nZostanie trwale usuniętych ${cnt} produktów. Tej operacji nie można cofnąć.`)) return
    try {
      const res = await productCatalogApi.deletePricelist(brand, manufacturer)
      alert(`✓ Usunięto ${res.deleted} produktów producenta ${manufacturer}.`)
      if (mfrFilter === manufacturer) setMfrFilter('all')
      load()
    } catch (err: any) {
      alert(`Błąd: ${err?.response?.data?.error ?? err?.message ?? 'Nie udało się usunąć cennika'}`)
    }
  }

  const startEdit = (item: ProductCatalogItem) => { setEditingId(item.id); setEditBuf({ ...item }) }
  const cancelEdit = () => { setEditingId(null); setEditBuf({}) }

  const commitEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const updated = await productCatalogApi.update(editingId, editBuf)
      setItems(prev => prev.map(i => i.id === editingId ? updated : i))
      setEditingId(null)
      setEditBuf({})
    } catch { alert('Błąd zapisu.') }
    finally { setSaving(false) }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Ukryć ten produkt? (soft delete)')) return
    await productCatalogApi.delete(id)
    setItems(prev => prev.map(i => i.id === id ? { ...i, active: false } : i))
  }

  const handleRestore = async (id: string) => {
    await productCatalogApi.update(id, { active: true })
    setItems(prev => prev.map(i => i.id === id ? { ...i, active: true } : i))
  }

  const handleAdd = async () => {
    if (!addForm.name || !addForm.brand || !addForm.unit) { alert('Uzupełnij: nazwę, markę i jednostkę.'); return }
    setSaving(true)
    try {
      const item = await productCatalogApi.create(addForm)
      setItems(prev => [...prev, item])
      setAddForm(EMPTY_FORM)
      setShowAdd(false)
    } catch { alert('Błąd dodawania.') }
    finally { setSaving(false) }
  }

  const BrandBadge = ({ brand }: { brand: QuoteBrand }) => (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${QUOTE_BRAND_COLORS[brand]}`}>{brand}</span>
  )

  const showMfrColumn = brandFilter === 'all' || availableManufacturers.length > 1

  const EditableRow = ({ item }: { item: ProductCatalogItem }) => {
    const isEditing = editingId === item.id
    return (
      <tr className={`group hover:bg-gray-50 dark:hover:bg-gray-800/30 text-xs ${!item.active ? 'opacity-40' : ''}`}>
        {isEditing ? (
          <>
            <td className="px-2 py-1.5">
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={editBuf.sku ?? ''} onChange={e => setEditBuf(b => ({ ...b, sku: e.target.value }))} />
            </td>
            <td className="px-2 py-1.5">
              <select className="w-full border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={editBuf.brand ?? 'KNX'} onChange={e => setEditBuf(b => ({ ...b, brand: e.target.value as QuoteBrand }))}>
                {QUOTE_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </td>
            <td className="px-2 py-1.5">
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={editBuf.manufacturer ?? ''} onChange={e => setEditBuf(b => ({ ...b, manufacturer: e.target.value }))} />
            </td>
            <td className="px-2 py-1.5">
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={editBuf.category ?? ''} onChange={e => setEditBuf(b => ({ ...b, category: e.target.value }))} />
            </td>
            <td className="px-2 py-1.5">
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={editBuf.name ?? ''} onChange={e => setEditBuf(b => ({ ...b, name: e.target.value }))} />
            </td>
            <td className="px-2 py-1.5">
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={editBuf.unit ?? ''} onChange={e => setEditBuf(b => ({ ...b, unit: e.target.value }))} />
            </td>
            <td className="px-2 py-1.5">
              <input type="number" min="0" step="1" className="w-full border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs text-right bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={editBuf.unit_price ?? 0} onChange={e => setEditBuf(b => ({ ...b, unit_price: Number(e.target.value) }))} />
            </td>
            <td className="px-2 py-1.5" colSpan={2}>
              <div className="flex gap-1">
                <button onClick={commitEdit} disabled={saving}
                  className="px-2 py-0.5 bg-green-600 hover:bg-green-700 text-white rounded text-xs disabled:opacity-50">✓</button>
                <button onClick={cancelEdit}
                  className="px-2 py-0.5 border border-gray-300 dark:border-gray-600 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded text-xs">✕</button>
              </div>
            </td>
          </>
        ) : (
          <>
            <td className="px-3 py-2 text-gray-400 font-mono">{item.sku}</td>
            <td className="px-3 py-2"><BrandBadge brand={item.brand} /></td>
            <td className="px-3 py-2 text-gray-500 dark:text-gray-400 font-medium text-xs">{item.manufacturer || item.brand}</td>
            <td className="px-3 py-2 text-gray-400">{item.category}</td>
            <td className="px-3 py-2 text-gray-700 dark:text-gray-300 max-w-xs truncate">{item.name}</td>
            <td className="px-3 py-2 text-gray-400">{item.unit}</td>
            <td className="px-3 py-2 text-right font-medium text-gray-700 dark:text-gray-300">{fmt(item.unit_price)} PLN</td>
            <td className="px-2 py-2">
              {item.active ? (
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => startEdit(item)}
                    className="text-xs text-gray-500 hover:text-violet-600 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700">✏️</button>
                  <button onClick={() => handleDelete(item.id)}
                    className="text-xs text-red-400 hover:text-red-600 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700">🗑</button>
                </div>
              ) : (
                <button onClick={() => handleRestore(item.id)}
                  className="text-xs text-green-500 hover:underline opacity-0 group-hover:opacity-100">Przywróć</button>
              )}
            </td>
          </>
        )}
      </tr>
    )
  }

  // Items count per brand (active only)
  const countByBrand = (b: QuoteBrand) => items.filter(i => i.brand === b && i.active !== false).length
  const countByMfr = (mfr: string) => items.filter(i => i.brand === brandFilter && (i.manufacturer || i.brand) === mfr && i.active !== false).length

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">📦 Katalog produktów</h1>
          <p className="text-sm text-gray-400 mt-0.5">Produkty KNX (HDL, Eelectron, Tyba, MDT), Control4, Hikvision, Satel</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => openImport()}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-1.5"
          >
            📥 Importuj cennik
          </button>
          <button
            onClick={() => setShowAdd(s => !s)}
            className="px-3 py-1.5 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
          >
            + Nowy produkt
          </button>
          <button
            onClick={handleSeed}
            disabled={seeding}
            className="px-3 py-1.5 text-sm font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
          >
            {seeding ? 'Ładuję…' : '🌱 Załaduj domyślny katalog'}
          </button>
        </div>
      </div>

      {seedMsg && (
        <div className="px-4 py-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-400">
          {seedMsg}
        </div>
      )}

      {/* Add product form */}
      {showAdd && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">Nowy produkt</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">SKU</label>
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                placeholder="np. KNX-TP-5701"
                value={addForm.sku ?? ''} onChange={e => setAddForm(f => ({ ...f, sku: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Marka *</label>
              <select className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={addForm.brand ?? 'KNX'} onChange={e => {
                  const b = e.target.value as QuoteBrand
                  setAddForm(f => ({ ...f, brand: b, manufacturer: BRAND_MANUFACTURERS[b]?.[0] ?? b }))
                }}>
                {QUOTE_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Producent *</label>
              <input
                list="add-mfr-suggestions"
                className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                placeholder="np. HDL"
                value={addForm.manufacturer ?? ''} onChange={e => setAddForm(f => ({ ...f, manufacturer: e.target.value }))} />
              <datalist id="add-mfr-suggestions">
                {(BRAND_MANUFACTURERS[addForm.brand ?? 'KNX'] ?? []).map(s => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Kategoria</label>
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                placeholder="np. Panel dotykowy"
                value={addForm.category ?? ''} onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))} />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Nazwa *</label>
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                placeholder="Pełna nazwa produktu"
                value={addForm.name ?? ''} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Jednostka *</label>
              <input className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                placeholder="szt."
                value={addForm.unit ?? ''} onChange={e => setAddForm(f => ({ ...f, unit: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Cena netto PLN *</label>
              <input type="number" min="0" step="1" className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={addForm.unit_price ?? 0} onChange={e => setAddForm(f => ({ ...f, unit_price: Number(e.target.value) }))} />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={handleAdd} disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition-colors">
              {saving ? 'Dodaję…' : 'Dodaj produkt'}
            </button>
            <button onClick={() => { setShowAdd(false); setAddForm(EMPTY_FORM) }}
              className="px-4 py-2 text-sm border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
              Anuluj
            </button>
          </div>
        </div>
      )}

      {/* Brand filter tabs */}
      <div className="space-y-2">
        <div className="flex gap-1 flex-wrap">
          {(['all', ...QUOTE_BRANDS] as const).map(b => (
            <button
              key={b}
              onClick={() => handleBrandChange(b)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                brandFilter === b
                  ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {b === 'all' ? `Wszystkie (${items.filter(i => i.active !== false).length})` : `${b} (${countByBrand(b)})`}
            </button>
          ))}
        </div>

        {/* Manufacturer sub-tabs (shown when a brand is selected and there are manufacturers) */}
        {brandFilter !== 'all' && (
          <div className="flex gap-1 flex-wrap items-center">
            <span className="text-xs text-gray-400 mr-1">Producent:</span>
            <button
              onClick={() => setMfrFilter('all')}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                mfrFilter === 'all'
                  ? 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-medium'
                  : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              Wszyscy ({countByBrand(brandFilter)})
            </button>
            {/* Show known manufacturers for the brand */}
            {(brandFilter === 'KNX' ? KNX_MANUFACTURERS as unknown as string[] : BRAND_MANUFACTURERS[brandFilter] ?? []).map(mfr => {
              const cnt = countByMfr(mfr)
              return (
                <button
                  key={mfr}
                  onClick={() => setMfrFilter(mfr)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors group flex items-center gap-1 ${
                    mfrFilter === mfr
                      ? 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-medium'
                      : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  {mfr} ({cnt})
                  <span
                    title={`Importuj cennik ${mfr}`}
                    onClick={e => { e.stopPropagation(); openImport(brandFilter, mfr) }}
                    className="opacity-0 group-hover:opacity-100 text-blue-500 hover:text-blue-700 transition-opacity cursor-pointer"
                  >📥</span>
                  {cnt > 0 && (
                    <span
                      title={`Usuń cennik ${mfr} (${cnt} produktów)`}
                      onClick={e => { e.stopPropagation(); handleDeletePricelist(brandFilter, mfr) }}
                      className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity cursor-pointer"
                    >🗑️</span>
                  )}
                </button>
              )
            })}
            {/* Show additional manufacturers found in DB but not in the default list */}
            {availableManufacturers
              .filter(m => !(brandFilter === 'KNX' ? KNX_MANUFACTURERS as unknown as string[] : BRAND_MANUFACTURERS[brandFilter] ?? []).includes(m))
              .map(mfr => (
                <button
                  key={mfr}
                  onClick={() => setMfrFilter(mfr)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors group flex items-center gap-1 ${
                    mfrFilter === mfr
                      ? 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-medium'
                      : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  {mfr} ({countByMfr(mfr)})
                  <span
                    title={`Importuj cennik ${mfr}`}
                    onClick={e => { e.stopPropagation(); openImport(brandFilter, mfr) }}
                    className="opacity-0 group-hover:opacity-100 text-blue-500 hover:text-blue-700 transition-opacity cursor-pointer"
                  >📥</span>
                  <span
                    title={`Usuń cennik ${mfr}`}
                    onClick={e => { e.stopPropagation(); handleDeletePricelist(brandFilter, mfr) }}
                    className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity cursor-pointer"
                  >🗑️</span>
                </button>
              ))
            }
            <button
              onClick={() => openImport(brandFilter, mfrFilter !== 'all' ? mfrFilter : undefined)}
              className="ml-2 px-2.5 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-md transition-colors"
            >
              + Importuj nowy cennik
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">Ładowanie…</div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 text-left">
                <th className="px-3 py-2.5 font-medium w-28">SKU</th>
                <th className="px-3 py-2.5 font-medium w-20">Marka</th>
                <th className="px-3 py-2.5 font-medium w-24">Producent</th>
                <th className="px-3 py-2.5 font-medium w-32">Kategoria</th>
                <th className="px-3 py-2.5 font-medium">Nazwa</th>
                <th className="px-3 py-2.5 font-medium w-14">J.m.</th>
                <th className="px-3 py-2.5 font-medium w-32 text-right">Cena netto</th>
                <th className="px-3 py-2.5 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {active.length === 0 && inactive.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-gray-400">
                    {mfrFilter !== 'all'
                      ? <>Brak produktów dla producenta <strong>{mfrFilter}</strong>. <button onClick={() => openImport(brandFilter !== 'all' ? brandFilter : 'KNX', mfrFilter)} className="text-blue-500 hover:underline">Importuj cennik</button>.</>
                      : <>Brak produktów. {items.length === 0 && <> Kliknij <strong>Załaduj domyślny katalog</strong>, aby dodać predefiniowane produkty.</>}</>
                    }
                  </td>
                </tr>
              ) : (
                <>
                  {active.map(item => <EditableRow key={item.id} item={item} />)}
                  {inactive.length > 0 && (
                    <>
                      <tr className="bg-gray-50 dark:bg-gray-800/40">
                        <td colSpan={8} className="px-3 py-1.5 text-xs text-gray-400 font-medium">
                          Ukryte ({inactive.length})
                        </td>
                      </tr>
                      {inactive.map(item => <EditableRow key={item.id} item={item} />)}
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <ImportModal
          defaultBrand={importDefaultBrand}
          defaultManufacturer={importDefaultMfr}
          onClose={() => setShowImport(false)}
          onImported={() => load()}
        />
      )}
    </div>
  )
}
