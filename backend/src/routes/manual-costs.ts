/**
 * Manual Costs — pensje, ZUS, podatki, faktury zagraniczne poza KSeF
 * oraz import wyciągów bankowych MT940 (format SWIFT)
 */
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { requireAdmin } from '../middleware/auth'
import { parseMT940Statements } from '../utils/mt940Parser'
import { saveBankBalances, upsertMt940Costs } from '../services/mt940-costs'

const router = Router()

// ─── Taksonomia kosztów ręcznych ──────────────────────────────────────────────
// Podkategorie rozszerzone o pensje / ZUS / podatki
export const MANUAL_SUBCATEGORIES: Record<string, Record<string, string>> = {
  ga: {
    salary_gross:   'Wynagrodzenia brutto (UoP)',
    salary_b2b:     'Wynagrodzenia B2B / faktury',
    salary_civil:   'Wynagrodzenia UoD / UoZ',
    zus_employer:   'ZUS pracodawcy',
    rent:           'Czynsz biuro / magazyn',
    utilities:      'Media (prąd, internet)',
    software:       'Oprogramowanie / licencje',
    accounting:     'Księgowość / doradztwo',
    legal:          'Usługi prawne',
    office_supplies:'Materiały biurowe',
    other:          'Inne / nierozpoznane',
  },
  financial: {
    tax_vat:        'VAT do US',
    tax_income:     'CIT / PIT do US',
    tax_other:      'Inne podatki i opłaty',
    bank_fee:       'Opłaty bankowe',
    interest:       'Odsetki',
    leasing:        'Leasing',
    fx:             'Różnice kursowe / przewalutowanie',
  },
  cogs: {
    hardware:           'Sprzęt krajowy',
    hardware_eu:        'Sprzęt z UE (WNT)',
    hardware_noneu:     'Sprzęt spoza UE (import)',
    import_duty:        'Cło i opłaty celne',
    import_freight:     'Fracht / spedycja importowa',
    import_agency:      'Agencja celna / obsługa importu',
    subcontractor:      'Podwykonawca',
    installation_material: 'Materiały instalacyjne',
  },
  operations: {
    car_fuel:    'Paliwo',
    car_service: 'Serwis pojazdów',
    insurance:   'Ubezpieczenie',
    travel:      'Podróże służbowe',
    tools:       'Narzędzia',
  },
}

