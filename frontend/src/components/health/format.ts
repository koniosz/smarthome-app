// Formatowanie liczb i dat dla strony „Kondycja firmy” (pl-PL, PLN)

const nf2 = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nf0 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })

export const fmt = (n: number) => nf2.format(n || 0)
export const fmt0 = (n: number) => nf0.format(n || 0)
export const money = (n: number) => `${fmt(n)} zł`
/** Pełne złote z separatorem tysięcy: „38 400 zł” */
export const money0 = (n: number) => `${fmt0(n)} zł`
export const pct1 = (n: number) => `${nf1.format(n || 0)} %`

/** Skrócony zapis na osie wykresów: 1 234 567 → „1,2 mln”, 38 400 → „38 tys.” */
export function short(n: number): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (a >= 1_000_000) return `${sign}${nf1.format(a / 1_000_000)} mln`
  if (a >= 1_000) return `${sign}${nf0.format(a / 1_000)} tys.`
  return `${sign}${nf0.format(a)}`
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return d ? `${d}.${m}.${y}` : s
}

/** 'YYYY-MM-DD' → 'DD.MM' (etykiety osi) */
export function fmtDayMonth(s: string): string {
  const [, m, d] = s.slice(0, 10).split('-')
  return d ? `${d}.${m}` : s
}

/** ISO timestamp → 'DD.MM.YYYY HH:MM' */
export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Zmiana procentowa; null gdy brak bazy do porównania */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null
  return ((cur - prev) / Math.abs(prev)) * 100
}
