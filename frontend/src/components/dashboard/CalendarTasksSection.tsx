import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { tasksApi, employeesApi, projectsApi } from '../../api/client'
import type { OutlookEvent } from '../../api/client'
import type { Task, TaskType, Employee, Project } from '../../types'
import { TASK_TYPE_LABELS } from '../../types'
import { useAuth } from '../../auth/AuthContext'

type CalView = 'month' | 'week' | 'day'

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

// ─── Task modal (dodawanie / edycja) ──────────────────────────────────────────
function TaskModal({
  defaultDate, task, projects, employees, onClose, onCreated, onUpdated, onDeleted,
}: {
  defaultDate: string
  task?: Task | null
  projects: Project[]
  employees: Employee[]
  onClose: () => void
  onCreated: (task: Task) => void
  onUpdated: (task: Task) => void
  onDeleted: (id: string) => void
}) {
  const isEdit = !!task
  const [title, setTitle] = useState(task?.title ?? '')
  const [titleError, setTitleError] = useState(false)
  const [type, setType] = useState<TaskType>(task?.type ?? 'work')
  // Nowe zadanie/spotkanie domyślnie BEZ projektu (można utworzyć bez wyboru projektu).
  // Edycja istniejącego zachowuje jego projekt.
  const [projectId, setProjectId] = useState<string>(task?.project_id ?? '')
  const [date, setDate] = useState(task?.date ?? defaultDate)
  const [time, setTime] = useState(task?.time || '09:00')
  const [endTime, setEndTime] = useState(task?.end_time || '10:00')
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    task ? (task.assignees ?? []).map(a => a.employee_id) : (employees[0]?.id ? [employees[0].id] : []),
  )
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

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

  const handleDelete = async () => {
    if (!task) return
    if (!confirm('Usunąć to zadanie? Zniknie też z kalendarzy Outlook przypisanych osób.')) return
    setDeleting(true)
    try {
      await tasksApi.delete(task.id)
      onDeleted(task.id)
    } catch {
      alert('Nie udało się usunąć zadania.')
      setDeleting(false)
    }
  }

  const handleSubmit = async () => {
    if (!title.trim()) { setTitleError(true); return }
    setSaving(true)
    try {
      const payload = {
        title: title.trim(),
        type,
        project_id: projectId || null,
        date,
        time,
        end_time: endTime,
        assignee_ids: assigneeIds,
      }
      if (isEdit && task) {
        const updated = await tasksApi.update(task.id, payload)
        onUpdated(updated)
      } else {
        const created = await tasksApi.create(payload)
        onCreated(created)
      }
    } catch {
      alert(isEdit ? 'Nie udało się zapisać zmian.' : 'Nie udało się dodać zadania.')
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
          <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{isEdit ? 'Edytuj zadanie' : 'Nowe zadanie'}</div>
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
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10,
          padding: '16px 24px', background: '#f8fafc', borderTop: '1px solid #f1f5f9',
        }}>
          {isEdit && (
            <button
              onClick={handleDelete}
              disabled={saving || deleting}
              style={{
                marginRight: 'auto', padding: '10px 16px', borderRadius: 8,
                border: '1px solid #fecaca', background: '#fff', color: '#dc2626',
                fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#fef2f2' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#fff' }}
            >
              {deleting ? 'Usuwam…' : 'Usuń'}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={saving || deleting}
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
            disabled={saving || deleting}
            style={{
              padding: '10px 20px', borderRadius: 8, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', boxShadow: '0 1px 2px rgba(37,99,235,0.3)',
              fontFamily: FONT, opacity: saving ? 0.6 : 1,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1d4ed8' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#2563eb' }}
          >
            {saving ? 'Zapisuję…' : isEdit ? 'Zapisz zmiany' : 'Dodaj zadanie'}
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
  const { user } = useAuth()
  const myEmail = (user?.email ?? '').toLowerCase()

  const [tasks, setTasks] = useState<Task[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [viewMonth, setViewMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [selectedDate, setSelectedDate] = useState(todayIso)
  const [calView, setCalView] = useState<CalView>('month')
  const [onlyMine, setOnlyMine] = useState(true)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [outlookEvents, setOutlookEvents] = useState<OutlookEvent[]>([])

  // okno pobierania wydarzeń Outlook zależne od oglądanego miesiąca
  const anchor = calView === 'month'
    ? viewMonth
    : (() => { const [y, m] = selectedDate.split('-').map(Number); return new Date(y, m - 1, 1) })()
  const anchorKey = `${anchor.getFullYear()}-${anchor.getMonth()}`
  useEffect(() => {
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), -7)
    const to   = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 14)
    tasksApi.outlookEvents(iso(from), iso(to)).then(setOutlookEvents).catch(() => {})
  }, [anchorKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const outlookByDate = useMemo(() => {
    const map = new Map<string, OutlookEvent[]>()
    for (const ev of outlookEvents) {
      const list = map.get(ev.date) ?? []
      list.push(ev)
      map.set(ev.date, list)
    }
    for (const list of map.values()) list.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
    return map
  }, [outlookEvents])

  // czy zadanie jest przypisane do zalogowanej osoby (po e-mailu pracownika)
  const isMine = (t: Task) =>
    !!myEmail && (t.assignees ?? []).some(a => (a.employee?.email ?? '').toLowerCase() === myEmail)

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

  // 3-day groups: today, tomorrow, day after — opcjonalnie tylko moje zadania
  const threeDays = useMemo(() => {
    return [0, 1, 2].map(offset => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
      const dIso = iso(d)
      const label = offset === 0 ? 'Dziś' : offset === 1 ? 'Jutro' : (() => {
        const name = d.toLocaleDateString('pl-PL', { weekday: 'long' })
        return name.charAt(0).toUpperCase() + name.slice(1)
      })()
      const dayTasks = (tasksByDate.get(dIso) ?? []).filter(t => !onlyMine || isMine(t))
      return {
        iso: dIso,
        label,
        dateLabel: d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }),
        tasks: dayTasks,
      }
    })
  }, [tasksByDate, todayIso, onlyMine, myEmail]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const selectedLabel = (() => {
    const [y, m, d] = selectedDate.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })
  })()

  const selectedTasks = tasksByDate.get(selectedDate) ?? []

  // dni tygodnia zawierającego wybrany dzień (Pn–Nd) — dla widoku tygodnia
  const weekDays = useMemo(() => {
    const [y, m, d] = selectedDate.split('-').map(Number)
    const base = new Date(y, m - 1, d)
    const offset = (base.getDay() + 6) % 7 // Pn = 0
    const monday = new Date(y, m - 1, d - offset)
    return Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
      return { date: dd, iso: iso(dd) }
    })
  }, [selectedDate])

  // etykieta nagłówka zależna od widoku
  const headerLabel = (() => {
    if (calView === 'day') {
      const [y, m, d] = selectedDate.split('-').map(Number)
      const l = new Date(y, m - 1, d).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })
      return l.charAt(0).toUpperCase() + l.slice(1)
    }
    if (calView === 'week') {
      const a = weekDays[0].date, b = weekDays[6].date
      const fmtShort = (x: Date) => x.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' })
      return `${fmtShort(a)} – ${fmtShort(b)} ${b.getFullYear()}`
    }
    const l = viewMonth.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
    return l.charAt(0).toUpperCase() + l.slice(1)
  })()

  // nawigacja prev/next zależna od widoku
  const shiftDate = (dIso: string, days: number) => {
    const [y, m, d] = dIso.split('-').map(Number)
    return iso(new Date(y, m - 1, d + days))
  }
  const goPrev = () => {
    if (calView === 'month') setViewMonth(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))
    else setSelectedDate(s => shiftDate(s, calView === 'week' ? -7 : -1))
  }
  const goNext = () => {
    if (calView === 'month') setViewMonth(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))
    else setSelectedDate(s => shiftDate(s, calView === 'week' ? 7 : 1))
  }
  const goToday = () => {
    setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1))
    setSelectedDate(todayIso)
  }

  // ── mutations ──
  const toggleDone = async (task: Task) => {
    const updated = await tasksApi.update(task.id, { done: !task.done })
    setTasks(prev => prev.map(t => t.id === task.id ? updated : t))
  }

  const handleUpdated = (updated: Task) => {
    setTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
    setEditingTask(null)
  }
  const handleDeleted = (id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id))
    setEditingTask(null)
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Kalendarz</div>
            <div style={{ flex: 1 }} />

            {/* Przełącznik widoku */}
            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 8, padding: 2 }}>
              {([['month', 'Miesiąc'], ['week', 'Tydzień'], ['day', 'Dzień']] as [CalView, string][]).map(([v, lbl]) => (
                <button
                  key={v}
                  onClick={() => setCalView(v)}
                  style={{
                    padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600, fontFamily: FONT,
                    background: calView === v ? '#fff' : 'transparent',
                    color: calView === v ? '#1d4ed8' : '#64748b',
                    boxShadow: calView === v ? '0 1px 2px rgba(15,23,42,0.08)' : 'none',
                  }}
                >
                  {lbl}
                </button>
              ))}
            </div>

            <button
              onClick={goToday}
              style={{
                padding: '6px 12px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff',
                fontSize: 13, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: FONT,
              }}
            >
              Dziś
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                onClick={goPrev}
                style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer' }}
              >
                <ChevronLeft size={16} />
              </button>
              <div style={{ fontSize: 14, fontWeight: 700, minWidth: 150, textAlign: 'center', color: '#0f172a', textTransform: 'capitalize' }}>{headerLabel}</div>
              <button
                onClick={goNext}
                style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer' }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Grid (widok miesiąca) */}
          {calView === 'month' && (
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
                  const dayOutlook = outlookByDate.get(day.iso) ?? []
                  const totalEntries = dayTasks.length + dayOutlook.length
                  const shownTasks = dayTasks.slice(0, 2)
                  const outlookSlots = Math.max(0, 2 - shownTasks.length)
                  const shownOutlook = dayOutlook.slice(0, outlookSlots)
                  const moreCount = totalEntries - shownTasks.length - shownOutlook.length
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
                      {shownTasks.map(t => (
                        <div key={t.id} style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 5,
                          background: TYPE_META[t.type]?.chipBg ?? '#f1f5f9',
                          color: TYPE_META[t.type]?.chipFg ?? '#475569',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {t.time ? `${t.time} ` : ''}{t.title}
                        </div>
                      ))}
                      {shownOutlook.map(ev => (
                        <div key={ev.id} title={`Outlook · ${ev.employee_name}: ${ev.subject}`} style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 5,
                          background: '#eef2ff', color: '#4f46e5', border: '1px dashed #c7d2fe',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {ev.start_time ? `${ev.start_time} ` : ''}{ev.subject}
                        </div>
                      ))}
                      {moreCount > 0 && (
                        <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, paddingLeft: 2 }}>
                          +{moreCount} więcej
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          )}

          {/* Widok tygodnia — 7 kolumn dni z agendą */}
          {calView === 'week' && (
            <div style={{ padding: '16px 16px 20px', display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
              {weekDays.map(({ date, iso: dIso }) => {
                const dayTasks = tasksByDate.get(dIso) ?? []
                const dayOutlook = outlookByDate.get(dIso) ?? []
                const isToday = dIso === todayIso
                const isSelected = dIso === selectedDate
                const wd = date.toLocaleDateString('pl-PL', { weekday: 'short' })
                return (
                  <div
                    key={dIso}
                    onClick={() => setSelectedDate(dIso)}
                    style={{
                      minHeight: 220, borderRadius: 10, padding: 8, cursor: 'pointer',
                      display: 'flex', flexDirection: 'column', gap: 5,
                      background: isSelected ? '#eff6ff' : '#fff',
                      border: `1px solid ${isSelected ? '#93c5fd' : '#f1f5f9'}`, overflow: 'hidden',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, paddingBottom: 4, borderBottom: '1px solid #f1f5f9' }}>
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#94a3b8' }}>{wd}</span>
                      <span style={{
                        width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                        color: isToday ? '#fff' : '#0f172a', background: isToday ? '#2563eb' : 'transparent',
                      }}>{date.getDate()}</span>
                    </div>
                    {dayTasks.length === 0 && dayOutlook.length === 0 && <span style={{ fontSize: 11, color: '#cbd5e1', textAlign: 'center', marginTop: 4 }}>—</span>}
                    {dayTasks.map(t => (
                      <div
                        key={t.id}
                        onClick={e => { e.stopPropagation(); setEditingTask(t) }}
                        title={`${timeRange(t)} ${t.title}`}
                        style={{
                          fontSize: 11, fontWeight: 600, padding: '3px 6px', borderRadius: 5, cursor: 'pointer',
                          background: TYPE_META[t.type]?.chipBg ?? '#f1f5f9',
                          color: TYPE_META[t.type]?.chipFg ?? '#475569',
                          textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.6 : 1,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        {t.time ? `${t.time} ` : ''}{t.title}
                      </div>
                    ))}
                    {dayOutlook.map(ev => (
                      <div
                        key={ev.id}
                        title={`Outlook · ${ev.employee_name}: ${ev.subject}`}
                        style={{
                          fontSize: 11, fontWeight: 600, padding: '3px 6px', borderRadius: 5,
                          background: '#eef2ff', color: '#4f46e5', border: '1px dashed #c7d2fe',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        {ev.start_time ? `${ev.start_time} ` : ''}{ev.subject}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {/* Selected day (agenda — w widoku dnia jest jedyną treścią) */}
          <div style={{ borderTop: calView === 'day' ? 'none' : '1px solid #e2e8f0', padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 10, background: calView === 'day' ? '#fff' : '#fcfdfe' }}>
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
            {selectedTasks.length === 0 && (outlookByDate.get(selectedDate) ?? []).length === 0 ? (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: '6px 0' }}>Brak zadań w tym dniu.</div>
            ) : (
              selectedTasks.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <TaskCheckbox done={t.done} size={18} onToggle={() => toggleDone(t)} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#64748b', fontVariantNumeric: 'tabular-nums', width: 88 }}>{timeRange(t)}</span>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_META[t.type]?.dot ?? '#94a3b8', flexShrink: 0 }} />
                  <span
                    onClick={() => setEditingTask(t)}
                    title="Kliknij, aby edytować"
                    style={{
                      fontSize: 14, fontWeight: 600, cursor: 'pointer',
                      color: t.done ? '#94a3b8' : '#0f172a',
                      textDecoration: t.done ? 'line-through' : 'none',
                    }}
                  >
                    {t.title}
                  </span>
                  <span
                    onClick={() => setEditingTask(t)}
                    style={{ fontSize: 13, color: '#94a3b8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                    {t.project?.name ?? ''}
                  </span>
                  <AssigneeAvatars task={t} employees={employees} size={26} onToggle={toggleAssignee} />
                </div>
              ))
            )}

            {/* Wydarzenia z Outlooka (tylko do odczytu) */}
            {(outlookByDate.get(selectedDate) ?? []).map(ev => (
              <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid #f1f5f9' }}>
                <span style={{ width: 18, display: 'inline-flex', justifyContent: 'center', flexShrink: 0, fontSize: 12 }}>📅</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#6366f1', fontVariantNumeric: 'tabular-nums', width: 88 }}>
                  {ev.is_all_day ? 'cały dzień' : (ev.end_time ? `${ev.start_time}–${ev.end_time}` : ev.start_time)}
                </span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6366f1', flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#4338ca' }}>{ev.subject}</span>
                <span style={{ fontSize: 12, color: '#94a3b8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ev.employee_name} · Outlook
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Tasks panel ── */}
        <div style={{ ...card, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a' }}>Do zrobienia</div>
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '2px 10px', borderRadius: 999,
              background: '#eff6ff', color: '#1d4ed8', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
            }}>
              {upcomingCount}
            </span>
            <div style={{ flex: 1 }} />
            {/* Filtr: moje / wszystkie */}
            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 8, padding: 2 }}>
              {([[true, 'Moje'], [false, 'Wszystkie']] as [boolean, string][]).map(([v, lbl]) => (
                <button
                  key={lbl}
                  onClick={() => setOnlyMine(v)}
                  style={{
                    padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 600, fontFamily: FONT,
                    background: onlyMine === v ? '#fff' : 'transparent',
                    color: onlyMine === v ? '#1d4ed8' : '#64748b',
                    boxShadow: onlyMine === v ? '0 1px 2px rgba(15,23,42,0.08)' : 'none',
                  }}
                >
                  {lbl}
                </button>
              ))}
            </div>
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
                    <div onClick={() => setEditingTask(t)} style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0, cursor: 'pointer' }}>
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

      {(modalOpen || editingTask) && (
        <TaskModal
          defaultDate={selectedDate}
          task={editingTask}
          projects={projects}
          employees={employees}
          onClose={() => { setEditingTask(null); onModalClose() }}
          onCreated={handleCreated}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      )}
    </>
  )
}
