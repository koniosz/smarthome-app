import axios from 'axios';

// ─── Base URL ────────────────────────────────────────────────────────────────
// Update this URL once your backend is deployed / you know the final address.
export const API_BASE_URL = 'https://smarthome-app-ssrv.onrender.com';

// ─── Axios instance ──────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ─── Auth token helpers ──────────────────────────────────────────────────────
export function setAuthToken(token: string): void {
  api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
}

export function clearAuthToken(): void {
  delete api.defaults.headers.common['Authorization'];
}

// ─── Types ───────────────────────────────────────────────────────────────────
export type ProjectStatus = 'active' | 'completed' | 'archived' | 'on_hold';

export interface Project {
  id: string;
  name: string;
  client_name: string;
  status: ProjectStatus;
  budget_amount: number | null;
  address: string | null;
  created_at: string;
}

export type ExtraCostStatus = 'pending' | 'sent' | 'approved' | 'rejected';

export interface ExtraCost {
  id: string;
  project_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  date: string;
  is_out_of_scope: boolean;
  status: ExtraCostStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  sent_at?: string | null;
  client_email?: string | null;
  approval_token?: string | null;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    display_name: string;
    role: string;
  };
}

export interface CreateExtraCostData {
  description: string;
  quantity: number;
  unit_price: number;
  date: string;
  is_out_of_scope: boolean;
  notes?: string;
}

export type UpdateExtraCostData = Partial<CreateExtraCostData>;

// ─── Auth API ────────────────────────────────────────────────────────────────
export const authApi = {
  login: async (email: string, password: string): Promise<LoginResponse> => {
    const response = await api.post<LoginResponse>('/api/auth/login', {
      email,
      password,
    });
    return response.data;
  },
};

// ─── Projects API ────────────────────────────────────────────────────────────
export const projectsApi = {
  list: async (): Promise<Project[]> => {
    const response = await api.get<Project[]>('/api/projects');
    return response.data;
  },

  get: async (id: string): Promise<Project> => {
    const response = await api.get<Project>(`/api/projects/${id}`);
    return response.data;
  },
};

// ─── Extra Costs API ─────────────────────────────────────────────────────────
export const extraCostsApi = {
  list: async (projectId: string): Promise<ExtraCost[]> => {
    const response = await api.get<ExtraCost[]>(
      `/api/projects/${projectId}/extra-costs`
    );
    return response.data;
  },

  create: async (
    projectId: string,
    data: CreateExtraCostData
  ): Promise<ExtraCost> => {
    const response = await api.post<ExtraCost>(
      `/api/projects/${projectId}/extra-costs`,
      data
    );
    return response.data;
  },

  update: async (
    id: string,
    data: UpdateExtraCostData
  ): Promise<ExtraCost> => {
    const response = await api.put<ExtraCost>(`/api/extra-costs/${id}`, data);
    return response.data;
  },

  remove: async (id: string): Promise<void> => {
    await api.delete(`/api/extra-costs/${id}`);
  },

  sendEmail: async (
    projectId: string,
    ids: string[],
    clientEmail: string
  ): Promise<void> => {
    await api.post(`/api/projects/${projectId}/extra-costs/send-email`, {
      ids,
      client_email: clientEmail,
    });
  },

  // Generuje token SMS — zwraca link do akceptacji
  createSmsToken: async (
    projectId: string,
    ids: string[]
  ): Promise<{ token: string; approveUrl: string; sent_at: string }> => {
    const response = await api.post(
      `/api/projects/${projectId}/extra-costs/sms-token`,
      { ids }
    );
    return response.data;
  },
};

// ─── Attachments API ─────────────────────────────────────────────────────────
export const attachmentsApi = {
  /**
   * TODO: Backend endpoint `/api/projects/:projectId/extra-costs/:id/attachment`
   * does not exist yet — add it to the Express backend before calling this.
   * The existing cost attachment endpoint is `/api/costs/:id/attachment`.
   * Once the backend endpoint is created, this helper will work as-is.
   */
  uploadForExtraCost: async (
    projectId: string,
    extraCostId: string,
    fileUri: string,
    fileName: string,
    mimeType: string
  ): Promise<void> => {
    const formData = new FormData();
    // React Native FormData accepts object with uri/name/type
    formData.append('file', {
      uri: fileUri,
      name: fileName,
      type: mimeType,
    } as unknown as Blob);

    await api.post(
      `/api/projects/${projectId}/extra-costs/${extraCostId}/attachment`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      }
    );
  },

  getUrl: (filename: string): string =>
    `${API_BASE_URL}/api/attachments/${filename}`,
};

export default api;
