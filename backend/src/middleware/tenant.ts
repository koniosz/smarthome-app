/**
 * Middleware aktywnej firmy (tenant). Po requireAuth: czyta nagłówek X-Company-Id, sprawdza, czy firma
 * istnieje i jest aktywna, pilnuje uprawnień (nie-admin jest przypięty do swojej firmy z User.company_id,
 * admin przełącza dowolnie) i uruchamia resztę łańcucha w kontekście tenantStorage.
 * Bez nagłówka → firma domyślna. Odpowiedź niesie X-Company-Id, żeby frontend wiedział, co faktycznie obowiązuje.
 */
import { Request, Response, NextFunction } from 'express'
import { basePrisma } from '../db'
import { tenantStorage, runWithCompany, setDefaultCompanyId } from '../tenant'

declare global {
  namespace Express {
    interface Request { companyId?: string }
  }
}

const TTL = 30_000
let companiesCache: { at: number; list: any[] } | null = null
const homeCache = new Map<string, { at: number; companyId: string | null }>()

export async function activeCompanies(force = false): Promise<any[]> {
  if (force || !companiesCache || Date.now() - companiesCache.at > TTL) {
    const list = await basePrisma.company.findMany({ where: { active: true }, orderBy: [{ is_default: 'desc' }, { name: 'asc' }] })
    companiesCache = { at: Date.now(), list }
    const def = list.find(c => c.is_default)
    if (def) setDefaultCompanyId(def.id)
  }
  return companiesCache.list
}
export function invalidateCompanyCache() { companiesCache = null; homeCache.clear() }

async function homeCompanyId(userId: string): Promise<string | null> {
  const hit = homeCache.get(userId)
  if (hit && Date.now() - hit.at < TTL) return hit.companyId
  const u = await basePrisma.user.findUnique({ where: { id: userId }, select: { company_id: true } })
  const companyId = u?.company_id ?? null
  homeCache.set(userId, { at: Date.now(), companyId })
  return companyId
}

/** Firmy, między którymi dany użytkownik może się przełączać. */
export async function companiesForUser(user: { id: string; role: string } | undefined): Promise<{ companies: any[]; home: any | null }> {
  const list = await activeCompanies()
  const def = list.find(c => c.is_default) ?? list[0] ?? null
  if (!user) return { companies: [], home: def }
  if (user.role === 'admin') return { companies: list, home: def }
  const homeId = await homeCompanyId(user.id)
  const home = list.find(c => c.id === homeId) ?? def
  return { companies: home ? [home] : [], home }
}

export async function tenantMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { companies, home } = await companiesForUser(req.user)
    if (!home) { next(); return } // brak firm (pierwszy start) — bez zakresu
    const wanted = String(req.headers['x-company-id'] || '')
    const company = companies.find(c => c.id === wanted) ?? home
    req.companyId = company.id
    _res.setHeader('X-Company-Id', company.id)
    tenantStorage.run({ companyId: company.id }, () => next())
  } catch (e) {
    console.error('[tenant]', e)
    next()
  }
}

/** Zadania w tle: wykonaj fn dla każdej aktywnej firmy w jej kontekście (błąd jednej nie przerywa reszty). */
export async function forEachCompany(fn: (company: any) => Promise<void>): Promise<void> {
  const list = await activeCompanies(true)
  for (const c of list) {
    try { await runWithCompany(c.id, () => fn(c)) }
    catch (e: any) { console.error(`[tenant] zadanie dla firmy ${c.name}:`, e?.message ?? e) }
  }
}
