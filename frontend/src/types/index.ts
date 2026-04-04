export type ProjectType = 'installation' | 'developer' | 'service' | 'purchase'
export type ProjectStatus = 'offer_submitted' | 'negotiation' | 'ordering' | 'installation' | 'closing' | 'cancelled'
export type CostCategory = 'materials' | 'subcontractor' | 'other' | 'ksef_invoice'
export type PaymentType = 'standard' | 'additional_works'

export interface Project {
  id: string
  name: string
  client_name: string
  client_contact: string
  project_type: ProjectType
  status: ProjectStatus
  budget_amount: number
  area_m2: number | null
  smart_features: string[]
  start_date: string | null
  end_date: string | null
  description: string
  created_at: string
  updated_at: string
  created_by?: string | null
  // computed
  cost_materials?: number
  cost_labor?: number
  cost_total?: number
  payments_total?: number
  margin_pln?: number
  margin_pct?: number
  // access control (non-admins)
  user_is_member?: boolean
  has_pending_request?: boolean
}

// ─── Access Requests ──────────────────────────────────────────────────────────

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected'

export interface AccessRequest {
  id: string
  project_id: string
  project_name: string
  requester_id: string
  requester_name: string
  requester_email: string
  status: AccessRequestStatus
  created_at: string
  updated_at: string
}

// ─── Notifications ────────────────────────────────────────────────────────────

export type NotificationType = 'access_request' | 'access_approved' | 'access_rejected'

export interface AppNotification {
  id: string
  user_id: string
  type: NotificationType
  message: string
  data: {
    request_id?: string
    project_id?: string
    project_name?: string
    requester_id?: string
    requester_name?: string
  }
  read: boolean
  created_at: string
}

export interface CostAuditEntry {
  id: string
  project_id: string
  action: 'add' | 'edit' | 'delete'
  entity: 'cost' | 'labor'
  entity_id: string
  description: string
  user_id: string | null
  user_name: string
  created_at: string
}

export interface ProjectDetail extends Project {
  cost_items: CostItem[]
  labor_entries: LaborEntry[]
  client_payments: ClientPayment[]
  extra_costs_count: number
}

export interface CostItem {
  id: string
  project_id: string
  category: CostCategory
  description: string
  quantity: number
  unit_price: number
  total_price: number
  supplier: string
  invoice_number: string
  date: string
  created_at: string
  attachment_filename?: string | null
  attachment_original?: string | null
}

export interface LaborEntry {
  id: string
  project_id: string
  worker_name: string
  date: string
  hours: number
  hourly_rate: number
  description: string
  created_at: string
}

export interface ClientPayment {
  id: string
  project_id: string
  amount: number
  date: string
  description: string
  invoice_number: string
  payment_type: PaymentType
  created_at: string
}

export interface Employee {
  id: string
  name: string
  hourly_rate: number
  employment_type: string
  position: string
  email: string
  phone: string
  address: string
  start_date?: string | null
  end_date?: string | null
  notes: string
  created_at: string
  updated_at: string
}

export interface EmployeeAsset {
  id: string
  employee_id: string
  asset_type: string
  name: string
  serial_no: string
  notes: string
  assigned_at: string
  created_at: string
}

export interface EmployeeDocument {
  id: string
  employee_id: string
  doc_type: string
  name: string
  file_name: string
  mime_type: string
  expires_at?: string | null
  notes: string
  uploaded_at: string
}

export interface EmployeeDetail extends Employee {
  assets: EmployeeAsset[]
  documents: EmployeeDocument[]
}

export interface DashboardStats {
  total_projects: number
  active_projects: number
  total_budget: number
  total_costs: number
  total_payments: number
  average_margin_pct: number
  over_budget_count: number
  over_budget_projects: OverBudgetProject[]
  by_status: Record<string, number>
  by_type: Record<string, number>
  recent_projects: (Project & { cost_total: number; margin_pct: number })[]
}

export interface OverBudgetProject {
  id: string
  name: string
  client_name: string
  status: ProjectStatus
  budget_amount: number
  cost_total: number
  margin_pln: number
  margin_pct: number
}

// ─── Extra Costs (koszty dodatkowe) ──────────────────────────────────────────

export type ExtraCostStatus = 'pending' | 'sent' | 'approved' | 'rejected'

export interface ExtraCost {
  id: string
  project_id: string
  description: string
  quantity: number
  unit_price: number
  total_price: number
  date: string
  is_out_of_scope: boolean   // koszt ponadprogramowy
  status: ExtraCostStatus
  notes: string
  created_at: string
  updated_at: string
}

export const EXTRA_COST_STATUS_LABELS: Record<ExtraCostStatus, string> = {
  pending:  'Oczekujący',
  sent:     'Wysłany do klienta',
  approved: 'Zaakceptowany',
  rejected: 'Odrzucony',
}

export const EXTRA_COST_STATUS_COLORS: Record<ExtraCostStatus, string> = {
  pending:  'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  sent:     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  rejected: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
}

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  installation: 'Instalacja',
  developer: 'Deweloperski',
  service: 'Serwis',
  purchase: 'Zakup sprzętu',
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  offer_submitted: '1. Złożenie oferty',
  negotiation:     '2. Negocjacje',
  ordering:        '3. Wybór i zamówienie',
  installation:    '4. Instalacja w toku',
  closing:         '5. Zamknięcie projektu',
  cancelled:       '0. Anulowanie',
}

export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  materials: 'Materiały',
  subcontractor: 'Podwykonawca',
  other: 'Inne',
  ksef_invoice: '📋 KSeF',
}

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  standard: 'Standardowa',
  additional_works: 'Prace dodatkowe',
}

