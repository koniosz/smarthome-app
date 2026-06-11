import { useEffect, useRef, useState } from 'react'
import { Plug, Server, Spline, Cpu, Lightbulb, Package, Plus, Search, X, Upload, AlertTriangle, CheckCircle, Loader2, Pencil, Trash2, RotateCcw } from 'lucide-react'
import type { ProductCatalogItem, QuoteBrand } from '../types'
import { QUOTE_BRANDS, QUOTE_BRAND_COLORS, KNX_MANUFACTURERS } from '../types'
import { productCatalogApi } from '../api/client'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

const EMPTY_FORM: Partial<ProductCatalogItem> = {
  sku: '', brand: 'KNX', manufacturer: 'HDL', category: '', name: '', unit: 'szt.', unit_price: 0, description: '',
}

const BRAND_MANUFACTURERS: Record<string, string[]> = {
  KNX: KNX_MANUFACTURERS as unknown as string[],
  Control4: ['Control4'],
  Hikvision: ['Hikvision'],
  Satel: ['Satel'],
}

// ─── Category icon/color mapping ───────────────────────────────────────────────
type CategoryStyle = {
  bg: string
  fg: string
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; color?: string }>
}

function getCategoryStyle(category: string): CategoryStyle {
  const lower = (category ?? '').toLowerCase()
  if (lower.includes('osprzęt') || lower.includes('osprzet') || lower.includes('osprzętu')) {
    return { bg: '#eff6ff', fg: '#2563eb', Icon: Plug }
  }
  if (lower.includes('rozdzielni')) {
    return { bg: '#f1f5f9', fg: '#475569', Icon: Server }
  }
  if (lower.includes('przewod') || lower.includes('przewód') || lower.includes('kabel')) {
    return { bg: '#fffbeb', fg: '#b45309', Icon: Spline }
  }
  if (lower.includes('smart') || lower.includes('knx') || lower.includes('panel') || lower.includes('sterownik') || lower.includes('modul') || lower.includes('moduł')) {
    return { bg: '#f5f3ff', fg: '#7c3aed', Icon: Cpu }
  }
  if (lower.includes('oświetl') || lower.includes('oswietl') || lower.includes('lampa') || lower.includes('light')) {
    return { bg: '#f0fdfa', fg: '#0d9488', Icon: Lightbulb }
  }
  return { bg: '#f8fafc', fg: '#94a3b8', Icon: Package }
}

