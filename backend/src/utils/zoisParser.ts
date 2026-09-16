/**
 * Parser zestawienia obrotów i sald (ZOiS) od biura rachunkowego → linie RZiS księgowej.
 *
 * Obsługiwane formaty:
 * - CSV (Comarch Optima, Rewizor, eksport z Excela): separator `;`, `,` lub tabulator (wykrywany),
 *   kodowanie UTF-8 (także z BOM), UTF-16LE (Excel „Tekst Unicode”) lub cp1250/latin2 (fallback bez iconv);
 * - XLSX/XLS (Symfonia, Optima) przez bibliotekę `xlsx` (`sheet_to_json({ header: 1, raw: false })`);
 * - tabele z kolumnami BO / Obroty okresu / Obroty narastająco / Saldo — bierzemy OBROTY OKRESU
 *   (flaga `has_period_and_ytd` mówi, że plik miał obie wersje);
 * - nagłówek w jednym lub dwóch wierszach (scalone komórki grup nad „Wn / Ma”);
 * - plik bez nagłówka (kolumna 0 = konto, ostatnie dwie liczbowe = Wn / Ma) — z ostrzeżeniem.
 *
 * Wszystkie funkcje są czyste (bez bazy) — testy w `__tests__/zois-parser.test.ts`.
 */
import * as XLSX from 'xlsx'
import { plNumber } from '../routes/finance'

// ── Typy ──────────────────────────────────────────────────────────────────────
export type ZoisRow = { account: string; name: string; debit: number; credit: number }

export type ZoisDetected = {
  account_col: number
  name_col: number
  debit_col: number
  credit_col: number
  header_row: number            // -1 = brak nagłówka
  has_period_and_ytd: boolean   // plik miał kolumny „okresu” i „narastająco” — użyto okresu
}

export type ZoisParseResult = { rows: ZoisRow[]; detected: ZoisDetected; warnings: string[] }

export type AccountantLines = {
  revenue: number          // 70x–74x (700, 730, 740…): Ma − Wn (przychody ze sprzedaży)
  cogs: number             // 701, 711, 731, 741 lub konto 7xx nazwane „koszt…” / „wartość sprzedanych…”: Wn − Ma (koszt sprzedanych towarów/produktów)
  other_revenue: number    // 750, 760: Ma − Wn (przychody finansowe, pozostałe operacyjne)
  depreciation: number     // 400
  materials: number        // 401
  services: number         // 402
  taxes_fees: number       // 403
  salaries: number         // 404
  social: number           // 405
  other_costs: number      // 406–409 oraz 761 (lub zespół 5, gdy brak zespołu 4)
  financial_costs: number  // 751
  cit: number              // 870–879: Wn − Ma
  costs_total: number      // cogs + depreciation + … + financial_costs
  result: number
  source_classes: '4' | '5'
  warnings: string[]
}

// ── Pomocnicze ────────────────────────────────────────────────────────────────
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
const str = (v: any): string => (v === null || v === undefined) ? '' : String(v)

const PL_MAP: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }
/** małe litery, bez polskich znaków, pojedyncze spacje — do dopasowań nagłówków */
export function normText(v: any): string {
  return str(v).toLowerCase().replace(/[ąćęłńóśźż]/g, ch => PL_MAP[ch] ?? ch).replace(/[\s ]+/g, ' ').trim()
}

// Wzorce nagłówków (na znormalizowanym tekście)
const ACCOUNT_RE = /konto|symbol|nr konta|numer/
const NAME_RE = /nazwa/
const DEBIT_RE = /\bwn\b|winien|debet|debit|\bdt\b/
const CREDIT_RE = /\bma\b|credit|kredyt|\bct\b/
const YTD_RE = /narast/
const PERIOD_RE = /okres|miesi/
const OBROTY_RE = /obrot/
const BO_RE = /\bbo\b|otwarcia|\bbz\b|zamkni/
const SALDO_RE = /saldo|persaldo/
const SUM_RE = /^(razem|suma|ogolem|lacznie|w tym)\b/