// ─── Auto-klasyfikacja z opisu transakcji (MT940 / ręcznie) ──────────────────
// Nierozpoznany przelew → ga/other (poza listą MT940_SAFE_SUBCATEGORIES), czyli NIE wchodzi
// do RZiS, dopóki nie zdecyduje reguła bankowa lub użytkownik (lista „nierozpoznane przelewy").
export function autoClassifyManual(description: string, reference: string): {
  cost_category: string; subcategory: string; business_unit: string
} {
  const t = `${description} ${reference}`.toLowerCase()

  // ZUS
  if (/\bzus\b|zakład.*ubezp|zaklad.*ubezp|ubezpieczenia społeczne|składk.*społeczn/.test(t))
    return { cost_category: 'ga', subcategory: 'zus_employer', business_unit: 'shared' }

  // Podatki — najpierw RODZAJ podatku (CIT/PIT → tax_income, VAT/JPK → tax_vat), dopiero potem
  // ogólny „przelew do US” → tax_other. Kolejność ma znaczenie: tax_vat jest wykluczone z RZiS,
  // tax_income wchodzi jako CIT (cit_paid_ytd), więc zaliczka CIT błędnie oznaczona jako VAT
  // znika z wyniku. Wszystkie krótkie tokeny z granicami słów (`\bus\b`, `\bcit\b`, `\bjpk`):
  // niezakotwiczone `us\s` łapało GLOBUS/PLUS/BONUS/ASUS i cicho wyrzucało te koszty z RZiS.
  const taxOffice = /urząd.*skarb|urzad.*skarb|\bus\b|mikrorachun/.test(t)
  // PIT-4 / PIT-4R / PIT-8A(R) = zaliczki na podatek pracowników/zleceniobiorców potrącone z wynagrodzeń —
  // to część kosztu pensji brutto (ga/salary_gross), NIE podatek dochodowy spółki (CIT).
  if (/\bpit-?4r?\b|\bpit-?8ar?\b|pit.?4|pit.?8a|podat.*od wynagrodze|zaliczk.*od wynagrodze/.test(t))
    return { cost_category: 'ga', subcategory: 'salary_gross', business_unit: 'shared' }
  const incomeTax = taxOffice
    ? /\bcit\b|\bcit-?\d|\bpit\b|\bpit-?\d|podatek.*dochod|zaliczk.*podat/.test(t)
    : /\bcit-?\d|\bpit-?\d|\bcit\b.*zaliczk|zaliczk.*\bcit\b|\bpit\b.*zaliczk|zaliczk.*\bpit\b|podatek.*dochod|podatek.*\bcit\b|podatek.*\bpit\b/.test(t)
  if (incomeTax)
    return { cost_category: 'financial', subcategory: 'tax_income', business_unit: 'shared' }
  const vatTax = taxOffice
    ? /\bvat\b|\bvat-?7|\bvat-?ue|\bjpk/.test(t)
    : /\bjpk|podatek\s+vat|podatek od towar|\bvat\b.*deklaracj|deklaracj.*\bvat\b|\bvat-?7\b|\bvat-?ue\b/.test(t)
  if (vatTax)
    return { cost_category: 'financial', subcategory: 'tax_vat', business_unit: 'shared' }
  // Inny przelew do US (PCC, odsetki, opłaty) — tax_other NIE jest w MT940_SAFE_SUBCATEGORIES,
  // więc trafia na listę „nierozpoznane przelewy” do decyzji zamiast cicho znikać.
  if (taxOffice)
    return { cost_category: 'financial', subcategory: 'tax_other', business_unit: 'shared' }

  // Wynagrodzenia
  if (/wynagrodzeni|pensj|płac|wypłata|premia|urlop.*wypłac/.test(t))
    return { cost_category: 'ga', subcategory: 'salary_gross', business_unit: 'shared' }

  // Leasing
  if (/leasing|rata.*leas/.test(t))
    return { cost_category: 'financial', subcategory: 'leasing', business_unit: 'shared' }

  // Opłaty bankowe
  if (/opłat.*bank|prowizja.*bank|obsługa.*rachun|opłata.*konto|oplat.*bank|obsluga.*rachun/.test(t))
    return { cost_category: 'financial', subcategory: 'bank_fee', business_unit: 'shared' }

  // Paliwo
  if (/paliwo|orlen|shell|bp\b|lotos|circle k/.test(t))
    return { cost_category: 'operations', subcategory: 'car_fuel', business_unit: 'shared' }

  // Czynsz
  if (/czynsz|najem|wynajem/.test(t))
    return { cost_category: 'ga', subcategory: 'rent', business_unit: 'shared' }

  // Import / cło
  if (/\bcło\b|opłat.*celn|agencja.*celn/.test(t))
    return { cost_category: 'cogs', subcategory: 'import_duty', business_unit: 'shc' }
  if (/fracht|freight|spedycj|forwarding/.test(t))
    return { cost_category: 'cogs', subcategory: 'import_freight', business_unit: 'shc' }

  // Domyślnie: G&A / inne (nierozpoznane — do decyzji)
  return { cost_category: 'ga', subcategory: 'other', business_unit: 'shared' }
}

