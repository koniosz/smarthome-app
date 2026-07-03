import axios from 'axios'
import type {
  Project, ProjectDetail, CostItem, LaborEntry, ClientPayment, Employee, EmployeeDetail,
  EmployeeAsset, EmployeeDocument, DashboardStats,
  AiQuote, ProductCatalogItem, ExtraCost, AccessRequest, AppNotification, CostAuditEntry,
  BankTransaction, ProjectDocument, ClientSurvey, ClientSurveyAttachment, Task,
} from '../types'

const BASE = '/api'

export const api = axios.create({ baseURL: BASE })

// Attach JWT token to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('shm-token')
  if (token) {
    config.headers = config.headers || {}
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// On 401, clear token and redirect to login
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('shm-token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export const manualCostsApi = {
  list: (params?: { dateFrom?: string; dateTo?: string; cost_category?: string; source?: string }) =>
    api.get<import('../types').ManualCost[]>('/manual-costs', { params }).then(r => r.data),
  create: (data: Partial<import('../types').ManualCost>) =>
    api.post<import('../types').ManualCost>('/manual-costs', data).then(r => r.data),
  update: (id: string, data: Partial<import('../types').ManualCost>) =>
    api.put<import('../types').ManualCost>(`/manual-costs/${id}`, data).then(r => r.data),
  remove: (id: string) =>
    api.delete(`/manual-costs/${id}`).then(r => r.data),
  importMt940: (content: string) =>
    api.post<{ total_parsed: number; outgoing: number; saved: number; message: string; costs: import('../types').ManualCost[] }>(
      '/manual-costs/import-mt940', { content }
    ).then(r => r.data),
  summary: (params?: { dateFrom?: string; dateTo?: string; business_unit?: string }) =>
    api.get<{ grouped: Record<string, { total: number; subcategories: Record<string, number> }>; total: number; count: number }>(
      '/manual-costs/summary', { params }
    ).then(r => r.data),
}

export const dashboardApi = {
  get: () => api.get<DashboardStats>('/dashboard').then(r => r.data),
}

export const projectsApi = {
  list: () => api.get<Project[]>('/projects').then(r => r.data),
  get: (id: string) => api.get<ProjectDetail>(`/projects/${id}`).then(r => r.data),
  create: (data: Partial<Project>) => api.post<Project>('/projects', data).then(r => r.data),
  update: (id: string, data: Partial<Project>) => api.put<Project>(`/projects/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/projects/${id}`).then(r => r.data),
}

export const costsApi = {
  list: (projectId: string) => api.get<CostItem[]>(`/projects/${projectId}/costs`).then(r => r.data),
  create: (projectId: string, data: Partial<CostItem>) =>
    api.post<CostItem>(`/projects/${projectId}/costs`, data).then(r => r.data),
  update: (id: string, data: Partial<CostItem>) =>
    api.put<CostItem>(`/costs/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/costs/${id}`).then(r => r.data),
  auditLog: (projectId: string) =>
    api.get<CostAuditEntry[]>(`/projects/${projectId}/costs/audit-log`).then(r => r.data),
}

export const laborApi = {
  list: (projectId: string) => api.get<LaborEntry[]>(`/projects/${projectId}/labor`).then(r => r.data),
  create: (projectId: string, data: Partial<LaborEntry>) =>
    api.post<LaborEntry>(`/projects/${projectId}/labor`, data).then(r => r.data),
  update: (id: string, data: Partial<LaborEntry>) =>
    api.put<LaborEntry>(`/labor/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/labor/${id}`).then(r => r.data),
}

export const paymentsApi = {
  list: (projectId: string) => api.get<ClientPayment[]>(`/projects/${projectId}/payments`).then(r => r.data),
  create: (projectId: string, data: Partial<ClientPayment>) =>
    api.post<ClientPayment>(`/projects/${projectId}/payments`, data).then(r => r.data),
  update: (id: string, data: Partial<ClientPayment>) =>
    api.put<ClientPayment>(`/payments/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/payments/${id}`).then(r => r.data),
}

export const employeesApi = {
  list: () => api.get<Employee[]>('/employees').then(r => r.data),
  get: (id: string): Promise<EmployeeDetail> =>
    api.get(`/employees/${id}`).then(r => r.data),
  create: (data: Partial<Employee>) => api.post<Employee>('/employees', data).then(r => r.data),
  update: (id: string, data: Partial<Employee>) => api.put<Employee>(`/employees/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/employees/${id}`).then(r => r.data),
  // Assets
  addAsset: (employeeId: string, data: any): Promise<EmployeeAsset> =>
    api.post(`/employees/${employeeId}/assets`, data).then(r => r.data),
  updateAsset: (assetId: string, data: any): Promise<EmployeeAsset> =>
    api.put(`/employees/assets/${assetId}`, data).then(r => r.data),
  deleteAsset: (assetId: string): Promise<void> =>
    api.delete(`/employees/assets/${assetId}`).then(r => r.data),
  // Documents
  uploadDocument: (employeeId: string, data: any): Promise<EmployeeDocument> =>
    api.post(`/employees/${employeeId}/documents`, data).then(r => r.data),
  downloadDocument: (docId: string) =>
    api.get(`/employees/documents/${docId}/download`, { responseType: 'blob' }).then(r => r.data),
  deleteDocument: (docId: string): Promise<void> =>
    api.delete(`/employees/documents/${docId}`).then(r => r.data),
}

export const projectDocumentsApi = {
  list: (projectId: string): Promise<ProjectDocument[]> =>
    api.get(`/projects/${projectId}/documents`).then(r => r.data),

  upload: (projectId: string, data: {
    doc_type: string; name: string; file_name: string; mime_type: string; file_data: string; notes?: string
  }): Promise<ProjectDocument> =>
    api.post(`/projects/${projectId}/documents`, data).then(r => r.data),

  download: (projectId: string, docId: string): Promise<Blob> =>
    api.get(`/projects/${projectId}/documents/${docId}/download`, { responseType: 'blob' }).then(r => r.data),

  delete: (projectId: string, docId: string): Promise<void> =>
    api.delete(`/projects/${projectId}/documents/${docId}`).then(r => r.data),

  generateContract: (projectId: string, data: Record<string, any>): Promise<Blob> =>
    api.post(`/projects/${projectId}/documents/generate-contract`, data, { responseType: 'blob' }).then(r => r.data),
}

export const attachmentsApi = {
  upload: (costId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.post<CostItem>(`/costs/${costId}/attachment`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  delete: (costId: string) => api.delete(`/costs/${costId}/attachment`).then(r => r.data),
  url: (filename: string) => `/api/attachments/${filename}`,
}

export const aiQuotesApi = {
  list: (projectId: string) =>
    api.get<AiQuote[]>(`/projects/${projectId}/ai-quotes`).then(r => r.data),

  // projectId === null → wycena samodzielna (/api/quotes/:id)
  get: (projectId: string | null, quoteId: string) =>
    api.get<AiQuote>(projectId ? `/projects/${projectId}/ai-quotes/${quoteId}` : `/quotes/${quoteId}`).then(r => r.data),

  analyze: (
    projectId: string,
    files: File | File[],
    onProgress?: (pct: number) => void,
    systems?: string[],
    features?: string[],
    userNotes?: string,
  ): Promise<AiQuote> => {
    const form = new FormData()
    const fileList = Array.isArray(files) ? files : [files]
    for (const f of fileList) form.append('floor_plans', f)
    if (systems?.length) systems.forEach(s => form.append('systems', s))
    if (features?.length) features.forEach(f => form.append('features', f))
    if (userNotes) form.append('user_notes', userNotes)
    return api.post<AiQuote>(
      `/projects/${projectId}/ai-quotes/analyze`,
      form,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180_000,
        onUploadProgress: e => {
          if (onProgress && e.total) {
            onProgress(Math.round((e.loaded / e.total) * 100))
          }
        },
      },
    ).then(r => r.data)
  },

  createManual: (projectId: string, data: {
    items: Partial<import('../types').AiQuoteItem>[]
    rooms_detected: string[]
    notes?: string
    description?: { must_have?: string; nice_to_have?: string; premium?: string }
  }) =>
    api.post<AiQuote>(`/projects/${projectId}/ai-quotes/manual`, data).then(r => r.data),

  update: (projectId: string | null, quoteId: string, data: Partial<AiQuote>) =>
    api.put<AiQuote>(projectId ? `/projects/${projectId}/ai-quotes/${quoteId}` : `/quotes/${quoteId}`, data).then(r => r.data),

  delete: (projectId: string | null, quoteId: string) =>
    api.delete(projectId ? `/projects/${projectId}/ai-quotes/${quoteId}` : `/quotes/${quoteId}`).then(r => r.data),

  floorPlanUrl: (filename: string) => `/api/attachments/${filename}`,

  exportEts: (projectId: string, quoteId: string): Promise<Blob> =>
    api.get(`/projects/${projectId}/ai-quotes/${quoteId}/ets-export`, { responseType: 'blob' }).then(r => r.data),

  refine: async (projectId: string, quoteId: string, suggestion: string): Promise<AiQuote> => {
    // Backend zwraca jobId natychmiast (HTTP 202), potem pollujemy
    const { data: { jobId } } = await api.post(
      `/projects/${projectId}/ai-quotes/${quoteId}/refine`,
      { suggestion },
    )
    return pollJob(`/projects/${projectId}/ai-quotes/jobs/${jobId}`)
  },

  fromSurvey: async (projectId: string, surveyId: string): Promise<AiQuote> => {
    const { data: { jobId } } = await api.post(
      `/projects/${projectId}/ai-quotes/from-survey/${surveyId}`
    )
    return pollJob(`/projects/${projectId}/ai-quotes/jobs/${jobId}`)
  },
}

// ─── Wyceny samodzielne (bez projektu) — zakładka „Wycena" ──────────────────────
export const quotesApi = {
  list: () => api.get<AiQuote[]>('/quotes').then(r => r.data),
  create: (data: {
    name?: string
    client_name?: string
    client_contact?: string
    items?: Partial<import('../types').AiQuoteItem>[]
    rooms_detected?: string[]
    notes?: string
  }) => api.post<AiQuote>('/quotes', data).then(r => r.data),
  accept: (quoteId: string) => api.post<Project>(`/quotes/${quoteId}/accept`, {}).then(r => r.data),
  delete: (quoteId: string) => api.delete(`/quotes/${quoteId}`).then(r => r.data),
}

// ─── Magazyn (warehouse) ────────────────────────────────────────────────────────
export interface WarehouseItem {
  id: string
  name: string
  sku: string | null
  unit: string
  unit_price: number
  quantity: number
  min_quantity: number
  category: string | null
  location: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}
export interface StockMovement {
  id: string
  warehouse_item_id: string
  type: 'in' | 'out' | 'initial' | 'adjust'
  quantity: number
  unit_price: number
  reason: string | null
  project_ref: string | null
  created_by: string | null
  created_at: string
}
export const warehouseApi = {
  list: () => api.get<WarehouseItem[]>('/warehouse').then(r => r.data),
  create: (data: Partial<WarehouseItem>) => api.post<WarehouseItem>('/warehouse', data).then(r => r.data),
  update: (id: string, data: Partial<WarehouseItem>) => api.put<WarehouseItem>(`/warehouse/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/warehouse/${id}`).then(r => r.data),
  move: (id: string, data: { type: 'in' | 'out'; quantity: number; reason?: string; project_ref?: string }) =>
    api.post<WarehouseItem>(`/warehouse/${id}/move`, data).then(r => r.data),
  movements: (id: string) => api.get<StockMovement[]>(`/warehouse/${id}/movements`).then(r => r.data),
  importExcel: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post<{ imported: number }>('/warehouse/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
  // Dokumenty WZ/PZ
  docsList: () => api.get<WarehouseDoc[]>('/warehouse/docs').then(r => r.data),
  docGet: (id: string) => api.get<WarehouseDoc>(`/warehouse/docs/${id}`).then(r => r.data),
  docCreate: (data: { type: 'WZ' | 'PZ'; date?: string; contractor?: string; notes?: string; lines: WarehouseDocLineInput[] }) =>
    api.post<WarehouseDoc>('/warehouse/docs', data).then(r => r.data),
  assignDoc: (id: string, project_id: string) =>
    api.post<WarehouseDoc>(`/warehouse/docs/${id}/assign-project`, { project_id }).then(r => r.data),
}

export interface WarehouseDocLineInput {
  warehouse_item_id?: string | null
  name: string
  sku?: string | null
  quantity: number
  unit?: string
  unit_price?: number
}
export interface WarehouseDocLine extends WarehouseDocLineInput {
  id: string
  doc_id: string
  total: number
}
export interface WarehouseDoc {
  id: string
  type: 'WZ' | 'PZ'
  number: string
  date: string
  contractor: string | null
  project_id: string | null
  cost_item_id: string | null
  total_net: number
  notes: string | null
  created_by: string | null
  created_at: string
  lines?: WarehouseDocLine[]
}

// ─── Protokoły odbioru ──────────────────────────────────────────────────────────
export interface HandoverProtocol {
  id: string
  project_id: string
  number: string
  title: string | null
  scope: string | null
  status: 'draft' | 'sent' | 'accepted'
  client_email: string | null
  client_name: string | null
  client_comment: string | null
  signature: string | null
  sent_at: string | null
  accepted_at: string | null
  created_at: string
}
// ─── HR: urlopy + ewidencja czasu pracy ─────────────────────────────────────────
export type LeaveType = 'wypoczynkowy' | 'na_zadanie' | 'okolicznosciowy' | 'bezplatny' | 'opieka_dziecko' | 'opiekunczy' | 'macierzynski' | 'rodzicielski' | 'ojcowski' | 'wychowawczy' | 'chorobowe' | 'inna'
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  wypoczynkowy: 'Wypoczynkowy',
  na_zadanie: 'Na żądanie (art. 167²)',
  okolicznosciowy: 'Okolicznościowy',
  bezplatny: 'Bezpłatny (art. 174)',
  opieka_dziecko: 'Opieka nad dzieckiem (art. 188)',
  opiekunczy: 'Opiekuńczy (art. 173¹)',
  macierzynski: 'Macierzyński',
  rodzicielski: 'Rodzicielski',
  ojcowski: 'Ojcowski',
  wychowawczy: 'Wychowawczy',
  chorobowe: 'Chorobowe (L4)',
  inna: 'Inna nieobecność',
}
export interface HrLeaveBalance {
  year: number
  entitlement_days: number
  carried_over_days: number
  adjustment_days: number
  adjustment_note: string | null
  total_days: number
  used_days: number
  remaining_days: number
  on_demand_used: number
  on_demand_limit: number
}
export interface HrLeaveRequest {
  id: string
  employee_id: string
  type: LeaveType
  date_from: string
  date_to: string
  days_count: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  comment: string | null
  admin_comment: string | null
  decided_at: string | null
  created_at: string
  employee?: { id: string; name: string }
}
export interface HrWorkTimeEntry {
  id: string
  employee_id: string
  date: string
  start_time: string | null
  end_time: string | null
  break_minutes: number
  hours_worked: number
  night_hours: number
  overtime_hours: number
  duty_start: string | null
  duty_end: string | null
  duty_place: string | null
  notes: string | null
}
export interface HrEwidencja {
  employee: Employee
  month: string
  days: Array<{
    date: string
    day_of_week: number
    is_weekend: boolean
    is_holiday: boolean
    entry: HrWorkTimeEntry | null
    leave: { id: string; type: LeaveType } | null
  }>
  sums: {
    hours_worked: number
    night_hours: number
    overtime_hours: number
    days_worked: number
    leave_days_by_type: Record<string, number>
  }
}
export const hrApi = {
  me: () => api.get<{ employee: Employee | null; balance?: HrLeaveBalance; requests?: HrLeaveRequest[] }>('/hr/me').then(r => r.data),
  createLeave: (data: { type: LeaveType; date_from: string; date_to: string; comment?: string }) =>
    api.post<HrLeaveRequest>('/hr/me/leave-requests', data).then(r => r.data),
  cancelLeave: (id: string) => api.post<HrLeaveRequest>(`/hr/me/leave-requests/${id}/cancel`, {}).then(r => r.data),
  myWorkTime: (month: string) => api.get<{ entries: HrWorkTimeEntry[] }>('/hr/me/work-time', { params: { month } }).then(r => r.data),
  logWorkTime: (data: { date: string; start_time?: string; end_time?: string; break_minutes?: number; notes?: string }) =>
    api.post<HrWorkTimeEntry>('/hr/me/work-time', data).then(r => r.data),
  myEwidencja: (month: string) => api.get<HrEwidencja | null>('/hr/me/ewidencja', { params: { month } }).then(r => r.data),
  adminOverview: (year?: number) =>
    api.get<{ year: number; rows: Array<{ employee: Employee; balance: HrLeaveBalance; pending_count: number }> }>('/hr/admin/overview', { params: { year } }).then(r => r.data),
  adminRequests: (status?: string) => api.get<HrLeaveRequest[]>('/hr/admin/leave-requests', { params: { status } }).then(r => r.data),
  decide: (id: string, decision: 'approved' | 'rejected', admin_comment?: string) =>
    api.post<HrLeaveRequest>(`/hr/admin/leave-requests/${id}/decide`, { decision, admin_comment }).then(r => r.data),
  setBalance: (employeeId: string, year: number, data: { entitlement_days?: number; carried_over_days?: number; adjustment_days?: number; adjustment_note?: string }) =>
    api.put<HrLeaveBalance>(`/hr/admin/balance/${employeeId}/${year}`, data).then(r => r.data),
  adminUpsertWorkTime: (employeeId: string, data: Partial<HrWorkTimeEntry> & { date: string }) =>
    api.post<HrWorkTimeEntry>(`/hr/admin/work-time/${employeeId}`, data).then(r => r.data),
  adminEwidencja: (employeeId: string, month: string) =>
    api.get<HrEwidencja>(`/hr/admin/ewidencja/${employeeId}`, { params: { month } }).then(r => r.data),
}

export const handoverApi = {
  list: (projectId: string) => api.get<HandoverProtocol[]>(`/projects/${projectId}/handover`).then(r => r.data),
  create: (projectId: string, data: { title?: string; scope?: string; client_email?: string }) =>
    api.post<HandoverProtocol>(`/projects/${projectId}/handover`, data).then(r => r.data),
  send: (projectId: string, id: string, client_email: string) =>
    api.post<HandoverProtocol>(`/projects/${projectId}/handover/${id}/send`, { client_email }).then(r => r.data),
  delete: (projectId: string, id: string) =>
    api.delete(`/projects/${projectId}/handover/${id}`).then(r => r.data),
}

// Polling helper — odpytuje /jobs/:id co 3s max 5 minut
async function pollJob(url: string, maxMs = 5 * 60 * 1000): Promise<any> {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    const { data } = await api.get(url)
    if (data.status === 'error') throw new Error(data.error || 'Błąd AI')
    if (data.status === 'done') return data.quote ?? data.result
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error('Operacja trwa zbyt długo. Spróbuj ponownie.')
}

type TaskInput = Partial<Omit<Task, 'assignees'>> & { assignee_ids?: string[] }
export interface OutlookEvent {
  id: string
  employee_id: string
  employee_name: string
  subject: string
  date: string
  start_time: string
  end_time: string
  is_all_day: boolean
}
export const tasksApi = {
  list: () => api.get<Task[]>('/tasks').then(r => r.data),
  create: (data: TaskInput) => api.post<Task>('/tasks', data).then(r => r.data),
  update: (id: string, data: TaskInput) => api.put<Task>(`/tasks/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/tasks/${id}`).then(r => r.data),
  outlookEvents: (from: string, to: string) =>
    api.get<{ events: OutlookEvent[] }>('/tasks/outlook-events', { params: { from, to } }).then(r => r.data.events),
}

export const extraCostsApi = {
  listAll: () =>
    api.get<(ExtraCost & { project: { id: string; name: string } })[]>('/extra-costs').then(r => r.data),

  list: (projectId: string) =>
    api.get<ExtraCost[]>(`/projects/${projectId}/extra-costs`).then(r => r.data),

  create: (projectId: string, data: Partial<ExtraCost>) =>
    api.post<ExtraCost>(`/projects/${projectId}/extra-costs`, data).then(r => r.data),

  update: (id: string, data: Partial<ExtraCost>) =>
    api.put<ExtraCost>(`/extra-costs/${id}`, data).then(r => r.data),

  delete: (id: string) =>
    api.delete(`/extra-costs/${id}`).then(r => r.data),

  send: (projectId: string, ids: string[]): Promise<{ sent: number; sent_at: string }> =>
    api.post(`/projects/${projectId}/extra-costs/send`, { ids }).then(r => r.data),

  sendEmail: (projectId: string, ids: string[], client_email: string): Promise<{ sent: number; sent_at: string; email: string }> =>
    api.post(`/projects/${projectId}/extra-costs/send-email`, { ids, client_email }).then(r => r.data),
}

export const productCatalogApi = {
  list: (brand?: string, manufacturer?: string) =>
    api.get<ProductCatalogItem[]>('/product-catalog', { params: { ...(brand ? { brand } : {}), ...(manufacturer ? { manufacturer } : {}) } }).then(r => r.data),

  listAll: () =>
    api.get<ProductCatalogItem[]>('/product-catalog/all').then(r => r.data),

  create: (data: Partial<ProductCatalogItem>) =>
    api.post<ProductCatalogItem>('/product-catalog', data).then(r => r.data),

  update: (id: string, data: Partial<ProductCatalogItem>) =>
    api.put<ProductCatalogItem>(`/product-catalog/${id}`, data).then(r => r.data),

  delete: (id: string) =>
    api.delete(`/product-catalog/${id}`).then(r => r.data),

  deletePricelist: (brand: string, manufacturer: string) =>
    api.delete('/product-catalog/pricelist', { params: { brand, manufacturer } })
      .then(r => r.data as { success: boolean; deleted: number; brand: string; manufacturer: string }),

  seed: () =>
    api.post<{ seeded?: number; already_seeded?: boolean; count?: number }>('/product-catalog/seed').then(r => r.data),

  getManufacturers: () =>
    api.get<Record<string, string[]>>('/product-catalog/manufacturers').then(r => r.data),

  importPricelist: (
    file: File,
    brand: string,
    manufacturer: string,
    onProgress?: (pct: number) => void,
  ): Promise<{ imported: number; replaced: number; brand: string; manufacturer: string }> => {
    const form = new FormData()
    form.append('file', file)
    form.append('brand', brand)
    form.append('manufacturer', manufacturer)
    return api.post('/product-catalog/import', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180_000,
      onUploadProgress: e => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 50))
      },
    }).then(r => r.data)
  },
}

