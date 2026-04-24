/**
 * Manual Costs — pensje, ZUS, podatki, faktury zagraniczne poza KSeF
 * oraz import wyciągów bankowych MT940 (format SWIFT)
 */
import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { v4 as uuidv4 } from 'uuid'
import { requireAdmin } from '../middleware/auth'

const prisma = new PrismaClient()
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
function autoClassifyManual(description: string, reference: string): {
  cost_category: string; subcategory: string; business_unit: string
} {
  const t = `${description} ${reference}`.toLowerCase()

  // ZUS
  if (/\bzus\b|zakład.*ubezp|ubezpieczenia społeczne|składk.*społeczn/.test(t))
    return { cost_category: 'ga', subcategory: 'zus_employer', business_unit: 'shared' }

  // Podatki — US / Urząd Skarbowy
  if (/urząd.*skarb|us\s|mikrorachun|podatek.*vat|\bvat\b.*deklaracj|jpk|pit-\d|cit-\d/.test(t))
    return { cost_category: 'financial', subcategory: 'tax_vat', business_unit: 'shared' }
  if (/podatek.*dochod|zaliczka.*podatek|podatek.*cit|podatek.*pit/.test(t))
    return { cost_category: 'financial', subcategory: 'tax_income', business_unit: 'shared' }

  // Wynagrodzenia
  if (/wynagrodzeni|pensj|płac|wypłata|premia|urlop.*wypłac/.test(t))
    return { cost_category: 'ga', subcategory: 'salary_gross', business_unit: 'shared' }

  // Leasing
  if (/leasing|rata.*leas/.test(t))
    return { cost_category: 'financial', subcategory: 'leasing', business_unit: 'shared' }

  // Opłaty bankowe
  if (/opłat.*bank|prowizja.*bank|obsługa.*rachun|opłata.*konto/.test(t))
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

  // Domyślnie: G&A
  return { cost_category: 'ga', subcategory: 'salary_gross', business_unit: 'shared' }
}

// ─── Parser MT940 ─────────────────────────────────────────────────────────────
interface Mt940Transaction {
  date: string           // YYYY-MM-DD
  amount: number         // ujemne = wychodzące
  currency: string
  description: string
  reference: string
  side: 'D' | 'C'       // Debet (wychodzące) | Credit (przychodzące)
}

function parseMt940(content: string): Mt940Transaction[] {
  const transactions: Mt940Transaction[] = []

  // Podziel na bloki transakcji — każda zaczyna się od :61:
  // Wzorzec :61: YYMMDDYYMMDD D/C kwota N// referencja
  const txBlocks = content.split(/(?=:61:)/)

  for (const block of txBlocks) {
    if (!block.startsWith(':61:')) continue

    // Parsuj :61: — linia transakcji
    // Format: :61:YYMMDDYYMMDDDkwota,groszeNGBP//referencja
    // lub:    :61:YYMMDD[MMDD]C/DRkwota,grosze[N]referencja
    const line61 = block.match(/:61:(\d{6})(\d{4})?([DC]R?)(\d+,\d{2})N?\w{0,3}\/\/([^\n]*)/)
    if (!line61) continue

    const [, dateStr, , side, amountStr, reference] = line61
    const year  = 2000 + parseInt(dateStr.slice(0, 2))
    const month = dateStr.slice(2, 4)
    const day   = dateStr.slice(4, 6)
    const date  = `${year}-${month}-${day}`
    const amount = parseFloat(amountStr.replace(',', '.'))

    // Pobierz opis z :86:
    const desc86 = block.match(/:86:([\s\S]*?)(?=:\d{2}[A-Z]?:|$)/)
    let description = desc86 ? desc86[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : reference.trim()

    // Usuń kody pola MT940 (np. ~20, ~30, ~31 itp.)
    description = description.replace(/~\d{2}/g, ' ').replace(/\s+/g, ' ').trim()

    // Szukaj waluty w nagłówku :25:
    const currency = (content.match(/:25:[\w\/]+(PLN|EUR|USD|GBP|CHF)/) ?? [])[1] ?? 'PLN'

    transactions.push({
      date,
      amount,
      currency,
      description: description.slice(0, 300),
      reference: reference.trim().slice(0, 100),
      side: side.startsWith('D') ? 'D' : 'C',
    })
  }

  return transactions
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

// ─── POST /api/manual-costs/import-mt940 — wgraj wyciąg MT940 ────────────────
router.post('/import-mt940', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { content } = req.body  // treść pliku MT940 jako string
    if (!content) return res.status(400).json({ error: 'Brak treści pliku MT940' })

    const transactions = parseMt940(String(content))

    // Importuj tylko transakcje wychodzące (Debet) — koszty
    const outgoing = transactions.filter(t => t.side === 'D')

    let saved = 0
    const results: any[] = []

    for (const tx of outgoing) {
      const auto = autoClassifyManual(tx.description, tx.reference)
      const cost = await prisma.manualCost.create({
        data: {
          id:            uuidv4(),
          date:          tx.date,
          description:   tx.description,
          amount:        tx.amount,
          currency:      tx.currency,
          cost_category: auto.cost_category,
          subcategory:   auto.subcategory,
          business_unit: auto.business_unit,
          reference:     tx.reference,
          notes:         '',
          source:        'mt940',
          created_at:    new Date().toISOString(),
        },
      })
      results.push(cost)
      saved++
    }

    res.json({
      total_parsed:    transactions.length,
      outgoing:        outgoing.length,
      saved,
      message:         `Zaimportowano ${saved} transakcji kosztowych z wyciągu MT940.`,
      costs:           results,
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
