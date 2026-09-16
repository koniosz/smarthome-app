// Drobne, wspólne elementy UI strony „Kondycja firmy” (karty, modale, style pól)
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export const inputCls = 'px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full disabled:opacity-60'
export const btnPrimary = 'inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold disabled:opacity-60'
export const btnSecondary = 'inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60'
export const btnGhost = 'px-3 py-2.5 rounded-lg text-sm font-semibold text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30'

export function Card({ title, subtitle, right, children, className = '' }: {
  title?: string; subtitle?: string; right?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <div className={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden ${className}`}>
      {(title || right) && (
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <div>
            {title && <div className="text-sm font-bold text-gray-800 dark:text-gray-100">{title}</div>}
            {subtitle && <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  )
}

export function ModalShell({ title, subtitle, onClose, children, width = 'max-w-lg' }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; width?: string
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full ${width} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900 z-10">
          <div>
            <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">{title}</h2>
            {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" aria-label="Zamknij"><X size={18} /></button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">{children}</div>
}
export function InfoBox({ children }: { children: ReactNode }) {
  return <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300">{children}</div>
}
export function OkBox({ children }: { children: ReactNode }) {
  return <div className="p-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-300">{children}</div>
}

/** Skrót „co to znaczy” pod liczbą — wszędzie ten sam wygląd */
export function Hint({ children }: { children: ReactNode }) {
  return <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 leading-snug">{children}</div>
}
