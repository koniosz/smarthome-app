import type { ClientPayment } from '../../types'
import { PAYMENT_TYPE_LABELS } from '../../types'
import { paymentsApi } from '../../api/client'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

interface Props {
  payments: ClientPayment[]
  onDeleted: (id: string) => void
}

export default function PaymentTable({ payments, onDeleted }: Props) {
  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć tę płatność?')) return
    await paymentsApi.delete(id)
    onDeleted(id)
  }

  if (payments.length === 0) {
    return <div className="text-sm text-gray-400 py-6 text-center">Brak płatności. Kliknij "+ Dodaj płatność".</div>
  }

  const total = payments.reduce((s, p) => s + p.amount, 0)

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
            <th className="text-left py-2 pr-3">Data</th>
            <th className="text-left py-2 pr-3">Typ</th>
            <th className="text-left py-2 pr-3">Opis</th>
            <th className="text-left py-2 pr-3">Nr faktury</th>
            <th className="text-right py-2 pr-3">Kwota</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {payments.map(payment => (
            <tr key={payment.id} className="group border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40">
              <td className="py-2 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{payment.date}</td>
              <td className="py-2 pr-3">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  payment.payment_type === 'additional_works'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                }`}>
                  {PAYMENT_TYPE_LABELS[payment.payment_type]}
                </span>
              </td>
              <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{payment.description || '—'}</td>
              <td className="py-2 pr-3 text-gray-500 dark:text-gray-400 font-mono text-xs">{payment.invoice_number || '—'}</td>
              <td className="py-2 pr-3 text-right font-medium text-green-700 dark:text-green-400">
                +{fmt(payment.amount)}
              </td>
              <td className="py-2">
                <button
                  onClick={() => handleDelete(payment.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 rounded transition-all"
                  title="Usuń"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-200 dark:border-gray-700">
            <td colSpan={4} className="pt-2 pr-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Suma wpłat:</td>
            <td className="pt-2 pr-3 text-right font-bold text-green-700 dark:text-green-400">+{fmt(total)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
