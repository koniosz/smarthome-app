import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { projectsApi, aiQuotesApi, costsApi, projectDocumentsApi } from '../../api/client'
import { useAuth } from '../../auth/AuthContext'
import type { ProjectDetail as ProjectDetailType, CostItem, LaborEntry, ClientPayment, AiQuote, CostAuditEntry, ProjectDocument } from '../../types'
import { SMART_FEATURES, PROJECT_DOC_TYPE_LABELS } from '../../types'
import { StatusBadge, TypeBadge } from '../ui/StatusBadge'
import AddProjectModal from './AddProjectModal'
import AddCostModal from '../costs/AddCostModal'
import AddLaborModal from '../costs/AddLaborModal'
import AddPaymentModal from '../costs/AddPaymentModal'
import CostTable from '../costs/CostTable'
import LaborTable from '../costs/LaborTable'
import PaymentTable from '../costs/PaymentTable'
import AIQuoteTab from '../ai-quote/AIQuoteTab'
import ExtraCostsTab from '../costs/ExtraCostsTab'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

// ── Helpers dla panelu historii ──────────────────────────────────────────────

type EntityType = 'cost' | 'labor' | 'payment' | 'ksef' | 'project' | string

const ENTITY_ICON: Record<EntityType, string> = {
  cost:    '🧾',
  labor:   '👷',
  payment: '💰',
  ksef:    '📋',
  project: '🏗️',
}

const ACTION_ICON: Record<string, string> = {
  add:     '➕',
  edit:    '✏️',
  delete:  '🗑️',
  created: '🚀',
  updated: '✏️',
}

const ACTION_LABEL: Record<string, string> = {
  add:     'Dodano',
  edit:    'Edytowano',
  delete:  'Usunięto',
  created: 'Utworzono',
  updated: 'Edytowano',
}

const ACTION_COLOR: Record<string, string> = {
  add:     'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  edit:    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  delete:  'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  created: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  updated: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: 'long', year: 'numeric' })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
}

