import type { Project } from '../../types'

interface NewProjectDialogProps {
  onClose: () => void
  onCreated: (project: Project) => void
  onOpenWizard: () => void
  onOpenAI: () => void
}

export default function NewProjectDialog({ onClose, onOpenWizard, onOpenAI }: NewProjectDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg p-8 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl font-bold"
        >×</button>

        <div className="text-center mb-8">
          <div className="text-3xl mb-2">🏠</div>
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">Nowy projekt</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Jak chcesz stworzyć projekt?</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Kreator */}
          <button
            onClick={onOpenWizard}
            className="group flex flex-col items-center gap-3 p-6 rounded-2xl border-2 border-gray-200 dark:border-gray-700 hover:border-violet-400 dark:hover:border-violet-500 hover:bg-violet-50 dark:hover:bg-violet-950/20 transition-all text-left"
          >
            <div className="w-14 h-14 rounded-2xl bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">
              🧙‍♂️
            </div>
            <div>
              <div className="font-semibold text-gray-800 dark:text-gray-100 text-sm">Kreator projektu</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
                Krok po kroku — dane inwestora, systemy, struktura domu i dobór urządzeń z katalogu.
              </div>
            </div>
            <div className="mt-auto w-full pt-3 border-t border-gray-100 dark:border-gray-800 text-xs text-violet-600 dark:text-violet-400 font-medium">
              Polecane → pełna kontrola
            </div>
          </button>

          {/* AI */}
          <button
            onClick={onOpenAI}
            className="group flex flex-col items-center gap-3 p-6 rounded-2xl border-2 border-gray-200 dark:border-gray-700 hover:border-amber-400 dark:hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/20 transition-all text-left"
          >
            <div className="w-14 h-14 rounded-2xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">
              🤖
            </div>
            <div>
              <div className="font-semibold text-gray-800 dark:text-gray-100 text-sm">Wycena AI</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
                Wgraj rzut PDF/JPG lub plik Excel — AI automatycznie wykryje pomieszczenia i dobierze urządzenia.
              </div>
            </div>
            <div className="mt-auto w-full pt-3 border-t border-gray-100 dark:border-gray-800 text-xs text-amber-600 dark:text-amber-400 font-medium">
              Szybko → na podstawie rzutu
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}
