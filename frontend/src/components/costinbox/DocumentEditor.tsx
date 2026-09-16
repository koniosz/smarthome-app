// Edycja inline pól dokumentu („✎ Popraw”) — PUT /cost-documents/:id, albo zapis + zatwierdzenie (approve z override).
import { useState } from 'react'
import { Save, Check, X } from 'lucide-react'
import { costDocumentsApi, approveConflict, type CostDocument, type CostDocumentEdit } from '../../api/costInbox'
import { BUSINESS_UNITS, categoryForSubcategory } from '../../constants/costTaxonomy'
import { inputCls, labelCls, btnPrimary, btnSecondary, parseNum, errorMessage, SubcategorySelect } from './shared'

const CURRENCIES = ['PLN', 'EUR', 'USD', 'GBP', 'CHF', 'CZK', 'CNY', 'SEK', 'NOK', 'DKK', 'HUF']

export default function DocumentEditor({ doc, onCancel, onSaved }: {
  doc: CostDocument
  onCancel: () => void
  onSaved: (doc: CostDocument, approved: boolean) => void
}) {
  const [f, setF] = useState({
    seller_name: doc.seller_name || '',
    seller_nip: doc.seller_nip || '',
    doc_number: doc.doc_number || '',
    doc_date: doc.doc_date || '',
    currency: (doc.currency || 'PLN').toUpperCase(),
    net: doc.net ? String(doc.net).replace('.', ',') : '',
    vat: doc.vat ? String(doc.vat).replace('.', ',') : '0',
    gross: doc.gross ? String(doc.gross).replace('.', ',') : '',
    subcategory: doc.subcategory || 'other',
    business_unit: doc.business_unit || 'shc',
    is_receipt: !!doc.is_receipt,
    notes: doc.notes || '',
  })
  const [saving, setSaving] = useState<'' | 'save' | 'approve'>('')
  const [err, setErr] = useState('')
  const [dup, setDup] = useState<{ note: string } | null>(null)

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }))

  const build = (): CostDocumentEdit | string => {
    const net = parseNum(f.net)
    const vat = f.vat.trim() === '' ? 0 : parseNum(f.vat)
    const grossRaw = f.gross.trim() === '' ? NaN : parseNum(f.gross)
    if (isNaN(net) || net < 0) return 'Podaj kwotę netto (może być 0 dla paragonu bez VAT).'
    if (isNaN(vat) || vat < 0) return 'VAT musi być liczbą (0, gdy brak).'
    const gross = isNaN(grossRaw) ? Math.round((net + vat) * 100) / 100 : grossRaw
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.doc_date)) return 'Podaj datę dokumentu (RRRR-MM-DD).'
    if (!/^[A-Z]{3}$/.test(f.currency)) return 'Waluta: kod 3-literowy (np. EUR).'
    return {
      seller_name: f.seller_name.trim(),
      seller_nip: f.seller_nip.replace(/\D/g, ''),
      doc_number: f.doc_number.trim(),
      doc_date: f.doc_date,
      currency: f.currency,
      net, vat, gross,
      cost_category: categoryForSubcategory(f.subcategory),
      subcategory: f.subcategory,
      business_unit: f.business_unit,
      is_receipt: f.is_receipt,
      notes: f.notes.trim(),
    }
  }

  const save = async (approve: boolean, force = false) => {
    const payload = build()
    if (typeof payload === 'string') { setErr(payload); return }
    setSaving(approve ? 'approve' : 'save'); setErr(''); setDup(null)
    try {
      if (approve) {
        const saved = await costDocumentsApi.approve(doc.id, { ...payload, force })
        onSaved(saved, true)
      } else {
        const saved = await costDocumentsApi.update(doc.id, payload)
        onSaved(saved, false)
      }
    } catch (e) {
      const c = approveConflict(e)
      if (c) setDup({ note: c.duplicate_note || c.error })
      else setErr(errorMessage(e, 'Nie udało się zapisać dokumentu.'))
      setSaving('')
    }
  }

  const netN = parseNum(f.net), vatN = f.vat.trim() === '' ? 0 : parseNum(f.vat)
  const grossHint = !isNaN(netN) && !isNaN(vatN) ? (netN + vatN).toFixed(2).replace('.', ',') : ''

  return (
    <div className="mt-3 p-4 rounded-xl border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20">
      <div className="text-xs font-bold text-violet-700 dark:text-violet-300 mb-3">Popraw dane odczytane z dokumentu</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="col-span-2">
          <label className={labelCls}>Sprzedawca</label>
          <input value={f.seller_name} onChange={e => set('seller_name', e.target.value)} className={inputCls} placeholder="np. Amazon EU S.à r.l." />
        </div>
        <div>
          <label className={labelCls}>NIP / VAT ID (same cyfry)</label>
          <input value={f.seller_nip} onChange={e => set('seller_nip', e.target.value)} className={inputCls} placeholder="opcjonalnie" />
        </div>
        <div>
          <label className={labelCls}>Numer dokumentu</label>
          <input value={f.doc_number} onChange={e => set('doc_number', e.target.value)} className={inputCls} placeholder="np. INV-2026-001" />
        </div>
        <div>
          <label className={labelCls}>Data dokumentu</label>
          <input type="date" value={f.doc_date} onChange={e => set('doc_date', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Waluta</label>
          <input list="costinbox-currencies" value={f.currency} onChange={e => set('currency', e.target.value.toUpperCase().slice(0, 3))} className={inputCls} />
          <datalist id="costinbox-currencies">{CURRENCIES.map(c => <option key={c} value={c} />)}</datalist>
        </div>
        <div>
          <label className={labelCls}>Netto ({f.currency})</label>
          <input value={f.net} onChange={e => set('net', e.target.value)} inputMode="decimal" className={inputCls} placeholder="1 234,00" />
        </div>
        <div>
          <label className={labelCls}>VAT ({f.currency})</label>
          <input value={f.vat} onChange={e => set('vat', e.target.value)} inputMode="decimal" className={inputCls} placeholder="0" />
        </div>
        <div>
          <label className={labelCls}>Brutto ({f.currency})</label>
          <input value={f.gross} onChange={e => set('gross', e.target.value)} inputMode="decimal" className={inputCls} placeholder={grossHint || 'netto + VAT'} />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Kategoria kosztu</label>
          <SubcategorySelect value={f.subcategory} onChange={v => set('subcategory', v)} />
        </div>
        <div>
          <label className={labelCls}>Jednostka</label>
          <select value={f.business_unit} onChange={e => set('business_unit', e.target.value)} className={inputCls}>
            {Object.entries(BUSINESS_UNITS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="col-span-2 md:col-span-4">
          <label className={labelCls}>Notatka</label>
          <input value={f.notes} onChange={e => set('notes', e.target.value)} className={inputCls} placeholder="np. licencja roczna, projekt X" />
        </div>
        <label className="col-span-2 md:col-span-4 inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
          <input type="checkbox" checked={f.is_receipt} onChange={e => set('is_receipt', e.target.checked)} className="accent-violet-600" />
          To paragon / rachunek bez VAT do odliczenia
          <span className="text-xs text-gray-400">(wtedy do kosztów wchodzi kwota brutto)</span>
        </label>
      </div>

      {err && <div className="mt-3 text-xs font-semibold text-red-600 dark:text-red-400">{err}</div>}
      {dup && (
        <div className="mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-3 flex-wrap">
          <span className="flex-1">⚠ Wygląda na duplikat: {dup.note}</span>
          <button onClick={() => save(true, true)} disabled={!!saving} className={btnSecondary}>Zatwierdź mimo to</button>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 mt-4 flex-wrap">
        <button onClick={onCancel} disabled={!!saving} className={btnSecondary}><X size={14} /> Anuluj</button>
        <button onClick={() => save(false)} disabled={!!saving} className={btnSecondary}><Save size={14} /> {saving === 'save' ? 'Zapisuję…' : 'Zapisz'}</button>
        <button onClick={() => save(true)} disabled={!!saving} className={btnPrimary}><Check size={14} /> {saving === 'approve' ? 'Zatwierdzam…' : 'Zapisz i zatwierdź'}</button>
      </div>
    </div>
  )
}
