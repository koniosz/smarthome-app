// API strony „Kondycja firmy”: health (sekcja A), prognoza gotówki (B.5), wycena magazynu (C).
// Kontrakty zgodne z docs/finance-automation-spec.md — nie zmieniaj nazw pól bez uzgodnienia z backendem.
import { api } from './client'
import type { PnlLines } from '../types'

export type HealthKind = 'monthly' | 'quarterly'
export type HealthStatus = 'green' | 'yellow' | 'red'
export type CheckSeverity = 'error' | 'warn' | 'info'

/** Porównanie z innym okresem (poprzedni / rok temu) */
export interface HealthCmp {
  label: string
  revenue: number
  costs: number
  ebitda: number
  ebitda_pct: number
}

export interface HealthTrendPoint {
  period: string   // YYYY-MM
  label: string    // np. „Sie 26”
  revenue: number
  costs: number
  ebitda: number
}

export interface HealthCostItem {
  key: string
  label: string
  amount: number
  pct: number
}

export interface HealthTaxes {
  vat_output: number
  vat_input: number
  vat_due_estimate: number
  cit_rate: number
  cit_base_ytd: number
  cit_estimate_ytd: number
  cit_paid_ytd: number
  cit_to_pay_estimate: number
  zus: number
  note: string
}

export interface HealthCheck {
  key: string
  severity: CheckSeverity
  message: string
  count?: number
  link?: string
}

export interface BankBalanceInfo {
  account: string
  currency: string
  closing: number
  date: string
}

export interface HealthCash {
  balances: BankBalanceInfo[]
  total_pln: number | null
  receivables: number
  overdue_receivables: number
  payables: number
  overdue_payables: number
}

export interface HealthTiles {
  revenue: number
  costs: number
  ebitda: number
  ebitda_pct: number
  net_result: number
  cash: number | null
  cash_date: string | null
}

export interface HealthResponse {
  kind: HealthKind
  period: string            // '2026-08' | '2026-Q3'
  label: string             // 'Sierpień 2026' | 'III kwartał 2026'
  range: { from: string; to: string }
  status: HealthStatus
  headline: string
  subline: string
  complete: boolean
  tiles: HealthTiles
  lines: PnlLines
  compare: { prev: HealthCmp | null; yoy: HealthCmp | null }
  trend: HealthTrendPoint[]
  cost_breakdown: HealthCostItem[]
  taxes: HealthTaxes
  checks: HealthCheck[]
  cash: HealthCash
  generated_at: string
}

export interface ReportPreview {
  subject: string
  html: string
  complete: boolean
  missing: string[]
}

export interface ReportSendResult {
  sent: boolean
  status: 'sent' | 'incomplete'
  recipients: string[]
}

export interface ReportDispatch {
  id: string
  kind: HealthKind
  period: string
  status: 'sending' | 'sent' | 'incomplete' | 'failed'   // sending = w trakcie wysyłki (lub niedokończona po awarii)
  recipients: string
  summary?: unknown
  created_at: string
}

export interface ReportSettings {
  company_name: string
  reports_enabled: boolean
  report_day: number
  report_emails: string       // po przecinku
  cit_rate: number            // 9 | 19
  inventory_in_pnl: boolean
  log: ReportDispatch[]       // ostatnie 12 wysyłek, najnowsze pierwsze
}
export type ReportSettingsInput = Omit<ReportSettings, 'log'>

// ── Prognoza gotówki (B.5) ────────────────────────────────────────────────────
export interface CashflowItem {
  kind: 'receivable' | 'payable' | 'recurring'
  label: string
  amount: number
}
export interface CashflowDay {
  date: string
  inflow: number
  outflow: number
  balance: number
  items: CashflowItem[]
}
export interface CashflowEntry {
  label: string
  amount: number
  due_date: string
  overdue: boolean
}
export interface CashflowRecurring {
  label: string
  amount: number
  day_of_month: number
  subcategory: string
}
export interface CashflowResponse {
  as_of: string
  cash: { balances: BankBalanceInfo[]; total_pln: number | null }
  has_balances: boolean
  days: CashflowDay[]
  min: { date: string; balance: number }
  end_balance: number
  warnings: string[]
  receivables: CashflowEntry[]
  payables: CashflowEntry[]
  recurring: CashflowRecurring[]
}

// ── Wycena magazynu (C) ───────────────────────────────────────────────────────
export interface InventoryMonth {
  period: string
  value: number
  change: number
  unpriced_items: number
}
export interface InventoryResponse {
  year: number
  months: InventoryMonth[]
  current_value: number
  as_of: string
}

export const healthApi = {
  /** Kondycja za okres (YYYY-MM lub YYYY-Qn); bez okresu → poprzedni miesiąc */
  get: (period?: string) =>
    api.get<HealthResponse>('/finance/health', { params: period ? { period } : {} }).then(r => r.data),
  reportPreview: (kind: HealthKind, period: string) =>
    api.get<ReportPreview>('/finance/health/report-preview', { params: { kind, period } }).then(r => r.data),
  reportSend: (data: { kind: HealthKind; period: string; force?: boolean }) =>
    api.post<ReportSendResult>('/finance/health/report-send', data).then(r => r.data),
  reportSettings: () =>
    api.get<ReportSettings>('/finance/health/report-settings').then(r => r.data),
  /** Tylko admin (backend: requireAdmin) */
  saveReportSettings: (data: Partial<ReportSettingsInput>) =>
    api.put<ReportSettings>('/finance/health/report-settings', data).then(r => r.data),
}

export const cashflowApi = {
  /** days: 7–90 (domyślnie 30) */
  get: (days = 30) =>
    api.get<CashflowResponse>('/finance/cashflow', { params: { days } }).then(r => r.data),
}

export const inventoryApi = {
  get: (year: number) =>
    api.get<InventoryResponse>('/finance/inventory', { params: { year } }).then(r => r.data),
}
