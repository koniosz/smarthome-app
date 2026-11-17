/**
 * Finanse 2.0 — rentowność spółki (RZiS z EBITDA) + import rejestru sprzedaży z Firmao.
 * Dostęp: admin lub księgowy (can_view_payments).
 *
 * Zasady rachunkowe:
 * - RZiS memoriałowo, w kwotach NETTO (alokacje KSeF są brutto → przeliczane
 *   proporcją netto/brutto faktury; VAT jest odliczalny i nie jest kosztem).
 * - VAT (tax_vat) wyłączony z RZiS; CIT (tax_income) poniżej EBIT;
 *   leasing traktowany operacyjnie (OPEX).
 * - Przychód: miesiąc z importem Firmao = Firmao (+ moduł niezdeduplikowany);
 *   miesiąc bez importu = KSeF sprzedaż + moduł (oznaczony jako wstępny).
 * - Koszty spoza KSeF (ManualCost: wyciąg MT940, wpisy ręczne, dokumenty) księgowane MEMORIAŁOWO:
 *   miesiąc = okres z tytułu przelewu (`period`), a dla kosztów pracy (pensje, PIT-4, ZUS) — wynik
 *   services/payroll-accrual (pensja wypłacona 1.–15. → miesiąc poprzedni, ZUS/PIT-4 → miesiąc, którego
 *   dotyczą, + SZACUNEK ZUS i PIT-4 za miesiące, za które przelewu jeszcze nie było). Jedna alokacja
 *   (loadManualCosts → allocateManualCosts) dla RZiS, podziału kosztów, „Kondycji firmy" i uzgodnienia
 *   z księgową — żeby wszystkie widoki pokazywały te same miesiące.
 */
import { Router, Request, Response } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import * as XLSX from 'xlsx'
import { requirePayments } from './payables'
import db, { prisma } from '../db'
import { inventoryChangeByMonth } from '../services/inventory-valuation'
import { moduleInvoiceScope } from './companies'
import { getCompanySettings } from '../settings-store'
import { allocatePayroll, payrollGroupOf, type PayrollCost, type PayrollGroup, type PayrollMonth } from '../services/payroll-accrual'
import { buildMatchedIndex, isKsefPayment, parseFxNote, type MatchedTxLite } from '../services/mt940-costs'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

function now() { return new Date().toISOString() }

router.use(requirePayments)

// ── Parsowanie liczb i dat: polski CSV ORAZ formaty z komórek XLSX ────────────
// XLSX z raw:false renderuje liczby w formacie US ("27,554.80"), a ujemne
// księgowo jako "(1 200,50)" — rozpoznajemy je przed polską podmianą przecinka.
export function plNumber(v: any): number {
  if (typeof v === 'number') return v
  let s = String(v ?? '').replace(/[\s\u00a0\u202f]/g, '')
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }          // "(1200,50)" — ujemna księgowo
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '') // US/SSF "27,554.80"
  else s = s.replace(',', '.')                                          // polskie "27554,80"
  const n = parseFloat(s)
  return isNaN(n) ? 0 : (neg ? -n : n)
}

export function plDate(v: any): string {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  const s = String(v ?? '').trim()
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/)  // DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)    // już ISO
  // Excel przechowuje daty jako serial (liczba dni); przy błędnym formacie
  // komórki sheet_to_json potrafi zwrócić surowy serial (np. "46220")
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const d = (XLSX as any).SSF?.parse_date_code?.(parseFloat(s))
    if (d && d.y >= 2000 && d.y <= 2100) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
  }
  return ''
}

// ── Prosty parser CSV (przecinek, cudzysłowy z "" jako escape) ────────────────
export function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  const src = content.replace(/^﻿/, '') // BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
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

// ── Mapowanie kolumn Firmao (dopasowanie po nagłówkach, odporne na kolejność) ──
const HEADER_MAP: Record<string, string> = {
  'numer transakcji': 'invoice_number',
  'typ transakcji': 'doc_type',
  'rodzaj': 'kind',
  'klient': 'buyer_name',
  'data transakcji': 'sale_date',
  'termin płatności': 'due_date',
  'data wystaw.': 'issue_date',
  'data wystawienia': 'issue_date',
  'zapłacono': 'paid',
  'wartość netto': 'net',
  'kwota vat': 'vat',
  'wartość brutto': 'gross',
}

export function mapFirmaoRows(rows: any[][]): { records: any[]; skipped: number; errors: string[] } {
  if (!rows.length) return { records: [], skipped: 0, errors: ['Pusty plik'] }
  const header = rows[0].map((h: any) => String(h ?? '').trim().toLowerCase())
  const idx: Record<string, number> = {}
  header.forEach((h, i) => { if (HEADER_MAP[h]) idx[HEADER_MAP[h]] = i })

  const required = ['invoice_number', 'sale_date', 'net', 'gross']
  const missing = required.filter(k => idx[k] === undefined)
  if (missing.length) {
    return { records: [], skipped: 0, errors: [`Nie rozpoznano kolumn: ${missing.join(', ')}. Oczekiwany eksport „Raport transakcji" z Firmao.`] }
  }

  const records: any[] = []
  let skipped = 0
  const errors: string[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const cell = (k: string) => idx[k] !== undefined ? String(row[idx[k]] ?? '').trim() : ''
    const invoice_number = cell('invoice_number')
    const sale_date = plDate(cell('sale_date'))
    if (!invoice_number || !sale_date) { skipped++; continue }
    // tylko sprzedaż (kolumna "Rodzaj" — jeśli jest)
    const kind = cell('kind').toLowerCase()
    if (kind && !kind.includes('sprzeda')) { skipped++; continue }

    const typeRaw = cell('doc_type').toLowerCase()
    const doc_type = typeRaw.includes('koryg') ? 'korekta'
      : typeRaw.includes('zaliczk') ? 'zaliczkowa'
      : typeRaw.includes('faktura') || typeRaw === '' ? 'faktura' : 'inny'

    records.push({
      invoice_number,
      doc_type,
      buyer_name: cell('buyer_name'),
      sale_date,
      issue_date: plDate(cell('issue_date')),
      due_date: plDate(cell('due_date')),
      paid: cell('paid').toLowerCase().startsWith('t'), // Tak/Nie
      net: plNumber(row[idx['net']]),
      vat: idx['vat'] !== undefined ? plNumber(row[idx['vat']]) : 0,
      gross: plNumber(row[idx['gross']]),
      period: sale_date.slice(0, 7),
    })
  }
  return { records, skipped, errors }
}

// ── Dedupe względem KSeF (sprzedaż) i modułu faktur ──────────────────────────
function alnum(s: string): string { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }

function nameOverlap(a: string, b: string): boolean {
  const tok = (s: string) => s.toLowerCase().split(/[^a-ząćęłńóśźż0-9]+/).filter(t => t.length >= 4)
  const ta = tok(a), tb = new Set(tok(b))
  return ta.some(t => tb.has(t))
}