/** Maksymalna liczba wierszy pliku — prawdziwe ZOiS ma setki, najwyżej kilka tysięcy kont; więcej = dziennik/zapisy na kontach */
export const MAX_ZOIS_ROWS = 20_000

// Zespół 7 (sprzedaż): x0 = przychód (Ma−Wn), x1 = koszt sprzedanych produktów/towarów/materiałów (Wn−Ma).
// Rozstrzyga nazwa konta; bez rozpoznawalnej nazwy — numer 701/711/731/741 z saldem Wn.
const COGS_NAME_RE = /koszt|wartos\w* sprzedan|cen\w* (zakupu|nabycia)/
const REVENUE_NAME_RE = /sprzedaz|przychod/
const COGS_ACCOUNTS = new Set([701, 711, 731, 741])

/** komórka wygląda na liczbę (także „1 234,56”, „(1 200,50)”, „-”) */
export function isNumericCell(v: any): boolean {
  if (typeof v === 'number') return true
  const s = str(v).replace(/[\s  ]/g, '')
  if (s === '' || s === '-') return s === '-'
  return /^\(?-?\d[\d.,]*\)?$/.test(s)
}

/** konto wygląda na numer konta księgowego (zaczyna się od 3 cyfr: 401, 401-01, 700-1-02) */
export function isAccountCode(v: any): boolean {
  return /^\d{3}/.test(str(v).trim().replace(/^'/, ''))
}

/** syntetyka — pierwsze 3 cyfry konta („401-01” → „401”) */
export function accountSynthetic(account: string): string {
  const m = str(account).trim().match(/^(\d{3})/)
  return m ? m[1] : ''
}

// ── Kodowanie i CSV ───────────────────────────────────────────────────────────
// cp1250 → Unicode dla polskich liter (reszta jak latin1). Bez zależności od iconv.
const CP1250_PL: Record<number, string> = {
  0xa5: 'Ą', 0xb9: 'ą', 0xc6: 'Ć', 0xe6: 'ć', 0xca: 'Ę', 0xea: 'ę', 0xa3: 'Ł', 0xb3: 'ł',
  0xd1: 'Ń', 0xf1: 'ń', 0xd3: 'Ó', 0xf3: 'ó', 0x8c: 'Ś', 0x9c: 'ś', 0x8f: 'Ź', 0x9f: 'ź', 0xaf: 'Ż', 0xbf: 'ż',
}
export function decodeCp1250(buf: Buffer): string {
  return buf.toString('latin1').replace(/[\x80-\xff]/g, ch => CP1250_PL[ch.charCodeAt(0)] ?? ch)
}

/** Buffer → tekst: UTF-16LE (BOM FF FE), UTF-8 (z/bez BOM), a gdy UTF-8 daje „�” → cp1250 */
export function decodeZoisBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const utf8 = buf.toString('utf-8')
  if (utf8.includes('�')) return decodeCp1250(buf)
  return utf8.replace(/^﻿/, '')
}

/** Separator CSV: `;`, tabulator lub `,` — wg liczby wystąpień w pierwszych wierszach */
export function detectSeparator(text: string): ';' | '\t' | ',' {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '').slice(0, 25)
  const count = (ch: string) => lines.reduce((n, l) => n + l.split(ch).length - 1, 0)
  const semi = count(';'), tab = count('\t'), comma = count(',')
  if (semi >= lines.length && semi >= tab) return ';'
  if (tab >= lines.length && tab > semi) return '\t'
  if (semi > 0 && semi >= comma) return ';'
  if (tab > 0 && tab >= comma) return '\t'
  return ','
}

/** Parser CSV z konfigurowalnym separatorem (cudzysłowy z "" jako escape); pomija puste wiersze */
export function parseDelimited(content: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  const src = content.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === sep) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f.trim() !== '')) rows.push(row)
  return rows
}

