import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'

// ─── SMTP helpers ────────────────────────────────────────────────────────────
const SMTP_PRESETS = [
  { label: 'Gmail',          host: 'smtp.gmail.com',       port: 587 },
  { label: 'Outlook/Office', host: 'smtp.office365.com',   port: 587 },
  { label: 'OVH',           host: 'ssl0.ovh.net',         port: 465 },
  { label: 'home.pl',       host: 'mail.home.pl',         port: 587 },
  { label: 'Onet',          host: 'smtp.poczta.onet.pl',  port: 465 },
  { label: 'Interia',       host: 'poczta.interia.pl',    port: 465 },
  { label: 'Własny…',       host: '',                     port: 587 },
]

interface SmtpForm {
  host: string; port: number; user: string; pass: string
  from_email: string; from_name: string
}
const SMTP_DEFAULT: SmtpForm = { host: '', port: 587, user: '', pass: '', from_email: '', from_name: '' }

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

  // SMTP settings state
  const [activeTab, setActiveTab] = useState<'users' | 'smtp'>('users')
  const [smtpForm, setSmtpForm] = useState<SmtpForm>(SMTP_DEFAULT)
  const [smtpSource, setSmtpSource] = useState<'database' | 'env' | 'none'>('none')
  const [smtpConfigured, setSmtpConfigured] = useState(false)
  const [smtpSaving, setSmtpSaving] = useState(false)
  const [smtpTesting, setSmtpTesting] = useState(false)
  const [testEmail, setTestEmail] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [smtpUpdatedAt, setSmtpUpdatedAt] = useState('')

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

  // ─── SMTP functions ────────────────────────────────────────────────────────
  const loadSmtp = useCallback(async () => {
    try {
      const res = await client.get<any>('/api/settings/smtp')
      const d = res.data
      setSmtpForm({
        host:       d.host       || '',
        port:       d.port       || 587,
        user:       d.user       || '',
        pass:       d.pass       || '',
        from_email: d.from_email || '',
        from_name:  d.from_name  || '',
      })
      setSmtpSource(d.source || 'none')
      setSmtpConfigured(!!d.configured)
      setSmtpUpdatedAt(d.updated_at || '')
      // Pre-fill test email with current user's email
      setTestEmail(prev => prev || '')
    } catch {
      // If endpoint not available yet, silently ignore
    }
  }, [token])

  useEffect(() => {
    if (activeTab === 'smtp') loadSmtp()
  }, [activeTab, loadSmtp])

  async function saveSmtp(e: React.FormEvent) {
    e.preventDefault()
    setSmtpSaving(true)
    try {
      await client.put('/api/settings/smtp', smtpForm)
      flash('success', 'Konfiguracja poczty zapisana pomyślnie')
      await loadSmtp()
    } catch (err: any) {
      flash('error', err.response?.data?.error || 'Nie udało się zapisać konfiguracji')
    } finally {
      setSmtpSaving(false)
    }
  }

  async function testSmtp() {
    if (!testEmail || !testEmail.includes('@')) {
      flash('error', 'Podaj poprawny adres email do testu')
      return
    }
    setSmtpTesting(true)
    try {
      await client.post('/api/settings/smtp/test', { to: testEmail })
      flash('success', `Email testowy wysłany na ${testEmail} — sprawdź skrzynkę!`)
    } catch (err: any) {
      flash('error', err.response?.data?.error || 'Nie udało się wysłać emaila testowego')
    } finally {
      setSmtpTesting(false)
    }
  }

  function applyPreset(preset: typeof SMTP_PRESETS[number]) {
    if (preset.host) {
      setSmtpForm(f => ({ ...f, host: preset.host, port: preset.port }))
    }
  }

  function flash(type: 'success' | 'error', msg: string) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000) }
    else { setError(msg); setTimeout(() => setError(''), 4000) }
  }

  const selectedUser = users.find(u => u.id === selectedUserId)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">Panel Administratora</h1>
          <p className="text-sm text-gray-400 mt-0.5">Zarządzaj użytkownikami, dostępem i ustawieniami systemu</p>
        </div>
        {activeTab === 'users' && (
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            + Dodaj użytkownika
          </button>
        )}
      </div>

      {error   && <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-4 py-2">{error}</div>}
      {success && <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 rounded-lg px-4 py-2">{success}</div>}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('users')}
          className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 -mb-px ${
            activeTab === 'users'
              ? 'border-violet-600 text-violet-600 dark:text-violet-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          👥 Użytkownicy
        </button>
        <button
          onClick={() => setActiveTab('smtp')}
          className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === 'smtp'
              ? 'border-violet-600 text-violet-600 dark:text-violet-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          📧 Poczta
          {smtpConfigured && activeTab !== 'smtp' && (
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block" title="Poczta skonfigurowana" />
          )}
        </button>
      </div>

      {/* ═══ TAB: Użytkownicy ═══ */}
      {activeTab === 'users' && (
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
      )}

      {/* ═══ TAB: Poczta (SMTP) ═══ */}
      {activeTab === 'smtp' && (
        <div className="space-y-6">

          {/* Status banner */}
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
            smtpConfigured
              ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
              : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300'
          }`}>
            <span className="text-lg">{smtpConfigured ? '✅' : '⚠️'}</span>
            <div className="flex-1">
              <strong>{smtpConfigured ? 'Poczta jest skonfigurowana' : 'Poczta nie jest skonfigurowana'}</strong>
              {smtpConfigured && smtpSource === 'database' && smtpUpdatedAt && (
                <span className="text-xs ml-2 opacity-70">
                  (zapisano {new Date(smtpUpdatedAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })})
                </span>
              )}
              {smtpConfigured && smtpSource === 'env' && (
                <span className="text-xs ml-2 opacity-70">(ze zmiennych środowiskowych)</span>
              )}
              {!smtpConfigured && (
                <span className="ml-1">— wypełnij formularz poniżej, aby skonfigurować wysyłanie emaili.</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
            {/* SMTP Form (3/5) */}
            <div className="xl:col-span-3 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Konfiguracja serwera SMTP</h2>
                <p className="text-xs text-gray-400 mt-0.5">Ustawienia będą używane do wysyłania emaili do klientów z portalu i aplikacji mobilnej</p>
              </div>

              <form onSubmit={saveSmtp} className="p-5 space-y-4">

                {/* Provider presets */}
                <div>
                  <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                    Szybki wybór dostawcy poczty
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {SMTP_PRESETS.map(p => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 hover:border-violet-400 hover:text-violet-700 dark:hover:border-violet-500 dark:hover:text-violet-300 transition-colors text-gray-600 dark:text-gray-400"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {/* Host */}
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Serwer SMTP (host) *
                    </label>
                    <input
                      type="text" required
                      value={smtpForm.host}
                      onChange={e => setSmtpForm(f => ({ ...f, host: e.target.value }))}
                      placeholder="np. smtp.gmail.com"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-violet-400 dark:focus:border-violet-600 font-mono"
                    />
                  </div>
                  {/* Port */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Port</label>
                    <select
                      value={smtpForm.port}
                      onChange={e => setSmtpForm(f => ({ ...f, port: parseInt(e.target.value) }))}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-violet-400 dark:focus:border-violet-600"
                    >
                      <option value={587}>587 (STARTTLS)</option>
                      <option value={465}>465 (SSL)</option>
                      <option value={25}>25 (plain)</option>
                      <option value={2525}>2525</option>
                    </select>
                  </div>
                </div>

                {/* Username */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Adres email / login *
                  </label>
                  <input
                    type="email" required
                    value={smtpForm.user}
                    onChange={e => setSmtpForm(f => ({ ...f, user: e.target.value }))}
                    placeholder="np. noreply@moja-firma.pl"
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-violet-400 dark:focus:border-violet-600"
                  />
                </div>

                {/* Password */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Hasło *</label>
                  <div className="relative">
                    <input
                      type={showPass ? 'text' : 'password'}
                      value={smtpForm.pass}
                      onChange={e => setSmtpForm(f => ({ ...f, pass: e.target.value }))}
                      placeholder={smtpConfigured ? 'Pozostaw puste, aby nie zmieniać' : 'Hasło do konta SMTP'}
                      className="w-full px-3 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-violet-400 dark:focus:border-violet-600 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
                    >
                      {showPass ? '🙈' : '👁'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Dla Gmaila użyj <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-violet-600 hover:underline">hasła aplikacji</a> (App Password), nie hasła konta.
                  </p>
                </div>

                {/* Separator */}
                <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">Nadawca (opcjonalne)</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Adres nadawcy (From)</label>
                      <input
                        type="email"
                        value={smtpForm.from_email}
                        onChange={e => setSmtpForm(f => ({ ...f, from_email: e.target.value }))}
                        placeholder="Domyślnie: login SMTP"
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-violet-400 dark:focus:border-violet-600"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nazwa firmy (wyświetlana)</label>
                      <input
                        type="text"
                        value={smtpForm.from_name}
                        onChange={e => setSmtpForm(f => ({ ...f, from_name: e.target.value }))}
                        placeholder="np. SHC Manager"
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-violet-400 dark:focus:border-violet-600"
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="submit" disabled={smtpSaving}
                  className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  {smtpSaving ? 'Zapisuję…' : '💾  Zapisz konfigurację poczty'}
                </button>
              </form>
            </div>

            {/* Right column: Test + Help (2/5) */}
            <div className="xl:col-span-2 space-y-4">

              {/* Test email */}
              <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">🧪 Testuj połączenie</h3>
                <p className="text-xs text-gray-400 mb-4">Wyślij email testowy, aby sprawdzić czy konfiguracja działa poprawnie.</p>
                <input
                  type="email"
                  value={testEmail}
                  onChange={e => setTestEmail(e.target.value)}
                  placeholder="Twój adres email"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-violet-400 dark:focus:border-violet-600 mb-3"
                />
                <button
                  type="button" onClick={testSmtp} disabled={smtpTesting || !smtpConfigured}
                  title={!smtpConfigured ? 'Najpierw zapisz konfigurację SMTP' : ''}
                  className="w-full py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  {smtpTesting ? '⏳ Wysyłam…' : '📨 Wyślij email testowy'}
                </button>
              </div>

              {/* How-to */}
              <div className="bg-blue-50 dark:bg-blue-950/30 rounded-2xl border border-blue-100 dark:border-blue-900 p-5 text-xs text-blue-700 dark:text-blue-300 space-y-2">
                <p className="font-semibold text-sm">ℹ️ Jak to działa</p>
                <p>Konfiguracja zapisana tutaj zostanie użyta do wysyłania wszystkich wiadomości z portalu i aplikacji mobilnej:</p>
                <ul className="list-disc list-inside space-y-1 ml-1">
                  <li>Emaile akceptacji kosztów dodatkowych</li>
                  <li>Linki do zatwierdzania/odrzucania</li>
                  <li>Powiadomienia o zmianach statusu</li>
                </ul>
                <p className="pt-1">Priorytet: <strong>baza danych</strong> &gt; zmienne środowiskowe (SMTP_HOST, SMTP_USER…)</p>
              </div>

              {/* Gmail tip */}
              <div className="bg-amber-50 dark:bg-amber-950/30 rounded-2xl border border-amber-100 dark:border-amber-900 p-5 text-xs text-amber-700 dark:text-amber-400 space-y-1">
                <p className="font-semibold">💡 Wskazówka — Gmail</p>
                <p>Włącz weryfikację dwuetapową i wygeneruj <strong>Hasło aplikacji</strong> na <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline">myaccount.google.com/apppasswords</a>. Użyj tego hasła (nie hasła do konta Google).</p>
              </div>
            </div>
          </div>
        </div>
      )} {/* end activeTab === 'smtp' */}

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