function HistoryTab({ auditLog, project }: { auditLog: CostAuditEntry[]; project: ProjectDetailType }) {
  if (auditLog.length === 0) {
    return <p className="text-sm text-gray-400 py-10 text-center">Brak wpisów w historii.</p>
  }

  // Grupowanie po dacie
  const groups: Record<string, CostAuditEntry[]> = {}
  for (const entry of auditLog) {
    const day = formatDate(entry.created_at)
    if (!groups[day]) groups[day] = []
    groups[day].push(entry)
  }

  return (
    <div className="space-y-6">
      {/* Baner: kto i kiedy stworzył projekt */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-violet-50 dark:bg-violet-950/20 border border-violet-100 dark:border-violet-900/30">
        <span className="text-2xl">🚀</span>
        <div>
          <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">Projekt utworzony</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {new Date(project.created_at).toLocaleString('pl-PL', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
      </div>

      {/* Oś czasu pogrupowana po dniach */}
      {Object.entries(groups).map(([day, entries]) => (
        <div key={day}>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 whitespace-nowrap">{day}</span>
            <div className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
          </div>

          <div className="space-y-1.5">
            {entries.map(entry => {
              const entity = (entry.entity ?? 'cost') as EntityType
              const actionKey = entry.action in ACTION_ICON ? entry.action : 'edit'
              return (
                <div key={entry.id} className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 hover:border-gray-200 dark:hover:border-gray-600 transition-colors">
                  {/* Ikona encji */}
                  <div className="shrink-0 w-8 h-8 rounded-lg bg-gray-50 dark:bg-gray-700 flex items-center justify-center text-base">
                    {ENTITY_ICON[entity] ?? '📝'}
                  </div>

                  {/* Treść */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 dark:text-gray-100 leading-snug">{entry.description}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded font-medium ${ACTION_COLOR[actionKey] ?? ACTION_COLOR.edit}`}>
                        {ACTION_ICON[actionKey]} {ACTION_LABEL[actionKey] ?? actionKey}
                      </span>
                      <span className="text-xs text-gray-400">
                        👤 <span className="font-medium text-gray-500 dark:text-gray-400">{entry.user_name ?? 'System'}</span>
                      </span>
                      <span className="text-xs text-gray-400">{formatTime(entry.created_at)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function fmtDec(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

type Tab = 'materials' | 'subcontractor' | 'other' | 'labor' | 'payments' | 'ai_quote' | 'extra_costs' | 'documents' | 'history'

// ── Project Documents Tab ────────────────────────────────────────────────────

function ProjectDocumentsTab({ projectId, project }: { projectId: string; project: ProjectDetailType }) {
  const [docs, setDocs] = useState<ProjectDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [showContract, setShowContract] = useState(false)
  const [uploadForm, setUploadForm] = useState({ doc_type: 'offer', name: '', notes: '' })
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Contract form state
  const [cf, setCf] = useState({
    contract_date: new Date().toISOString().slice(0, 10),
    client_company: project.client_name || '',
    client_address: '',
    client_krs: '',
    client_nip: '',
    client_representative: '',
    scope_description: '',
    start_date: project.start_date || '',
    end_date: project.end_date || '',
    total_amount_net: project.budget_amount || 0,
    guarantee_months: 24,
    shc_representative: 'Prezesa Zarządu - Dorotę Szychtę',
    location_name: '',
    tranches: [
      { label: 'zaliczka', amount: 0, due_date: '' },
      { label: 'po zakończeniu', amount: 0, due_date: '' },
    ],
  })
  const [generatingContract, setGeneratingContract] = useState(false)

  useEffect(() => {
    projectDocumentsApi.list(projectId).then(data => {
      setDocs(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [projectId])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadFile(file)
    if (!uploadForm.name) setUploadForm(f => ({ ...f, name: file.name }))
  }

  const handleUpload = async () => {
    if (!uploadFile) return
    setUploading(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(uploadFile)
      })
      const doc = await projectDocumentsApi.upload(projectId, {
        doc_type: uploadForm.doc_type,
        name: uploadForm.name || uploadFile.name,
        file_name: uploadFile.name,
        mime_type: uploadFile.type || 'application/octet-stream',
        file_data: base64,
        notes: uploadForm.notes,
      })
      setDocs(prev => [doc, ...prev])
      setShowUpload(false)
      setUploadForm({ doc_type: 'offer', name: '', notes: '' })
      setUploadFile(null)
      if (fileRef.current) fileRef.current.value = ''
    } catch {
      alert('Błąd podczas wgrywania pliku')
    } finally {
      setUploading(false)
    }
  }

  const handleDownload = async (doc: ProjectDocument) => {
    const blob = await projectDocumentsApi.download(projectId, doc.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = doc.file_name
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDelete = async (doc: ProjectDocument) => {
    if (!confirm(`Usunąć dokument "${doc.name}"?`)) return
    await projectDocumentsApi.delete(projectId, doc.id)
    setDocs(prev => prev.filter(d => d.id !== doc.id))
  }

  const handleGenerateContract = async () => {
    setGeneratingContract(true)
    try {
      const blob = await projectDocumentsApi.generateContract(projectId, cf)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const safeName = `Umowa_${(cf.client_company || 'Klient').replace(/[^a-zA-Z0-9]/g, '_')}_${cf.contract_date.replace(/-/g, '')}.docx`
      a.download = safeName
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Błąd generowania umowy')
    } finally {
      setGeneratingContract(false)
    }
  }

  const updateTranche = (i: number, field: string, value: string | number) => {
    setCf(prev => {
      const t = [...prev.tranches]
      t[i] = { ...t[i], [field]: value }
      return { ...prev, tranches: t }
    })
  }

  const docTypeColor: Record<string, string> = {
    offer:    'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
    contract: 'bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300',
    annex:    'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
    other:    'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  }

  if (loading) return <p className="text-sm text-gray-400 text-center py-10">Ładowanie...</p>

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Dokumenty projektu ({docs.length})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => setShowContract(c => !c)}
            className="px-3 py-1.5 text-xs font-medium border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/20 rounded-lg transition-colors"
          >
            📝 Generuj umowę
          </button>
          <button
            onClick={() => setShowUpload(c => !c)}
            className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
          >
            + Wgraj dokument
          </button>
        </div>
      </div>

      {/* Upload form */}
      {showUpload && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-3 bg-gray-50 dark:bg-gray-800/50">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Wgraj dokument</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Typ dokumentu</label>
              <select
                value={uploadForm.doc_type}
                onChange={e => setUploadForm(f => ({ ...f, doc_type: e.target.value }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
              >
                {Object.entries(PROJECT_DOC_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nazwa (opcjonalna)</label>
              <input
                type="text"
                value={uploadForm.name}
                onChange={e => setUploadForm(f => ({ ...f, name: e.target.value }))}
                placeholder="np. Oferta v2"
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Plik</label>
            <input ref={fileRef} type="file" onChange={handleFileChange} className="text-sm text-gray-600 dark:text-gray-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notatka (opcjonalna)</label>
            <input
              type="text"
              value={uploadForm.notes}
              onChange={e => setUploadForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleUpload}
              disabled={!uploadFile || uploading}
              className="px-4 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              {uploading ? 'Wgrywanie...' : 'Wgraj'}
            </button>
            <button onClick={() => setShowUpload(false)} className="px-4 py-2 text-xs font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
              Anuluj
            </button>
          </div>
        </div>
      )}

      {/* Contract generator form */}
      {showContract && (
        <div className="border border-violet-200 dark:border-violet-800 rounded-xl p-4 space-y-4 bg-violet-50/50 dark:bg-violet-950/10">
          <h4 className="text-sm font-semibold text-violet-700 dark:text-violet-300">📝 Generator standardowej umowy</h4>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Data umowy</label>
              <input type="date" value={cf.contract_date} onChange={e => setCf(p => ({ ...p, contract_date: e.target.value }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Firma klienta</label>
              <input type="text" value={cf.client_company} onChange={e => setCf(p => ({ ...p, client_company: e.target.value }))}
                placeholder="np. ABC Sp. z o.o."
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Adres klienta</label>
              <input type="text" value={cf.client_address} onChange={e => setCf(p => ({ ...p, client_address: e.target.value }))}
                placeholder="ul. Przykładowa 1, Warszawa"
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Przedstawiciel klienta</label>
              <input type="text" value={cf.client_representative} onChange={e => setCf(p => ({ ...p, client_representative: e.target.value }))}
                placeholder="np. Jana Kowalskiego - Prezesa"
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">KRS klienta (opcjonalnie)</label>
              <input type="text" value={cf.client_krs} onChange={e => setCf(p => ({ ...p, client_krs: e.target.value }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">NIP klienta (opcjonalnie)</label>
              <input type="text" value={cf.client_nip} onChange={e => setCf(p => ({ ...p, client_nip: e.target.value }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Przedmiot umowy (opis zakresu)</label>
            <textarea value={cf.scope_description} onChange={e => setCf(p => ({ ...p, scope_description: e.target.value }))}
              rows={2} placeholder="np. wykonanie instalacji domu inteligentnego zgodnie z ofertą..."
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 resize-none" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Termin rozpoczęcia</label>
              <input type="date" value={cf.start_date} onChange={e => setCf(p => ({ ...p, start_date: e.target.value }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Termin zakończenia</label>
              <input type="date" value={cf.end_date} onChange={e => setCf(p => ({ ...p, end_date: e.target.value }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Wartość netto (PLN)</label>
              <input type="number" value={cf.total_amount_net} onChange={e => setCf(p => ({ ...p, total_amount_net: Number(e.target.value) }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Gwarancja (miesiące)</label>
              <input type="number" value={cf.guarantee_months} onChange={e => setCf(p => ({ ...p, guarantee_months: Number(e.target.value) }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Lokalizacja (opcjonalnie)</label>
              <input type="text" value={cf.location_name} onChange={e => setCf(p => ({ ...p, location_name: e.target.value }))}
                placeholder="np. budynku Bagatela 10"
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Przedstawiciel SHC</label>
              <input type="text" value={cf.shc_representative} onChange={e => setCf(p => ({ ...p, shc_representative: e.target.value }))}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
            </div>
          </div>

          {/* Tranches */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Transze płatności</label>
              <button onClick={() => setCf(p => ({ ...p, tranches: [...p.tranches, { label: '', amount: 0, due_date: '' }] }))}
                className="text-xs text-violet-600 hover:underline">+ Dodaj transzę</button>
            </div>
            <div className="space-y-2">
              {cf.tranches.map((t, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="text" value={t.label} onChange={e => updateTranche(i, 'label', e.target.value)}
                    placeholder="Opis (np. zaliczka)"
                    className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
                  <input type="number" value={t.amount} onChange={e => updateTranche(i, 'amount', Number(e.target.value))}
                    placeholder="Kwota PLN netto"
                    className="w-36 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
                  <input type="date" value={t.due_date} onChange={e => updateTranche(i, 'due_date', e.target.value)}
                    className="w-40 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200" />
                  <button onClick={() => setCf(p => ({ ...p, tranches: p.tranches.filter((_, j) => j !== i) }))}
                    className="text-red-400 hover:text-red-600 text-sm px-1">✕</button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleGenerateContract}
              disabled={generatingContract}
              className="px-4 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              {generatingContract ? 'Generowanie...' : '⬇️ Pobierz umowę (.docx)'}
            </button>
            <button onClick={() => setShowContract(false)} className="px-4 py-2 text-xs font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
              Zamknij
            </button>
          </div>
        </div>
      )}

      {/* Documents list */}
      {docs.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">Brak dokumentów. Wgraj pierwszą ofertę lub umowę.</p>
      ) : (
        <div className="space-y-2">
          {docs.map(doc => (
            <div key={doc.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 hover:border-gray-200 dark:hover:border-gray-600 transition-colors">
              <div className="text-xl flex-shrink-0">
                {doc.mime_type === 'application/pdf' ? '📄' : doc.mime_type?.includes('word') ? '📝' : '📎'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{doc.name}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className={`inline-flex text-xs px-1.5 py-0.5 rounded font-medium ${docTypeColor[doc.doc_type] ?? docTypeColor.other}`}>
                    {PROJECT_DOC_TYPE_LABELS[doc.doc_type as keyof typeof PROJECT_DOC_TYPE_LABELS] ?? doc.doc_type}
                  </span>
                  <span className="text-xs text-gray-400">{doc.file_name}</span>
                  {doc.notes && <span className="text-xs text-gray-400 italic truncate max-w-xs">{doc.notes}</span>}
                  <span className="text-xs text-gray-400">{new Date(doc.uploaded_at).toLocaleDateString('pl-PL')}</span>
                </div>
              </div>
              <button
                onClick={() => handleDownload(doc)}
                className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors flex-shrink-0"
              >
                ⬇️ Pobierz
              </button>
              <button
                onClick={() => handleDelete(doc)}
                className="px-3 py-1.5 text-xs font-medium border border-red-200 dark:border-red-900 text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors flex-shrink-0"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [project, setProject] = useState<ProjectDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('materials')
  const [showEdit, setShowEdit] = useState(false)
  const [showAddCost, setShowAddCost] = useState(false)
  const [showAddLabor, setShowAddLabor] = useState(false)
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [aiQuotes, setAiQuotes] = useState<AiQuote[]>([])
  const [aiQuotesLoaded, setAiQuotesLoaded] = useState(false)
  const [auditLog, setAuditLog] = useState<CostAuditEntry[]>([])
  const [auditLoaded, setAuditLoaded] = useState(false)

  const load = () => {
    if (!id) return
    projectsApi.get(id).then(data => {
      setProject(data)
      setLoading(false)
    })
  }

  useEffect(() => { load() }, [id])

  useEffect(() => {
    if (tab === 'ai_quote' && id && !aiQuotesLoaded) {
      aiQuotesApi.list(id).then(data => {
        setAiQuotes(data)
        setAiQuotesLoaded(true)
      })
    }
    if (tab === 'history' && id && !auditLoaded) {
      costsApi.auditLog(id).then(data => {
        setAuditLog(data)
        setAuditLoaded(true)
      }).catch(() => {})
    }
  }, [tab, id, aiQuotesLoaded, auditLoaded])

  const handleDelete = async () => {
    if (!project) return
    if (!confirm(`Usunąć projekt "${project.name}"? Wszystkie koszty zostaną usunięte.`)) return
    setDeleting(true)
    await projectsApi.delete(project.id)
    navigate('/projects')
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">Ładowanie...</div>
  }
  if (!project) {
    return <div className="flex items-center justify-center h-64 text-red-500">Projekt nie znaleziony</div>
  }

  const budget = project.budget_amount
  const costMaterials = project.cost_items
    .filter(i => i.category === 'materials')
    .reduce((s, i) => s + i.total_price, 0)
  const costSubcontractors = project.cost_items
    .filter(i => i.category === 'subcontractor')
    .reduce((s, i) => s + i.total_price, 0)
  const costOther = project.cost_items
    .filter(i => i.category === 'other')
    .reduce((s, i) => s + i.total_price, 0)
  const costLabor = project.labor_entries
    .reduce((s, e) => s + e.hours * e.hourly_rate, 0)
  const costTotal = project.cost_total ?? (costMaterials + costSubcontractors + costOther + costLabor)
  const payments = project.client_payments ?? []
  const paymentsTotal = payments.reduce((s, p) => s + p.amount, 0)
  const revenue = Math.max(budget, paymentsTotal)
  const marginPln = revenue - costTotal
  const marginPct = revenue > 0 ? (marginPln / revenue) * 100 : 0

  const budgetPct = budget > 0 ? Math.min((costTotal / budget) * 100, 100) : 0
  const isOverBudget = costTotal > revenue && revenue > 0

  let barColor = 'bg-green-500'
  if (budgetPct > 80) barColor = 'bg-red-500'
  else if (budgetPct > 60) barColor = 'bg-yellow-500'

  let marginColor = 'text-green-600 dark:text-green-400'
  if (marginPct < 0) marginColor = 'text-red-600 dark:text-red-400'
  else if (marginPct < 10) marginColor = 'text-orange-600 dark:text-orange-400'
  else if (marginPct < 25) marginColor = 'text-yellow-600 dark:text-yellow-400'

  const filterCostItems = (cat: string) => project.cost_items.filter(i => i.category === cat)

  const tabs = [
    { key: 'materials' as Tab, label: `Materiały (${filterCostItems('materials').length})` },
    { key: 'subcontractor' as Tab, label: `Podwykonawcy (${filterCostItems('subcontractor').length})` },
    { key: 'other' as Tab, label: `Inne (${filterCostItems('other').length})` },
    { key: 'labor' as Tab, label: `Robocizna (${project.labor_entries.length})` },
    ...(isAdmin ? [{ key: 'payments' as Tab, label: `💳 Wpłaty (${payments.length})` }] : []),
    { key: 'ai_quote' as Tab, label: `🤖 Wycena AI${aiQuotes.length > 0 ? ` (${aiQuotes.length})` : ''}` },
    { key: 'extra_costs' as Tab, label: `📋 Koszty dodatkowe${project.extra_costs_count > 0 ? ` (${project.extra_costs_count})` : ''}` },
    { key: 'documents' as Tab, label: '📁 Dokumenty' },
    { key: 'history' as Tab, label: '🕓 Historia zmian' },
  ]

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <button onClick={() => navigate('/projects')} className="text-violet-600 dark:text-violet-400 hover:underline">
          ← Projekty
        </button>
        <span className="text-gray-400">/</span>
        <span className="text-gray-600 dark:text-gray-400 truncate">{project.name}</span>
      </div>

      {/* Header card */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <TypeBadge type={project.project_type} />
              <StatusBadge status={project.status} />
              {isOverBudget && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  🚨 Przekroczony budżet
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100 mt-1">{project.name}</h1>
            {project.client_name && (
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                👤 {project.client_name}
                {project.client_contact && ` · ${project.client_contact}`}
              </div>
            )}
            {(project.start_date || project.end_date) && (
              <div className="text-xs text-gray-400 mt-1">
                📅 {project.start_date || '?'} → {project.end_date || '?'}
              </div>
            )}
            {project.description && (
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-xl">{project.description}</div>
            )}
            {project.area_m2 != null && (
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                📐 Metraż: <span className="font-medium text-gray-700 dark:text-gray-300">{project.area_m2} m²</span>
              </div>
            )}
            {project.smart_features && project.smart_features.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {project.smart_features.map(key => {
                  const f = SMART_FEATURES.find(sf => sf.key === key)
                  if (!f) return null
                  return (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300"
                    >
                      {f.icon} {f.label}
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setShowEdit(true)}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            >
              ✏️ Edytuj
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-xs font-medium border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors disabled:opacity-50"
            >
              🗑 Usuń
            </button>
          </div>
        </div>
      </div>

      {/* Cost summary card */}
      <div className={`bg-white dark:bg-gray-900 rounded-xl border p-5 ${isOverBudget ? 'border-red-300 dark:border-red-700' : 'border-gray-200 dark:border-gray-700'}`}>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center gap-2">
          <span>💰</span> Kontrola kosztów
        </h2>

        {/* Budget progress bar */}
        {budget > 0 && (
          <div className="mb-5">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
              <span>Wydano {fmt(costTotal)} PLN z {fmt(budget)} PLN budżetu</span>
              <span className="font-medium">{budgetPct.toFixed(0)}%</span>
            </div>
            <div className="h-2.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${barColor}`}
                style={{ width: `${Math.min(budgetPct, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Cost breakdown grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Budżet oferty', value: budget, color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-950/20', adminOnly: false },
            { label: 'Wpłaty klienta', value: paymentsTotal, color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-950/20', adminOnly: true },
            { label: 'Materiały', value: costMaterials, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/20', adminOnly: false },
            { label: 'Robocizna', value: costLabor, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/20', adminOnly: false },
            { label: 'Podwykonawcy', value: costSubcontractors, color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950/20', adminOnly: false },
            { label: 'Inne koszty', value: costOther, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-800', adminOnly: false },
          ].filter(item => !item.adminOnly || isAdmin).map(item => (
            <div key={item.label} className={`rounded-lg p-3 ${item.bg}`}>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{item.label}</div>
              <div className={`text-lg font-bold ${item.color}`}>{fmtDec(item.value)}</div>
              <div className="text-xs text-gray-400">PLN</div>
            </div>
          ))}
        </div>

        {/* Total + margin */}
        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Łączne koszty</div>
            <div className={`text-2xl font-bold ${isOverBudget ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>
              {fmtDec(costTotal)} PLN
            </div>
          </div>

          {isAdmin && paymentsTotal > 0 && (
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Wpłynęło od klienta</div>
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                {fmtDec(paymentsTotal)} PLN
              </div>
              {paymentsTotal > budget && budget > 0 && (
                <div className="text-xs text-amber-500">+{fmtDec(paymentsTotal - budget)} prace dodatkowe</div>
              )}
            </div>
          )}

          {isAdmin && (
            <div className="text-right">
              <div className="text-xs text-gray-500 dark:text-gray-400">Marża</div>
              <div className={`text-2xl font-bold ${marginColor}`}>
                {marginPct.toFixed(1)}%
              </div>
              <div className="text-xs text-gray-400">{fmtDec(marginPln)} PLN</div>
            </div>
          )}
        </div>
      </div>

      {/* Cost details tabs */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex gap-1 flex-wrap">
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  tab === t.key
                    ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div>
            {tab === 'labor' && (
              <button
                onClick={() => setShowAddLabor(true)}
                className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
              >
                + Dodaj robociznę
              </button>
            )}
            {tab === 'payments' && isAdmin && (
              <button
                onClick={() => setShowAddPayment(true)}
                className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
              >
                + Dodaj wpłatę
              </button>
            )}
            {(tab === 'materials' || tab === 'subcontractor' || tab === 'other') && (
              <button
                onClick={() => setShowAddCost(true)}
                className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
              >
                + Dodaj koszt
              </button>
            )}
          </div>
        </div>

        {tab === 'extra_costs' && (
          <ExtraCostsTab
            projectId={project.id}
            projectName={project.name}
            clientContact={project.client_contact}
          />
        )}
        {tab === 'documents' && (
          <ProjectDocumentsTab projectId={project.id} project={project} />
        )}
        {tab === 'history' && (
          <HistoryTab auditLog={auditLog} project={project} />
        )}
        {tab === 'ai_quote' && (
          <AIQuoteTab
            projectId={project.id}
            quotes={aiQuotes}
            onQuotesChanged={setAiQuotes}
          />
        )}
        {tab === 'labor' && (
          <LaborTable
            entries={project.labor_entries}
            isAdmin={isAdmin}
            onDeleted={(itemId) => setProject(p => p ? { ...p, labor_entries: p.labor_entries.filter(e => e.id !== itemId) } : p)}
          />
        )}
        {tab === 'payments' && (
          <PaymentTable
            payments={payments}
            onDeleted={(itemId) => setProject(p => p ? { ...p, client_payments: (p.client_payments ?? []).filter(pay => pay.id !== itemId) } : p)}
          />
        )}
        {(tab === 'materials' || tab === 'subcontractor' || tab === 'other') && (
          <CostTable
            items={filterCostItems(tab)}
            projectId={project.id}
            onDeleted={(itemId) => setProject(p => p ? { ...p, cost_items: p.cost_items.filter(i => i.id !== itemId) } : p)}
            onUpdated={(updated) => setProject(p => p ? { ...p, cost_items: p.cost_items.map(i => i.id === updated.id ? updated : i) } : p)}
          />
        )}
      </div>

      {/* Modals */}
      {showEdit && (
        <AddProjectModal
          onClose={() => setShowEdit(false)}
          onCreated={() => load()}
          initial={project}
          editMode
        />
      )}
      {showAddCost && (
        <AddCostModal
          projectId={project.id}
          onClose={() => setShowAddCost(false)}
          onCreated={(item: CostItem) => {
            setProject(p => p ? { ...p, cost_items: [item, ...p.cost_items] } : p)
          }}
        />
      )}
      {showAddLabor && (
        <AddLaborModal
          projectId={project.id}
          isAdmin={isAdmin}
          onClose={() => setShowAddLabor(false)}
          onCreated={(entry: LaborEntry) => {
            setProject(p => p ? { ...p, labor_entries: [entry, ...p.labor_entries] } : p)
          }}
        />
      )}
      {showAddPayment && (
        <AddPaymentModal
          projectId={project.id}
          onClose={() => setShowAddPayment(false)}
          onCreated={(payment: ClientPayment) => {
            setProject(p => p ? { ...p, client_payments: [payment, ...(p.client_payments ?? [])] } : p)
          }}
        />
      )}
    </div>
  )
}
