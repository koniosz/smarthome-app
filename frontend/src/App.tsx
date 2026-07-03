import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import AppHeader from './components/layout/AppHeader'
import type { NavView } from './components/layout/AppHeader'
import DashboardView from './components/dashboard/DashboardView'
import ProjectsList from './components/projects/ProjectsList'
import ProjectDetail from './components/projects/ProjectDetail'
import EmployeesView from './components/employees/EmployeesView'
import LoginPage from './pages/LoginPage'
import AdminView from './pages/AdminView'
import ProductCatalogPage from './pages/ProductCatalogPage'
import AiExamplesPage from './pages/AiExamplesPage'
import KsefPage from './pages/KsefPage'
import SharedInvoicesPage from './pages/SharedInvoicesPage'
import FinansePage from './pages/FinansePage'
import ManualCostsPage from './pages/ManualCostsPage'
import KosztyPage from './pages/KosztyPage'
import WycenaPage from './pages/WycenaPage'
import MagazynPage from './pages/MagazynPage'
import HrPage from './pages/HrPage'
import HandoverPrintView from './pages/HandoverPrintView'
import AIQuotePrintView from './pages/AIQuotePrintView'
import SurveyPage from './pages/SurveyPage'
import ProtectedRoute from './components/auth/ProtectedRoute'
import AdminRoute from './components/auth/AdminRoute'
import { AuthProvider, useAuth } from './auth/AuthContext'

function pathToView(pathname: string): NavView {
  if (pathname.startsWith('/projects')) return 'projects'
  if (pathname.startsWith('/wycena')) return 'wycena'
  if (pathname.startsWith('/magazyn')) return 'magazyn'
  if (pathname.startsWith('/hr')) return 'hr'
  if (pathname.startsWith('/product-catalog')) return 'product-catalog'
  if (pathname.startsWith('/faktury') || pathname.startsWith('/ksef')) return 'faktury'
  if (pathname.startsWith('/koszty')) return 'koszty'
  return 'dashboard'
}

// Faktury design = KSeF cost-invoice page (admin); non-admins see shared invoices
function viewToPath(view: NavView, isAdmin: boolean): string {
  if (view === 'dashboard') return '/'
  if (view === 'faktury') return isAdmin ? '/ksef' : '/faktury'
  return `/${view}`
}

function AppContent() {
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('shm-dark') === 'true'
  })
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('shm-dark', String(darkMode))
  }, [darkMode])

  const activeView = pathToView(location.pathname)

  if (location.pathname === '/login') {
    return <LoginPage />
  }

  if (location.pathname.startsWith('/survey/')) {
    return (
      <Routes>
        <Route path="/survey/:token" element={<SurveyPage />} />
      </Routes>
    )
  }

  if (location.pathname.includes('/ai-quotes/') && location.pathname.endsWith('/print')) {
    return (
      <ProtectedRoute>
        <Routes>
          <Route path="/projects/:id/ai-quotes/:quoteId/print" element={<AIQuotePrintView />} />
        </Routes>
      </ProtectedRoute>
    )
  }

  if (location.pathname.includes('/handover/') && location.pathname.endsWith('/print')) {
    return (
      <ProtectedRoute>
        <Routes>
          <Route path="/projects/:id/handover/:protocolId/print" element={<HandoverPrintView />} />
        </Routes>
      </ProtectedRoute>
    )
  }

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-[#f8fafc] dark:bg-gray-950 flex flex-col">
        <AppHeader
          darkMode={darkMode}
          onToggleDark={() => setDarkMode(d => !d)}
          activeView={activeView}
          onNavigate={(view) => navigate(viewToPath(view, user?.role === 'admin'))}
        />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<DashboardView />} />
            <Route path="/projects" element={<ProjectsList />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/employees" element={
              <AdminRoute><EmployeesView /></AdminRoute>
            } />
            <Route path="/admin" element={
              <AdminRoute><AdminView /></AdminRoute>
            } />
            <Route path="/product-catalog" element={<ProductCatalogPage />} />
            <Route path="/ai-examples" element={
              <AdminRoute><AiExamplesPage /></AdminRoute>
            } />
            <Route path="/ksef" element={
              <AdminRoute><KsefPage /></AdminRoute>
            } />
            <Route path="/finanse" element={
              <AdminRoute><FinansePage /></AdminRoute>
            } />
            <Route path="/inne-koszty" element={
              <AdminRoute><ManualCostsPage /></AdminRoute>
            } />
            <Route path="/faktury" element={<SharedInvoicesPage />} />
            <Route path="/koszty" element={<KosztyPage />} />
            <Route path="/wycena" element={<WycenaPage />} />
            <Route path="/magazyn" element={<MagazynPage />} />
            <Route path="/hr" element={<HrPage />} />
          </Routes>
        </main>
      </div>
    </ProtectedRoute>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  )
}
