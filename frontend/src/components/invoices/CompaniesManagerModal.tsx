import { useEffect, useState } from 'react'
import Modal from '../ui/Modal'
import { companiesApi } from '../../api/client'
import type { Company, CompanyInput, CompanyBusinessUnit } from '../../api/client'

// ── Rejestr firm‑sprzedawców (admin): dane na fakturze, logo, stopka, prefiks numeracji ──

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
const lblCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'
const btnSecondary = 'px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50'

const LOGO_MAX_BYTES = 700 * 1024
export const BUSINESS_UNIT_LABELS: Record<CompanyBusinessUnit, string> = { shc: 'Smart Home Center', gatelynk: 'GateLynk', shared: 'Wspólne' }

const EMPTY_FORM: CompanyInput = {
  name: '', short_name: '', nip: '', address: '', bank_account: '', bank_name: '', email: '',
  invoice_prefix: 'FV', invoice_logo: '', invoice_footer: '', business_unit: 'shc', is_default: false, active: true,
}

// NIP: 10 cyfr; dozwolony prefiks „PL” oraz spacje/myślniki — zapisujemy tak, jak wpisano
export function nipDigits(nip: string) { return (nip || '').trim().replace(/^PL/i, '').replace(/[\s-]/g, '') }
export function isValidNip(nip: string) { return /^\d{10}$/.test(nipDigits(nip)) }

function errMsg(e: any, fallback: string) { return e?.response?.data?.error || e?.message || fallback }

function toForm(c: Company): CompanyInput {
  return {
    name: c.name ?? '', short_name: c.short_name ?? '', nip: c.nip ?? '', address: c.address ?? '',
    bank_account: c.bank_account ?? '', bank_name: c.bank_name ?? '', email: c.email ?? '',
    invoice_prefix: c.invoice_prefix || 'FV', invoice_logo: c.invoice_logo ?? '', invoice_footer: c.invoice_footer ?? '',
    business_unit: c.business_unit || 'shc', is_default: !!c.is_default, active: c.active !== false,
  }
}

