import { useEffect, useRef, useState } from 'react'
import { Check, Lock, Plus, Trash2, X } from 'lucide-react'
import { personalTodosApi } from '../../api/client'
import type { PersonalTodo } from '../../types'
import { useAuth } from '../../auth/AuthContext'
import axios from 'axios'

const FONT = "'IBM Plex Sans', sans-serif"

function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fmtDue(s: string) {
  const [y, m, d] = s.split('-')
  return `${d}.${m}.${y}`
}

// Prywatna lista zadań użytkownika. Admin może podejrzeć listę pracownika (odczyt).
export default function PersonalTodoPanel() {
  const { user, token } = useAuth()
  const [todos, setTodos] = useState<PersonalTodo[]>([])
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDue, setEditDue] = useState('')
  const [showDone, setShowDone] = useState(false)

  // Admin: podgląd listy innego użytkownika (tylko odczyt)
  const [users, setUsers] = useState<Array<{ id: string; display_name: string }>>([])
  const [viewUserId, setViewUserId] = useState<string>('')
  const viewingOther = !!viewUserId && viewUserId !== user?.id

  useEffect(() => {
    if (user?.role !== 'admin') return
    axios.get('/api/users', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setUsers(r.data)).catch(() => {})
  }, [user?.role, token])

  // sekwencer: odpowiedź starszego żądania nie nadpisze nowszej listy
  const reqSeq = useRef(0)
  const reload = (uid?: string) => {
    const seq = ++reqSeq.current
    return personalTodosApi.list(uid || undefined)
      .then(d => { if (seq === reqSeq.current) setTodos(d) })
      .catch(() => {})
  }

  useEffect(() => { reload(viewUserId || undefined) }, [viewUserId]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!title.trim() || adding) return
    setAdding(true)
    try {
      await personalTodosApi.create({ title: title.trim(), due_date: dueDate || undefined })
      setTitle(''); setDueDate('')
      await reload()
    } catch { alert('Nie udało się dodać zadania.') }
    finally { setAdding(false) }
  }

  const toggle = async (t: PersonalTodo) => {
    if (viewingOther) return
    setTodos(prev => prev.map(x => x.id === t.id ? { ...x, done: !t.done } : x)) // optymistycznie
    try { await personalTodosApi.update(t.id, { done: !t.done }); await reload() }
    catch { await reload() }
  }

  const remove = async (t: PersonalTodo) => {
    if (!confirm(`Usunąć „${t.title}"?`)) return
    try { await personalTodosApi.remove(t.id); await reload() }
    catch { alert('Nie udało się usunąć.') }
  }

  const startEdit = (t: PersonalTodo) => {
    if (viewingOther) return
    setEditingId(t.id); setEditTitle(t.title); setEditDue(t.due_date)
  }
  const saveEdit = async () => {
    if (!editingId || !editTitle.trim()) { setEditingId(null); return }
    try { await personalTodosApi.update(editingId, { title: editTitle.trim(), due_date: editDue }) }
    catch { alert('Nie udało się zapisać.') }
    setEditingId(null)
    await reload(viewUserId || undefined)
  }

  const clearDone = async () => {
    if (!confirm('Usunąć wszystkie ukończone zadania?')) return
    await personalTodosApi.clearDone().catch(() => {})
    await reload()
  }

  const open = todos.filter(t => !t.done)
  const done = todos.filter(t => t.done)
  const today = todayIso()

  const inputCls: React.CSSProperties = {
    padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0',
    fontSize: 13, outline: 'none', color: '#0f172a', fontFamily: FONT, background: '#fff',
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, fontFamily: FONT, display: 'flex', flexDirection: 'column' }}>
      {/* Nagłówek */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
        <Lock size={14} color="#94a3b8" />
        <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>Moja lista</div>
        {open.length > 0 && (
          <span style={{ padding: '2px 9px', borderRadius: 999, background: '#f5f3ff', color: '#6d28d9', fontSize: 12, fontWeight: 700 }}>
            {open.length}
          </span>
        )}
        <span style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 500 }}>widoczna tylko dla Ciebie</span>
        <div style={{ flex: 1 }} />
        {user?.role === 'admin' && users.length > 0 && (
          <select
            value={viewUserId}
            onChange={e => setViewUserId(e.target.value)}
            title="Podgląd listy pracownika (tylko odczyt)"
            style={{ ...inputCls, padding: '5px 8px', fontSize: 12, cursor: 'pointer', maxWidth: 160 }}
          >
            <option value="">Moja lista</option>
            {users.filter(u => u.id !== user?.id).map(u => (
              <option key={u.id} value={u.id}>{u.display_name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Szybkie dodawanie (nie przy podglądzie cudzej listy) */}
      {!viewingOther && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px 4px' }}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            placeholder="Dodaj zadanie…"
            style={{ ...inputCls, flex: 1 }}
          />
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            title="Termin (opcjonalny)"
            style={{ ...inputCls, width: 130, padding: '8px 8px' }}
          />
          <button
            onClick={add}
            disabled={!title.trim() || adding}
            style={{
              width: 36, borderRadius: 8, border: 'none', background: title.trim() ? '#7c3aed' : '#e2e8f0',
              color: '#fff', cursor: title.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Plus size={16} />
          </button>
        </div>
      )}

      {/* Lista */}
      <div style={{ padding: '8px 16px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {open.length === 0 && done.length === 0 && (
          <div style={{ fontSize: 13, color: '#94a3b8', padding: '10px 4px' }}>
            {viewingOther ? 'Ta osoba nie ma zadań na liście.' : 'Pusta lista — dodaj pierwsze zadanie powyżej.'}
          </div>
        )}
        {open.map(t => {
          const overdue = !!t.due_date && t.due_date < today
          const isToday = t.due_date === today
          if (editingId === t.id) {
            return (
              <div key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 0' }}>
                <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null) }}
                  autoFocus style={{ ...inputCls, flex: 1 }} />
                <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)} style={{ ...inputCls, width: 130, padding: '8px 8px' }} />
                <button onClick={saveEdit} title="Zapisz" style={{ border: 'none', background: '#16a34a', color: '#fff', borderRadius: 7, width: 30, height: 30, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={14} /></button>
                <button onClick={() => setEditingId(null)} title="Anuluj" style={{ border: 'none', background: '#f1f5f9', color: '#64748b', borderRadius: 7, width: 30, height: 30, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} /></button>
              </div>
            )
          }
          return (
            <div key={t.id} className="ptodo-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px', borderBottom: '1px solid #f8fafc' }}>
              <div
                onClick={() => toggle(t)}
                style={{
                  width: 18, height: 18, borderRadius: 5, border: '1.5px solid #cbd5e1', background: '#fff',
                  cursor: viewingOther ? 'default' : 'pointer', flexShrink: 0,
                }}
              />
              <span
                onClick={() => startEdit(t)}
                title={viewingOther ? undefined : 'Kliknij, aby edytować'}
                style={{ fontSize: 13.5, fontWeight: 500, color: '#0f172a', flex: 1, minWidth: 0, cursor: viewingOther ? 'default' : 'pointer', overflowWrap: 'anywhere' }}
              >
                {t.title}
              </span>
              {t.due_date && (
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6, flexShrink: 0, whiteSpace: 'nowrap',
                  background: overdue ? '#fef2f2' : isToday ? '#fffbeb' : '#f1f5f9',
                  color: overdue ? '#dc2626' : isToday ? '#b45309' : '#64748b',
                }}>
                  {isToday ? 'dziś' : fmtDue(t.due_date)}
                </span>
              )}
              {!viewingOther && (
                <button onClick={() => remove(t)} title="Usuń"
                  style={{ border: 'none', background: 'transparent', color: '#cbd5e1', cursor: 'pointer', padding: 2, display: 'flex' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#ef4444' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#cbd5e1' }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          )
        })}

        {/* Ukończone */}
        {done.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <button
                onClick={() => setShowDone(s => !s)}
                style={{ border: 'none', background: 'transparent', color: '#94a3b8', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 0', fontFamily: FONT }}
              >
                {showDone ? '▾' : '▸'} Ukończone ({done.length})
              </button>
              <div style={{ flex: 1 }} />
              {!viewingOther && showDone && (
                <button onClick={clearDone} style={{ border: 'none', background: 'transparent', color: '#94a3b8', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                  Wyczyść ukończone
                </button>
              )}
            </div>
            {showDone && done.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 4px' }}>
                <div
                  onClick={() => toggle(t)}
                  style={{
                    width: 18, height: 18, borderRadius: 5, border: '1.5px solid #16a34a', background: '#16a34a',
                    cursor: viewingOther ? 'default' : 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Check size={11} color="#fff" strokeWidth={3.5} />
                </div>
                <span style={{ fontSize: 13, color: '#94a3b8', textDecoration: 'line-through', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{t.title}</span>
                {!viewingOther && (
                  <button onClick={() => remove(t)} title="Usuń" style={{ border: 'none', background: 'transparent', color: '#cbd5e1', cursor: 'pointer', padding: 2, display: 'flex' }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
