/**
 * Zestawienie obrotów i sald od księgowej + uzgodnienie z naszym RZiS.
 * Mount: /api/finance/accountant (admin lub księgowy — requirePayments).
 *
 * Przepływ: biuro rachunkowe przysyła miesięczne ZOiS (CSV/XLSX) → parsujemy konta → mapujemy
 * na linie RZiS księgowej (przychody 70x–74x, koszt sprzedanych towarów 701/731/741 → `cogs`,
 * koszty rodzajowe 40x, CIT 87x) → porównujemy
 * z `computePnlYear` linia po linii. Tryb `ytd` (obroty narastająco od stycznia): miesiąc =
 * bieżące − zapisane narastające za poprzedni miesiąc.
 */
import { Router, Request, Response } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { requirePayments } from './payables'
import { computePnlYear, addMonths, includeManualCostInPnl } from './finance'
import {
  parseZoisFile, parseZoisRows, mapZoisToLines, diffZoisRows, emptyAccountantLines, MAX_ZOIS_ROWS,
  type ZoisRow, type AccountantLines,
} from '../utils/zoisParser'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

router.use(requirePayments)

const now = () => new Date().toISOString()
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const fmtPln = (n: number) => `${new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(Math.round(Math.abs(n)))} zł`

// Pensje i ZUS w naszym RZiS (konto 404 + 405 u księgowej). salary_civil (UoD/UoZ) księguje się
// też na 404; B2B to 402 (usługi obce), więc zostaje w „pozostałych kosztach”.
const SALARY_SUBCATEGORIES = ['salary_gross', 'salary_admin', 'salary_civil', 'zus_employer']

function toLines(json: any): AccountantLines {
  const L = emptyAccountantLines()
  const src = (json && typeof json === 'object') ? json : {}
  for (const k of Object.keys(L) as (keyof AccountantLines)[]) {
    if (k === 'warnings') L.warnings = Array.isArray(src.warnings) ? src.warnings.map(String) : []
    else if (k === 'source_classes') L.source_classes = src.source_classes === '5' ? '5' : '4'
    else L[k] = Number(src[k]) || 0
  }
  return L
}

function isFalsy(v: any): boolean {
  if (v === false || v === 0) return true
  return ['false', '0', 'no', 'nie'].includes(String(v ?? '').trim().toLowerCase())
}

