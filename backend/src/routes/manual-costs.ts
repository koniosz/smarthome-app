/**
 * Manual Costs — pensje, ZUS, podatki, faktury zagraniczne poza KSeF
 * oraz import wyciągów bankowych MT940 (format SWIFT)
 */
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { requireAdmin } from '../middleware/auth'
import { parseMT940Statements } from '../utils/mt940Parser'
import { saveBankBalances, upsertMt940Costs, accountInOtherCompanyMessage } from '../services/mt940-costs'

const router = Router()

// ─── Taksonomia kosztów ręcznych ──────────────────────────────────────────────
// Podkategorie rozszerzone o pensje / ZUS / podatki.
// Koszt pracy z wyciągu składa się z trzech przelewów: wypłaty na konta pracowników (salary_gross —
// kwoty netto „na rękę"), zaliczka PIT-4 do urzędu skarbowego (salary_pit) i składki do ZUS
// (zus_employer — część pracownika i pracodawcy razem). Suma tych trzech = pełny koszt wynagrodzeń.
export const MANUAL_SUBCATEGORIES: Record<string, Record<string, string>> = {
  ga: {
    salary_gross:   'Wynagrodzenia (wypłaty na konta)',
    salary_pit:     'Zaliczki PIT od wynagrodzeń (PIT-4)',
    salary_b2b:     'Wynagrodzenia B2B / faktury',
    salary_civil:   'Wynagrodzenia UoD / UoZ',
    zus_employer:   'ZUS (składki pracownika i pracodawcy)',
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
    internal_transfer: 'Przelew własny / rachunek VAT (nie koszt)',
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

// ─── Auto-klasyfikacja z opisu (wpisy RĘCZNE) ─────────────────────────────────
// Podpowiada kategorię kosztu wpisywanego ręcznie (POST /api/manual-costs bez kategorii).
// Import wyciągu MT940 już z niej NIE korzysta — przelewy rozpoznaje klasyfikator strukturalny
// (services/bank-classify: kod operacji, rachunek ZUS / mikrorachunek, dopiero potem tytuł).
// Nierozpoznany opis → ga/other.
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
  // to część kosztu pracy (ga/salary_pit, jak w klasyfikatorze wyciągów), NIE podatek dochodowy spółki (CIT).
  if (/\bpit-?4r?\b|\bpit-?8ar?\b|pit.?4|pit.?8a|podat.*od wynagrodze|zaliczk.*od wynagrodze/.test(t))
    return { cost_category: 'ga', subcategory: 'salary_pit', business_unit: 'shared' }
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

  // Wynagrodzenia. „płac" tylko jako osobne słowo (lista płac, płace, fundusz płac) — nie „opłacenie",
  // „zapłacono", „wpłaca"; „wypłata" nie może być wypłatą gotówki (bankomat, kasa).
  const payrollWord = /wynagrodzeni|pensj|premia|urlop.*wypłac/.test(t)
    || /(?<![a-ząćęłńóśźż])płac(?:e|a|y)?(?![a-ząćęłńóśźż])/.test(t)
  const cashWithdrawal = /gotówk|gotowk|bankomat|wpłatomat|wplatomat|\batm\b/.test(t)
  if (payrollWord || (/wypłata/.test(t) && !cashWithdrawal))
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
    // RZiS księguje koszt w miesiącu `period` (gdy jest), inaczej w miesiącu daty. Okres bywa tylko automatyczną
    // kopią miesiąca daty (dodanie kosztu, zatwierdzenie dokumentu) — po poprawieniu daty musi pójść za nią,
    // inaczej koszt zostawałby w starym miesiącu. Okres wpisany świadomie (inny niż miesiąc daty) zostaje.
    let periodFollowsDate = false
    if (date !== undefined) {
      const cur = await prisma.manualCost.findUnique({ where: { id: req.params.id }, select: { date: true, period: true } })
      const newDate = String(date)
      if (cur && newDate !== cur.date) {
        const autoFilled = !cur.period || cur.period === String(cur.date).slice(0, 7)
        const periodUntouched = period === undefined || (period ?? null) === (cur.period ?? null)
        periodFollowsDate = autoFilled && periodUntouched
      }
    }
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
        ...(periodFollowsDate ? { period: null } : (period !== undefined && { period: period ?? null })),
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
// Wspólny serwis z /api/payables/import-mt940: deduplikacja, naprawa wierszy starego importu,
// klasyfikator przelewów (ZUS, podatki, pensje, przelewy własne, zagraniczne), reguły bankowe,
// zapis sald wyciągu.
router.post('/import-mt940', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { content } = req.body  // treść pliku MT940 jako string
    if (!content) return res.status(400).json({ error: 'Brak treści pliku MT940' })

    const { transactions, balances } = parseMT940Statements(String(content))
    if (!transactions.length)
      return res.status(400).json({ error: 'Nie znaleziono transakcji w pliku. Sprawdź, czy to poprawny wyciąg MT940.' })

    // Wyciąg rachunku prowadzonego w innej firmie → odmowa, zanim cokolwiek zapiszemy
    const otherCompany = await accountInOtherCompanyMessage([...transactions.map(t => t.account), ...balances.map(b => b.account)])
    if (otherCompany) return res.status(409).json({ error: otherCompany, code: 'account_other_company' })

    // Koszty = obciążenia (bez storn)
    const outgoing = transactions.filter(t => t.amount < 0 && !t.is_reversal)

    const balances_saved = await saveBankBalances(balances)
    const result = await upsertMt940Costs(transactions, {
      createdBy: (req as any).user?.email ?? '',
      accounts: balances.map(b => b.account), // rachunki wszystkich wyciągów z pliku = rachunki własne
    })
    const recognizedCount = result.recognized.reduce((s, r) => s + r.count, 0)

    res.json({
      total_parsed:     transactions.length,
      outgoing:         outgoing.length,
      saved:            result.created,
      skipped_existing: result.skipped_existing,
      rules_applied:    result.rules_applied,
      balances_saved,
      repaired:         result.repaired,     // wiersze starego importu uzupełnione na miejscu
      recognized:       result.recognized,   // rozpoznane rodzaje przelewów: { kind, label, count, total }
      to_review:        result.to_review,    // przelewy czekające na decyzję (nie weszły do RZiS)
      to_review_from:   result.to_review_from, // najwcześniejszy miesiąc (YYYY-MM) wśród czekających
      message: `Zaimportowano ${result.created} transakcji kosztowych z wyciągu MT940`
        + (result.skipped_existing ? ` (${result.skipped_existing} już było w bazie)` : '')
        + (result.repaired ? `, uzupełniono ${result.repaired} wcześniej zaimportowanych` : '')
        + (recognizedCount ? `, rozpoznano automatycznie ${recognizedCount}` : '')
        + (result.rules_applied ? `, reguły bankowe rozpoznały ${result.rules_applied}` : '')
        + (result.to_review ? `, do decyzji ${result.to_review}` : '')
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
