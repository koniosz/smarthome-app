// 4 kafle: Przychód · Koszty · Zysk (EBITDA) · Gotówka na koncie — każdy z jednym zdaniem „co to znaczy”
import { useNavigate } from 'react-router-dom'
import { TrendingUp, Receipt, PiggyBank, Wallet } from 'lucide-react'
import type { HealthResponse } from '../../api/health'
import { money0, pct1, fmtDate } from './format'
import { Hint } from './ui'

export default function Tiles({ data }: { data: HealthResponse }) {
  const navigate = useNavigate()
  const t = data.tiles
  // Konta walutowe nie wchodzą do kafla (tylko PLN) — mówimy o tym wprost, żeby „—” nie wyglądało jak brak wyciągu
  const foreignCurrencies = [...new Set((data.cash?.balances ?? []).map(b => b.currency).filter(c => c && c !== 'PLN'))]
  const tileCls ='bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 flex flex-col'
  const labelCls = 'text-xs font-semibold uppercase tracking-wide text-gray-400 inline-flex items-center gap-1.5'

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div className={tileCls}>
        <div className={labelCls}><TrendingUp size={13} /> Przychód</div>
        <div className="text-xl font-bold mt-1 text-gray-800 dark:text-gray-100 tabular-nums">{money0(t.revenue)}</div>
        <Hint>Ile sprzedaliście w tym okresie (netto, bez VAT).{data.lines.provisional && <> <span className="text-amber-600 dark:text-amber-400 font-semibold">Wstępnie</span> — brak importu Firmao.</>}</Hint>
      </div>

      <div className={tileCls}>
        <div className={labelCls}><Receipt size={13} /> Koszty</div>
        <div className="text-xl font-bold mt-1 text-gray-800 dark:text-gray-100 tabular-nums">{money0(t.costs)}</div>
        <Hint>Wszystko, co firma wydała, żeby to sprzedać: towar, pensje, biuro, auta, amortyzacja, odsetki. Bez podatku CIT.</Hint>
      </div>

      <div className={tileCls}>
        <div className={labelCls}><PiggyBank size={13} /> Zysk (EBITDA)</div>
        <div className={`text-xl font-bold mt-1 tabular-nums ${t.ebitda < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>
          {money0(t.ebitda)} <span className="text-sm font-semibold text-gray-400">· {pct1(t.ebitda_pct)}</span>
        </div>
        <Hint>Czy biznes sam z siebie zarabia — bez amortyzacji, odsetek i podatku. Procent = marża z każdej złotówki sprzedaży.</Hint>
      </div>

      <div className={tileCls}>
        <div className={labelCls}><Wallet size={13} /> Gotówka na koncie</div>
        {t.cash === null ? (
          <>
            <div className="text-xl font-bold mt-1 text-gray-400">—</div>
            <Hint>
              Brak salda PLN.{' '}
              <button onClick={() => navigate('/platnosci')} className="text-violet-600 dark:text-violet-400 font-semibold hover:underline">Wgraj wyciąg MT940 →</button>
              {foreignCurrencies.length > 0 && <> Salda w {foreignCurrencies.join(', ')} nie są wliczane.</>}
            </Hint>
          </>
        ) : (
          <>
            <div className={`text-xl font-bold mt-1 tabular-nums ${t.cash < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{money0(t.cash)}</div>
            <Hint>Stan kont PLN z ostatniego wyciągu ({fmtDate(t.cash_date)}) — realne pieniądze, nie zysk „na papierze”.</Hint>
          </>
        )}
      </div>
    </div>
  )
}