export const bankApi = {
  importMT940: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post<{ imported: number; transactions: BankTransaction[] }>(
      '/bank/import-mt940', fd, { headers: { 'Content-Type': 'multipart/form-data' } }
    ).then(r => r.data)
  },
  match: () =>
    api.post<{ matched: number; details: any[] }>('/bank/match').then(r => r.data),
  transactions: (params?: { source?: string; matched?: string }) =>
    api.get<BankTransaction[]>('/bank/transactions', { params }).then(r => r.data),
  clearTransactions: () =>
    api.delete('/bank/transactions').then(r => r.data),
  p24Status: () =>
    api.get<{ configured: boolean; sandbox: boolean; merchantId: string }>('/bank/przelewy24/status').then(r => r.data),
  p24Sync: () =>
    api.post<{ imported: number; transactions: BankTransaction[] }>('/bank/przelewy24/sync').then(r => r.data),
  updatePayment: (invoiceId: string, status: 'paid' | 'unpaid', paidAmount?: number, paidAt?: string) =>
    api.patch(`/ksef/invoices/${invoiceId}/payment`, { status, paid_amount: paidAmount, paid_at: paidAt }).then(r => r.data),
}

export const accessRequestsApi = {
  request: (projectId: string) =>
    api.post<AccessRequest>('/access-requests', { project_id: projectId }).then(r => r.data),

  list: () =>
    api.get<AccessRequest[]>('/access-requests').then(r => r.data),

  approve: (id: string) =>
    api.put<AccessRequest>(`/access-requests/${id}`, { status: 'approved' }).then(r => r.data),

  reject: (id: string) =>
    api.put<AccessRequest>(`/access-requests/${id}`, { status: 'rejected' }).then(r => r.data),
}

