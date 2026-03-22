import { Navigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { ReactNode } from 'react'

export default function AdminRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth()

  if (!user || user.role !== 'admin') {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
