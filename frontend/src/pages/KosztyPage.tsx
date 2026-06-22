import { useEffect, useState } from 'react'
import { Plus, Send, Check, X } from 'lucide-react'
import { extraCostsApi, projectsApi } from '../api/client'
import type { ExtraCost, Project } from '../types'

type ExtraCostWithProject = ExtraCost & { project: { id: string; name: string } }

type FilterStatus = 'all' | 'pending' | 'sent' | 'approved' | 'rejected'

function fmtAmount(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(dateStr: string) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}.${mm}.${yyyy}`
}

function fmtDateShort(dateStr: string) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}`
}

// ── Status pill ────────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<ExtraCost['status'], { label: string; bg: string; fg: string; dot: string }> = {
  pending:  { label: 'Szkic',            bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' },
  sent:     { label: 'Czeka na klienta', bg: '#eff6ff', fg: '#1d4ed8', dot: '#2563eb' },
  approved: { label: 'Zaakceptowany',    bg: '#f0fdf4', fg: '#15803d', dot: '#16a34a' },
  rejected: { label: 'Odrzucony',        bg: '#fef2f2', fg: '#b91c1c', dot: '#dc2626' },
}

function StatusPill({ status }: { status: ExtraCost['status'] }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: cfg.bg, color: cfg.fg,
      fontSize: 13, fontWeight: 600,
      borderRadius: 999, padding: '4px 12px',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot, flexShrink: 0 }} />
      {cfg.label}
    </span>
  )
}

// ── KPI card ───────────────────────────────────────────────────────────────────
function KpiCard({ title, value, subtitle, valueColor }: { title: string; value: string | number; subtitle: string; valueColor: string }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
      padding: '24px 28px',
    }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#64748b', marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: valueColor, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', marginBottom: 6 }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: '#94a3b8' }}>{subtitle}</div>
    </div>
  )
}

// ── Filter chip ────────────────────────────────────────────────────────────────
function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? '#eff6ff' : '#fff',
        border: `1px solid ${active ? '#93c5fd' : '#e2e8f0'}`,
        color: active ? '#1d4ed8' : '#475569',
        fontSize: 13, fontWeight: 600,
        borderRadius: 999, padding: '4px 14px',
        cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'all 0.15s',
      }}
    >
      {label}
    </button>
  )
}

// ── Modal ──────────────────────────────────────────────────────────────────────
interface ModalProps {
  projects: Project[]
  onClose: () => void
  onSaved: () => void
}

