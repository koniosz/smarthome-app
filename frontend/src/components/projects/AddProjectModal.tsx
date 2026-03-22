import { useState } from 'react'
import Modal from '../ui/Modal'
import { projectsApi } from '../../api/client'
import type { Project, ProjectType, ProjectStatus } from '../../types'
import { PROJECT_TYPE_LABELS, PROJECT_STATUS_LABELS, SMART_FEATURES } from '../../types'

interface Props {
  onClose: () => void
  onCreated: (p: Project) => void
  initial?: Partial<Project>
  editMode?: boolean
}

export default function AddProjectModal({ onClose, onCreated, initial, editMode }: Props) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    client_name: initial?.client_name || '',
    client_contact: initial?.client_contact || '',
    project_type: initial?.project_type || 'installation' as ProjectType,
    status: initial?.status || 'offer_submitted' as ProjectStatus,
    budget_amount: initial?.budget_amount?.toString() || '',
    area_m2: initial?.area_m2?.toString() || '',
    start_date: initial?.start_date || '',
    end_date: initial?.end_date || '',
    description: initial?.description || '',
  })
  const [smartFeatures, setSmartFeatures] = useState<string[]>(initial?.smart_features || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const toggleFeature = (key: string) => {
    setSmartFeatures(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Nazwa jest wymagana'); return }
    if (!form.area_m2 || parseFloat(form.area_m2) <= 0) { setError('Metraż budynku jest wymagany'); return }
    setSaving(true)
    setError('')
    try {
      const data = {
        ...form,
        budget_amount: parseFloat(form.budget_amount) || 0,
        area_m2: parseFloat(form.area_m2),
        smart_features: smartFeatures,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
      }
      let result: Project
      if (editMode && initial?.id) {
        result = await projectsApi.update(initial.id, data)
      } else {
        result = await projectsApi.create(data)
      }
      onCreated(result)
      onClose()
    } catch {
      setError('Błąd zapisu. Sprawdź połączenie z backendem.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={editMode ? 'Edytuj projekt' : 'Nowy projekt'} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nazwa projektu *</label>
            <input
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="np. Instalacja Smart Home – Kowalski"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Klient</label>
            <input
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.client_name}
              onChange={e => set('client_name', e.target.value)}
              placeholder="Imię i nazwisko / firma"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Kontakt</label>
            <input
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.client_contact}
              onChange={e => set('client_contact', e.target.value)}
              placeholder="email lub telefon"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Typ projektu</label>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.project_type}
              onChange={e => set('project_type', e.target.value)}
            >
              {(Object.entries(PROJECT_TYPE_LABELS) as [ProjectType, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Status</label>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.status}
              onChange={e => set('status', e.target.value)}
            >
              {(Object.entries(PROJECT_STATUS_LABELS) as [ProjectStatus, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Budżet oferty (PLN)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.budget_amount}
              onChange={e => set('budget_amount', e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Metraż budynku (m²) *</label>
            <input
              type="number"
              min="1"
              step="0.1"
              className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 ${
                !form.area_m2 ? 'border-gray-200 dark:border-gray-700' : 'border-gray-200 dark:border-gray-700'
              }`}
              value={form.area_m2}
              onChange={e => set('area_m2', e.target.value)}
              placeholder="np. 120"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data rozpoczęcia</label>
            <input
              type="date"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.start_date}
              onChange={e => set('start_date', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Data zakończenia</label>
            <input
              type="date"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={form.end_date}
              onChange={e => set('end_date', e.target.value)}
            />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Opis</label>
            <textarea
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Opcjonalny opis projektu..."
            />
          </div>
        </div>

        {/* Smart features */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
            Funkcje Smart Home
            {smartFeatures.length > 0 && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 text-xs font-semibold">
                {smartFeatures.length}
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {SMART_FEATURES.map(f => {
              const checked = smartFeatures.includes(f.key)
              return (
                <label
                  key={f.key}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer border transition-colors select-none ${
                    checked
                      ? 'bg-violet-50 dark:bg-violet-950/30 border-violet-300 dark:border-violet-700 text-violet-800 dark:text-violet-200'
                      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={checked}
                    onChange={() => toggleFeature(f.key)}
                  />
                  <span className="text-base leading-none">{f.icon}</span>
                  <span className="text-xs font-medium">{f.label}</span>
                </label>
              )
            })}
          </div>
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            Anuluj
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Zapisywanie...' : editMode ? 'Zapisz zmiany' : 'Utwórz projekt'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
