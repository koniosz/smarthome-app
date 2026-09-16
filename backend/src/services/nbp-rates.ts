/**
 * Kursy średnie NBP (tabela A) do przeliczania dokumentów kosztowych w walucie obcej.
 *
 * Zasada podatkowa: koszt w walucie przelicza się po kursie średnim NBP z OSTATNIEGO DNIA
 * ROBOCZEGO POPRZEDZAJĄCEGO datę dokumentu. NBP nie publikuje tabel w weekendy i święta,
 * więc cofamy się dzień po dniu (max 10 dni) aż API zwróci tabelę (404 = brak tabeli tego dnia).
 *
 * Wynik trafia do cache'u w pamięci (klucz: waluta|data dokumentu). Błąd sieci / brak kursu
 * → `{ rate: 0, date: '' }` — funkcja nigdy nie rzuca (wywołujący decyduje, co z zerem zrobić).
 */
import axios from 'axios'

export interface NbpRate {
  rate: number   // kurs średni (0 = nie udało się pobrać)
  date: string   // data tabeli NBP (YYYY-MM-DD), '' gdy brak
}

const NBP_TIMEOUT_MS = 8000
const MAX_LOOKBACK_DAYS = 10

const cache = new Map<string, NbpRate>()

/** Czyści cache (na potrzeby testów / ręcznego odświeżenia). */
export function clearNbpCache(): void {
  cache.clear()
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseDocDate(docDate: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(docDate ?? ''))
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    if (!Number.isNaN(d.getTime())) return d
  }
  // Brak/niepoprawna data dokumentu → liczymy od dziś
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Zwraca kurs średni NBP waluty `currency` z ostatniego dnia roboczego przed `docDate`.
 * PLN → `{ rate: 1, date: docDate }`.
 */
export async function getNbpRate(currency: string, docDate: string): Promise<NbpRate> {
  const cur = String(currency ?? 'PLN').trim().toUpperCase()
  if (!cur || cur === 'PLN') return { rate: 1, date: docDate }
  if (!/^[A-Z]{3}$/.test(cur)) return { rate: 0, date: '' }

  const base = parseDocDate(docDate)
  const key = `${cur}|${toIsoDate(base)}`
  const cached = cache.get(key)
  if (cached) return cached

  for (let back = 1; back <= MAX_LOOKBACK_DAYS; back++) {
    const probe = toIsoDate(new Date(base.getTime() - back * 86_400_000))
    const url = `https://api.nbp.pl/api/exchangerates/rates/a/${cur}/${probe}/`
    try {
      const resp = await axios.get(url, {
        params: { format: 'json' },
        timeout: NBP_TIMEOUT_MS,
        validateStatus: (s) => s === 200 || s === 404,
      })
      if (resp.status === 404) continue // brak tabeli tego dnia (weekend/święto) — cofamy się dalej
      const row = resp.data?.rates?.[0]
      const rate = Number(row?.mid)
      const date = String(row?.effectiveDate ?? probe)
      if (Number.isFinite(rate) && rate > 0) {
        const result = { rate, date }
        cache.set(key, result)
        return result
      }
      // Odpowiedź 200 bez kursu — traktuj jak brak
      continue
    } catch (e: any) {
      // Błąd sieci / timeout — nie próbuj 10× po 8 s; zwróć zero, wywołujący pokaże ostrzeżenie
      console.error('[NBP] Błąd pobierania kursu', cur, probe, e?.message ?? e)
      return { rate: 0, date: '' }
    }
  }
  return { rate: 0, date: '' }
}