// ─── GET /api/manual-costs ───────────────────────────────────────────────────
router.get('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, cost_category, source } = req.query
    const where: any = {}
    if (dateFrom) where.date = { ...where.date, gte: String(dateFrom) }
    if (dateTo)   where.date = { ...where.date, lte: String(dateTo) }
    if (cost_category && cost_category !== 'all') where.cost_category = String(cost_category)
    if (source && source !== 'all') where.source = String(source)

    const costs = await prisma.manualCost.findMany({
      where,
      orderBy: { date: 'desc' },
    })
    res.json(costs)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ─── POST /api/manual-costs ──────────────────────────────────────────────────
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const {
      date, description, amount, currency = 'PLN',
      cost_category, subcategory, business_unit,
      period, notes, reference,
    } = req.body

    if (!date || !description || amount === undefined)
      return res.status(400).json({ error: 'date, description, amount są wymagane' })

    // Auto-klasyfikacja jeśli nie podano
    const auto = autoClassifyManual(description, reference ?? '')
    const created = await prisma.manualCost.create({
      data: {
        id:            uuidv4(),
        date:          String(date),
        description:   String(description),
        amount:        parseFloat(String(amount)),
        currency:      String(currency),
        cost_category: cost_category ?? auto.cost_category,
        subcategory:   subcategory   ?? auto.subcategory,
        business_unit: business_unit ?? auto.business_unit,
        period:        period ?? null,
        notes:         notes ?? '',
        reference:     reference ?? '',
        source:        'manual',
        created_at:    new Date().toISOString(),
        created_by:    (req as any).user?.email ?? '',
      },
    })
    res.json(created)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ─── PUT /api/manual-costs/:id ───────────────────────────────────────────────
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const {
      date, description, amount, currency,
      cost_category, subcategory, business_unit,
      period, notes, reference,
    } = req.body
    const updated = await prisma.manualCost.update({
      where: { id: req.params.id },
      data: {
        ...(date          !== undefined && { date: String(date) }),
        ...(description   !== undefined && { description: String(description) }),
        ...(amount        !== undefined && { amount: parseFloat(String(amount)) }),
        ...(currency      !== undefined && { currency: String(currency) }),
        ...(cost_category !== undefined && { cost_category: String(cost_category) }),
        ...(subcategory   !== undefined && { subcategory: String(subcategory) }),
        ...(business_unit !== undefined && { business_unit: String(business_unit) }),
        ...(period        !== undefined && { period: period ?? null }),
        ...(notes         !== undefined && { notes: String(notes) }),
        ...(reference     !== undefined && { reference: String(reference) }),
      },
    })
    res.json(updated)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ─── DELETE /api/manual-costs/:id ────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.manualCost.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ─── POST /api/manual-costs/import-mt940 — wgraj wyciąg MT940 (treść jako string) ──
// Wspólny serwis z /api/payables/import-mt940: deduplikacja, auto-klasyfikacja,
// reguły bankowe, zapis sald wyciągu.
router.post('/import-mt940', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { content } = req.body  // treść pliku MT940 jako string
    if (!content) return res.status(400).json({ error: 'Brak treści pliku MT940' })

    const { transactions, balances } = parseMT940Statements(String(content))
    if (!transactions.length)
      return res.status(400).json({ error: 'Nie znaleziono transakcji w pliku. Sprawdź, czy to poprawny wyciąg MT940.' })

    // Koszty = obciążenia (bez storn)
    const outgoing = transactions.filter(t => t.amount < 0 && !t.is_reversal)

    const balances_saved = await saveBankBalances(balances)
    const result = await upsertMt940Costs(transactions, { createdBy: (req as any).user?.email ?? '' })

    res.json({
      total_parsed:     transactions.length,
      outgoing:         outgoing.length,
      saved:            result.created,
      skipped_existing: result.skipped_existing,
      rules_applied:    result.rules_applied,
      balances_saved,
      message: `Zaimportowano ${result.created} transakcji kosztowych z wyciągu MT940`
        + (result.skipped_existing ? ` (${result.skipped_existing} już było w bazie)` : '')
        + (result.rules_applied ? `, reguły bankowe rozpoznały ${result.rules_applied}` : '')
        + (balances_saved ? `, zapisano ${balances_saved} sald` : '')
        + '.',
    })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ─── GET /api/manual-costs/summary — podsumowanie dla P&L ────────────────────
router.get('/summary', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, business_unit } = req.query
    const where: any = {}
    if (dateFrom) where.date = { ...where.date, gte: String(dateFrom) }
    if (dateTo)   where.date = { ...where.date, lte: String(dateTo) }
    if (business_unit && business_unit !== 'all') where.business_unit = String(business_unit)

    const costs = await prisma.manualCost.findMany({ where })

    const grouped: Record<string, { total: number; subcategories: Record<string, number> }> = {}
    for (const c of costs) {
      if (!grouped[c.cost_category]) grouped[c.cost_category] = { total: 0, subcategories: {} }
      grouped[c.cost_category].total += c.amount
      grouped[c.cost_category].subcategories[c.subcategory] =
        (grouped[c.cost_category].subcategories[c.subcategory] ?? 0) + c.amount
    }

    res.json({ grouped, total: costs.reduce((s, c) => s + c.amount, 0), count: costs.length })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

export default router