// ── POST /import — multipart: file + period (YYYY-MM) + mode (monthly|ytd) + dry_run ('true' domyślnie) ──
router.post('/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Brak pliku. Wyślij zestawienie (CSV/XLSX) w polu "file".' }); return }
    const period = String(req.body?.period ?? '').trim().slice(0, 7)
    if (!PERIOD_RE.test(period)) { res.status(400).json({ error: 'Podaj okres w formacie RRRR-MM (np. 2026-08).' }); return }
    let mode = String(req.body?.mode ?? 'monthly').trim().toLowerCase()
    if (mode !== 'monthly' && mode !== 'ytd') { res.status(400).json({ error: 'Tryb musi być "monthly" (obroty miesiąca) lub "ytd" (narastająco od stycznia).' }); return }
    const dryRun = !isFalsy(req.body?.dry_run ?? 'true')

    let rawRows: any[][]
    try {
      rawRows = parseZoisFile(req.file.buffer, req.file.originalname || '')
    } catch (e: any) {
      res.status(400).json({ error: `Nie udało się odczytać pliku: ${e?.message ?? 'nieznany format'}` }); return
    }
    if (rawRows.length > MAX_ZOIS_ROWS) {
      res.status(400).json({ error: `Plik ma ${rawRows.length} wierszy — to nie wygląda na zestawienie obrotów i sald (maksymalnie ${MAX_ZOIS_ROWS}). Wgraj ZOiS, nie dziennik ani zapisy na kontach.` }); return
    }
    const parsed = parseZoisRows(rawRows)
    const warnings = [...parsed.warnings]
    if (!parsed.rows.length) {
      res.status(400).json({ error: 'Nie rozpoznano wierszy kont w pliku.', warnings, detected: parsed.detected }); return
    }

    // Tryb narastający: miesiąc = bieżące − poprzednie (jeśli mamy poprzedni miesiąc w trybie ytd)
    let monthRows: ZoisRow[] = parsed.rows
    if (mode === 'ytd') {
      if (parsed.detected.has_period_and_ytd) {
        warnings.push('Plik zawiera obroty okresu — użyto ich jako obrotów miesiąca (bez odejmowania poprzedniego miesiąca); zapisano w trybie miesięcznym.')
        mode = 'monthly'
      } else if (period.endsWith('-01')) {
        warnings.push('Styczeń: obroty narastające są równe obrotom miesiąca.')
      } else {
        const prevPeriod = addMonths(period, -1)
        const prev = await prisma.accountantStatement.findFirst({ where: { period: prevPeriod } })
        if (prev && prev.mode === 'ytd') {
          monthRows = diffZoisRows(parsed.rows, (prev.rows as unknown as ZoisRow[]) ?? [])
          warnings.push(`Obroty miesiąca policzono jako różnicę narastających: ${period} − ${prevPeriod}.`)
        } else {
          warnings.push(`Brak zestawienia narastającego za ${prevPeriod} — zapisano obroty narastające jako obroty miesiąca. Wgraj najpierw poprzedni miesiąc (tryb „narastająco”), aby policzyć różnicę.`)
        }
      }
    }

    const lines = mapZoisToLines(monthRows)
    warnings.push(...lines.warnings)

    let saved = false
    if (!dryRun) {
      const user = (req as any).user
      const data = {
        period, mode,
        file_name: String(req.file.originalname || '').slice(0, 200),
        rows: parsed.rows as any,       // surowe wiersze z pliku (w trybie ytd — narastające, potrzebne następnemu miesiącowi)
        lines: lines as any,            // linie MIESIĄCA
        revenue: lines.revenue, costs: lines.costs_total, result: lines.result,
        created_by: String(user?.email ?? ''),
        created_at: now(),
      }
      const existing = await prisma.accountantStatement.findFirst({ where: { period } })
      if (existing) await prisma.accountantStatement.update({ where: { id: existing.id }, data })
      else await prisma.accountantStatement.create({ data: { id: uuidv4(), ...data } })
      saved = true
    }

    res.json({ period, mode, lines, rows_count: parsed.rows.length, detected: parsed.detected, warnings, dry_run: dryRun, saved })
  } catch (e: any) {
    console.error('[finance/accountant/import]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd importu zestawienia' })
  }
})

