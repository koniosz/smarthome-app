import { useState, useEffect, useRef } from 'react'
import { employeesApi } from '../../api/client'
import type { Employee, EmployeeDetail, EmployeeAsset, EmployeeDocument } from '../../types'

// ── Constants ──────────────────────────────────────────────────────────────────
const EMPLOYMENT_TYPES: Record<string, { label: string; color: string; bg: string }> = {
  employment: { label: 'Umowa o pracę', color: 'text-blue-700 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/30' },
  b2b:        { label: 'B2B',           color: 'text-violet-700 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-950/30' },
  subcontractor: { label: 'Podwykonawca', color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/30' },
}

const ASSET_TYPES: Record<string, string> = {
  computer: '💻 Komputer',
  phone: '📱 Telefon',
  car: '🚗 Samochód służbowy',
  tablet: '📋 Tablet',
  tools: '🔧 Narzędzia',
  other: '📦 Inne',
}

const DOC_TYPES: Record<string, string> = {
  contract:  '📄 Umowa o pracę',
  annex:     '📎 Aneks',
  medical:   '🏥 Medycyna pracy',
  bhp:       '⛑️ Szkolenie BHP',
  other:     '📁 Inny dokument',
}

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(s?: string | null) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('pl-PL')
}

function expiryStatus(expiresAt?: string | null): 'ok' | 'soon' | 'expired' | null {
  if (!expiresAt) return null
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000)
  if (days < 0) return 'expired'
  if (days <= 30) return 'soon'
  return 'ok'
}

