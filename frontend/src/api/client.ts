import axios from 'axios'
import type {
  Project, ProjectDetail, CostItem, LaborEntry, ClientPayment, Employee, DashboardStats,
  AiQuote, ProductCatalogItem, ExtraCost, AccessRequest, AppNotification, CostAuditEntry,
} from '../types'

const BASE = '/api'

const api = axios.create({ baseURL: BASE })

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
  create: (data: Partial<Employee>) => api.post<Employee>('/employees', data).then(r => r.data),
  update: (id: string, data: Partial<Employee>) => api.put<Employee>(`/employees/${id}`, data).then(r => r.data),
  delete: (id: string) => api.delete(`/employees/${id}`).then(r => r.data),
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

  get: (projectId: string, quoteId: string) =>
    api.get<AiQuote>(`/projects/${projectId}/ai-quotes/${quoteId}`).then(r => r.data),

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

  update: (projectId: string, quoteId: string, data: Partial<AiQuote>) =>
    api.put<AiQuote>(`/projects/${projectId}/ai-quotes/${quoteId}`, data).then(r => r.data),

  delete: (projectId: string, quoteId: string) =>
    api.delete(`/projects/${projectId}/ai-quotes/${quoteId}`).then(r => r.data),

  floorPlanUrl: (filename: string) => `/api/attachments/${filename}`,

  exportEts: (projectId: string, quoteId: string): Promise<Blob> =>
    api.get(`/projects/${projectId}/ai-quotes/${quoteId}/ets-export`, { responseType: 'blob' }).then(r => r.data),

  refine: (projectId: string, quoteId: string, suggestion: string): Promise<AiQuote> =>
    api.post<AiQuote>(
      `/projects/${projectId}/ai-quotes/${quoteId}/refine`,
      { suggestion },
      { timeout: 120_000 },
    ).then(r => r.data),
}

export const extraCostsApi = {
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
