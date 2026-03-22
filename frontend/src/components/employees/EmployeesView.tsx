import { useState, useEffect } from 'react'
import { employeesApi } from '../../api/client'
import type { Employee } from '../../types'
import Modal from '../ui/Modal'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n)
}

function EmployeeModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Employee
  onClose: () => void
  onSaved: (emp: Employee) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [rate, setRate] = useState(initial ? String(initial.hourly_rate) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError('Imię i nazwisko jest wymagane'); return }
    setSaving(true)
    setError('')
    try {
      let result: Employee
      if (initial) {
        result = await employeesApi.update(initial.id, { name: name.trim(), hourly_rate: parseFloat(rate) || 0 })
      } else {
        result = await employeesApi.create({ name: name.trim(), hourly_rate: parseFloat(rate) || 0 })
      }
      onSaved(result)
      onClose()
    } catch {
      setError('Błąd zapisu.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={initial ? 'Edytuj pracownika' : 'Dodaj pracownika'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Imię i nazwisko *</label>
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="np. Jan Kowalski"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Stawka godzinowa (PLN/h)</label>
          <input
            type="number" min="0" step="1"
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            value={rate}
            onChange={e => setRate(e.target.value)}
            placeholder="0"
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
            {saving ? 'Zapisywanie...' : (initial ? 'Zapisz' : 'Dodaj')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function EmployeesView() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)

  const load = () => {
    employeesApi.list().then(data => {
      setEmployees(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleDelete = async (emp: Employee) => {
    if (!confirm(`Usunąć pracownika "${emp.name}"?`)) return
    await employeesApi.delete(emp.id)
    setEmployees(prev => prev.filter(e => e.id !== emp.id))
  }

  const handleSaved = (saved: Employee) => {
    setEmployees(prev => {
      const idx = prev.findIndex(e => e.id === saved.id)
      if (idx !== -1) {
        const copy = [...prev]
        copy[idx] = saved
        return copy
      }
      return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name))
    })
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">Pracownicy</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Zarządzaj pracownikami i ich stawkami godzinowymi</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
        >
          + Dodaj pracownika
        </button>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700">
        {loading ? (
          <div className="text-sm text-gray-400 py-10 text-center">Ładowanie...</div>
        ) : employees.length === 0 ? (
          <div className="text-sm text-gray-400 py-10 text-center">
            Brak pracowników. Dodaj pierwszego pracownika.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="text-left px-5 py-3">Imię i nazwisko</th>
                <th className="text-right px-5 py-3">Stawka (PLN/h)</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {employees.map(emp => (
                <tr key={emp.id} className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                  <td className="px-5 py-3 font-medium text-gray-800 dark:text-gray-100">
                    👤 {emp.name}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-violet-50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-400 font-semibold">
                      {fmt(emp.hourly_rate)} PLN/h
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setEditing(emp)}
                        className="px-2.5 py-1 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                      >
                        ✏️ Edytuj
                      </button>
                      <button
                        onClick={() => handleDelete(emp)}
                        className="px-2.5 py-1 text-xs font-medium border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors"
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <EmployeeModal onClose={() => setShowAdd(false)} onSaved={handleSaved} />
      )}
      {editing && (
        <EmployeeModal initial={editing} onClose={() => setEditing(null)} onSaved={handleSaved} />
      )}
    </div>
  )
}
