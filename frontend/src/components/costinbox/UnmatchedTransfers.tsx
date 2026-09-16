// Nierozpoznane przelewy MT940 (koszty, które nie wchodzą do RZiS i nie są zapłatą za fakturę KSeF).
// Z każdego można zrobić regułę („➕ Reguła z tego”) albo podjąć jednorazową decyzję (PATCH /cost/:id).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Check, Ban, RotateCcw } from 'lucide-react'
import { bankRulesApi, type UnmatchedTransfer } from '../../api/costInbox'
import { BUSINESS_UNITS, categoryForSubcategory, subcategoryLabel } from '../../constants/costTaxonomy'
import { money, fmtDate, currentMonth, errorMessage, inputCls, labelCls, cardCls, btnPrimary, btnSecondary, btnGhost, Badge, Alert, SubcategorySelect } from './shared'

export default function UnmatchedTransfers({ refreshKey, onMakeRule }: {
  refreshKey: number
  onMakeRule: (t: UnmatchedTransfer) => void
}) {
  const [from, setFrom] = useState(currentMonth(-2))
  const [to, setTo] = useState(currentMonth(0))
  const [items, setItems] = useState<UnmatchedTransfer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showExcluded, setShowExcluded] = useState(false)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [decSub, setDecSub] = useState('software')
  const [decBU, setDecBU] = useState('shared')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<Record<string, string>>({})
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return
    const my = ++seq.current
    setLoading(true); setError('')
    try {
      const list = await bankRulesApi.unmatched(from, to)
      if (my !== seq.current) return
      setItems(list)
    } catch (e) {
      if (my !== seq.current) return
      setError(errorMessage(e, 'Nie udało się pobrać przelewów.'))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [from, to])

  useEffect(() => { void load() }, [load, refreshKey])

  const startInclude = (t: UnmatchedTransfer) => {
    setDeciding(t.id)
    setDecSub(t.subcategory && subcategoryLabel(t.subcategory) !== t.subcategory ? t.subcategory : 'software')
    setDecBU('shared')
  }

  const patch = async (t: UnmatchedTransfer, data: Parameters<typeof bankRulesApi.patchCost>[1], after: (t: UnmatchedTransfer) => UnmatchedTransfer | null) => {
    setBusyId(t.id); setRowErr(p => ({ ...p, [t.id]: '' }))
    try {
      await bankRulesApi.patchCost(t.id, data)
      setItems(prev => prev.flatMap(x => {
        if (x.id !== t.id) return [x]
        const next = after(x)
        return next ? [next] : []
      }))
      setDeciding(null)
    } catch (e) {
      setRowErr(p => ({ ...p, [t.id]: errorMessage(e, 'Nie udało się zapisać decyzji.') }))
    } finally {
      setBusyId(null)
    }
  }

  const include = (t: UnmatchedTransfer) =>
    patch(t, { pnl_mode: 'include', cost_category: categoryForSubcategory(decSub), subcategory: decSub, business_unit: decBU }, () => null)
  const exclude = (t: UnmatchedTransfer) =>
    patch(t, { pnl_mode: 'exclude' }, x => ({ ...x, pnl_mode: 'exclude' }))
  // Cofnięcie „Pomiń": pnl_mode=auto → przelew znów jest nierozpoznany (i podlega regułom)
  const restore = (t: UnmatchedTransfer) =>
    patch(t, { pnl_mode: 'auto' }, x => ({ ...x, pnl_mode: 'auto' }))

  const visible = items.filter(i => showExcluded || i.pnl_mode !== 'exclude')
  const excludedCount = items.length - items.filter(i => i.pnl_mode !== 'exclude').length
  const total = visible.reduce((s, i) => s + (i.amount || 0), 0)

  return (
    <div className={`${cardCls} p-5`}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">Nierozpoznane przelewy</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-xl">
            Wychodzące przelewy z wyciągu, których system nie liczy w rentowności (bo nie wie, co to) i które nie są zapłatą za fakturę z KSeF.
            Zdecyduj: zrób z nich regułę na przyszłość, policz raz w RZiS albo pomiń.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className={labelCls}>Od</label>
            <input type="month" value={from} onChange={e => setFrom(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Do</label>
            <input type="month" value={to} onChange={e => setTo(e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>

      {error && <div className="mb-3"><Alert tone="red">{error}</Alert></div>}

      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mb-2 flex-wrap">
        <span>{visible.length} przelewów · razem <b className="text-gray-700 dark:text-gray-200">{money(total)}</b></span>
        {excludedCount > 0 && (
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showExcluded} onChange={e => setShowExcluded(e.target.checked)} className="accent-violet-600" />
            pokaż pominięte ({excludedCount})
          </label>
        )}
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-400 text-sm">Ładowanie…</div>
      ) : visible.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">Wszystkie przelewy w tym zakresie są rozpoznane. 🎉</div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800 border-t border-gray-100 dark:border-gray-800">
          {visible.map(t => {
            const busy = busyId === t.id
            const isExcluded = t.pnl_mode === 'exclude'
            return (
              <div key={t.id} className={`py-2.5 ${isExcluded ? 'opacity-60' : ''}`}>
                <div className="flex items-center gap-3 flex-wrap md:flex-nowrap text-sm">
                  <span className="text-xs text-gray-400 tabular-nums w-20 flex-shrink-0">{fmtDate(t.date)}</span>
                  <span className="font-bold tabular-nums text-gray-800 dark:text-gray-100 w-28 text-right flex-shrink-0">{money(t.amount)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-gray-700 dark:text-gray-200 truncate" title={t.description}>{t.description || '(bez opisu)'}</div>
                    <div className="text-[11px] text-gray-400 truncate">
                      {t.reference && <span title="Referencja bankowa">ref. {t.reference} · </span>}
                      <span title="Kategoria nadana automatycznie">{subcategoryLabel(t.subcategory)}</span>
                      {isExcluded && <> · <Badge tone="gray">pominięty</Badge></>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
                    <button onClick={() => onMakeRule(t)} disabled={busy} className={btnGhost} title={`Utwórz regułę z fragmentem „${t.suggested_pattern}”`}>
                      <Plus size={13} /> Reguła z tego
                    </button>
                    {!isExcluded && (
                      <button onClick={() => deciding === t.id ? setDeciding(null) : startInclude(t)} disabled={busy}
                        className={`${btnGhost} text-green-700 dark:text-green-400`} title="Policz ten jeden przelew w rentowności (bez reguły)">
                        <Check size={13} /> Licz w RZiS
                      </button>
                    )}
                    {!isExcluded && (
                      <button onClick={() => exclude(t)} disabled={busy} className={btnGhost} title="Nie licz tego przelewu w rentowności (np. to przelew własny albo zapłata za fakturę, która już jest w KSeF)">
                        <Ban size={13} /> {busy ? '…' : 'Pomiń'}
                      </button>
                    )}
                    {isExcluded && (
                      <button onClick={() => restore(t)} disabled={busy} className={btnGhost} title="Cofnij pominięcie — przelew wróci na listę nierozpoznanych">
                        <RotateCcw size={13} /> {busy ? '…' : 'Przywróć'}
                      </button>
                    )}
                  </div>
                </div>
                {deciding === t.id && (
                  <div className="mt-2 ml-0 md:ml-[8.5rem] p-3 rounded-lg bg-green-50/60 dark:bg-green-950/20 border border-green-200 dark:border-green-900 flex items-end gap-2 flex-wrap">
                    <div className="min-w-[220px]">
                      <label className={labelCls}>Kategoria kosztu</label>
                      <SubcategorySelect value={decSub} onChange={setDecSub} />
                    </div>
                    <div>
                      <label className={labelCls}>Jednostka</label>
                      <select value={decBU} onChange={e => setDecBU(e.target.value)} className={inputCls}>
                        {Object.entries(BUSINESS_UNITS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                    <button onClick={() => include(t)} disabled={busy} className={btnPrimary}><Check size={14} /> {busy ? 'Zapisuję…' : 'Licz w RZiS'}</button>
                    <button onClick={() => setDeciding(null)} disabled={busy} className={btnSecondary}>Anuluj</button>
                  </div>
                )}
                {rowErr[t.id] && <div className="mt-1 text-xs font-semibold text-red-600 dark:text-red-400">{rowErr[t.id]}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
