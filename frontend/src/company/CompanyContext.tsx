import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react'
import axios from 'axios'
import { useAuth } from '../auth/AuthContext'
import { companiesApi, COMPANY_STORAGE_KEY, COMPANY_HEADER, getStoredCompanyId } from '../api/client'
import type { Company } from '../api/client'

// ─── Kontekst aktywnej firmy (jak zmiana firmy w Fakturowni) ───────────────────
// Po zalogowaniu pobieramy GET /companies/me: aktywną firmę (wg nagłówka X-Company-Id z localStorage),
// listę firm do przełączenia i flagę can_switch (admin). Przełączenie = zapis klucza + pełny reload strony,
// żeby każdy moduł załadował dane nowej firmy od zera.

interface CompanyContextValue {
  company: Company | null
  companies: Company[]
  canSwitch: boolean
  loading: boolean
  switchCompany: (id: string) => void
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

/** Nazwa firmy do UI: skrócona, a gdy brak — pełna. */
export function companyLabel(c: Pick<Company, 'name' | 'short_name'> | null | undefined, fallback = ''): string {
  if (!c) return fallback
  return (c.short_name || c.name || '').trim() || fallback
}

function clearStoredCompany() {
  try { localStorage.removeItem(COMPANY_STORAGE_KEY) } catch { /* ignore */ }
  delete axios.defaults.headers.common[COMPANY_HEADER]
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [company, setCompany] = useState<Company | null>(null)
  const [companies, setCompanies] = useState<Company[]>([])
  const [canSwitch, setCanSwitch] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setCompany(null); setCompanies([]); setCanSwitch(false); setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    companiesApi.me()
      .then(res => {
        if (cancelled) return
        const stored = getStoredCompanyId()
        const list = Array.isArray(res.companies) ? res.companies : []
        // zapisana firma zniknęła z listy (dezaktywowana / usunięta / brak uprawnień) → wracamy do domyślnej
        if (stored && res.can_switch && !list.some(c => c.id === stored)) {
          clearStoredCompany()
          window.location.reload()
          return
        }
        // nie‑admin: nagłówek i tak ignorowany — nie trzymaj cudzego wyboru w przeglądarce
        if (stored && !res.can_switch) clearStoredCompany()
        setCompany(res.company ?? null)
        setCompanies(list)
        setCanSwitch(!!res.can_switch)
      })
      .catch(() => {
        if (cancelled) return
        // np. zapisana firma odrzucona przez serwer → jednorazowo czyścimy klucz i ładujemy od nowa bez nagłówka
        if (getStoredCompanyId()) {
          clearStoredCompany()
          window.location.reload()
          return
        }
        setCompany(null); setCompanies([]); setCanSwitch(false)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user])

  const switchCompany = useCallback((id: string) => {
    if (!id || id === company?.id) return
    try { localStorage.setItem(COMPANY_STORAGE_KEY, id) } catch { /* ignore */ }
    // najprostsze i pewne: wszystkie listy/cachowane dane przeładują się już w nowej firmie
    window.location.reload()
  }, [company?.id])

  const value = useMemo<CompanyContextValue>(
    () => ({ company, companies, canSwitch, loading, switchCompany }),
    [company, companies, canSwitch, loading, switchCompany],
  )

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany must be used within CompanyProvider')
  return ctx
}