export const notificationsApi = {
  list: () =>
    api.get<AppNotification[]>('/notifications').then(r => r.data),

  unreadCount: () =>
    api.get<{ count: number }>('/notifications/unread-count').then(r => r.data.count),

  markRead: (ids?: string[]) =>
    api.put('/notifications/read', { ids }).then(r => r.data),
}

export const ksefApi = {
  status: () =>
    api.get<import('../types').KsefStatus>('/ksef/status').then(r => r.data),

  sync: (dateFrom?: string) =>
    api.post<import('../types').KsefSyncResult>('/ksef/sync', dateFrom ? { dateFrom } : {}).then(r => r.data),

  invoices: (params?: { assigned?: boolean; payment_status?: string; direction?: string; search?: string; page?: number; limit?: number }) =>
    api.get<{ invoices: import('../types').KsefInvoice[]; total: number; page: number; limit: number }>(
      '/ksef/invoices', { params }
    ).then(r => r.data),

  assign: (id: string, project_id: string | null, notes?: string) =>
    api.patch<import('../types').KsefInvoice>(`/ksef/invoices/${id}/assign`, { project_id, notes }).then(r => r.data),

  updateNotes: (id: string, notes: string) =>
    api.patch<import('../types').KsefInvoice>(`/ksef/invoices/${id}/notes`, { notes }).then(r => r.data),

  remove: (id: string) =>
    api.delete(`/ksef/invoices/${id}`).then(r => r.data),

  removeAll: () =>
    api.delete<{ success: boolean; deleted: number }>('/ksef/invoices').then(r => r.data),

  getXml: (id: string) =>
    api.get<string>(`/ksef/invoices/${id}/xml`, { responseType: 'text' }).then(r => r.data),

  debugAuth: () =>
    api.get<Record<string, any>>('/ksef/debug-auth').then(r => r.data),

  share: (id: string, is_shared: boolean) =>
    api.patch<import('../types').KsefInvoice>(`/ksef/invoices/${id}/share`, { is_shared }).then(r => r.data),

  sharedInvoices: (params?: { search?: string; page?: number; limit?: number }) =>
    api.get<{ invoices: import('../types').KsefInvoice[]; total: number; page: number; limit: number }>(
      '/ksef/shared', { params }
    ).then(r => r.data),

  getSharedXml: (id: string) =>
    api.get<string>(`/ksef/shared/${id}/xml`, { responseType: 'text' }).then(r => r.data),

  lineItems: (id: string) =>
    api.get<{ items: import('../types').KsefLineItem[] }>(`/ksef/invoices/${id}/line-items`).then(r => r.data.items),

  sharedLineItems: (id: string) =>
    api.get<{ items: import('../types').KsefLineItem[] }>(`/ksef/shared/${id}/line-items`).then(r => r.data.items),

  assignShared: (id: string, body: { project_id?: string | null; company_cost?: boolean; notes?: string }) =>
    api.patch<import('../types').KsefInvoice>(`/ksef/shared/${id}/assign`, body).then(r => r.data),

  updatePayment: (invoiceId: string, status: 'paid' | 'unpaid', paidAmount?: number, paidAt?: string) =>
    api.patch(`/ksef/invoices/${invoiceId}/payment`, { status, paid_amount: paidAmount, paid_at: paidAt }).then(r => r.data),

  // Alokacje
  getAllocations: (invoiceId: string) =>
    api.get<import('../types').KsefInvoiceAllocation[]>(`/ksef/invoices/${invoiceId}/allocations`).then(r => r.data),
  addAllocation: (
    invoiceId: string,
    project_id: string | null,
    amount: number,
    notes?: string,
    category?: string,
    allocation_type?: string,
    cost_category?: string,
    subcategory?: string,
    business_unit?: string,
  ) =>
    api.post<import('../types').KsefInvoiceAllocation>(`/ksef/invoices/${invoiceId}/allocations`,
      { project_id, amount, notes, category, allocation_type, cost_category, subcategory, business_unit }
    ).then(r => r.data),
  updateAllocation: (
    allocationId: string,
    amount: number,
    notes?: string,
    category?: string,
    is_paid?: boolean,
    cost_category?: string,
    subcategory?: string,
    business_unit?: string,
  ) =>
    api.patch<import('../types').KsefInvoiceAllocation>(`/ksef/allocations/${allocationId}`,
      { amount, notes, category, is_paid, cost_category, subcategory, business_unit }
    ).then(r => r.data),
  deleteAllocation: (allocationId: string) =>
    api.delete(`/ksef/allocations/${allocationId}`).then(r => r.data),

  setPaymentDueDate: (id: string, payment_due_date: string | null) =>
    api.patch(`/ksef/invoices/${id}/due-date`, { payment_due_date }).then(r => r.data),

  toggleInternalAllocationPaid: (allocationId: string, is_paid: boolean) =>
    api.patch(`/ksef/allocations/${allocationId}`, { is_paid }).then(r => r.data),

  dueToday: () =>
    api.get('/ksef/invoices/due-today').then(r => r.data),

  confirmSuggestion: (id: string, create_payment = false) =>
    api.post<import('../types').KsefInvoice>(`/ksef/invoices/${id}/confirm-suggestion`, { create_payment }).then(r => r.data),

  dismissSuggestion: (id: string) =>
    api.post<import('../types').KsefInvoice>(`/ksef/invoices/${id}/dismiss-suggestion`).then(r => r.data),

  reSuggest: () =>
    api.post<{ processed: number; suggested: number }>('/ksef/invoices/re-suggest').then(r => r.data),

  learnClassify: () =>
    api.post<{ total: number; classified: number; skipped: number; message: string }>('/ksef/invoices/learn-classify').then(r => r.data),

  fixDirections: () =>
    api.post<{ total: number; fixed: number; our_nip_masked: string }>('/ksef/invoices/fix-directions').then(r => r.data),

  toggleDirection: (id: string) =>
    api.patch<import('../types').KsefInvoice>(`/ksef/invoices/${id}/toggle-direction`).then(r => r.data),

  pnl: (params?: { dateFrom?: string; dateTo?: string; business_unit?: string; revenue_source?: 'payments' | 'ksef' | 'both' }) =>
    api.get<import('../types').PnLReport>('/ksef/pnl', { params }).then(r => r.data),

  resetSession: () =>
    api.post<{ success: boolean; message?: string; error?: string }>('/ksef/session/reset').then(r => r.data),
}

