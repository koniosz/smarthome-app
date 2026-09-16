/**
 * Wycena magazynu na koniec miesiąca + zmiana stanu zapasów do RZiS.
 * (spec: docs/finance-automation-spec.md §C)
 *
 * Kontrakt (używany przez routes/finance.ts — silnik RZiS):
 *  - inventoryValueAt(period: 'YYYY-MM') → wartość zapasów (netto, po cenach zakupu) na KONIEC miesiąca
 *  - inventoryChangeByMonth(months: string[]) → Map<period, Δ> gdzie Δ = value(end M) − value(end M−1)
 *    (dodatnie = magazyn urósł → koszty sprzedanych towarów maleją)
 *
 * Metoda (wstecz od stanu bieżącego):
 *  - StockMovement ma tylko `created_at` (nie ma daty dokumentu), więc stan na koniec miesiąca P liczymy jako
 *    `item.quantity − Σ ruchów zapisanych PO końcu P` (in: +qty, out: −qty, adjust: qty ze znakiem).
 *    Każda zmiana `quantity` w backendzie (routes/warehouse.ts: przyjęcie/wydanie, PZ/WZ/MM, import Excel)
 *    zapisuje sparowany ruch, więc odliczanie jest spójne. MM = `out` ze źródła + `in` do celu po tej samej
 *    cenie → wycena łączna neutralna.
 *  - Ruchy `initial` (stan początkowy z formularza „nowa pozycja” / importu Excel, routes/warehouse.ts) to bilans
 *    otwarcia — towar istniejący „od zawsze”, a nie zakup w miesiącu wpisania. NIE są cofane przy liczeniu stanu
 *    wstecz (inaczej miesiąc zasilenia magazynu dostałby Δ = +cała wartość stanu otwarcia i COGS spadłby o tę
 *    kwotę). Faktyczne przyjęcia zakupów należy księgować przez PZ/„Przyjęcie” (ruch `in`).
 *  - Koniec miesiąca = północ pierwszego dnia następnego miesiąca w strefie Europe/Warsaw
 *    (timestampy w bazie są w UTC — `new Date().toISOString()`).
 *  - Cena = `item.unit_price`; gdy 0 → cena ostatniego ruchu in/initial z ceną > 0 (najpierw sprzed końca P,
 *    potem dowolnego); gdy nadal 0 → pozycja bez wyceny (liczona w `unpriced_items`, o ile ma stan > 0).
 *  - Ujemny stan wsteczny traktujemy jak 0. Wszystkie kwoty netto, zaokrąglane do groszy.
 */
import { prisma } from '../db'

// ── Typy (podzbiór pól Prisma — czyste funkcje nie zależą od bazy) ───────────
export interface ValuationItem {
  id: string
  quantity: number
  unit_price: number
}

export interface ValuationMovement {
  warehouse_item_id: string
  type: string            // in | out | initial | adjust
  quantity: number
  unit_price: number
  created_at: string      // ISO
}

export interface PeriodValuation {
  value: number           // wartość zapasów na koniec miesiąca (netto, PLN)
  unpriced_items: number  // pozycje ze stanem > 0 bez żadnej ceny (ich wartość = 0)
}

export interface MonthValuation extends PeriodValuation {
  period: string
  change: number          // Δ = value(M) − value(M−1)
}

const WARSAW_TZ = 'Europe/Warsaw'

function r2(n: number): number { return Math.round(n * 100) / 100 }

// ── Okresy ──────────────────────────────────────────────────────────────────
export function isPeriod(p: unknown): p is string {
  return typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p)
}

/** Poprzedni miesiąc: '2026-01' → '2025-12' */
export function prevPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Przesunięcie strefy Europe/Warsaw względem UTC (w minutach) w danej chwili. */
function warsawOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WARSAW_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - at.getTime()) / 60000)
}

/**
 * Pierwsza chwila PO końcu miesiąca P (północ 1. dnia następnego miesiąca czasu warszawskiego) jako ISO UTC.
 * Ruch z `created_at >= periodEndExclusive(P)` jest „po końcu P”.
 * Np. '2026-08' → '2026-08-31T22:00:00.000Z' (lato, UTC+2), '2026-12' → '2026-12-31T23:00:00.000Z' (zima, UTC+1).
 */
export function periodEndExclusive(period: string): string {
  const [y, m] = period.split('-').map(Number)
  const localMidnightAsUtc = Date.UTC(y, m, 1, 0, 0, 0) // m (1-12) = następny miesiąc w indeksie 0-11
  let utc = localMidnightAsUtc - warsawOffsetMinutes(new Date(localMidnightAsUtc)) * 60000
  const check = warsawOffsetMinutes(new Date(utc))
  if (check * 60000 !== localMidnightAsUtc - utc) utc = localMidnightAsUtc - check * 60000
  return new Date(utc).toISOString()
}

// ── Czysta wycena ───────────────────────────────────────────────────────────
/** Zmiana stanu wynikająca z ruchu (znak wg typu). Nieznany typ → 0. */
export function movementDelta(m: Pick<ValuationMovement, 'type' | 'quantity'>): number {
  const q = Number(m.quantity) || 0
  switch (m.type) {
    case 'in':
    case 'initial': return q
    case 'out': return -q
    case 'adjust': return q // korekta ze znakiem (nikt jej dziś nie zapisuje — patrz nagłówek pliku)
    default: return 0
  }
}

function tsMs(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0 // nieparsowalna data → traktuj jak „dawno” (ruch już w stanie)
}

