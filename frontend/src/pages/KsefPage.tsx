import { useEffect, useState, useCallback, useRef } from 'react'
import { RefreshCw, Folder, ChevronDown, Check, Search, AlertTriangle, X, Eye, Share2, Trash2, ChevronLeft, ChevronRight, Settings, Brain, Wrench, Bug, Building2 } from 'lucide-react'
import { ksefApi, bankApi, projectsApi } from '../api/client'
import type { KsefInvoice, KsefStatus, Project } from '../types'
import AllocationPanel from '../components/ksef/AllocationPanel'
import PaymentVerificationModal from '../components/ksef/PaymentVerificationModal'
import AssignInvoiceModal from '../components/ksef/AssignInvoiceModal'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Button + modal wrapper; keeps the old AssignDropdown call sites working
function AssignDropdown({ invoice, projects, onAssigned }: {
  invoice: KsefInvoice
  projects: Project[]
  onAssigned: (updated: KsefInvoice) => void
}) {
  const [open, setOpen]     = useState(false)
  const [saving, setSaving] = useState(false)

  // Pełna alokacja → tworzy CostItem w projekcie, faktura znika z listy
  const handleAssignProject = async (projectId: string) => {
    setSaving(true)
    try {
      const alloc = await ksefApi.addAllocation(
        invoice.id, projectId, invoice.gross_amount, '', 'materials', 'project',
      )
      const proj = projects.find(p => p.id === projectId)
      onAssigned({
        ...invoice,
        project_id: projectId,
        project: proj ? { id: proj.id, name: proj.name, client_name: proj.client_name } : invoice.project,
        allocations: [...(invoice.allocations ?? []), alloc],
      })
      setOpen(false)
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Nie udało się przypisać faktury.')
    } finally {
      setSaving(false)
    }
  }

  // Koszty firmowe = alokacja "internal" + notatka (bez projektu)
  const handleCompanyCost = async (notes: string) => {
    setSaving(true)
    try {
      const alloc = await ksefApi.addAllocation(
        invoice.id, null, invoice.gross_amount, notes, 'other', 'internal',
      )
      onAssigned({
        ...invoice,
        notes: notes || invoice.notes,
        allocations: [...(invoice.allocations ?? []), alloc],
      })
      setOpen(false)
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Nie udało się oznaczyć faktury.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={saving}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '9px 16px',
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 8,
          border: 'none',
          background: '#2563eb',
          color: '#ffffff',
          cursor: 'pointer',
          transition: 'background 0.15s',
          whiteSpace: 'nowrap',
          boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1d4ed8' }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#2563eb' }}
      >
        <Folder size={14} strokeWidth={2} />
        {saving ? 'Zapisywanie…' : 'Przypisz'}
      </button>

      {open && (
        <AssignInvoiceModal
          invoice={invoice}
          projects={projects}
          saving={saving}
          onPickProject={handleAssignProject}
          onPickCompany={handleCompanyCost}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// ─── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, valueColor, sub }: {
  label: string
  value: React.ReactNode
  valueColor?: string
  sub: string
}) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #e2e8f0',
      borderRadius: 12,
      padding: '20px 24px',
    }}>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 8 }}>{label}</div>
      <div style={{
        fontSize: 28,
        fontWeight: 700,
        letterSpacing: '-0.02em',
        color: valueColor ?? '#0f172a',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
        marginBottom: 6,
      }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>{sub}</div>
    </div>
  )
}

// ─── Sync error banner ─────────────────────────────────────────────────────────

function SyncErrorBanner({ status, onResetSession, resettingSession }: {
  status: KsefStatus
  onResetSession: () => void
  resettingSession: boolean
}) {
  if (!status.last_sync_error) return null
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      background: '#fef2f2',
      border: '1px solid #fecaca',
      borderRadius: 12,
      padding: '14px 18px',
    }}>
      <AlertTriangle size={16} color="#dc2626" style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: '#b91c1c', margin: '0 0 4px' }}>
          Błąd synchronizacji KSeF — faktury nie są pobierane automatycznie
        </p>
        <p style={{ fontSize: 12, color: '#dc2626', fontFamily: 'monospace', wordBreak: 'break-all', margin: '0 0 6px' }}>
          {status.last_sync_error}
        </p>
        <p style={{ fontSize: 12, color: '#b91c1c', margin: 0 }}>
          {status.last_sync_error?.includes('429')
            ? 'Przekroczono limit 20 zapytań/h KSeF API. Synchronizacja wznowi się automatycznie za około 30 minut.'
            : 'Najczęstsza przyczyna: wygasły token autoryzacji KSeF. Kliknij „Zresetuj sesję" aby odtworzyć połączenie.'
          }
        </p>
      </div>
      <button
        onClick={onResetSession}
        disabled={resettingSession || !status.configured}
        style={{
          flexShrink: 0,
          padding: '6px 14px',
          fontSize: 12,
          fontWeight: 500,
          background: '#dc2626',
          color: '#ffffff',
          border: 'none',
          borderRadius: 8,
          cursor: 'pointer',
          opacity: resettingSession || !status.configured ? 0.5 : 1,
        }}
      >
        {resettingSession ? 'Resetowanie…' : 'Zresetuj sesję'}
      </button>
    </div>
  )
}

// ─── XML invoice preview modal ─────────────────────────────────────────────────

interface InvoiceLineItem {
  nr: string
  name: string
  unit: string
  qty: string
  unitPrice: string
  netValue: string
  vatRate: string
}

function parseInvoiceXml(xml: string): { fields: Record<string, string>; items: InvoiceLineItem[] } {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const el = (tag: string, parent: Element | Document = doc): string => {
    const hits = parent.getElementsByTagNameNS('*', tag)
    if (hits.length > 0) return hits[0].textContent?.trim() ?? ''
    const hits2 = parent.getElementsByTagName(tag)
    return hits2.length > 0 ? hits2[0].textContent?.trim() ?? '' : ''
  }
  const elFirst = (tags: string[], parent: Element | Document = doc): string => {
    for (const tag of tags) { const v = el(tag, parent); if (v) return v }
    return ''
  }
  const rowsNS = doc.getElementsByTagNameNS('*', 'FaWiersz')
  const rows   = rowsNS.length > 0 ? rowsNS : doc.getElementsByTagName('FaWiersz')
  const items: InvoiceLineItem[] = Array.from(rows).map(row => ({
    nr:        elFirst(['NrWierszaFa', 'NrWiersza'], row),
    name:      el('P_7',  row),
    unit:      el('P_8A', row),
    qty:       el('P_8B', row),
    unitPrice: elFirst(['P_9A', 'P_9B'], row),
    netValue:  elFirst(['P_11', 'P_11A'], row),
    vatRate:   el('P_12', row),
  })).filter(i => i.name)

  const fields: Record<string, string> = {
    'Nr faktury':       el('P_2'),
    'Data wystawienia': el('P_1'),
    'Sprzedawca':       elFirst(['Nazwa']),
    'NIP sprzedawcy':   el('NIP'),
    'Wartość netto':    el('P_15'),
    'Kwota VAT':        el('P_16'),
    'Wartość brutto':   el('P_17'),
    'Waluta':           el('KodWaluty') || 'PLN',
  }
  return { fields, items }
}

