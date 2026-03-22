import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import AppHeader from './components/layout/AppHeader'
import DashboardView from './components/dashboard/DashboardView'
import ProjectsList from './components/projects/ProjectsList'
import ProjectDetail from './components/projects/ProjectDetail'
import EmployeesView from './components/employees/EmployeesView'
import LoginPage from './pages/LoginPage'
import AdminView from './pages/AdminView'
import ProductCatalogPage from './pages/ProductCatalogPage'
import AIQuotePrintView from './pages/AIQuotePrintView'
import ProtectedRoute from './components/auth/ProtectedRoute'
import AdminRoute from './components/auth/AdminRoute'
import { AuthProvider } from './auth/AuthContext'

function AppContent() {
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('shm-dark') === 'true'
  })
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('shm-dark', String(darkMode))
  }, [darkMode])

  const activeView = location.pathname.startsWith('/projects')
    ? 'projects'
    : location.pathname.startsWith('/employees')
    ? 'employees'
    : location.pathname.startsWith('/product-catalog')
    ? 'product-catalog'
    : 'dashboard'

  if (location.pathname === '/login') {
    return <LoginPage />
  }

  // Print view — full Route context for useParams, no app shell
  if (location.pathname.includes('/ai-quotes/') && location.pathname.endsWith('/print')) {
    return (
      <ProtectedRoute>
        <Routes>
          <Route path="/projects/:id/ai-quotes/:quoteId/print" element={<AIQuotePrintView />} />
        </Routes>
      </ProtectedRoute>
    )
  }

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gray-100 dark:bg-gray-950 flex flex-col">
        <AppHeader
          darkMode={darkMode}
          onToggleDark={() => setDarkMode(d => !d)}
          activeView={activeView}
          onNavigate={(view) => navigate(view === 'dashboard' ? '/' : `/${view}`)}
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
