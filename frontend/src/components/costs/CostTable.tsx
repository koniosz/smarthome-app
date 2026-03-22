import { useRef, useState } from 'react'
import type { CostItem } from '../../types'
import { COST_CATEGORY_LABELS } from '../../types'
import { costsApi, attachmentsApi } from '../../api/client'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

interface Props {
  items: CostItem[]
  onDeleted: (id: string) => void
  onUpdated?: (item: CostItem) => void
}

const CAT_COLORS: Record<string, string> = {
  materials: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  subcontractor: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  other: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}

function AttachmentCell({ item, onUpdated }: { item: CostItem; onUpdated?: (i: CostItem) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState(false)

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const updated = await attachmentsApi.upload(item.id, file)
      onUpdated?.(updated)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDeleteAttachment = async () => {
    if (!confirm('Usunąć załącznik?')) return
    await attachmentsApi.delete(item.id)
    onUpdated?.({ ...item, attachment_filename: null, attachment_original: null })
  }

  if (item.attachment_filename) {
    const url = attachmentsApi.url(item.attachment_filename)
    const isPdf = item.attachment_original?.toLowerCase().endsWith('.pdf')
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={() => setPreview(true)}
          className="text-xs text-violet-600 dark:text-violet-400 hover:underline flex items-center gap-1"
          title={item.attachment_original ?? ''}
        >
          {isPdf ? '📄' : '🖼'} Podgląd
        </button>
        <button
          onClick={handleDeleteAttachment}
          className="text-xs text-red-400 hover:text-red-600 ml-1"
          title="Usuń załącznik"
        >
          ✕
        </button>

        {preview && (
          <div
            className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            onClick={() => setPreview(false)}
          >
            <div
              className="relative bg-white dark:bg-gray-900 rounded-xl overflow-hidden max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                  {item.attachment_original}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <a
                    href={url}
                    download={item.attachment_original ?? 'attachment'}
                    className="px-3 py-1 text-xs font-medium border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                    onClick={e => e.stopPropagation()}
                  >
                    ⬇ Pobierz
                  </a>
                  <button
                    onClick={() => setPreview(false)}
                    className="p-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-2 flex items-center justify-center bg-gray-50 dark:bg-gray-950 min-h-[200px]">
                {isPdf ? (
                  <iframe
                    src={url}
                    className="w-full h-[70vh] border-0 rounded"
                    title={item.attachment_original ?? 'PDF'}
                  />
                ) : (
                  <img
                    src={url}
                    alt={item.attachment_original ?? ''}
                    className="max-w-full max-h-[70vh] object-contain rounded"
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="text-xs text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:opacity-50"
        title="Dodaj załącznik (faktura, paragon)"
      >
        {uploading ? '⏳' : '📎'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp,.heic"
        className="hidden"
        onChange={handleUpload}
      />
    </>
  )
}

export default function CostTable({ items, onDeleted, onUpdated }: Props) {
  const [localItems, setLocalItems] = useState<CostItem[]>(items)

  // Sync when parent adds new items
  const ids = items.map(i => i.id).join(',')
  const localIds = localItems.map(i => i.id).join(',')
  if (ids !== localIds) {
    setLocalItems(items)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Usunąć tę pozycję?')) return
    await costsApi.delete(id)
    setLocalItems(prev => prev.filter(i => i.id !== id))
    onDeleted(id)
  }

  const handleUpdated = (updated: CostItem) => {
    setLocalItems(prev => prev.map(i => i.id === updated.id ? updated : i))
    onUpdated?.(updated)
  }

  if (localItems.length === 0) {
    return <div className="text-sm text-gray-400 py-6 text-center">Brak kosztów. Kliknij "Dodaj koszt".</div>
  }

  const total = localItems.reduce((s, i) => s + i.total_price, 0)

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
            <th className="text-left py-2 pr-3">Data</th>
            <th className="text-left py-2 pr-3">Kategoria</th>
            <th className="text-left py-2 pr-3">Opis</th>
            <th className="text-right py-2 pr-3">Ilość</th>
            <th className="text-right py-2 pr-3">Cena j.</th>
            <th className="text-right py-2 pr-3">Razem</th>
            <th className="text-center py-2 pr-3">Fak.</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {localItems.map(item => (
            <tr key={item.id} className="group border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40">
              <td className="py-2 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{item.date}</td>
              <td className="py-2 pr-3">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${CAT_COLORS[item.category]}`}>
                  {COST_CATEGORY_LABELS[item.category]}
                </span>
              </td>
              <td className="py-2 pr-3 text-gray-800 dark:text-gray-100">
                <div>{item.description}</div>
                {item.supplier && <div className="text-xs text-gray-400">{item.supplier}{item.invoice_number ? ` · ${item.invoice_number}` : ''}</div>}
              </td>
              <td className="py-2 pr-3 text-right text-gray-600 dark:text-gray-400">{item.quantity}</td>
              <td className="py-2 pr-3 text-right text-gray-600 dark:text-gray-400">{fmt(item.unit_price)}</td>
              <td className="py-2 pr-3 text-right font-medium text-gray-800 dark:text-gray-100">{fmt(item.total_price)}</td>
              <td className="py-2 pr-3 text-center">
                <AttachmentCell item={item} onUpdated={handleUpdated} />
              </td>
              <td className="py-2">
                <button
                  onClick={() => handleDelete(item.id)}
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
            <td colSpan={5} className="pt-2 pr-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Suma:</td>
            <td className="pt-2 pr-3 text-right font-bold text-gray-800 dark:text-gray-100">{fmt(total)}</td>
            <td colSpan={2}></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
