import { useRef, useState } from 'react'
import Modal from '../ui/Modal'
import { costsApi, attachmentsApi } from '../../api/client'
import type { CostItem, CostCategory } from '../../types'
import { COST_CATEGORY_LABELS } from '../../types'

interface Props {
  projectId: string
  onClose: () => void
  onCreated: (item: CostItem) => void
}

export default function AddCostModal({ projectId, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    category: 'materials' as CostCategory,
    description: '',
    quantity: '1',
    unit_price: '',
    supplier: '',
    invoice_number: '',
    date: new Date().toISOString().slice(0, 10),
  })
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.description.trim()) { setError('Opis jest wymagany'); return }
    setSaving(true)
    setError('')
    try {
      let result = await costsApi.create(projectId, {
        ...form,
        quantity: parseFloat(form.quantity) || 1,
        unit_price: parseFloat(form.unit_price) || 0,
      })
      if (file) {
        try {
          result = await attachmentsApi.upload(result.id, file)
        } catch {
          // attachment upload failed but cost item created — still report success
        }
      }
      onCreated(result)
      onClose()
    } catch {
      setError('Błąd zapisu.')
    } finally {
      setSaving(false)
    }
  }

  const total = (parseFloat(form.quantity) || 0) * (parseFloat(form.unit_price) || 0)

  return (
    <Modal title="Dodaj koszt" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Kategoria</label>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.category}
              onChange={e => set('category', e.target.value)}
            >
              {(Object.entries(COST_CATEGORY_LABELS) as [CostCategory, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data</label>
            <input
              type="date"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.date}
              onChange={e => set('date', e.target.value)}
            />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Opis *</label>
            <input
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="np. Kabel UTP kat.6, Czujnik ruchu, Firma elektryczna XYZ"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Ilość</label>
            <input
              type="number" min="0" step="0.01"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.quantity}
              onChange={e => set('quantity', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Cena jednostkowa (PLN)</label>
            <input
              type="number" min="0" step="0.01"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.unit_price}
              onChange={e => set('unit_price', e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Dostawca</label>
            <input
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.supplier}
              onChange={e => set('supplier', e.target.value)}
              placeholder="opcjonalnie"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nr faktury</label>
            <input
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.invoice_number}
              onChange={e => set('invoice_number', e.target.value)}
              placeholder="opcjonalnie"
            />
          </div>
        </div>

        {/* File attachment */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Załącz fakturę / paragon <span className="font-normal text-gray-400">(PDF, JPG, PNG — opcjonalnie)</span>
          </label>
          <div
            className="flex items-center gap-3 px-3 py-2 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer hover:border-violet-400 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <span className="text-lg">📎</span>
            <span className="text-sm text-gray-500 dark:text-gray-400 flex-1 truncate">
              {file ? file.name : 'Kliknij aby wybrać plik'}
            </span>
            {file && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setFile(null); if (fileRef.current) fileRef.current.value = '' }}
                className="text-xs text-red-400 hover:text-red-600"
              >
                ✕
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic"
            className="hidden"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {total > 0 && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-4 py-2 flex justify-between items-center">
            <span className="text-sm text-gray-600 dark:text-gray-400">Łącznie:</span>
            <span className="text-base font-bold text-violet-700 dark:text-violet-400">
              {new Intl.NumberFormat('pl-PL').format(total)} PLN
            </span>
          </div>
        )}

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button" onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            Anuluj
          </button>
          <button
            type="submit" disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Zapisywanie...' : 'Dodaj koszt'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
