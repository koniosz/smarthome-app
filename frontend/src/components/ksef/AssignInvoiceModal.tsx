import { useState } from 'react'
import { Folder, Search, X, Building2 } from 'lucide-react'
import type { KsefInvoice, Project } from '../../types'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function AssignInvoiceModal({ invoice, projects, saving, onPickProject, onPickCompany, onClose }: {
  invoice: KsefInvoice
  projects: Project[]
  saving: boolean
  onPickProject: (projectId: string) => void
  onPickCompany: (notes: string) => void
  onClose: () => void
}) {
  const [mode, setMode]   = useState<'project' | 'company'>('project')
  const [note, setNote]   = useState('')
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const filtered = q
    ? projects.filter(p => (p.name + ' ' + (p.client_name ?? '')).toLowerCase().includes(q))
    : projects

  const suggested = invoice.suggested_project_id && !invoice.suggestion_dismissed
    ? projects.find(p => p.id === invoice.suggested_project_id)
    : undefined
  const rest = suggested ? filtered.filter(p => p.id !== suggested.id) : filtered
  const showSuggested = suggested && (!q || (suggested.name + ' ' + (suggested.client_name ?? '')).toLowerCase().includes(q))

  const tileBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    textAlign: 'left',
    padding: '13px 14px',
    borderRadius: 10,
    border: '1px solid #e2e8f0',
    background: '#ffffff',
    cursor: saving ? 'wait' : 'pointer',
    transition: 'all 0.12s',
    opacity: saving ? 0.6 : 1,
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#ffffff', borderRadius: 16, width: 640, maxWidth: '100%',
          maxHeight: '85vh', boxShadow: '0 24px 64px rgba(15,23,42,0.25)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Do którego projektu przypisać?</div>
          <button
            onClick={onClose}
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f1f5f9' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          >
            <X size={17} />
          </button>
        </div>

        {/* Invoice summary */}
        <div style={{ padding: '16px 24px 0' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
            background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '13px 16px',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {invoice.seller_name ?? '—'}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                {invoice.invoice_number ?? invoice.ksef_number ?? '—'} · {fmtDate(invoice.invoice_date)}
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(invoice.gross_amount)}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>PLN brutto</div>
            </div>
          </div>
        </div>

        {/* Mode switch: project vs company costs */}
        <div style={{ padding: '14px 24px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {([
            { key: 'project' as const, label: 'Do projektu',    Icon: Folder },
            { key: 'company' as const, label: 'Koszty firmowe', Icon: Building2 },
          ]).map(({ key, label, Icon }) => {
            const active = mode === key
            return (
              <button
                key={key}
                onClick={() => setMode(key)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '12px 0', borderRadius: 10, fontSize: 14, fontWeight: 600,
                  border: `1px solid ${active ? '#93c5fd' : '#e2e8f0'}`,
                  background: active ? '#eff6ff' : '#ffffff',
                  color: active ? '#1d4ed8' : '#475569',
                  cursor: 'pointer', transition: 'all 0.12s',
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            )
          })}
        </div>

        {/* Company costs: note + confirm */}
        {mode === 'company' && (
          <div style={{ padding: '16px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>
                Notatka <span style={{ fontWeight: 400, color: '#94a3b8' }}>(czego dotyczy koszt — opcjonalnie)</span>
              </label>
              <textarea
                autoFocus
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="np. paliwo, narzędzia, materiały biurowe…"
                rows={3}
                style={{
                  padding: '10px 14px', borderRadius: 8, border: '1px solid #e2e8f0',
                  fontSize: 14, outline: 'none', color: '#0f172a', resize: 'vertical',
                  fontFamily: "'IBM Plex Sans', sans-serif",
                }}
              />
            </div>
            <button
              onClick={() => !saving && onPickCompany(note.trim())}
              disabled={saving}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '12px 0', borderRadius: 10, fontSize: 14, fontWeight: 600,
                border: 'none', background: '#2563eb', color: '#ffffff', cursor: 'pointer',
                boxShadow: '0 1px 2px rgba(37,99,235,0.3)', opacity: saving ? 0.6 : 1,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1d4ed8' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#2563eb' }}
            >
              <Building2 size={16} />
              {saving ? 'Zapisywanie…' : 'Oznacz jako koszty firmowe'}
            </button>
          </div>
        )}

        {/* Search */}
        {mode === 'project' && (
        <div style={{ padding: '14px 24px 0' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
            borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff',
          }}>
            <Search size={15} color="#94a3b8" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Szukaj projektu lub klienta…"
              style={{ border: 'none', outline: 'none', fontSize: 14, flex: 1, color: '#0f172a', background: 'transparent' }}
            />
          </div>
        </div>
        )}

        {/* Project tiles */}
        {mode === 'project' && (
        <div style={{ padding: '14px 24px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {showSuggested && suggested && (
            <button
              onClick={() => !saving && onPickProject(suggested.id)}
              style={{ ...tileBase, border: '1px solid #93c5fd', background: '#eff6ff' }}
              onMouseEnter={e => { if (!saving) (e.currentTarget as HTMLButtonElement).style.background = '#dbeafe' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#eff6ff' }}
            >
              <div style={{
                width: 38, height: 38, borderRadius: 9, background: '#2563eb', color: '#ffffff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Folder size={18} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {suggested.name}
                  </span>
                  <span style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: '#2563eb', color: '#ffffff',
                  }}>
                    Sugerowany{invoice.suggestion_score ? ` · ${Math.round(invoice.suggestion_score * 100)}%` : ''}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{suggested.client_name}</div>
              </div>
            </button>
          )}

          {rest.length === 0 && !showSuggested ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 14, color: '#94a3b8' }}>
              Brak projektów spełniających kryteria.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {rest.map(p => (
                <button
                  key={p.id}
                  onClick={() => !saving && onPickProject(p.id)}
                  style={tileBase}
                  onMouseEnter={e => {
                    if (saving) return
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.borderColor = '#93c5fd'
                    el.style.background = '#eff6ff'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.borderColor = '#e2e8f0'
                    el.style.background = '#ffffff'
                  }}
                >
                  <div style={{
                    width: 38, height: 38, borderRadius: 9, background: '#eff6ff', color: '#2563eb',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Folder size={18} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.client_name}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
