import { useRef, useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { api } from '../api/client'

interface AiQuoteExample {
  id: string
  title: string
  project_type: string
  brands: string[]
  area_m2: number | null
  rooms_count: number | null
  final_items: any[]
  final_total_net: number | null
  human_notes: string | null
  approved_by_name: string | null
  created_at: string
}

const PROJECT_TYPE_LABELS: Record<string, string> = {
  residential: 'Dom jednorodzinny',
  apartment: 'Apartament / mieszkanie',
  commercial: 'Biuro / komercyjny',
  other: 'Inny',
}

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

// ── Excel import helpers ───────────────────────────────────────────────────

interface ParsedItem {
  room: string
  brand: string
  category: string
  name: string
  qty: number
  unit: string
  unit_price: number
  discount_pct: number
  total: number
  catalog_item_id: null
  sort_order: number
}

function detectBrand(sectionName: string): string {
  const n = sectionName.toLowerCase()
  if (n.includes('knx')) return 'KNX'
  if (n.includes('control4') || n.includes('wizualizac')) return 'Control4'
  if (n.includes('hikvision') || n.includes('cctv') || n.includes('monitoring')) return 'Hikvision'
  if (n.includes('satel') || (n.includes('alarm') && !n.includes('knx'))) return 'Satel'
  if (n.includes('montaż') || n.includes('programow') || n.includes('konfigur') || n.includes('usług')) return 'Usługi'
  return 'Inne'
}

function detectCategory(sectionName: string): string {
  const n = sectionName.toLowerCase()
  if (n.includes('element') || n.includes('wykonawcz')) return 'Elementy wykonawcze'
  if (n.includes('panel') || n.includes('steruj') || n.includes('przycisk')) return 'Panel dotykowy'
  if (n.includes('wizualizac')) return 'Wizualizacja'
  if (n.includes('domofon')) return 'Domofon'
  if (n.includes('cctv') || n.includes('monitoring')) return 'Monitoring CCTV'
  if (n.includes('sieć') || n.includes('wifi') || n.includes('siec')) return 'Sieć i WiFi'
  if (n.includes('alarm') || n.includes('satel')) return 'Alarm'
  if (n.includes('montaż') || n.includes('programow') || n.includes('konfigur') || n.includes('usług')) return 'Usługi'
  return sectionName.replace(/^Zakres\s*/i, '').trim()
}

function parseExcelWycena(file: File): Promise<{ items: ParsedItem[]; totalNet: number; brands: string[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][]

        const items: ParsedItem[] = []
        let currentBrand = 'KNX'
        let currentCategory = 'Inne'
        let sortOrder = 0
        let totalNet = 0
        const brandsSet = new Set<string>()

        for (const row of rows) {
          const col0 = String(row[0] || '').trim()
          const col1 = row[1]
          const col2 = row[2]   // cena netto jedn.
          const col4 = row[4]   // wartość netto

          // Section header: non-empty name, qty is empty/string
          if (col0 && (col0.toLowerCase().startsWith('zakres') || col0.toLowerCase().includes('system')) && (col1 === '' || typeof col1 === 'string')) {
            currentBrand = detectBrand(col0)
            currentCategory = detectCategory(col0)
            continue
          }

          // Data row: non-empty name, qty is a positive number
          const qty = typeof col1 === 'number' ? col1 : parseFloat(String(col1))
          if (!col0 || isNaN(qty) || qty <= 0) continue

          // unit_price: prefer col2 (first net price column)
          const unitPrice = typeof col2 === 'number' ? col2 : parseFloat(String(col2)) || 0
          const total = typeof col4 === 'number' ? col4 : parseFloat(String(col4)) || (qty * unitPrice)

          brandsSet.add(currentBrand)
          totalNet += total

          items.push({
            room: currentCategory,  // use category as room grouping
            brand: currentBrand,
            category: currentCategory,
            name: col0,
            qty: Math.round(qty),
            unit: 'szt.',
            unit_price: Math.round(unitPrice * 100) / 100,
            discount_pct: 0,
            total: Math.round(total * 100) / 100,
            catalog_item_id: null,
            sort_order: sortOrder++,
          })
        }

        resolve({ items, totalNet: Math.round(totalNet * 100) / 100, brands: Array.from(brandsSet) })
      } catch (err) {
        reject(err)
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

export default function AiExamplesPage() {
  const [examples, setExamples] = useState<AiQuoteExample[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  // Import modal state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([])
  const [parsedTotal, setParsedTotal] = useState(0)
  const [parsedBrands, setParsedBrands] = useState<string[]>([])
  const [importForm, setImportForm] = useState({
    title: '',
    project_type: 'residential',
    area_m2: '',
    human_notes: '',
  })
  const [parseError, setParseError] = useState<string | null>(null)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setParseError(null)
    try {
      const { items, totalNet, brands } = await parseExcelWycena(file)
      if (items.length === 0) { setParseError('Nie znaleziono pozycji. Sprawdź format pliku.'); return }
      setParsedItems(items)
      setParsedTotal(totalNet)
      setParsedBrands(brands)
      if (!importForm.title) setImportForm(f => ({ ...f, title: file.name.replace(/\.[^.]+$/, '') }))
    } catch {
      setParseError('Błąd parsowania pliku. Upewnij się, że to plik .xlsx.')
    }
  }

  const handleImportSubmit = async () => {
    if (!importForm.title.trim() || parsedItems.length === 0) return
    setImporting(true)
    try {
      const res = await api.post('/api/ai-quote-examples', {
        title: importForm.title.trim(),
        project_type: importForm.project_type,
        brands: parsedBrands,
        area_m2: importForm.area_m2 ? Number(importForm.area_m2) : null,
        rooms_count: null,
        ai_items: null,
        final_items: parsedItems,
        final_total_net: parsedTotal,
        human_notes: importForm.human_notes.trim() || null,
        source_quote_id: null,
      })
      setExamples(prev => [res.data, ...prev])
      setImportOpen(false)
      setParsedItems([])
      setImportForm({ title: '', project_type: 'residential', area_m2: '', human_notes: '' })
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch {
      alert('Błąd zapisu wzorca. Spróbuj ponownie.')
    } finally {
      setImporting(false)
    }
  }

  useEffect(() => {
    api.get('/api/ai-quote-examples')
      .then(r => setExamples(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Usunąć wzorzec "${title}"?\n\nClaude przestanie go używać przy nowych wycenach.`)) return
    setDeleting(id)
    try {
      await api.delete(`/api/ai-quote-examples/${id}`)
      setExamples(prev => prev.filter(e => e.id !== id))
    } catch {
      alert('Błąd usuwania. Spróbuj ponownie.')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            🧠 Wzorce AI
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Zatwierdzone wyceny używane jako przykłady przy generowaniu nowych ofert AI.
            Claude uczy się z nich doboru urządzeń i zakresu instalacji.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setImportOpen(o => !o)}
            className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-xl transition-colors flex items-center gap-2"
          >
            📥 Importuj z Excel
          </button>
          <div className="text-right">
            <span className="text-2xl font-bold text-violet-600 dark:text-violet-400">{examples.length}</span>
            <p className="text-xs text-gray-500">wzorców</p>
          </div>
        </div>
      </div>

      {/* Info box */}
      <div className="bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 rounded-xl p-4 text-sm text-violet-800 dark:text-violet-300 flex gap-3">
        <span className="text-lg flex-shrink-0">💡</span>
        <div>
          <strong>Jak to działa?</strong> Przy każdej nowej wycenie AI, Claude automatycznie dostaje
          do 3 ostatnich wzorców jako przykłady. Im więcej wzorców, tym lepiej Claude rozumie specyfikę
          Twojej firmy — dobór urządzeń, zakres instalacji, typowe konfiguracje.
          <br/>
          <strong>Aby dodać wzorzec</strong> — otwórz gotową wycenę AI i kliknij przycisk <span className="font-mono bg-violet-100 dark:bg-violet-900 px-1 rounded">🧠 Wzorzec AI</span>.
        </div>
      </div>

      {/* Import from Excel panel */}
      {importOpen && (
        <div className="bg-white dark:bg-gray-900 border border-violet-200 dark:border-violet-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
            📥 Import wzorca z pliku Excel
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Obsługiwany format: plik .xlsx z sekcjami "Zakres Smart Home KNX…", "Zakres Wizualizacji" itp.
            Kolumny: Nazwa | Ilość | Cena netto | … | Wartość netto.
          </p>

          {/* File picker */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Plik Excel (.xlsx)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="text-sm text-gray-600 dark:text-gray-400"
            />
            {parseError && <p className="text-xs text-red-500 mt-1">{parseError}</p>}
          </div>

          {/* Parsed preview */}
          {parsedItems.length > 0 && (
            <>
              <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-lg p-3 text-xs text-green-800 dark:text-green-300 flex items-center gap-2">
                ✅ Wczytano <strong>{parsedItems.length} pozycji</strong> · Łącznie: <strong>{fmt(parsedTotal)} PLN netto</strong> · Marki: {parsedBrands.join(', ')}
              </div>

              {/* Form */}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Tytuł wzorca *</label>
                  <input
                    type="text"
                    value={importForm.title}
                    onChange={e => setImportForm(f => ({ ...f, title: e.target.value }))}
                    placeholder="np. Dom 320m² KNX+Satel+Control4"
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Typ projektu</label>
                  <select
                    value={importForm.project_type}
                    onChange={e => setImportForm(f => ({ ...f, project_type: e.target.value }))}
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                  >
                    <option value="residential">Dom jednorodzinny</option>
                    <option value="apartment">Apartament / mieszkanie</option>
                    <option value="commercial">Biuro / komercyjny</option>
                    <option value="other">Inny</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Metraż (m²)</label>
                  <input
                    type="number"
                    value={importForm.area_m2}
                    onChange={e => setImportForm(f => ({ ...f, area_m2: e.target.value }))}
                    placeholder="np. 320"
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Notatki (opcjonalne)</label>
                  <input
                    type="text"
                    value={importForm.human_notes}
                    onChange={e => setImportForm(f => ({ ...f, human_notes: e.target.value }))}
                    placeholder="np. Projekt z 2025, klient premium, pełny zakres KNX"
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                  />
                </div>
              </div>

              {/* Preview table */}
              <details className="text-xs">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 select-none">
                  Podgląd zaimportowanych pozycji ({parsedItems.length})
                </summary>
                <div className="mt-2 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden max-h-60 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">Sekcja/Kategoria</th>
                        <th className="px-3 py-1.5 text-left font-medium">Marka</th>
                        <th className="px-3 py-1.5 text-left font-medium">Nazwa</th>
                        <th className="px-3 py-1.5 text-right font-medium">Ilość</th>
                        <th className="px-3 py-1.5 text-right font-medium">Cena jedn.</th>
                        <th className="px-3 py-1.5 text-right font-medium">Razem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {parsedItems.map((item, i) => (
                        <tr key={i} className="text-gray-700 dark:text-gray-300">
                          <td className="px-3 py-1 text-gray-400 dark:text-gray-500 truncate max-w-[120px]">{item.category}</td>
                          <td className="px-3 py-1 font-medium">{item.brand}</td>
                          <td className="px-3 py-1 truncate max-w-[240px]">{item.name}</td>
                          <td className="px-3 py-1 text-right">{item.qty}</td>
                          <td className="px-3 py-1 text-right">{fmt(item.unit_price)}</td>
                          <td className="px-3 py-1 text-right font-medium">{fmt(item.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              <div className="flex gap-2">
                <button
                  onClick={handleImportSubmit}
                  disabled={importing || !importForm.title.trim()}
                  className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50 transition-colors"
                >
                  {importing ? 'Zapisywanie...' : '💾 Zapisz jako wzorzec AI'}
                </button>
                <button
                  onClick={() => { setImportOpen(false); setParsedItems([]); setParseError(null) }}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  Anuluj
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-violet-600 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Empty state */}
      {!loading && examples.length === 0 && (
        <div className="text-center py-16 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700">
          <div className="text-5xl mb-3">🧠</div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">Brak wzorców</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            Otwórz dowolną wycenę AI, popraw ją ręcznie jeśli trzeba,
            a następnie kliknij <strong>"🧠 Wzorzec AI"</strong> aby zapisać ją jako przykład dla Claude.
          </p>
        </div>
      )}

      {/* Examples list */}
      {!loading && examples.length > 0 && (
        <div className="space-y-3">
          {examples.map((ex, idx) => (
            <div key={ex.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              {/* Header row */}
              <div className="flex items-center gap-3 p-4">
                <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center text-violet-600 dark:text-violet-400 font-bold text-sm flex-shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-gray-900 dark:text-white text-sm">{ex.title}</h3>
                    <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded-full">
                      {PROJECT_TYPE_LABELS[ex.project_type] || ex.project_type}
                    </span>
                    {ex.area_m2 && (
                      <span className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full">
                        {ex.area_m2} m²
                      </span>
                    )}
                    {ex.brands && ex.brands.slice(0, 4).map((b: string) => (
                      <span key={b} className="text-xs bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400 px-2 py-0.5 rounded-full">
                        {b}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
                    <span>{ex.final_items?.length || 0} pozycji</span>
                    {ex.final_total_net && <span>{fmt(ex.final_total_net)} PLN netto</span>}
                    {ex.rooms_count && <span>{ex.rooms_count} pomieszczeń</span>}
                    <span>{new Date(ex.created_at).toLocaleDateString('pl-PL')}</span>
                    {ex.approved_by_name && <span>przez {ex.approved_by_name}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => setExpanded(expanded === ex.id ? null : ex.id)}
                    className="text-xs text-violet-600 dark:text-violet-400 hover:underline"
                  >
                    {expanded === ex.id ? 'Zwiń' : 'Podgląd'}
                  </button>
                  <button
                    onClick={() => handleDelete(ex.id, ex.title)}
                    disabled={deleting === ex.id}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors disabled:opacity-50"
                    title="Usuń wzorzec"
                  >
                    🗑
                  </button>
                </div>
              </div>

              {/* Human notes */}
              {ex.human_notes && (
                <div className="px-4 pb-3">
                  <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300">
                    <strong>Uwagi autora:</strong> {ex.human_notes}
                  </div>
                </div>
              )}

              {/* Expanded items */}
              {expanded === ex.id && ex.final_items && ex.final_items.length > 0 && (
                <div className="border-t border-gray-100 dark:border-gray-800">
                  <div className="p-3 max-h-72 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-400 dark:text-gray-500 text-left">
                          <th className="pb-1 pr-3">Pomieszczenie</th>
                          <th className="pb-1 pr-3">Nazwa</th>
                          <th className="pb-1 pr-3 text-right">Qty</th>
                          <th className="pb-1 text-right">Cena jedn.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                        {ex.final_items.map((item: any, i: number) => (
                          <tr key={i} className="text-gray-700 dark:text-gray-300">
                            <td className="py-1 pr-3 text-gray-400 dark:text-gray-500 truncate max-w-[100px]">{item.room}</td>
                            <td className="py-1 pr-3 truncate max-w-[260px]" title={item.name}>{item.name}</td>
                            <td className="py-1 pr-3 text-right">{item.qty}</td>
                            <td className="py-1 text-right font-mono">{fmt(item.unit_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
