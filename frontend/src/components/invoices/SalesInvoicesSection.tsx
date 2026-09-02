import { useEffect, useState } from 'react'
import Modal from '../ui/Modal'
import { salesInvoicesApi, quotesApi, warehouseApi, projectsApi, projectWarehouseApi, companySettingsApi } from '../../api/client'
import type { SalesInvoice, SalesInvoiceItem, WarehouseDoc, ProjectWarehouseDoc, ProjectWarehouseDocLine, CompanySettings } from '../../api/client'
import type { AiQuote, Project } from '../../types'
import { COMPANY_INFO } from '../../constants/company'
import { useAuth } from '../../auth/AuthContext'

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
const lblCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Szkic', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
  issued: { label: 'Wystawiona', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  paid: { label: '✓ Opłacona', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  cancelled: { label: 'Anulowana', cls: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300' },
}

function fmt(n: number) { return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0) }
function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s); return isNaN(d.getTime()) ? s : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function SalesInvoicesSection({ onBack }: { onBack: () => void }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [list, setList] = useState<SalesInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [editInv, setEditInv] = useState<SalesInvoice | 'new' | null>(null)
  const [previewInv, setPreviewInv] = useState<SalesInvoice | null>(null)
  const [company, setCompany] = useState<CompanySettings>({ invoice_logo: '', invoice_footer: '', updated_at: '' })
  const [logoBusy, setLogoBusy] = useState(false)

  const load = () => { setLoading(true); salesInvoicesApi.list().then(setList).catch(() => setList([])).finally(() => setLoading(false)) }
  useEffect(() => { load(); companySettingsApi.get().then(setCompany).catch(() => {}) }, [])

  const act = async (fn: () => Promise<any>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    try { await fn(); load() } catch (e: any) { alert(e?.response?.data?.error || 'Błąd operacji.') }
  }

  // Logo firmy na fakturze — plik → data URL → ustawienia (tylko admin)
  const uploadLogo = async (file: File) => {
    if (file.size > 700 * 1024) { alert('Logo jest za duże — maksymalnie 700 KB (najlepiej PNG/SVG ~300×100 px).'); return }
    setLogoBusy(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file)
      })
      setCompany(await companySettingsApi.update({ invoice_logo: dataUrl }))
    } catch (e: any) { alert(e?.response?.data?.error || 'Nie udało się zapisać logo.') }
    finally { setLogoBusy(false) }
  }
  const removeLogo = async () => {
    if (!confirm('Usunąć logo z faktur?')) return
    setLogoBusy(true)
    try { setCompany(await companySettingsApi.update({ invoice_logo: '' })) } finally { setLogoBusy(false) }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto min-h-screen bg-[#f8fafc] dark:bg-gray-950">
      <div className="flex items-start justify-between mb-1 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-50">Faktury sprzedażowe <span className="text-xs font-semibold align-middle bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 px-2 py-0.5 rounded-full">BETA</span></h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Szkic → wystawienie (numer FV) → podgląd / wydruk / PDF · numeracja FV/RRRR/MM/NNN</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <label className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg cursor-pointer ${logoBusy ? 'opacity-60' : ''}`}
              title="Logo drukowane w nagłówku faktury">
              {company.invoice_logo
                ? <img src={company.invoice_logo} alt="logo" className="h-5 max-w-[80px] object-contain" />
                : <span>🖼</span>}
              {company.invoice_logo ? 'Zmień logo' : 'Dodaj logo firmy'}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = '' }} />
            </label>
          )}
          {isAdmin && company.invoice_logo && (
            <button onClick={removeLogo} disabled={logoBusy} className="px-2 py-2 text-xs text-gray-400 hover:text-red-500" title="Usuń logo">✕</button>
          )}
          <button onClick={onBack} className="px-3 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">← Wróć</button>
          <button onClick={() => setEditInv('new')} className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">+ Nowa faktura</button>
        </div>
      </div>
      <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-700 rounded-lg px-3 py-2 mb-4 mt-3 max-w-2xl">
        ⚠️ Wysyłka do KSeF jest <strong>przygotowana, ale wyłączona</strong> — od 04.2026 KSeF jest obowiązkowy dla faktur B2B; włączenie wysyłki wymaga osobnej decyzji.
      </p>

      {loading ? <div className="text-center py-14 text-gray-400">Ładowanie…</div>
        : list.length === 0 ? <div className="text-center py-14 text-gray-400"><div className="text-4xl mb-3">🧾</div><p className="text-sm">Brak faktur. Utwórz pierwszą — ręcznie, z wyceny albo z WZ.</p></div>
        : (
          <div className="space-y-2">
            {list.map(inv => {
              const st = STATUS_BADGE[inv.status] ?? STATUS_BADGE.draft
              return (
                <div key={inv.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3.5 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-800 dark:text-gray-100">{inv.number || 'Szkic (bez numeru)'} · {inv.buyer_name}</div>
                    <div className="text-xs text-gray-400">
                      {inv.issue_date ? `wyst. ${fmtDate(inv.issue_date)}` : `utw. ${fmtDate(inv.created_at)}`}
                      {inv.due_date ? ` · termin ${fmtDate(inv.due_date)}` : ''} · {inv.items?.length ?? 0} poz.
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-gray-800 dark:text-gray-100">{fmt(inv.total_gross)} PLN <span className="text-xs font-normal text-gray-400">brutto</span></div>
                    <div className="text-xs text-gray-400">{fmt(inv.total_net)} netto</div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button onClick={() => setPreviewInv(inv)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800">👁 Podgląd</button>
                    {inv.status === 'draft' && <>
                      <button onClick={() => setEditInv(inv)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800">✏️ Edytuj</button>
                      <button onClick={() => act(() => salesInvoicesApi.issue(inv.id), `Wystawić fakturę dla ${inv.buyer_name}? Zostanie nadany numer.`)} className="px-2.5 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded">Wystaw</button>
                      <button onClick={() => act(() => salesInvoicesApi.delete(inv.id), 'Usunąć szkic?')} className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-950/30">🗑</button>
                    </>}
                    {inv.status === 'issued' && <>
                      <button onClick={() => printInvoice(inv, company)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800">🖨 Drukuj / PDF</button>
                      <button onClick={() => act(() => salesInvoicesApi.markPaid(inv.id))} className="px-2.5 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded">Opłacona</button>
                      <button onClick={() => act(() => salesInvoicesApi.cancel(inv.id), 'Anulować fakturę? Pozostanie w rejestrze jako anulowana.')} className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-950/30">Anuluj</button>
                    </>}
                    {inv.status === 'paid' && <button onClick={() => printInvoice(inv, company)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800">🖨 Drukuj / PDF</button>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      {editInv && <InvoiceBuilderModal invoice={editInv === 'new' ? null : editInv} onClose={() => setEditInv(null)} onSaved={() => { setEditInv(null); load() }} />}
      {previewInv && <InvoicePreviewModal invoice={previewInv} company={company} onClose={() => setPreviewInv(null)} />}
    </div>
  )
}

// ── Podgląd faktury (ta sama treść co wydruk, w oknie aplikacji) ──
function InvoicePreviewModal({ invoice, company, onClose }: { invoice: SalesInvoice; company: CompanySettings; onClose: () => void }) {
  const html = buildInvoiceHtml(invoice, company, false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          <div>
            <div className="text-sm font-bold text-gray-800 dark:text-gray-100">Podgląd: Faktura {invoice.number ?? '(szkic — bez numeru)'}</div>
            <div className="text-xs text-gray-400">{invoice.buyer_name} · {fmt(invoice.total_gross)} PLN brutto</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => printInvoice(invoice, company)} className="px-3 py-1.5 text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">🖨 Drukuj / zapisz PDF</button>
            <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">Zamknij</button>
          </div>
        </div>
        {/* iframe izoluje style wydruku od trybu ciemnego aplikacji — faktura zawsze biała */}
        <iframe title="Podgląd faktury" srcDoc={html} className="flex-1 w-full bg-white" style={{ border: 0 }} />
      </div>
    </div>
  )
}

// ── Wydruk faktury (okno drukowania — Ctrl+P → PDF) ──
function printInvoice(inv: SalesInvoice, company?: CompanySettings) {
  const html = buildInvoiceHtml(inv, company ?? { invoice_logo: '', invoice_footer: '', updated_at: '' }, true)
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close() }
}

// ── HTML faktury (wspólny dla podglądu i wydruku) ──
function buildInvoiceHtml(inv: SalesInvoice, company: CompanySettings, autoPrint: boolean): string {
  const rows = (inv.items || []).map((i, idx) => `<tr>
    <td>${idx + 1}</td><td>${i.name}</td>
    <td style="text-align:right">${fmt(i.qty)}</td><td>${i.unit}</td>
    <td style="text-align:right">${fmt(i.unit_price)}</td>
    <td style="text-align:right">${fmt(i.total_net)}</td>
    <td style="text-align:center">${i.vat_rate}%</td>
    <td style="text-align:right">${fmt(i.total_vat)}</td>
    <td style="text-align:right">${fmt(i.total_gross)}</td>
  </tr>`).join('')
  const breakdown = (inv.vat_breakdown || []).map(b => `<tr>
    <td style="text-align:center">${b.rate}%</td><td style="text-align:right">${fmt(b.net)}</td>
    <td style="text-align:right">${fmt(b.vat)}</td><td style="text-align:right">${fmt(b.gross)}</td>
  </tr>`).join('')
  const html = `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><title>Faktura ${inv.number ?? ''}</title>
  <style>body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#111;margin:26px;max-width:780px}
  h1{font-size:18px;margin:0}
  table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #cbd5e1;padding:5px 7px;font-size:11px}th{background:#f1f5f9;text-align:left}
  .box{border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:14px}
  .lbl{font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px}</style></head><body>
  <div class="hdr">
    <div style="display:flex;align-items:center;gap:14px">
      ${company.invoice_logo ? `<img src="${company.invoice_logo}" alt="logo" style="max-height:64px;max-width:200px;object-fit:contain">` : ''}
      <div><div style="font-weight:800;font-size:14px">${COMPANY_INFO.name}</div>
      <div style="font-size:11px;color:#475569">${COMPANY_INFO.address}<br>NIP: ${COMPANY_INFO.nip}</div></div>
    </div>
    <div style="text-align:right"><h1>Faktura ${inv.number ?? '(szkic)'}</h1>
    <div style="font-size:11px;color:#475569">Data wystawienia: ${fmtDate(inv.issue_date)}<br>Data sprzedaży: ${fmtDate(inv.sale_date)}${inv.due_date ? `<br>Termin płatności: ${fmtDate(inv.due_date)}` : ''}</div></div>
  </div>
  <div style="display:flex;gap:14px;margin-bottom:14px">
    <div class="box" style="flex:1"><div class="lbl">Sprzedawca</div><strong>${COMPANY_INFO.name}</strong><br>${COMPANY_INFO.address}<br>NIP: ${COMPANY_INFO.nip}</div>
    <div class="box" style="flex:1"><div class="lbl">Nabywca</div><strong>${inv.buyer_name}</strong>${inv.buyer_nip ? `<br>NIP: ${inv.buyer_nip}` : ''}${inv.buyer_address ? `<br>${String(inv.buyer_address).replace(/\n/g, '<br>')}` : ''}</div>
  </div>
  <table><thead><tr><th>Lp.</th><th>Nazwa towaru / usługi</th><th>Ilość</th><th>Jm.</th><th>Cena netto</th><th>Wartość netto</th><th>VAT</th><th>Kwota VAT</th><th>Wartość brutto</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div style="display:flex;gap:14px;margin-top:14px;align-items:flex-start">
    <table style="flex:1;max-width:360px"><thead><tr><th>Stawka</th><th>Netto</th><th>VAT</th><th>Brutto</th></tr></thead><tbody>${breakdown}</tbody>
    <tfoot><tr style="font-weight:700"><td>Razem</td><td style="text-align:right">${fmt(inv.total_net)}</td><td style="text-align:right">${fmt(inv.total_vat)}</td><td style="text-align:right">${fmt(inv.total_gross)}</td></tr></tfoot></table>
    <div style="flex:1;text-align:right">
      <div style="font-size:15px;font-weight:800;margin-bottom:6px">Do zapłaty: ${fmt(inv.total_gross)} PLN</div>
      <div style="font-size:11px;color:#475569">Forma płatności: ${inv.payment_method || 'przelew'}<br>Konto: ${COMPANY_INFO.bank_account} (${COMPANY_INFO.bank_name})</div>
    </div>
  </div>
  ${inv.notes ? `<div style="margin-top:12px;font-size:11px;color:#475569"><strong>Uwagi:</strong> ${inv.notes}</div>` : ''}
  <div style="margin-top:44px;display:flex;justify-content:space-between;font-size:11px;color:#555">
    <div style="border-top:1px solid #999;padding-top:4px;width:40%">Osoba upoważniona do wystawienia</div>
    <div style="border-top:1px solid #999;padding-top:4px;width:40%">Osoba upoważniona do odbioru</div>
  </div>
  ${company.invoice_footer ? `<div style="margin-top:28px;padding-top:8px;border-top:1px solid #e2e8f0;font-size:10px;color:#64748b;text-align:center">${company.invoice_footer}</div>` : ''}
  ${inv.status === 'draft' ? `<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font-size:64px;font-weight:800;color:rgba(220,38,38,0.12);transform:rotate(-20deg);pointer-events:none">SZKIC</div>` : ''}
  ${autoPrint ? '<script>window.print()</script>' : ''}</body></html>`
  return html
}

// ── Kreator / edycja faktury ──
const EMPTY_LINE: SalesInvoiceItem = { name: '', qty: 1, unit: 'szt.', unit_price: 0, vat_rate: 23, total_net: 0, total_vat: 0, total_gross: 0 }

function InvoiceBuilderModal({ invoice, onClose, onSaved }: { invoice: SalesInvoice | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!invoice
  const todayIso = new Date().toISOString().slice(0, 10)
  const [buyerName, setBuyerName] = useState(invoice?.buyer_name ?? '')
  const [buyerNip, setBuyerNip] = useState(invoice?.buyer_nip ?? '')
  const [buyerAddress, setBuyerAddress] = useState(invoice?.buyer_address ?? '')
  const [buyerEmail, setBuyerEmail] = useState(invoice?.buyer_email ?? '')
  const [issueDate, setIssueDate] = useState(invoice?.issue_date ?? todayIso)
  const [saleDate, setSaleDate] = useState(invoice?.sale_date ?? todayIso)
  const [dueDate, setDueDate] = useState(invoice?.due_date ?? '')
  const [payment, setPayment] = useState(invoice?.payment_method ?? 'przelew')
  const [notes, setNotes] = useState(invoice?.notes ?? '')
  const [lines, setLines] = useState<SalesInvoiceItem[]>(invoice?.items?.length ? invoice.items.map(i => ({ ...i })) : [{ ...EMPTY_LINE }])
  const [quoteRef, setQuoteRef] = useState<string | null>(invoice?.quote_id ?? null)
  const [wzRef, setWzRef] = useState<string | null>(invoice?.warehouse_doc_id ?? null)
  const [quotes, setQuotes] = useState<AiQuote[]>([])
  const [wzDocs, setWzDocs] = useState<WarehouseDoc[]>([])
  // Projekt + pobrania magazynowe (MM) — przy wystawieniu powstaje z nich WZ
  const [projects, setProjects] = useState<Project[]>([])
  const [projectRef, setProjectRef] = useState<string>(invoice?.project_id ?? '')
  const [mmDocs, setMmDocs] = useState<ProjectWarehouseDoc[]>([])
  const [mmSelected, setMmSelected] = useState<Set<string>>(new Set(invoice?.linked_mm_line_ids ?? []))
  // pozycje już WSTAWIONE do tabeli faktury (przy edycji szkicu: wiersze już tam są)
  const [mmInserted, setMmInserted] = useState<Set<string>>(new Set(invoice?.linked_mm_line_ids ?? []))
  const [mmInfo, setMmInfo] = useState('')
  // pozycja zablokowana tylko, gdy rozlicza ją INNA faktura niż edytowany szkic
  const lockedByOther = (l: ProjectWarehouseDocLine) => !!l.invoiced && l.invoiced.invoice_id !== (invoice?.id ?? '')

  useEffect(() => { projectsApi.list().then(setProjects).catch(() => {}) }, [])
  useEffect(() => {
    if (!projectRef) { setMmDocs([]); return }
    projectWarehouseApi.docs(projectRef)
      .then(ds => setMmDocs(ds.filter(d => d.type === 'MM')))
      .catch(() => setMmDocs([]))
  }, [projectRef])

  const toggleMmLine = (lineId: string) => setMmSelected(prev => {
    const next = new Set(prev)
    if (next.has(lineId)) next.delete(lineId); else next.add(lineId)
    return next
  })

  const insertMmLines = () => {
    const selectedLines: ProjectWarehouseDocLine[] = []
    for (const d of mmDocs) for (const l of d.lines) {
      if (mmSelected.has(l.id) && !mmInserted.has(l.id) && !lockedByOther(l)) selectedLines.push(l)
    }
    if (!selectedLines.length) { setMmInfo(mmSelected.size ? 'Zaznaczone pozycje są już wstawione.' : 'Zaznacz pozycje MM do wstawienia.'); return }
    const newItems: SalesInvoiceItem[] = selectedLines.map(l => ({
      name: l.name, qty: l.quantity || 1, unit: l.unit || 'szt.', unit_price: l.unit_price || 0,
      vat_rate: 23, total_net: 0, total_vat: 0, total_gross: 0,
      ...( { _mm: true } as any ),
    }))
    setLines(prev => {
      const existing = prev.filter(l => l.name.trim())
      return [...existing, ...newItems]
    })
    setMmInserted(prev => new Set([...prev, ...selectedLines.map(l => l.id)]))
    setMmInfo(`Wstawiono ${newItems.length} pozycji. Przy wystawieniu faktury powstanie z nich dokument WZ.`)
  }
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [nipLoading, setNipLoading] = useState(false)
  const [vatStatus, setVatStatus] = useState<string | null>(null)

  const lookupNip = async () => {
    const nip = buyerNip.replace(/[^0-9]/g, '')
    if (nip.length !== 10) { setErr('Podaj NIP (10 cyfr), aby pobrać dane'); return }
    setNipLoading(true); setErr(''); setVatStatus(null)
    try {
      const r = await salesInvoicesApi.lookupNip(nip)
      if (r.name) setBuyerName(r.name)
      if (r.address) setBuyerAddress(r.address)
      setVatStatus(r.status_vat)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Nie udało się pobrać danych z rejestru.')
    } finally { setNipLoading(false) }
  }

  useEffect(() => {
    quotesApi.list().then(setQuotes).catch(() => {})
    warehouseApi.docsList().then(ds => setWzDocs(ds.filter(d => d.type === 'WZ'))).catch(() => {})
  }, [])

  const setLine = (i: number, patch: Partial<SalesInvoiceItem>) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  const lineNet = (l: SalesInvoiceItem) => (l.qty || 0) * (l.unit_price || 0)
  const totalNet = lines.reduce((s, l) => s + lineNet(l), 0)
  const totalVat = lines.reduce((s, l) => s + lineNet(l) * (l.vat_rate || 0) / 100, 0)

  const importFromQuote = async (id: string) => {
    const q = quotes.find(x => x.id === id); if (!q) return
    setLines((q.items || []).map((i: any) => ({ name: i.name, qty: i.qty || 1, unit: i.unit || 'szt.', unit_price: i.unit_price || 0, vat_rate: 23, total_net: 0, total_vat: 0, total_gross: 0 })))
    if (q.client_name && !buyerName) setBuyerName(q.client_name)
    setQuoteRef(id); setWzRef(null)
  }
  const importFromWz = async (id: string) => {
    try {
      const doc = await warehouseApi.docGet(id)
      setLines((doc.lines || []).map(l => ({ name: l.name, qty: l.quantity || 1, unit: l.unit || 'szt.', unit_price: l.unit_price || 0, vat_rate: 23, total_net: 0, total_vat: 0, total_gross: 0 })))
      if (doc.contractor && !buyerName) setBuyerName(doc.contractor)
      setWzRef(id); setQuoteRef(null)
    } catch { alert('Nie udało się pobrać WZ.') }
  }

  const save = async () => {
    if (!buyerName.trim()) { setErr('Nazwa nabywcy jest wymagana'); return }
    const validLines = lines.filter(l => l.name.trim() && l.qty > 0)
    if (validLines.length === 0) { setErr('Dodaj przynajmniej jedną pozycję'); return }
    setSaving(true); setErr('')
    const payload = {
      buyer_name: buyerName.trim(), buyer_nip: buyerNip.trim() || undefined, buyer_address: buyerAddress.trim() || undefined,
      buyer_email: buyerEmail.trim() || undefined, issue_date: issueDate || undefined, sale_date: saleDate || undefined,
      due_date: dueDate || undefined, payment_method: payment, notes: notes.trim() || undefined,
      items: validLines.map(({ ...l }) => { delete (l as any)._mm; return l }),
      quote_id: quoteRef || undefined, warehouse_doc_id: wzRef || undefined,
      project_id: projectRef || undefined,
      linked_mm_line_ids: [...mmInserted],
    }
    try {
      if (editing && invoice) await salesInvoicesApi.update(invoice.id, payload as any)
      else await salesInvoicesApi.create(payload as any)
      onSaved()
    } catch (e: any) { setErr(e?.response?.data?.error || 'Błąd zapisu.') } finally { setSaving(false) }
  }

  return (
    <Modal title={editing ? `Edycja szkicu faktury` : 'Nowa faktura sprzedażowa (szkic)'} onClose={onClose} wide>
      <div className="space-y-4">
        {!editing && (
          <div className="grid grid-cols-2 gap-3">
            <div><label className={lblCls}>Importuj pozycje z wyceny</label>
              <select className={inputCls} value={quoteRef ?? ''} onChange={e => e.target.value && importFromQuote(e.target.value)}>
                <option value="">— wybierz wycenę —</option>
                {quotes.map(q => <option key={q.id} value={q.id}>{q.name || 'Wycena'} · {q.client_name || ''}</option>)}
              </select>
            </div>
            <div><label className={lblCls}>Importuj pozycje z WZ</label>
              <select className={inputCls} value={wzRef ?? ''} onChange={e => e.target.value && importFromWz(e.target.value)}>
                <option value="">— wybierz WZ —</option>
                {wzDocs.map(d => <option key={d.id} value={d.id}>{d.number} · {d.contractor || ''}</option>)}
              </select>
            </div>
          </div>
        )}

        {/* Projekt + pobrania magazynowe MM → automatyczny WZ przy wystawieniu */}
        <div>
          <label className={lblCls}>Projekt (podpina pobrania magazynowe MM)</label>
          <select className={inputCls} value={projectRef} onChange={e => { setProjectRef(e.target.value); setMmSelected(new Set()); setMmInserted(new Set()); setMmInfo(''); setLines(prev => { const kept = prev.filter(l => !(l as any)._mm); return kept.length ? kept : [{ ...EMPTY_LINE }] }) }} disabled={editing && !!invoice?.linked_mm_line_ids?.length}>
            <option value="">— bez projektu —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.client_name ? ` · ${p.client_name}` : ''}</option>)}
          </select>
        </div>
        {projectRef && mmDocs.length > 0 && (
          <div className="border border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/20 rounded-lg p-3 space-y-2">
            <div className="text-sm font-semibold text-violet-700 dark:text-violet-300">📦 Pobrania magazynowe projektu (MM) — zaznacz, co trafia na fakturę</div>
            <div className="max-h-52 overflow-y-auto space-y-2">
              {mmDocs.map(d => (
                <div key={d.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg">
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 dark:border-gray-800">
                    <label className="flex items-center gap-2 text-xs font-bold text-gray-700 dark:text-gray-200 cursor-pointer">
                      <input type="checkbox"
                        checked={d.lines.every(l => mmSelected.has(l.id) || lockedByOther(l))}
                        onChange={e => setMmSelected(prev => {
                          const next = new Set(prev)
                          for (const l of d.lines) { if (lockedByOther(l)) continue; if (e.target.checked) next.add(l.id); else next.delete(l.id) }
                          return next
                        })} />
                      {d.number}
                    </label>
                    <span className="text-xs text-gray-400">{fmtDate(d.date)} · {fmt(d.total_net)} netto</span>
                  </div>
                  {d.lines.map(l => (
                    <label key={l.id} className={`flex items-center gap-2 px-3 py-1 text-xs ${lockedByOther(l) ? 'opacity-50' : 'cursor-pointer hover:bg-violet-50 dark:hover:bg-violet-950/30'}`}>
                      <input type="checkbox" disabled={lockedByOther(l)} checked={mmSelected.has(l.id)} onChange={() => toggleMmLine(l.id)} />
                      <span className="flex-1 truncate text-gray-700 dark:text-gray-200">{l.name}</span>
                      <span className="text-gray-400 whitespace-nowrap">{fmt(l.quantity || 0)} {l.unit} × {fmt(l.unit_price || 0)}</span>
                      {lockedByOther(l) && <span className="text-[10px] font-bold text-amber-600">na fakturze {l.invoiced!.number ?? '(szkic)'}</span>}
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={insertMmLines}
                className="px-3 py-1.5 text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">
                Wstaw zaznaczone pozycje do faktury
              </button>
              {mmInfo && <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">{mmInfo}</span>}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div><label className={lblCls}>Nabywca *</label><input className={inputCls} value={buyerName} onChange={e => setBuyerName(e.target.value)} placeholder="nazwa firmy / imię i nazwisko" /></div>
          <div>
            <label className={lblCls}>NIP nabywcy</label>
            <div className="flex gap-2">
              <input className={inputCls} value={buyerNip} onChange={e => setBuyerNip(e.target.value)} placeholder="np. 8961543585" />
              <button type="button" onClick={lookupNip} disabled={nipLoading}
                title="Pobierz nazwę i adres z Białej listy podatników VAT (MF)"
                className="shrink-0 px-3 py-2 text-xs font-medium border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/20 rounded-lg disabled:opacity-50">
                {nipLoading ? '…' : '🔍 Pobierz'}
              </button>
            </div>
            {vatStatus && (
              <div className={`text-xs mt-1 ${vatStatus === 'Czynny' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                Status VAT: <strong>{vatStatus}</strong> (Biała lista MF)
              </div>
            )}
          </div>
          <div><label className={lblCls}>Adres nabywcy</label><input className={inputCls} value={buyerAddress} onChange={e => setBuyerAddress(e.target.value)} placeholder="ulica, kod, miasto" /></div>
          <div><label className={lblCls}>E-mail nabywcy</label><input className={inputCls} value={buyerEmail} onChange={e => setBuyerEmail(e.target.value)} placeholder="opcjonalnie" /></div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <div><label className={lblCls}>Data wystawienia</label><input type="date" className={inputCls} value={issueDate} onChange={e => setIssueDate(e.target.value)} /></div>
          <div><label className={lblCls}>Data sprzedaży</label><input type="date" className={inputCls} value={saleDate} onChange={e => setSaleDate(e.target.value)} /></div>
          <div><label className={lblCls}>Termin płatności</label><input type="date" className={inputCls} value={dueDate} onChange={e => setDueDate(e.target.value)} /></div>
          <div><label className={lblCls}>Forma płatności</label>
            <select className={inputCls} value={payment} onChange={e => setPayment(e.target.value)}>
              <option value="przelew">Przelew</option><option value="gotówka">Gotówka</option><option value="karta">Karta</option>
            </select>
          </div>
        </div>

        {/* Pozycje */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
              <tr><th className="text-left px-2 py-1.5 font-medium">Nazwa</th><th className="px-2 py-1.5 font-medium w-16">Ilość</th><th className="px-2 py-1.5 font-medium w-16">Jm.</th><th className="px-2 py-1.5 font-medium w-24">Cena netto</th><th className="px-2 py-1.5 font-medium w-20">VAT</th><th className="text-right px-2 py-1.5 font-medium w-24">Netto</th><th className="w-8"></th></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-2 py-1"><input className="w-full px-1.5 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800" value={l.name} onChange={e => setLine(i, { name: e.target.value })} placeholder="towar / usługa" /></td>
                  <td className="px-2 py-1"><input type="number" min="0" step="0.01" className="w-14 px-1.5 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-right" value={l.qty} onChange={e => setLine(i, { qty: parseFloat(e.target.value) || 0 })} /></td>
                  <td className="px-2 py-1"><input className="w-14 px-1.5 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800" value={l.unit} onChange={e => setLine(i, { unit: e.target.value })} /></td>
                  <td className="px-2 py-1"><input type="number" min="0" step="0.01" className="w-20 px-1.5 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-right" value={l.unit_price} onChange={e => setLine(i, { unit_price: parseFloat(e.target.value) || 0 })} /></td>
                  <td className="px-2 py-1">
                    <select className="w-16 px-1 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800" value={l.vat_rate} onChange={e => setLine(i, { vat_rate: Number(e.target.value) })}>
                      {[23, 8, 5, 0].map(r => <option key={r} value={r}>{r}%</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-200">{fmt(lineNet(l))}</td>
                  <td className="px-2 py-1 text-center">{lines.length > 1 && <button onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400 hover:text-red-600 text-xs">✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => setLines(prev => [...prev, { ...EMPTY_LINE }])} className="w-full py-1.5 text-xs text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 border-t border-gray-100 dark:border-gray-800">+ Dodaj pozycję</button>
        </div>

        <div className="flex justify-between items-center bg-gray-50 dark:bg-gray-800 rounded-lg px-4 py-2.5">
          <span className="text-sm text-gray-600 dark:text-gray-400">Razem netto / VAT / brutto:</span>
          <span className="text-sm font-bold text-gray-800 dark:text-gray-100">{fmt(totalNet)} / {fmt(totalVat)} / <span className="text-violet-700 dark:text-violet-300">{fmt(totalNet + totalVat)} PLN</span></span>
        </div>

        <div><label className={lblCls}>Uwagi (na fakturze)</label><input className={inputCls} value={notes} onChange={e => setNotes(e.target.value)} placeholder="opcjonalnie" /></div>
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Zapisz szkic'}</button>
        </div>
      </div>
    </Modal>
  )
}
