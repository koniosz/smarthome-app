// Reguły bankowe: lista z trafieniami, formularz (nowa / edycja), „Zastosuj reguły do historii” + nierozpoznane przelewy.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Pencil, Trash2, Play, Save, X } from 'lucide-react'
import { bankRulesApi, type BankRule, type BankRuleInput, type BankRuleMatchField, type BankRulePnlMode, type BankRulesApplyResult, type UnmatchedTransfer } from '../../api/costInbox'
import { BUSINESS_UNITS, MATCH_FIELD_LABELS, categoryForSubcategory, subcategoryLabel, businessUnitLabel } from '../../constants/costTaxonomy'
import UnmatchedTransfers from './UnmatchedTransfers'
import { errorMessage, inputCls, labelCls, cardCls, btnPrimary, btnSecondary, btnGhost, Badge, Alert, SubcategorySelect } from './shared'

interface FormState {
  name: string
  pattern: string
  match_field: BankRuleMatchField
  subcategory: string
  business_unit: string
  pnl_mode: BankRulePnlMode
}

const EMPTY: FormState = { name: '', pattern: '', match_field: 'any', subcategory: 'software', business_unit: 'shared', pnl_mode: 'include' }

export default function BankRulesPanel() {
  const [rules, setRules] = useState<BankRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState<FormState>(EMPTY)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState('')
  const [notice, setNotice] = useState('')
  const [applying, setApplying] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [applyResult, setApplyResult] = useState<BankRulesApplyResult | null>(null)
  const [unmatchedKey, setUnmatchedKey] = useState(0)
  const formRef = useRef<HTMLDivElement>(null)
  const patternRef = useRef<HTMLInputElement>(null)

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(p => ({ ...p, [k]: v }))

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setRules(await bankRulesApi.list()) }
    catch (e) { setError(errorMessage(e, 'Nie udało się pobrać reguł.')) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const resetForm = () => { setForm(EMPTY); setEditingId(null); setFormErr('') }

  const submit = async () => {
    const pattern = form.pattern.trim()
    if (pattern.length < 3) { setFormErr('Fragment musi mieć co najmniej 3 znaki.'); return }
    const payload: BankRuleInput = {
      name: form.name.trim() || pattern,
      pattern,
      match_field: form.match_field,
      cost_category: categoryForSubcategory(form.subcategory),
      subcategory: form.subcategory,
      business_unit: form.business_unit,
      pnl_mode: form.pnl_mode,
    }
    setSaving(true); setFormErr('')
    try {
      if (editingId) {
        const saved = await bankRulesApi.update(editingId, payload)
        setRules(prev => prev.map(r => r.id === editingId ? saved : r))
        setNotice(`Reguła „${saved.name}” zapisana.`)
      } else {
        const created = await bankRulesApi.create(payload)
        setRules(prev => [created, ...prev])
        setNotice(`Reguła „${created.name}” dodana. Zadziała przy kolejnym imporcie wyciągu — a dla starych przelewów kliknij „Zastosuj reguły do historii”.`)
      }
      resetForm()
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status
      setFormErr(status === 409 ? 'Reguła z takim samym fragmentem już istnieje.' : errorMessage(e, 'Nie udało się zapisać reguły.'))
    } finally {
      setSaving(false)
    }
  }

  const edit = (r: BankRule) => {
    setEditingId(r.id)
    setForm({
      name: r.name, pattern: r.pattern,
      match_field: (['counterparty', 'description', 'any'].includes(r.match_field) ? r.match_field : 'any') as BankRuleMatchField,
      subcategory: r.subcategory, business_unit: r.business_unit,
      pnl_mode: r.pnl_mode === 'exclude' ? 'exclude' : 'include',
    })
    setFormErr('')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const remove = async (r: BankRule) => {
    if (!window.confirm(`Usunąć regułę „${r.name}”? Przelewy przypisane do niej wrócą do trybu automatycznego.`)) return
    try {
      await bankRulesApi.remove(r.id)
      setRules(prev => prev.filter(x => x.id !== r.id))
      if (editingId === r.id) resetForm()
      setUnmatchedKey(k => k + 1)
    } catch (e) { setError(errorMessage(e, 'Nie udało się usunąć reguły.')) }
  }

  const apply = async () => {
    setApplying(true); setApplyResult(null); setError('')
    try {
      const res = await bankRulesApi.apply(overwrite)
      setApplyResult(res)
      await load()
      setUnmatchedKey(k => k + 1)
    } catch (e) { setError(errorMessage(e, 'Nie udało się zastosować reguł.')) }
    finally { setApplying(false) }
  }

  const prefillFrom = (t: UnmatchedTransfer) => {
    const pattern = t.suggested_pattern || ''
    setEditingId(null)
    setForm({
      name: pattern, pattern, match_field: 'any',
      subcategory: t.subcategory && subcategoryLabel(t.subcategory) !== t.subcategory ? t.subcategory : 'software',
      business_unit: 'shared', pnl_mode: 'include',
    })
    setFormErr('')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(() => patternRef.current?.focus(), 300)
  }

  const ruleName = (id: string) => rules.find(r => r.id === id)?.name ?? id

  return (
    <div className="space-y-4">
      <Alert tone="blue">
        <b>Reguła bankowa</b> mówi systemowi: „gdy na wyciągu pojawi się przelew z tym fragmentem nazwy, zaksięguj go w tej kategorii”.
        Przydaje się do stałych opłat bez faktury w KSeF: subskrypcje zagraniczne, ubezpieczenia, leasing. Reguły działają przy każdym imporcie MT940.
      </Alert>

      {error && <Alert tone="red">{error}</Alert>}
      {notice && <Alert tone="green"><span className="flex items-center gap-3"><span className="flex-1">{notice}</span><button onClick={() => setNotice('')} className="text-xs font-semibold">zamknij</button></span></Alert>}

      {/* Formularz */}
      <div ref={formRef} className={`${cardCls} p-5`}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">{editingId ? 'Edytuj regułę' : 'Nowa reguła'}</h3>
          {editingId && <button onClick={resetForm} className={btnGhost}><X size={13} /> Anuluj edycję</button>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>Nazwa (dla ludzi)</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} className={inputCls} placeholder="np. Google Workspace" />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Fragment nazwy / opisu na wyciągu</label>
            <input ref={patternRef} value={form.pattern} onChange={e => set('pattern', e.target.value)} className={inputCls} placeholder="np. GOOGLE" />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Gdzie szukać</label>
            <select value={form.match_field} onChange={e => set('match_field', e.target.value as BankRuleMatchField)} className={inputCls}>
              {Object.entries(MATCH_FIELD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="col-span-2 md:col-span-3">
            <label className={labelCls}>Kategoria kosztu</label>
            <SubcategorySelect value={form.subcategory} onChange={v => set('subcategory', v)} />
          </div>
          <div className="col-span-1 md:col-span-1">
            <label className={labelCls}>Jednostka</label>
            <select value={form.business_unit} onChange={e => set('business_unit', e.target.value)} className={inputCls}>
              {Object.entries(BUSINESS_UNITS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="col-span-1 md:col-span-2">
            <label className={labelCls}>Co robić z przelewem</label>
            <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
              {([['include', 'Licz w RZiS'], ['exclude', 'Pomiń']] as [BankRulePnlMode, string][]).map(([v, l]) => (
                <button key={v} type="button" onClick={() => set('pnl_mode', v)}
                  className={`flex-1 px-2 py-1.5 rounded-md text-xs font-semibold ${form.pnl_mode === v
                    ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-gray-400 mt-2">
          Wielkość liter i polskie znaki nie mają znaczenia. „Pomiń” = przelew nigdy nie wejdzie do kosztów (np. przelewy własne, spłaty kart).
        </div>
        {formErr && <div className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">{formErr}</div>}
        <div className="flex justify-end mt-3">
          <button onClick={submit} disabled={saving} className={btnPrimary}>
            {editingId ? <Save size={14} /> : <Plus size={14} />} {saving ? 'Zapisuję…' : editingId ? 'Zapisz zmiany' : 'Dodaj regułę'}
          </button>
        </div>
      </div>

      {/* Lista reguł */}
      <div className={`${cardCls} overflow-hidden`}>
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex-wrap">
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100 flex-1">Reguły ({rules.length})</h3>
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
            <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} className="accent-violet-600" />
            nadpisz też przelewy już przypisane do reguł
          </label>
          <button onClick={apply} disabled={applying || rules.length === 0} className={btnSecondary} title="Przepuść wszystkie przelewy z wyciągów przez reguły">
            <Play size={14} /> {applying ? 'Stosuję…' : 'Zastosuj reguły do historii'}
          </button>
        </div>
        {applyResult && (
          <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 text-sm text-green-800 dark:text-green-300 bg-green-50/60 dark:bg-green-900/10">
            Zaktualizowano <b>{applyResult.updated}</b> przelewów.
            {Object.keys(applyResult.by_rule || {}).length > 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                {Object.entries(applyResult.by_rule).map(([id, n]) => `${ruleName(id)}: ${n}`).join(' · ')}
              </span>
            )}
          </div>
        )}
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Ładowanie…</div>
        ) : rules.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">Brak reguł. Dodaj pierwszą powyżej albo kliknij „Reguła z tego” przy nierozpoznanym przelewie poniżej.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-2.5 text-left font-semibold">Nazwa</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Fragment · gdzie</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Kategoria</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Jednostka</th>
                  <th className="px-4 py-2.5 text-left font-semibold">RZiS</th>
                  <th className="px-4 py-2.5 text-right font-semibold" title="Ile przelewów złapała ta reguła">Trafienia</th>
                  <th className="px-2 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.id} className={`border-b border-gray-50 dark:border-gray-800/60 ${editingId === r.id ? 'bg-violet-50/50 dark:bg-violet-950/20' : ''}`}>
                    <td className="px-4 py-2.5 font-semibold text-gray-800 dark:text-gray-100">{r.name || r.pattern}</td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
                      <code className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">{r.pattern}</code>
                      <span className="text-[11px] text-gray-400 ml-1.5">{(MATCH_FIELD_LABELS as Record<string, string>)[r.match_field] ?? r.match_field}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">{subcategoryLabel(r.subcategory)}</td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">{businessUnitLabel(r.business_unit)}</td>
                    <td className="px-4 py-2.5">
                      {r.pnl_mode === 'exclude' ? <Badge tone="gray">pomiń</Badge> : <Badge tone="green">licz</Badge>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-200 font-semibold">{r.hits ?? 0}</td>
                    <td className="px-2 py-2.5 whitespace-nowrap text-right">
                      <button onClick={() => edit(r)} className={btnGhost} title="Edytuj"><Pencil size={13} /></button>
                      <button onClick={() => remove(r)} className={`${btnGhost} hover:text-red-600 dark:hover:text-red-400`} title="Usuń"><Trash2 size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UnmatchedTransfers refreshKey={unmatchedKey} onMakeRule={prefillFrom} />
    </div>
  )
}
