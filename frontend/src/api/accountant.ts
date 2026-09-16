// Zestawienie obrotów i sald od księgowej — API klienta (kontrakt: docs/finance-automation-spec.md, sekcja E)
import { api } from './client'

/** Linie RZiS po stronie księgowej, zmapowane z ZOiS (konta zespołu 4/5 i 7). */
export interface AccountantLines {
  revenue: number          // 70x–74x: Ma − Wn
  cogs: number             // 701, 711, 731, 741 lub konto 7xx „koszt…”/„wartość sprzedanych…”: Wn − Ma (w costs_total)
  other_revenue: number    // 750, 760: Ma − Wn
  depreciation: number     // 400
  materials: number        // 401
  services: number         // 402
  taxes_fees: number       // 403
  salaries: number         // 404
  social: number           // 405
  other_costs: number      // 406–409 oraz 761 (albo zespół 5, gdy brak 4)
  financial_costs: number  // 751
  cit: number              // 870–879: Wn − Ma
  costs_total: number
  result: number
  source_classes: '4' | '5'
  warnings: string[]
}

/** Wykryte kolumny pliku ZOiS (indeksy kolumn / wiersza nagłówka). */
export interface ZoisDetected {
  account_col: number
  name_col: number
  debit_col: number
  credit_col: number
  header_row: number
  has_period_and_ytd: boolean
}

export type AccountantMode = 'monthly' | 'ytd'

export interface AccountantImportResult {
  period: string
  mode: AccountantMode
  lines: AccountantLines
  rows_count: number
  detected: ZoisDetected
  warnings: string[]
  dry_run: boolean
  saved: boolean
}

export interface AccountantStatementSummary {
  period: string
  mode: AccountantMode
  revenue: number
  costs: number
  result: number
  file_name: string
  created_at: string
}

export interface AccountantCompareLine {
  key: string
  label: string
  ours: number
  theirs: number
  diff: number
}

export interface AccountantCompareResponse {
  period: string
  ours: {
    revenue: number
    depreciation: number
    salaries_social: number
    cit: number
    other_costs: number
    costs_total: number
    result: number
  }
  theirs: AccountantLines
  by_line: AccountantCompareLine[]
  verdict: 'ok' | 'check'
  threshold: number
  hints: string[]
}

export const accountantApi = {
  /** Import pliku CSV/XLSX. `dryRun=true` → tylko podgląd (nic nie zapisuje). */
  import: (file: File, period: string, mode: AccountantMode, dryRun: boolean): Promise<AccountantImportResult> => {
    const form = new FormData()
    form.append('file', file)
    form.append('period', period)
    form.append('mode', mode)
    form.append('dry_run', dryRun ? 'true' : 'false')
    return api.post('/finance/accountant/import', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
  list: (): Promise<AccountantStatementSummary[]> =>
    api.get('/finance/accountant').then(r => r.data),
  remove: (period: string): Promise<void> =>
    api.delete(`/finance/accountant/${period}`).then(r => r.data),
  compare: (period: string): Promise<AccountantCompareResponse> =>
    api.get(`/finance/accountant/${period}/compare`).then(r => r.data),
  /** Porównanie z obsługą 404 → null (brak zestawienia za okres). Inne błędy rzucają dalej. */
  compareOrNull: async (period: string): Promise<AccountantCompareResponse | null> => {
    try {
      return await accountantApi.compare(period)
    } catch (e: any) {
      if (e?.response?.status === 404) return null
      throw e
    }
  },
}