/** Cena zakupu pozycji na potrzeby wyceny na koniec okresu (patrz nagłówek pliku). */
function priceFor(item: ValuationItem, sortedMovements: ValuationMovement[], boundaryMs: number): number {
  const own = Number(item.unit_price) || 0
  if (own > 0) return own
  let fallback = 0
  for (const m of sortedMovements) { // rosnąco po created_at → ostatni pasujący wygrywa
    if (m.type !== 'in' && m.type !== 'initial') continue
    const p = Number(m.unit_price) || 0
    if (p <= 0) continue
    if (tsMs(m.created_at) < boundaryMs) fallback = p
  }
  if (fallback > 0) return fallback
  for (let i = sortedMovements.length - 1; i >= 0; i--) {
    const m = sortedMovements[i]
    if ((m.type === 'in' || m.type === 'initial') && (Number(m.unit_price) || 0) > 0) return Number(m.unit_price)
  }
  return 0
}

function groupMovements(movements: ValuationMovement[]): Map<string, ValuationMovement[]> {
  const byItem = new Map<string, ValuationMovement[]>()
  for (const m of movements) {
    const arr = byItem.get(m.warehouse_item_id)
    if (arr) arr.push(m); else byItem.set(m.warehouse_item_id, [m])
  }
  for (const arr of byItem.values()) arr.sort((a, b) => tsMs(a.created_at) - tsMs(b.created_at))
  return byItem
}

function valueAtBoundary(items: ValuationItem[], byItem: Map<string, ValuationMovement[]>, boundaryMs: number): PeriodValuation {
  let value = 0
  let unpriced = 0
  for (const item of items) {
    const mv = byItem.get(item.id) || []
    let qty = Number(item.quantity) || 0
    // `initial` = bilans otwarcia, istnieje we wszystkich wcześniejszych okresach → nie cofamy (patrz nagłówek)
    for (const m of mv) if (m.type !== 'initial' && tsMs(m.created_at) >= boundaryMs) qty -= movementDelta(m)
    if (qty <= 0) continue // ujemny/zerowy stan wsteczny → 0, nic nie wnosi
    const price = priceFor(item, mv, boundaryMs)
    if (price <= 0) { unpriced++; continue }
    value += qty * price
  }
  return { value: r2(value), unpriced_items: unpriced }
}

/**
 * Wycena zapasów na koniec każdego z podanych miesięcy (wszystkie magazyny, także „Projekty”).
 * Czysta funkcja — items/movements to pełny zrzut tabel (lub fixture w testach).
 */
export function computeValuation(items: ValuationItem[], movements: ValuationMovement[], periods: string[]): Map<string, PeriodValuation> {
  const out = new Map<string, PeriodValuation>()
  const byItem = groupMovements(movements)
  for (const p of periods) {
    if (out.has(p)) continue
    out.set(p, valueAtBoundary(items, byItem, tsMs(periodEndExclusive(p))))
  }
  return out
}

/** Wycena stanu BIEŻĄCEGO (bez cofania ruchów). */
export function computeCurrentValuation(items: ValuationItem[], movements: ValuationMovement[]): PeriodValuation {
  return valueAtBoundary(items, groupMovements(movements), Number.POSITIVE_INFINITY)
}

/**
 * Wartość + zmiana stanu dla listy miesięcy. Dla każdego M liczy też M−1 (Δ = value(M) − value(M−1)).
 * Brak pozycji i ruchów → wszędzie 0.
 */
export function computeMonthlyChanges(items: ValuationItem[], movements: ValuationMovement[], months: string[]): Map<string, MonthValuation> {
  const needed = new Set<string>()
  for (const m of months) { needed.add(prevPeriod(m)); needed.add(m) }
  const val = computeValuation(items, movements, [...needed])
  const out = new Map<string, MonthValuation>()
  for (const m of months) {
    const cur = val.get(m)!
    const prev = val.get(prevPeriod(m))!
    out.set(m, { period: m, value: cur.value, change: r2(cur.value - prev.value), unpriced_items: cur.unpriced_items })
  }
  return out
}

// ── Dostęp do bazy ──────────────────────────────────────────────────────────
async function loadInventory(): Promise<{ items: ValuationItem[]; movements: ValuationMovement[] }> {
  const [items, movements] = await Promise.all([
    prisma.warehouseItem.findMany({ select: { id: true, quantity: true, unit_price: true } }),
    prisma.stockMovement.findMany({ select: { warehouse_item_id: true, type: true, quantity: true, unit_price: true, created_at: true } }),
  ])
  return { items, movements }
}

export async function inventoryValueAt(period: string): Promise<number> {
  if (!isPeriod(period)) return 0
  const { items, movements } = await loadInventory()
  if (items.length === 0) return 0
  return computeValuation(items, movements, [period]).get(period)?.value ?? 0
}

export async function inventoryChangeByMonth(months: string[]): Promise<Map<string, number>> {
  const valid = months.filter(isPeriod)
  const { items, movements } = await loadInventory()
  const result = new Map<string, number>(months.map(m => [m, 0]))
  if (items.length === 0 || valid.length === 0) return result
  const changes = computeMonthlyChanges(items, movements, valid)
  for (const m of valid) result.set(m, changes.get(m)?.change ?? 0)
  return result
}

/** Dane dla `GET /api/finance/inventory?year=` (spec §C). */
export interface InventoryYearReport {
  year: number
  months: MonthValuation[]
  current_value: number
  as_of: string
}

export async function inventoryReportForYear(year: number): Promise<InventoryYearReport> {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  const { items, movements } = await loadInventory()
  const changes = computeMonthlyChanges(items, movements, months)
  const current = computeCurrentValuation(items, movements)
  return {
    year,
    months: months.map(m => changes.get(m)!),
    current_value: current.value,
    as_of: new Date().toISOString(),
  }
}
