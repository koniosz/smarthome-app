import { useState, useEffect, useCallback } from 'react'
import { surveyApi, aiQuotesApi } from '../../api/client'
import type { ClientSurvey } from '../../types'

// ── Types ──────────────────────────────────────────────────────────────────────

type SurveyStatus = ClientSurvey['status']

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<SurveyStatus, string> = {
  draft: 'Szkic',
  sent: 'Wysłana',
  viewed: 'Wyświetlona',
  submitted: 'Wypełniona',
}

const STATUS_COLORS: Record<SurveyStatus, string> = {
  draft: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  viewed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  submitted: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('pl-PL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Response viewer (ankieta v4; klucze legacy obsługiwane fallbackiem) ─────────

import { SYSTEM_LABELS as SPEC_SYSTEM_LABELS, DETAIL_FIELD_LABELS, SURVEY_FIELD_LABELS } from '../../surveySpec'

const LEGACY_SYSTEM_LABELS: Record<string, string> = {
  hvac: '🌡️ Ogrzewanie i klimatyzacja', access: '🔐 Kontrola dostępu', voice: '🎙️ Sterowanie głosowe', ai_monitoring: '🤖 AI Concierge',
}
const SYSTEM_LABELS: Record<string, string> = { ...LEGACY_SYSTEM_LABELS, ...SPEC_SYSTEM_LABELS }

interface ResponseGroup {
  title: string
  fields: { key: string; label: string }[]
}

const RESPONSE_GROUPS: ResponseGroup[] = [
  {
    title: '🏠 Twój dom',
    fields: [
      { key: 'building_type', label: 'Typ budynku' },
      { key: 'building_state', label: 'Stan budynku' },
      { key: 'is_new_build', label: 'Stan budynku' },        // legacy
      { key: 'area_m2', label: 'Powierzchnia (m²)' },
      { key: 'floors_count', label: 'Liczba kondygnacji' },
      { key: 'rooms_count', label: 'Liczba pokoi / stref' },
      { key: 'location', label: 'Miasto / region' },
      { key: 'completion_date', label: 'Termin realizacji' },
    ],
  },
  {
    title: '⚡ Wybrane systemy',
    fields: [{ key: 'systems', label: 'Systemy Smart Home' }],
  },
  {
    title: '🎯 Priorytety i oczekiwania',
    fields: [
      { key: 'control_methods', label: SURVEY_FIELD_LABELS.control_methods },
      { key: 'control_preference', label: 'Sposób sterowania' },   // legacy
      { key: 'automation_level', label: SURVEY_FIELD_LABELS.automation_level },
      { key: 'existing_systems', label: SURVEY_FIELD_LABELS.existing_systems },
      { key: 'integration_existing', label: 'Istniejące systemy' }, // legacy
      { key: 'priorities', label: SURVEY_FIELD_LABELS.priorities },
      { key: 'priority_system', label: 'Priorytet' },              // legacy
      { key: 'phasing', label: SURVEY_FIELD_LABELS.phasing },
      { key: 'timeline_urgency', label: SURVEY_FIELD_LABELS.timeline_urgency },
      { key: 'budget_range', label: 'Budżet (legacy)' },           // legacy
    ],
  },
  {
    title: '📝 Opis projektu',
    fields: [
      { key: 'project_description', label: SURVEY_FIELD_LABELS.project_description },
      { key: 'dream_description', label: 'Wymarzony smart home' }, // legacy
      { key: 'previous_experience', label: 'Doświadczenie' },      // legacy
      { key: 'additional_notes', label: 'Dodatkowe uwagi' },       // legacy
    ],
  },
]

function displayValue(val: any): string {
  if (typeof val === 'boolean') return val ? 'Tak' : 'Nie'
  if (Array.isArray(val)) return val.join(', ')
  return String(val)
}

function ResponseViewer({ responses }: { responses: Record<string, any> }) {
  const details: Record<string, Record<string, any>> = responses.details ?? {}
  return (
    <div className="space-y-5">
      {RESPONSE_GROUPS.map(group => (
        <div key={group.title}>
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">{group.title}</h4>
          <div className="space-y-2">
            {group.fields.map(field => {
              const val = responses[field.key]
              if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) return null
              const display = field.key === 'systems' && Array.isArray(val)
                ? val.map((k: string) => SYSTEM_LABELS[k] ?? k).join(', ')
                : displayValue(val)
              return (
                <div key={field.key} className="flex gap-3">
                  <span className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400 w-40">{field.label}:</span>
                  <span className="text-sm text-gray-800 dark:text-gray-100 flex-1">{display}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Pytania dedykowane (krok 3) — per wybrany system */}
      {Object.keys(details).length > 0 && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">🔧 Szczegóły systemów</h4>
          <div className="space-y-3">
            {Object.entries(details).map(([sysKey, answers]) => {
              const fieldLabels = DETAIL_FIELD_LABELS[sysKey] ?? {}
              const entries = Object.entries(answers ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
              if (entries.length === 0) return null
              return (
                <div key={sysKey} className="border border-gray-100 dark:border-gray-800 rounded-lg p-3">
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1.5">{SYSTEM_LABELS[sysKey] ?? sysKey}</div>
                  <div className="space-y-1">
                    {entries.map(([k, v]) => (
                      <div key={k} className="flex gap-3">
                        <span className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400 w-40">{fieldLabels[k] ?? k}:</span>
                        <span className="text-sm text-gray-800 dark:text-gray-100 flex-1">{displayValue(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Create Survey Modal ────────────────────────────────────────────────────────

function CreateSurveyModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string
  onClose: () => void
  onCreated: (s: ClientSurvey) => void
}) {
  const [form, setForm] = useState({ client_email: '', client_name: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.client_email.trim() || !form.client_name.trim()) {
      setError('Email i imię klienta są wymagane')
      return
    }
    setSaving(true)
    setError('')
    try {
      const survey = await surveyApi.create(projectId, form)
      onCreated(survey)
      onClose()
    } catch {
      setError('Błąd podczas tworzenia ankiety')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-800">
          <h3 className="font-bold text-gray-800 dark:text-gray-100">Nowa ankieta klienta</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Imię i nazwisko klienta</label>
            <input
              type="text"
              value={form.client_name}
              onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))}
              placeholder="np. Jan Kowalski"
              className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Adres email klienta</label>
            <input
              type="email"
              value={form.client_email}
              onChange={e => setForm(f => ({ ...f, client_email: e.target.value }))}
              placeholder="np. jan@example.com"
              className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notatka (opcjonalnie)</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              placeholder="Np. klient z polecenia, spotkanie 15.06..."
              className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 resize-none"
            />
          </div>

          {error && (
            <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-2.5">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
              Anuluj
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-xl disabled:opacity-50 transition-colors"
            >
              {saving ? 'Tworzenie...' : 'Utwórz ankietę'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Survey Row ─────────────────────────────────────────────────────────────────

function SurveyRow({
  survey,
  onSend,
  onDelete,
  onCopyLink,
  onPushToAi,
  pushingAiId,
}: {
  survey: ClientSurvey
  onSend: (id: string) => void
  onDelete: (id: string) => void
  onCopyLink: (token: string) => void
  onPushToAi: (id: string) => void
  pushingAiId: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const isGenerating = pushingAiId === survey.id
  const hasAttachments = (survey.attachments?.length ?? 0) > 0

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-900 overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-lg shrink-0">
              {survey.status === 'submitted' ? '✅' : survey.status === 'viewed' ? '👁️' : survey.status === 'sent' ? '📧' : '📝'}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                <span className="font-semibold text-sm text-gray-800 dark:text-gray-100 truncate">{survey.client_name}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[survey.status]}`}>
                  {STATUS_LABELS[survey.status]}
                </span>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{survey.client_email}</div>
              <div className="flex gap-3 mt-1 text-xs text-gray-400 flex-wrap">
                {survey.sent_at && <span>📧 Wysłano: {fmtDate(survey.sent_at)}</span>}
                {survey.viewed_at && <span>👁️ Wyświetlono: {fmtDate(survey.viewed_at)}</span>}
                {survey.submitted_at && <span>✅ Wypełniono: {fmtDate(survey.submitted_at)}</span>}
                {!survey.sent_at && <span>Utworzono: {fmtDate(survey.created_at)}</span>}
              </div>
              {survey.notes && (
                <div className="text-xs text-gray-500 mt-1 italic">"{survey.notes}"</div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap shrink-0">
            {survey.status === 'draft' && (
              <button
                onClick={() => onSend(survey.id)}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              >
                📧 Wyślij email
              </button>
            )}
            <button
              onClick={() => onCopyLink(survey.token)}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              🔗 Kopiuj link
            </button>
            {survey.status === 'submitted' && (
              <>
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="px-3 py-1.5 text-xs font-medium border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/20 rounded-lg transition-colors"
                >
                  {expanded ? '▲ Ukryj' : '👁️ Podgląd odpowiedzi'}
                </button>
                <button
                  onClick={() => onPushToAi(survey.id)}
                  disabled={isGenerating}
                  className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {isGenerating ? (
                    <>
                      <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Generowanie...
                    </>
                  ) : hasAttachments ? (
                    '🤖 Generuj wycenę AI'
                  ) : (
                    '🤖 Wycena AI (bez planów)'
                  )}
                </button>
              </>
            )}
            <button
              onClick={() => onDelete(survey.id)}
              className="px-3 py-1.5 text-xs font-medium border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors"
            >
              🗑 Usuń
            </button>
          </div>
        </div>
      </div>

      {/* Expanded responses */}
      {expanded && survey.responses && (
        <div className="border-t border-gray-100 dark:border-gray-800 p-4 bg-gray-50/50 dark:bg-gray-800/30">
          <ResponseViewer responses={survey.responses} />

          {/* Attachments */}
          {survey.attachments && survey.attachments.length > 0 && (
            <div className="mt-5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">📎 Załączniki</h4>
              <ul className="space-y-1.5">
                {survey.attachments.map(a => (
                  <li key={a.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <span>{a.mime_type.startsWith('image/') ? '🖼️' : a.file_name.endsWith('.pdf') ? '📄' : '📎'}</span>
                    <span className="truncate">{a.file_name}</span>
                    <span className="text-xs text-gray-400 ml-auto shrink-0">
                      {a.file_size < 1024 ? `${a.file_size} B` : a.file_size < 1024 * 1024 ? `${(a.file_size / 1024).toFixed(1)} KB` : `${(a.file_size / (1024 * 1024)).toFixed(1)} MB`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── SurveyPanel ────────────────────────────────────────────────────────────────

export default function SurveyPanel({
  projectId,
  projectName,
  onNavigateToAiQuote,
}: {
  projectId: string
  projectName: string
  onNavigateToAiQuote?: () => void
}) {
  const [surveys, setSurveys] = useState<ClientSurvey[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [pushingAiId, setPushingAiId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await surveyApi.list(projectId)
      setSurveys(data)
    } catch {
      // silent fail
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const handleSend = async (id: string) => {
    if (!confirm('Wysłać ankietę emailem do klienta?')) return
    setSendingId(id)
    try {
      const updated = await surveyApi.send(projectId, id)
      setSurveys(prev => prev.map(s => s.id === id ? updated : s))
    } catch {
      alert('Błąd podczas wysyłania emaila')
    } finally {
      setSendingId(null)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć tę ankietę?')) return
    try {
      await surveyApi.delete(projectId, id)
      setSurveys(prev => prev.filter(s => s.id !== id))
    } catch {
      alert('Błąd podczas usuwania ankiety')
    }
  }

  const handleCopyLink = (token: string) => {
    const url = `${window.location.origin}/survey/${token}`
    navigator.clipboard.writeText(url).then(() => {
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 2000)
    })
  }

  const handleCreated = (survey: ClientSurvey) => {
    setSurveys(prev => [survey, ...prev])
  }

  const handlePushToAi = async (surveyId: string) => {
    setPushingAiId(surveyId)
    try {
      await aiQuotesApi.fromSurvey(projectId, surveyId)
      onNavigateToAiQuote?.()
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Błąd generowania wyceny AI')
    } finally {
      setPushingAiId(null)
    }
  }

  // Stats
  const byStatus = surveys.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Ankiety klienta ({surveys.length})
          </h3>
          {surveys.length > 0 && (
            <div className="flex gap-2 mt-1 flex-wrap">
              {Object.entries(byStatus).map(([status, count]) => (
                <span key={status} className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[status as SurveyStatus] ?? ''}`}>
                  {STATUS_LABELS[status as SurveyStatus] ?? status}: {count}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-xl transition-colors"
        >
          + Nowa ankieta
        </button>
      </div>

      {/* Copied toast */}
      {copiedToken && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl text-sm text-green-700 dark:text-green-400">
          ✅ Link skopiowany do schowka!
        </div>
      )}

      {/* Sending overlay */}
      {sendingId && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl text-sm text-blue-700 dark:text-blue-400">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          Wysyłanie emaila...
        </div>
      )}

      {/* List */}
      {loading ? (
        <p className="text-sm text-gray-400 text-center py-10">Ładowanie...</p>
      ) : surveys.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
          <div className="text-4xl mb-3">📋</div>
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Brak ankiet dla tego projektu</p>
          <p className="text-xs text-gray-400">Kliknij "+ Nowa ankieta", aby wysłać ankietę do klienta</p>
        </div>
      ) : (
        <div className="space-y-3">
          {surveys.map(survey => (
            <SurveyRow
              key={survey.id}
              survey={survey}
              onSend={handleSend}
              onDelete={handleDelete}
              onCopyLink={handleCopyLink}
              onPushToAi={handlePushToAi}
              pushingAiId={pushingAiId}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateSurveyModal
          projectId={projectId}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}