// ── Employee Form Modal ────────────────────────────────────────────────────────
function EmployeeFormModal({ initial, onClose, onSaved }: {
  initial?: Employee
  onClose: () => void
  onSaved: (emp: Employee) => void
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    hourly_rate: initial ? String(initial.hourly_rate) : '',
    employment_type: initial?.employment_type ?? 'employment',
    position: initial?.position ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    address: initial?.address ?? '',
    start_date: initial?.start_date ?? '',
    end_date: initial?.end_date ?? '',
    notes: initial?.notes ?? '',
    medical_exam_last_date: initial?.medical_exam_last_date ?? '',
    medical_exam_date: initial?.medical_exam_date ?? '',
    bhp_last_date: initial?.bhp_last_date ?? '',
    bhp_date: initial?.bhp_date ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Imię i nazwisko jest wymagane'); return }
    setSaving(true); setError('')
    try {
      const data = {
        ...form,
        hourly_rate: parseFloat(form.hourly_rate) || 0,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
      }
      const result = initial
        ? await employeesApi.update(initial.id, data)
        : await employeesApi.create(data)
      onSaved(result); onClose()
    } catch { setError('Błąd zapisu.') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{initial ? 'Edytuj pracownika' : 'Dodaj pracownika'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Imię i nazwisko *</label>
              <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.name} onChange={e => set('name', e.target.value)} placeholder="np. Jan Kowalski" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Stanowisko</label>
              <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.position} onChange={e => set('position', e.target.value)} placeholder="np. Monter" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Forma zatrudnienia</label>
              <select className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.employment_type} onChange={e => set('employment_type', e.target.value)}>
                <option value="employment">Umowa o pracę</option>
                <option value="b2b">B2B</option>
                <option value="subcontractor">Podwykonawca</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Stawka godzinowa (PLN/h)</label>
              <input type="number" min="0" step="1" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.hourly_rate} onChange={e => set('hourly_rate', e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Email</label>
              <input type="email" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.email} onChange={e => set('email', e.target.value)} placeholder="jan@firma.pl" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Telefon</label>
              <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+48 600 000 000" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Adres</label>
              <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.address} onChange={e => set('address', e.target.value)} placeholder="ul. Przykładowa 1, 00-000 Warszawa" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data zatrudnienia</label>
              <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.start_date ?? ''} onChange={e => set('start_date', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data zakończenia</label>
              <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.end_date ?? ''} onChange={e => set('end_date', e.target.value)} />
            </div>
            {/* Separator */}
            <div className="col-span-2 pt-1">
              <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide border-t border-gray-100 dark:border-gray-800 pt-3">🩺 Badania medycyny pracy</div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data ostatnich badań</label>
              <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.medical_exam_last_date ?? ''} onChange={e => set('medical_exam_last_date', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data następnych badań (ważność)</label>
              <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.medical_exam_date ?? ''} onChange={e => set('medical_exam_date', e.target.value)} />
            </div>
            {/* BHP */}
            <div className="col-span-2 pt-1">
              <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide border-t border-gray-100 dark:border-gray-800 pt-3">🦺 Szkolenie BHP</div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data ostatniego szkolenia</label>
              <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.bhp_last_date ?? ''} onChange={e => set('bhp_last_date', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data następnego szkolenia (ważność)</label>
              <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.bhp_date ?? ''} onChange={e => set('bhp_date', e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notatki</label>
              <textarea rows={2} className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Dodatkowe informacje..." />
            </div>
          </div>
          {error && <div className="text-sm text-red-500">{error}</div>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie...' : (initial ? 'Zapisz' : 'Dodaj')}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Asset Form Modal ───────────────────────────────────────────────────────────
function AssetModal({ employeeId, initial, onClose, onSaved }: {
  employeeId: string
  initial?: EmployeeAsset
  onClose: () => void
  onSaved: (asset: EmployeeAsset) => void
}) {
  const [form, setForm] = useState({
    asset_type: initial?.asset_type ?? 'computer',
    name: initial?.name ?? '',
    serial_no: initial?.serial_no ?? '',
    notes: initial?.notes ?? '',
    assigned_at: initial?.assigned_at ?? new Date().toISOString().slice(0, 10),
    car_inspection_date: initial?.car_inspection_date ?? '',
    car_insurance_date: initial?.car_insurance_date ?? '',
  })
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const result = initial
        ? await employeesApi.updateAsset(initial.id, form)
        : await employeesApi.addAsset(employeeId, form)
      onSaved(result); onClose()
    } catch {}
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{initial ? 'Edytuj asset' : 'Dodaj asset'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Typ</label>
            <select className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.asset_type} onChange={e => set('asset_type', e.target.value)}>
              {Object.entries(ASSET_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nazwa / Model *</label>
            <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.name} onChange={e => set('name', e.target.value)} placeholder="np. MacBook Pro 14" autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nr seryjny / rejestracyjny</label>
            <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.serial_no} onChange={e => set('serial_no', e.target.value)} placeholder="SN/REJ" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data przydzielenia</label>
            <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.assigned_at} onChange={e => set('assigned_at', e.target.value)} />
          </div>
          {form.asset_type === 'car' && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data ważności badań technicznych</label>
                <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.car_inspection_date ?? ''} onChange={e => set('car_inspection_date', e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data końca ubezpieczenia</label>
                <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.car_insurance_date ?? ''} onChange={e => set('car_insurance_date', e.target.value)} />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Uwagi</label>
            <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Opcjonalne uwagi" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie...' : 'Zapisz'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Document Upload Modal ─────────────────────────────────────────────────────
function DocumentModal({ employeeId, onClose, onSaved }: {
  employeeId: string
  onClose: () => void
  onSaved: (doc: EmployeeDocument) => void
}) {
  const [form, setForm] = useState({ doc_type: 'contract', name: '', expires_at: '', notes: '' })
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))
  const needsExpiry = ['medical', 'bhp'].includes(form.doc_type)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) {
      setFile(f)
      if (!form.name) setForm(prev => ({ ...prev, name: f.name.replace(/\.[^.]+$/, '') }))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) { setError('Wybierz plik'); return }
    setSaving(true); setError('')
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await employeesApi.uploadDocument(employeeId, {
        doc_type: form.doc_type,
        name: form.name || file.name,
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_data: base64,
        expires_at: form.expires_at || null,
        notes: form.notes,
      })
      onSaved(result); onClose()
    } catch { setError('Błąd przesyłania.') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Wgraj dokument</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Typ dokumentu</label>
            <select className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.doc_type} onChange={e => set('doc_type', e.target.value)}>
              {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Plik *</label>
            <div
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center cursor-pointer hover:border-violet-400 transition-colors"
            >
              {file ? (
                <div className="text-sm text-violet-600 font-medium">📎 {file.name}</div>
              ) : (
                <div className="text-sm text-gray-400">Kliknij aby wybrać plik (PDF, JPG, PNG)</div>
              )}
            </div>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={handleFile} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nazwa dokumentu</label>
            <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.name} onChange={e => set('name', e.target.value)} placeholder="np. Umowa o pracę 2024" />
          </div>
          {needsExpiry && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data ważności *</label>
              <input type="date" className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.expires_at} onChange={e => set('expires_at', e.target.value)} />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Uwagi</label>
            <input className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Opcjonalne uwagi" />
          </div>
          {error && <div className="text-sm text-red-500">{error}</div>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Przesyłanie...' : 'Wgraj'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Employee Detail Panel ─────────────────────────────────────────────────────
function EmployeeDetailPanel({ employee, onClose, onUpdated, onDeleted }: {
  employee: Employee
  onClose: () => void
  onUpdated: (emp: Employee) => void
  onDeleted: (id: string) => void
}) {
  const [detail, setDetail] = useState<EmployeeDetail | null>(null)
  const [tab, setTab] = useState<'info' | 'assets' | 'documents'>('info')
  const [editing, setEditing] = useState(false)
  const [showAssetModal, setShowAssetModal] = useState(false)
  const [editingAsset, setEditingAsset] = useState<EmployeeAsset | null>(null)
  const [showDocModal, setShowDocModal] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)

  const load = async () => {
    try {
      const data = await employeesApi.get(employee.id)
      setDetail(data)
    } catch {}
  }

  useEffect(() => { load() }, [employee.id])

  const handleDelete = async () => {
    if (!confirm(`Usunąć pracownika "${employee.name}"? Zostaną usunięte wszystkie jego assety i dokumenty.`)) return
    await employeesApi.delete(employee.id)
    onDeleted(employee.id)
    onClose()
  }

  const handleDeleteAsset = async (assetId: string) => {
    if (!confirm('Usunąć asset?')) return
    await employeesApi.deleteAsset(assetId)
    setDetail(d => d ? { ...d, assets: d.assets.filter(a => a.id !== assetId) } : d)
  }

  const handleDeleteDoc = async (docId: string) => {
    if (!confirm('Usunąć dokument?')) return
    await employeesApi.deleteDocument(docId)
    setDetail(d => d ? { ...d, documents: d.documents.filter(doc => doc.id !== docId) } : d)
  }

  const handleDownload = async (doc: EmployeeDocument) => {
    setDownloading(doc.id)
    try {
      const blob = await employeesApi.downloadDocument(doc.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = doc.file_name; a.click()
      URL.revokeObjectURL(url)
    } catch {}
    finally { setDownloading(null) }
  }

  const et = EMPLOYMENT_TYPES[detail?.employment_type ?? employee.employment_type] ?? EMPLOYMENT_TYPES.employment

  // Count expiring docs for badge
  const expiringCount = detail?.documents.filter(d => {
    const s = expiryStatus(d.expires_at)
    return s === 'soon' || s === 'expired'
  }).length ?? 0

  return (
    <div className="fixed inset-0 z-40 flex" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ml-auto w-full max-w-2xl bg-white dark:bg-gray-900 shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 bg-gradient-to-r from-violet-600 to-violet-700">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">👤</span>
              <h2 className="text-lg font-bold text-white">{employee.name}</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/20 text-white">{et.label}</span>
              {employee.position && <span className="text-violet-200 text-sm">{employee.position}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditing(true)} className="px-3 py-1.5 text-xs font-medium bg-white/20 hover:bg-white/30 text-white rounded-lg transition-colors">✏️ Edytuj</button>
            <button onClick={handleDelete} className="px-3 py-1.5 text-xs font-medium bg-red-500/30 hover:bg-red-500/50 text-white rounded-lg transition-colors">🗑</button>
            <button onClick={onClose} className="text-white/70 hover:text-white text-xl ml-2">✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          {([['info', '📋 Informacje'], ['assets', `💼 Assety${detail ? ` (${detail.assets.length})` : ''}`], ['documents', `📁 Dokumenty${expiringCount > 0 ? ` ⚠️${expiringCount}` : (detail ? ` (${detail.documents.length})` : '')}`]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === key ? 'border-violet-600 text-violet-600 dark:text-violet-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
            >{label}</button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!detail ? (
            <div className="text-center text-gray-400 py-10">Ładowanie...</div>
          ) : tab === 'info' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {[
                  ['📧 Email', detail.email],
                  ['📞 Telefon', detail.phone],
                  ['📍 Adres', detail.address],
                  ['💰 Stawka', detail.hourly_rate ? `${fmt(detail.hourly_rate)} PLN/h` : null],
                  ['📅 Zatrudniony od', detail.start_date ? fmtDate(detail.start_date) : null],
                  ['📅 Zakończenie', detail.end_date ? fmtDate(detail.end_date) : null],
                ].map(([label, value]) => value ? (
                  <div key={String(label)} className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3">
                    <div className="text-xs text-gray-400 mb-0.5">{label}</div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{value}</div>
                  </div>
                ) : null)}
              </div>
              {/* Badania medycyny pracy */}
              {(detail.medical_exam_last_date || detail.medical_exam_date) && (() => {
                const s = expiryStatus(detail.medical_exam_date)
                return (
                  <div className={`rounded-xl border px-4 py-3 space-y-2 ${s === 'expired' ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800' : s === 'soon' ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800' : 'bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-700'}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">🩺 Badania medycyny pracy</span>
                      {s === 'expired' && <span className="text-xs font-bold text-red-600 dark:text-red-400">❌ Wygasłe!</span>}
                      {s === 'soon'    && <span className="text-xs font-bold text-amber-600 dark:text-amber-400">⚠️ Wygasa wkrótce</span>}
                      {s === 'ok'      && <span className="text-xs font-bold text-green-600 dark:text-green-400">✅ Ważne</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {detail.medical_exam_last_date && (
                        <div>
                          <div className="text-xs text-gray-400 mb-0.5">Data ostatnich badań</div>
                          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{fmtDate(detail.medical_exam_last_date)}</div>
                        </div>
                      )}
                      {detail.medical_exam_date && (
                        <div>
                          <div className="text-xs text-gray-400 mb-0.5">Data następnych badań</div>
                          <div className={`text-sm font-semibold ${s === 'expired' ? 'text-red-600 dark:text-red-400' : s === 'soon' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300'}`}>{fmtDate(detail.medical_exam_date)}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* Szkolenie BHP */}
              {(detail.bhp_last_date || detail.bhp_date) && (() => {
                const s = expiryStatus(detail.bhp_date)
                return (
                  <div className={`rounded-xl border px-4 py-3 space-y-2 ${s === 'expired' ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800' : s === 'soon' ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800' : 'bg-gray-50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-700'}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">🦺 Szkolenie BHP</span>
                      {s === 'expired' && <span className="text-xs font-bold text-red-600 dark:text-red-400">❌ Wygasłe!</span>}
                      {s === 'soon'    && <span className="text-xs font-bold text-amber-600 dark:text-amber-400">⚠️ Wygasa wkrótce</span>}
                      {s === 'ok'      && <span className="text-xs font-bold text-green-600 dark:text-green-400">✅ Ważne</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {detail.bhp_last_date && (
                        <div>
                          <div className="text-xs text-gray-400 mb-0.5">Data ostatniego szkolenia</div>
                          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{fmtDate(detail.bhp_last_date)}</div>
                        </div>
                      )}
                      {detail.bhp_date && (
                        <div>
                          <div className="text-xs text-gray-400 mb-0.5">Data następnego szkolenia</div>
                          <div className={`text-sm font-semibold ${s === 'expired' ? 'text-red-600 dark:text-red-400' : s === 'soon' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300'}`}>{fmtDate(detail.bhp_date)}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
              {detail.notes && (
                <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900 rounded-xl p-4">
                  <div className="text-xs text-amber-600 font-medium mb-1">📝 Notatki</div>
                  <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">{detail.notes}</div>
                </div>
              )}
            </div>
          ) : tab === 'assets' ? (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={() => setShowAssetModal(true)} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg">+ Dodaj asset</button>
              </div>
              {detail.assets.length === 0 ? (
                <div className="text-center text-gray-400 py-10 text-sm">Brak przydzielonych assetów.</div>
              ) : detail.assets.map(asset => (
                <div key={asset.id} className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 group">
                  <div className="text-2xl">{ASSET_TYPES[asset.asset_type]?.split(' ')[0] ?? '📦'}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{asset.name}</div>
                    <div className="text-xs text-gray-400">{ASSET_TYPES[asset.asset_type]?.replace(/^.\s/, '') ?? 'Inne'}{asset.serial_no ? ` · ${asset.serial_no}` : ''} · od {fmtDate(asset.assigned_at)}</div>
                    {asset.asset_type === 'car' && (asset.car_inspection_date || asset.car_insurance_date) && (
                      <div className="flex flex-wrap gap-2 mt-1">
                        {asset.car_inspection_date && (() => {
                          const s = expiryStatus(asset.car_inspection_date)
                          return (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${s === 'expired' ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' : s === 'soon' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}`}>
                              🔧 Przegląd: {fmtDate(asset.car_inspection_date)} {s === 'expired' ? '❌' : s === 'soon' ? '⚠️' : '✅'}
                            </span>
                          )
                        })()}
                        {asset.car_insurance_date && (() => {
                          const s = expiryStatus(asset.car_insurance_date)
                          return (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${s === 'expired' ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' : s === 'soon' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}`}>
                              🛡 Ubezpieczenie: {fmtDate(asset.car_insurance_date)} {s === 'expired' ? '❌' : s === 'soon' ? '⚠️' : '✅'}
                            </span>
                          )
                        })()}
                      </div>
                    )}
                    {asset.notes && <div className="text-xs text-gray-400 mt-0.5">{asset.notes}</div>}
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setEditingAsset(asset)} className="text-xs text-gray-400 hover:text-violet-600 px-2 py-1 rounded border border-gray-200 dark:border-gray-700">✏️</button>
                    <button onClick={() => handleDeleteAsset(asset.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded border border-gray-200 dark:border-gray-700">🗑</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={() => setShowDocModal(true)} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg">+ Wgraj dokument</button>
              </div>
              {detail.documents.length === 0 ? (
                <div className="text-center text-gray-400 py-10 text-sm">Brak dokumentów. Wgraj umowę, badania lub inne dokumenty.</div>
              ) : detail.documents.map(doc => {
                const expStatus = expiryStatus(doc.expires_at)
                return (
                  <div key={doc.id} className={`flex items-center gap-3 rounded-xl p-4 group border ${expStatus === 'expired' ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800' : expStatus === 'soon' ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800' : 'bg-gray-50 dark:bg-gray-800/50 border-transparent'}`}>
                    <div className="text-2xl">{DOC_TYPES[doc.doc_type]?.split(' ')[0] ?? '📁'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{doc.name}</div>
                      <div className="text-xs text-gray-400">{DOC_TYPES[doc.doc_type]?.replace(/^.\s/, '') ?? 'Dokument'} · {fmtDate(doc.uploaded_at)}</div>
                      {doc.expires_at && (
                        <div className={`text-xs mt-0.5 font-medium ${expStatus === 'expired' ? 'text-red-600' : expStatus === 'soon' ? 'text-amber-600' : 'text-green-600'}`}>
                          {expStatus === 'expired' ? '❌ Wygasło' : expStatus === 'soon' ? '⚠️ Wygasa' : '✅ Ważne do'}: {fmtDate(doc.expires_at)}
                        </div>
                      )}
                      {doc.notes && <div className="text-xs text-gray-400 mt-0.5">{doc.notes}</div>}
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => handleDownload(doc)} disabled={downloading === doc.id} className="text-xs text-gray-400 hover:text-violet-600 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-50">{downloading === doc.id ? '⏳' : '⬇️'}</button>
                      <button onClick={() => handleDeleteDoc(doc.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded border border-gray-200 dark:border-gray-700">🗑</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <EmployeeFormModal
          initial={detail ?? employee}
          onClose={() => setEditing(false)}
          onSaved={emp => { onUpdated(emp); setDetail(d => d ? { ...d, ...emp } : d); setEditing(false) }}
        />
      )}
      {showAssetModal && (
        <AssetModal
          employeeId={employee.id}
          onClose={() => setShowAssetModal(false)}
          onSaved={asset => { setDetail(d => d ? { ...d, assets: [asset, ...d.assets] } : d); setShowAssetModal(false) }}
        />
      )}
      {editingAsset && (
        <AssetModal
          employeeId={employee.id}
          initial={editingAsset}
          onClose={() => setEditingAsset(null)}
          onSaved={updated => { setDetail(d => d ? { ...d, assets: d.assets.map(a => a.id === updated.id ? updated : a) } : d); setEditingAsset(null) }}
        />
      )}
      {showDocModal && (
        <DocumentModal
          employeeId={employee.id}
          onClose={() => setShowDocModal(false)}
          onSaved={doc => { setDetail(d => d ? { ...d, documents: [doc, ...d.documents] } : d); setShowDocModal(false) }}
        />
      )}
    </div>
  )
}

// ── Main EmployeesView ────────────────────────────────────────────────────────
export default function EmployeesView() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [selected, setSelected] = useState<Employee | null>(null)

  const load = () => {
    setLoading(true)
    employeesApi.list().then(data => { setEmployees(data); setLoading(false) }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleSaved = (emp: Employee) => {
    setEmployees(prev => {
      const idx = prev.findIndex(e => e.id === emp.id)
      if (idx !== -1) { const copy = [...prev]; copy[idx] = emp; return copy }
      return [...prev, emp].sort((a, b) => a.name.localeCompare(b.name))
    })
  }

  return (
    <div className="p-6 max-w-screen-xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">Pracownicy</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Zarządzaj pracownikami, assetami i dokumentami HR</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors">+ Dodaj pracownika</button>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="text-sm text-gray-400 py-10 text-center">Ładowanie...</div>
        ) : employees.length === 0 ? (
          <div className="text-sm text-gray-400 py-10 text-center">Brak pracowników. Dodaj pierwszego pracownika.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                <th className="text-left px-5 py-3">Pracownik</th>
                <th className="text-left px-4 py-3">Email</th>
                <th className="text-left px-4 py-3">Telefon</th>
                <th className="text-left px-4 py-3">Zatrudniony od</th>
                <th className="text-left px-4 py-3">🩺 Badania medycyny pracy</th>
                <th className="text-left px-4 py-3">🦺 Szkolenie BHP</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {employees.map(emp => {
                const et = EMPLOYMENT_TYPES[emp.employment_type] ?? EMPLOYMENT_TYPES.employment
                const medStatus  = expiryStatus(emp.medical_exam_date)
                const bhpStatus  = expiryStatus(emp.bhp_date)

                const statusDot = (s: ReturnType<typeof expiryStatus>) =>
                  s === 'expired' ? 'text-red-600 dark:text-red-400'
                  : s === 'soon'  ? 'text-amber-600 dark:text-amber-400'
                  : s === 'ok'    ? 'text-green-600 dark:text-green-400'
                  : 'text-gray-400'

                const statusIcon = (s: ReturnType<typeof expiryStatus>) =>
                  s === 'expired' ? '❌' : s === 'soon' ? '⚠️' : s === 'ok' ? '✅' : ''

                return (
                  <tr key={emp.id} onClick={() => setSelected(emp)} className="border-b border-gray-50 dark:border-gray-800 hover:bg-violet-50/40 dark:hover:bg-violet-950/10 cursor-pointer transition-colors">
                    {/* Pracownik */}
                    <td className="px-5 py-3">
                      <div className="font-medium text-gray-800 dark:text-gray-100 flex items-center gap-1.5">
                        <span>👤</span>{emp.name}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {emp.position && <span className="text-xs text-gray-400">{emp.position}</span>}
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${et.bg} ${et.color}`}>{et.label}</span>
                      </div>
                    </td>

                    {/* Email */}
                    <td className="px-4 py-3">
                      {emp.email
                        ? <a href={`mailto:${emp.email}`} onClick={e => e.stopPropagation()} className="text-xs text-violet-600 dark:text-violet-400 hover:underline">{emp.email}</a>
                        : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>}
                    </td>

                    {/* Telefon */}
                    <td className="px-4 py-3">
                      {emp.phone
                        ? <a href={`tel:${emp.phone}`} onClick={e => e.stopPropagation()} className="text-xs text-gray-700 dark:text-gray-300 hover:text-violet-600">{emp.phone}</a>
                        : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>}
                    </td>

                    {/* Zatrudniony od */}
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {emp.start_date ? fmtDate(emp.start_date) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>

                    {/* Badania medycyny pracy */}
                    <td className="px-4 py-3">
                      {(emp.medical_exam_last_date || emp.medical_exam_date) ? (
                        <div className="space-y-0.5">
                          {emp.medical_exam_last_date && (
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              <span className="text-gray-400">Ostatnie: </span>
                              <span className="font-medium">{fmtDate(emp.medical_exam_last_date)}</span>
                            </div>
                          )}
                          {emp.medical_exam_date && (
                            <div className={`text-xs font-medium ${statusDot(medStatus)}`}>
                              <span className="text-gray-400 font-normal">Następne: </span>
                              {fmtDate(emp.medical_exam_date)} {statusIcon(medStatus)}
                            </div>
                          )}
                        </div>
                      ) : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>}
                    </td>

                    {/* Szkolenie BHP */}
                    <td className="px-4 py-3">
                      {(emp.bhp_last_date || emp.bhp_date) ? (
                        <div className="space-y-0.5">
                          {emp.bhp_last_date && (
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              <span className="text-gray-400">Ostatnie: </span>
                              <span className="font-medium">{fmtDate(emp.bhp_last_date)}</span>
                            </div>
                          )}
                          {emp.bhp_date && (
                            <div className={`text-xs font-medium ${statusDot(bhpStatus)}`}>
                              <span className="text-gray-400 font-normal">Następne: </span>
                              {fmtDate(emp.bhp_date)} {statusIcon(bhpStatus)}
                            </div>
                          )}
                        </div>
                      ) : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>}
                    </td>

                    {/* Button */}
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <button onClick={() => setSelected(emp)} className="text-xs text-gray-400 hover:text-violet-600 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 whitespace-nowrap">Otwórz →</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {showAdd && <EmployeeFormModal onClose={() => setShowAdd(false)} onSaved={emp => { handleSaved(emp); setShowAdd(false) }} />}
      {selected && (
        <EmployeeDetailPanel
          employee={selected}
          onClose={() => setSelected(null)}
          onUpdated={handleSaved}
          onDeleted={id => { setEmployees(prev => prev.filter(e => e.id !== id)); setSelected(null) }}
        />
      )}
    </div>
  )
}