export function dedupeRecord(
  rec: { invoice_number: string; gross: number; period: string; buyer_name: string },
  ksefOutgoing: Array<{ id: string; invoice_number: string | null; gross_amount: number; invoice_date: string | null; buyer_name: string | null }>,
  moduleInvoices: Array<{ id: string; number: string | null; total_gross: number; sale_date: string | null; issue_date: string | null; buyer_name: string }>,
  used?: Set<string>, // faktury już skonsumowane w tym imporcie — jedna faktura ≠ dwa rekordy Firmao
): { dedup_status: string; matched_id: string | null } {
  const recNum = alnum(rec.invoice_number)
  const take = (status: string, id: string) => { used?.add(id); return { dedup_status: status, matched_id: id } }

  // 1) numer faktury (dokładny po normalizacji)
  for (const inv of ksefOutgoing) {
    if (used?.has(inv.id)) continue
    if (recNum.length >= 4 && alnum(inv.invoice_number || '') === recNum) return take('ksef_match', inv.id)
  }
  for (const inv of moduleInvoices) {
    if (used?.has(inv.id)) continue
    if (recNum.length >= 4 && alnum(inv.number || '') === recNum) return take('module_match', inv.id)
  }

  // 2) kwota brutto + ten sam miesiąc + zbieżna nazwa nabywcy
  for (const inv of ksefOutgoing) {
    if (used?.has(inv.id)) continue
    const invMonth = (inv.invoice_date || '').slice(0, 7)
    if (invMonth === rec.period && Math.abs(inv.gross_amount - rec.gross) <= 0.01 && rec.gross > 0
        && inv.buyer_name && nameOverlap(inv.buyer_name, rec.buyer_name)) {
      return take('ksef_match', inv.id)
    }
  }
  for (const inv of moduleInvoices) {
    if (used?.has(inv.id)) continue
    const invMonth = ((inv.sale_date || inv.issue_date) || '').slice(0, 7)
    if (invMonth === rec.period && Math.abs(inv.total_gross - rec.gross) <= 0.01 && rec.gross > 0
        && nameOverlap(inv.buyer_name, rec.buyer_name)) {
      return take('module_match', inv.id)
    }
  }

  // 3) sama kwota + miesiąc (bez zgodności nazwy) → podejrzenie duplikatu (nie konsumuje)
  for (const inv of ksefOutgoing) {
    if (used?.has(inv.id)) continue
    const invMonth = (inv.invoice_date || '').slice(0, 7)
    if (invMonth === rec.period && Math.abs(inv.gross_amount - rec.gross) <= 0.01 && rec.gross > 0) {
      return { dedup_status: 'suspect', matched_id: inv.id }
    }
  }
  return { dedup_status: 'unique', matched_id: null }
}

// ── POST /api/finance/import-sales — upload CSV/Excel z Firmao ────────────────
router.post('/import-sales', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Brak pliku. Wyślij plik w polu "file".' }); return }

    const name = (req.file.originalname || '').toLowerCase()
    let rows: any[][]
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as any[][]
    } else {
      let content = req.file.buffer.toString('utf-8')
      if (content.includes('�')) content = req.file.buffer.toString('latin1')
      rows = parseCsv(content)
    }

    const { records, skipped, errors } = mapFirmaoRows(rows)
    if (errors.length) { res.status(400).json({ error: errors.join('; ') }); return }
    if (!records.length) { res.status(400).json({ error: 'Nie znaleziono wierszy sprzedaży w pliku.' }); return }

    const ksefOutgoing = await prisma.ksefInvoice.findMany({
      where: { invoice_direction: 'outgoing' },
      select: { id: true, invoice_number: true, gross_amount: true, invoice_date: true, buyer_name: true },
    })
    const inScope = await moduleInvoiceScope()
    const moduleInvoices = (await prisma.salesInvoice.findMany({
      where: { status: { in: ['issued', 'paid'] } },
      select: { id: true, number: true, total_gross: true, sale_date: true, issue_date: true, buyer_name: true, company_id: true },
    })).filter(inv => inScope(inv)) // Firmao to księgowość SHC — deduplikujemy tylko z fakturami spółki
    const existing = await prisma.salesRecord.findMany({ select: { id: true, invoice_number: true, period: true } })
    const existingByKey = new Map(existing.map(e => [`${alnum(e.invoice_number)}|${e.period}`, e.id]))

    let inserted = 0, updated = 0, dedupKsef = 0, dedupModule = 0, suspects = 0
    const periods = new Set<string>()
    const used = new Set<string>() // każda faktura KSeF/modułu może zdeduplikować tylko JEDEN rekord Firmao

    for (const rec of records) {
      const { dedup_status, matched_id } = dedupeRecord(rec, ksefOutgoing, moduleInvoices, used)
      if (dedup_status === 'ksef_match') dedupKsef++
      if (dedup_status === 'module_match') dedupModule++
      if (dedup_status === 'suspect') suspects++
      periods.add(rec.period)

      const key = `${alnum(rec.invoice_number)}|${rec.period}`
      const existingId = existingByKey.get(key)
      const data = { ...rec, source: 'firmao', currency: 'PLN', dedup_status, matched_id }
      if (existingId) {
        await prisma.salesRecord.update({ where: { id: existingId }, data })
        updated++
      } else {
        const id = uuidv4()
        await prisma.salesRecord.create({ data: { id, ...data, created_at: now() } })
        existingByKey.set(key, id)
        inserted++
      }
    }

    res.json({
      inserted, updated, skipped,
      dedup_ksef: dedupKsef, dedup_module: dedupModule, suspects,
      periods: [...periods].sort(),
    })
  } catch (e: any) {
    console.error('[finance/import-sales]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd importu' })
  }
})