// ─── AI Quote types ───────────────────────────────────────────────────────────

export type QuoteBrand = 'KNX' | 'Control4' | 'Hikvision' | 'Satel' | 'Usługi'
export type QuoteStatus = 'draft' | 'confirmed'

export interface ProductCatalogItem {
  id: string
  sku: string
  brand: QuoteBrand
  manufacturer: string
  category: string
  name: string
  unit: string
  unit_price: number
  description: string
  active: boolean
  created_at: string
  updated_at: string
  last_import?: string
}

export const KNX_MANUFACTURERS = ['HDL', 'Eelectron', 'Tyba', 'MDT'] as const
export type KnxManufacturer = typeof KNX_MANUFACTURERS[number]

export interface AiQuoteItem {
  id: string
  room: string
  brand: QuoteBrand
  category: string
  name: string
  qty: number
  unit: string
  unit_price: number
  discount_pct: number
  total: number
  catalog_item_id: string | null
  sort_order: number
}

export interface AiQuoteDescription {
  must_have: string
  nice_to_have: string
  premium: string
}

export interface AiQuote {
  id: string
  project_id: string
  status: QuoteStatus
  floor_plan_filename: string | null
  floor_plan_original: string | null
  floor_plan_filenames: string[]
  floor_plan_originals: string[]
  rooms_detected: string[]
  description?: AiQuoteDescription
  items: AiQuoteItem[]
  total_net: number
  discount_pct: number
  total_after_discount: number
  labor_cost_pct: number
  labor_cost: number
  grand_total: number
  notes: string
  tokens_input?: number | null
  tokens_output?: number | null
  cost_usd?: number | null
  name?: string | null
  created_at: string
  updated_at: string
  created_by: string
}

export const QUOTE_BRAND_COLORS: Record<QuoteBrand, string> = {
  KNX:       'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-200 dark:border-orange-700',
  Control4:  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-700',
  Hikvision: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-700',
  Satel:     'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-700',
  Usługi:    'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 border-slate-200 dark:border-slate-700',
}

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft:     'Szkic',
  confirmed: 'Zatwierdzona',
}

export const QUOTE_BRANDS: QuoteBrand[] = ['KNX', 'Control4', 'Hikvision', 'Satel', 'Usługi']

// ─── Smart features ───────────────────────────────────────────────────────────

export const SMART_FEATURES: { key: string; label: string; icon: string }[] = [
  { key: 'lighting_onoff', label: 'Oświetlenie On/Off', icon: '💡' },
  { key: 'lighting_dali', label: 'Oświetlenie DALI', icon: '🔆' },
  { key: 'blinds', label: 'Sterowanie żaluzjami/zasłonami', icon: '🪟' },
  { key: 'heating', label: 'Ogrzewanie', icon: '🌡️' },
  { key: 'ac', label: 'Klimatyzacja', icon: '❄️' },
  { key: 'recuperation', label: 'Rekuperacja', icon: '🌀' },
  { key: 'motion_sensors', label: 'Czujniki ruchu', icon: '👁️' },
  { key: 'av_audio', label: 'Nagłośnienie AV', icon: '🔊' },
  { key: 'tv', label: 'Integracja z Telewizją', icon: '📺' },
  { key: 'pergola', label: 'Sterowanie pergolą', icon: '⛱️' },
  { key: 'flood_sensors', label: 'Czujniki zalania', icon: '💧' },
  { key: 'alarm', label: 'Alarm', icon: '🚨' },
  { key: 'cctv', label: 'Monitoring CCTV', icon: '📷' },
  { key: 'pool', label: 'Sterowanie basenem', icon: '🏊' },
  { key: 'spa', label: 'Sterowanie SPA', icon: '🛁' },
  { key: 'pv', label: 'Monitoring instalacji PV', icon: '☀️' },
]


// ─── KSeF ────────────────────────────────────────────────────────────────────

export interface KsefInvoiceAllocation {
  id: string
  invoice_id: string
  project_id: string
  amount: number
  notes: string
  category: string
  created_at: string
  updated_at: string
  project?: { id: string; name: string; client_name: string }
}

export interface KsefInvoice {
  id: string
  ksef_number: string | null
  invoice_number: string | null
  seller_name: string | null
  seller_nip: string | null
  net_amount: number
  vat_amount: number
  gross_amount: number
  currency: string
  invoice_date: string | null
  acquisition_date: string | null
  project_id: string | null
  notes: string | null
  is_shared: boolean
  created_at: string
  payment_status?: 'paid' | 'unpaid' | 'partial' | null
  payment_source?: 'mt940' | 'przelewy24' | 'manual' | null
  paid_amount?: number | null
  paid_at?: string | null
  bank_tx_id?: string | null
  project?: { id: string; name: string; client_name: string } | null
  allocations?: KsefInvoiceAllocation[]
}

export interface BankTransaction {
  id: string
  source: 'mt940' | 'przelewy24'
  transaction_date: string
  amount: number
  currency: string
  description: string
  counterparty: string
  counterparty_iban?: string
  reference: string
  matched_invoice_id?: string | null
  match_confidence?: number | null
  created_at: string
}

export interface KsefStatus {
  configured: boolean
  env: string
  nip: string
  has_session: boolean
  session_expires_at: string | null
  last_sync_at: string | null
  invoice_count: number
  unassigned_count: number
}

export interface KsefSyncResult {
  fetched: number
  saved: number
  errors: string[]
}
