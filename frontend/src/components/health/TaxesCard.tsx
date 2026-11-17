// „Podatki”: VAT do zapłaty (szacunek), CIT (szacunek YTD / zapłacono / do dopłaty), ZUS + notka
// ZUS: to samo, co wiersz „ZUS” karty „Koszty pracy” na tej stronie — składki pracownika i pracodawcy przypisane
// do miesięcy, których dotyczą (nie do dnia przelewu). Tu są SAME przelewy (taxes.zus), tam dochodzi szacunek
// za miesiące, za które przelewu jeszcze nie było — różnicę objaśnia podpowiedź pod wierszem.
import { Landmark } from 'lucide-react'
import type { HealthTaxes, HealthPayroll } from '../../api/health'
import { money0 } from './format'
import { Card, Hint } from './ui'

function Row({ label, value, hint, bold, tone }: { label: string; value: number; hint?: string; bold?: boolean; tone?: 'red' | 'green' }) {
  const cls = tone === 'red' ? 'text-red-600 dark:text-red-400' : tone === 'green' ? 'text-green-700 dark:text-green-400' : 'text-gray-800 dark:text-gray-100'
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-gray-50 dark:border-gray-800/60 last:border-0">
      <div className="min-w-0">
        <div className={`text-sm ${bold ? 'font-bold text-gray-800 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'}`}>{label}</div>
        {hint && <div className="text-[11px] text-gray-400 leading-snug">{hint}</div>}
      </div>
      <div className={`text-sm tabular-nums whitespace-nowrap ${bold ? 'font-bold' : 'font-semibold'} ${cls}`}>{money0(value)}</div>
    </div>
  )
}

const ZUS_HINT = 'składki pracownika i pracodawcy; liczone za miesiąc, którego dotyczą (nie w dniu przelewu)'

/**
 * Podpowiedź pod wierszem ZUS — tak, żeby ta kwota i „ZUS” w karcie „Koszty pracy” nie wyglądały na dwie różne
 * liczby bez wyjaśnienia. `payroll` jest opcjonalne (strona może go nie przekazać, starszy backend go nie zwraca):
 *  - znamy szacunek > 0   → mówimy wprost, o ile tamta karta pokazuje więcej i dlaczego,
 *  - kwoty są równe       → mówimy, że to ta sama kwota,
 *  - nie znamy            → ogólne zdanie, że tamta karta może doliczać szacunek.
 */
function zusHint(zus: number, payroll?: HealthPayroll | null): string {
  if (!payroll) return `${ZUS_HINT}. „Koszty pracy” mogą pokazywać więcej — doliczają szacunek za miesiące, za które przelewu jeszcze nie było.`
  const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0)
  const estimate = Math.max(0, n(payroll.zus_estimate))
  if (estimate >= 0.5) return `${ZUS_HINT}. W „Kosztach pracy” ZUS jest o ${money0(estimate)} wyższy — tam doliczony jest szacunek za miesiące, za które przelewu jeszcze nie było.`
  if (Math.abs(n(payroll.zus) - n(zus)) < 1) return `${ZUS_HINT}. Ta sama kwota co ZUS w „Kosztach pracy”.`
  return ZUS_HINT
}

export default function TaxesCard({ taxes, yearLabel, payroll }: {
  taxes: HealthTaxes
  yearLabel: string
  /** Koszty pracy tego samego okresu (HealthResponse.payroll) — tylko do objaśnienia różnicy przy ZUS; opcjonalne */
  payroll?: HealthPayroll | null
}) {
  const vatDue = taxes.vat_due_estimate
  return (
    <Card title="Podatki" subtitle="Ile mniej więcej trzeba odłożyć — żeby urząd nie zaskoczył."
      right={<Landmark size={16} className="text-gray-300 dark:text-gray-600" />}>
      <div className="mb-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">VAT za okres</div>
        <Row label="VAT należny (ze sprzedaży)" value={taxes.vat_output} hint="VAT z faktur, które wystawiliście" />
        <Row label="VAT naliczony (z zakupów)" value={taxes.vat_input} hint="VAT z faktur kosztowych w KSeF — do odliczenia" />
        <Row label={vatDue >= 0 ? 'VAT do zapłaty (szacunek)' : 'VAT do zwrotu (szacunek)'} value={Math.abs(vatDue)} bold tone={vatDue > 0 ? 'red' : 'green'}
          hint="należny − naliczony; VAT nie jest kosztem firmy — tylko przepływa przez konto" />
      </div>
      <div className="mb-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">CIT narastająco od stycznia {yearLabel}</div>
        <Row label={`Podstawa opodatkowania (stawka ${taxes.cit_rate} %)`} value={taxes.cit_base_ytd} hint="zysk od początku roku, od którego liczy się podatek" />
        <Row label="CIT należny — szacunek" value={taxes.cit_estimate_ytd} />
        <Row label="Zapłacone zaliczki CIT" value={taxes.cit_paid_ytd} hint="przelewy do urzędu z wyciągu (kategoria „podatek dochodowy”)" />
        <Row label="Do dopłaty (szacunek)" value={taxes.cit_to_pay_estimate} bold tone={taxes.cit_to_pay_estimate > 0 ? 'red' : 'green'} />
      </div>
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">ZUS</div>
        <Row label="ZUS zapłacony za ten okres" value={taxes.zus} hint={zusHint(taxes.zus, payroll)} />
      </div>
      <Hint>{taxes.note || 'Szacunek — ostateczne kwoty liczy księgowa.'}</Hint>
    </Card>
  )
}
