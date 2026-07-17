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
 */
import { Router, Request, Response } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import * as XLSX from 'xlsx'
import { requirePayments } from './payables'
import db, { prisma } from '../db'

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
    const moduleInvoices = await prisma.salesInvoice.findMany({
      where: { status: { in: ['issued', 'paid'] } },
      select: { id: true, number: true, total_gross: true, sale_date: true, issue_date: true, buyer_name: true },
    })
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
function monthsOf(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

function addMonths(period: string, n: number): string {
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

const EMPTY_LINES = () => ({
  revenue: 0, revenue_firmao: 0, revenue_ksef: 0, revenue_module: 0, revenue_advances: 0,
  cogs: 0, gross_margin: 0, gross_margin_pct: 0,
  opex: 0, opex_sales: 0, opex_ga: 0, opex_operations: 0, opex_leasing: 0,
  ebitda: 0, ebitda_pct: 0,
  depreciation: 0, ebit: 0,
  financial_costs: 0, cit: 0, net_result: 0,
  provisional: true, // brak importu Firmao → przychód wstępny (KSeF+moduł)
})
export type PnlLines = ReturnType<typeof EMPTY_LINES>

// Klasyfikacja pozycji kosztowej do linii RZiS
export function costLine(cost_category: string, subcategory: string):
  'cogs' | 'opex_sales' | 'opex_ga' | 'opex_operations' | 'opex_leasing' | 'financial' | 'cit' | 'excluded' {
  if (subcategory === 'tax_vat') return 'excluded'   // VAT jest neutralny — nie jest kosztem
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

function finalizeLines(L: PnlLines): PnlLines {
  const r2 = (x: number) => Math.round(x * 100) / 100
  L.opex = r2(L.opex_sales + L.opex_ga + L.opex_operations + L.opex_leasing)
  L.gross_margin = r2(L.revenue - L.cogs)
  L.gross_margin_pct = L.revenue > 0 ? r2(L.gross_margin / L.revenue * 100) : 0
  L.ebitda = r2(L.gross_margin - L.opex)
  L.ebitda_pct = L.revenue > 0 ? r2(L.ebitda / L.revenue * 100) : 0
  L.ebit = r2(L.ebitda - L.depreciation)
  L.net_result = r2(L.ebit - L.financial_costs - L.cit)
  for (const k of ['revenue', 'revenue_firmao', 'revenue_ksef', 'revenue_module', 'revenue_advances', 'cogs', 'opex_sales', 'opex_ga', 'opex_operations', 'opex_leasing', 'depreciation', 'financial_costs', 'cit'] as const) {
    L[k] = r2(L[k])
  }
  return L
}

function sumLines(parts: PnlLines[]): PnlLines {
  const L = EMPTY_LINES()
  for (const p of parts) {
    for (const k of Object.keys(L) as (keyof PnlLines)[]) {
      if (typeof L[k] === 'number') (L[k] as number) += (p[k] as number) || 0
    }
  }
  L.provisional = parts.some(p => p.provisional)
  return finalizeLines(L)
}

// ── GET /api/finance/pnl?year=YYYY&business_unit=all|shc|gatelynk|shared ──────
router.get('/pnl', async (req: Request, res: Response) => {
  try {
    const year = parseInt(String(req.query.year)) || new Date().getFullYear()
    const bu = String(req.query.business_unit ?? 'all')
    const months = monthsOf(year)
    const yFrom = `${year}-01-01`, yTo = `${year}-12-31`

    // Źródła — jedno zapytanie na rok, agregacja w JS (skala: setki rekordów)
    const [salesRecords, ksefOutgoing, moduleInvoices, allocations, manualCosts, assets] = await Promise.all([
      prisma.salesRecord.findMany({ where: { period: { gte: months[0], lte: months[11] } } }),
      prisma.ksefInvoice.findMany({
        where: { invoice_direction: 'outgoing', invoice_date: { gte: yFrom, lte: yTo } },
        select: { id: true, net_amount: true, gross_amount: true, invoice_date: true, ksef_number: true },
      }),
      prisma.salesInvoice.findMany({
        where: { status: { in: ['issued', 'paid'] } },
        select: { id: true, total_net: true, sale_date: true, issue_date: true, ksef_number: true },
      }),
      prisma.ksefInvoiceAllocation.findMany({
        where: bu !== 'all' ? { business_unit: bu } : {},
        include: { invoice: { select: { invoice_date: true, created_at: true, net_amount: true, gross_amount: true, invoice_direction: true } } },
      }),
      prisma.manualCost.findMany({ where: { date: { gte: yFrom, lte: yTo }, ...(bu !== 'all' ? { business_unit: bu } : {}) } }),
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
    for (const inv of moduleInvoices as any[]) {
      const m = ((inv.sale_date || inv.issue_date) || '').slice(0, 7)
      const l = L(m); if (!l) continue
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
      else l[line] += amountNet
    }

    // ── Koszty: MT940/ręczne ──
    // Wiersze z MT940 tylko z kategorii, które NIGDY nie przychodzą fakturą w KSeF
    // (pensje, ZUS, podatki, opłaty bankowe) — czynsz/paliwo/leasing płacone przelewem mają
    // fakturę w KSeF i liczyłyby się podwójnie. Wpisy ręczne (source=manual) wchodzą w całości.
    const MT940_SAFE_SUBCATEGORIES = new Set(['salary_gross', 'salary_admin', 'zus_employer', 'tax_income', 'tax_vat', 'bank_fee', 'interest', 'fx'])
    for (const c of manualCosts as any[]) {
      if (c.source === 'mt940' && !MT940_SAFE_SUBCATEGORIES.has(c.subcategory)) continue
      const m = (c.date || '').slice(0, 7)
      const l = L(m); if (!l) continue
      const line = costLine(c.cost_category, c.subcategory)
      if (line === 'excluded') continue
      if (line === 'cit') l.cit += c.amount
      else if (line === 'financial') l.financial_costs += c.amount
      else l[line] += c.amount
    }

    // ── Amortyzacja ──
    for (const m of months) L(m)!.depreciation = depreciationForPeriod(assets as any[], m)

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

    res.json({
      year,
      business_unit: bu,
      // Rekordy sprzedaży (Firmao/KSeF/moduł) nie mają przypisania do jednostki —
      // przy filtrze BU przychody pozostają dla całej spółki (tylko koszty są filtrowane)
      revenue_scope: bu === 'all' ? 'business_unit' : 'company_wide',
      months: monthLines,
      quarters,
      ytd: { label: 'YTD', ...ytd },
      firmao_months: [...firmaoMonths].sort(),
      quality: {
        unallocated_ksef_invoices: unallocatedInvoices,
        suspect_sales_records: suspects,
        fixed_assets_count: (assets as any[]).length,
      },
    })
  } catch (e) {
    console.error('[finance/pnl]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
