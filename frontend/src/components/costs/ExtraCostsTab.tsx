import { useEffect, useRef, useState } from 'react'
import type { ExtraCost, ExtraCostStatus } from '../../types'
import { EXTRA_COST_STATUS_LABELS, EXTRA_COST_STATUS_COLORS } from '../../types'
import { extraCostsApi } from '../../api/client'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('pl-PL')
}

const STATUS_FILTER_OPTIONS: { key: ExtraCostStatus | 'all'; label: string }[] = [
  { key: 'all',      label: 'Wszystkie' },
  { key: 'pending',  label: 'Oczekujące' },
  { key: 'sent',     label: 'Wysłane' },
  { key: 'approved', label: 'Zaakceptowane' },
  { key: 'rejected', label: 'Odrzucone' },
]

// ─── Add/Edit form (inline modal) ─────────────────────────────────────────────
interface FormData {
  description: string
  quantity: string
  unit_price: string
  date: string
  is_out_of_scope: boolean
  notes: string
}

const EMPTY_FORM: FormData = {
  description: '', quantity: '1', unit_price: '0',
  date: new Date().toISOString().slice(0, 10),
  is_out_of_scope: false, notes: '',
}

function AddEditModal({
  initial,
  onClose,
  onSave,
}: {
  initial?: ExtraCost | null
  onClose: () => void
  onSave: (data: FormData) => Promise<void>
}) {
  const [form, setForm] = useState<FormData>(
    initial
      ? {
          description: initial.description,
          quantity: String(initial.quantity),
          unit_price: String(initial.unit_price),
          date: initial.date,
          is_out_of_scope: initial.is_out_of_scope,
          notes: initial.notes,
        }
      : EMPTY_FORM,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const descRef = useRef<HTMLInputElement>(null)

  useEffect(() => { descRef.current?.focus() }, [])

  const preview = (Number(form.quantity) || 0) * (Number(form.unit_price) || 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.description.trim()) { setError('Opis jest wymagany.'); return }
    setSaving(true)
    setError('')
    try {
      await onSave(form)
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Błąd zapisu.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
            {initial ? 'Edytuj koszt dodatkowy' : 'Dodaj koszt dodatkowy'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Description */}
          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Opis kosztu *</label>
            <input
              ref={descRef}
              className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              placeholder="np. Dodatkowa trasa kablowa w garażu"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>

          {/* Qty + Price + Date */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Ilość</label>
              <input
                type="number" min="0" step="0.1"
                className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Cena netto PLN</label>
              <input
                type="number" min="0" step="1"
                className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={form.unit_price}
                onChange={e => setForm(f => ({ ...f, unit_price: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Data</label>
              <input
                type="date"
                className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              />
            </div>
          </div>

          {/* Total preview */}
          {preview > 0 && (
            <div className="text-right text-sm font-medium text-gray-700 dark:text-gray-300">
              Razem: <span className="text-violet-600 dark:text-violet-400">{fmt(preview)} PLN</span>
            </div>
          )}

          {/* Out of scope checkbox */}
          <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
            form.is_out_of_scope
              ? 'border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/20'
              : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/40'
          }`}>
            <input
              type="checkbox"
              className="mt-0.5 accent-orange-500"
              checked={form.is_out_of_scope}
              onChange={e => setForm(f => ({ ...f, is_out_of_scope: e.target.checked }))}
            />
            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                ⚠️ Koszt ponadprogramowy
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Praca lub materiał wykraczający poza pierwotny zakres projektu — wymaga akceptacji klienta
              </div>
            </div>
          </label>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1.5">Uwagi (opcjonalne)</label>
            <textarea
              rows={2}
              className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 resize-none"
              placeholder="Dodatkowe informacje dla klienta…"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
          )}
        </form>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 dark:border-gray-800">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50">
            Anuluj
          </button>
          <button onClick={e => { e.preventDefault(); handleSubmit(e as any) }} disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Zapisuję…' : (initial ? 'Zapisz zmiany' : 'Dodaj koszt')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Send to Client Modal ──────────────────────────────────────────────────────
function SendToClientModal({
  projectId,
  projectName,
  items,
  onClose,
  onSent,
  clientContact,
}: {
  projectId: string
  projectName: string
  items: ExtraCost[]
  onClose: () => void
  onSent: (ids: string[], sentAt: string) => void
  clientContact?: string
}) {
  // Pre-fill email if client_contact looks like an email address
  const prefillEmail = clientContact?.includes('@') ? clientContact.trim() : ''
  const pendingItems = items.filter(i => i.status === 'pending')
  const [selected, setSelected] = useState<Set<string>>(new Set(pendingItems.length > 0 ? pendingItems.map(i => i.id) : items.map(i => i.id)))
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [sentAt, setSentAt] = useState('')
  const [sentEmail, setSentEmail] = useState('')
  const [clientEmail, setClientEmail] = useState(prefillEmail)
  const [emailError, setEmailError] = useState('')
  const printRef = useRef<HTMLDivElement>(null)

  const allItems = items
  const toggleAll = () => {
    if (selected.size === allItems.length) setSelected(new Set())
    else setSelected(new Set(allItems.map(i => i.id)))
  }

  const selectedItems = items.filter(i => selected.has(i.id))
  const total = selectedItems.reduce((s, i) => s + i.total_price, 0)

  const handlePrint = () => { window.print() }

  const handleSendEmail = async () => {
    if (selected.size === 0) return
    if (!clientEmail.trim() || !clientEmail.includes('@')) {
      setEmailError('Podaj poprawny adres email klienta.')
      return
    }
    setEmailError('')
    setSending(true)
    try {
      const res = await extraCostsApi.sendEmail(projectId, Array.from(selected), clientEmail.trim())
      const at = new Date(res.sent_at).toLocaleString('pl-PL')
      setSentAt(at)
      setSentEmail(res.email)
      setSent(true)
      onSent(Array.from(selected), res.sent_at)
    } catch (err: any) {
      setEmailError(err?.response?.data?.error ?? 'Błąd wysyłania emaila.')
    } finally {
      setSending(false)
    }
  }

  const handleMarkSent = async () => {
    if (selected.size === 0) return
    setSending(true)
    try {
      const res = await extraCostsApi.send(projectId, Array.from(selected))
      const at = new Date(res.sent_at).toLocaleString('pl-PL')
      setSentAt(at)
      setSentEmail('')
      setSent(true)
      onSent(Array.from(selected), res.sent_at)
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Błąd wysyłania.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !sending) onClose() }}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 w-full max-w-3xl shadow-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">📤 Zestawienie kosztów dodatkowych</h2>
            <p className="text-xs text-gray-400 mt-0.5">Wybierz pozycje do przesłania klientowi do akceptacji</p>
          </div>
          <button onClick={onClose} disabled={sending} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">✕</button>
        </div>

        {sent ? (
          /* Success state */
          <div className="px-6 py-10 text-center flex-1">
            <div className="text-5xl mb-4">{sentEmail ? '📧' : '✅'}</div>
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">
              {sentEmail ? 'Email wysłany do klienta!' : 'Zestawienie przygotowane!'}
            </h3>
            {sentEmail ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                Email z prośbą o akceptację został wysłany na adres{' '}
                <strong className="text-violet-600 dark:text-violet-400">{sentEmail}</strong>
              </p>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
                {selected.size} {selected.size === 1 ? 'pozycja oznaczona' : 'pozycji oznaczonych'} jako <strong>„Wysłane do klienta"</strong>
              </p>
            )}
            <p className="text-xs text-gray-400">{sentAt}</p>
            <button onClick={onClose}
              className="mt-6 px-6 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-lg transition-colors">
              Zamknij
            </button>
          </div>
        ) : (
          <>
            {/* ── Email do klienta — widoczne od razu pod nagłówkiem ── */}
            <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0 bg-green-50 dark:bg-green-950/20 print:hidden">
              <label className="text-xs font-semibold text-green-800 dark:text-green-300 block mb-2">
                📧 Wyślij do klienta emailem — adres email klienta
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="email"
                  placeholder="np. jan.kowalski@firma.pl"
                  value={clientEmail}
                  onChange={e => { setClientEmail(e.target.value); setEmailError('') }}
                  disabled={sending}
                  className="flex-1 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-green-400 disabled:opacity-50"
                />
                <button
                  onClick={handleSendEmail}
                  disabled={sending || selected.size === 0}
                  className="px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap flex-shrink-0"
                >
                  {sending
                    ? <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Wysyłam…</>
                    : `📧 Wyślij email (${selected.size})`
                  }
                </button>
              </div>
              {emailError && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1.5">{emailError}</p>
              )}
              <p className="text-xs text-green-700 dark:text-green-400 mt-1.5 opacity-70">
                Klient otrzyma email z przyciskami „Akceptuję" i „Nie akceptuję"
              </p>
            </div>

            {/* Printable summary area */}
            <div ref={printRef} className="flex-1 overflow-y-auto px-6 py-4 print:px-0 print:py-0">

              {/* Print header */}
              <div className="hidden print:block mb-6">
                <h1 className="text-2xl font-bold text-gray-900">Zestawienie kosztów dodatkowych</h1>
                <p className="text-gray-600 mt-1">Projekt: <strong>{projectName}</strong></p>
                <p className="text-gray-500 text-sm">Data: {new Date().toLocaleDateString('pl-PL')}</p>
                <hr className="mt-4" />
              </div>

              {allItems.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  Brak kosztów dodatkowych w tym projekcie.
                </div>
              ) : (
                <>
                  {/* Select all */}
                  <div className="flex items-center gap-2 mb-3 print:hidden">
                    <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                      <input type="checkbox"
                        checked={selected.size === allItems.length && allItems.length > 0}
                        onChange={toggleAll}
                        className="accent-violet-500"
                      />
                      Zaznacz wszystkie ({allItems.length})
                    </label>
                    <span className="text-xs text-gray-400">· Zaznaczono: {selected.size}</span>
                  </div>

                  {/* Items table */}
                  <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-gray-500 dark:text-gray-400">
                          <th className="px-3 py-2.5 w-8 print:hidden" />
                          <th className="px-3 py-2.5 text-left font-medium">Data</th>
                          <th className="px-3 py-2.5 text-left font-medium">Opis</th>
                          <th className="px-3 py-2.5 text-right font-medium">Ilość</th>
                          <th className="px-3 py-2.5 text-right font-medium">Cena jedn.</th>
                          <th className="px-3 py-2.5 text-right font-medium">Razem</th>
                          <th className="px-3 py-2.5 text-center font-medium w-24">Typ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {allItems.map((item) => {
                          const isSel = selected.has(item.id)
                          return (
                            <tr
                              key={item.id}
                              onClick={() => {
                                setSelected(prev => {
                                  const next = new Set(prev)
                                  isSel ? next.delete(item.id) : next.add(item.id)
                                  return next
                                })
                              }}
                              className={`cursor-pointer transition-colors print:cursor-default ${
                                isSel
                                  ? 'bg-violet-50 dark:bg-violet-900/10'
                                  : 'hover:bg-gray-50 dark:hover:bg-gray-800/20 opacity-40'
                              }`}
                            >
                              <td className="px-3 py-2.5 print:hidden">
                                <input type="checkbox" className="accent-violet-500"
                                  checked={isSel} onChange={() => {}} />
                              </td>
                              <td className="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                                {fmtDate(item.date)}
                              </td>
                              <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300">
                                <div>{item.description}</div>
                                {item.notes && (
                                  <div className="text-xs text-gray-400 mt-0.5">{item.notes}</div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right text-xs text-gray-500 dark:text-gray-400">
                                {item.quantity}
                              </td>
                              <td className="px-3 py-2.5 text-right text-xs text-gray-500 dark:text-gray-400">
                                {fmt(item.unit_price)}
                              </td>
                              <td className="px-3 py-2.5 text-right font-medium text-gray-800 dark:text-gray-200">
                                {fmt(item.total_price)} PLN
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                {item.is_out_of_scope
                                  ? <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">⚠️ Ponadprogramowy</span>
                                  : <span className="text-xs text-gray-400">standardowy</span>
                                }
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="bg-gray-50 dark:bg-gray-800/60 border-t-2 border-gray-200 dark:border-gray-700">
                          <td colSpan={5} className="px-3 py-3 text-sm font-semibold text-gray-700 dark:text-gray-300 text-right">
                            Suma zaznaczonych:
                          </td>
                          <td className="px-3 py-3 text-right text-sm font-bold text-violet-700 dark:text-violet-300">
                            {fmt(total)} PLN
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Print approval section */}
                  <div className="hidden print:block mt-8 border-t pt-6">
                    <p className="text-sm text-gray-600 mb-6">
                      Prosimy o zapoznanie się z powyższym zestawieniem kosztów dodatkowych i potwierdzenie akceptacji.<br />
                      Prace zostaną rozpoczęte po uzyskaniu pisemnej akceptacji.
                    </p>
                    <div className="grid grid-cols-2 gap-16 mt-8">
                      <div>
                        <div className="border-b border-gray-400 mb-2 pb-8" />
                        <p className="text-xs text-gray-500">Podpis i pieczątka klienta / data</p>
                      </div>
                      <div>
                        <div className="border-b border-gray-400 mb-2 pb-8" />
                        <p className="text-xs text-gray-500">Podpis wykonawcy / data</p>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex-shrink-0 flex-wrap print:hidden">
              <button onClick={handlePrint}
                className="px-3 py-2 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors flex items-center gap-1.5">
                🖨️ Drukuj / Eksportuj PDF
              </button>
              <div className="flex gap-2 items-center">
                <button onClick={onClose} disabled={sending}
                  className="px-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50">
                  Anuluj
                </button>
                <button
                  onClick={handleMarkSent}
                  disabled={sending || selected.size === 0}
                  className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 rounded-lg transition-colors"
                >
                  Oznacz jako wysłane (bez emaila)
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Main ExtraCostsTab ────────────────────────────────────────────────────────
export default function ExtraCostsTab({ projectId, projectName, clientContact }: { projectId: string; projectName: string; clientContact?: string }) {
  const [items, setItems] = useState<ExtraCost[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<ExtraCostStatus | 'all'>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [editingItem, setEditingItem] = useState<ExtraCost | null>(null)
  const [showSend, setShowSend] = useState(false)

  const load = () => {
    setLoading(true)
    extraCostsApi.list(projectId).then(data => {
      setItems(data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [projectId])

  const filtered = statusFilter === 'all' ? items : items.filter(i => i.status === statusFilter)
  const pendingCount = items.filter(i => i.status === 'pending').length
  const totalFiltered = filtered.reduce((s, i) => s + i.total_price, 0)

  const handleAdd = async (form: FormData) => {
    const item = await extraCostsApi.create(projectId, {
      description: form.description,
      quantity: Number(form.quantity),
      unit_price: Number(form.unit_price),
      date: form.date,
      is_out_of_scope: form.is_out_of_scope,
      notes: form.notes,
    })
    setItems(prev => [item, ...prev])
    setShowAdd(false)
  }

  const handleEdit = async (form: FormData) => {
    if (!editingItem) return
    const updated = await extraCostsApi.update(editingItem.id, {
      description: form.description,
      quantity: Number(form.quantity),
      unit_price: Number(form.unit_price),
      date: form.date,
      is_out_of_scope: form.is_out_of_scope,
      notes: form.notes,
    })
    setItems(prev => prev.map(i => i.id === editingItem.id ? updated : i))
    setEditingItem(null)
  }

  const handleStatusChange = async (item: ExtraCost, newStatus: ExtraCostStatus) => {
    const updated = await extraCostsApi.update(item.id, { status: newStatus })
    setItems(prev => prev.map(i => i.id === item.id ? updated : i))
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć ten koszt?')) return
    await extraCostsApi.delete(id)
    setItems(prev => prev.filter(i => i.id !== id))
  }

  const handleSent = (ids: string[], sentAt: string) => {
    setItems(prev => prev.map(i =>
      ids.includes(i.id) ? { ...i, status: 'sent' as ExtraCostStatus, sent_at: sentAt } : i,
    ))
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Status filter tabs */}
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTER_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setStatusFilter(opt.key)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                statusFilter === opt.key
                  ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 font-medium'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {opt.label}
              {opt.key !== 'all' && (
                <span className="ml-1 text-gray-400">
                  ({items.filter(i => i.status === opt.key).length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {items.length > 0 && (
            <button
              onClick={() => setShowSend(true)}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-1.5"
            >
              📧 Wyślij do klienta
            </button>
          )}
          <button
            onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors"
          >
            + Dodaj koszt dodatkowy
          </button>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">Ładowanie…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          {items.length === 0
            ? <><div className="text-3xl mb-2">📋</div>Brak kosztów dodatkowych.<br /><span className="text-xs">Kliknij <strong>+ Dodaj koszt dodatkowy</strong> aby dodać pierwszą pozycję.</span></>
            : 'Brak kosztów w wybranym statusie.'
          }
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 text-left">
                <th className="px-3 py-2.5 font-medium w-24">Data</th>
                <th className="px-3 py-2.5 font-medium">Opis</th>
                <th className="px-3 py-2.5 font-medium w-14 text-right">Ilość</th>
                <th className="px-3 py-2.5 font-medium w-28 text-right">Cena jedn.</th>
                <th className="px-3 py-2.5 font-medium w-28 text-right">Razem</th>
                <th className="px-3 py-2.5 font-medium w-24 text-center">Typ</th>
                <th className="px-3 py-2.5 font-medium w-36">Status</th>
                <th className="px-3 py-2.5 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map(item => (
                <tr key={item.id} className="group hover:bg-gray-50 dark:hover:bg-gray-800/20">
                  <td className="px-3 py-2.5 text-gray-400 whitespace-nowrap">{fmtDate(item.date)}</td>
                  <td className="px-3 py-2.5">
                    <div className="text-gray-700 dark:text-gray-300 font-medium">{item.description}</div>
                    {item.notes && (
                      <div className="text-gray-400 text-xs mt-0.5">{item.notes}</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right text-gray-500 dark:text-gray-400">{item.quantity}</td>
                  <td className="px-3 py-2.5 text-right text-gray-500 dark:text-gray-400">{fmt(item.unit_price)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-gray-800 dark:text-gray-200">
                    {fmt(item.total_price)} PLN
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {item.is_out_of_scope
                      ? <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">⚠️ Ponadprog.</span>
                      : <span className="text-gray-300 dark:text-gray-600">—</span>
                    }
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={item.status}
                      onChange={e => handleStatusChange(item, e.target.value as ExtraCostStatus)}
                      className={`text-xs px-2 py-1 rounded-md border-0 cursor-pointer ${EXTRA_COST_STATUS_COLORS[item.status]}`}
                    >
                      {Object.entries(EXTRA_COST_STATUS_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setEditingItem(item)}
                        className="text-xs text-gray-400 hover:text-violet-600 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700"
                      >✏️</button>
                      <button
                        onClick={() => handleDelete(item.id)}
                        className="text-xs text-red-400 hover:text-red-600 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700"
                      >🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800/40 border-t border-gray-200 dark:border-gray-700">
                <td colSpan={4} className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 font-medium text-right">
                  Suma {statusFilter !== 'all' ? `(${STATUS_FILTER_OPTIONS.find(o => o.key === statusFilter)?.label})` : ''}:
                </td>
                <td className="px-3 py-2 text-right text-xs font-bold text-gray-700 dark:text-gray-300">
                  {fmt(totalFiltered)} PLN
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Modals */}
      {showAdd && (
        <AddEditModal
          onClose={() => setShowAdd(false)}
          onSave={handleAdd}
        />
      )}
      {editingItem && (
        <AddEditModal
          initial={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={handleEdit}
        />
      )}
      {showSend && (
        <SendToClientModal
          projectId={projectId}
          projectName={projectName}
          items={items}
          onClose={() => setShowSend(false)}
          onSent={handleSent}
          clientContact={clientContact}
        />
      )}
    </div>
  )
}
