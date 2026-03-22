import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import GlobalSearch from './GlobalSearch'
import { useAuth } from '../../auth/AuthContext'
import { notificationsApi, accessRequestsApi } from '../../api/client'
import type { AppNotification } from '../../types'

interface AppHeaderProps {
  darkMode: boolean
  onToggleDark: () => void
  activeView: 'dashboard' | 'projects' | 'employees' | 'product-catalog'
  onNavigate: (view: 'dashboard' | 'projects' | 'employees' | 'product-catalog') => void
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
    <div className="absolute right-0 top-full mt-1 w-96 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col max-h-[80vh]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">🔔 Powiadomienia</h3>
        <button
          onClick={onMarkAllRead}
          className="text-xs text-violet-600 dark:text-violet-400 hover:underline"
        >
          Oznacz jako przeczytane
        </button>
      </div>

      <div className="overflow-y-auto flex-1">
        {notifications.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-400 text-sm">Brak powiadomień</div>
        ) : (
          notifications.map(n => {
            const requestId = n.data?.request_id
            const isLoading = requestId ? actionLoading[requestId] === true : false
            // Processed = admin already acted (type updated in parent state, persists across panel open/close)
            const isProcessed = n.type === 'access_approved' || n.type === 'access_rejected'
            const isAccessRequest = n.type === 'access_request'

            return (
              <div
                key={n.id}
                className={`px-4 py-3 border-b border-gray-50 dark:border-gray-800 last:border-0 transition-colors ${
                  isProcessed
                    ? 'bg-gray-50 dark:bg-gray-800/40 opacity-60'
                    : n.read
                    ? 'bg-white dark:bg-gray-900'
                    : 'bg-violet-50/60 dark:bg-violet-900/10'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-lg flex-shrink-0 mt-0.5">
                    {n.type === 'access_request' ? '🔑' : n.type === 'access_approved' ? '✅' : '❌'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm leading-snug ${isProcessed || n.read ? 'text-gray-500 dark:text-gray-500' : 'text-gray-800 dark:text-gray-100 font-medium'}`}>
                      {n.message}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{fmtTime(n.created_at)}</p>

                    {isAccessRequest && requestId && (
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleAction(onApprove, requestId, n.id)}
                          disabled={isLoading}
                          className="px-2.5 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50"
                        >
                          {isLoading ? '⏳' : '✅ Akceptuj'}
                        </button>
                        <button
                          onClick={() => handleAction(onReject, requestId, n.id)}
                          disabled={isLoading}
                          className="px-2.5 py-1 text-xs font-medium border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-md transition-colors disabled:opacity-50"
                        >
                          {isLoading ? '⏳' : '❌ Odrzuć'}
                        </button>
                      </div>
                    )}
                    {isProcessed && (
                      <p className={`text-xs mt-1.5 font-medium ${n.type === 'access_approved' ? 'text-green-600 dark:text-green-500' : 'text-red-500 dark:text-red-400'}`}>
                        {n.type === 'access_approved' ? '✓ Dostęp przyznany' : '✗ Wniosek odrzucony'}
                      </p>
                    )}
                  </div>
                  {!n.read && !isProcessed && (
                    <span className="w-2 h-2 bg-violet-500 rounded-full flex-shrink-0 mt-1.5" />
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

// ─── Main AppHeader ───────────────────────────────────────────────────────────
export default function AppHeader({ darkMode, onToggleDark, activeView, onNavigate }: AppHeaderProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const notifRef = useRef<HTMLDivElement>(null)

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
      n.id === notifId
        ? { ...n, type: 'access_approved' as const, read: true }
        : n
    ))
    setUnreadCount(prev => Math.max(0, prev - 1))
  }

  const handleReject = async (requestId: string, notifId: string) => {
    await accessRequestsApi.reject(requestId)
    setNotifications(prev => prev.map(n =>
      n.id === notifId
        ? { ...n, type: 'access_rejected' as const, read: true }
        : n
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
    <header className="flex items-center justify-between px-6 py-3 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0 gap-4">
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="bg-slate-800 rounded-xl px-4 py-1.5">
          <img src="/logo_wh2.webp" alt="Smart Home Center" className="h-8 w-auto object-contain" />
        </div>
      </div>

      <nav className="flex items-center gap-1 flex-shrink-0">
        {(['dashboard', 'projects'] as const).map(view => (
          <button
            key={view}
            onClick={() => onNavigate(view)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeView === view
                ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {view === 'dashboard' ? '📊 Dashboard' : '📁 Projekty'}
          </button>
        ))}
        {user?.role === 'admin' && (
          <button
            onClick={() => onNavigate('employees')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeView === 'employees'
                ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            👥 Pracownicy
          </button>
        )}
        <button
          onClick={() => onNavigate('product-catalog')}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeView === 'product-catalog'
              ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          📦 Katalog
        </button>
      </nav>

      <div className="flex items-center gap-2 flex-1 justify-end">
        <GlobalSearch />

        {/* Mobile view button */}
        <a
          href={window.location.origin}
          target="_blank"
          rel="noopener noreferrer"
          className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors flex-shrink-0"
          title="Widok mobilny"
        >
          📱
        </a>

        {/* Notification bell */}
        {user && (
          <div ref={notifRef} className="relative flex-shrink-0">
            <button
              onClick={handleOpenNotif}
              className="relative p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
              title="Powiadomienia"
            >
              🔔
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

        <button
          onClick={onToggleDark}
          className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors flex-shrink-0"
          title={darkMode ? 'Tryb jasny' : 'Tryb ciemny'}
        >
          {darkMode ? '☀️' : '🌙'}
        </button>

        {/* User menu */}
        {user && (
          <div ref={menuRef} className="relative flex-shrink-0">
            <button
              onClick={() => { setMenuOpen(o => !o); setNotifOpen(false) }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-violet-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                {initials}
              </div>
              <span className="hidden sm:block text-sm font-medium text-gray-700 dark:text-gray-300 max-w-[120px] truncate">
                {user.display_name}
              </span>
              <span className="text-gray-400 text-xs">▾</span>
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{user.display_name}</div>
                  <div className="text-xs text-gray-400 truncate">{user.email}</div>
                  <div className={`mt-1 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                    user.role === 'admin'
                      ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                  }`}>
                    {user.role === 'admin' ? '👑 Administrator' : '👤 User'}
                  </div>
                </div>
                {user.role === 'admin' && (
                  <button
                    onClick={() => { setMenuOpen(false); navigate('/admin') }}
                    className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center gap-2"
                  >
                    ⚙️ Panel admina
                  </button>
                )}
                <button
                  onClick={handleLogout}
                  className="w-full text-left px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors flex items-center gap-2 border-t border-gray-100 dark:border-gray-800"
                >
                  🚪 Wyloguj
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