export default function CompaniesManagerModal({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Company | 'new' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try { setCompanies(await companiesApi.list(true)); setError('') }
    catch (e: any) { setError(errMsg(e, 'Nie udało się pobrać listy firm.')) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const changed = () => { onChanged?.(); load() }

  const setDefault = async (c: Company) => {
    setBusyId(c.id); setError('')
    try { await companiesApi.update(c.id, { is_default: true }); changed() }
    catch (e: any) { setError(errMsg(e, 'Nie udało się ustawić firmy domyślnej.')) }
    finally { setBusyId(null) }
  }

  const remove = async (c: Company) => {
    if (!window.confirm(`Usunąć firmę „${c.name}”? Tej operacji nie można cofnąć.`)) return
    setBusyId(c.id); setError('')
    try { await companiesApi.remove(c.id); changed() }
    catch (e: any) { setError(errMsg(e, 'Nie udało się usunąć firmy.')) } // 409 → komunikat z backendu (ma faktury / jest domyślna)
    finally { setBusyId(null) }
  }

  // W trybie edycji ✕ / Esc / kliknięcie tła wraca do listy (nie zamyka całego okna)
  const handleClose = () => { if (editing) setEditing(null); else onClose() }
  const title = editing === 'new' ? '🏢 Nowa firma (sprzedawca)' : editing ? `🏢 Edycja firmy: ${editing.short_name || editing.name}` : '🏢 Firmy (sprzedawcy na fakturach)'

  return (
    <Modal title={title} onClose={handleClose} wide>
      {editing ? (
        <CompanyForm
          company={editing === 'new' ? null : editing}
          others={companies.filter(c => editing === 'new' || c.id !== editing.id)}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); changed() }}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-xs text-gray-500 dark:text-gray-400 max-w-md">
              Każda firma ma własne dane, logo, stopkę i prefiks numeracji — faktury każdej firmy numerowane są osobno.
              Firma <strong>domyślna</strong> jest podpowiadana przy nowej fakturze.
            </p>
            <button onClick={() => setEditing('new')} className="px-3 py-1.5 text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white rounded-lg whitespace-nowrap">+ Dodaj firmę</button>
          </div>

          {error && <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">{error}</div>}

          {loading ? <div className="text-center py-10 text-gray-400 text-sm">Ładowanie…</div>
            : companies.length === 0 ? <div className="text-center py-10 text-gray-400 text-sm">Brak firm. Dodaj pierwszą firmę‑sprzedawcę.</div>
            : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
                {companies.map(c => {
                  const busy = busyId === c.id
                  return (
                    <div key={c.id} className={`px-4 py-3 flex items-center gap-3 flex-wrap bg-white dark:bg-gray-900 ${c.active ? '' : 'opacity-60'}`}>
                      <div className="w-12 h-9 shrink-0 rounded bg-white border border-gray-200 dark:border-gray-700 flex items-center justify-center overflow-hidden" title={c.invoice_logo ? 'Logo na fakturze' : 'Brak logo'}>
                        {c.invoice_logo ? <img src={c.invoice_logo} alt="logo" className="max-h-8 max-w-[44px] object-contain" /> : <span className="text-gray-400">🏢</span>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`font-semibold truncate ${c.active ? 'text-gray-800 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400 line-through'}`}>{c.name}</span>
                          {c.is_default && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" title="Firma domyślna">★ domyślna</span>}
                          {!c.active && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400">nieaktywna</span>}
                        </div>
                        <div className="text-xs text-gray-400 truncate">
                          {c.short_name && c.short_name !== c.name ? `${c.short_name} · ` : ''}NIP {c.nip || '—'} · prefiks <span className="font-mono">{c.invoice_prefix || 'FV'}</span> · {BUSINESS_UNIT_LABELS[c.business_unit] ?? c.business_unit}
                          {typeof c.invoices_count === 'number' ? ` · ${c.invoices_count} ${c.invoices_count === 1 ? 'faktura' : c.invoices_count >= 2 && c.invoices_count <= 4 ? 'faktury' : 'faktur'}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button onClick={() => setEditing(c)} disabled={busy} className={btnSecondary}>✏️ Edytuj</button>
                        {!c.is_default && c.active && (
                          <button onClick={() => setDefault(c)} disabled={busy} className={btnSecondary} title="Podpowiadana przy nowej fakturze">★ Ustaw jako domyślną</button>
                        )}
                        <button onClick={() => remove(c)} disabled={busy}
                          title={c.is_default ? 'Firmy domyślnej nie można usunąć — najpierw ustaw inną jako domyślną' : c.invoices_count ? 'Firma ma faktury — zamiast usuwać, dezaktywuj ją w edycji' : 'Usuń firmę'}
                          className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50">🗑</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

          <div className="flex justify-end pt-1">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Zamknij</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Formularz firmy (nowa / edycja) ──
function CompanyForm({ company, others, onCancel, onSaved }: { company: Company | null; others: Company[]; onCancel: () => void; onSaved: () => void }) {
  // pierwsza firma w rejestrze od razu staje się domyślną
  const [form, setForm] = useState<CompanyInput>(company ? toForm(company) : { ...EMPTY_FORM, is_default: others.length === 0 })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const set = <K extends keyof CompanyInput>(k: K, v: CompanyInput[K]) => setForm(f => ({ ...f, [k]: v }))

  const wasDefault = !!company?.is_default
  const prefixClash = others.find(o => o.active && (o.invoice_prefix || 'FV').trim().toUpperCase() === (form.invoice_prefix || 'FV').trim().toUpperCase())
  const nipOk = !form.nip.trim() || isValidNip(form.nip)

  const onLogoFile = (file: File) => {
    if (file.size > LOGO_MAX_BYTES) { setErr(`Logo jest za duże (${Math.round(file.size / 1024)} KB) — maksymalnie 700 KB. Najlepiej PNG/SVG ok. 300×100 px.`); return }
    const r = new FileReader()
    r.onload = () => { set('invoice_logo', String(r.result)); setErr('') }
    r.onerror = () => setErr('Nie udało się odczytać pliku z logo.')
    r.readAsDataURL(file)
  }

  const save = async () => {
    if (!form.name.trim()) { setErr('Nazwa firmy jest wymagana.'); return }
    if (!isValidNip(form.nip)) { setErr('NIP musi mieć 10 cyfr (dozwolony prefiks PL, np. PL1234567890).'); return }
    const payload: CompanyInput = {
      ...form,
      name: form.name.trim(), short_name: form.short_name.trim(), nip: form.nip.trim(), address: form.address.trim(),
      bank_account: form.bank_account.trim(), bank_name: form.bank_name.trim(), email: form.email.trim(),
      invoice_prefix: form.invoice_prefix.trim() || 'FV', invoice_footer: form.invoice_footer.trim(),
    }
    setSaving(true); setErr('')
    try {
      if (company) await companiesApi.update(company.id, payload)
      else await companiesApi.create(payload)
      onSaved()
    } catch (e: any) { setErr(errMsg(e, 'Błąd zapisu firmy.')) } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className={lblCls}>Nazwa pełna *</label>
          <input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} placeholder="np. GateLynk Sp. z o.o." /></div>
        <div><label className={lblCls}>Nazwa skrócona</label>
          <input className={inputCls} value={form.short_name} onChange={e => set('short_name', e.target.value)} placeholder="np. GateLynk (na listach i w filtrach)" /></div>
        <div><label className={lblCls}>NIP *</label>
          <input className={`${inputCls} ${nipOk ? '' : 'border-red-400 dark:border-red-600'}`} value={form.nip} onChange={e => set('nip', e.target.value)} placeholder="np. PL1234567890 lub 1234567890" />
          {!nipOk && <div className="text-[11px] text-red-500 mt-1">NIP musi mieć 10 cyfr (prefiks PL dozwolony).</div>}
        </div>
        <div className="col-span-2"><label className={lblCls}>Adres (na fakturze)</label>
          <textarea className={`${inputCls} min-h-[60px]`} rows={2} value={form.address} onChange={e => set('address', e.target.value)} placeholder={'ulica nr/lokal\nkod pocztowy miasto'} /></div>
        <div><label className={lblCls}>Konto bankowe</label>
          <input className={`${inputCls} font-mono`} value={form.bank_account} onChange={e => set('bank_account', e.target.value)} placeholder="np. 62 1140 2004 0000 3302 7656 7828" /></div>
        <div><label className={lblCls}>Bank</label>
          <input className={inputCls} value={form.bank_name} onChange={e => set('bank_name', e.target.value)} placeholder="np. mBank" /></div>
        <div><label className={lblCls}>E‑mail</label>
          <input type="email" className={inputCls} value={form.email} onChange={e => set('email', e.target.value)} placeholder="np. biuro@firma.pl" /></div>
        <div><label className={lblCls}>Jednostka biznesowa</label>
          <select className={inputCls} value={form.business_unit} onChange={e => set('business_unit', e.target.value as CompanyBusinessUnit)}>
            {(Object.keys(BUSINESS_UNIT_LABELS) as CompanyBusinessUnit[]).map(k => <option key={k} value={k}>{BUSINESS_UNIT_LABELS[k]}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">Do rentowności: „Smart Home Center” i „Wspólne” liczą się jako przychód spółki (Kondycja firmy, RZiS); „GateLynk” — tylko w widoku jednostki GateLynk (osobna spółka nie zawyża wyniku SHC).</p>
        </div>
      </div>

      {/* Numeracja */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-1.5 bg-gray-50/60 dark:bg-gray-800/40">
        <label className={lblCls}>Prefiks numeracji faktur</label>
        <div className="flex items-center gap-3 flex-wrap">
          <input className={`${inputCls} w-36 font-mono`} value={form.invoice_prefix} onChange={e => set('invoice_prefix', e.target.value)} placeholder="FV" />
          <span className="text-xs text-gray-500 dark:text-gray-400">Numer: <span className="font-mono font-semibold text-gray-700 dark:text-gray-200">{(form.invoice_prefix.trim() || 'FV')}/RRRR/MM/NNN</span> — numeracja osobna dla każdej firmy.</span>
        </div>
        <p className="text-[11px] text-gray-400">
          Domyślnie „FV”. Dla drugiej firmy użyj innego prefiksu, np. <span className="font-mono">FV-GL</span>, żeby numery obu firm się nie myliły.
        </p>
        {prefixClash && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">⚠️ Taki sam prefiks ma już firma „{prefixClash.short_name || prefixClash.name}” — numery obu firm będą wyglądać identycznie.</p>
        )}
      </div>

      {/* Logo */}
      <div>
        <label className={lblCls}>Logo na fakturze</label>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="h-16 w-44 rounded-lg bg-white border border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center overflow-hidden">
            {form.invoice_logo
              ? <img src={form.invoice_logo} alt="logo" className="max-h-14 max-w-[168px] object-contain" />
              : <span className="text-xs text-gray-400">brak logo</span>}
          </div>
          <label className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg cursor-pointer">
            🖼 {form.invoice_logo ? 'Zmień logo' : 'Wybierz plik'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) onLogoFile(f); e.target.value = '' }} />
          </label>
          {form.invoice_logo && (
            <button type="button" onClick={() => set('invoice_logo', '')} className="px-2 py-2 text-xs text-gray-400 hover:text-red-500" title="Usuń logo">✕ Usuń</button>
          )}
        </div>
        <p className="text-[11px] text-gray-400 mt-1">PNG / JPG / SVG / WEBP, maks. 700 KB — najlepiej ok. 300×100 px na białym lub przezroczystym tle.</p>
      </div>

      <div><label className={lblCls}>Stopka faktury</label>
        <textarea className={`${inputCls} min-h-[56px]`} rows={2} value={form.invoice_footer} onChange={e => set('invoice_footer', e.target.value)} placeholder="np. KRS 0000000000 · Kapitał zakładowy 5 000 zł · Sąd Rejonowy dla m.st. Warszawy" /></div>

      <div className="flex items-center gap-5 flex-wrap">
        <label className={`flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 ${wasDefault ? 'opacity-60' : 'cursor-pointer'}`}
          title={wasDefault ? 'Aby zmienić, ustaw inną firmę jako domyślną' : 'Podpowiadana przy nowej fakturze'}>
          <input type="checkbox" className="accent-violet-600" checked={form.is_default} disabled={wasDefault} onChange={e => set('is_default', e.target.checked)} />
          ★ Domyślna
        </label>
        <label className={`flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 ${form.is_default ? 'opacity-60' : 'cursor-pointer'}`}
          title={form.is_default ? 'Firma domyślna musi być aktywna' : 'Nieaktywna firma nie pojawia się w wyborze sprzedawcy'}>
          <input type="checkbox" className="accent-violet-600" checked={form.active} disabled={form.is_default} onChange={e => set('active', e.target.checked)} />
          Aktywna
        </label>
      </div>

      {err && <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">{err}</div>}
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">← Wróć do listy</button>
        <button type="button" onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">
          {saving ? 'Zapisywanie…' : company ? 'Zapisz zmiany' : 'Dodaj firmę'}
        </button>
      </div>
    </div>
  )
}
