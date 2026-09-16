// Okresy strony „Kondycja firmy”: 'YYYY-MM' (miesiąc) lub 'YYYY-Qn' (kwartał)
import type { HealthKind } from '../../api/health'

const MONTHS_PL = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień']
const ROMAN = ['I', 'II', 'III', 'IV']

export function isQuarter(period: string): boolean {
  return /^\d{4}-Q[1-4]$/.test(period)
}

export function kindOf(period: string): HealthKind {
  return isQuarter(period) ? 'quarterly' : 'monthly'
}

export function yearOf(period: string): number {
  return parseInt(period.slice(0, 4), 10)
}

/** Domyślny okres = poprzedni miesiąc */
export function defaultPeriod(now = new Date()): string {
  const y = now.getFullYear()
  const m = now.getMonth() // 0-11 → poprzedni miesiąc = m (1-based: m)
  if (m === 0) return `${y - 1}-12`
  return `${y}-${String(m).padStart(2, '0')}`
}

/** Przesunięcie okresu o n miesięcy / kwartałów (ujemne = wstecz) */
export function shiftPeriod(period: string, delta: number): string {
  if (isQuarter(period)) {
    const y = yearOf(period)
    const q = parseInt(period.slice(6), 10)
    const idx = y * 4 + (q - 1) + delta
    return `${Math.floor(idx / 4)}-Q${(idx % 4 + 4) % 4 + 1}`
  }
  const y = yearOf(period)
  const m = parseInt(period.slice(5, 7), 10)
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${String((idx % 12 + 12) % 12 + 1).padStart(2, '0')}`
}

/** Miesiąc → kwartał, w którym leży */
export function toQuarter(period: string): string {
  if (isQuarter(period)) return period
  const m = parseInt(period.slice(5, 7), 10)
  return `${yearOf(period)}-Q${Math.floor((m - 1) / 3) + 1}`
}

/** Kwartał → jego ostatni miesiąc */
export function toMonth(period: string): string {
  if (!isQuarter(period)) return period
  const q = parseInt(period.slice(6), 10)
  return `${yearOf(period)}-${String(q * 3).padStart(2, '0')}`
}

/** Etykieta okresu po polsku (do nagłówka zanim przyjdą dane) */
export function periodLabel(period: string): string {
  if (isQuarter(period)) {
    const q = parseInt(period.slice(6), 10)
    return `${ROMAN[q - 1]} kwartał ${yearOf(period)}`
  }
  const m = parseInt(period.slice(5, 7), 10)
  return `${MONTHS_PL[m - 1] ?? period} ${yearOf(period)}`
}

/** Zakres miesięcy okresu (od–do, YYYY-MM) */
export function periodRange(period: string): { from: string; to: string } {
  if (!isQuarter(period)) return { from: period, to: period }
  const q = parseInt(period.slice(6), 10)
  const y = yearOf(period)
  const p = (m: number) => `${y}-${String(m).padStart(2, '0')}`
  return { from: p(q * 3 - 2), to: p(q * 3) }
}

/** Czy okres jest w przyszłości (jeszcze nie ma sensu go pokazywać) */
export function isFuture(period: string, now = new Date()): boolean {
  const { from } = periodRange(period)
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return from > cur
}
