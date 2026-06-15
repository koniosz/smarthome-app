import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { tasksApi, employeesApi, projectsApi } from '../../api/client'
import type { Task, TaskType, Employee, Project } from '../../types'
import { TASK_TYPE_LABELS } from '../../types'

// ─── helpers ──────────────────────────────────────────────────────────────────
const FONT = "'IBM Plex Sans', sans-serif"

const TYPE_META: Record<TaskType, { chipBg: string; chipFg: string; dot: string }> = {
  work:  { chipBg: '#eff6ff', chipFg: '#1d4ed8', dot: '#2563eb' },
  event: { chipBg: '#f5f3ff', chipFg: '#6d28d9', dot: '#7c3aed' },
  task:  { chipBg: '#fffbeb', chipFg: '#b45309', dot: '#f59e0b' },
}

const AVATAR_COLORS = ['#7c3aed', '#2563eb', '#0d9488', '#b45309']

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function timeRange(t: Task): string {
  if (!t.time) return '—'
  return t.end_time ? `${t.time}–${t.end_time}` : t.time
}

function initialsOf(name: string): string {
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
}

function employeeColor(employees: Employee[], id: string | null | undefined): string {
  if (!id) return '#94a3b8'
  const idx = employees.findIndex(e => e.id === id)
  return idx >= 0 ? AVATAR_COLORS[idx % AVATAR_COLORS.length] : '#94a3b8'
}

function assigneeIdsOf(task: Task): string[] {
  return (task.assignees ?? []).map(a => a.employee_id)
}

