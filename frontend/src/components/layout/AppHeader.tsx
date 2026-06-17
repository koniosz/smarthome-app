import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  Zap,
  LayoutDashboard,
  Folder,
  Package,
  FileText,
  Banknote,
  FileBarChart,
  Search,
  Bell,
  ChevronDown,
} from 'lucide-react'
import { useAuth } from '../../auth/AuthContext'
import { notificationsApi, accessRequestsApi } from '../../api/client'
import type { AppNotification } from '../../types'

export type NavView = 'dashboard' | 'projects' | 'wycena' | 'product-catalog' | 'faktury' | 'koszty'

interface AppHeaderProps {
  darkMode: boolean
  onToggleDark: () => void
  activeView: NavView
  onNavigate: (view: NavView) => void
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 60) return 'przed chwilą'
  if (diff < 3600) return `${Math.floor(diff / 60)} min temu`
  if (diff < 86400) return `${Math.floor(diff / 3600)} godz. temu`
  return d.toLocaleDateString('pl-PL')
}

// ─── Notifications dropdown ───────────────────────────────────────────────────
function NotificationsPanel({
  notifications,
  onMarkAllRead,
  onApprove,
  onReject,
}: {
  notifications: AppNotification[]
  onMarkAllRead: () => void
  onApprove: (requestId: string, notifId: string) => Promise<void>
  onReject: (requestId: string, notifId: string) => Promise<void>
}) {
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})

  const handleAction = async (
    fn: (rId: string, nId: string) => Promise<void>,
    requestId: string,
    notifId: string,
  ) => {
    setActionLoading(prev => ({ ...prev, [requestId]: true }))
    try { await fn(requestId, notifId) }
    catch (err: any) { alert(err?.response?.data?.error ?? 'Błąd operacji.') }
    finally { setActionLoading(prev => ({ ...prev, [requestId]: false })) }
  }

  return (
    <div className="absolute right-0 top-full mt-2 w-96 bg-white border border-[#e2e8f0] rounded-xl z-50 overflow-hidden flex flex-col max-h-[80vh]" style={{ boxShadow: '0 8px 24px rgba(15,23,42,0.14)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#f1f5f9] flex-shrink-0">
        <h3 className="text-sm font-semibold text-[#0f172a]">Powiadomienia</h3>
        <button onClick={onMarkAllRead} className="text-xs text-[#2563eb] hover:text-[#1d4ed8]">
          Oznacz jako przeczytane
        </button>
      </div>
      <div className="overflow-y-auto flex-1">
        {notifications.length === 0 ? (
          <div className="px-4 py-8 text-center text-[#94a3b8] text-sm">Brak powiadomień</div>
        ) : (
          notifications.map(n => {
            const requestId = n.data?.request_id
            const isLoading = requestId ? actionLoading[requestId] === true : false
            const isProcessed = n.type === 'access_approved' || n.type === 'access_rejected'
            const isAccessRequest = n.type === 'access_request'
            return (
              <div
                key={n.id}
                className={`px-4 py-3 border-b border-[#f1f5f9] last:border-0 transition-colors ${
                  isProcessed ? 'bg-[#f8fafc] opacity-60'
                    : n.read ? 'bg-white'
                    : 'bg-[#eff6ff]/40'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="text-base flex-shrink-0 mt-0.5">
                    {n.type === 'access_request' ? '🔑' : n.type === 'access_approved' ? '✅' : '❌'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm leading-snug ${isProcessed || n.read ? 'text-[#64748b]' : 'text-[#0f172a] font-medium'}`}>
                      {n.message}
                    </p>
                    <p className="text-xs text-[#94a3b8] mt-0.5">{fmtTime(n.created_at)}</p>
                    {isAccessRequest && requestId && (
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleAction(onApprove, requestId, n.id)}
                          disabled={isLoading}
                          className="px-2.5 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50"
                        >
                          {isLoading ? '…' : 'Akceptuj'}
                        </button>
                        <button
                          onClick={() => handleAction(onReject, requestId, n.id)}
                          disabled={isLoading}
                          className="px-2.5 py-1 text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
                        >
                          {isLoading ? '…' : 'Odrzuć'}
                        </button>
                      </div>
                    )}
                    {isProcessed && (
                      <p className={`text-xs mt-1.5 font-medium ${n.type === 'access_approved' ? 'text-green-600' : 'text-red-500'}`}>
                        {n.type === 'access_approved' ? '✓ Dostęp przyznany' : '✗ Wniosek odrzucony'}
                      </p>
                    )}
                  </div>
                  {!n.read && !isProcessed && (
                    <span className="w-2 h-2 bg-[#2563eb] rounded-full flex-shrink-0 mt-1.5" />
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── Nav items config ─────────────────────────────────────────────────────────
const NAV_ITEMS: { view: NavView; label: string; Icon: typeof Zap }[] = [
  { view: 'dashboard',       label: 'Dashboard', Icon: LayoutDashboard },
  { view: 'projects',        label: 'Projekty',  Icon: Folder },
  { view: 'wycena',          label: 'Wycena',    Icon: FileBarChart },
  { view: 'product-catalog', label: 'Katalog',   Icon: Package },
  { view: 'faktury',         label: 'Faktury',   Icon: FileText },
  { view: 'koszty',          label: 'Koszty',    Icon: Banknote },
]

// ─── Main AppHeader ───────────────────────────────────────────────────────────
export default function AppHeader({ darkMode, onToggleDark, activeView, onNavigate }: AppHeaderProps) {
  const { user, token, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const notifRef = useRef<HTMLDivElement>(null)

  // Change password
  const [showChangePwd, setShowChangePwd] = useState(false)
  const [cpCurrent, setCpCurrent] = useState('')
  const [cpNew, setCpNew] = useState('')
  const [cpConfirm, setCpConfirm] = useState('')
  const [cpLoading, setCpLoading] = useState(false)
  const [cpError, setCpError] = useState('')
  const [cpSuccess, setCpSuccess] = useState(false)

  function openChangePwd() {
    setMenuOpen(false)
    setCpCurrent(''); setCpNew(''); setCpConfirm('')
    setCpError(''); setCpSuccess(false)
    setShowChangePwd(true)
  }

  async function handleChangePwd(e: React.FormEvent) {
    e.preventDefault()
    if (cpNew !== cpConfirm) { setCpError('Nowe hasła nie są identyczne'); return }
    if (cpNew.length < 6) { setCpError('Hasło musi mieć co najmniej 6 znaków'); return }
    setCpLoading(true); setCpError('')
    try {
      await axios.post('/api/auth/change-password',
        { current_password: cpCurrent, new_password: cpNew },
        { headers: { Authorization: `Bearer ${token}` } }
      )
      setCpSuccess(true)
      setTimeout(() => setShowChangePwd(false), 2000)
    } catch (err: any) {
      setCpError(err?.response?.data?.error ?? 'Błąd zmiany hasła')
    } finally {
      setCpLoading(false)
    }
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const fetchNotifications = useCallback(() => {
    if (!user) return
    notificationsApi.list().then(data => {
      setNotifications(data)
      setUnreadCount(data.filter(n => !n.read).length)
    }).catch(() => {})
  }, [user])

  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 60_000)
    return () => clearInterval(interval)
  }, [fetchNotifications])

  const handleOpenNotif = () => {
    setNotifOpen(o => !o)
    setMenuOpen(false)
  }

  const handleMarkAllRead = async () => {
    await notificationsApi.markRead()
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
    setUnreadCount(0)
  }

  const handleApprove = async (requestId: string, notifId: string) => {
    await accessRequestsApi.approve(requestId)
    setNotifications(prev => prev.map(n =>
      n.id === notifId ? { ...n, type: 'access_approved' as const, read: true } : n
    ))
    setUnreadCount(prev => Math.max(0, prev - 1))
  }

  const handleReject = async (requestId: string, notifId: string) => {
    await accessRequestsApi.reject(requestId)
    setNotifications(prev => prev.map(n =>
      n.id === notifId ? { ...n, type: 'access_rejected' as const, read: true } : n
    ))
    setUnreadCount(prev => Math.max(0, prev - 1))
  }

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const initials = user?.display_name
    ? user.display_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    : '?'

  return (
    <>
      <header className="flex items-center gap-7 px-8 py-0 bg-white border-b border-[#e2e8f0] sticky top-0 z-40 flex-shrink-0" style={{ minHeight: '61px' }}>
        {/* Logo */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <div className="flex items-center justify-center rounded-[9px] text-[#60a5fa]" style={{ width: 34, height: 34, background: '#0f1b2d' }}>
            <Zap size={18} strokeWidth={2} />
          </div>
          <span className="text-[15px] font-bold tracking-tight text-[#0f1b2d]">Smart Home Center</span>
        </div>

        {/* Nav */}
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map(({ view, label, Icon }) => {
            const isActive = activeView === view
            return (
              <button
                key={view}
                onClick={() => onNavigate(view)}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-[#eff6ff] text-[#1d4ed8] font-semibold'
                    : 'text-[#475569] font-medium hover:bg-[#f1f5f9]'
                }`}
              >
                <Icon size={16} strokeWidth={2} />
                {label}
              </button>
            )
          })}
        </nav>

        <div className="flex items-center gap-3 flex-1 justify-end">
          {/* Search — shown only on dashboard */}
          {activeView === 'dashboard' && (
            <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] text-[#94a3b8] text-sm" style={{ width: 230 }}>
              <Search size={15} strokeWidth={2} />
              <span className="flex-1">Szukaj…</span>
              <span className="text-[11px] border border-[#e2e8f0] rounded bg-white px-1.5 py-px">⌘K</span>
            </div>
          )}

          {/* Bell */}
          {user && (
            <div ref={notifRef} className="relative flex-shrink-0">
              <button
                onClick={handleOpenNotif}
                className="relative p-2 rounded-lg text-[#64748b] hover:bg-[#f1f5f9] transition-colors"
              >
                <Bell size={18} strokeWidth={2} />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 leading-none">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
              {notifOpen && (
                <NotificationsPanel
                  notifications={notifications}
                  onMarkAllRead={handleMarkAllRead}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              )}
            </div>
          )}

          {/* Avatar / user menu */}
          {user && (
            <div ref={menuRef} className="relative flex-shrink-0">
              <button
                onClick={() => { setMenuOpen(o => !o); setNotifOpen(false) }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#f1f5f9] transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-[#2563eb] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                  {initials}
                </div>
                <ChevronDown size={14} strokeWidth={2} className="text-[#94a3b8]" />
              </button>

              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-[#e2e8f0] rounded-xl z-50 overflow-hidden" style={{ boxShadow: '0 8px 24px rgba(15,23,42,0.14)' }}>
                  <div className="px-4 py-3 border-b border-[#f1f5f9]">
                    <div className="text-sm font-semibold text-[#0f172a] truncate">{user.display_name}</div>
                    <div className="text-xs text-[#94a3b8] truncate mt-0.5">{user.email}</div>
                  </div>
                  {user.role === 'admin' && (
                    <>
                      <button
                        onClick={() => { setMenuOpen(false); navigate('/admin') }}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors"
                      >
                        Panel admina
                      </button>
                      <button
                        onClick={() => { setMenuOpen(false); navigate('/employees') }}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors"
                      >
                        Pracownicy
                      </button>
                      <button
                        onClick={() => { setMenuOpen(false); navigate('/ai-examples') }}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors"
                      >
                        Wzorce AI
                      </button>
                      <button
                        onClick={() => { setMenuOpen(false); navigate('/finanse') }}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors"
                      >
                        P&amp;L / EBITDA
                      </button>
                      <button
                        onClick={() => { setMenuOpen(false); navigate('/inne-koszty') }}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors"
                      >
                        Inne koszty (pensje, ZUS)
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => { setMenuOpen(false); onToggleDark() }}
                    className="w-full text-left px-4 py-2.5 text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors border-t border-[#f1f5f9]"
                  >
                    {darkMode ? 'Tryb jasny' : 'Tryb ciemny'}
                  </button>
                  <button
                    onClick={openChangePwd}
                    className="w-full text-left px-4 py-2.5 text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors"
                  >
                    Zmień hasło
                  </button>
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors border-t border-[#f1f5f9]"
                  >
                    Wyloguj
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Change password modal */}
      {showChangePwd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.45)] p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6" style={{ boxShadow: '0 24px 64px rgba(15,23,42,0.25)' }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-[#0f172a]">Zmień hasło</h2>
              <button onClick={() => setShowChangePwd(false)} className="text-[#94a3b8] hover:text-[#475569] text-xl leading-none">×</button>
            </div>
            {cpSuccess ? (
              <div className="text-center py-4">
                <div className="text-4xl mb-3">✅</div>
                <p className="text-sm font-medium text-green-600">Hasło zostało zmienione!</p>
              </div>
            ) : (
              <form onSubmit={handleChangePwd} className="space-y-4">
                {(['Obecne hasło', 'Nowe hasło', 'Powtórz nowe hasło'] as const).map((label, i) => (
                  <div key={label}>
                    <label className="block text-xs font-medium text-[#475569] mb-1">{label}</label>
                    <input
                      type="password" required={i === 0} minLength={i > 0 ? 6 : undefined}
                      value={i === 0 ? cpCurrent : i === 1 ? cpNew : cpConfirm}
                      onChange={e => [setCpCurrent, setCpNew, setCpConfirm][i](e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#e2e8f0] text-sm outline-none focus:border-[#2563eb] transition-colors"
                      style={{ boxShadow: 'none' }}
                      onFocus={e => { e.target.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)'; e.target.style.borderColor = '#2563eb' }}
                      onBlur={e => { e.target.style.boxShadow = 'none'; e.target.style.borderColor = '#e2e8f0' }}
                    />
                  </div>
                ))}
                {cpError && (
                  <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 border border-[#fecaca]">{cpError}</div>
                )}
                <div className="flex gap-3 pt-1">
                  <button type="button" onClick={() => setShowChangePwd(false)} disabled={cpLoading}
                    className="flex-1 py-2.5 rounded-lg border border-[#e2e8f0] text-sm text-[#475569] hover:bg-[#f8fafc] transition-colors disabled:opacity-50">
                    Anuluj
                  </button>
                  <button type="submit" disabled={cpLoading}
                    className="flex-1 py-2.5 bg-[#2563eb] hover:bg-[#1d4ed8] disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors" style={{ boxShadow: '0 1px 2px rgba(37,99,235,0.3)' }}>
                    {cpLoading ? 'Zapisuję…' : 'Zmień hasło'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  )
}
