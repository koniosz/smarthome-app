import { useState } from 'react'
import Modal from '../ui/Modal'
import { paymentsApi } from '../../api/client'
import type { ClientPayment } from '../../types'

interface Props {
  projectId: string
  onClose: () => void
  onCreated: (payment: ClientPayment) => void
}

export default function AddPaymentModal({ projectId, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    description: '',
    invoice_number: '',
    payment_type: 'standard' as 'standard' | 'additional_works',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(form.amount)
    if (!amount || amount <= 0) { setError('Kwota musi być większa od 0'); return }
    setSaving(true)
    setError('')
    try {
      const result = await paymentsApi.create(projectId, { ...form, amount })
      onCreated(result)
      onClose()
    } catch {
      setError('Błąd zapisu.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Zarejestruj wpłatę" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Typ płatności</label>
          <div className="flex gap-2">
            {(['standard', 'additional_works'] as const).map(type => (
              <button
                key={type}
                type="button"
                onClick={() => set('payment_type', type)}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg border transition-colors ${
                  form.payment_type === type
                    ? 'bg-violet-600 border-violet-600 text-white'
                    : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                {type === 'standard' ? '💳 Standardowa' : '➕ Prace dodatkowe'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Kwota (PLN) *</label>
            <input
              type="number" min="0" step="0.01"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.amount}
              onChange={e => set('amount', e.target.value)}
              placeholder="0,00"
              autoFocus
            />
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
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Opis</label>
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            value={form.description}
            onChange={e => set('description', e.target.value)}
            placeholder="np. Zaliczka, Dopłata za prace dodatkowe"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nr faktury / dokumentu</label>
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            value={form.invoice_number}
            onChange={e => set('invoice_number', e.target.value)}
            placeholder="np. FV/2024/001"
          />
        </div>

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
            {saving ? 'Zapisywanie...' : 'Dodaj wpłatę'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
