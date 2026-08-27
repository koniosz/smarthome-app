import { useNavigate } from 'react-router-dom'
import SalesInvoicesSection from '../components/invoices/SalesInvoicesSection'
import { useAuth } from '../auth/AuthContext'

// Moduł faktur sprzedażowych (offline — bez wysyłki do KSeF) jako osobna strona.
// Dostęp: admin lub użytkownik z flagą 🧾 can_view_invoices.
export default function SprzedazPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const canSee = user?.role === 'admin' || !!user?.can_view_invoices

  if (!canSee) {
    return <div className="p-8 text-center text-gray-500 dark:text-gray-400">Brak dostępu do fakturowania. Poproś administratora o nadanie uprawnienia (🧾).</div>
  }
  return <SalesInvoicesSection onBack={() => navigate(user?.role === 'admin' ? '/ksef' : '/')} />
}