// ── GET / — lista zapisanych zestawień ────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const list = await prisma.accountantStatement.findMany({
      orderBy: { period: 'desc' },
      select: { period: true, mode: true, revenue: true, costs: true, result: true, file_name: true, created_at: true },
    })
    res.json(list)
  } catch (e) {
    console.error('[finance/accountant/list]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── Nasz RZiS za miesiąc (do porównania) ──────────────────────────────────────
async function computeOurs(period: string) {
  const year = parseInt(period.slice(0, 4), 10)
  const from = `${period}-01`, to = `${period}-31`
  const [pnl, manualCosts, allocations, unallocated] = await Promise.all([
    computePnlYear(year),
    prisma.manualCost.findMany({ where: { date: { gte: from, lte: to }, subcategory: { in: SALARY_SUBCATEGORIES } } }),
    prisma.ksefInvoiceAllocation.findMany({
      where: { subcategory: { in: SALARY_SUBCATEGORIES } },
      include: { invoice: { select: { invoice_date: true, created_at: true, net_amount: true, gross_amount: true, invoice_direction: true } } },
    }),
    prisma.ksefInvoice.count({ where: { invoice_direction: 'incoming', invoice_date: { gte: from, lte: to }, allocations: { none: {} } } }),
  ])
  const month = pnl.months.find(m => m.period === period)
  if (!month) throw new Error(`Brak miesiąca ${period} w RZiS`)

  let salariesSocial = 0
  for (const c of manualCosts as any[]) if (includeManualCostInPnl(c)) salariesSocial += c.amount || 0
  for (const a of allocations as any[]) {
    const inv = a.invoice
    if (!inv || inv.invoice_direction === 'outgoing') continue
    if ((inv.invoice_date || inv.created_at || a.created_at || '').slice(0, 7) !== period) continue
    const netRatio = inv.gross_amount > 0 && inv.net_amount > 0 ? inv.net_amount / inv.gross_amount : 1
    salariesSocial += (a.amount || 0) * netRatio
  }

  const costs_total = r2(month.cogs + month.opex + month.depreciation + month.financial_costs)
  return {
    ours: {
      revenue: r2(month.revenue),
      depreciation: r2(month.depreciation),
      salaries_social: r2(salariesSocial),
      cit: r2(month.cit),
      other_costs: r2(costs_total - month.depreciation - salariesSocial),
      costs_total,
      result: r2(month.net_result),
    },
    provisional: !!month.provisional,
    unallocated,
  }
}

// ── GET /:period/compare — nasz RZiS vs księgowa, linia po linii ──────────────
router.get('/:period/compare', async (req: Request, res: Response) => {
  try {
    const period = String(req.params.period ?? '').slice(0, 7)
    if (!PERIOD_RE.test(period)) { res.status(400).json({ error: 'Okres w formacie RRRR-MM.' }); return }
    const st = await prisma.accountantStatement.findFirst({ where: { period } })
    if (!st) { res.status(404).json({ error: 'Brak zestawienia księgowej za ten okres.' }); return }

    const theirs = toLines(st.lines)
    const { ours, provisional, unallocated } = await computeOurs(period)

    const t = {
      revenue: theirs.revenue,
      other_revenue: theirs.other_revenue,
      depreciation: theirs.depreciation,
      salaries_social: r2(theirs.salaries + theirs.social),
      other_costs: r2(theirs.costs_total - theirs.depreciation - theirs.salaries - theirs.social),
      costs_total: theirs.costs_total,
      cit: theirs.cit,
      result: theirs.result,
    }
    const line = (key: string, label: string, o: number, th: number) => ({ key, label, ours: r2(o), theirs: r2(th), diff: r2(o - th) })
    const by_line = [
      line('revenue', 'Przychody ze sprzedaży', ours.revenue, t.revenue),
      ...(t.other_revenue !== 0 ? [line('other_revenue', 'Pozostałe przychody (odsetki, różnice kursowe)', 0, t.other_revenue)] : []),
      line('depreciation', 'Amortyzacja', ours.depreciation, t.depreciation),
      line('salaries_social', 'Wynagrodzenia i ZUS', ours.salaries_social, t.salaries_social),
      line('other_costs', 'Pozostałe koszty (towary, usługi, materiały, finansowe)', ours.other_costs, t.other_costs),
      line('costs_total', 'Koszty razem', ours.costs_total, t.costs_total),
      line('cit', 'Podatek dochodowy (CIT)', ours.cit, t.cit),
      line('result', 'Wynik netto', ours.result, t.result),
    ]

    const threshold = r2(Math.max(500, 0.05 * Math.abs(t.costs_total)))
    const resultDiff = r2(ours.result - t.result)
    const verdict: 'ok' | 'check' = Math.abs(resultDiff) > threshold ? 'check' : 'ok'

    // Podpowiedzi dla laika — skąd może brać się różnica
    const hints: string[] = []
    const costsDiff = r2(ours.costs_total - t.costs_total)
    const tol = Math.max(100, threshold / 5)
    if (costsDiff < -tol) {
      hints.push(`Księgowa ma wyższe koszty o ${fmtPln(costsDiff)} — sprawdź faktury KSeF bez kategorii (${unallocated}) i koszty spoza KSeF czekające na zatwierdzenie.`)
    } else if (costsDiff > tol) {
      hints.push(`Nasze koszty są wyższe o ${fmtPln(costsDiff)} — sprawdź, czy przelew z wyciągu nie dubluje faktury KSeF (reguły bankowe, tryb „pomiń”).`)
    }
    const revDiff = r2(ours.revenue - t.revenue)
    if (revDiff > tol) {
      hints.push(provisional
        ? `Nasz przychód wyższy o ${fmtPln(revDiff)} — miesiąc bez importu Firmao (przychód wstępny z KSeF i modułu).`
        : `Nasz przychód wyższy o ${fmtPln(revDiff)} — sprawdź duplikaty Firmao/KSeF/moduł (zaliczki, korekty).`)
    } else if (revDiff < -tol) {
      hints.push(`Przychód księgowej wyższy o ${fmtPln(revDiff)} — sprawdź, czy wszystkie faktury sprzedaży są w imporcie Firmao / KSeF.`)
    }
    if (Math.abs(ours.depreciation - t.depreciation) > 1) {
      hints.push(`Amortyzacja różni się o ${fmtPln(ours.depreciation - t.depreciation)} — uzupełnij środki trwałe (wartość, okres amortyzacji).`)
    }
    if (Math.abs(ours.salaries_social - t.salaries_social) > tol) {
      hints.push(`Pensje i ZUS różnią się o ${fmtPln(ours.salaries_social - t.salaries_social)} — sprawdź, czy wyciąg MT940 za ten miesiąc jest wgrany (pensje liczymy z przelewów, księgowa memoriałowo).`)
    }
    if (t.other_revenue !== 0) {
      hints.push(`Księgowa wykazuje pozostałe przychody ${fmtPln(t.other_revenue)} (odsetki, różnice kursowe) — nie ma ich w naszym RZiS.`)
    }
    if (Math.abs(ours.cit - t.cit) > 1) {
      hints.push('CIT: księgowa księguje podatek memoriałowo, my liczymy zapłacone zaliczki (przelewy do US) — różnica jest naturalna.')
    }
    if (theirs.source_classes === '5') {
      hints.push('Zestawienie księgowej nie ma zespołu 4 — koszty porównano zbiorczo (bez podziału na amortyzację i pensje).')
    }

    res.json({ period, ours, theirs, by_line, verdict, threshold, hints })
  } catch (e: any) {
    console.error('[finance/accountant/compare]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd serwera' })
  }
})

// ── GET /:period — pełny zapis (linie + wiersze kont) ─────────────────────────
router.get('/:period', async (req: Request, res: Response) => {
  try {
    const period = String(req.params.period ?? '').slice(0, 7)
    if (!PERIOD_RE.test(period)) { res.status(400).json({ error: 'Okres w formacie RRRR-MM.' }); return }
    const st = await prisma.accountantStatement.findFirst({ where: { period } })
    if (!st) { res.status(404).json({ error: 'Brak zestawienia księgowej za ten okres.' }); return }
    res.json(st)
  } catch (e) {
    console.error('[finance/accountant/get]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── DELETE /:period ───────────────────────────────────────────────────────────
router.delete('/:period', async (req: Request, res: Response) => {
  try {
    const period = String(req.params.period ?? '').slice(0, 7)
    if (!PERIOD_RE.test(period)) { res.status(400).json({ error: 'Okres w formacie RRRR-MM.' }); return }
    const r = await prisma.accountantStatement.deleteMany({ where: { period } })
    if (!r.count) { res.status(404).json({ error: 'Brak zestawienia księgowej za ten okres.' }); return }
    res.json({ ok: true, period })
  } catch (e) {
    console.error('[finance/accountant/delete]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
