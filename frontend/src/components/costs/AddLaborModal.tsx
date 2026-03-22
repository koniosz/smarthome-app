import { useState, useEffect } from 'react'
import Modal from '../ui/Modal'
import { laborApi, employeesApi } from '../../api/client'
import type { LaborEntry, Employee } from '../../types'

interface Props {
  projectId: string
  onClose: () => void
  onCreated: (entry: LaborEntry) => void
  isAdmin?: boolean
}

export default function AddLaborModal({ projectId, onClose, onCreated, isAdmin = true }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [form, setForm] = useState({
    worker_name: '',
    date: new Date().toISOString().slice(0, 10),
    hours: '',
    hourly_rate: '',
    description: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    employeesApi.list().then(setEmployees).catch(() => {})
  }, [])

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleEmployeeSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value
    setSelectedEmployeeId(id)
    if (id === '') {
      set('worker_name', '')
      set('hourly_rate', '')
    } else {
      const emp = employees.find(emp => emp.id === id)
      if (emp) {
        set('worker_name', emp.name)
        set('hourly_rate', String(emp.hourly_rate))
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.worker_name.trim()) { setError('Imię pracownika jest wymagane'); return }
    setSaving(true)
    setError('')
    try {
      const result = await laborApi.create(projectId, {
        ...form,
        hours: parseFloat(form.hours) || 0,
        hourly_rate: parseFloat(form.hourly_rate) || 0,
      })
      onCreated(result)
      onClose()
    } catch {
      setError('Błąd zapisu.')
    } finally {
      setSaving(false)
    }
  }

  const total = (parseFloat(form.hours) || 0) * (parseFloat(form.hourly_rate) || 0)

  return (
    <Modal title="Dodaj robociznę" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">

        {employees.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Wybierz pracownika</label>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={selectedEmployeeId}
              onChange={handleEmployeeSelect}
            >
              <option value="">— wpisz ręcznie —</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}{isAdmin ? ` (${emp.hourly_rate} PLN/h)` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Pracownik * {selectedEmployeeId ? '' : <span className="font-normal text-gray-400">(wpisz ręcznie)</span>}
          </label>
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            value={form.worker_name}
            onChange={e => set('worker_name', e.target.value)}
            placeholder="Imię i nazwisko"
            autoFocus={employees.length === 0}
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

        <div className={isAdmin ? 'grid grid-cols-2 gap-4' : ''}>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Godziny</label>
            <input
              type="number" min="0" step="0.5"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.hours}
              onChange={e => set('hours', e.target.value)}
              placeholder="0"
            />
          </div>

          {isAdmin && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Stawka (PLN/h)</label>
              <input
                type="number" min="0" step="1"
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                value={form.hourly_rate}
                onChange={e => set('hourly_rate', e.target.value)}
                placeholder="0"
              />
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Opis pracy</label>
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            value={form.description}
            onChange={e => set('description', e.target.value)}
            placeholder="np. Montaż okablowania, Konfiguracja central"
          />
        </div>

        {isAdmin && total > 0 && (
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
            {saving ? 'Zapisywanie...' : 'Dodaj'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
