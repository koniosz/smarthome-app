// API skrzynki kosztów spoza KSeF: dokumenty (sekcja D), reguły bankowe (sekcja B), IMAP (sekcja D).
// Kontrakty wg docs/finance-automation-spec.md — nazwy pól i ścieżki 1:1 z backendem.
import { api } from './client'
import type { CostCategory, BusinessUnit, PnlMode } from '../constants/costTaxonomy'

// ── Typy: dokumenty kosztowe ──────────────────────────────────────────────────
export type CostDocumentStatus = 'pending' | 'approved' | 'rejected' | 'processing' | 'error'
export type CostDocumentSource = 'upload' | 'email' | 'mobile'
export type CostDocumentFilter = 'pending' | 'approved' | 'rejected' | 'error' | 'all'

export interface CostDocument {
  id: string
  source: CostDocumentSource | string
  status: CostDocumentStatus | string
  file_name: string
  mime_type: string
  extracted?: unknown
  extract_error: string
  seller_name: string
  seller_nip: string
  seller_country: string
  doc_number: string
  doc_date: string          // YYYY-MM-DD
  currency: string          // ISO-3
  net: number               // w walucie dokumentu
  vat: number
  gross: number
  fx_rate: number           // kurs NBP (0 = brak kursu)
  fx_date: string
  net_pln: number
  gross_pln: number
  cost_category: CostCategory | string
  subcategory: string
  business_unit: BusinessUnit | string
  is_receipt: boolean
  confidence: number        // 0–1
  duplicate_of: string      // 'ksef:<id>' | 'mt940:<id>' | 'document:<id>' | ''
  duplicate_note: string
  manual_cost_id?: string | null
  email_from: string
  email_subject: string
  email_uid?: string
  notes: string
  created_by: string
  created_at: string
  reviewed_by: string
  reviewed_at: string
}

export interface CostDocumentStats {
  pending: number
  error: number
  approved_30d: number
}

/** Pola edytowalne przez PUT /cost-documents/:id i jako override w approve. */
export interface CostDocumentEdit {
  seller_name?: string
  seller_nip?: string
  doc_number?: string
  doc_date?: string
  currency?: string
  net?: number
  vat?: number
  gross?: number
  cost_category?: string
  subcategory?: string
  business_unit?: string
  notes?: string
  is_receipt?: boolean
}

export interface ApproveConflict {
  error: string
  duplicate_of: string
  duplicate_note: string
}

/**
 * Zwraca dane konfliktu duplikatu z błędu axios, albo null gdy to inny błąd.
 * Backend odpowiada 409 także bez `duplicate_of` („Dokument jest już zatwierdzony” przy
 * PUT /:id, POST /:id/approve, POST /:id/reextract) — takie 409 NIE jest duplikatem
 * i ma trafić do `errorMessage(e, …)`, żeby pokazać prawdziwy komunikat backendu.
 */
export function approveConflict(e: unknown): ApproveConflict | null {
  const err = e as { response?: { status?: number; data?: Partial<ApproveConflict> } }
  if (err?.response?.status !== 409) return null
  const d = err.response.data ?? {}
  if (typeof d.duplicate_of !== 'string' || !d.duplicate_of) return null
  return {
    error: d.error ?? 'Ten dokument wygląda na duplikat.',
    duplicate_of: d.duplicate_of,
    duplicate_note: d.duplicate_note ?? '',
  }
}

// POST / i POST /:id/reextract odpowiadają 202 natychmiast (status 'processing'); ekstrakcja AI
// idzie w tle — klient odpytuje GET /cost-documents/:id aż status ≠ 'processing'.
const EXTRACT_TIMEOUT_MS = 30_000

export const costDocumentsApi = {
  list: (status: CostDocumentFilter = 'pending') =>
    api.get<CostDocument[]>('/cost-documents', { params: { status } }).then(r => r.data),
  stats: () =>
    api.get<CostDocumentStats>('/cost-documents/stats').then(r => r.data),
  mine: () =>
    api.get<CostDocument[]>('/cost-documents/mine').then(r => r.data),
  /** Pojedynczy dokument bez file_data — do odpytywania po 202 (status 'processing'). */
  get: (id: string) =>
    api.get<CostDocument>(`/cost-documents/${id}`).then(r => r.data),
  upload: (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return api.post<CostDocument>('/cost-documents', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: EXTRACT_TIMEOUT_MS,
    }).then(r => r.data)
  },
  /** Binarny plik dokumentu (blob → URL.createObjectURL). */
  file: (id: string) =>
    api.get<Blob>(`/cost-documents/${id}/file`, { responseType: 'blob' }).then(r => r.data),
  update: (id: string, data: CostDocumentEdit) =>
    api.put<CostDocument>(`/cost-documents/${id}`, data).then(r => r.data),
  /**
   * 409 z `duplicate_of` → duplikat: użyj `approveConflict(e)`; `force: true` zatwierdza mimo to.
   * 409 bez `duplicate_of` (dokument już zatwierdzony) → `approveConflict` zwraca null → zwykły błąd.
   */
  approve: (id: string, data: CostDocumentEdit & { force?: boolean } = {}) =>
    api.post<CostDocument>(`/cost-documents/${id}/approve`, data).then(r => r.data),
  reject: (id: string, reason?: string) =>
    api.post<CostDocument>(`/cost-documents/${id}/reject`, { reason: reason ?? '' }).then(r => r.data),
  reextract: (id: string) =>
    api.post<CostDocument>(`/cost-documents/${id}/reextract`, {}, { timeout: EXTRACT_TIMEOUT_MS }).then(r => r.data),
  remove: (id: string) =>
    api.delete(`/cost-documents/${id}`).then(r => r.data),
}