// ── GET /api/finance/sales?period=YYYY-MM ─────────────────────────────────────
router.get('/sales', async (req: Request, res: Response) => {
  try {
    const period = String(req.query.period ?? '').slice(0, 7)
    const where = period ? { period } : {}
    const records = await prisma.salesRecord.findMany({ where, orderBy: [{ sale_date: 'desc' }] })
    res.json(records)
  } catch (e) {
    console.error('[finance/sales]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── DELETE /api/finance/sales/period/:period — wyczyść miesiąc przed re-importem ─
router.delete('/sales/period/:period', async (req: Request, res: Response) => {
  try {
    const r = await prisma.salesRecord.deleteMany({ where: { period: req.params.period } })
    res.json({ deleted: r.count })
  } catch (e) {
    console.error('[finance/sales/delete-period]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── Środki trwałe (amortyzacja liniowa) ──────────────────────────────────────
router.get('/fixed-assets', async (_req: Request, res: Response) => {
  try {
    res.json(await prisma.fixedAsset.findMany({ orderBy: { start_period: 'desc' } }))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.post('/fixed-assets', async (req: Request, res: Response) => {
  try {
    const { name, value_net, depreciation_months, start_period, purchase_date, notes } = req.body ?? {}
    if (!name || !value_net || !start_period || !/^\d{4}-\d{2}$/.test(start_period)) {
      res.status(400).json({ error: 'Wymagane: name, value_net, start_period (YYYY-MM)' }); return
    }
    const asset = await prisma.fixedAsset.create({ data: {
      id: uuidv4(), name: String(name), value_net: Number(value_net),
      depreciation_months: Math.max(1, parseInt(depreciation_months) || 60),
      start_period: String(start_period), purchase_date: purchase_date || '',
      notes: notes || '', created_at: now(),
    }})
    res.status(201).json(asset)
  } catch (e) {
    console.error('[finance/fixed-assets]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

router.delete('/fixed-assets/:id', async (req: Request, res: Response) => {
  try {
    await prisma.fixedAsset.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Silnik RZiS ───────────────────────────────────────────────────────────────
export function monthsOf(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function depreciationForPeriod(assets: Array<{ value_net: number; depreciation_months: number; start_period: string }>, period: string): number {
  let sum = 0
  for (const a of assets) {
    const end = addMonths(a.start_period, a.depreciation_months) // pierwszy miesiąc PO amortyzacji
    if (period >= a.start_period && period < end) sum += a.value_net / a.depreciation_months
  }
  return Math.round(sum * 100) / 100
}

// ── Daty i etykiety miesięcy (wspólne z services/finance-health — tam re-eksport) ──
export const MONTHS_PL = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień']

/** Dzisiejsza data wg Europe/Warsaw (serwer na Render działa w UTC). */
export function warsawToday(d: Date = new Date()): { year: number; month: number; day: number; iso: string; period: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
  const year = get('year'), month = get('month'), day = get('day')
  const period = `${year}-${String(month).padStart(2, '0')}`
  return { year, month, day, iso: `${period}-${String(day).padStart(2, '0')}`, period }
}

/** '2026-08' → 'Sierpień 2026'. */
export function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return `${MONTHS_PL[m - 1] ?? period} ${y}`
}

/** Ostatni dzień miesiąca: '2026-02' → '2026-02-28'. */
export function lastDayOf(period: string): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${period}-${String(d).padStart(2, '0')}`
}

export const EMPTY_LINES = () => ({
  revenue: 0, revenue_firmao: 0, revenue_ksef: 0, revenue_module: 0, revenue_advances: 0,
  // cogs = cogs_purchases − inventory_change (zmiana stanu zapasów: dodatnia = magazyn urósł)
  cogs: 0, cogs_purchases: 0, inventory_change: 0, gross_margin: 0, gross_margin_pct: 0,
  opex: 0, opex_sales: 0, opex_ga: 0, opex_operations: 0, opex_leasing: 0,
  // Koszty pracy — INFORMACYJNIE, to CZĘŚĆ opex_ga (nie dodawać do opex drugi raz):
  // payroll = pensje + PIT-4 + ZUS ujęte w opex_ga, łącznie z szacunkiem; payroll_estimate = sama część szacowana
  payroll: 0, payroll_estimate: 0,
  ebitda: 0, ebitda_pct: 0,
  depreciation: 0, ebit: 0,
  financial_costs: 0, cit: 0, net_result: 0,
  provisional: true, // brak importu Firmao → przychód wstępny (KSeF+moduł)
})
export type PnlLines = ReturnType<typeof EMPTY_LINES>

// Wiersze z MT940 wchodzą do RZiS tylko z kategorii, które NIGDY nie przychodzą fakturą w KSeF
// (pensje, ZUS, podatki, opłaty bankowe) — czynsz/paliwo/leasing płacone przelewem mają fakturę
// w KSeF i liczyłyby się podwójnie. pnl_mode nadpisuje tę regułę: include (reguła bankowa /
// dokument spoza KSeF) → zawsze; exclude (duplikat) → nigdy. Wpisy ręczne i z dokumentów → zawsze.
// Koszt w walucie obcej (kwota NIE jest w PLN — np. wyciąg z rachunku EUR bez kursu NBP)
// nigdy nie wchodzi do RZiS: sumowanie EUR jako PLN zaniżałoby koszt ~4×.
// salary_pit = zaliczka PIT-4 (podatek potrącony z pensji i odprowadzony do US) — część kosztu pracy.
export const MT940_SAFE_SUBCATEGORIES = new Set(['salary_gross', 'salary_admin', 'salary_pit', 'zus_employer', 'tax_income', 'tax_vat', 'bank_fee', 'interest', 'fx'])
export function isForeignCurrencyCost(c: { currency?: string | null }): boolean {
  const cur = String(c.currency ?? '').trim().toUpperCase()
  return cur !== '' && cur !== 'PLN'
}
export function includeManualCostInPnl(c: { source?: string | null; subcategory?: string | null; pnl_mode?: string | null; currency?: string | null }): boolean {
  if (isForeignCurrencyCost(c)) return false
  if (c.pnl_mode === 'exclude') return false
  if (c.pnl_mode === 'include') return true
  if (c.source === 'mt940' && !MT940_SAFE_SUBCATEGORIES.has(String(c.subcategory ?? ''))) return false
  return true
}

// Klasyfikacja pozycji kosztowej do linii RZiS
export function costLine(cost_category: string, subcategory: string):
  'cogs' | 'opex_sales' | 'opex_ga' | 'opex_operations' | 'opex_leasing' | 'financial' | 'cit' | 'excluded' {
  if (subcategory === 'tax_vat') return 'excluded'   // VAT jest neutralny — nie jest kosztem
  if (subcategory === 'internal_transfer') return 'excluded' // przelew własny / rachunek VAT / wymiana walut — nie jest kosztem
  if (subcategory === 'tax_income') return 'cit'
  if (cost_category === 'cogs') return 'cogs'
  if (cost_category === 'sales') return 'opex_sales'
  if (cost_category === 'ga') return 'opex_ga'
  if (cost_category === 'operations') return 'opex_operations'
  if (cost_category === 'financial') {
    if (subcategory === 'leasing') return 'opex_leasing' // leasing operacyjny → OPEX
    return 'financial'
  }
  return 'opex_ga' // nieznane kategorie zachowawczo do G&A
}

export function finalizeLines(L: PnlLines): PnlLines {
  const r2 = (x: number) => Math.round(x * 100) / 100
  L.cogs = r2(L.cogs_purchases - L.inventory_change)
  L.opex = r2(L.opex_sales + L.opex_ga + L.opex_operations + L.opex_leasing)
  L.gross_margin = r2(L.revenue - L.cogs)
  L.gross_margin_pct = L.revenue > 0 ? r2(L.gross_margin / L.revenue * 100) : 0
  L.ebitda = r2(L.gross_margin - L.opex)
  L.ebitda_pct = L.revenue > 0 ? r2(L.ebitda / L.revenue * 100) : 0
  L.ebit = r2(L.ebitda - L.depreciation)
  L.net_result = r2(L.ebit - L.financial_costs - L.cit)
  // payroll / payroll_estimate są częścią opex_ga (informacyjnie) — tylko zaokrąglamy, NIE wchodzą do opex drugi raz
  for (const k of ['revenue', 'revenue_firmao', 'revenue_ksef', 'revenue_module', 'revenue_advances', 'cogs', 'cogs_purchases', 'inventory_change', 'opex_sales', 'opex_ga', 'opex_operations', 'opex_leasing', 'payroll', 'payroll_estimate', 'depreciation', 'financial_costs', 'cit'] as const) {
    L[k] = r2(L[k])
  }
  return L
}

export function sumLines(parts: PnlLines[]): PnlLines {
  const L = EMPTY_LINES()
  for (const p of parts) {
    for (const k of Object.keys(L) as (keyof PnlLines)[]) {
      if (typeof L[k] === 'number') (L[k] as number) += (p[k] as number) || 0
    }
  }
  L.provisional = parts.some(p => p.provisional)
  return finalizeLines(L)
}

// ── Koszty spoza KSeF (ManualCost): miesiąc memoriałowy, koszty pracy, ochrona przed podwójnym liczeniem ──
// Czyste funkcje (bez bazy) — testy: src/__tests__/finance-payroll.test.ts.

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Miesiąc memoriałowy kosztu: poprawny `period` (YYYY-MM) wygrywa, inaczej miesiąc daty przelewu / dokumentu. */
export function effectiveCostMonth(c: { date: string; period?: string | null }): string {
  const p = String(c.period ?? '').trim()
  const dateMonth = String(c.date ?? '').slice(0, 7)
  if (!PERIOD_RE.test(p)) return dateMonth
  // okres oddalony od daty o ponad 3 lata to pomyłka (np. literówka w roku) — nie przenosimy kosztu o lata
  if (PERIOD_RE.test(dateMonth)) {
    const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7))
    if (Math.abs(idx(p) - idx(dateMonth)) > 36) return dateMonth
  }
  return p
}

/** Pola ManualCost potrzebne silnikowi RZiS. */
export interface ManualCostLike {
  id: string
  date: string                    // data przelewu / dokumentu YYYY-MM-DD
  period?: string | null          // miesiąc, którego koszt dotyczy (YYYY-MM) — z tytułu przelewu albo wpisany ręcznie
  amount: number                  // dodatnia, w walucie `currency`
  currency?: string | null
  cost_category: string
  subcategory: string
  business_unit?: string | null
  source?: string | null          // manual | mt940 | document
  pnl_mode?: string | null        // auto | include | exclude
  reference?: string | null
  notes?: string | null           // notatka kursowa NBP → kwota oryginalna do porównania z transakcją bankową
}

export type ManualCostLine = Exclude<ReturnType<typeof costLine>, 'excluded'>

/** Koszt, który wchodzi do RZiS: w którym miesiącu, w której linii i czy jest kosztem pracy. */
export interface BookedManualCost<T extends ManualCostLike = ManualCostLike> {
  cost: T
  month: string                   // miesiąc RZiS (YYYY-MM)
  line: ManualCostLine
  payroll: PayrollGroup | null    // 'salaries' | 'pit' | 'zus' — po podkategorii (niezależnie od linii)
}

export interface ManualAllocation<T extends ManualCostLike = ManualCostLike> {
  booked: BookedManualCost<T>[]               // wszystkie koszty wchodzące do RZiS (cała historia, wszystkie jednostki)
  skipped_ksef: T[]                           // przelewy, które weszłyby do RZiS, ale są płatnością za fakturę KSeF
  ksef_payment_ids: Set<string>               // WSZYSTKIE przelewy z wyciągu będące płatnością za fakturę KSeF (także te i tak nieliczone)
  payroll_months: Map<string, PayrollMonth>   // koszty pracy per miesiąc — z szacunkiem ZUS / PIT-4 (cała spółka)
}

/**
 * Czy koszt z wyciągu jest płatnością za fakturę KSeF (przelew przypisany do faktury w Płatnościach).
 * Koszt liczy wtedy alokacja faktury (netto) — przelew (brutto) byłby drugim razem. Sprawdzane przy ODCZYCIE,
 * bo fakturę można przypisać do przelewu długo po imporcie wyciągu. Reguła jak przy imporcie (isKsefPayment:
 * ta sama data, kwota ±0,01, zgodna referencja); koszt przeliczony z waluty obcej porównujemy też po kwocie
 * oryginalnej z notatki kursowej, bo transakcja bankowa jest zapisana w walucie rachunku.
 */
export function isKsefInvoicePayment(c: ManualCostLike, matched: Map<string, MatchedTxLite[]>): boolean {
  if (c.source !== 'mt940' || !matched.size) return false
  const probe = { date: c.date, amount: c.amount, reference: c.reference }
  if (isKsefPayment(probe, matched)) return true
  const fx = parseFxNote(c.notes)
  return !!fx && isKsefPayment({ ...probe, amount: fx.amount }, matched)
}

/**
 * Jedna alokacja kosztów spoza KSeF dla całej historii: które koszty wchodzą do RZiS, w którym miesiącu
 * i w której linii.
 *  1. reguła włączania (includeManualCostInPnl: PLN, pnl_mode, lista bezpieczna MT940),
 *  2. VAT i przelewy własne (costLine = excluded) nigdy nie są kosztem,
 *  3. przelew będący płatnością za fakturę KSeF → pominięty (`skipped_ksef`),
 *  4. koszty pracy (pensje, PIT-4, ZUS) → miesiąc z allocatePayroll (liczone RAZ na całej historii, żeby
 *     spóźnione przelewy i miesiące odniesienia do szacunku nie zależały od oglądanego roku); heurystyki dat
 *     przelewów dotyczą tylko wierszy z wyciągu — wpis ręczny / dokument zostaje w miesiącu wskazanym przez
 *     użytkownika (effectiveCostMonth); pozostałe koszty → effectiveCostMonth.
 * `today` = bieżący miesiąc (YYYY-MM, Europe/Warsaw): szacunków za miesiące późniejsze nie ma.
 * Alokacja jest wspólna dla całej spółki — filtr jednostki działa dopiero w manualLinesByMonth.
 */
export function allocateManualCosts<T extends ManualCostLike>(
  costs: T[],
  matched: Map<string, MatchedTxLite[]>,
  today: string,
  opts: { estimate?: boolean } = {},
): ManualAllocation<T> {
  const counted: Array<{ cost: T; line: ManualCostLine; payroll: PayrollGroup | null }> = []
  const skipped_ksef: T[] = []
  const ksef_payment_ids = new Set<string>()
  for (const c of costs ?? []) {
    if (!c) continue
    // płatność za fakturę KSeF sprawdzamy dla KAŻDEGO przelewu — także nierozpoznanego (ga/other, auto), który
    // i tak nie wchodzi do RZiS: podział kosztów musi odróżnić „opłacona faktura" od „czeka na decyzję"
    const ksefPayment = isKsefInvoicePayment(c, matched)
    if (ksefPayment) ksef_payment_ids.add(String(c.id))
    if (!includeManualCostInPnl(c)) continue
    const line = costLine(c.cost_category, c.subcategory)
    if (line === 'excluded') continue
    if (ksefPayment) { skipped_ksef.push(c); continue }
    counted.push({ cost: c, line, payroll: payrollGroupOf(c.subcategory) })
  }

  const payrollInput: PayrollCost[] = counted
    .filter(x => x.payroll)
    .map(x => {
      const c = x.cost
      const row = { id: String(c.id), subcategory: c.subcategory, amount: Number(c.amount) || 0 }
      // Przelew z wyciągu: data = dzień przelewu, okres tylko gdy podał go tytuł → resztę rozstrzyga allocatePayroll.
      if (c.source === 'mt940') return { ...row, date: c.date, period: c.period ?? null }
      // Wpis ręczny / dokument: miesiąc wskazał użytkownik (period, a bez niego data) — nie stosujemy do niego
      // heurystyk dat przelewów („do 15. → miesiąc poprzedni"). Dla alokatora to koszt z okresem podanym wprost,
      // więc nadal pokrywa swój miesiąc i liczy się do wskaźników szacunku.
      const m = effectiveCostMonth(c)
      return { ...row, date: PERIOD_RE.test(m) ? lastDayOf(m) : c.date, period: m }
    })
  const { monthOf, months } = allocatePayroll(payrollInput, { today, estimate: opts.estimate })

  const booked = counted.map(x => ({
    cost: x.cost,
    // allocatePayroll pomija wiersze z niepoprawną datą — wtedy zostajemy przy zwykłej regule miesiąca
    month: (x.payroll && monthOf.get(String(x.cost.id))) || effectiveCostMonth(x.cost),
    line: x.line,
    payroll: x.payroll,
  }))
  return { booked, skipped_ksef, ksef_payment_ids, payroll_months: months }
}

/** Koszty spoza KSeF jednego miesiąca w układzie linii RZiS + składniki kosztów pracy. */
export interface ManualMonth {
  cogs_purchases: number; opex_sales: number; opex_ga: number; opex_operations: number; opex_leasing: number
  financial_costs: number; cit: number
  payroll: number            // pensje + PIT-4 + ZUS ujęte w opex_ga, ŁĄCZNIE z szacunkiem (część opex_ga)
  payroll_estimate: number   // szacowana część payroll (zus_estimate + pit4_estimate)
  salaries: number; pit4: number; zus: number           // rzeczywiste przelewy (składniki payroll)
  zus_estimate: number; pit4_estimate: number           // szacunek za miesiące bez przelewu
}

const EMPTY_MANUAL_MONTH = (): ManualMonth => ({
  cogs_purchases: 0, opex_sales: 0, opex_ga: 0, opex_operations: 0, opex_leasing: 0, financial_costs: 0, cit: 0,
  payroll: 0, payroll_estimate: 0, salaries: 0, pit4: 0, zus: 0, zus_estimate: 0, pit4_estimate: 0,
})

/**
 * Sumy kosztów spoza KSeF dla podanych miesięcy (koszty spoza listy są pomijane).
 * Jednostka: `bu` ≠ 'all' zostawia tylko koszty z dokładnie tą jednostką (jak dotychczasowy filtr w bazie).
 * SZACUNEK ZUS / PIT-4 jest liczony dla całej spółki i zastępuje przyszły przelew z wyciągu, a przelewy
 * z wyciągu mają jednostkę 'shared' — dlatego szacunek wchodzi tylko do widoku 'all' i 'shared'
 * (dzięki temu all = shc + gatelynk + shared także w miesiącach z szacunkiem).
 */
export function manualLinesByMonth(alloc: ManualAllocation, months: string[], bu = 'all'): Map<string, ManualMonth> {
  const r2 = (x: number) => Math.round(x * 100) / 100
  const out = new Map<string, ManualMonth>(months.map(m => [m, EMPTY_MANUAL_MONTH()]))
  for (const b of alloc.booked) {
    const l = out.get(b.month)
    if (!l) continue
    if (bu !== 'all' && b.cost.business_unit !== bu) continue
    const amt = Number(b.cost.amount) || 0
    if (b.line === 'cogs') l.cogs_purchases += amt
    else if (b.line === 'financial') l.financial_costs += amt
    else l[b.line] += amt
    if (b.payroll && b.line === 'opex_ga') {
      l.payroll += amt
      if (b.payroll === 'salaries') l.salaries += amt
      else if (b.payroll === 'pit') l.pit4 += amt
      else l.zus += amt
    }
  }
  if (bu === 'all' || bu === 'shared') {
    for (const m of months) {
      const p = alloc.payroll_months.get(m)
      if (!p) continue
      const l = out.get(m)!
      const zusEst = Math.max(0, p.zus_estimate || 0), pitEst = Math.max(0, p.pit_estimate || 0)
      l.zus_estimate += zusEst
      l.pit4_estimate += pitEst
      l.payroll_estimate += zusEst + pitEst
      l.payroll += zusEst + pitEst
      l.opex_ga += zusEst + pitEst
    }
  }
  for (const l of out.values()) for (const k of Object.keys(l) as (keyof ManualMonth)[]) l[k] = r2(l[k])
  return out
}

/**
 * Księgowanie kosztów spoza KSeF w miesiącach roku — to, co silnik RZiS (computePnlYear) dodaje do linii.
 * Czysta funkcja: koszty (cała historia, nie tylko rok), indeks przelewów dopasowanych do faktur KSeF,
 * rok i bieżący miesiąc.
 */
export function bookManualCosts(
  costs: ManualCostLike[],
  matched: Map<string, MatchedTxLite[]>,
  year: number,
  today: string,
  opts: { bu?: string; estimate?: boolean } = {},
): Map<string, ManualMonth> {
  return manualLinesByMonth(allocateManualCosts(costs, matched, today, { estimate: opts.estimate }), monthsOf(year), opts.bu ?? 'all')
}

/** Koszty pracy okresu (suma miesięcy): rzeczywiste przelewy + szacunek; `total` = PnlLines.payroll tego okresu. */
export interface PayrollSummary {
  salaries: number; pit4: number; zus: number
  zus_estimate: number; pit4_estimate: number
  total: number
  estimated_months: string[]   // miesiące, w których jest jakikolwiek szacunek
}

export function payrollSummary(byMonth: Map<string, ManualMonth>, months: string[]): PayrollSummary {
  const r2 = (x: number) => Math.round(x * 100) / 100
  const s: PayrollSummary = { salaries: 0, pit4: 0, zus: 0, zus_estimate: 0, pit4_estimate: 0, total: 0, estimated_months: [] }
  for (const m of months) {
    const l = byMonth.get(m)
    if (!l) continue
    s.salaries += l.salaries; s.pit4 += l.pit4; s.zus += l.zus
    s.zus_estimate += l.zus_estimate; s.pit4_estimate += l.pit4_estimate
    if (l.payroll_estimate > 0) s.estimated_months.push(m)
  }
  for (const k of ['salaries', 'pit4', 'zus', 'zus_estimate', 'pit4_estimate'] as const) s[k] = r2(s[k])
  s.total = r2(s.salaries + s.pit4 + s.zus + s.zus_estimate + s.pit4_estimate)
  return s
}

/** Wiersz ManualCost w zakresie potrzebnym silnikowi, podziałowi kosztów i „Kondycji firmy". */
export type ManualCostRow = ManualCostLike & { description: string; document_id: string | null; op_code: string | null }
export type LoadedManualCosts = ManualAllocation<ManualCostRow> & { costs: ManualCostRow[] }

/**
 * Wczytuje koszty spoza KSeF (cała historia — to setki–tysiące wierszy) i przelewy dopasowane do faktur
 * KSeF, po czym liczy JEDNĄ alokację. Cała historia zamiast okna rocznego: spóźniony ZUS (opłacony po kilku
 * miesiącach), miesiące odniesienia do szacunku i 6-miesięczne cofanie przelewów do ZUS bez okresu dają wtedy
 * ten sam wynik niezależnie od tego, który rok lub okres jest oglądany.
 */
export async function loadManualCosts(today: string = warsawToday().period): Promise<LoadedManualCosts> {
  const [costs, matchedTx] = await Promise.all([
    prisma.manualCost.findMany({
      select: {
        id: true, date: true, period: true, amount: true, currency: true, cost_category: true, subcategory: true,
        business_unit: true, source: true, pnl_mode: true, reference: true, notes: true,
        description: true, document_id: true, op_code: true,
      },
    }),
    prisma.bankTransaction.findMany({
      where: { source: 'mt940', matched_invoice_id: { not: null } },
      select: { transaction_date: true, amount: true, reference: true },
    }),
  ])
  const rows = costs as ManualCostRow[]
  return { costs: rows, ...allocateManualCosts(rows, buildMatchedIndex(matchedTx), today) }
}

// ── Podział kosztów spoza KSeF (część GET /cost-details) — czysta funkcja na TEJ SAMEJ alokacji co silnik ──
/** Pozycja podziału kosztów; `period` = miesiąc RZiS pozycji (może różnić się od miesiąca daty przelewu). */
export type CostDetailItem = { date: string; description: string; amount: number; source: string; category?: string; period?: string }
export type ManualDetailGroup = 'salaries' | 'zus' | 'taxes' | 'import' | 'non_ksef' | 'other_manual'
/** `source` pozycji szacunku ZUS / PIT-4 (nie jest wierszem z bazy; frontend pokazuje źródło jako etykietę). */
export const ESTIMATE_SOURCE = 'szacunek'
/** Import towaru: osobna grupa w podziale kosztów (faktury KSeF i koszty ręczne). */
export const IMPORT_SUBCATEGORIES = new Set(['hardware_noneu', 'hardware_eu', 'import_duty', 'import_freight', 'import_agency', 'import_vat'])

export interface ManualCostDetails {
  groups: Record<ManualDetailGroup, { total: number; items: CostDetailItem[] }>
  skipped_duplicates: { count: number; total: number }   // przelewy poza RZiS, o których już zdecydowano: płatność za fakturę KSeF / pnl_mode=exclude / kategoria fakturowana
  awaiting_decision: { count: number; total: number }    // przelewy z wyciągu poza RZiS, o których NIKT jeszcze nie zdecydował (lista „nierozpoznane przelewy")
  foreign_currency: { count: number; items: Array<CostDetailItem & { currency: string }> }
}

/**
 * Koszty spoza KSeF miesięcy `from`..`to` (YYYY-MM) w grupach podziału kosztów. Miesiąc, linia i to, czy koszt
 * w ogóle wchodzi do RZiS, pochodzą z alokacji silnika (`booked`), więc suma grup = suma linii RZiS z kosztów
 * spoza KSeF za ten sam zakres (manualLinesByMonth, widok całej spółki) — test: finance-payroll.test.ts.
 *  - pensje i zaliczki PIT-4 → `salaries`, ZUS → `zus`; SZACUNEK ZUS / PIT-4 to osobne, nazwane pozycje
 *    (`source` = ESTIMATE_SOURCE) w tych samych grupach,
 *  - VAT i przelewy własne nie są kosztem ani duplikatem; koszt w walucie obcej → `foreign_currency`,
 *  - przelew z wyciągu poza RZiS bez żadnej decyzji (pnl_mode=auto, nie płatność za fakturę KSeF) →
 *    `awaiting_decision` — to NIE jest duplikat, tylko koszt, którego być może brakuje w wyniku,
 *  - reszta kosztów poza RZiS → `skipped_duplicates`.
 * Sumy grup nie są zaokrąglane (robi to wywołujący po dodaniu faktur KSeF); pozycji nie przycinamy.
 */
export function manualCostDetails(
  manual: Pick<LoadedManualCosts, 'costs' | 'booked' | 'payroll_months'> & { ksef_payment_ids?: Set<string> },
  from: string,
  to: string,
): ManualCostDetails {
  const r2 = (x: number) => Math.round(x * 100) / 100
  const inRange = (m: string) => m >= from && m <= to
  const mk = () => ({ total: 0, items: [] as CostDetailItem[] })
  const out: ManualCostDetails = {
    groups: { salaries: mk(), zus: mk(), taxes: mk(), import: mk(), non_ksef: mk(), other_manual: mk() },
    skipped_duplicates: { count: 0, total: 0 },
    awaiting_decision: { count: 0, total: 0 },
    foreign_currency: { count: 0, items: [] },
  }
  const ksefPaid = manual.ksef_payment_ids ?? new Set<string>()
  const add = (g: ManualDetailGroup, item: CostDetailItem) => { out.groups[g].total += item.amount; out.groups[g].items.push(item) }

  const bookedById = new Map(manual.booked.map(b => [b.cost.id, b]))
  for (const c of manual.costs) {
    const booked = bookedById.get(c.id)
    const m = booked ? booked.month : effectiveCostMonth(c)
    if (!inRange(m)) continue
    const category = `${c.cost_category}/${c.subcategory}`
    if (isForeignCurrencyCost(c)) {
      // kwota w EUR/USD… nie jest w PLN — nie sumujemy jej z resztą ani nie liczymy jako duplikat
      out.foreign_currency.count += 1
      if (out.foreign_currency.items.length < 200) out.foreign_currency.items.push({
        date: c.date, description: c.description, amount: r2(c.amount), currency: String(c.currency),
        source: String(c.source ?? ''), category,
      })
      continue
    }
    // VAT i przelewy własne (rachunek VAT, między swoimi kontami) — poza RZiS; to nie koszt ani duplikat
    if (costLine(c.cost_category, c.subcategory) === 'excluded') continue
    if (!booked) {
      // poza RZiS. Przelew z wyciągu, o którym nikt nie zdecydował (pnl_mode=auto, nierozpoznany, nie jest
      // płatnością za fakturę KSeF) CZEKA NA DECYZJĘ — może to być koszt, którego w wyniku brakuje.
      // Pozostałe: przelew przypisany w Płatnościach do faktury KSeF, pnl_mode=exclude, kategoria fakturowana.
      const undecided = c.source === 'mt940' && (c.pnl_mode ?? 'auto') === 'auto' && !ksefPaid.has(String(c.id))
      const bucket = undecided ? out.awaiting_decision : out.skipped_duplicates
      bucket.count += 1; bucket.total += Number(c.amount) || 0
      continue
    }
    const fromNonKsef = c.source === 'document' || (c.source === 'mt940' && c.pnl_mode === 'include')
    // Koszty pracy tylko z linii G&A (tak liczy je payroll w RZiS); koszt pracy zaksięgowany w innej linii
    // (np. umowa o dzieło w kosztach sprzedanych) zostaje w grupie swojego źródła
    const payroll = booked.line === 'opex_ga' ? booked.payroll : null
    const group: ManualDetailGroup = (payroll === 'salaries' || payroll === 'pit') ? 'salaries'
      : payroll === 'zus' ? 'zus'
      : booked.line === 'cit' ? 'taxes'
      : IMPORT_SUBCATEGORIES.has(c.subcategory) ? 'import'
      : fromNonKsef ? 'non_ksef'
      : 'other_manual'
    add(group, {
      date: c.date,
      // koszt ujęty w innym miesiącu niż data przelewu (np. spóźniony ZUS, pensja wypłacona 1.–2.) — mówimy to wprost
      description: m !== String(c.date).slice(0, 7) ? `${c.description} (koszt za ${monthLabel(m)})` : c.description,
      amount: r2(c.amount),
      source: String(c.source ?? ''), category, period: m,
    })
  }

  // Szacunek ZUS / PIT-4 za miesiące, za które przelewu jeszcze nie było (jest w RZiS — pokazujemy osobno)
  for (const [m, p] of manual.payroll_months) {
    if (!inRange(m)) continue
    if (p.zus_estimate > 0) add('zus', {
      date: lastDayOf(m), description: `ZUS — szacunek za ${monthLabel(m)} (przelewu jeszcze nie było)`,
      amount: r2(p.zus_estimate), source: ESTIMATE_SOURCE, category: 'ga/zus_employer', period: m,
    })
    if (p.pit_estimate > 0) add('salaries', {
      date: lastDayOf(m), description: `PIT-4 — szacunek za ${monthLabel(m)} (przelewu jeszcze nie było)`,
      amount: r2(p.pit_estimate), source: ESTIMATE_SOURCE, category: 'ga/salary_pit', period: m,
    })
  }
  return out
}

// ── POST /api/finance/manual-cost — ręczny koszt (np. import towaru z zagranicy) ──
// Import spoza UE nie ma faktury w KSeF (dokumenty celne), więc musi dać się
// dopisać ręcznie. Trafia do ManualCost (source=manual) i wchodzi do RZiS w całości.
router.post('/manual-cost', async (req: Request, res: Response) => {
  try {
    const { date, description, amount, cost_category, subcategory, business_unit } = req.body ?? {}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) { res.status(400).json({ error: 'Wymagana data (YYYY-MM-DD)' }); return }
    const amt = Number(amount)
    if (!description || !String(description).trim() || !amt || isNaN(amt)) {
      res.status(400).json({ error: 'Wymagane: opis i kwota' }); return
    }
    const u: any = (req as any).user
    const cost = await prisma.manualCost.create({ data: {
      id: uuidv4(), date: String(date),
      description: String(description).trim().slice(0, 500),
      amount: Math.round(amt * 100) / 100,
      currency: 'PLN',
      cost_category: String(cost_category || 'cogs'),
      subcategory: String(subcategory || 'hardware_noneu'),
      business_unit: ['shc', 'gatelynk', 'shared'].includes(business_unit) ? business_unit : 'shc',
      period: String(date).slice(0, 7),
      source: 'manual',
      created_at: now(), created_by: u?.email ?? '',
    }})
    res.status(201).json(cost)
  } catch (e) {
    console.error('[finance/manual-cost]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── GET /api/finance/cost-details?from=YYYY-MM&to=YYYY-MM — pełny podział kosztów ──
// Grupy spójne z regułami RZiS (te same wykluczenia, przeliczenia brutto→netto i TEN SAM miesiąc kosztu
// co w silniku — loadManualCosts → manualCostDetails): pensje (+ PIT-4) / ZUS / podatki (CIT) / import /
// faktury KSeF / inne ręczne + pominięte duplikaty MT940 + koszty per projekt.
// Szacunek ZUS / PIT-4 jest osobną pozycją (source = ESTIMATE_SOURCE).
router.get('/cost-details', async (req: Request, res: Response) => {
  try {
    const from = String(req.query.from ?? '').slice(0, 7)
    const to = String(req.query.to ?? from).slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
      res.status(400).json({ error: 'Wymagane: from, to (YYYY-MM)' }); return
    }
    const inRange = (m: string) => m >= from && m <= to

    const [allocations, manual] = await Promise.all([
      prisma.ksefInvoiceAllocation.findMany({
        include: {
          invoice: { select: { invoice_number: true, seller_name: true, invoice_date: true, created_at: true, net_amount: true, gross_amount: true, invoice_direction: true } },
          project: { select: { id: true, name: true } },
        },
      }),
      loadManualCosts(),
    ])

    const r2 = (x: number) => Math.round(x * 100) / 100
    const mkGroup = () => ({ total: 0, items: [] as CostDetailItem[] })
    const groups = {
      salaries: mkGroup(),      // pensje + zaliczki PIT-4 (MT940/ręczne) + szacunek PIT-4
      zus: mkGroup(),           // ZUS + szacunek ZUS
      taxes: mkGroup(),         // CIT (VAT poza RZiS — neutralny)
      import: mkGroup(),        // import towaru: cło, fracht, agencja, towar spoza UE
      ksef_invoices: mkGroup(), // pozostałe faktury kosztowe z KSeF
      non_ksef: mkGroup(),      // koszty spoza KSeF: dokumenty ze skrzynki + przelewy z reguł bankowych
      other_manual: mkGroup(),  // inne koszty ręczne
    }
    const projectMap = new Map<string, { project_id: string | null; name: string; total: number; count: number }>()

    // ── Alokacje KSeF (brutto → netto proporcją faktury) ──
    for (const a of allocations as any[]) {
      const inv = a.invoice
      if (!inv || inv.invoice_direction === 'outgoing') continue
      const m = (inv.invoice_date || inv.created_at || '').slice(0, 7)
      if (!inRange(m)) continue
      const line = costLine(a.cost_category, a.subcategory)
      if (line === 'excluded') continue
      const netRatio = inv.gross_amount > 0 && inv.net_amount > 0 ? inv.net_amount / inv.gross_amount : 1
      const amount = r2(a.amount * netRatio)
      const item: CostDetailItem = {
        date: (inv.invoice_date || '').slice(0, 10),
        description: `${inv.seller_name ?? '—'} · ${inv.invoice_number ?? 'b/n'}`,
        amount, source: 'ksef', category: `${a.cost_category}/${a.subcategory}`,
      }
      const g = IMPORT_SUBCATEGORIES.has(a.subcategory) ? groups.import : groups.ksef_invoices
      g.total += amount; g.items.push(item)

      // per projekt
      const key = a.project_id ?? '__none__'
      const cur = projectMap.get(key) ?? { project_id: a.project_id ?? null, name: a.project?.name ?? 'Bez projektu (koszty firmowe)', total: 0, count: 0 }
      cur.total += amount; cur.count += 1
      projectMap.set(key, cur)
    }

    // ── Koszty ręczne/MT940 — miesiąc jak w silniku RZiS (koszty pracy memoriałowo, reszta: period / data),
    // + szacunek ZUS / PIT-4 za miesiące, za które przelewu jeszcze nie było ──
    const manualDetails = manualCostDetails(manual, from, to)
    for (const k of Object.keys(manualDetails.groups) as ManualDetailGroup[]) {
      groups[k].total += manualDetails.groups[k].total
      groups[k].items.push(...manualDetails.groups[k].items)
    }
    // MT940 pominięte (kategorie fakturowane → są w KSeF, płatności za faktury KSeF, pnl_mode=exclude)
    const skippedDuplicates = { count: manualDetails.skipped_duplicates.count, total: r2(manualDetails.skipped_duplicates.total) }
    // Koszty w walucie obcej bez przeliczenia na PLN — poza RZiS, do ręcznego przeliczenia
    const foreignCurrency = manualDetails.foreign_currency

    for (const g of Object.values(groups)) {
      g.total = r2(g.total)
      g.items.sort((a, b) => b.date.localeCompare(a.date))
      if (g.items.length > 200) g.items = g.items.slice(0, 200)
    }

    const projects = [...projectMap.values()].map(p => ({ ...p, total: r2(p.total) })).sort((a, b) => b.total - a.total)
    const total = r2(Object.values(groups).reduce((s, g) => s + g.total, 0))

    foreignCurrency.items.sort((a, b) => b.date.localeCompare(a.date))

    const awaitingDecision = { count: manualDetails.awaiting_decision.count, total: r2(manualDetails.awaiting_decision.total) }
    res.json({ from, to, groups, projects, skipped_mt940_duplicates: skippedDuplicates, mt940_awaiting_decision: awaitingDecision, foreign_currency_costs: foreignCurrency, total })
  } catch (e) {
    console.error('[finance/cost-details]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── Silnik: pełny RZiS roku (miesiące, kwartały, YTD, jakość danych) ─────────
// Używany przez GET /pnl, „Kondycję firmy", raport e-mail i uzgodnienie z księgową.
export type PnlYear = {
  year: number
  business_unit: string
  revenue_scope: 'business_unit' | 'company_wide'
  months: Array<PnlLines & { period: string }>
  quarters: Array<PnlLines & { quarter: string }>
  ytd: PnlLines & { label: string }
  firmao_months: string[]
  inventory_in_pnl: boolean
  quality: { unallocated_ksef_invoices: number; suspect_sales_records: number; fixed_assets_count: number }
}

/**
 * `manual` — gotowa alokacja kosztów spoza KSeF (loadManualCosts); podaj ją, gdy liczysz kilka lat lub łączysz
 * RZiS z innym widokiem (Kondycja firmy, uzgodnienie z księgową), żeby wszystko opierało się na tych samych danych.
 */
export async function computePnlYear(year: number, bu = 'all', manual?: ManualAllocation): Promise<PnlYear> {
  {
    const months = monthsOf(year)
    const yFrom = `${year}-01-01`, yTo = `${year}-12-31`

    // Źródła — jedno zapytanie na rok, agregacja w JS (skala: setki rekordów).
    // Koszty spoza KSeF: cała historia, wszystkie jednostki (filtr jednostki w manualLinesByMonth) — koszt
    // zapłacony w innym roku niż ten, którego dotyczy (ZUS z opóźnieniem, pensja 2 stycznia), musi być widoczny.
    const [salesRecords, ksefOutgoing, moduleInvoices, allocations, manualAlloc, assets] = await Promise.all([
      prisma.salesRecord.findMany({ where: { period: { gte: months[0], lte: months[11] } } }),
      prisma.ksefInvoice.findMany({
        where: { invoice_direction: 'outgoing', invoice_date: { gte: yFrom, lte: yTo } },
        select: { id: true, net_amount: true, gross_amount: true, invoice_date: true, ksef_number: true },
      }),
      prisma.salesInvoice.findMany({
        where: { status: { in: ['issued', 'paid'] } },
        select: { id: true, total_net: true, sale_date: true, issue_date: true, ksef_number: true, company_id: true },
      }),
      prisma.ksefInvoiceAllocation.findMany({
        where: bu !== 'all' ? { business_unit: bu } : {},
        include: { invoice: { select: { invoice_date: true, created_at: true, net_amount: true, gross_amount: true, invoice_direction: true } } },
      }),
      manual ? Promise.resolve(manual) : loadManualCosts(),
      prisma.fixedAsset.findMany(),
    ])

    const byMonth = new Map<string, PnlLines>(months.map(m => [m, EMPTY_LINES()]))
    const L = (m: string) => byMonth.get(m)

    // ── Przychody ──
    const firmaoMonths = new Set(salesRecords.map((r: any) => r.period))
    const matchedModuleIds = new Set(salesRecords.map((r: any) => r.dedup_status === 'module_match' ? r.matched_id : null).filter(Boolean))
    // faktury KSeF zdeduplikowane w JAKIMKOLWIEK rekordzie Firmao (także suspect i z innego miesiąca)
    const matchedKsefIds = new Set(salesRecords.map((r: any) => (r.dedup_status === 'ksef_match' || r.dedup_status === 'suspect') ? r.matched_id : null).filter(Boolean))

    for (const r of salesRecords as any[]) {
      const l = L(r.period); if (!l) continue
      l.revenue_firmao += r.net
      l.revenue += r.net
      if (r.doc_type === 'zaliczkowa') l.revenue_advances += r.net
    }
    for (const inv of ksefOutgoing as any[]) {
      const m = (inv.invoice_date || '').slice(0, 7)
      const l = L(m); if (!l) continue
      if (firmaoMonths.has(m)) continue        // miesiąc zamknięty Firmao — KSeF tylko do kontroli krzyżowej
      if (matchedKsefIds.has(inv.id)) continue // ujęta w rekordzie Firmao (np. z sąsiedniego miesiąca)
      l.revenue_ksef += inv.net_amount
      l.revenue += inv.net_amount
    }
    const inScope = await moduleInvoiceScope() // faktury innej spółki (np. GateLynk Sp. z o.o.) nie są przychodem SHC
    for (const inv of moduleInvoices as any[]) {
      const m = ((inv.sale_date || inv.issue_date) || '').slice(0, 7)
      const l = L(m); if (!l) continue
      if (!inScope(inv, bu)) continue
      if (inv.ksef_number) continue                 // trafiła do KSeF — nie liczymy drugi raz
      if (matchedModuleIds.has(inv.id)) continue    // jest w Firmao — nie liczymy drugi raz
      l.revenue_module += inv.total_net
      l.revenue += inv.total_net
    }
    for (const m of months) { const l = L(m)!; l.provisional = !firmaoMonths.has(m) }

    // ── Koszty: alokacje KSeF (brutto → netto proporcją faktury) ──
    for (const a of allocations as any[]) {
      if (a.invoice?.invoice_direction === 'outgoing') continue
      const m = (a.invoice?.invoice_date || a.invoice?.created_at || a.created_at || '').slice(0, 7)
      const l = L(m); if (!l) continue
      const inv = a.invoice
      // proporcja tylko gdy oba > 0 — inaczej zachowawczo 1 (koszt brutto zamiast zgubionego)
      const netRatio = inv && inv.gross_amount > 0 && inv.net_amount > 0 ? inv.net_amount / inv.gross_amount : 1
      const amountNet = a.amount * netRatio
      const line = costLine(a.cost_category, a.subcategory)
      if (line === 'excluded') continue
      if (line === 'cit') l.cit += amountNet
      else if (line === 'financial') l.financial_costs += amountNet
      else if (line === 'cogs') l.cogs_purchases += amountNet
      else l[line] += amountNet
    }

    // ── Koszty: MT940/ręczne/dokumenty — memoriałowo (allocateManualCosts): reguła włączania
    // includeManualCostInPnl, bez płatności za faktury KSeF, koszty pracy w miesiącu, którego dotyczą,
    // + szacunek ZUS / PIT-4 za miesiące bez przelewu (w opex_ga; payroll / payroll_estimate informacyjnie) ──
    const manualMonths = manualLinesByMonth(manualAlloc, months, bu)
    for (const m of months) {
      const l = L(m)!, x = manualMonths.get(m)!
      l.cogs_purchases += x.cogs_purchases
      l.opex_sales += x.opex_sales
      l.opex_ga += x.opex_ga
      l.opex_operations += x.opex_operations
      l.opex_leasing += x.opex_leasing
      l.financial_costs += x.financial_costs
      l.cit += x.cit
      l.payroll += x.payroll
      l.payroll_estimate += x.payroll_estimate
    }

    // ── Amortyzacja ──
    for (const m of months) L(m)!.depreciation = depreciationForPeriod(assets as any[], m)

    // ── Zmiana stanu magazynu (koszt sprzedanych towarów zamiast kosztu zakupów) ──
    // Magazyn nie ma podziału na jednostki (WarehouseItem/StockMovement bez business_unit),
    // więc zmiana stanu wchodzi do RZiS TYLKO w widoku całej spółki — w widoku jednostki
    // odejmowałaby zapasy całej firmy od zakupów jednej jednostki (ujemny COGS, potrójne liczenie).
    const settings = await getCompanySettings().catch(() => null)
    const inventoryInPnl = (settings ? settings.inventory_in_pnl !== false : true) && bu === 'all'
    if (inventoryInPnl) {
      const inv = await inventoryChangeByMonth(months)
      for (const m of months) L(m)!.inventory_change = inv.get(m) ?? 0
    }

    for (const m of months) finalizeLines(L(m)!)

    // ── Agregaty ──
    const monthLines = months.map(m => ({ period: m, ...L(m)! }))
    const quarters = [0, 1, 2, 3].map(q => ({
      quarter: `Q${q + 1}`,
      ...sumLines(months.slice(q * 3, q * 3 + 3).map(m => L(m)!)),
    }))
    const nowPeriod = new Date().toISOString().slice(0, 7)
    const ytdMonths = months.filter(m => m <= nowPeriod)
    const ytd = sumLines((ytdMonths.length ? ytdMonths : months).map(m => L(m)!))

    // ── Jakość danych ──
    const unallocatedInvoices = await prisma.ksefInvoice.count({
      where: { invoice_direction: 'incoming', invoice_date: { gte: yFrom, lte: yTo }, allocations: { none: {} } },
    })
    const suspects = (salesRecords as any[]).filter(r => r.dedup_status === 'suspect').length

    return {
      year,
      business_unit: bu,
      // Rekordy sprzedaży (Firmao/KSeF/moduł) nie mają przypisania do jednostki —
      // przy filtrze BU przychody pozostają dla całej spółki (tylko koszty są filtrowane)
      revenue_scope: bu === 'all' ? 'business_unit' : 'company_wide',
      months: monthLines,
      quarters,
      ytd: { label: 'YTD', ...ytd },
      firmao_months: [...firmaoMonths].sort(),
      inventory_in_pnl: inventoryInPnl,
      quality: {
        unallocated_ksef_invoices: unallocatedInvoices,
        suspect_sales_records: suspects,
        fixed_assets_count: (assets as any[]).length,
      },
    }
  }
}

// ── GET /api/finance/pnl?year=YYYY&business_unit=all|shc|gatelynk|shared ──────
router.get('/pnl', async (req: Request, res: Response) => {
  try {
    const year = parseInt(String(req.query.year)) || new Date().getFullYear()
    const bu = String(req.query.business_unit ?? 'all')
    res.json(await computePnlYear(year, bu))
  } catch (e) {
    console.error('[finance/pnl]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
