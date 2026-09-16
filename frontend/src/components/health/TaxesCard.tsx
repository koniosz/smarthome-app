// „Podatki”: VAT do zapłaty (szacunek), CIT (szacunek YTD / zapłacono / do dopłaty), ZUS + notka
import { Landmark } from 'lucide-react'
import type { HealthTaxes } from '../../api/health'
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

export default function TaxesCard({ taxes, yearLabel }: { taxes: HealthTaxes; yearLabel: string }) {
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
        <Row label="Składki ZUS w okresie" value={taxes.zus} hint="składki pracodawcy zapłacone z konta" />
      </div>
      <Hint>{taxes.note || 'Szacunek — ostateczne kwoty liczy księgowa.'}</Hint>
    </Card>
  )
}
