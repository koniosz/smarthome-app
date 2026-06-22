import { useEffect, useState, useCallback } from 'react'
import { Search, Folder, FileText, ChevronDown, ChevronUp } from 'lucide-react'
import { ksefApi, projectsApi } from '../api/client'
import type { KsefInvoice, Project } from '../types'
import AssignInvoiceModal from '../components/ksef/AssignInvoiceModal'
import InvoiceLineItems from '../components/ksef/InvoiceLineItems'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

interface InvoiceLineItem { nr: string; name: string; unit: string; qty: string; unitPrice: string; netValue: string; vatRate: string }

function parseXml(xml: string): { fields: Record<string, string>; items: InvoiceLineItem[] } {
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

  const fields = {
    'Nr faktury': el('P_2'), 'Data': el('P_1'), 'Sprzedawca': elFirst(['Nazwa']),
    'Netto': el('P_15'), 'VAT': el('P_16'), 'Brutto': el('P_17'),
  }
  return { fields, items }
}

function InvoiceCard({ invoice, projects, onAssigned }: {
  invoice: KsefInvoice
  projects: Project[]
  onAssigned: (id: string) => void
}) {
  const [expanded, setExpanded]     = useState(false)
  const [xml, setXml]               = useState<string | null>(null)
  const [loadingXml, setLoadingXml] = useState(false)
  const [modalOpen, setModalOpen]   = useState(false)
  const [saving, setSaving]         = useState(false)

  const loadXml = async () => {
    if (xml) { setExpanded(e => !e); return }
    setLoadingXml(true)
    try {
      const data = await ksefApi.getSharedXml(invoice.id)
      setXml(data)
      setExpanded(true)
    } catch (e) { /* ignore */ } finally { setLoadingXml(false) }
  }

  const { items } = xml ? parseXml(xml) : { items: [] as InvoiceLineItem[] }

  const handlePickProject = async (projectId: string) => {
    setSaving(true)
    try {
      await ksefApi.assignShared(invoice.id, { project_id: projectId })
      onAssigned(invoice.id)
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Nie udało się przypisać faktury.')
    } finally {
      setSaving(false)
    }
  }

  const handlePickCompany = async (notes: string) => {
    setSaving(true)
    try {
      await ksefApi.assignShared(invoice.id, { company_cost: true, notes })
      onAssigned(invoice.id)
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Nie udało się oznaczyć faktury.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{invoice.seller_name || '—'}</span>
            <span style={{ fontSize: 12, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{invoice.seller_nip}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 4, flexWrap: 'wrap', fontSize: 12, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
            <span>Nr: {invoice.invoice_number || '—'}</span>
            <span>Data: {invoice.invoice_date || '—'}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{fmt(invoice.gross_amount)} {invoice.currency} <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>brutto</span></span>
            <span style={{ fontSize: 12, color: '#64748b' }}>{fmt(invoice.net_amount)} {invoice.currency} <span style={{ fontSize: 11, color: '#94a3b8' }}>netto</span></span>
          </div>
          <InvoiceLineItems invoiceId={invoice.id} load={() => ksefApi.sharedLineItems(invoice.id)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            onClick={loadXml}
            disabled={loadingXml}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 13px', fontSize: 13, fontWeight: 600,
              border: '1px solid #e2e8f0', borderRadius: 8,
              background: '#ffffff', color: '#475569', cursor: 'pointer',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f1f5f9' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#ffffff' }}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {loadingXml ? '…' : 'Pozycje'}
          </button>
          <button
            onClick={() => setModalOpen(true)}
            disabled={saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '9px 16px', fontSize: 13, fontWeight: 600,
              borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#ffffff', cursor: 'pointer',
              boxShadow: '0 1px 2px rgba(37,99,235,0.3)', whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1d4ed8' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#2563eb' }}
          >
            <Folder size={14} />
            {saving ? 'Zapisywanie…' : 'Przypisz'}
          </button>
        </div>
      </div>

      {/* Line items */}
      {expanded && xml && (
        <div style={{ borderTop: '1px solid #f1f5f9', padding: '14px 20px' }}>
          {items.length > 0 ? (
            <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #f1f5f9' }}>
              <table style={{ width: '100%', fontSize: 12, color: '#0f172a', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', color: '#94a3b8' }}>
                    <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>Nazwa towaru/usługi</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>Ilość</th>
                    <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>J.m.</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>Cena netto</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>Wartość netto</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>VAT%</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 500 }}>{item.name}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.qty}</td>
                      <td style={{ padding: '8px 12px', color: '#64748b' }}>{item.unit}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.unitPrice}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{item.netValue}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#64748b' }}>{item.vatRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', padding: '14px 0' }}>Brak pozycji w XML lub nieznany format</div>
          )}
        </div>
      )}

      {modalOpen && (
        <AssignInvoiceModal
          invoice={invoice}
          projects={projects}
          saving={saving}
          onPickProject={handlePickProject}
          onPickCompany={handlePickCompany}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}

export default function SharedInvoicesPage() {
  const [invoices, setInvoices] = useState<KsefInvoice[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [page, setPage]         = useState(1)
  const LIMIT = 20

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, projs] = await Promise.all([
        ksefApi.sharedInvoices({ search: search || undefined, page, limit: LIMIT }),
        projectsApi.list(),
      ])
      setInvoices(res.invoices)
      setTotal(res.total)
      // members only: employees assign to their own projects
      setProjects(projs.filter(p => p.user_is_member !== false))
    } finally { setLoading(false) }
  }, [search, page])

  useEffect(() => { load() }, [load])

  const handleAssigned = (id: string) => {
    setInvoices(prev => prev.filter(i => i.id !== id))
    setTotal(t => Math.max(0, t - 1))
  }

  const totalPages = Math.ceil(total / LIMIT)

  const btnPage: React.CSSProperties = {
    padding: '7px 14px', fontSize: 13, fontWeight: 600,
    border: '1px solid #e2e8f0', borderRadius: 8,
    background: '#ffffff', color: '#475569', cursor: 'pointer',
  }

  return (
    <div style={{ padding: '36px 32px 64px', background: '#f8fafc', minHeight: '100vh', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Header */}
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', letterSpacing: '-0.01em', margin: 0 }}>
            Faktury do przypisania
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 4, marginBottom: 0 }}>
            Faktury udostępnione przez administratora · przypisz do projektu albo oznacz jako koszty firmowe — przypisana faktura znika z listy
          </p>
        </div>

        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
            borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff', width: 320,
          }}>
            <Search size={15} color="#94a3b8" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder="Szukaj sprzedawcy lub nr faktury…"
              style={{ border: 'none', outline: 'none', fontSize: 14, flex: 1, color: '#0f172a', background: 'transparent' }}
            />
          </div>
          <span style={{ fontSize: 13, color: '#94a3b8', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {total} {total === 1 ? 'faktura' : total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 12 || total % 100 > 14) ? 'faktury' : 'faktur'}
          </span>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: '#94a3b8', fontSize: 14 }}>Ładowanie…</div>
        ) : invoices.length === 0 ? (
          <div style={{
            background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12,
            padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%', background: '#f0fdf4', color: '#16a34a',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <FileText size={20} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Brak faktur do przypisania</div>
            <div style={{ fontSize: 13, color: '#94a3b8' }}>Nowe pojawią się tu, gdy administrator udostępni kolejne faktury.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {invoices.map(inv => (
              <InvoiceCard
                key={inv.id}
                invoice={inv}
                projects={projects}
                onAssigned={handleAssigned}
              />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={{ ...btnPage, opacity: page === 1 ? 0.4 : 1 }}>← Poprzednia</button>
            <span style={{ fontSize: 13, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>Strona {page} z {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{ ...btnPage, opacity: page === totalPages ? 0.4 : 1 }}>Następna →</button>
          </div>
        )}
      </div>
    </div>
  )
}