/** Plik (CSV/TXT/XLSX/XLS) → surowa tablica wierszy do `parseZoisRows` */
export function parseZoisFile(buffer: Buffer, fileName: string): any[][] {
  const name = str(fileName).toLowerCase()
  const isExcel = /\.(xlsx|xlsm|xls|ods)$/.test(name)
    || (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b)                        // ZIP → xlsx
    || (buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11)  // OLE → xls
  if (isExcel) {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    let best: any[][] = []
    for (const sn of wb.SheetNames) {
      const ws = wb.Sheets[sn]
      if (!ws) continue
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as any[][]
      // pierwszy arkusz z danymi (≥ 2 wiersze); gdy żaden — najdłuższy
      if (rows.length >= 2) return rows
      if (rows.length > best.length) best = rows
    }
    return best
  }
  const text = decodeZoisBuffer(buffer)
  return parseDelimited(text, detectSeparator(text))
}

// ── Wykrywanie nagłówka i kolumn ──────────────────────────────────────────────
function indicesWhere(cells: string[], pred: (c: string, j: number) => boolean): number[] {
  const out: number[] = []
  cells.forEach((c, j) => { if (pred(c, j)) out.push(j) })
  return out
}

// scalone komórki grup („Obroty okresu”, „”, „Obroty narastająco”, „”) → wypełnij w prawo
function forwardFill(cells: string[]): string[] {
  let last = ''
  return cells.map(c => { if (c) last = c; return last })
}

// im wyższy wynik, tym bardziej „obroty okresu”; BO / saldo / narastająco odpadają
function turnoverScore(ctx: string): number {
  let s = 0
  if (OBROTY_RE.test(ctx)) s += 2
  if (PERIOD_RE.test(ctx)) s += 3
  if (YTD_RE.test(ctx)) s -= 2
  if (BO_RE.test(ctx)) s -= 5
  if (SALDO_RE.test(ctx)) s -= 5
  return s
}

function pickBest(cands: number[], ctx: string[]): number {
  let best = -1, bestScore = -Infinity
  for (const j of cands) {
    const sc = turnoverScore(ctx[j])
    if (sc > bestScore) { best = j; bestScore = sc }
  }
  return best
}

type HeaderInfo = ZoisDetected & { found: boolean }

function detectHeader(rows: any[][]): HeaderInfo {
  const none: HeaderInfo = { found: false, account_col: -1, name_col: -1, debit_col: -1, credit_col: -1, header_row: -1, has_period_and_ytd: false }
  const limit = Math.min(15, rows.length)
  for (let r = 0; r < limit; r++) {
    const own = (rows[r] ?? []).map(normText)
    if (own.filter(Boolean).length < 2) continue
    let accCols = indicesWhere(own, c => ACCOUNT_RE.test(c) && !NAME_RE.test(c))
    const debitOwn = indicesWhere(own, c => DEBIT_RE.test(c))
    const creditOwn = indicesWhere(own, c => CREDIT_RE.test(c))
    if (!debitOwn.length || !creditOwn.length) continue

    // Kontekst z wiersza wyżej (nagłówek dwuwierszowy): tylko gdy własne komórki są „gołe”
    // („Wn” / „Ma”) albo brakuje kolumny konta we własnym wierszu — tytuł nad tabelą nie zakłóca.
    const above = r > 0 ? (rows[r - 1] ?? []).map(normText) : []
    const bare = debitOwn.every(j => own[j].length <= 6) && creditOwn.every(j => own[j].length <= 6)
    const useAbove = r > 0 && above.filter(Boolean).length >= 2 && (bare || accCols.length === 0)
    const filled = useAbove ? forwardFill(above) : []
    const ctx = own.map((c, j) => (useAbove && filled[j] ? filled[j] + ' ' : '') + c)

    if (!accCols.length && r > 0) accCols = indicesWhere(above, c => ACCOUNT_RE.test(c) && !NAME_RE.test(c))
    if (!accCols.length) continue

    const account_col = accCols[0]
    let nameCols = indicesWhere(own, (c, j) => NAME_RE.test(c) && j !== account_col)
    if (!nameCols.length && r > 0) nameCols = indicesWhere(above, (c, j) => NAME_RE.test(c) && j !== account_col)
    const debitCands = debitOwn.filter(j => j !== account_col)
    const creditCands = creditOwn.filter(j => j !== account_col)
    const debit_col = pickBest(debitCands, ctx)
    const credit_col = pickBest(creditCands.filter(j => j !== debit_col), ctx)
    if (debit_col < 0 || credit_col < 0) continue

    const nonBalance = (j: number) => !BO_RE.test(ctx[j]) && !SALDO_RE.test(ctx[j])
    const hasYtd = debitCands.some(j => YTD_RE.test(ctx[j]))
    const hasPeriod = debitCands.some(j => nonBalance(j) && !YTD_RE.test(ctx[j]))
    let name_col = nameCols.length ? nameCols[0] : -1
    if (name_col < 0) {
      // brak kolumny „Nazwa” — sąsiednia kolumna po koncie, o ile nie jest liczbowa
      const j = account_col + 1
      if (j !== debit_col && j !== credit_col && j < own.length) name_col = j
    }
    return { found: true, account_col, name_col, debit_col, credit_col, header_row: r, has_period_and_ytd: hasYtd && hasPeriod }
  }
  return none
}