function InvoicePreviewModal({ invoice, onClose }: {
  invoice: KsefInvoice
  onClose: () => void
}) {
  const [xml, setXml]         = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    ksefApi.getXml(invoice.id)
      .then(x => setXml(x))
      .catch(e => setError(e.response?.data?.error ?? e.message))
      .finally(() => setLoading(false))
  }, [invoice.id])

  const handleDownload = () => {
    if (!xml) return
    const blob = new Blob([xml], { type: 'application/xml' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `faktura-${invoice.invoice_number ?? invoice.ksef_number ?? 'ksef'}.xml`
    a.click()
    URL.revokeObjectURL(url)
  }

  const { fields, items } = xml ? parseInvoiceXml(xml) : { fields: {}, items: [] }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#ffffff', borderRadius: 16, boxShadow: '0 24px 64px rgba(15,23,42,0.25)', width: '100%', maxWidth: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #f1f5f9' }}>
          <div>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', margin: 0 }}>Podgląd faktury</h2>
            <p style={{ fontSize: 12, color: '#94a3b8', margin: '2px 0 0' }}>{invoice.invoice_number ?? invoice.ksef_number}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {xml && (
              <button
                onClick={handleDownload}
                style={{ padding: '6px 14px', fontSize: 12, fontWeight: 500, color: '#7c3aed', border: '1px solid #ddd6fe', borderRadius: 8, background: 'transparent', cursor: 'pointer' }}
              >
                Pobierz XML
              </button>
            )}
            <button
              onClick={onClose}
              style={{ padding: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: '#94a3b8', borderRadius: 6 }}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {loading && <div style={{ textAlign: 'center', padding: '48px 0', color: '#94a3b8', fontSize: 14 }}>Pobieranie z KSeF…</div>}
          {error   && <div style={{ fontSize: 13, color: '#b91c1c', background: '#fef2f2', padding: '12px 16px', borderRadius: 8 }}>{error}</div>}
          {xml && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {Object.entries(fields).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{k}</div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{v}</div>
                  </div>
                ))}
              </div>
              {items.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                    Pozycje faktury ({items.length})
                  </h3>
                  <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #f1f5f9' }}>
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          {['Nazwa', 'Ilość', 'J.m.', 'Cena netto', 'Wartość netto', 'VAT %'].map(h => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Nazwa' || h === 'J.m.' ? 'left' : 'right', fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item, i) => (
                          <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '8px 10px', color: '#0f172a', fontWeight: 500 }}>{item.name}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.qty}</td>
                            <td style={{ padding: '8px 10px', color: '#64748b' }}>{item.unit}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.unitPrice}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{item.netValue}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: '#64748b' }}>{item.vatRate}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 16 }}>
                <h3 style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Dane z bazy</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {[
                    ['Sprzedawca', invoice.seller_name],
                    ['NIP sprzedawcy', invoice.seller_nip],
                    ['Netto', `${fmt(invoice.net_amount)} ${invoice.currency}`],
                    ['VAT', `${fmt(invoice.vat_amount)} ${invoice.currency}`],
                    ['Brutto', `${fmt(invoice.gross_amount)} ${invoice.currency}`],
                    ['Data wystawienia', invoice.invoice_date],
                    ['Numer KSeF', invoice.ksef_number],
                  ].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k as string} style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{k}</div>
                      <div style={{ fontSize: 13, color: '#475569', wordBreak: 'break-all' }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
              <details style={{ border: '1px solid #f1f5f9', borderRadius: 8 }}>
                <summary style={{ padding: '8px 16px', fontSize: 12, color: '#94a3b8', cursor: 'pointer', userSelect: 'none' }}>Surowy XML</summary>
                <pre style={{ padding: '12px 16px', fontSize: 11, fontFamily: 'monospace', color: '#475569', overflowX: 'auto', maxHeight: 240, overflowY: 'auto', background: '#f8fafc', borderRadius: '0 0 8px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                  {xml}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Payment badge (unchanged logic) ──────────────────────────────────────────

function PaymentBadge({ invoice, onUpdated }: { invoice: KsefInvoice; onUpdated: (inv: KsefInvoice) => void }) {
  const [changing, setChanging] = useState(false)

  const handleChange = async (newStatus: 'paid' | 'unpaid') => {
    setChanging(true)
    try {
      const updated = await bankApi.updatePayment(invoice.id, newStatus)
      onUpdated(updated as KsefInvoice)
    } catch (e: any) {
      alert(e.response?.data?.error ?? e.message)
    } finally {
      setChanging(false)
    }
  }

  const { payment_status: status, payment_source: source } = invoice

  let badgeBg = '#f1f5f9'; let badgeColor = '#64748b'
  let label = 'Nieznana'

  if (status === 'paid') {
    badgeBg = '#f0fdf4'; badgeColor = '#15803d'; label = 'Opłacona'
  } else if (status === 'unpaid') {
    badgeBg = '#fef2f2'; badgeColor = '#b91c1c'; label = 'Nieopłacona'
  } else if (status === 'partial') {
    badgeBg = '#fffbeb'; badgeColor = '#b45309'; label = 'Częściowa'
  }

  const sourceLabel = source === 'mt940' ? 'MT940' : source === 'przelewy24' ? 'P24' : source === 'manual' ? 'ręczna' : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: badgeBg, color: badgeColor, width: 'fit-content' }}>
        {label}
      </span>
      {sourceLabel && <span style={{ fontSize: 11, color: '#94a3b8' }}>{sourceLabel}</span>}
      {!changing && (
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {status !== 'paid' && (
            <button onClick={() => handleChange('paid')} style={{ fontSize: 11, color: '#15803d', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Opłacona</button>
          )}
          {status !== 'unpaid' && (
            <button onClick={() => handleChange('unpaid')} style={{ fontSize: 11, color: '#b91c1c', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Nieopłacona</button>
          )}
        </div>
      )}
      {changing && <span style={{ fontSize: 11, color: '#94a3b8' }}>Zapisywanie…</span>}
    </div>
  )
}

// ─── "Do przypisania" table row ────────────────────────────────────────────────

function UnassignedRow({ invoice, projects, onUpdated }: {
  invoice: KsefInvoice
  projects: Project[]
  onUpdated: (inv: KsefInvoice) => void
}) {
  const [previewing, setPreviewing]           = useState(false)
  const [confirmingPayment, setConfirmingPayment] = useState(false)

  const hasSuggestion = !!(invoice.suggested_project_id) && !invoice.project_id && !invoice.suggestion_dismissed

  return (
    <>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1.3fr 0.9fr 1fr 1fr 1.7fr',
        alignItems: 'center',
        padding: '16px 24px',
        borderBottom: '1px solid #f1f5f9',
        transition: 'background 0.1s',
        gap: 8,
      }}
        onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'}
        onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
      >
        {/* Sprzedawca */}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {invoice.seller_name ?? '—'}
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            {invoice.seller_nip ?? ''}
          </div>
        </div>

        {/* Nr faktury */}
        <div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {invoice.invoice_number ?? invoice.ksef_number ?? '—'}
        </div>

        {/* Wystawiono */}
        <div style={{ fontSize: 14, color: '#64748b', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {fmtDate(invoice.invoice_date)}
        </div>

        {/* Netto */}
        <div style={{ textAlign: 'right', fontSize: 14, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(invoice.net_amount)}
        </div>

        {/* Brutto */}
        <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 600, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(invoice.gross_amount)}
        </div>

        {/* Przypisanie: tylko podgląd + jeden wyraźny przycisk */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={() => setPreviewing(true)}
            title="Podgląd faktury"
            style={{ padding: 6, border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', borderRadius: 6 }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = '#475569'}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'}
          >
            <Eye size={15} />
          </button>
          <AssignDropdown invoice={invoice} projects={projects} onAssigned={onUpdated} />
        </div>
      </div>

      {/* Suggestion banner */}
      {hasSuggestion && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fef3c7', padding: '10px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#b45309' }}>Sugerowany projekt:</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
                {projects.find(p => p.id === invoice.suggested_project_id)?.name ?? invoice.suggested_project_id}
              </span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                ({projects.find(p => p.id === invoice.suggested_project_id)?.client_name ?? '—'})
              </span>
              {invoice.suggestion_score && (
                <span style={{ fontSize: 11, color: '#b45309' }}>pewność: {Math.round(invoice.suggestion_score * 100)}%</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {!confirmingPayment ? (
                <>
                  <button
                    onClick={() => setConfirmingPayment(true)}
                    style={{ padding: '5px 12px', fontSize: 12, fontWeight: 500, background: '#16a34a', color: '#ffffff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
                  >
                    Przypisz do projektu
                  </button>
                  <button
                    onClick={async () => {
                      const updated = await ksefApi.dismissSuggestion(invoice.id)
                      onUpdated(updated)
                    }}
                    style={{ padding: '5px 12px', fontSize: 12, color: '#64748b', background: 'none', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}
                  >
                    Odrzuć
                  </button>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#ffffff', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 12px' }}>
                  <span style={{ fontSize: 12, color: '#475569' }}>Czy też utworzyć wpłatę klienta?</span>
                  <button onClick={async () => { const u = await ksefApi.confirmSuggestion(invoice.id, true); onUpdated(u); setConfirmingPayment(false) }}
                    style={{ padding: '3px 10px', fontSize: 11, fontWeight: 500, background: '#16a34a', color: '#ffffff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                    Tak, utwórz wpłatę
                  </button>
                  <button onClick={async () => { const u = await ksefApi.confirmSuggestion(invoice.id, false); onUpdated(u); setConfirmingPayment(false) }}
                    style={{ padding: '3px 10px', fontSize: 11, color: '#475569', background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}>
                    Tylko przypisz
                  </button>
                  <button onClick={() => setConfirmingPayment(false)} style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}>Anuluj</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {previewing && (
        <InvoicePreviewModal invoice={invoice} onClose={() => setPreviewing(false)} />
      )}
    </>
  )
}

// ─── "Ostatnio przypisane" row ─────────────────────────────────────────────────

function AssignedRow({ invoice, projects, onUpdated }: {
  invoice: KsefInvoice
  projects: Project[]
  onUpdated: (inv: KsefInvoice) => void
}) {
  const [unassigning, setUnassigning] = useState(false)

  const project = projects.find(p => p.id === invoice.project_id)
  const isCompanyCost = !invoice.project_id
    && (invoice.allocations ?? []).some(a => a.allocation_type === 'internal')

  // Cofnij = usuń alokacje (kasuje też CostItem w projekcie) + wyczyść project_id
  const handleUnassign = async () => {
    setUnassigning(true)
    try {
      for (const a of invoice.allocations ?? []) {
        await ksefApi.deleteAllocation(a.id)
      }
      const updated = await ksefApi.assign(invoice.id, null, invoice.notes ?? '')
      onUpdated({ ...updated, allocations: [] })
    } finally {
      setUnassigning(false)
    }
  }

  const assignedAt = invoice.invoice_date ?? invoice.created_at

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '2fr 1.3fr 0.9fr 1fr 1fr 1.7fr',
      alignItems: 'center',
      padding: '14px 24px',
      borderBottom: '1px solid #f1f5f9',
      gap: 8,
    }}
      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'}
      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
    >
      {/* Sprzedawca */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {invoice.seller_name ?? '—'}
        </div>
        <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
          {invoice.invoice_number ?? invoice.ksef_number ?? '—'}
        </div>
      </div>

      {/* Przypisano dnia */}
      <div style={{ fontSize: 13, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
        przypisano {fmtDate(assignedAt)}
      </div>

      {/* (pusta kolumna daty wystawienia) */}
      <div />

      {/* Netto */}
      <div style={{ textAlign: 'right', fontSize: 14, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
        {fmt(invoice.net_amount)}
      </div>

      {/* Brutto */}
      <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 600, color: '#475569', fontVariantNumeric: 'tabular-nums' }}>
        {fmt(invoice.gross_amount)}
      </div>

      {/* Projekt / koszty firmowe + cofnij */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        {project && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 12px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            background: '#eff6ff',
            color: '#1d4ed8',
          }}>
            <Folder size={11} />
            {project.name}
          </span>
        )}
        {isCompanyCost && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 12px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            background: '#f1f5f9',
            color: '#475569',
          }}>
            <Building2 size={11} />
            Koszty firmowe
          </span>
        )}
        <button
          onClick={handleUnassign}
          disabled={unassigning}
          style={{
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 500,
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            background: 'transparent',
            color: '#64748b',
            cursor: 'pointer',
            opacity: unassigning ? 0.5 : 1,
          }}
        >
          {unassigning ? '…' : 'Cofnij'}
        </button>
      </div>
    </div>
  )
}

// ─── Full invoice row for "Wszystkie faktury" advanced view ────────────────────

function FullInvoiceRow({ invoice, projects, onUpdated, onRemoved }: {
  invoice: KsefInvoice
  projects: Project[]
  onUpdated: (inv: KsefInvoice) => void
  onRemoved: (id: string) => void
}) {
  const [showAllocations, setShowAllocations] = useState(false)
  const [previewing, setPreviewing]           = useState(false)
  const [confirmingPayment, setConfirmingPayment] = useState(false)

  const isAssignedToProject = !!invoice.project_id
  const internalAllocs = (invoice.allocations ?? []).filter((a: any) => a.allocation_type === 'internal')
  const revenueAllocs  = (invoice.allocations ?? []).filter((a: any) => a.allocation_type === 'revenue')
  const isAssignedInternal = internalAllocs.length > 0
  const isAssignedRevenue  = revenueAllocs.length > 0
  const isAssigned = isAssignedToProject || isAssignedInternal || isAssignedRevenue
  const isOutgoing = invoice.invoice_direction === 'outgoing'
  const hasSuggestion = !!(invoice.suggested_project_id) && !invoice.project_id && !invoice.suggestion_dismissed

  const COST_CAT_LABELS: Record<string, string> = { cogs: 'COGS', sales: 'Sprzedaż', ga: 'G&A', operations: 'Operacje', financial: 'Finansowe' }
  const COST_CAT_ICONS: Record<string, string>  = { cogs: '🏗️', sales: '📣', ga: '🏢', operations: '⚙️', financial: '💳' }
  const internalCat = internalAllocs[0]?.cost_category ?? 'cogs'

  const REVENUE_SUB_LABELS: Record<string, string> = {
    installation_complete: 'Instalacja kompletna', installation_partial: 'Instalacja częściowa',
    hardware_sale: 'Sprzedaż sprzętu', service_maintenance: 'Serwis', additional_works: 'Prace dodatkowe',
    consulting: 'Doradztwo', gatelynk_license: 'GateLynk', other_revenue: 'Przychód',
  }
  const REVENUE_SUB_ICONS: Record<string, string> = {
    installation_complete: '🏠', installation_partial: '🔧', hardware_sale: '📦',
    service_maintenance: '🛠️', additional_works: '➕', consulting: '💡', gatelynk_license: '🔑', other_revenue: '💰',
  }
  const revenueSub = revenueAllocs[0]?.subcategory ?? 'installation_complete'

  const handleRemove = async () => {
    if (!confirm('Usunąć tę fakturę z bazy? (Nie usuwa jej z KSeF)')) return
    await ksefApi.remove(invoice.id)
    onRemoved(invoice.id)
  }

  return (
    <>
      <tr className="group border-b border-gray-50 hover:bg-gray-50 transition-colors" style={{ borderBottom: '1px solid #f1f5f9' }}>
        <td style={{ padding: '10px 12px 10px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{invoice.invoice_number ?? '—'}</div>
            <button
              title="Kliknij aby zmienić kierunek"
              onClick={async e => { e.stopPropagation(); const u = await ksefApi.toggleDirection(invoice.id); onUpdated(u) }}
              style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
            >
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500,
                background: isOutgoing ? '#dbeafe' : '#f1f5f9', color: isOutgoing ? '#1d4ed8' : '#64748b',
              }}>
                {isOutgoing ? '📤 Sprzedażowa' : '📥 Zakupowa'}
              </span>
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginTop: 2 }}>
            KSeF: {invoice.ksef_number ? invoice.ksef_number.slice(0, 20) + '…' : '—'}
          </div>
          {isOutgoing && invoice.buyer_name && (
            <div style={{ fontSize: 11, color: '#2563eb', marginTop: 2 }}>→ {invoice.buyer_name}</div>
          )}
        </td>
        <td style={{ padding: '10px 12px' }}>
          <div style={{ fontSize: 13, color: '#475569' }}>{invoice.seller_name ?? '—'}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{invoice.seller_nip ?? ''}</div>
        </td>
        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
            {fmt(invoice.gross_amount)} {invoice.currency}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
            Netto: {fmt(invoice.net_amount)} / VAT: {fmt(invoice.vat_amount)}
          </div>
        </td>
        <td style={{ padding: '10px 12px', fontSize: 13, color: '#64748b', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {invoice.invoice_date ?? '—'}
        </td>
        <td style={{ padding: '10px 12px' }}>
          {isAssignedToProject ? (
            <div>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, background: '#f0fdf4', color: '#15803d' }}>
                <Check size={10} /> {invoice.project?.name ?? 'Projekt'}
              </span>
              {invoice.notes && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{invoice.notes}</div>}
            </div>
          ) : isAssignedRevenue ? (
            <span style={{ display: 'inline-flex', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, background: '#f0fdf4', color: '#15803d' }}>
              <Check size={10} /> {REVENUE_SUB_ICONS[revenueSub]} {REVENUE_SUB_LABELS[revenueSub] ?? 'Przychód'}
            </span>
          ) : isAssignedInternal ? (
            <span style={{ display: 'inline-flex', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, background: '#f0fdf4', color: '#15803d' }}>
              <Check size={10} /> {COST_CAT_ICONS[internalCat]} {COST_CAT_LABELS[internalCat] ?? 'Wewnętrzne'}
            </span>
          ) : (
            <span style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, background: '#fffbeb', color: '#b45309' }}>
              Nieprzypisana
            </span>
          )}
        </td>
        <td style={{ padding: '10px 12px' }}>
          <PaymentBadge invoice={invoice} onUpdated={onUpdated} />
        </td>
        <td style={{ padding: '10px 24px 10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              onClick={async () => { const u = await ksefApi.share(invoice.id, !invoice.is_shared); onUpdated(u) }}
              style={{ padding: 4, border: 'none', background: 'none', cursor: 'pointer', color: invoice.is_shared ? '#16a34a' : '#cbd5e1' }}
              title={invoice.is_shared ? 'Cofnij udostępnienie' : 'Udostępnij'}
            >
              <Share2 size={13} />
            </button>
            <button
              onClick={() => setPreviewing(true)}
              style={{ padding: 4, border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8' }}
              title="Podgląd faktury"
            >
              <Eye size={13} />
            </button>
            <button
              onClick={() => setShowAllocations(v => !v)}
              style={{
                padding: '3px 8px', fontSize: 11, fontWeight: 500, borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${showAllocations ? '#7c3aed' : '#e2e8f0'}`,
                background: showAllocations ? '#7c3aed' : 'transparent',
                color: showAllocations ? '#ffffff' : '#7c3aed',
              }}
            >
              Alokacje
            </button>
            <AssignDropdown invoice={invoice} projects={projects} onAssigned={onUpdated} />
            <button
              onClick={handleRemove}
              style={{ padding: 4, border: 'none', background: 'none', cursor: 'pointer', color: '#cbd5e1' }}
              title="Usuń z bazy"
              onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = '#dc2626'}
              onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = '#cbd5e1'}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </td>
      </tr>
      {hasSuggestion && (
        <tr style={{ background: '#fffbeb', borderBottom: '1px solid #fef3c7' }}>
          <td colSpan={7} style={{ padding: '8px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: '#b45309' }}>Sugerowany projekt:</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
                  {projects.find(p => p.id === invoice.suggested_project_id)?.name ?? invoice.suggested_project_id}
                </span>
                {invoice.suggestion_score && (
                  <span style={{ fontSize: 11, color: '#b45309' }}>pewność: {Math.round(invoice.suggestion_score * 100)}%</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!confirmingPayment ? (
                  <>
                    <button onClick={() => setConfirmingPayment(true)} style={{ padding: '5px 12px', fontSize: 12, fontWeight: 500, background: '#16a34a', color: '#ffffff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                      Przypisz do projektu
                    </button>
                    <button onClick={async () => { const u = await ksefApi.dismissSuggestion(invoice.id); onUpdated(u) }} style={{ padding: '5px 12px', fontSize: 12, color: '#64748b', background: 'none', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>
                      Odrzuć
                    </button>
                  </>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#ffffff', border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 12px' }}>
                    <span style={{ fontSize: 12, color: '#475569' }}>Czy też utworzyć wpłatę klienta?</span>
                    <button onClick={async () => { const u = await ksefApi.confirmSuggestion(invoice.id, true); onUpdated(u); setConfirmingPayment(false) }} style={{ padding: '3px 10px', fontSize: 11, fontWeight: 500, background: '#16a34a', color: '#ffffff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                      Tak, utwórz wpłatę
                    </button>
                    <button onClick={async () => { const u = await ksefApi.confirmSuggestion(invoice.id, false); onUpdated(u); setConfirmingPayment(false) }} style={{ padding: '3px 10px', fontSize: 11, color: '#475569', background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}>
                      Tylko przypisz
                    </button>
                    <button onClick={() => setConfirmingPayment(false)} style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}>Anuluj</button>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
      {showAllocations && (
        <tr style={{ background: '#f5f3ff', borderBottom: '1px solid #ddd6fe' }}>
          <td colSpan={7} style={{ padding: '12px 24px' }}>
            <AllocationPanel invoice={invoice} isAdmin={true} />
          </td>
        </tr>
      )}
      {previewing && <InvoicePreviewModal invoice={invoice} onClose={() => setPreviewing(false)} />}
    </>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function KsefPage() {
  const [status, setStatus]     = useState<KsefStatus | null>(null)
  const [invoices, setInvoices] = useState<KsefInvoice[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [syncing, setSyncing]   = useState(false)
  const [syncMsg, setSyncMsg]   = useState<string | null>(null)

  // View mode: 'faktury' = new Faktury design, 'all' = full admin table
  const [viewMode, setViewMode]   = useState<'faktury' | 'all'>('faktury')
  const [tab, setTab]             = useState<'all' | 'unassigned' | 'assigned'>('all')
  const [paymentTab, setPaymentTab] = useState<'all' | 'paid' | 'unpaid'>('all')
  const [dirTab, setDirTab]       = useState<'all' | 'incoming' | 'outgoing'>('all')
  const [search, setSearch]       = useState('')
  const [page, setPage]           = useState(1)
  const [debugInfo, setDebugInfo] = useState<any>(null)
  const [debugging, setDebugging] = useState(false)
  const [resettingSession, setResettingSession] = useState(false)
  const [dateFrom, setDateFrom]   = useState('2024-01-01')
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [showAdminTools, setShowAdminTools]     = useState(false)
  const LIMIT = 50

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const assigned       = tab === 'all' ? undefined : tab === 'assigned'
      const payment_status = paymentTab === 'all' ? undefined : paymentTab
      const direction      = dirTab === 'all' ? undefined : dirTab
      const [res, st, projs] = await Promise.all([
        ksefApi.invoices({ assigned, payment_status, direction, search: search || undefined, page, limit: LIMIT }),
        ksefApi.status(),
        projectsApi.list(),
      ])
      setInvoices(res.invoices)
      setTotal(res.total)
      setStatus(st)
      setProjects(projs)
    } finally {
      setLoading(false)
    }
  }, [tab, paymentTab, dirTab, search, page])

  useEffect(() => { load() }, [load])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const result = await ksefApi.sync(dateFrom || undefined)
      const errTxt = result.errors.length ? `\nBłędy: ${result.errors.join(' | ')}` : ''
      setSyncMsg(`Pobrano ${result.fetched}, zapisano ${result.saved} nowych faktur${errTxt}`)
      await load()
    } catch (err: any) {
      setSyncMsg(`Błąd: ${err.response?.data?.error ?? err.message}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleDebug = async () => {
    setDebugging(true)
    setDebugInfo(null)
    try {
      const result = await ksefApi.debugAuth()
      setDebugInfo(result)
    } catch (err: any) {
      setDebugInfo({ error: err.response?.data ?? err.message })
    } finally {
      setDebugging(false)
    }
  }

  const handleResetSession = async () => {
    if (!confirm('Zresetować sesję KSeF? Zostanie wymuszone ponowne uwierzytelnienie z KSEF_TOKEN z Render.')) return
    setResettingSession(true)
    setSyncMsg(null)
    try {
      const result = await ksefApi.resetSession()
      if (result.success) {
        setSyncMsg('Sesja KSeF odtworzona pomyślnie. Kliknij „Synchronizuj" aby pobrać brakujące faktury.')
      } else {
        setSyncMsg(`Błąd resetu sesji: ${result.error}`)
      }
      await ksefApi.status().then(setStatus).catch(() => {})
    } catch (err: any) {
      setSyncMsg(`Błąd resetu sesji: ${err.response?.data?.error ?? err.message}`)
    } finally {
      setResettingSession(false)
    }
  }

  const handleUpdated = (updated: KsefInvoice) => {
    setInvoices(prev => prev.map(i => i.id === updated.id ? updated : i))
    ksefApi.status().then(setStatus).catch(() => {})
  }

  const handleRemoved = (id: string) => {
    setInvoices(prev => prev.filter(i => i.id !== id))
    setTotal(t => t - 1)
    ksefApi.status().then(setStatus).catch(() => {})
  }

  const totalPages = Math.ceil(total / LIMIT)

  // Derived data for Faktury view
  const unassigned = invoices.filter(inv => !inv.project_id && (inv.allocations ?? []).length === 0)
  const assigned   = invoices.filter(inv => inv.project_id || (inv.allocations ?? []).length > 0)

  const unassignedNet   = unassigned.reduce((s, i) => s + (i.net_amount ?? 0), 0)
  const unassignedGross = unassigned.reduce((s, i) => s + (i.gross_amount ?? 0), 0)
  const assignedGross   = assigned.reduce((s, i) => s + (i.gross_amount ?? 0), 0)

  const lastSync = status?.last_sync_at
    ? new Date(status.last_sync_at).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null

  // ── Faktury view ──────────────────────────────────────────────────────────────

  if (viewMode === 'faktury') {
    return (
      <div style={{ padding: '36px 32px 64px', background: '#f8fafc', minHeight: '100vh', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>

          {/* Page header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', color: '#0f172a', margin: 0 }}>
                Faktury kosztowe
              </h1>
              <p style={{ fontSize: 14, color: '#64748b', margin: '6px 0 0' }}>
                Pobrane z KSeF · wystawione na Smart Home Center · przypisz każdą fakturę do projektu jako koszt
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <button
                onClick={() => setViewMode('all')}
                title="Widok administratora"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '10px 14px', fontSize: 13, fontWeight: 500,
                  borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff',
                  color: '#64748b', cursor: 'pointer',
                }}
              >
                <Settings size={14} />
                Admin
              </button>
              <button
                onClick={() => setShowPaymentModal(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '10px 14px', fontSize: 13, fontWeight: 500,
                  borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff',
                  color: '#475569', cursor: 'pointer',
                }}
              >
                Weryfikacja płatności
              </button>
              <button
                onClick={handleSync}
                disabled={syncing || !status?.configured}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '10px 18px', fontSize: 14, fontWeight: 500,
                  borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff',
                  color: syncing ? '#94a3b8' : '#2563eb',
                  cursor: syncing || !status?.configured ? 'not-allowed' : 'pointer',
                  opacity: !status?.configured ? 0.5 : 1,
                  boxShadow: 'none',
                }}
              >
                <RefreshCw size={15} strokeWidth={2} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
                {syncing ? 'Synchronizacja…' : 'Synchronizuj z KSeF'}
              </button>
            </div>
          </div>

          {/* Sync error banner */}
          {status?.last_sync_error && (
            <div style={{ marginBottom: 20 }}>
              <SyncErrorBanner status={status} onResetSession={handleResetSession} resettingSession={resettingSession} />
            </div>
          )}

          {/* Not configured warning */}
          {status && !status.configured && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 18px', marginBottom: 20 }}>
              <AlertTriangle size={14} color="#dc2626" />
              <span style={{ fontSize: 13, color: '#b91c1c' }}>
                Brak konfiguracji. Ustaw zmienne środowiskowe: <code style={{ fontFamily: 'monospace' }}>KSEF_NIP</code>, <code style={{ fontFamily: 'monospace' }}>KSEF_TOKEN</code>
              </span>
            </div>
          )}

          {/* Sync result message */}
          {syncMsg && (
            <div style={{
              fontSize: 13, padding: '10px 16px', borderRadius: 10, marginBottom: 20,
              background: syncMsg.startsWith('Błąd') ? '#fef2f2' : '#f0fdf4',
              color: syncMsg.startsWith('Błąd') ? '#b91c1c' : '#15803d',
              border: `1px solid ${syncMsg.startsWith('Błąd') ? '#fecaca' : '#bbf7d0'}`,
            }}>
              {syncMsg}
            </div>
          )}

          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 28 }}>
            <KpiCard
              label="Do przypisania"
              value={loading ? '…' : status?.unassigned_count ?? unassigned.length}
              valueColor="#1d4ed8"
              sub={loading ? '—' : `łącznie ${fmt(unassignedGross)} PLN brutto`}
            />
            <KpiCard
              label="Ostatnia synchronizacja"
              value={
                <span style={{ fontSize: lastSync ? 18 : 22 }}>
                  {loading ? '…' : lastSync ?? 'Brak danych'}
                </span>
              }
              sub="KSeF API · automatycznie co 6 godzin"
            />
            <KpiCard
              label="Przypisane w tym miesiącu"
              value={loading ? '…' : assigned.length}
              valueColor="#16a34a"
              sub={loading ? '—' : `łącznie ${fmt(assignedGross)} PLN brutto`}
            />
          </div>

          {/* Search */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ position: 'relative', width: 320 }}>
              <Search size={14} color="#94a3b8" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input
                type="text"
                placeholder="Szukaj sprzedawcy lub nr faktury…"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1) }}
                style={{
                  width: '100%',
                  paddingLeft: 36,
                  paddingRight: 14,
                  paddingTop: 10,
                  paddingBottom: 10,
                  fontSize: 14,
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  background: '#ffffff',
                  color: '#0f172a',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                onFocus={e => {
                  e.currentTarget.style.borderColor = '#2563eb'
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)'
                }}
                onBlur={e => {
                  e.currentTarget.style.borderColor = '#e2e8f0'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              />
            </div>
          </div>

          {/* "Do przypisania" table */}
          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, marginBottom: 20, overflow: 'hidden' }}>
            {/* Card header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px', borderBottom: '1px solid #f1f5f9' }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Do przypisania</span>
              <span style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '2px 10px', borderRadius: 999,
                fontSize: 13, fontWeight: 600,
                background: '#eff6ff', color: '#1d4ed8',
              }}>
                {loading ? '…' : status?.unassigned_count ?? unassigned.length}
              </span>
              <span style={{ fontSize: 13, color: '#94a3b8', marginLeft: 4 }}>
                faktura przypisana do projektu znika z tej listy
              </span>
            </div>

            {/* Column headers */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1.3fr 0.9fr 1fr 1fr 1.7fr',
              padding: '10px 24px',
              gap: 8,
              borderBottom: '1px solid #f1f5f9',
              background: '#f8fafc',
            }}>
              {[
                { label: 'Sprzedawca', align: 'left' },
                { label: 'Nr faktury', align: 'left' },
                { label: 'Wystawiono', align: 'left' },
                { label: 'Netto (PLN)', align: 'right' },
                { label: 'Brutto (PLN)', align: 'right' },
                { label: 'Przypisanie', align: 'right' },
              ].map(col => (
                <div key={col.label} style={{
                  fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: '0.05em', color: '#94a3b8',
                  textAlign: col.align as 'left' | 'right',
                }}>
                  {col.label}
                </div>
              ))}
            </div>

            {loading ? (
              <div style={{ padding: '48px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>Ładowanie…</div>
            ) : unassigned.length === 0 ? (
              <div style={{ padding: '48px 24px', textAlign: 'center' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, borderRadius: '50%', background: '#f0fdf4', marginBottom: 12 }}>
                  <Check size={22} color="#16a34a" strokeWidth={2.5} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>Wszystkie faktury przypisane</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>
                  {invoices.length === 0
                    ? 'Kliknij „Synchronizuj z KSeF" aby pobrać faktury'
                    : 'Każda faktura ma przypisany projekt — świetna robota!'}
                </div>
              </div>
            ) : (
              <div>
                {unassigned.map(inv => (
                  <UnassignedRow
                    key={inv.id}
                    invoice={inv}
                    projects={projects}
                    onUpdated={handleUpdated}
                  />
                ))}
              </div>
            )}
          </div>

          {/* "Ostatnio przypisane" card */}
          {assigned.length > 0 && (
            <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px', borderBottom: '1px solid #f1f5f9' }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Ostatnio przypisane</span>
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '2px 10px', borderRadius: 999,
                  fontSize: 13, fontWeight: 600,
                  background: '#f0fdf4', color: '#15803d',
                }}>
                  {assigned.length}
                </span>
              </div>

              {/* Column headers */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1.3fr 0.9fr 1fr 1fr 1.7fr',
                padding: '10px 24px',
                gap: 8,
                borderBottom: '1px solid #f1f5f9',
                background: '#f8fafc',
              }}>
                {[
                  { label: 'Sprzedawca / nr', align: 'left' },
                  { label: 'Przypisano', align: 'left' },
                  { label: '', align: 'left' },
                  { label: 'Netto (PLN)', align: 'right' },
                  { label: 'Brutto (PLN)', align: 'right' },
                  { label: 'Projekt', align: 'right' },
                ].map((col, i) => (
                  <div key={i} style={{
                    fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: '#94a3b8',
                    textAlign: col.align as 'left' | 'right',
                  }}>
                    {col.label}
                  </div>
                ))}
              </div>

              {assigned.slice(0, 20).map(inv => (
                <AssignedRow key={inv.id} invoice={inv} projects={projects} onUpdated={handleUpdated} />
              ))}
              {assigned.length > 20 && (
                <div style={{ padding: '12px 24px', fontSize: 13, color: '#94a3b8', textAlign: 'center', borderTop: '1px solid #f1f5f9' }}>
                  + {assigned.length - 20} więcej przypisanych faktur · przejdź do widoku Admin aby zobaczyć wszystkie
                </div>
              )}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#475569', cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}
              >
                <ChevronLeft size={14} /> Poprzednia
              </button>
              <span style={{ fontSize: 13, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>Strona {page} z {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#475569', cursor: page === totalPages ? 'not-allowed' : 'pointer', opacity: page === totalPages ? 0.4 : 1 }}
              >
                Następna <ChevronRight size={14} />
              </button>
            </div>
          )}

          {/* CSS keyframes for spin */}
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>

        {showPaymentModal && (
          <PaymentVerificationModal
            onClose={() => setShowPaymentModal(false)}
            onPaymentsUpdated={load}
          />
        )}
      </div>
    )
  }

  // ── Admin / all-invoices view ─────────────────────────────────────────────────

  return (
    <div style={{ padding: '36px 32px 64px', background: '#f8fafc', minHeight: '100vh', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', color: '#0f172a', margin: 0 }}>
              KSeF — Faktury
            </h1>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: '4px 0 0' }}>
              {status ? `${status.env?.includes('prod') ? 'Produkcja' : 'Test'} · NIP: ${status.nip ?? '—'} · ${total} faktur` : 'Ładowanie…'}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setViewMode('faktury')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 13, fontWeight: 500, borderRadius: 8, border: '1px solid #e2e8f0', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer' }}
            >
              Widok Faktury
            </button>
            <button
              onClick={() => setShowPaymentModal(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 13, fontWeight: 500, borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff', color: '#475569', cursor: 'pointer' }}
            >
              Weryfikacja płatności
            </button>
          </div>
        </div>

        {/* Status / sync bar */}
        {status && (
          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 20px', marginBottom: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 9, height: 9, borderRadius: '50%',
                  background: status.configured ? (status.last_sync_error ? '#f87171' : '#22c55e') : '#f87171',
                  flexShrink: 0,
                  display: 'inline-block',
                }} />
                <span style={{ fontSize: 13, fontWeight: 500, color: '#475569' }}>
                  KSeF {status.env?.includes('prod') ? 'Produkcja' : 'Test'} 2.0
                </span>
                {status.nip && <span style={{ fontSize: 12, color: '#94a3b8' }}>NIP: {status.nip}</span>}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: '#64748b', marginLeft: 'auto' }}>
                <span>{status.invoice_count} faktur</span>
                <span style={{ color: '#f59e0b', fontWeight: 500 }}>{status.unassigned_count} nieprzypisanych</span>
                <span>Sync: {status.last_sync_at ? new Date(status.last_sync_at).toLocaleString('pl-PL') : 'Nigdy'}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>Od:</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  style={{ padding: '5px 10px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#475569', outline: 'none' }}
                />
              </div>

              <button
                onClick={handleSync}
                disabled={syncing || !status.configured}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', fontSize: 13, fontWeight: 500,
                  borderRadius: 8, border: 'none',
                  background: '#2563eb', color: '#ffffff',
                  cursor: syncing || !status.configured ? 'not-allowed' : 'pointer',
                  opacity: syncing || !status.configured ? 0.6 : 1,
                  boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
                }}
              >
                <RefreshCw size={13} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
                {syncing ? 'Synchronizacja…' : 'Synchronizuj'}
              </button>
            </div>
          </div>
        )}

        {status?.last_sync_error && (
          <div style={{ marginBottom: 16 }}>
            <SyncErrorBanner status={status} onResetSession={handleResetSession} resettingSession={resettingSession} />
          </div>
        )}

        {syncMsg && (
          <div style={{
            fontSize: 13, padding: '10px 16px', borderRadius: 10, marginBottom: 16,
            background: syncMsg.startsWith('Błąd') ? '#fef2f2' : '#f0fdf4',
            color: syncMsg.startsWith('Błąd') ? '#b91c1c' : '#15803d',
            border: `1px solid ${syncMsg.startsWith('Błąd') ? '#fecaca' : '#bbf7d0'}`,
          }}>
            {syncMsg}
          </div>
        )}

        {/* Admin tools (collapsible) */}
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setShowAdminTools(v => !v)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#64748b', cursor: 'pointer' }}
          >
            <Settings size={12} />
            {showAdminTools ? 'Ukryj narzędzia admin' : 'Narzędzia admin'}
          </button>
          {showAdminTools && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, padding: '12px 16px', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12 }}>
              <button
                onClick={handleDebug}
                disabled={debugging}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 500, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#64748b', cursor: 'pointer', opacity: debugging ? 0.5 : 1 }}
              >
                <Bug size={12} /> {debugging ? 'Diagnostyka…' : 'Diagnostyka autoryzacji'}
              </button>
              <button
                onClick={async () => {
                  const r = await ksefApi.reSuggest()
                  alert(`Sprawdzono ${r.processed} faktur sprzedażowych, dodano ${r.suggested} sugestii.`)
                  load()
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 500, border: '1px solid #ddd6fe', borderRadius: 8, background: '#ffffff', color: '#7c3aed', cursor: 'pointer' }}
              >
                Przelicz sugestie
              </button>
              <button
                onClick={async () => {
                  try { const r = await ksefApi.learnClassify(); alert(r.message); load() }
                  catch (e: any) { alert('Błąd: ' + e.message) }
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 500, border: '1px solid #a7f3d0', borderRadius: 8, background: '#ffffff', color: '#059669', cursor: 'pointer' }}
              >
                <Brain size={12} /> Naucz się wzorców
              </button>
              <button
                onClick={async () => {
                  if (!confirm('Napraw kierunek (sprzedażowa/zakupowa) wszystkich faktur?')) return
                  try { const r = await ksefApi.fixDirections(); alert(`Sprawdzono ${r.total} faktur, poprawiono ${r.fixed}.`); load() }
                  catch (e: any) { alert('Błąd: ' + e.message) }
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 500, border: '1px solid #fde68a', borderRadius: 8, background: '#ffffff', color: '#b45309', cursor: 'pointer' }}
              >
                <Wrench size={12} /> Napraw kierunki
              </button>
              <button
                onClick={async () => {
                  if (!confirm('Usunąć wszystkie faktury z bazy i zresetować synchronizację?')) return
                  const r = await ksefApi.removeAll()
                  setSyncMsg(`Usunięto ${r.deleted} faktur. Kliknij Synchronizuj aby pobrać ponownie.`)
                  await load()
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 500, border: '1px solid #fecaca', borderRadius: 8, background: '#ffffff', color: '#dc2626', cursor: 'pointer' }}
              >
                <Trash2 size={12} /> Resetuj bazę faktur
              </button>
              {debugInfo && (
                <button onClick={() => setDebugInfo(null)} style={{ padding: '6px 12px', fontSize: 12, color: '#94a3b8', background: 'none', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>
                  Zamknij diagnostykę
                </button>
              )}
            </div>
          )}
        </div>

        {debugInfo && (
          <div style={{ background: '#0f172a', borderRadius: 12, padding: 16, marginBottom: 16, maxHeight: 256, overflowY: 'auto' }}>
            <pre style={{ fontSize: 11, fontFamily: 'monospace', color: '#4ade80', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(debugInfo, null, 2)}
            </pre>
          </div>
        )}

        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          {/* Assignment filter */}
          <div style={{ display: 'flex', borderRadius: 8, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
            {(['all', 'unassigned', 'assigned'] as const).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setPage(1) }}
                style={{
                  padding: '7px 14px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', transition: 'background 0.1s',
                  background: tab === t ? '#2563eb' : '#ffffff',
                  color: tab === t ? '#ffffff' : '#64748b',
                }}
              >
                {t === 'all' ? 'Wszystkie' : t === 'unassigned' ? 'Nieprzypisane' : 'Przypisane'}
              </button>
            ))}
          </div>

          {/* Payment filter */}
          <div style={{ display: 'flex', borderRadius: 8, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
            {([{ value: 'all', label: 'Każda płatność' }, { value: 'paid', label: 'Opłacone' }, { value: 'unpaid', label: 'Nieopłacone' }] as const).map(t => (
              <button
                key={t.value}
                onClick={() => { setPaymentTab(t.value); setPage(1) }}
                style={{
                  padding: '7px 14px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
                  background: paymentTab === t.value ? '#2563eb' : '#ffffff',
                  color: paymentTab === t.value ? '#ffffff' : '#64748b',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Direction filter */}
          <div style={{ display: 'flex', borderRadius: 8, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
            {([{ value: 'all', label: 'Wszystkie typy' }, { value: 'incoming', label: 'Zakupowe' }, { value: 'outgoing', label: 'Sprzedażowe' }] as const).map(t => (
              <button
                key={t.value}
                onClick={() => { setDirTab(t.value); setPage(1) }}
                style={{
                  padding: '7px 14px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
                  background: dirTab === t.value ? '#2563eb' : '#ffffff',
                  color: dirTab === t.value ? '#ffffff' : '#64748b',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 200 }}>
            <Search size={13} color="#94a3b8" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Szukaj (nr faktury, NIP, sprzedawca…)"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              style={{
                width: '100%', paddingLeft: 30, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
                fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8,
                background: '#ffffff', color: '#0f172a', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          <span style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>{total} faktur</span>
        </div>

        {/* Table */}
        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: '64px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>Ładowanie…</div>
          ) : invoices.length === 0 ? (
            <div style={{ padding: '64px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
              <div style={{ fontSize: 14, fontWeight: 500, color: '#475569', marginBottom: 4 }}>Brak faktur</div>
              <div style={{ fontSize: 13, color: '#94a3b8' }}>
                {status?.configured ? 'Kliknij „Synchronizuj" aby pobrać faktury z KSeF' : 'Skonfiguruj zmienne środowiskowe KSEF_NIP i KSEF_TOKEN'}
              </div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #f1f5f9' }}>
                    {['Nr faktury / KSeF', 'Sprzedawca', 'Kwota', 'Data', 'Projekt', 'Płatność', 'Akcje'].map(h => (
                      <th key={h} style={{
                        padding: h === 'Nr faktury / KSeF' ? '12px 12px 12px 24px' : h === 'Akcje' ? '12px 24px 12px 12px' : '12px',
                        textAlign: h === 'Kwota' || h === 'Akcje' ? 'right' : 'left',
                        fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                        letterSpacing: '0.05em', color: '#94a3b8',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <FullInvoiceRow
                      key={inv.id}
                      invoice={inv}
                      projects={projects}
                      onUpdated={handleUpdated}
                      onRemoved={handleRemoved}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 }}>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#475569', cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}
            >
              <ChevronLeft size={14} /> Poprzednia
            </button>
            <span style={{ fontSize: 13, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>Strona {page} z {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 8, background: '#ffffff', color: '#475569', cursor: page === totalPages ? 'not-allowed' : 'pointer', opacity: page === totalPages ? 0.4 : 1 }}
            >
              Następna <ChevronRight size={14} />
            </button>
          </div>
        )}

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>

      {showPaymentModal && (
        <PaymentVerificationModal
          onClose={() => setShowPaymentModal(false)}
          onPaymentsUpdated={load}
        />
      )}
    </div>
  )
}