function AddCostModal({ projects, onClose, onSaved }: ModalProps) {
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [nameError, setNameError] = useState(false)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(asDraft: boolean) {
    if (!description.trim()) {
      setNameError(true)
      return
    }
    setNameError(false)
    setSaving(true)
    const today = new Date().toISOString().slice(0, 10)
    const numAmount = parseFloat(amount) || 0
    try {
      await extraCostsApi.create(projectId, {
        description: description.trim(),
        total_price: numAmount,
        unit_price: numAmount,
        quantity: 1,
        notes,
        status: asDraft ? 'pending' : 'sent',
        date: today,
        is_out_of_scope: true,
      })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, width: 500, maxWidth: '95vw',
          boxShadow: '0 24px 64px rgba(15,23,42,0.25)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '24px 28px 20px', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Nowy koszt dodatkowy</div>
            <button
              onClick={onClose}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#94a3b8', display: 'flex', alignItems: 'center', padding: 4,
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Nazwa kosztu */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
              Nazwa kosztu <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={e => { setDescription(e.target.value); if (e.target.value.trim()) setNameError(false) }}
              placeholder="np. Dodatkowe okablowanie sieciowe"
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8, fontSize: 14,
                border: `1px solid ${nameError ? '#ef4444' : '#e2e8f0'}`,
                boxShadow: nameError ? '0 0 0 3px rgba(239,68,68,0.12)' : 'none',
                outline: 'none', boxSizing: 'border-box',
                fontFamily: 'inherit', color: '#0f172a',
              }}
              onFocus={e => { if (!nameError) e.target.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)'; e.target.style.borderColor = '#2563eb' }}
              onBlur={e => { if (!nameError) { e.target.style.boxShadow = 'none'; e.target.style.borderColor = '#e2e8f0' } }}
            />
            {nameError && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>Podaj nazwę kosztu</div>}
          </div>

          {/* Projekt + Kwota */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Projekt</label>
              <select
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 8, fontSize: 14,
                  border: '1px solid #e2e8f0', outline: 'none',
                  boxSizing: 'border-box', fontFamily: 'inherit', color: '#0f172a',
                  background: '#fff', cursor: 'pointer',
                }}
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Kwota netto (PLN)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0,00"
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 8, fontSize: 14,
                  border: '1px solid #e2e8f0', outline: 'none',
                  boxSizing: 'border-box', fontFamily: 'inherit', color: '#0f172a',
                  fontVariantNumeric: 'tabular-nums',
                }}
                onFocus={e => { e.target.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)'; e.target.style.borderColor = '#2563eb' }}
                onBlur={e => { e.target.style.boxShadow = 'none'; e.target.style.borderColor = '#e2e8f0' }}
              />
              {Number(amount) > 0 && (
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  Brutto (VAT 23%): <strong>{fmtAmount(Number(amount) * 1.23)} PLN</strong>
                </div>
              )}
            </div>
          </div>

          {/* Opis */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
              Opis dla klienta <span style={{ color: '#94a3b8', fontWeight: 400 }}>(opcjonalnie)</span>
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Szczegółowy opis prac lub uzasadnienie kosztu..."
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8, fontSize: 14,
                border: '1px solid #e2e8f0', outline: 'none', resize: 'vertical',
                boxSizing: 'border-box', fontFamily: 'inherit', color: '#0f172a',
                lineHeight: 1.5,
              }}
              onFocus={e => { e.target.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)'; e.target.style.borderColor = '#2563eb' }}
              onBlur={e => { e.target.style.boxShadow = 'none'; e.target.style.borderColor = '#e2e8f0' }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 28px', background: '#f8fafc',
          borderTop: '1px solid #e2e8f0',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '10px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              border: '1px solid #e2e8f0', background: '#fff', color: '#475569',
              cursor: 'pointer',
            }}
          >
            Anuluj
          </button>
          <button
            onClick={() => handleSubmit(true)}
            disabled={saving}
            style={{
              padding: '10px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              border: '1px solid #e2e8f0', background: '#fff', color: '#0f172a',
              cursor: 'pointer',
            }}
          >
            Zapisz jako szkic
          </button>
          <button
            onClick={() => handleSubmit(false)}
            disabled={saving}
            style={{
              padding: '10px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              border: 'none', background: '#2563eb', color: '#fff',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7,
              boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
            }}
          >
            <Send size={14} />
            Zapisz i wyślij do klienta
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function KosztyPage() {
  const [costs, setCosts] = useState<ExtraCostWithProject[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [showModal, setShowModal] = useState(false)

  async function reload() {
    setLoading(true)
    try {
      const [data, projs] = await Promise.all([extraCostsApi.listAll(), projectsApi.list()])
      setCosts(data)
      setProjects(projs)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  async function handleStatusChange(id: string, newStatus: ExtraCost['status']) {
    await extraCostsApi.update(id, { status: newStatus })
    reload()
  }

  // ── KPI computation ──────────────────────────────────────────────────────────
  const now = new Date()
  const currentMonth = now.getMonth()
  const currentYear = now.getFullYear()

  const sentCosts = costs.filter(c => c.status === 'sent')
  const sentTotal = sentCosts.reduce((s, c) => s + c.total_price, 0)
  const sentCount = sentCosts.length

  const approvedThisMonth = costs.filter(c => {
    if (c.status !== 'approved') return false
    const d = new Date(c.updated_at)
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear
  })
  const approvedSum = approvedThisMonth.reduce((s, c) => s + c.total_price, 0)
  const approvedCount = approvedThisMonth.length

  const pendingCosts = costs.filter(c => c.status === 'pending')
  const pendingTotal = pendingCosts.reduce((s, c) => s + c.total_price, 0)
  const pendingCount = pendingCosts.length

  const rejectedCount = costs.filter(c => c.status === 'rejected').length

  // ── Filtering ────────────────────────────────────────────────────────────────
  const filtered = costs.filter(c => {
    if (filterStatus !== 'all' && c.status !== filterStatus) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      if (!c.description.toLowerCase().includes(q) && !c.project.name.toLowerCase().includes(q)) return false
    }
    return true
  })

  const chipCounts: Record<FilterStatus, number> = {
    all: costs.length,
    pending: pendingCount,
    sent: sentCount,
    approved: costs.filter(c => c.status === 'approved').length,
    rejected: rejectedCount,
  }

  const chips: { key: FilterStatus; label: string }[] = [
    { key: 'all', label: `Wszystkie (${chipCounts.all})` },
    { key: 'pending', label: `Szkice (${chipCounts.pending})` },
    { key: 'sent', label: `Wysłane (${chipCounts.sent})` },
    { key: 'approved', label: `Zaakceptowane (${chipCounts.approved})` },
    { key: 'rejected', label: `Odrzucone (${chipCounts.rejected})` },
  ]

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: '#f8fafc', minHeight: '100vh',
      padding: '36px 32px 64px',
      fontFamily: "'IBM Plex Sans', sans-serif",
    }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{
            fontSize: 24, fontWeight: 700, color: '#0f172a',
            letterSpacing: '-0.01em', margin: 0, lineHeight: 1.2,
          }}>
            Koszty dodatkowe
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 6, marginBottom: 0 }}>
            Prace poza ofertą · wyślij do klienta — otrzyma e-mail z linkiem do akceptacji
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600,
            border: 'none', background: '#2563eb', color: '#fff',
            cursor: 'pointer', boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
            whiteSpace: 'nowrap',
          }}
        >
          <Plus size={16} />
          Dodaj koszt
        </button>
      </div>

      {/* KPI grid */}
      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 28 }}>
          <KpiCard
            title="Oczekują na akceptację klienta"
            value={sentCount}
            subtitle={`łącznie ${fmtAmount(sentTotal)} PLN netto`}
            valueColor="#1d4ed8"
          />
          <KpiCard
            title="Zaakceptowane w tym miesiącu"
            value={`${fmtAmount(approvedSum)} PLN`}
            subtitle={`${approvedCount} ${approvedCount === 1 ? 'pozycja' : approvedCount >= 2 && approvedCount <= 4 ? 'pozycje' : 'pozycji'} · PLN netto`}
            valueColor="#16a34a"
          />
          <KpiCard
            title="Szkice — niewysłane"
            value={pendingCount}
            subtitle={`łącznie ${fmtAmount(pendingTotal)} PLN netto`}
            valueColor="#475569"
          />
        </div>
      )}

      {/* Filters row */}
      <div style={{
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
        padding: '14px 20px', marginBottom: 20,
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Szukaj kosztu lub projektu…"
          style={{
            width: 300, padding: '8px 14px', borderRadius: 8, fontSize: 14,
            border: '1px solid #e2e8f0', outline: 'none',
            fontFamily: 'inherit', color: '#0f172a',
          }}
          onFocus={e => { e.target.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)'; e.target.style.borderColor = '#2563eb' }}
          onBlur={e => { e.target.style.boxShadow = 'none'; e.target.style.borderColor = '#e2e8f0' }}
        />
        <div style={{ width: 1, height: 24, background: '#e2e8f0', flexShrink: 0 }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {chips.map(chip => (
            <FilterChip
              key={chip.key}
              label={chip.label}
              active={filterStatus === chip.key}
              onClick={() => setFilterStatus(chip.key)}
            />
          ))}
        </div>
      </div>

      {/* Table card */}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>
            Ładowanie…
          </div>
        ) : (
          <>
            {/* Column headers */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2.3fr 1.4fr 0.8fr 1fr 1.5fr 1.7fr',
              padding: '12px 24px',
              borderBottom: '1px solid #f1f5f9',
              gap: 8,
            }}>
              {['Koszt', 'Projekt', 'Data', 'Kwota netto / brutto', 'Status', 'Akcje'].map((col, i) => (
                <div key={col} style={{
                  fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: '0.05em', color: '#94a3b8',
                  textAlign: i === 3 ? 'right' : i === 5 ? 'right' : 'left',
                }}>
                  {col}
                </div>
              ))}
            </div>

            {/* Rows */}
            {filtered.length === 0 ? (
              <div style={{ padding: '40px 24px', textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>
                Brak kosztów spełniających kryteria.
              </div>
            ) : (
              filtered.map((cost, idx) => (
                <div
                  key={cost.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2.3fr 1.4fr 0.8fr 1fr 1.5fr 1.7fr',
                    padding: '16px 24px',
                    borderBottom: idx < filtered.length - 1 ? '1px solid #f1f5f9' : 'none',
                    alignItems: 'center', gap: 8,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  {/* Koszt */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{cost.description}</div>
                    {cost.notes && (
                      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{cost.notes}</div>
                    )}
                  </div>

                  {/* Projekt */}
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#475569' }}>{cost.project.name}</div>

                  {/* Data */}
                  <div style={{ fontSize: 14, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtDate(cost.date)}
                  </div>

                  {/* Kwota netto / brutto */}
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{fmtAmount(cost.total_price)} <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>netto</span></div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{fmtAmount(cost.total_price * 1.23)} <span style={{ fontSize: 11, color: '#94a3b8' }}>brutto</span></div>
                  </div>

                  {/* Status */}
                  <div>
                    <StatusPill status={cost.status} />
                  </div>

                  {/* Akcje */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                    {cost.status === 'pending' && (
                      <button
                        onClick={() => handleStatusChange(cost.id, 'sent')}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '7px 13px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                          border: 'none', background: '#2563eb', color: '#fff',
                          cursor: 'pointer', boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Send size={13} />
                        Wyślij do klienta
                      </button>
                    )}

                    {cost.status === 'sent' && (
                      <>
                        <span style={{ fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums', marginRight: 4 }}>
                          wysłano {fmtDateShort(cost.updated_at || cost.created_at)}
                        </span>
                        <button
                          onClick={() => handleStatusChange(cost.id, 'approved')}
                          title="Zaakceptuj"
                          style={{
                            width: 30, height: 30, borderRadius: 6, border: '1px solid #bbf7d0',
                            background: '#f0fdf4', color: '#16a34a',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', flexShrink: 0,
                          }}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => handleStatusChange(cost.id, 'rejected')}
                          title="Odrzuć"
                          style={{
                            width: 30, height: 30, borderRadius: 6, border: '1px solid #fecaca',
                            background: '#fef2f2', color: '#dc2626',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', flexShrink: 0,
                          }}
                        >
                          <X size={14} />
                        </button>
                      </>
                    )}

                    {cost.status === 'approved' && (
                      <span style={{ fontSize: 12, fontWeight: 500, color: '#16a34a' }}>
                        zaakceptowano {fmtDateShort(cost.updated_at)} · dodano do kosztów projektu
                      </span>
                    )}

                    {cost.status === 'rejected' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                          odrzucono {fmtDateShort(cost.updated_at)}
                        </span>
                        <button
                          onClick={() => handleStatusChange(cost.id, 'sent')}
                          style={{
                            fontSize: 13, fontWeight: 600, color: '#2563eb',
                            background: 'none', border: 'none', cursor: 'pointer',
                            padding: '5px 10px', borderRadius: 6,
                            transition: 'background 0.1s',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#eff6ff')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                        >
                          Wyślij ponownie
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <AddCostModal
          projects={projects}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); reload() }}
        />
      )}
    </div>
  )
}