// ─── Input style helper ────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid #e2e8f0',
  fontSize: 14,
  color: '#0f172a',
  background: '#fff',
  outline: 'none',
  boxSizing: 'border-box',
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
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 50, padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        boxShadow: '0 24px 64px rgba(15,23,42,0.25)',
        width: '100%', maxWidth: 480,
        border: '1px solid #e2e8f0',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          padding: '20px 24px 16px', borderBottom: '1px solid #f1f5f9',
        }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>
              Importuj cennik producenta
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>
              Prześlij plik Excel lub PDF — AI automatycznie wyodrębni produkty
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#94a3b8', padding: 4, borderRadius: 6,
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {result ? (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: '#f0fdf4', display: 'flex', alignItems: 'center',
              justifyContent: 'center', margin: '0 auto 16px',
            }}>
              <CheckCircle size={28} color="#16a34a" strokeWidth={1.8} />
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: '0 0 8px' }}>
              Import zakończony!
            </h3>
            <p style={{ fontSize: 14, color: '#475569', margin: '0 0 4px' }}>
              Zaimportowano <strong>{result.imported}</strong> produktów dla{' '}
              <strong>{result.brand} / {manufacturer}</strong>
            </p>
            {result.replaced > 0 && (
              <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 20px' }}>
                Zastąpiono {result.replaced} poprzednich pozycji.
              </p>
            )}
            <button
              onClick={onClose}
              style={{
                marginTop: 20, padding: '10px 24px',
                background: '#2563eb', color: '#fff', border: 'none',
                borderRadius: 8, fontSize: 14, fontWeight: 600,
                cursor: 'pointer', boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
              }}
            >
              Zamknij
            </button>
          </div>
        ) : (
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Brand + Manufacturer */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>
                  Marka
                </label>
                <select
                  value={brand}
                  onChange={e => {
                    const b = e.target.value as QuoteBrand
                    setBrand(b)
                    setManufacturer(BRAND_MANUFACTURERS[b]?.[0] ?? b)
                  }}
                  style={{ ...inputStyle, fontSize: 13 }}
                >
                  {QUOTE_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>
                  Producent
                </label>
                <input
                  list="mfr-suggestions"
                  value={manufacturer}
                  onChange={e => setManufacturer(e.target.value)}
                  placeholder="np. Eelectron"
                  style={{ ...inputStyle, fontSize: 13 }}
                />
                <datalist id="mfr-suggestions">
                  {suggestions.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
            </div>

            {/* File drop zone */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>
                Plik cennika
              </label>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? '#2563eb' : file ? '#16a34a' : '#e2e8f0'}`,
                  borderRadius: 10, padding: '24px 16px', textAlign: 'center',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                  background: dragOver ? '#eff6ff' : file ? '#f0fdf4' : '#f8fafc',
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.pdf"
                  style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                />
                {file ? (
                  <div>
                    <Upload size={24} color="#16a34a" style={{ margin: '0 auto 8px' }} />
                    <p style={{ fontSize: 14, fontWeight: 600, color: '#15803d', margin: '0 0 2px' }}>
                      {file.name}
                    </p>
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
                      {(file.size / 1024).toFixed(0)} KB — kliknij aby zmienić
                    </p>
                  </div>
                ) : (
                  <div>
                    <Upload size={24} color="#94a3b8" style={{ margin: '0 auto 8px' }} />
                    <p style={{ fontSize: 14, color: '#475569', margin: '0 0 4px' }}>
                      Przeciągnij plik lub{' '}
                      <span style={{ color: '#7c3aed', fontWeight: 600 }}>kliknij aby wybrać</span>
                    </p>
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
                      Excel (.xlsx, .xls) lub PDF — max 50 MB
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Warning */}
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '10px 12px', background: '#fffbeb',
              border: '1px solid #fcd34d', borderRadius: 8,
            }}>
              <AlertTriangle size={14} color="#b45309" style={{ marginTop: 1, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: '#b45309' }}>
                Istniejące produkty <strong>{brand} / {manufacturer || '…'}</strong> zostaną zastąpione
                produktami z importowanego cennika.
              </span>
            </div>

            {error && (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '10px 12px', background: '#fef2f2',
                border: '1px solid #fecaca', borderRadius: 8,
              }}>
                <X size={14} color="#b91c1c" style={{ marginTop: 1, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: '#b91c1c' }}>{error}</span>
              </div>
            )}

            {loading && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                  <span>AI analizuje cennik…</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{progress}%</span>
                </div>
                <div style={{ width: '100%', background: '#f1f5f9', borderRadius: 999, height: 6 }}>
                  <div style={{
                    width: `${progress}%`, background: '#7c3aed',
                    height: 6, borderRadius: 999, transition: 'width 0.5s',
                  }} />
                </div>
              </div>
            )}
          </div>
        )}

        {!result && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
            padding: '16px 24px', borderTop: '1px solid #f1f5f9',
          }}>
            <button
              onClick={onClose}
              disabled={loading}
              style={{
                padding: '10px 18px', borderRadius: 8, border: '1px solid #e2e8f0',
                background: '#fff', color: '#475569', fontSize: 14, fontWeight: 500,
                cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
              }}
            >
              Anuluj
            </button>
            <button
              onClick={handleImport}
              disabled={loading || !file}
              style={{
                padding: '10px 18px', borderRadius: 8, border: 'none',
                background: '#7c3aed', color: '#fff', fontSize: 14, fontWeight: 600,
                cursor: loading || !file ? 'not-allowed' : 'pointer',
                opacity: loading || !file ? 0.5 : 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {loading ? (
                <>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  Importuję…
                </>
              ) : (
                <>
                  <Upload size={14} />
                  Importuj i zastąp
                </>
              )}
            </button>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// ─── Add Product Modal ─────────────────────────────────────────────────────────
function AddProductModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: (item: ProductCatalogItem) => void
}) {
  const [form, setForm] = useState<Partial<ProductCatalogItem>>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const handleAdd = async () => {
    if (!form.name || !form.brand || !form.unit) { alert('Uzupełnij: nazwę, markę i jednostkę.'); return }
    setSaving(true)
    try {
      const item = await productCatalogApi.create(form)
      onAdded(item)
      onClose()
    } catch { alert('Błąd dodawania.') }
    finally { setSaving(false) }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6,
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 50, padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        boxShadow: '0 24px 64px rgba(15,23,42,0.25)',
        width: '100%', maxWidth: 560,
        border: '1px solid #e2e8f0',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px 16px', borderBottom: '1px solid #f1f5f9',
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>
            Nowy produkt
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label style={labelStyle}>SKU</label>
            <input
              style={inputStyle} placeholder="np. KNX-TP-5701"
              value={form.sku ?? ''} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Marka *</label>
            <select
              style={inputStyle}
              value={form.brand ?? 'KNX'}
              onChange={e => {
                const b = e.target.value as QuoteBrand
                setForm(f => ({ ...f, brand: b, manufacturer: BRAND_MANUFACTURERS[b]?.[0] ?? b }))
              }}
            >
              {QUOTE_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Producent</label>
            <input
              list="add-mfr-suggestions"
              style={inputStyle} placeholder="np. HDL"
              value={form.manufacturer ?? ''}
              onChange={e => setForm(f => ({ ...f, manufacturer: e.target.value }))}
            />
            <datalist id="add-mfr-suggestions">
              {(BRAND_MANUFACTURERS[form.brand ?? 'KNX'] ?? []).map(s => <option key={s} value={s} />)}
            </datalist>
          </div>
          <div>
            <label style={labelStyle}>Kategoria</label>
            <input
              style={inputStyle} placeholder="np. Panel dotykowy"
              value={form.category ?? ''} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Nazwa *</label>
            <input
              style={inputStyle} placeholder="Pełna nazwa produktu"
              value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Jednostka *</label>
            <input
              style={inputStyle} placeholder="szt."
              value={form.unit ?? ''} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Cena netto PLN</label>
            <input
              type="number" min="0" step="1" style={{ ...inputStyle, fontVariantNumeric: 'tabular-nums' }}
              value={form.unit_price ?? 0}
              onChange={e => setForm(f => ({ ...f, unit_price: Number(e.target.value) }))}
            />
          </div>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '16px 24px', borderTop: '1px solid #f1f5f9',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '10px 18px', borderRadius: 8, border: '1px solid #e2e8f0',
              background: '#fff', color: '#475569', fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Anuluj
          </button>
          <button
            onClick={handleAdd}
            disabled={saving}
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
              boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
            }}
          >
            {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
            {saving ? 'Dodaję…' : 'Dodaj produkt'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Product Card ──────────────────────────────────────────────────────────────
function ProductCard({
  item,
  onEdit,
  onDelete,
  onRestore,
}: {
  item: ProductCatalogItem
  onEdit: (item: ProductCatalogItem) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const { bg, fg, Icon } = getCategoryStyle(item.category)
  const isInactive = item.active === false

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: 12,
        border: `1px solid ${hovered && !isInactive ? '#93c5fd' : '#e2e8f0'}`,
        background: '#fff',
        overflow: 'hidden',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered && !isInactive ? '0 4px 12px rgba(15,23,42,0.06)' : 'none',
        opacity: isInactive ? 0.45 : 1,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Top tile */}
      <div style={{
        height: 110, background: bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={30} color={fg} strokeWidth={1.7} />
      </div>

      {/* Card body */}
      <div style={{ padding: '16px 18px 18px', flex: 1, display: 'flex', flexDirection: 'column', gap: 0 }}>
        <p style={{
          fontSize: 14, fontWeight: 600, color: '#0f172a',
          lineHeight: 1.4, minHeight: 39, margin: '0 0 6px',
          display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {item.name}
        </p>

        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 12px' }}>
          {item.manufacturer || item.brand}
          {item.category ? ` · ${item.category}` : ''}
        </p>

        <p style={{ fontSize: 17, fontWeight: 700, color: '#0f172a', margin: '0 0 2px', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(item.unit_price)}{' '}
          <span style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8' }}>
            PLN netto / {item.unit}
          </span>
        </p>

        {item.sku && (
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '6px 0 0', fontFamily: 'monospace' }}>
            {item.sku}
          </p>
        )}
      </div>

      {/* Action buttons on hover */}
      {hovered && (
        <div style={{
          position: 'absolute', top: 8, right: 8,
          display: 'flex', gap: 4,
        }}>
          {item.active !== false ? (
            <>
              <button
                onClick={e => { e.stopPropagation(); onEdit(item) }}
                title="Edytuj"
                style={{
                  width: 28, height: 28, borderRadius: 7, border: '1px solid #e2e8f0',
                  background: '#fff', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  color: '#475569',
                }}
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onDelete(item.id) }}
                title="Usuń"
                style={{
                  width: 28, height: 28, borderRadius: 7, border: '1px solid #fecaca',
                  background: '#fff', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  color: '#b91c1c',
                }}
              >
                <Trash2 size={13} />
              </button>
            </>
          ) : (
            <button
              onClick={e => { e.stopPropagation(); onRestore(item.id) }}
              title="Przywróć"
              style={{
                padding: '4px 8px', borderRadius: 7, border: '1px solid #bbf7d0',
                background: '#f0fdf4', cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center', gap: 4,
                color: '#15803d', fontSize: 12, fontWeight: 600,
              }}
            >
              <RotateCcw size={12} />
              Przywróć
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Edit Product Modal ────────────────────────────────────────────────────────
function EditProductModal({
  item,
  onClose,
  onSaved,
}: {
  item: ProductCatalogItem
  onClose: () => void
  onSaved: (updated: ProductCatalogItem) => void
}) {
  const [buf, setBuf] = useState<Partial<ProductCatalogItem>>({ ...item })
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await productCatalogApi.update(item.id, buf)
      onSaved(updated)
      onClose()
    } catch { alert('Błąd zapisu.') }
    finally { setSaving(false) }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6,
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 50, padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        boxShadow: '0 24px 64px rgba(15,23,42,0.25)',
        width: '100%', maxWidth: 560,
        border: '1px solid #e2e8f0',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px 16px', borderBottom: '1px solid #f1f5f9',
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>
            Edytuj produkt
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label style={labelStyle}>SKU</label>
            <input
              style={inputStyle} value={buf.sku ?? ''}
              onChange={e => setBuf(b => ({ ...b, sku: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Marka</label>
            <select
              style={inputStyle}
              value={buf.brand ?? 'KNX'}
              onChange={e => setBuf(b => ({ ...b, brand: e.target.value as QuoteBrand }))}
            >
              {QUOTE_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Producent</label>
            <input
              style={inputStyle} value={buf.manufacturer ?? ''}
              onChange={e => setBuf(b => ({ ...b, manufacturer: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Kategoria</label>
            <input
              style={inputStyle} value={buf.category ?? ''}
              onChange={e => setBuf(b => ({ ...b, category: e.target.value }))}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Nazwa</label>
            <input
              style={inputStyle} value={buf.name ?? ''}
              onChange={e => setBuf(b => ({ ...b, name: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Jednostka</label>
            <input
              style={inputStyle} value={buf.unit ?? ''}
              onChange={e => setBuf(b => ({ ...b, unit: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Cena netto PLN</label>
            <input
              type="number" min="0" step="1"
              style={{ ...inputStyle, fontVariantNumeric: 'tabular-nums' }}
              value={buf.unit_price ?? 0}
              onChange={e => setBuf(b => ({ ...b, unit_price: Number(e.target.value) }))}
            />
          </div>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '16px 24px', borderTop: '1px solid #f1f5f9',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '10px 18px', borderRadius: 8, border: '1px solid #e2e8f0',
              background: '#fff', color: '#475569', fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Anuluj
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
              boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
            }}
          >
            {saving && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
            {saving ? 'Zapisuję…' : 'Zapisz zmiany'}
          </button>
        </div>
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
  const [search, setSearch] = useState('')
  const [editingItem, setEditingItem] = useState<ProductCatalogItem | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [seedMsg, setSeedMsg] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importDefaultBrand, setImportDefaultBrand] = useState<QuoteBrand>('KNX')
  const [importDefaultMfr, setImportDefaultMfr] = useState<string>('HDL')

  // Keep these for compatibility with existing logic that uses editingId + editBuf
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuf, setEditBuf] = useState<Partial<ProductCatalogItem>>({})
  const [saving, setSaving] = useState(false)
  const [addForm, setAddForm] = useState<Partial<ProductCatalogItem>>(EMPTY_FORM)

  const load = () => {
    setLoading(true)
    productCatalogApi.listAll().then(data => {
      setItems(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleBrandChange = (b: QuoteBrand | 'all') => {
    setBrandFilter(b)
    setMfrFilter('all')
  }

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
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(i =>
        i.name.toLowerCase().includes(q) ||
        (i.manufacturer || '').toLowerCase().includes(q) ||
        (i.sku || '').toLowerCase().includes(q)
      )
    }
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
      alert(`Usunięto ${res.deleted} produktów producenta ${manufacturer}.`)
      if (mfrFilter === manufacturer) setMfrFilter('all')
      load()
    } catch (err: any) {
      alert(`Błąd: ${err?.response?.data?.error ?? err?.message ?? 'Nie udało się usunąć cennika'}`)
    }
  }

  const startEdit = (item: ProductCatalogItem) => {
    setEditingId(item.id)
    setEditBuf({ ...item })
    setEditingItem(item)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditBuf({})
    setEditingItem(null)
  }

  const commitEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const updated = await productCatalogApi.update(editingId, editBuf)
      setItems(prev => prev.map(i => i.id === editingId ? updated : i))
      setEditingId(null)
      setEditBuf({})
      setEditingItem(null)
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

  // Stats
  const totalActive = items.filter(i => i.active !== false).length
  const totalCategories = new Set(items.filter(i => i.active !== false).map(i => i.category).filter(Boolean)).size

  // Category chips with counts
  const categoryChips = (() => {
    const map = new Map<string, number>()
    const base = brandFilter !== 'all'
      ? items.filter(i => i.brand === brandFilter && i.active !== false)
      : items.filter(i => i.active !== false)
    for (const item of base) {
      if (item.category) {
        map.set(item.category, (map.get(item.category) ?? 0) + 1)
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  })()

  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [showAllCategories, setShowAllCategories] = useState(false)

  const displayItems = (() => {
    if (categoryFilter === 'all') return { active, inactive }
    const a = active.filter(i => i.category === categoryFilter)
    const n = inactive.filter(i => i.category === categoryFilter)
    return { active: a, inactive: n }
  })()

  const countByBrand = (b: QuoteBrand) => items.filter(i => i.brand === b && i.active !== false).length
  const countByMfr = (mfr: string) => items.filter(i => i.brand === brandFilter && (i.manufacturer || i.brand) === mfr && i.active !== false).length

  const BrandBadge = ({ brand }: { brand: QuoteBrand }) => (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${QUOTE_BRAND_COLORS[brand]}`}>{brand}</span>
  )
  void BrandBadge // used in hidden table below

  return (
    <div style={{
      padding: '36px 32px 64px',
      background: '#f8fafc',
      minHeight: '100vh',
      fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto' }}>

        {/* ── Page Header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28, gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{
              fontSize: 24, fontWeight: 700, color: '#0f172a',
              margin: 0, letterSpacing: '-0.01em',
            }}>
              Katalog produktów
            </h1>
            <p style={{ fontSize: 14, color: '#64748b', margin: '6px 0 0', fontVariantNumeric: 'tabular-nums' }}>
              {totalActive} produktów · {totalCategories} kategorii
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={() => openImport()}
              style={{
                padding: '10px 18px', borderRadius: 8, border: '1px solid #e2e8f0',
                background: '#fff', color: '#475569', fontSize: 14, fontWeight: 500,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <Upload size={15} />
              Importuj cennik
            </button>
            <button
              onClick={handleSeed}
              disabled={seeding}
              style={{
                padding: '10px 18px', borderRadius: 8, border: '1px solid #e2e8f0',
                background: '#fff', color: '#475569', fontSize: 14, fontWeight: 500,
                cursor: seeding ? 'not-allowed' : 'pointer', opacity: seeding ? 0.6 : 1,
              }}
            >
              {seeding ? 'Ładuję…' : 'Załaduj katalog'}
            </button>
            <button
              onClick={() => setShowAdd(true)}
              style={{
                padding: '10px 18px', borderRadius: 8, border: 'none',
                background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
              }}
            >
              <Plus size={15} />
              Dodaj produkt
            </button>
          </div>
        </div>

        {/* Seed message */}
        {seedMsg && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '12px 16px', borderRadius: 10,
            background: '#f0fdf4', border: '1px solid #bbf7d0',
            fontSize: 14, color: '#15803d', marginBottom: 20,
          }}>
            <CheckCircle size={16} />
            {seedMsg}
          </div>
        )}

        {/* ── Filters Row ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          marginBottom: 20, flexWrap: 'wrap',
        }}>
          {/* Search */}
          <div style={{ position: 'relative', width: 300, flexShrink: 0 }}>
            <Search size={15} color="#94a3b8" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Szukaj produktu lub producenta…"
              style={{
                ...inputStyle,
                paddingLeft: 36,
                fontSize: 14,
              }}
            />
          </div>

          {/* Vertical separator */}
          <div style={{ width: 1, height: 28, background: '#e2e8f0', flexShrink: 0 }} />

          {/* Brand chips */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['all', ...QUOTE_BRANDS] as const).map(b => {
              const cnt = b === 'all'
                ? items.filter(i => i.active !== false).length
                : countByBrand(b)
              const active_ = brandFilter === b
              return (
                <button
                  key={b}
                  onClick={() => { handleBrandChange(b); setCategoryFilter('all') }}
                  style={{
                    padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                    border: `1px solid ${active_ ? '#93c5fd' : '#e2e8f0'}`,
                    background: active_ ? '#eff6ff' : '#fff',
                    color: active_ ? '#2563eb' : '#475569',
                    cursor: 'pointer', transition: 'all 0.12s',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {b === 'all' ? 'Wszystkie' : b} {cnt}
                </button>
              )
            })}
          </div>
        </div>

        {/* Manufacturer sub-filter */}
        {brandFilter !== 'all' && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#94a3b8', marginRight: 2 }}>Producent:</span>
            <button
              onClick={() => setMfrFilter('all')}
              style={{
                padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                border: `1px solid ${mfrFilter === 'all' ? '#93c5fd' : '#e2e8f0'}`,
                background: mfrFilter === 'all' ? '#eff6ff' : '#fff',
                color: mfrFilter === 'all' ? '#2563eb' : '#64748b',
                cursor: 'pointer',
              }}
            >
              Wszyscy ({countByBrand(brandFilter)})
            </button>
            {(brandFilter === 'KNX' ? KNX_MANUFACTURERS as unknown as string[] : BRAND_MANUFACTURERS[brandFilter] ?? []).map(mfr => {
              const cnt = countByMfr(mfr)
              return (
                <button
                  key={mfr}
                  onClick={() => setMfrFilter(mfr)}
                  style={{
                    padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                    border: `1px solid ${mfrFilter === mfr ? '#93c5fd' : '#e2e8f0'}`,
                    background: mfrFilter === mfr ? '#eff6ff' : '#fff',
                    color: mfrFilter === mfr ? '#2563eb' : '#64748b',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                  }}
                  className="group"
                >
                  {mfr} ({cnt})
                  <span
                    title={`Importuj cennik ${mfr}`}
                    onClick={e => { e.stopPropagation(); openImport(brandFilter, mfr) }}
                    style={{ color: '#2563eb', cursor: 'pointer', display: 'inline-flex' }}
                  >
                    <Upload size={11} />
                  </span>
                  {cnt > 0 && (
                    <span
                      title={`Usuń cennik ${mfr}`}
                      onClick={e => { e.stopPropagation(); handleDeletePricelist(brandFilter, mfr) }}
                      style={{ color: '#b91c1c', cursor: 'pointer', display: 'inline-flex' }}
                    >
                      <Trash2 size={11} />
                    </span>
                  )}
                </button>
              )
            })}
            {availableManufacturers
              .filter(m => !(brandFilter === 'KNX' ? KNX_MANUFACTURERS as unknown as string[] : BRAND_MANUFACTURERS[brandFilter] ?? []).includes(m))
              .map(mfr => (
                <button
                  key={mfr}
                  onClick={() => setMfrFilter(mfr)}
                  style={{
                    padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                    border: `1px solid ${mfrFilter === mfr ? '#93c5fd' : '#e2e8f0'}`,
                    background: mfrFilter === mfr ? '#eff6ff' : '#fff',
                    color: mfrFilter === mfr ? '#2563eb' : '#64748b',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  {mfr} ({countByMfr(mfr)})
                  <span onClick={e => { e.stopPropagation(); openImport(brandFilter, mfr) }} style={{ color: '#2563eb', display: 'inline-flex' }}>
                    <Upload size={11} />
                  </span>
                  <span onClick={e => { e.stopPropagation(); handleDeletePricelist(brandFilter, mfr) }} style={{ color: '#b91c1c', display: 'inline-flex' }}>
                    <Trash2 size={11} />
                  </span>
                </button>
              ))
            }
            <button
              onClick={() => openImport(brandFilter, mfrFilter !== 'all' ? mfrFilter : undefined)}
              style={{
                padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                border: '1px solid #93c5fd', background: '#fff',
                color: '#2563eb', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Plus size={11} />
              Importuj cennik
            </button>
          </div>
        )}

        {/* Category chips */}
        {categoryChips.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 24, flexWrap: 'wrap' }}>
            <button
              onClick={() => setCategoryFilter('all')}
              style={{
                padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                border: `1px solid ${categoryFilter === 'all' ? '#93c5fd' : '#e2e8f0'}`,
                background: categoryFilter === 'all' ? '#eff6ff' : '#fff',
                color: categoryFilter === 'all' ? '#2563eb' : '#475569',
                cursor: 'pointer',
              }}
            >
              Wszystkie
            </button>
            {(showAllCategories ? categoryChips : categoryChips.slice(0, 11)).map(([cat, cnt]) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                style={{
                  padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                  border: `1px solid ${categoryFilter === cat ? '#93c5fd' : '#e2e8f0'}`,
                  background: categoryFilter === cat ? '#eff6ff' : '#fff',
                  color: categoryFilter === cat ? '#2563eb' : '#475569',
                  cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
                }}
              >
                {cat} {cnt}
              </button>
            ))}
            {categoryChips.length > 11 && (
              <button
                onClick={() => setShowAllCategories(s => !s)}
                style={{
                  padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                  border: '1px dashed #cbd5e1', background: '#fff',
                  color: '#2563eb', cursor: 'pointer',
                }}
              >
                {showAllCategories ? 'Zwiń kategorie' : `+${categoryChips.length - 11} więcej`}
              </button>
            )}
          </div>
        )}

        {/* ── Product Grid ── */}
        {loading ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '80px 0', gap: 10, color: '#94a3b8', fontSize: 14,
          }}>
            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
            Ładowanie katalogu…
          </div>
        ) : displayItems.active.length === 0 && displayItems.inactive.length === 0 ? (
          <div style={{
            borderRadius: 12, border: '1px solid #e2e8f0',
            background: '#fff', padding: '64px 24px',
            textAlign: 'center',
          }}>
            <Package size={32} color="#e2e8f0" style={{ margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, color: '#94a3b8', margin: 0 }}>
              {search || categoryFilter !== 'all' || mfrFilter !== 'all'
                ? 'Brak produktów spełniających kryteria.'
                : items.length === 0
                  ? 'Katalog jest pusty. Kliknij "Załaduj katalog", aby dodać domyślne produkty.'
                  : 'Brak produktów spełniających kryteria.'
              }
            </p>
            {mfrFilter !== 'all' && (
              <button
                onClick={() => openImport(brandFilter !== 'all' ? brandFilter : 'KNX', mfrFilter)}
                style={{
                  marginTop: 12, padding: '8px 16px', borderRadius: 8,
                  border: '1px solid #93c5fd', background: '#eff6ff',
                  color: '#2563eb', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Importuj cennik {mfrFilter}
              </button>
            )}
          </div>
        ) : (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 20,
            }}>
              {displayItems.active.map(item => (
                <ProductCard
                  key={item.id}
                  item={item}
                  onEdit={startEdit}
                  onDelete={handleDelete}
                  onRestore={handleRestore}
                />
              ))}
            </div>

            {displayItems.inactive.length > 0 && (
              <div style={{ marginTop: 32 }}>
                <p style={{
                  fontSize: 12, fontWeight: 600, color: '#94a3b8',
                  letterSpacing: '0.05em', textTransform: 'uppercase',
                  marginBottom: 14,
                }}>
                  Ukryte ({displayItems.inactive.length})
                </p>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                  gap: 20,
                }}>
                  {displayItems.inactive.map(item => (
                    <ProductCard
                      key={item.id}
                      item={item}
                      onEdit={startEdit}
                      onDelete={handleDelete}
                      onRestore={handleRestore}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Modals ── */}
      {showAdd && (
        <AddProductModal
          onClose={() => setShowAdd(false)}
          onAdded={item => setItems(prev => [...prev, item])}
        />
      )}

      {editingItem && (
        <EditProductModal
          item={editingItem}
          onClose={cancelEdit}
          onSaved={updated => {
            setItems(prev => prev.map(i => i.id === updated.id ? updated : i))
            setEditingId(null)
            setEditBuf({})
            setEditingItem(null)
          }}
        />
      )}

      {showImport && (
        <ImportModal
          defaultBrand={importDefaultBrand}
          defaultManufacturer={importDefaultMfr}
          onClose={() => setShowImport(false)}
          onImported={() => load()}
        />
      )}

      {/* Spin keyframe for Loader2 */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
