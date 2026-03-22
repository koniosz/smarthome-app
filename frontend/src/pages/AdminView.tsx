import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'

interface User {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'employee'
  azure_oid: string | null
  created_at: string
}

interface Project {
  id: string
  name: string
  client_name: string
}

function api(token: string | null) {
  return axios.create({
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

export default function AdminView() {
  const { token } = useAuth()
  const [users, setUsers] = useState<User[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [memberProjectIds, setMemberProjectIds] = useState<Set<string>>(new Set())
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Create user modal state
  const [showCreate, setShowCreate] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<'admin' | 'employee'>('employee')
  const [creating, setCreating] = useState(false)

  // Reset password modal state
  const [resetUserId, setResetUserId] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetting, setResetting] = useState(false)

  const client = api(token)

  const loadData = useCallback(() => {
    Promise.all([
      client.get<User[]>('/api/users'),
      client.get<Project[]>('/api/projects'),
    ]).then(([usersRes, projectsRes]) => {
      setUsers(usersRes.data)
      setProjects(projectsRes.data)
    }).catch(() => setError('Nie udało się załadować danych'))
  }, [token])

  useEffect(() => { loadData() }, [loadData])

  const loadMemberships = useCallback(async (userId: string) => {
    setLoadingMembers(true)
    try {
      const res = await client.get<{ project_id: string }[]>(`/api/users/${userId}/projects`)
      // Fallback: build from project membership
      const ids = new Set<string>()
      await Promise.all(
        projects.map(async p => {
          try {
            const r = await client.get<User[]>(`/api/projects/${p.id}/members`)
            if (r.data.some(u => u.id === userId)) ids.add(p.id)
          } catch {}
        })
      )
      setMemberProjectIds(ids)
    } catch {
      const ids = new Set<string>()
      await Promise.all(
        projects.map(async p => {
          try {
            const r = await client.get<User[]>(`/api/projects/${p.id}/members`)
            if (r.data.some((u: User) => u.id === userId)) ids.add(p.id)
          } catch {}
        })
      )
      setMemberProjectIds(ids)
    } finally {
      setLoadingMembers(false)
    }
  }, [token, projects])

  async function selectUser(userId: string) {
    setSelectedUserId(userId)
    await loadMemberships(userId)
  }

  async function changeRole(userId: string, role: 'admin' | 'employee') {
    try {
      await client.put(`/api/users/${userId}`, { role })
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role } : u))
      flash('success', 'Rola zaktualizowana')
    } catch {
      flash('error', 'Nie udało się zmienić roli')
    }
  }

  async function deleteUser(userId: string) {
    if (!confirm('Na pewno usunąć tego użytkownika?')) return
    try {
      await client.delete(`/api/users/${userId}`)
      setUsers(prev => prev.filter(u => u.id !== userId))
      if (selectedUserId === userId) setSelectedUserId(null)
      flash('success', 'Użytkownik usunięty')
    } catch (err: any) {
      flash('error', err.response?.data?.error || 'Nie udało się usunąć użytkownika')
    }
  }

  async function toggleProjectAccess(projectId: string) {
    if (!selectedUserId) return
    const has = memberProjectIds.has(projectId)
    try {
      if (has) {
        await client.delete(`/api/projects/${projectId}/members/${selectedUserId}`)
        setMemberProjectIds(prev => { const s = new Set(prev); s.delete(projectId); return s })
      } else {
        await client.post(`/api/projects/${projectId}/members`, { user_id: selectedUserId })
        setMemberProjectIds(prev => new Set([...prev, projectId]))
      }
    } catch {
      flash('error', 'Nie udało się zmienić dostępu')
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      const res = await client.post<User>('/api/users', {
        email: newEmail,
        password: newPassword || undefined,
        display_name: newName,
        role: newRole,
      })
      setUsers(prev => [...prev, res.data])
      setShowCreate(false)
      setNewEmail(''); setNewName(''); setNewPassword(''); setNewRole('employee')
      flash('success', 'Użytkownik utworzony')
    } catch (err: any) {
      flash('error', err.response?.data?.error || 'Nie udało się utworzyć użytkownika')
    } finally {
      setCreating(false)
    }
  }

  async function resetUserPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!resetUserId) return
    setResetting(true)
    try {
      await client.post(`/api/users/${resetUserId}/reset-password`, { password: resetPassword })
      setResetUserId(null)
      setResetPassword('')
      flash('success', 'Hasło zostało zmienione')
    } catch (err: any) {
      flash('error', err.response?.data?.error || 'Nie udało się zmienić hasła')
    } finally {
      setResetting(false)
    }
  }

  function flash(type: 'success' | 'error', msg: string) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000) }
    else { setError(msg); setTimeout(() => setError(''), 4000) }
  }

  const selectedUser = users.find(u => u.id === selectedUserId)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">Panel Administratora</h1>
          <p className="text-sm text-gray-400 mt-0.5">Zarządzaj użytkownikami i dostępem do projektów</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          + Dodaj użytkownika
        </button>
      </div>

      {error && <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-4 py-2">{error}</div>}
      {success && <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 rounded-lg px-4 py-2">{success}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Users table */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Użytkownicy</h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {users.length === 0 && (
              <p className="px-5 py-6 text-sm text-gray-400 text-center">Brak użytkowników</p>
            )}
            {users.map(u => (
              <div
                key={u.id}
                onClick={() => selectUser(u.id)}
                className={`px-5 py-3 flex items-center gap-3 cursor-pointer transition-colors ${
                  selectedUserId === u.id
                    ? 'bg-violet-50 dark:bg-violet-950/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex items-center justify-center text-sm font-bold flex-shrink-0">
                  {u.display_name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{u.display_name}</div>
                  <div className="text-xs text-gray-400 truncate">{u.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={u.role}
                    onClick={e => e.stopPropagation()}
                    onChange={e => changeRole(u.id, e.target.value as 'admin' | 'employee')}
                    className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                  >
                    <option value="admin">Admin</option>
                    <option value="employee">User</option>
                  </select>
                  <button
                    onClick={e => { e.stopPropagation(); setResetUserId(u.id); setResetPassword('') }}
                    className="text-gray-300 hover:text-amber-500 dark:text-gray-600 dark:hover:text-amber-400 transition-colors text-xs"
                    title="Zmień hasło"
                  >🔑</button>
                  <button
                    onClick={e => { e.stopPropagation(); deleteUser(u.id) }}
                    className="text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 transition-colors text-xs"
                    title="Usuń użytkownika"
                  >✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Project access */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {selectedUser
                ? <>Dostęp do projektów — <span className="text-violet-600 dark:text-violet-400">{selectedUser.display_name}</span></>
                : 'Dostęp do projektów'}
            </h2>
            {selectedUser?.role === 'admin' && (
              <p className="text-xs text-gray-400 mt-1">Administratorzy mają dostęp do wszystkich projektów</p>
            )}
          </div>
          {!selectedUser ? (
            <p className="px-5 py-6 text-sm text-gray-400 text-center">Wybierz użytkownika aby zarządzać dostępem</p>
          ) : loadingMembers ? (
            <p className="px-5 py-6 text-sm text-gray-400 text-center">Ładowanie…</p>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800 max-h-96 overflow-y-auto">
              {projects.length === 0 && (
                <p className="px-5 py-6 text-sm text-gray-400 text-center">Brak projektów</p>
              )}
              {projects.map(p => {
                const has = memberProjectIds.has(p.id)
                const disabled = selectedUser.role === 'admin'
                return (
                  <label
                    key={p.id}
                    className={`px-5 py-3 flex items-center gap-3 transition-colors ${
                      disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={disabled ? true : has}
                      disabled={disabled}
                      onChange={() => !disabled && toggleProjectAccess(p.id)}
                      className="w-4 h-4 accent-violet-600"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{p.name}</div>
                      {p.client_name && <div className="text-xs text-gray-400 truncate">{p.client_name}</div>}
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Reset password modal */}
      {resetUserId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">🔑 Zmień hasło</h2>
              <button onClick={() => { setResetUserId(null); setResetPassword('') }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Użytkownik: <strong className="text-gray-700 dark:text-gray-200">{users.find(u => u.id === resetUserId)?.display_name}</strong>
            </p>
            <form onSubmit={resetUserPassword} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nowe hasło</label>
                <input
                  type="password" required minLength={4}
                  value={resetPassword} onChange={e => setResetPassword(e.target.value)}
                  placeholder="Minimum 4 znaki"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none focus:border-violet-400 dark:focus:border-violet-600"
                />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => { setResetUserId(null); setResetPassword('') }}
                  className="flex-1 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  Anuluj
                </button>
                <button type="submit" disabled={resetting}
                  className="flex-1 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
                  {resetting ? 'Zapisuję…' : 'Zmień hasło'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create user modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Nowy użytkownik</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
            </div>
            <form onSubmit={createUser} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Imię i nazwisko</label>
                <input
                  type="text" required value={newName} onChange={e => setNewName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none focus:border-violet-400 dark:focus:border-violet-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Email</label>
                <input
                  type="email" required value={newEmail} onChange={e => setNewEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none focus:border-violet-400 dark:focus:border-violet-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Hasło (opcjonalne dla kont Azure)</label>
                <input
                  type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                  placeholder="Zostaw puste jeśli konto Azure AD"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none focus:border-violet-400 dark:focus:border-violet-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Rola</label>
                <select
                  value={newRole} onChange={e => setNewRole(e.target.value as 'admin' | 'employee')}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none"
                >
                  <option value="employee">User</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  Anuluj
                </button>
                <button type="submit" disabled={creating} className="flex-1 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
                  {creating ? 'Tworzenie…' : 'Utwórz'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
