/**
 * Wielofirmowość (tenant = Company). Aktywna firma trzymana w AsyncLocalStorage na czas żądania
 * (middleware/tenant.ts) albo zadania w tle (runWithCompany). Rozszerzenie Prisma automatycznie:
 *  - filtruje odczyty/aktualizacje/usunięcia modeli z company_id po aktywnej firmie,
 *  - uzupełnia company_id przy tworzeniu (aktywna firma, a bez kontekstu — firma domyślna).
 * Dzięki temu moduły (projekty, faktury, KSeF, koszty, magazyn, HR, finanse) nie muszą znać firmy.
 * Bez kontekstu (skrypty, start serwera) odczyty są globalne — zadania cykliczne iterują firmy przez forEachCompany.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { PrismaClient } from '@prisma/client'

// Modele z kolumną company_id (schema.prisma) — dzieci (koszty projektu, urlopy pracownika, alokacje faktury…)
// dziedziczą zakres po rodzicu i nie wymagają własnego filtra.
export const SCOPED_MODELS = new Set([
  'Project', 'Task', 'Employee', 'WarehouseItem', 'WarehouseLocation', 'WarehouseDoc', 'ProductCatalog',
  'AiQuote', 'AiQuoteExample', 'KsefInvoice', 'BankTransaction', 'KsefSession', 'SalesRecord', 'FixedAsset',
  'ManualCost', 'BankBalance', 'BankRule', 'CostDocument', 'AccountantStatement', 'ReportDispatch',
  'CompanySettings', 'ImapSettings', 'SalesInvoice',
])

// Modele-dzieci bez własnego company_id, odpytywane też bezpośrednio (np. lista wniosków urlopowych,
// alokacje faktur, pozycje dokumentów): zakres przez relację do rodzica z company_id.
// Wartość = ścieżka relacji do modelu z company_id (np. ClientSurveyAttachment → survey → project).
export const CHILD_SCOPES: Record<string, string[]> = {
  HandoverProtocol: ['project'], TaskAssignee: ['task'], CostItem: ['project'], LaborEntry: ['project'], ClientPayment: ['project'],
  LeaveBalance: ['employee'], LeaveRequest: ['employee'], WorkTimeEntry: ['employee'], EmployeeAsset: ['employee'], EmployeeDocument: ['employee'],
  StockMovement: ['item'], StockReservation: ['item'], WarehouseDocLine: ['doc'], ProjectMember: ['project'], ExtraCost: ['project'],
  AccessRequest: ['project'], CostAuditLog: ['project'], KsefInvoiceAllocation: ['invoice'], ProjectDocument: ['project'], ClientSurvey: ['project'],
  ClientSurveyAttachment: ['survey', 'project'],
}
function childFilter(path: string[], companyId: string): any {
  let f: any = { company_id: companyId }
  for (let i = path.length - 1; i >= 0; i--) f = { [path[i]]: f }
  return f
}

type Store = { companyId: string }
export const tenantStorage = new AsyncLocalStorage<Store>()

/** Id aktywnej firmy (undefined poza żądaniem/zadaniem z kontekstem). */
export function currentCompanyId(): string | undefined { return tenantStorage.getStore()?.companyId }

/** Uruchom funkcję w kontekście firmy (zadania w tle, skrypty). */
export function runWithCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ companyId }, fn)
}

let defaultCompanyId: string | null = null
export function setDefaultCompanyId(id: string | null) { defaultCompanyId = id }
export function getDefaultCompanyId(): string | null { return defaultCompanyId }

const WHERE_OPS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany'])
const UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete'])

/** Rozszerzenie Prisma: automatyczny zakres firmy dla SCOPED_MODELS. */
export function withTenantScope(base: PrismaClient) {
  const resolveDefault = async (): Promise<string | null> => {
    if (defaultCompanyId) return defaultCompanyId
    const c = await base.company.findFirst({ where: { is_default: true }, select: { id: true } })
    if (c) defaultCompanyId = c.id
    return defaultCompanyId
  }
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const ctx = currentCompanyId()
          const a: any = args ?? {}
          const childPath = CHILD_SCOPES[model]
          if (childPath) {
            // dziecko: tylko filtr odczytu/aktualizacji przez rodzica (tworzenie dziedziczy firmę po rodzicu)
            if (ctx && (WHERE_OPS.has(operation) || UNIQUE_OPS.has(operation) || operation === 'upsert')) {
              const f = childFilter(childPath, ctx)
              a.where = UNIQUE_OPS.has(operation) || operation === 'upsert'
                ? { ...(a.where ?? {}), ...f }
                : (a.where ? { AND: [a.where, f] } : f)
            }
            return query(a)
          }
          if (!SCOPED_MODELS.has(model)) return query(args)
          if (operation === 'create') {
            a.data = a.data ?? {}
            if (a.data.company_id === undefined) a.data.company_id = ctx ?? await resolveDefault()
          } else if (operation === 'createMany') {
            const cid = ctx ?? await resolveDefault()
            const rows = Array.isArray(a.data) ? a.data : [a.data]
            for (const r of rows) if (r && r.company_id === undefined) r.company_id = cid
          } else if (operation === 'upsert') {
            if (a.create && a.create.company_id === undefined) a.create.company_id = ctx ?? await resolveDefault()
            if (ctx) a.where = { ...(a.where ?? {}), company_id: ctx }
          } else if (ctx && WHERE_OPS.has(operation)) {
            a.where = a.where ? { AND: [a.where, { company_id: ctx }] } : { company_id: ctx }
          } else if (ctx && UNIQUE_OPS.has(operation)) {
            // Prisma 5 (extendedWhereUnique): klucz unikalny + dodatkowy filtr — cudzy rekord = „nie znaleziono”
            a.where = { ...(a.where ?? {}), company_id: ctx }
          }
          return query(a)
        },
      },
    },
  })
}
