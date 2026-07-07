import { useEffect, useState } from 'react'
import Modal from '../ui/Modal'
import { salesInvoicesApi, quotesApi, warehouseApi } from '../../api/client'
import type { SalesInvoice, SalesInvoiceItem, WarehouseDoc } from '../../api/client'
import type { AiQuote } from '../../types'
import { COMPANY_INFO } from '../../constants/company'

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
  const [list, setList] = useState<SalesInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [editInv, setEditInv] = useState<SalesInvoice | 'new' | null>(null)

  const load = () => { setLoading(true); salesInvoicesApi.list().then(setList).catch(() => setList([])).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  const act = async (fn: () => Promise<any>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    try { await fn(); load() } catch (e: any) { alert(e?.response?.data?.error || 'Błąd operacji.') }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-1 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Faktury sprzedażowe <span className="text-xs font-semibold align-middle bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 px-2 py-0.5 rounded-full">BETA</span></h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Szkic → wystawienie (numer FV) → wydruk/PDF · numeracja FV/RRRR/MM/NNN</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="px-3 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">← Faktury kosztowe</button>
          <button onClick={() => setEditInv('new')} className="px-4 py-2 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg">+ Nowa faktura</button>
        </div>
      </div>
      <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 mb-4 mt-3 max-w-2xl">
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
                  <div className="flex items-center gap-1.5">
                    {inv.status === 'draft' && <>
                      <button onClick={() => setEditInv(inv)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800">✏️ Edytuj</button>
                      <button onClick={() => act(() => salesInvoicesApi.issue(inv.id), `Wystawić fakturę dla ${inv.buyer_name}? Zostanie nadany numer.`)} className="px-2.5 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded">Wystaw</button>
                      <button onClick={() => act(() => salesInvoicesApi.delete(inv.id), 'Usunąć szkic?')} className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50">🗑</button>
                    </>}
                    {inv.status === 'issued' && <>
                      <button onClick={() => printInvoice(inv)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800">🖨 Drukuj</button>
                      <button onClick={() => act(() => salesInvoicesApi.markPaid(inv.id))} className="px-2.5 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded">Opłacona</button>
                      <button onClick={() => act(() => salesInvoicesApi.cancel(inv.id), 'Anulować fakturę? Pozostanie w rejestrze jako anulowana.')} className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50">Anuluj</button>
                    </>}
                    {inv.status === 'paid' && <button onClick={() => printInvoice(inv)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800">🖨 Drukuj</button>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      {editInv && <InvoiceBuilderModal invoice={editInv === 'new' ? null : editInv} onClose={() => setEditInv(null)} onSaved={() => { setEditInv(null); load() }} />}
    </div>
  )
}

// ── Wydruk faktury (okno drukowania — Ctrl+P → PDF) ──
function printInvoice(inv: SalesInvoice) {
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
    <div><div style="font-weight:800;font-size:14px">${COMPANY_INFO.name}</div>
    <div style="font-size:11px;color:#475569">${COMPANY_INFO.address}<br>NIP: ${COMPANY_INFO.nip}</div></div>
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
  <script>window.print()</script></body></html>`
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close() }
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
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

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
      items: validLines, quote_id: quoteRef || undefined, warehouse_doc_id: wzRef || undefined,
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

        <div className="grid grid-cols-2 gap-3">
          <div><label className={lblCls}>Nabywca *</label><input className={inputCls} value={buyerName} onChange={e => setBuyerName(e.target.value)} placeholder="nazwa firmy / imię i nazwisko" /></div>
          <div><label className={lblCls}>NIP nabywcy</label><input className={inputCls} value={buyerNip} onChange={e => setBuyerNip(e.target.value)} placeholder="np. 8961543585" /></div>
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
