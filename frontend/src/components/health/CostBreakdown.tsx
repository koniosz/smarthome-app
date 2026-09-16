// „Na co idą pieniądze”: poziome paski top 6 podkategorii + Pozostałe
import type { HealthCostItem } from '../../api/health'
import { money0 } from './format'
import { Card, Hint } from './ui'

/** Klucz kubełka „Pozostałe” z backendu (finance-health.ts costBreakdown) — celowo różny od realnej podkategorii 'other' („Inne / nierozpoznane”) */
const REST_KEY = '__other'

export default function CostBreakdown({ items, total }: { items: HealthCostItem[]; total: number }) {
  const maxPct = Math.max(1, ...items.map(i => i.pct))
  // Procenty z backendu liczone są względem sumy pozycji podziału (KSeF netto + przelewy/dokumenty w RZiS),
  // bez amortyzacji i zmiany stanu magazynu — więc „Razem” musi być tą samą sumą, a nie tiles.costs (koszty RZiS).
  const sum = items.reduce((s, i) => s + (Number(i.amount) || 0), 0)
  return (
    <Card title="Na co idą pieniądze" subtitle={`Największe grupy kosztów w okresie (netto). Razem: ${money0(sum)} (koszty okresu w RZiS: ${money0(total)}).`}>
      {items.length === 0 ? (
        <div className="text-sm text-gray-400">Brak kosztów w tym okresie.</div>
      ) : (
        <div className="space-y-2.5">
          {items.map((it, i) => {
            const other = it.key === REST_KEY
            return (
              <div key={`${it.key}-${i}`}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className={`truncate ${other ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200'}`} title={it.label}>{it.label}</span>
                  <span className="tabular-nums whitespace-nowrap">
                    <b className="text-gray-800 dark:text-gray-100">{money0(it.amount)}</b>
                    <span className="text-xs text-gray-400 ml-1.5 inline-block w-11 text-right">{Math.round(it.pct)} %</span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-800 mt-1 overflow-hidden">
                  <div className={`h-full rounded-full ${other ? 'bg-gray-300 dark:bg-gray-600' : 'bg-violet-500 dark:bg-violet-400'}`}
                    style={{ width: `${Math.max(1.5, (it.pct / maxPct) * 100)}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
      <Hint>Procent = udział w sumie pozycji podziału ({money0(sum)}) — bez amortyzacji i zmiany stanu magazynu, które wchodzą tylko do kosztów RZiS. Faktury KSeF liczone z alokacji (netto), przelewy z wyciągu — tylko te, które wchodzą do RZiS.</Hint>
    </Card>
  )
}
