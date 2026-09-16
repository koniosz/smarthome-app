// Strona „Koszty spoza KSeF”: skrzynka dokumentów (upload / e-mail / telefon), reguły bankowe, ustawienia IMAP (admin).
// Dostęp: admin lub can_view_payments. Trasa /koszty-spoza-ksef.
import { useEffect, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { Inbox, Landmark, Mail } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { costDocumentsApi, type CostDocumentStats } from '../api/costInbox'
import DocumentsInbox from '../components/costinbox/DocumentsInbox'
import BankRulesPanel from '../components/costinbox/BankRulesPanel'
import ImapSettingsCard from '../components/costinbox/ImapSettingsCard'

type Tab = 'docs' | 'rules' | 'imap'

export default function KosztySpozaKsefPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const canSee = user?.role === 'admin' || !!user?.can_view_payments
  const isAdmin = user?.role === 'admin'

  const [tab, setTab] = useState<Tab>('docs')
  const [stats, setStats] = useState<CostDocumentStats | null>(null)

  useEffect(() => {
    if (!canSee) return
    costDocumentsApi.stats().then(setStats).catch(() => {})
  }, [canSee])

  if (!canSee) {
    return <div className="p-8 text-center text-gray-500 dark:text-gray-400">Brak dostępu. Poproś administratora o nadanie uprawnienia (💳).</div>
  }

  const TABS: Array<{ key: Tab; label: string; icon: ReactElement; adminOnly?: boolean }> = [
    { key: 'docs',  label: 'Dokumenty',      icon: <Inbox size={15} /> },
    { key: 'rules', label: 'Reguły bankowe', icon: <Landmark size={15} /> },
    { key: 'imap',  label: 'Skrzynka e-mail', icon: <Mail size={15} />, adminOnly: true },
  ]
  const pending = stats?.pending ?? 0

  return (
    <div className="p-6 max-w-[1150px] mx-auto" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {/* Nagłówek */}
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Koszty spoza KSeF</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Tu trafiają koszty, których nie ma w KSeF: faktury zagraniczne, subskrypcje, paragony. Zatwierdzone wchodzą do rentowności.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setTab('docs')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-bold ${pending > 0
              ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-200 dark:border-amber-800'
              : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 border border-green-200 dark:border-green-800'}`}
            title="Dokumenty czekające na Twoją decyzję">
            {pending > 0 ? `⏳ ${pending} do zatwierdzenia` : '✓ nic do zatwierdzenia'}
          </button>
          <button onClick={() => navigate('/rentownosc')}
            className="px-3 py-2 rounded-lg text-sm font-semibold text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30">
            Rentowność →
          </button>
          <button onClick={() => navigate('/kondycja')}
            className="px-3 py-2 rounded-lg text-sm font-semibold text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30">
            Kondycja firmy →
          </button>
        </div>
      </div>

      {/* Zakładki */}
      <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5 mb-4 w-fit flex-wrap">
        {TABS.filter(t => !t.adminOnly || isAdmin).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-sm font-semibold ${tab === t.key
              ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t.icon} {t.label}
            {t.key === 'docs' && pending > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none">{pending}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'docs' && <DocumentsInbox isAdmin={isAdmin} onStats={setStats} />}
      {tab === 'rules' && <BankRulesPanel />}
      {tab === 'imap' && (isAdmin
        ? <ImapSettingsCard />
        : <div className="p-8 text-center text-gray-500 dark:text-gray-400">Ustawienia skrzynki e-mail może zmieniać tylko administrator.</div>)}
    </div>
  )
}