// ─── Stos awatarów + dropdown wielokrotnego wyboru ────────────────────────────
function AssigneeAvatars({
  task, employees, size, onToggle,
}: {
  task: Task
  employees: Employee[]
  size: number
  onToggle: (taskId: string, employeeId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const assigned = task.assignees ?? []
  const assignedIds = assigneeIdsOf(task)
  const shown = assigned.slice(0, 3)
  const extra = assigned.length - shown.length
  const overlap = Math.round(size * 0.32)

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <div
        onClick={() => setOpen(o => !o)}
        title={assigned.length ? assigned.map(a => a.employee?.name).filter(Boolean).join(', ') : 'Nieprzypisane'}
        style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}
      >
        {assigned.length === 0 ? (
          <div style={{
            width: size, height: size, borderRadius: '50%',
            border: '1.5px dashed #cbd5e1', color: '#94a3b8',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Plus size={size >= 30 ? 15 : 12} />
          </div>
        ) : (
          shown.map((a, i) => (
            <div
              key={a.id}
              style={{
                width: size, height: size, borderRadius: '50%',
                background: employeeColor(employees, a.employee_id), color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: size >= 30 ? 11 : 10, fontWeight: 700,
                boxShadow: '0 0 0 2px #ffffff, 0 0 0 3px #e2e8f0',
                marginLeft: i === 0 ? 0 : -overlap, position: 'relative', zIndex: 10 - i,
              }}
            >
              {a.employee ? initialsOf(a.employee.name) : '?'}
            </div>
          ))
        )}
        {extra > 0 && (
          <div style={{
            width: size, height: size, borderRadius: '50%',
            background: '#e2e8f0', color: '#475569',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: size >= 30 ? 11 : 10, fontWeight: 700,
            boxShadow: '0 0 0 2px #ffffff, 0 0 0 3px #e2e8f0',
            marginLeft: -overlap, position: 'relative', zIndex: 1,
          }}>
            +{extra}
          </div>
        )}
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: size + 8, right: 0, zIndex: 30,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
          boxShadow: '0 8px 24px rgba(15,23,42,0.14)', padding: 6,
          display: 'flex', flexDirection: 'column', gap: 2, width: 230,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
            textTransform: 'uppercase', color: '#94a3b8', padding: '6px 10px 4px',
          }}>
            Przypisani pracownicy
          </div>
          {employees.map((e, i) => {
            const active = assignedIds.includes(e.id)
            return (
              <div
                key={e.id}
                onClick={() => onToggle(task.id, e.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 10px', borderRadius: 7, cursor: 'pointer',
                  background: active ? '#eff6ff' : 'transparent',
                }}
                onMouseEnter={ev => { if (!active) (ev.currentTarget as HTMLDivElement).style.background = '#f1f5f9' }}
                onMouseLeave={ev => { (ev.currentTarget as HTMLDivElement).style.background = active ? '#eff6ff' : 'transparent' }}
              >
                <span style={{
                  width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                  border: `1.5px solid ${active ? '#2563eb' : '#cbd5e1'}`,
                  background: active ? '#2563eb' : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {active && <Check size={11} color="#fff" strokeWidth={3.5} />}
                </span>
                <span style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: AVATAR_COLORS[i % AVATAR_COLORS.length], color: '#fff',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, flexShrink: 0,
                }}>
                  {initialsOf(e.name)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Checkbox ─────────────────────────────────────────────────────────────────
function TaskCheckbox({ done, size, onToggle }: { done: boolean; size: number; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      style={{
        width: size, height: size, borderRadius: size >= 20 ? 6 : 5,
        border: `1.5px solid ${done ? '#2563eb' : '#cbd5e1'}`,
        background: done ? '#2563eb' : '#fff',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {done && <Check size={size - 8} color="#fff" strokeWidth={3.5} />}
    </div>
  )
}

// ─── New task modal ───────────────────────────────────────────────────────────
function NewTaskModal({
  defaultDate, projects, employees, onClose, onCreated,
}: {
  defaultDate: string
  projects: Project[]
  employees: Employee[]
  onClose: () => void
  onCreated: (task: Task) => void
}) {
  const [title, setTitle] = useState('')
  const [titleError, setTitleError] = useState(false)
  const [type, setType] = useState<TaskType>('work')
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '')
  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [assigneeIds, setAssigneeIds] = useState<string[]>(employees[0]?.id ? [employees[0].id] : [])
  const [saving, setSaving] = useState(false)

  const toggleAssignee = (id: string) =>
    setAssigneeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  // start przesunięty za koniec → koniec podąża (+1h)
  const handleStartChange = (v: string) => {
    setTime(v)
    if (v && (!endTime || endTime <= v)) {
      const [h, m] = v.split(':').map(Number)
      setEndTime(`${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '10px 14px', borderRadius: 8, border: '1px solid #e2e8f0',
    fontSize: 14, outline: 'none', color: '#0f172a', fontFamily: FONT, background: '#fff',
  }

  const handleSubmit = async () => {
    if (!title.trim()) { setTitleError(true); return }
    setSaving(true)
    try {
      const task = await tasksApi.create({
        title: title.trim(),
        type,
        project_id: projectId || null,
        date,
        time,
        end_time: endTime,
        assignee_ids: assigneeIds,
      })
      onCreated(task)
    } catch {
      alert('Nie udało się dodać zadania.')
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, width: 480, maxWidth: '100%',
          boxShadow: '0 24px 64px rgba(15,23,42,0.25)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Nowe zadanie</div>
          <div
            onClick={onClose}
            style={{
              width: 32, height: 32, borderRadius: 8, display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#f1f5f9' }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            <X size={17} />
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Tytuł */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Tytuł</label>
            <input
              value={title}
              onChange={e => { setTitle(e.target.value); setTitleError(false) }}
              placeholder="np. Montaż rozdzielnicy — parter"
              autoFocus
              style={{ ...inputStyle, border: `1px solid ${titleError ? '#ef4444' : '#e2e8f0'}` }}
              onFocus={e => { if (!titleError) { e.target.style.borderColor = '#2563eb'; e.target.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)' } }}
              onBlur={e => { e.target.style.borderColor = titleError ? '#ef4444' : '#e2e8f0'; e.target.style.boxShadow = 'none' }}
            />
            {titleError && (
              <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 500 }}>Podaj tytuł zadania</div>
            )}
          </div>

          {/* Typ */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Typ</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(Object.keys(TASK_TYPE_LABELS) as TaskType[]).map(t => {
                const active = type === t
                return (
                  <div
                    key={t}
                    onClick={() => setType(t)}
                    style={{
                      flex: 1, textAlign: 'center', padding: '9px 0', borderRadius: 8,
                      border: `1px solid ${active ? '#93c5fd' : '#e2e8f0'}`,
                      background: active ? '#eff6ff' : '#fff',
                      color: active ? '#1d4ed8' : '#475569',
                      fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {TASK_TYPE_LABELS[t]}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Projekt */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Projekt</label>
            <select value={projectId} onChange={e => setProjectId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">— bez projektu —</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Data + Godziny od–do */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Data</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...inputStyle, padding: '9px 12px' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Od</label>
              <input type="time" value={time} onChange={e => handleStartChange(e.target.value)} style={{ ...inputStyle, padding: '9px 12px' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Do</label>
              <input type="time" value={endTime} min={time} onChange={e => setEndTime(e.target.value)} style={{ ...inputStyle, padding: '9px 12px' }} />
            </div>
          </div>

          {/* Pracownicy — wielokrotny wybór */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>
              Przypisz do pracowników
              {assigneeIds.length > 0 && <span style={{ fontWeight: 400, color: '#94a3b8' }}> · wybrano {assigneeIds.length}</span>}
            </label>
            <div style={{
              border: '1px solid #e2e8f0', borderRadius: 8, padding: 4,
              maxHeight: 168, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              {employees.length === 0 && (
                <div style={{ fontSize: 13, color: '#94a3b8', padding: '8px 10px' }}>Brak pracowników</div>
              )}
              {employees.map((e, i) => {
                const active = assigneeIds.includes(e.id)
                return (
                  <div
                    key={e.id}
                    onClick={() => toggleAssignee(e.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', borderRadius: 7, cursor: 'pointer',
                      background: active ? '#eff6ff' : 'transparent',
                    }}
                    onMouseEnter={ev => { if (!active) (ev.currentTarget as HTMLDivElement).style.background = '#f8fafc' }}
                    onMouseLeave={ev => { (ev.currentTarget as HTMLDivElement).style.background = active ? '#eff6ff' : 'transparent' }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                      border: `1.5px solid ${active ? '#2563eb' : '#cbd5e1'}`,
                      background: active ? '#2563eb' : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {active && <Check size={11} color="#fff" strokeWidth={3.5} />}
                    </span>
                    <span style={{
                      width: 24, height: 24, borderRadius: '50%',
                      background: AVATAR_COLORS[i % AVATAR_COLORS.length], color: '#fff',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700, flexShrink: 0,
                    }}>
                      {initialsOf(e.name)}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{e.name}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 10,
          padding: '16px 24px', background: '#f8fafc', borderTop: '1px solid #f1f5f9',
        }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '10px 18px', borderRadius: 8, border: '1px solid #e2e8f0',
              background: '#fff', color: '#475569', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', fontFamily: FONT,
            }}
          >
            Anuluj
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            style={{
              padding: '10px 20px', borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
              fontFamily: FONT, opacity: saving ? 0.6 : 1,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1d4ed8' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#2563eb' }}
          >
            {saving ? 'Zapisuję…' : 'Dodaj zadanie'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main section ─────────────────────────────────────────────────────────────
export default function CalendarTasksSection({
  modalOpen, onModalClose, onRequestOpenModal, onUpcomingCount,
}: {
  modalOpen: boolean
  onModalClose: () => void
  onRequestOpenModal: () => void
  onUpcomingCount?: (n: number) => void
}) {
  const today = new Date()
  const todayIso = iso(today)

  const [tasks, setTasks] = useState<Task[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [viewMonth, setViewMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [selectedDate, setSelectedDate] = useState(todayIso)

  useEffect(() => {
    tasksApi.list().then(setTasks).catch(() => {})
    employeesApi.list().then(setEmployees).catch(() => {})
    projectsApi.list().then(setProjects).catch(() => {})
  }, [])

  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      const list = map.get(t.date) ?? []
      list.push(t)
      map.set(t.date, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.time.localeCompare(b.time))
    return map
  }, [tasks])

  // 3-day groups: today, tomorrow, day after
  const threeDays = useMemo(() => {
    return [0, 1, 2].map(offset => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
      const dIso = iso(d)
      const label = offset === 0 ? 'Dziś' : offset === 1 ? 'Jutro' : (() => {
        const name = d.toLocaleDateString('pl-PL', { weekday: 'long' })
        return name.charAt(0).toUpperCase() + name.slice(1)
      })()
      return {
        iso: dIso,
        label,
        dateLabel: d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }),
        tasks: tasksByDate.get(dIso) ?? [],
      }
    })
  }, [tasksByDate, todayIso]) // eslint-disable-line react-hooks/exhaustive-deps

  const upcomingCount = threeDays.reduce((s, g) => s + g.tasks.filter(t => !t.done).length, 0)

  useEffect(() => { onUpcomingCount?.(upcomingCount) }, [upcomingCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // Calendar grid (weeks starting Monday)
  const weeks = useMemo(() => {
    const y = viewMonth.getFullYear()
    const m = viewMonth.getMonth()
    const first = new Date(y, m, 1)
    const startOffset = (first.getDay() + 6) % 7 // Mon = 0
    const start = new Date(y, m, 1 - startOffset)
    const result: { date: Date; iso: string; inMonth: boolean }[][] = []
    const cursor = new Date(start)
    do {
      const week: { date: Date; iso: string; inMonth: boolean }[] = []
      for (let i = 0; i < 7; i++) {
        week.push({ date: new Date(cursor), iso: iso(cursor), inMonth: cursor.getMonth() === m })
        cursor.setDate(cursor.getDate() + 1)
      }
      result.push(week)
    } while (cursor.getMonth() === m)
    return result
  }, [viewMonth])

  const monthLabel = (() => {
    const l = viewMonth.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
    return l.charAt(0).toUpperCase() + l.slice(1)
  })()

  const selectedLabel = (() => {
    const [y, m, d] = selectedDate.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })
  })()

  const selectedTasks = tasksByDate.get(selectedDate) ?? []

  // ── mutations ──
  const toggleDone = async (task: Task) => {
    const updated = await tasksApi.update(task.id, { done: !task.done })
    setTasks(prev => prev.map(t => t.id === task.id ? updated : t))
  }

  // Przełącz przypisanie pracownika (dodaj/usuń) — wysyła pełną nową listę
  const toggleAssignee = async (taskId: string, employeeId: string) => {
    const task = tasks.find(t => t.id === taskId)
    if (!task) return
    const current = assigneeIdsOf(task)
    const next = current.includes(employeeId)
      ? current.filter(id => id !== employeeId)
      : [...current, employeeId]
    const updated = await tasksApi.update(taskId, { assignee_ids: next })
    setTasks(prev => prev.map(t => t.id === taskId ? updated : t))
  }

  const handleCreated = (task: Task) => {
    setTasks(prev => [...prev, task])
    const [y, m] = task.date.split('-').map(Number)
    setViewMonth(new Date(y, m - 1, 1))
    setSelectedDate(task.date)
    onModalClose()
  }

  // ── render ──
  const card: React.CSSProperties = {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, fontFamily: FONT,
  }

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 24, alignItems: 'start', marginBottom: 28 }}>

        {/* ── Calendar card ── */}
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 24px', borderBottom: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Kalendarz</div>
            <div style={{ fontSize: 13, color: '#94a3b8' }}>kliknij dzień, aby zobaczyć i dodać zadania</div>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => { setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDate(todayIso) }}
              style={{
                padding: '6px 12px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff',
                fontSize: 13, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: FONT,
              }}
            >
              Dziś
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                onClick={() => setViewMonth(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer' }}
              >
                <ChevronLeft size={16} />
              </button>
              <div style={{ fontSize: 14, fontWeight: 700, minWidth: 130, textAlign: 'center', color: '#0f172a' }}>{monthLabel}</div>
              <button
                onClick={() => setViewMonth(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
                style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer' }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Grid */}
          <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, paddingBottom: 4 }}>
              {['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'Sb', 'Nd'].map(d => (
                <div key={d} style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#94a3b8', textAlign: 'center' }}>{d}</div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
                {week.map(day => {
                  const dayTasks = tasksByDate.get(day.iso) ?? []
                  const isToday = day.iso === todayIso
                  const isSelected = day.iso === selectedDate
                  return (
                    <div
                      key={day.iso}
                      onClick={() => {
                        setSelectedDate(day.iso)
                        if (!day.inMonth) setViewMonth(new Date(day.date.getFullYear(), day.date.getMonth(), 1))
                      }}
                      style={{
                        minHeight: 86, borderRadius: 10, padding: '7px 8px', cursor: 'pointer',
                        display: 'flex', flexDirection: 'column', gap: 4,
                        background: isSelected ? '#eff6ff' : day.inMonth ? '#fff' : '#fafbfc',
                        border: `1px solid ${isSelected ? '#93c5fd' : '#f1f5f9'}`,
                        overflow: 'hidden', transition: 'border-color 0.12s',
                      }}
                      onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.borderColor = '#bfdbfe' }}
                      onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.borderColor = '#f1f5f9' }}
                    >
                      <span style={{
                        width: 24, height: 24, borderRadius: '50%',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                        color: isToday ? '#fff' : day.inMonth ? '#0f172a' : '#cbd5e1',
                        background: isToday ? '#2563eb' : 'transparent',
                      }}>
                        {day.date.getDate()}
                      </span>
                      {dayTasks.slice(0, 2).map(t => (
                        <div key={t.id} style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 5,
                          background: TYPE_META[t.type]?.chipBg ?? '#f1f5f9',
                          color: TYPE_META[t.type]?.chipFg ?? '#475569',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {t.time ? `${t.time} ` : ''}{t.title}
                        </div>
                      ))}
                      {dayTasks.length > 2 && (
                        <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, paddingLeft: 2 }}>
                          +{dayTasks.length - 2} więcej
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Selected day */}
          <div style={{ borderTop: '1px solid #e2e8f0', padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 10, background: '#fcfdfe' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'capitalize', color: '#0f172a' }}>{selectedLabel}</div>
              <div
                onClick={onRequestOpenModal}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
                  color: '#2563eb', cursor: 'pointer', padding: '4px 8px', borderRadius: 6,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#eff6ff' }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <Plus size={14} strokeWidth={2.5} />
                Dodaj na ten dzień
              </div>
            </div>
            {selectedTasks.length === 0 ? (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: '6px 0' }}>Brak zadań w tym dniu.</div>
            ) : (
              selectedTasks.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <TaskCheckbox done={t.done} size={18} onToggle={() => toggleDone(t)} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#64748b', fontVariantNumeric: 'tabular-nums', width: 88 }}>{timeRange(t)}</span>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_META[t.type]?.dot ?? '#94a3b8', flexShrink: 0 }} />
                  <span style={{
                    fontSize: 14, fontWeight: 600,
                    color: t.done ? '#94a3b8' : '#0f172a',
                    textDecoration: t.done ? 'line-through' : 'none',
                  }}>
                    {t.title}
                  </span>
                  <span style={{ fontSize: 13, color: '#94a3b8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.project?.name ?? ''}
                  </span>
                  <AssigneeAvatars task={t} employees={employees} size={26} onToggle={toggleAssignee} />
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Tasks panel ── */}
        <div style={{ ...card, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 20px', borderBottom: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Do zrobienia</div>
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '2px 10px', borderRadius: 999,
              background: '#eff6ff', color: '#1d4ed8', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
            }}>
              {upcomingCount}
            </span>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 13, color: '#94a3b8' }}>najbliższe 3 dni</div>
          </div>

          {threeDays.map(g => (
            <div key={g.iso} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 4px' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{g.label}</span>
                <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>{g.dateLabel}</span>
              </div>
              {g.tasks.length === 0 ? (
                <div style={{ fontSize: 13, color: '#94a3b8', padding: '2px 4px 6px' }}>Brak zadań</div>
              ) : (
                g.tasks.map(t => (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '11px 12px',
                      border: '1px solid #f1f5f9', borderRadius: 10, background: '#fff', position: 'relative',
                      transition: 'border-color 0.12s, box-shadow 0.12s',
                    }}
                    onMouseEnter={e => {
                      const el = e.currentTarget as HTMLDivElement
                      el.style.borderColor = '#e2e8f0'
                      el.style.boxShadow = '0 1px 3px rgba(15,23,42,0.05)'
                    }}
                    onMouseLeave={e => {
                      const el = e.currentTarget as HTMLDivElement
                      el.style.borderColor = '#f1f5f9'
                      el.style.boxShadow = 'none'
                    }}
                  >
                    <div style={{ marginTop: 1 }}>
                      <TaskCheckbox done={t.done} size={20} onToggle={() => toggleDone(t)} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 14, fontWeight: 600, lineHeight: 1.35,
                        color: t.done ? '#94a3b8' : '#0f172a',
                        textDecoration: t.done ? 'line-through' : 'none',
                      }}>
                        {t.title}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#94a3b8' }}>
                        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#64748b' }}>{timeRange(t)}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.project?.name ?? ''}</span>
                      </div>
                      <div>
                        <span style={{
                          display: 'inline-flex', padding: '2px 8px', borderRadius: 6,
                          background: TYPE_META[t.type]?.chipBg ?? '#f1f5f9',
                          color: TYPE_META[t.type]?.chipFg ?? '#475569',
                          fontSize: 11, fontWeight: 700,
                        }}>
                          {TASK_TYPE_LABELS[t.type] ?? t.type}
                        </span>
                      </div>
                    </div>
                    <AssigneeAvatars task={t} employees={employees} size={30} onToggle={toggleAssignee} />
                  </div>
                ))
              )}
            </div>
          ))}

          <div style={{ padding: '12px 16px 16px', marginTop: 'auto' }}>
            <div
              onClick={onRequestOpenModal}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: 11, borderRadius: 10, border: '1.5px dashed #cbd5e1',
                color: '#64748b', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLDivElement
                el.style.borderColor = '#2563eb'; el.style.color = '#2563eb'; el.style.background = '#f8fafc'
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLDivElement
                el.style.borderColor = '#cbd5e1'; el.style.color = '#64748b'; el.style.background = 'transparent'
              }}
            >
              <Plus size={16} />
              Dodaj zadanie
            </div>
          </div>
        </div>
      </div>

      {modalOpen && (
        <NewTaskModal
          defaultDate={selectedDate}
          projects={projects}
          employees={employees}
          onClose={onModalClose}
          onCreated={handleCreated}
        />
      )}
    </>
  )
}
