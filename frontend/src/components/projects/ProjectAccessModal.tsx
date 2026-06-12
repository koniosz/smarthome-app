import { useEffect, useState } from 'react'
import { X, Check, ShieldCheck } from 'lucide-react'
import { api } from '../../api/client'

interface AccessUser {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'employee'
}

// Admin zaznacza, którzy użytkownicy (pracownicy) mają dostęp do projektu.
// Administratorzy widzą wszystkie projekty — pokazani informacyjnie, bez przełącznika.
export default function ProjectAccessModal({ projectId, projectName, onClose }: {
  projectId: string
  projectName: string
  onClose: () => void
}) {
  const [users, setUsers]         = useState<AccessUser[]>([])
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set())
  const [loading, setLoading]     = useState(true)
  const [busy, setBusy]           = useState<Record<string, boolean>>({})
  const [error, setError]         = useState('')

  useEffect(() => {
    Promise.all([
      api.get<AccessUser[]>('/users').then(r => r.data),
      api.get<AccessUser[]>(`/projects/${projectId}/members`).then(r => r.data),
    ])
      .then(([allUsers, members]) => {
        setUsers(allUsers)
        setMemberIds(new Set(members.map(m => m.id)))
      })
      .catch(() => setError('Nie udało się pobrać listy użytkowników.'))
      .finally(() => setLoading(false))
  }, [projectId])

  const toggle = async (u: AccessUser) => {
    if (busy[u.id]) return
    setBusy(prev => ({ ...prev, [u.id]: true }))
    setError('')
    const isMember = memberIds.has(u.id)
    try {
      if (isMember) {
        await api.delete(`/projects/${projectId}/members/${u.id}`)
        setMemberIds(prev => { const s = new Set(prev); s.delete(u.id); return s })
      } else {
        await api.post(`/projects/${projectId}/members`, { user_id: u.id })
        setMemberIds(prev => new Set([...prev, u.id]))
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Błąd zapisu dostępu.')
    } finally {
      setBusy(prev => ({ ...prev, [u.id]: false }))
    }
  }

  const employees = users.filter(u => u.role !== 'admin')
  const admins    = users.filter(u => u.role === 'admin')

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        fontFamily: "'IBM Plex Sans', sans-serif",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, width: 480, maxWidth: '100%', maxHeight: '85vh',
          boxShadow: '0 24px 64px rgba(15,23,42,0.25)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Dostęp do projektu</div>
            <button
              onClick={onClose}
              style={{
                width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', cursor: 'pointer',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f1f5f9' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              <X size={17} />
            </button>
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
            {projectName} · zaznacz pracowników, którzy mają widzieć ten projekt
          </div>
        </div>

        {error && (
          <div style={{
            margin: '14px 24px 0', padding: '10px 14px', borderRadius: 8,
            background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <div style={{ padding: '16px 24px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: '#94a3b8', fontSize: 14 }}>Ładowanie…</div>
          ) : (
            <>
              {employees.length === 0 && (
                <div style={{ textAlign: 'center', padding: '16px 0', color: '#94a3b8', fontSize: 13 }}>
                  Brak kont pracowników. Dodaj użytkowników w Panelu admina.
                </div>
              )}
              {employees.map(u => {
                const checked = memberIds.has(u.id)
                return (
                  <button
                    key={u.id}
                    onClick={() => toggle(u)}
                    disabled={busy[u.id]}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                      padding: '11px 14px', borderRadius: 10,
                      border: `1px solid ${checked ? '#93c5fd' : '#e2e8f0'}`,
                      background: checked ? '#eff6ff' : '#fff',
                      cursor: 'pointer', transition: 'all 0.12s',
                      opacity: busy[u.id] ? 0.6 : 1,
                    }}
                    onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLButtonElement).style.background = '#f8fafc' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = checked ? '#eff6ff' : '#fff' }}
                  >
                    <span style={{
                      width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                      border: `1.5px solid ${checked ? '#2563eb' : '#cbd5e1'}`,
                      background: checked ? '#2563eb' : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {checked && <Check size={12} color="#fff" strokeWidth={3.5} />}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{u.display_name}</span>
                      <span style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginTop: 1 }}>{u.email}</span>
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: checked ? '#1d4ed8' : '#94a3b8' }}>
                      {checked ? 'ma dostęp' : 'brak dostępu'}
                    </span>
                  </button>
                )
              })}

              {admins.length > 0 && (
                <>
                  <div style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                    color: '#94a3b8', padding: '12px 4px 4px',
                  }}>
                    Administratorzy — pełny dostęp do wszystkich projektów
                  </div>
                  {admins.map(u => (
                    <div
                      key={u.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '11px 14px', borderRadius: 10,
                        border: '1px solid #f1f5f9', background: '#f8fafc',
                      }}
                    >
                      <ShieldCheck size={18} color="#16a34a" style={{ flexShrink: 0 }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#475569' }}>{u.display_name}</span>
                        <span style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginTop: 1 }}>{u.email}</span>
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#16a34a' }}>zawsze</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
