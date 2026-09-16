// Magazyn: wartość zapasów na koniec okresu i zmiana w okresie (z GET /finance/inventory)
import { Package } from 'lucide-react'
import type { InventoryResponse } from '../../api/health'
import { money0, fmtDate } from './format'
import { Card, Hint } from './ui'

// inPnl: CompanySettings.inventory_in_pnl — true: zmiana stanu koryguje koszt sprzedaży w kaflach/RZiS; false: kafle i RZiS
// liczą pełne zakupy (zmiana stanu tylko informacyjnie); undefined: nieznane (nie twierdź, że koszt jest mniejszy/większy).
export default function InventoryCard({ inv, range, inPnl }: { inv: InventoryResponse; range: { from: string; to: string }; inPnl?: boolean }) {
  const inRange = inv.months.filter(m => m.period >= range.from && m.period <= range.to)
  const last = inRange[inRange.length - 1]
  const change = inRange.reduce((s, m) => s + m.change, 0)
  const unpriced = last?.unpriced_items ?? 0
  const subtitle = inPnl === false
    ? 'Towar na półce to zamrożona gotówka. W RZiS zakupy liczone są w całości jako koszt (zmiana stanu magazynu wyłączona w ustawieniach).'
    : 'Towar na półce to zamrożona gotówka — a nie koszt, dopóki go nie sprzedacie.'
  const changeText = change > 0
    ? (inPnl === true ? 'Magazyn urósł → część zakupów nie jest jeszcze kosztem (koszt sprzedaży mniejszy).' : 'Magazyn urósł → część zakupów została na półce.')
    : change < 0
      ? (inPnl === true ? 'Magazyn zmalał → sprzedaliście towar kupiony wcześniej (koszt sprzedaży większy).' : 'Magazyn zmalał → sprzedaliście towar kupiony wcześniej.')
      : 'Stan magazynu bez zmian.'
  return (
    <Card title="Magazyn" subtitle={subtitle}
      right={<Package size={16} className="text-gray-300 dark:text-gray-600" />}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Wartość na koniec okresu</div>
          <div className="text-lg font-bold tabular-nums text-gray-800 dark:text-gray-100">{last ? money0(last.value) : '—'}</div>
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Zmiana w okresie</div>
          <div className={`text-lg font-bold tabular-nums ${change > 0 ? 'text-blue-600 dark:text-blue-400' : change < 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-800 dark:text-gray-100'}`}>
            {change > 0 ? '+' : ''}{money0(change)}
          </div>
        </div>
      </div>
      <Hint>
        {changeText}
        {inPnl === false && <> <span className="text-amber-600 dark:text-amber-400 font-semibold">Zmiana stanu nie jest liczona w RZiS</span> (ustawienia raportu) — kafle Koszty/EBITDA liczą pełne zakupy.</>}
        {unpriced > 0 && <> ⚠ {unpriced} poz. bez ceny zakupu — wartość zaniżona.</>}
        {' '}Dziś: {money0(inv.current_value)} ({fmtDate(inv.as_of)}).
      </Hint>
    </Card>
  )
}