export const surveyApi = {
  list: (projectId: string) =>
    api.get<ClientSurvey[]>(`/projects/${projectId}/surveys`).then(r => r.data),
  create: (projectId: string, data: { client_email: string; client_name: string; notes?: string }) =>
    api.post<ClientSurvey>(`/projects/${projectId}/surveys`, data).then(r => r.data),
  get: (projectId: string, id: string) =>
    api.get<ClientSurvey>(`/projects/${projectId}/surveys/${id}`).then(r => r.data),
  update: (projectId: string, id: string, data: Partial<ClientSurvey>) =>
    api.put<ClientSurvey>(`/projects/${projectId}/surveys/${id}`, data).then(r => r.data),
  delete: (projectId: string, id: string) =>
    api.delete(`/projects/${projectId}/surveys/${id}`).then(r => r.data),
  send: (projectId: string, id: string) =>
    api.post<ClientSurvey>(`/projects/${projectId}/surveys/${id}/send`).then(r => r.data),
  downloadAttachment: (projectId: string, surveyId: string, attachId: string) =>
    api.get(`/projects/${projectId}/surveys/${surveyId}/attachments/${attachId}/download`, { responseType: 'blob' }).then(r => r.data),
  // Public endpoints (no auth)
  publicGet: (token: string) =>
    api.get<{ survey: ClientSurvey; project_name: string }>(`/surveys/public/${token}`).then(r => r.data),
  publicSubmit: (token: string, responses: Record<string, any>) =>
    api.post(`/surveys/public/${token}/submit`, { responses }).then(r => r.data),
  publicAddAttachment: (token: string, data: { file_name: string; mime_type: string; file_data: string; file_size: number }) =>
    api.post<ClientSurveyAttachment>(`/surveys/public/${token}/attachments`, data).then(r => r.data),
}
