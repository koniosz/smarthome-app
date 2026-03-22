import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { projectsApi } from '../../api/client'
import type { Project } from '../../types'
import { PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '../../types'

function highlight(text: string, query: string) {
  if (!query.trim()) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-violet-200 dark:bg-violet-800/60 text-inherit rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export default function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [allProjects, setAllProjects] = useState<Project[]>([])
  const [results, setResults] = useState<Project[]>([])
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const loadProjects = useCallback(() => {
    projectsApi.list().then(setAllProjects).catch(() => {})
  }, [])

  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q) { setResults([]); return }
    const filtered = allProjects.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.client_name.toLowerCase().includes(q) ||
      (p.description && p.description.toLowerCase().includes(q))
    ).slice(0, 8)
    setResults(filtered)
    setActiveIdx(-1)
  }, [query, allProjects])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Keyboard shortcut: Cmd/Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const select = (project: Project) => {
    navigate(`/projects/${project.id}`)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setQuery('')
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      select(results[activeIdx])
    }
  }

  const showDropdown = open && query.trim().length > 0

  return (
    <div ref={containerRef} className="relative">
      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
        open
          ? 'border-violet-400 dark:border-violet-600 bg-white dark:bg-gray-800'
          : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50'
      }`}>
        <span className="text-gray-400 text-sm flex-shrink-0 select-none">🔍</span>
        <input
          ref={inputRef}
          type="text"
          placeholder="Szukaj…"
          value={query}
          className="bg-transparent w-44 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 outline-none"
          onFocus={() => { setOpen(true); loadProjects() }}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onKeyDown={handleKeyDown}
        />
        {query ? (
          <button
            onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus() }}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0 text-xs"
          >✕</button>
        ) : (
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 flex-shrink-0 border border-gray-200 dark:border-gray-600">
            ⌘K
          </kbd>
        )}
      </div>

      {showDropdown && (
        <div className="absolute top-full right-0 mt-1 w-96 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          {results.length > 0 ? (
            <>
              <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                {results.length} {results.length === 1 ? 'wynik' : 'wyniki/ów'}
              </div>
              {results.map((p, i) => {
                const marginColor = p.margin_pct == null ? 'text-gray-400'
                  : p.margin_pct < 0 ? 'text-red-500 dark:text-red-400'
                  : p.margin_pct < 10 ? 'text-orange-500 dark:text-orange-400'
                  : p.margin_pct < 25 ? 'text-yellow-600 dark:text-yellow-400'
                  : 'text-green-600 dark:text-green-400'
                return (
                  <button
                    key={p.id}
                    onClick={() => select(p)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors border-b border-gray-50 dark:border-gray-800 last:border-0 ${
                      i === activeIdx
                        ? 'bg-violet-50 dark:bg-violet-950/30'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                        {highlight(p.name, query.trim())}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {p.client_name && (
                          <span className="text-xs text-gray-400 truncate">
                            👤 {highlight(p.client_name, query.trim())}
                          </span>
                        )}
                        <span className="text-xs text-gray-300 dark:text-gray-600">·</span>
                        <span className="text-xs text-gray-400">
                          {PROJECT_TYPE_LABELS[p.project_type]}
                        </span>
                        <span className="text-xs text-gray-300 dark:text-gray-600">·</span>
                        <span className="text-xs text-gray-400">
                          {PROJECT_STATUS_LABELS[p.status]}
                        </span>
                      </div>
                    </div>
                    {p.margin_pct != null && (
                      <span className={`text-sm font-bold flex-shrink-0 ${marginColor}`}>
                        {p.margin_pct.toFixed(0)}%
                      </span>
                    )}
                    <span className="text-gray-300 dark:text-gray-600 flex-shrink-0">→</span>
                  </button>
                )
              })}
              <div className="px-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3 text-xs text-gray-400">
                <span><kbd className="font-mono">↑↓</kbd> nawigacja</span>
                <span><kbd className="font-mono">↵</kbd> otwórz</span>
                <span><kbd className="font-mono">Esc</kbd> zamknij</span>
              </div>
            </>
          ) : (
            <div className="px-4 py-4 text-sm text-gray-400 text-center">
              Brak wyników dla „{query}"
            </div>
          )}
        </div>
      )}
    </div>
  )
}