// ── Wiersze kont ──────────────────────────────────────────────────────────────
function cleanAccount(v: any): string {
  return str(v).trim().replace(/^'/, '').replace(/\s+$/, '')
}

/**
 * Pomiń syntetyki, które mają analityki w zestawieniu (401 gdy jest 401-01) — bez podwajania.
 * O(n · długość konta): zbiór ścisłych prefiksów każdego konta uciętych przed separatorem
 * (401-1-01 → 401, 401-1) oraz pierwsze 3 cyfry kont z samych cyfr (4011 → 401);
 * rodzic = konto obecne w tym zbiorze. Dawna wersja (accounts.some dla każdego wiersza) była O(n²)
 * i blokowała pętlę zdarzeń na minuty przy omyłkowo wgranym dzienniku.
 */
export function dropParentAccounts(rows: ZoisRow[]): { rows: ZoisRow[]; dropped: string[] } {
  const prefixes = new Set<string>()
  const seen = new Set<string>()
  for (const r of rows) {
    const b = r.account
    if (seen.has(b)) continue
    seen.add(b)
    for (let i = 1; i < b.length; i++) if (/[-./\s_]/.test(b[i])) prefixes.add(b.slice(0, i))
    if (b.length > 3 && /^\d+$/.test(b)) prefixes.add(b.slice(0, 3))
  }
  const dropped: string[] = []
  const kept = rows.filter(r => { if (prefixes.has(r.account)) { dropped.push(r.account); return false } return true })
  return { rows: kept, dropped: [...new Set(dropped)] }
}

/**
 * Surowe wiersze (CSV/XLSX) → wiersze kont z obrotami Wn/Ma okresu.
 * Nie rzuca — brak danych to pusta lista + ostrzeżenie.
 */
export function parseZoisRows(rows: any[][]): ZoisParseResult {
  const warnings: string[] = []
  const total = (rows ?? []).length
  if (total > MAX_ZOIS_ROWS) {
    return {
      rows: [], detected: { account_col: -1, name_col: -1, debit_col: -1, credit_col: -1, header_row: -1, has_period_and_ytd: false },
      warnings: [`Plik ma ${total} wierszy — to nie wygląda na zestawienie obrotów i sald (maksymalnie ${MAX_ZOIS_ROWS}). Wgraj ZOiS, nie dziennik ani zapisy na kontach.`],
    }
  }
  const safeRows = (rows ?? []).map(r => (Array.isArray(r) ? r : [r]))
  const hdr = detectHeader(safeRows)
  let out: ZoisRow[] = []
  let detected: ZoisDetected

  if (hdr.found) {
    const { account_col, name_col, debit_col, credit_col, header_row, has_period_and_ytd } = hdr
    detected = { account_col, name_col, debit_col, credit_col, header_row, has_period_and_ytd }
    for (let r = header_row + 1; r < safeRows.length; r++) {
      const cells = safeRows[r]
      let account = cleanAccount(cells[account_col])
      if (!isAccountCode(account)) continue
      let name = name_col >= 0 ? str(cells[name_col]).trim() : ''
      // „401-01 Materiały” w jednej komórce
      const m = account.match(/^(\S+)\s+(.+)$/)
      if (m) { account = m[1]; if (!name) name = m[2] }
      if (SUM_RE.test(normText(name))) continue
      out.push({ account, name, debit: r2(plNumber(cells[debit_col] ?? 0)), credit: r2(plNumber(cells[credit_col] ?? 0)) })
    }
    if (has_period_and_ytd) warnings.push('Plik ma obroty okresu i narastająco — użyto obrotów okresu.')
  } else {
    // Bez nagłówka: kolumna 0 = konto, ostatnie dwie liczbowe = Wn / Ma
    const dataRows = safeRows.filter(r => isAccountCode(r[0]))
    if (!dataRows.length) {
      return {
        rows: [], detected: { account_col: -1, name_col: -1, debit_col: -1, credit_col: -1, header_row: -1, has_period_and_ytd: false },
        warnings: ['Nie rozpoznano nagłówka ani kolumn (konto / nazwa / Wn / Ma). Sprawdź, czy to zestawienie obrotów i sald.'],
      }
    }
    warnings.push('Brak nagłówka — przyjęto: pierwsza kolumna = konto, ostatnie dwie liczbowe = Wn / Ma. Sprawdź wynik.')
    let name_col = -1, debit_col = -1, credit_col = -1
    for (const cells of dataRows) {
      let account = cleanAccount(cells[0])
      const numeric = indicesWhere(cells.map(str), (_c, j) => j > 0 && isNumericCell(cells[j]))
      const textIdx = cells.findIndex((c, j) => j > 0 && str(c).trim() !== '' && !isNumericCell(c))
      let name = textIdx > 0 ? str(cells[textIdx]).trim() : ''
      const m = account.match(/^(\S+)\s+(.+)$/)
      if (m) { account = m[1]; if (!name) name = m[2] }
      if (SUM_RE.test(normText(name))) continue
      const d = numeric.length >= 2 ? numeric[numeric.length - 2] : (numeric.length === 1 ? numeric[0] : -1)
      const c = numeric.length >= 2 ? numeric[numeric.length - 1] : -1
      if (debit_col < 0 && d >= 0) { debit_col = d; credit_col = c; name_col = textIdx > 0 ? textIdx : -1 }
      out.push({ account, name, debit: d >= 0 ? r2(plNumber(cells[d])) : 0, credit: c >= 0 ? r2(plNumber(cells[c])) : 0 })
    }
    detected = { account_col: 0, name_col, debit_col, credit_col, header_row: -1, has_period_and_ytd: false }
  }

  const { rows: leaves, dropped } = dropParentAccounts(out)
  if (dropped.length) warnings.push(`Pominięto ${dropped.length} kont syntetycznych z analitykami (${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? '…' : ''}) — liczone są tylko analityki.`)
  if (!leaves.length) warnings.push('Nie znaleziono wierszy kont (numer konta powinien zaczynać się od 3 cyfr, np. 401 lub 401-01).')
  return { rows: leaves, detected, warnings }
}

/** Obroty narastająco: bieżący miesiąc − poprzedni (po kontach) → obroty miesiąca */
export function diffZoisRows(current: ZoisRow[], previous: ZoisRow[]): ZoisRow[] {
  const prev = new Map<string, ZoisRow>()
  for (const p of previous ?? []) prev.set(p.account, p)
  const seen = new Set<string>()
  const out: ZoisRow[] = []
  for (const c of current) {
    const p = prev.get(c.account)
    seen.add(c.account)
    out.push({ account: c.account, name: c.name || p?.name || '', debit: r2(c.debit - (p?.debit ?? 0)), credit: r2(c.credit - (p?.credit ?? 0)) })
  }
  for (const p of previous ?? []) {
    if (seen.has(p.account)) continue
    // konto było w poprzednim miesiącu, a teraz go nie ma → obroty miesiąca ujemne (storno)
    out.push({ account: p.account, name: p.name, debit: r2(-p.debit), credit: r2(-p.credit) })
  }
  return out
}

// ── Mapowanie kont na linie RZiS księgowej ────────────────────────────────────
export function emptyAccountantLines(): AccountantLines {
  return {
    revenue: 0, cogs: 0, other_revenue: 0, depreciation: 0, materials: 0, services: 0, taxes_fees: 0,
    salaries: 0, social: 0, other_costs: 0, financial_costs: 0, cit: 0, costs_total: 0, result: 0,
    source_classes: '4', warnings: [],
  }
}

export function mapZoisToLines(rows: ZoisRow[]): AccountantLines {
  const L = emptyAccountantLines()
  let class4Abs = 0, class5 = 0, class5Abs = 0
  const ignored = new Set<string>()
  const revenueDebit = new Set<string>()   // konta 7xx policzone jako przychód, ale z saldem Wn — do sprawdzenia

  for (const row of rows ?? []) {
    const synth = accountSynthetic(row.account)
    if (!synth) continue
    const n = parseInt(synth, 10)
    const cost = (row.debit || 0) - (row.credit || 0)   // koszty: Wn − Ma
    const rev = (row.credit || 0) - (row.debit || 0)    // przychody: Ma − Wn
    const hasTurnover = Math.abs(row.debit || 0) + Math.abs(row.credit || 0) > 0

    if (n >= 700 && n <= 749) {
      const nm = normText(row.name)
      const isCogs = COGS_NAME_RE.test(nm) || (!REVENUE_NAME_RE.test(nm) && COGS_ACCOUNTS.has(n) && cost > 0)
      if (isCogs) L.cogs += cost
      else { L.revenue += rev; if (cost > 0) revenueDebit.add(synth) }
    }
    else if (n === 750 || n === 760) L.other_revenue += rev
    else if (n === 751) L.financial_costs += cost
    else if (n === 761) L.other_costs += cost
    else if (n >= 870 && n <= 879) L.cit += cost
    else if (n === 400) { L.depreciation += cost; class4Abs += Math.abs(cost) }
    else if (n === 401) { L.materials += cost; class4Abs += Math.abs(cost) }
    else if (n === 402) { L.services += cost; class4Abs += Math.abs(cost) }
    else if (n === 403) { L.taxes_fees += cost; class4Abs += Math.abs(cost) }
    else if (n === 404) { L.salaries += cost; class4Abs += Math.abs(cost) }
    else if (n === 405) { L.social += cost; class4Abs += Math.abs(cost) }
    else if (n >= 406 && n <= 409) { L.other_costs += cost; class4Abs += Math.abs(cost) }
    else if (n >= 490 && n <= 499) continue                       // rozliczenie kosztów — pomijamy
    else if (n >= 500 && n <= 559) { class5 += cost; class5Abs += Math.abs(cost) }
    else if (hasTurnover && ((n >= 410 && n <= 489) || (n >= 752 && n <= 799))) ignored.add(synth)
    // pozostałe zespoły (0–3, 6, 8 poza 87x: kapitały, wynik finansowy) — bilansowe, nie wchodzą do wyniku
  }

  if (class4Abs === 0 && class5Abs > 0) {
    L.other_costs += class5
    L.source_classes = '5'
    L.warnings.push('Brak zespołu 4 — koszty policzono z zespołu 5 (konta 50–55) jako „pozostałe koszty” (bez podziału na amortyzację / pensje).')
  }
  if (ignored.size) L.warnings.push(`Pominięto konta spoza mapowania RZiS: ${[...ignored].sort().join(', ')}.`)
  if (revenueDebit.size) L.warnings.push(`Konta przychodowe z obrotem netto Wn: ${[...revenueDebit].sort().join(', ')} — sprawdź, czy to nie koszt sprzedanych towarów/produktów (wtedy nazwij konto „koszt…” / „wartość sprzedanych…”).`)

  for (const k of ['revenue', 'cogs', 'other_revenue', 'depreciation', 'materials', 'services', 'taxes_fees', 'salaries', 'social', 'other_costs', 'financial_costs', 'cit'] as const) {
    L[k] = r2(L[k])
  }
  L.costs_total = r2(L.cogs + L.depreciation + L.materials + L.services + L.taxes_fees + L.salaries + L.social + L.other_costs + L.financial_costs)
  L.result = r2(L.revenue + L.other_revenue - L.costs_total - L.cit)
  return L
}
