import type { LaborEntry } from '../../types'
import { laborApi } from '../../api/client'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

interface Props {
  entries: LaborEntry[]
  onDeleted: (id: string) => void
  isAdmin?: boolean
}

export default function LaborTable({ entries, onDeleted, isAdmin = true }: Props) {
  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć ten wpis?')) return
    await laborApi.delete(id)
    onDeleted(id)
  }

  if (entries.length === 0) {
    return <div className="text-sm text-gray-400 py-6 text-center">Brak wpisów. Kliknij "Dodaj robociznę".</div>
  }

  const totalHours = entries.reduce((s, e) => s + e.hours, 0)
  const totalCost = entries.reduce((s, e) => s + e.hours * e.hourly_rate, 0)

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
            <th className="text-left py-2 pr-3">Data</th>
            <th className="text-left py-2 pr-3">Pracownik</th>
            <th className="text-left py-2 pr-3">Opis</th>
            <th className="text-right py-2 pr-3">Godz.</th>
            {isAdmin && <th className="text-right py-2 pr-3">Stawka</th>}
            {isAdmin && <th className="text-right py-2 pr-3">Razem</th>}
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(entry => (
            <tr key={entry.id} className="group border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40">
              <td className="py-2 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{entry.date}</td>
              <td className="py-2 pr-3 font-medium text-gray-800 dark:text-gray-100">{entry.worker_name}</td>
              <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{entry.description || '—'}</td>
              <td className="py-2 pr-3 text-right text-gray-700 dark:text-gray-300">{entry.hours}h</td>
              {isAdmin && <td className="py-2 pr-3 text-right text-gray-600 dark:text-gray-400">{fmt(entry.hourly_rate)}/h</td>}
              {isAdmin && (
                <td className="py-2 pr-3 text-right font-medium text-gray-800 dark:text-gray-100">
                  {fmt(entry.hours * entry.hourly_rate)}
                </td>
              )}
              <td className="py-2">
                <button
                  onClick={() => handleDelete(entry.id)}
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
            <td colSpan={3} className="pt-2 pr-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Suma:</td>
            <td className="pt-2 pr-3 text-right font-bold text-gray-800 dark:text-gray-100">{totalHours}h</td>
            {isAdmin && <td></td>}
            {isAdmin && <td className="pt-2 pr-3 text-right font-bold text-gray-800 dark:text-gray-100">{fmt(totalCost)}</td>}
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
