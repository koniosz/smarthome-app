import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'
import { msalInstance, loginRequest, azureConfigured } from '../auth/msalConfig'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()

  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLocal(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const endpoint = tab === 'login' ? '/api/auth/login' : '/api/auth/register'
      const body = tab === 'login'
        ? { email, password }
        : { email, password, display_name: displayName }
      const res = await axios.post(endpoint, body)
      login(res.data.token, res.data.user)
      navigate('/')
    } catch (err: any) {
      setError(err.response?.data?.error || 'Wystąpił błąd. Spróbuj ponownie.')
    } finally {
      setLoading(false)
    }
  }

  async function handleAzure() {
    if (!azureConfigured) return
    setError('')
    setLoading(true)
    try {
      await msalInstance.initialize()
      const result = await msalInstance.loginPopup(loginRequest)
      const idToken = result.idToken
      const res = await axios.post('/api/auth/azure', { id_token: idToken })
      login(res.data.token, res.data.user)
      navigate('/')
    } catch (err: any) {
      setError(err.response?.data?.error || 'Logowanie przez Microsoft nie powiodło się.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="bg-slate-800 rounded-2xl px-8 py-4">
            <img src="/logo_wh2.webp" alt="Smart Home Center" className="h-16 w-auto object-contain" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-800 p-6">
          {/* Tab switcher */}
          <div className="flex rounded-lg bg-gray-100 dark:bg-gray-800 p-1 mb-6">
            {(['login', 'register'] as const).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setError('') }}
                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  tab === t
                    ? 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {t === 'login' ? 'Zaloguj się' : 'Zarejestruj się'}
              </button>
            ))}
          </div>

          {/* Azure SSO button */}
          {azureConfigured && (
            <>
              <button
                onClick={handleAzure}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-sm font-medium text-gray-700 dark:text-gray-200 disabled:opacity-50"
              >
                <svg width="18" height="18" viewBox="0 0 21 21" fill="none">
                  <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                  <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                  <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                  <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
                </svg>
                Zaloguj przez Microsoft
              </button>
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
                <span className="text-xs text-gray-400">lub</span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
              </div>
            </>
          )}

          {/* Local form */}
          <form onSubmit={handleLocal} className="space-y-4">
            {tab === 'register' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Imię i nazwisko
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  required
                  placeholder="Jan Kowalski"
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-violet-400 dark:focus:border-violet-600 transition-colors"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="jan@firma.pl"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-violet-400 dark:focus:border-violet-600 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Hasło
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-violet-400 dark:focus:border-violet-600 transition-colors"
              />
            </div>

            {error && (
              <p className="text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {loading ? 'Ładowanie…' : tab === 'login' ? 'Zaloguj się' : 'Zarejestruj się'}
            </button>
          </form>

          {tab === 'register' && (
            <p className="mt-3 text-xs text-center text-gray-400">
              Pierwsza zarejestrowana osoba otrzymuje rolę <strong>Administratora</strong>.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