// ── Typy: reguły bankowe ──────────────────────────────────────────────────────
export type BankRuleMatchField = 'counterparty' | 'description' | 'any'
export type BankRulePnlMode = Extract<PnlMode, 'include' | 'exclude'>

export interface BankRule {
  id: string
  name: string
  pattern: string
  match_field: BankRuleMatchField | string
  cost_category: CostCategory | string
  subcategory: string
  business_unit: BusinessUnit | string
  pnl_mode: BankRulePnlMode | string
  hits: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface BankRuleInput {
  name: string
  pattern: string
  match_field?: BankRuleMatchField
  cost_category: string
  subcategory: string
  business_unit?: string
  pnl_mode?: BankRulePnlMode
}

export interface BankRulesApplyResult {
  updated: number
  by_rule: Record<string, number>
}

export interface UnmatchedTransfer {
  id: string
  date: string
  amount: number
  description: string
  reference: string
  subcategory: string
  cost_category: string
  pnl_mode: PnlMode | string
  suggested_pattern: string
}

export interface UnmatchedCostPatch {
  pnl_mode?: PnlMode
  cost_category?: string
  subcategory?: string
  business_unit?: string
}

export const bankRulesApi = {
  list: () =>
    api.get<BankRule[]>('/finance/bank-rules').then(r => r.data),
  /** 409 gdy identyczny `pattern` już istnieje. */
  create: (data: BankRuleInput) =>
    api.post<BankRule>('/finance/bank-rules', data).then(r => r.data),
  update: (id: string, data: Partial<BankRuleInput>) =>
    api.put<BankRule>(`/finance/bank-rules/${id}`, data).then(r => r.data),
  remove: (id: string) =>
    api.delete(`/finance/bank-rules/${id}`).then(r => r.data),
  apply: (overwrite = false) =>
    api.post<BankRulesApplyResult>('/finance/bank-rules/apply', { overwrite }).then(r => r.data),
  unmatched: (from: string, to: string) =>
    api.get<UnmatchedTransfer[]>('/finance/bank-rules/unmatched', { params: { from, to } }).then(r => r.data),
  /** Jednorazowa decyzja dla jednego przelewu (bez tworzenia reguły). */
  patchCost: (id: string, data: UnmatchedCostPatch) =>
    api.patch<UnmatchedTransfer | { ok: boolean }>(`/finance/bank-rules/cost/${id}`, data).then(r => r.data),
}

// ── Typy: skrzynka IMAP ───────────────────────────────────────────────────────
export const IMAP_PASSWORD_MASK = '••••••••'

export interface ImapSettings {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  pass: string            // maska '••••••••' gdy hasło jest ustawione
  folder: string
  last_uid: number
  last_checked_at: string
  last_error: string
  updated_at: string
}

export type ImapSettingsInput = Pick<ImapSettings, 'enabled' | 'host' | 'port' | 'secure' | 'user' | 'pass' | 'folder'>

export interface ImapTestResult {
  ok: boolean
  mailbox?: { exists: number; unseen: number }
  error?: string
}

export interface ImapCheckResult {
  fetched: number
  created: number
  skipped: number
  error?: string
}

export const imapSettingsApi = {
  get: () =>
    api.get<ImapSettings>('/settings/imap').then(r => r.data),
  update: (data: ImapSettingsInput) =>
    api.put<ImapSettings>('/settings/imap', data).then(r => r.data),
  test: () =>
    api.post<ImapTestResult>('/settings/imap/test', {}, { timeout: 30_000 }).then(r => r.data),
  checkNow: () =>
    api.post<ImapCheckResult>('/settings/imap/check-now', {}, { timeout: 180_000 }).then(r => r.data),
}
