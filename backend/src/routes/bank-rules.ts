/**
 * Reguły bankowe — automatyczna kategoryzacja przelewów z wyciągu MT940 (ManualCost source='mt940').
 * Mount: /api/finance/bank-rules (admin lub can_view_payments).
 *
 * Przepływ: przelew z wyciągu → autoClassifyManual → pierwsza pasująca reguła (dłuższy wzorzec ma
 * pierwszeństwo) nadaje kategorię i decyduje, czy koszt liczy się w RZiS (pnl_mode include/exclude).
 * „Nierozpoznane przelewy" = wychodzące bez reguły, które nie wchodzą do RZiS i nie są płatnością
 * za fakturę z KSeF (w tym pominięte jednorazowo, pnl_mode=exclude — żeby dało się cofnąć „Pomiń") —
 * użytkownik tworzy z nich regułę albo decyduje jednorazowo (PATCH /cost/:id).
 *
 * Decyzja o pnl_mode podjęta POZA regułami (zatwierdzony dokument ze skrzynki, „Pomiń"/„Licz w RZiS",
 * strażnik duplikatów przy imporcie) jest nienaruszalna dla POST /apply i DELETE /:id — inaczej
 * koszt liczyłby się podwójnie (dokument + przelew) albo decyzja użytkownika znikałaby po kliknięciu
 * „Zastosuj reguły do historii".
 */
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { requirePayments } from './payables'
import { includeManualCostInPnl, addMonths } from './finance'
import { applyBankRules, normalizeForMatch, sortRules, splitStoredDescription } from '../services/mt940-costs'

const router = Router()
router.use(requirePayments)

const MATCH_FIELDS = new Set(['counterparty', 'description', 'any'])
const COST_CATEGORIES = new Set(['cogs', 'sales', 'ga', 'operations', 'financial'])
const BUSINESS_UNITS = new Set(['shc', 'gatelynk', 'shared'])
const RULE_PNL_MODES = new Set(['include', 'exclude'])
const COST_PNL_MODES = new Set(['auto', 'include', 'exclude'])

function now() { return new Date().toISOString() }

// ── Czyste funkcje (testowane) ────────────────────────────────────────────────

// Słowa zbyt ogólne na wzorzec reguły (po normalizacji: bez polskich znaków)
const STOP_WORDS = new Set([
  'przelew', 'przelewu', 'przelewy', 'tytulem', 'tytul', 'faktura', 'faktury', 'fakture', 'faktur',
  'platnosc', 'platnosci', 'zaplata', 'oplata', 'oplaty', 'srodkow', 'przychodzacy', 'wychodzacy',
  'zewnetrzny', 'wewnetrzny', 'numer', 'nazwa', 'transakcja', 'karta', 'spolka', 'sprzedaz',
  'usluga', 'uslugi', 'towar', 'towary', 'zamowienie', 'zlecenie', 'rachunek', 'rachunku', 'prowizja',
  'odsetki', 'dnia', 'miesiac', 'kwota', 'zakup', 'zakupu', 'oraz', 'dla', 'firma', 'firmy',
])

/**
 * Propozycja fragmentu do nowej reguły: najdłuższe słowo (≥ 4 litery, bez cyfr) z kontrahenta,
 * a gdy brak — z opisu. Pomija słowa zbyt ogólne (przelew, faktura…).
 */
export function suggestPattern(counterparty: string | null | undefined, description: string | null | undefined): string {
  const pick = (s: string | null | undefined): string => {
    const words = String(s ?? '')
      .split(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(normalizeForMatch(w)))
    return words.sort((a, b) => b.length - a.length)[0] ?? ''
  }
  return pick(counterparty) || pick(description)
}

export interface MatchedTxLite { transaction_date: string; amount: number; reference: string | null }

function alnum(s: string | null | undefined): string {
  const v = String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return v === 'nonref' || v === 'notprovided' ? '' : v
}

/** Indeks transakcji bankowych dopasowanych do faktur KSeF — po dacie. */
export function buildMatchedIndex(txs: MatchedTxLite[]): Map<string, MatchedTxLite[]> {
  const idx = new Map<string, MatchedTxLite[]>()
  for (const t of txs) {
    const list = idx.get(t.transaction_date) ?? []
    list.push(t)
    idx.set(t.transaction_date, list)
  }
  return idx
}

/**
 * Czy koszt MT940 jest płatnością za fakturę KSeF: ta sama data, |kwota| ± 0,01 i zgodna referencja
 * (gdy którakolwiek strona nie ma referencji — wystarczy data + kwota).
 */
export function isKsefPayment(
  cost: { date: string; amount: number; reference?: string | null },
  index: Map<string, MatchedTxLite[]>,
): boolean {
  const list = index.get(cost.date)
  if (!list || !list.length) return false
  const ref = alnum(cost.reference)
  const amt = Math.abs(Number(cost.amount) || 0)
  return list.some(t => {
    if (Math.abs(Math.abs(t.amount) - amt) > 0.01) return false
    const tref = alnum(t.reference)
    return !ref || !tref || ref === tref
  })
}

// ── Decyzje spoza reguł (dokument / ręczna / strażnik duplikatów) ──────────────

/**
 * Znaczniki w `notes` kosztu MT940 oznaczające, że pnl_mode ustawiono poza regułami bankowymi
 * (po normalizacji: małe litery, bez polskich znaków). Zapisują je: cost-documents (approve „mimo to"),
 * PATCH /cost/:id (decyzja ręczna) i mt940-costs (strażnik: płatność za KSeF / duplikat dokumentu).
 */
const DECISION_MARKERS = ['wykluczony przez dokument', 'decyzja reczna', 'duplikat dokumentu', 'platnosc za fakture ksef']
export const MANUAL_DECISION_MARKER = 'decyzja ręczna'

export function hasDecisionMarker(notes: string | null | undefined): boolean {
  const n = normalizeForMatch(notes)
  return !!n && DECISION_MARKERS.some(m => n.includes(m))
}

/**
 * Czy o pnl_mode tego przelewu zdecydowano poza regułami: wykluczył go zatwierdzony dokument
 * (duplicate_of='mt940:<id>'), ma znacznik w notes, albo ma pnl_mode ≠ auto bez reguły (jednorazowa decyzja).
 * Takich wierszy POST /apply nie dotyka, a DELETE reguły nie cofa ich do auto.
 */
export function isDecidedOutsideRules(
  c: { id: string; pnl_mode?: string | null; bank_rule_id?: string | null; notes?: string | null },
  excludedByDocument: Set<string>,
): boolean {
  if (excludedByDocument.has(c.id)) return true
  if (hasDecisionMarker(c.notes)) return true
  return (c.pnl_mode ?? 'auto') !== 'auto' && !c.bank_rule_id
}

/** Dopisuje znacznik „decyzja ręczna" do notes (raz), zachowując istniejącą treść. */
export function withManualDecisionMarker(notes: string | null | undefined, who: string, date: string): string {
  const cur = String(notes ?? '').trim()
  if (normalizeForMatch(cur).includes('decyzja reczna')) return cur
  const marker = `${MANUAL_DECISION_MARKER} (${[who, date].filter(Boolean).join(', ')})`
  return [cur, marker].filter(Boolean).join(' · ').slice(0, 1000)
}

/** Usuwa znacznik „decyzja ręczna" z notes (cofnięcie decyzji → przelew znów podlega regułom). */
export function withoutManualDecisionMarker(notes: string | null | undefined): string {
  return String(notes ?? '').split(' · ')
    .filter(part => !normalizeForMatch(part).startsWith('decyzja reczna'))
    .join(' · ').trim()
}

/** Id przelewów MT940 wykluczonych z RZiS przez zatwierdzony dokument ze skrzynki (koszt liczy dokument). */
async function loadExcludedByDocument(): Promise<Set<string>> {
  const docs = await prisma.costDocument.findMany({
    where: { status: 'approved', duplicate_of: { startsWith: 'mt940:' } },
    select: { duplicate_of: true },
  })
  return new Set(docs.map(d => String(d.duplicate_of).slice('mt940:'.length)).filter(Boolean))
}

// ── Walidacja wejścia reguły ──────────────────────────────────────────────────
function ruleDataFromBody(body: any, partial: boolean): { data?: Record<string, any>; error?: string } {
  const b = body ?? {}
  const data: Record<string, any> = {}

  if (b.pattern !== undefined || !partial) {
    const pattern = String(b.pattern ?? '').trim()
    if (pattern.length < 3) return { error: 'Fragment do rozpoznania (pattern) musi mieć co najmniej 3 znaki' }
    data.pattern = pattern.slice(0, 200)
  }
  if (b.name !== undefined) data.name = String(b.name ?? '').trim().slice(0, 120)
  if (b.match_field !== undefined) {
    if (!MATCH_FIELDS.has(String(b.match_field))) return { error: 'match_field musi być jednym z: counterparty, description, any' }
    data.match_field = String(b.match_field)
  }
  if (b.cost_category !== undefined || !partial) {
    if (!COST_CATEGORIES.has(String(b.cost_category))) return { error: 'cost_category musi być jednym z: cogs, sales, ga, operations, financial' }
    data.cost_category = String(b.cost_category)
  }
  if (b.subcategory !== undefined || !partial) {
    const sub = String(b.subcategory ?? '').trim()
    if (!sub) return { error: 'subcategory jest wymagane' }
    data.subcategory = sub.slice(0, 60)
  }
  if (b.business_unit !== undefined) {
    if (!BUSINESS_UNITS.has(String(b.business_unit))) return { error: 'business_unit musi być jednym z: shc, gatelynk, shared' }
    data.business_unit = String(b.business_unit)
  }
  if (b.pnl_mode !== undefined) {
    if (!RULE_PNL_MODES.has(String(b.pnl_mode))) return { error: 'pnl_mode musi być include (licz w RZiS) lub exclude (pomiń)' }
    data.pnl_mode = String(b.pnl_mode)
  }
  return { data }
}

async function findDuplicatePattern(pattern: string, excludeId?: string): Promise<{ id: string } | null> {
  const key = normalizeForMatch(pattern)
  const all = await prisma.bankRule.findMany({ select: { id: true, pattern: true } })
  return all.find(r => r.id !== excludeId && normalizeForMatch(r.pattern) === key) ?? null
}

/** Licznik trafień = liczba kosztów z bank_rule_id danej reguły (prawda z bazy, nie inkrementy). */
async function recomputeHits(): Promise<void> {
  const groups = await prisma.manualCost.groupBy({
    by: ['bank_rule_id'],
    where: { bank_rule_id: { not: null } },
    _count: { _all: true },
  })
  const counts = new Map<string, number>()
  for (const g of groups) if (g.bank_rule_id) counts.set(g.bank_rule_id, g._count._all)
  const rules = await prisma.bankRule.findMany({ select: { id: true, hits: true } })
  for (const r of rules) {
    const n = counts.get(r.id) ?? 0
    if (n !== r.hits) await prisma.bankRule.update({ where: { id: r.id }, data: { hits: n } })
  }
}

// ── GET /api/finance/bank-rules ───────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const rules = await prisma.bankRule.findMany({ orderBy: [{ hits: 'desc' }, { created_at: 'desc' }] })
    res.json(rules)
  } catch (e) {
    console.error('[bank-rules/list]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/finance/bank-rules ──────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const v = ruleDataFromBody(req.body, false)
    if (v.error || !v.data) { res.status(400).json({ error: v.error ?? 'Nieprawidłowe dane' }); return }
    const dup = await findDuplicatePattern(v.data.pattern)
    if (dup) { res.status(409).json({ error: 'Reguła z takim samym fragmentem już istnieje', existing_id: dup.id }); return }

    const created = await prisma.bankRule.create({
      data: {
        id: uuidv4(),
        name: v.data.name || v.data.pattern,
        pattern: v.data.pattern,
        match_field: v.data.match_field ?? 'any',
        cost_category: v.data.cost_category,
        subcategory: v.data.subcategory,
        business_unit: v.data.business_unit ?? 'shared',
        pnl_mode: v.data.pnl_mode ?? 'include',
        hits: 0,
        created_by: (req as any).user?.email ?? '',
        created_at: now(),
        updated_at: now(),
      },
    })
    res.status(201).json(created)
  } catch (e) {
    console.error('[bank-rules/create]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/finance/bank-rules/apply { overwrite? } — przepuść historię MT940 przez reguły ──
// (przed /:id, żeby „apply" nie zostało potraktowane jako id)
router.post('/apply', async (req: Request, res: Response) => {
  try {
    const overwrite = req.body?.overwrite === true || req.body?.overwrite === 'true'
    const rules = sortRules(await prisma.bankRule.findMany())
    const [costs, excludedByDocument] = await Promise.all([
      prisma.manualCost.findMany({
        where: { source: 'mt940', ...(overwrite ? {} : { bank_rule_id: null }) },
      }),
      loadExcludedByDocument(),
    ])

    let updated = 0
    let skipped_decided = 0
    const by_rule: Record<string, number> = {}
    for (const c of costs) {
      // Decyzja spoza reguł (dokument „mimo to", „Pomiń"/„Licz w RZiS", strażnik duplikatów) — nie ruszamy,
      // nawet z overwrite: przywrócenie include liczyłoby koszt podwójnie (dokument + przelew).
      if (isDecidedOutsideRules(c, excludedByDocument)) { skipped_decided++; continue }
      const { counterparty, description } = splitStoredDescription(c.description)
      const { cost, rule } = applyBankRules({
        counterparty, description,
        cost_category: c.cost_category, subcategory: c.subcategory, business_unit: c.business_unit,
        pnl_mode: c.pnl_mode, bank_rule_id: c.bank_rule_id,
      }, rules)
      if (!rule) continue
      const changed = cost.cost_category !== c.cost_category || cost.subcategory !== c.subcategory
        || cost.business_unit !== c.business_unit || cost.pnl_mode !== c.pnl_mode || cost.bank_rule_id !== c.bank_rule_id
      if (!changed) continue
      await prisma.manualCost.update({
        where: { id: c.id },
        data: {
          cost_category: cost.cost_category, subcategory: cost.subcategory, business_unit: cost.business_unit,
          pnl_mode: cost.pnl_mode, bank_rule_id: cost.bank_rule_id ?? null,
        },
      })
      updated++
      by_rule[rule.id] = (by_rule[rule.id] ?? 0) + 1
    }
    await recomputeHits()
    res.json({ updated, by_rule, skipped_decided })
  } catch (e) {
    console.error('[bank-rules/apply]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── GET /api/finance/bank-rules/unmatched?from=YYYY-MM&to=YYYY-MM ─────────────
router.get('/unmatched', async (req: Request, res: Response) => {
  try {
    const curMonth = new Date().toISOString().slice(0, 7)
    const to = String(req.query.to ?? '') || curMonth
    const from = String(req.query.from ?? '') || addMonths(to, -2)
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
      res.status(400).json({ error: 'Parametry from i to w formacie YYYY-MM' }); return
    }
    if (from > to) { res.status(400).json({ error: 'Zakres: from nie może być późniejszy niż to' }); return }
    const dFrom = `${from}-01`, dTo = `${to}-31`

    const [costs, matchedTx] = await Promise.all([
      prisma.manualCost.findMany({ where: { source: 'mt940', date: { gte: dFrom, lte: dTo } } }),
      prisma.bankTransaction.findMany({
        where: { source: 'mt940', matched_invoice_id: { not: null }, transaction_date: { gte: dFrom, lte: dTo } },
        select: { transaction_date: true, amount: true, reference: true },
      }),
    ])
    const index = buildMatchedIndex(matchedTx)

    const items = costs
      // bez reguły, nie w RZiS, nie płatność za fakturę KSeF. Pominięte jednorazowo (pnl_mode=exclude)
      // TEŻ wracają — z pnl_mode w odpowiedzi — żeby dało się je zobaczyć („pokaż pominięte") i cofnąć.
      .filter(c => !c.bank_rule_id && !includeManualCostInPnl(c) && !isKsefPayment(c, index))
      .map(c => {
        const { counterparty, description } = splitStoredDescription(c.description)
        return {
          id: c.id, date: c.date, amount: c.amount, description: c.description, reference: c.reference,
          subcategory: c.subcategory, cost_category: c.cost_category, pnl_mode: c.pnl_mode,
          suggested_pattern: suggestPattern(counterparty, description),
        }
      })
      .sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date))
      .slice(0, 300)
    res.json(items)
  } catch (e) {
    console.error('[bank-rules/unmatched]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── PATCH /api/finance/bank-rules/cost/:id — jednorazowa decyzja dla przelewu (bez reguły) ──
router.patch('/cost/:id', async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {}
    const data: Record<string, string> = {}
    if (b.pnl_mode !== undefined) {
      if (!COST_PNL_MODES.has(String(b.pnl_mode))) { res.status(400).json({ error: 'pnl_mode musi być jednym z: auto, include, exclude' }); return }
      data.pnl_mode = String(b.pnl_mode)
    }
    if (b.cost_category !== undefined) {
      if (!COST_CATEGORIES.has(String(b.cost_category))) { res.status(400).json({ error: 'cost_category musi być jednym z: cogs, sales, ga, operations, financial' }); return }
      data.cost_category = String(b.cost_category)
    }
    if (b.subcategory !== undefined) {
      const sub = String(b.subcategory ?? '').trim()
      if (!sub) { res.status(400).json({ error: 'subcategory nie może być puste' }); return }
      data.subcategory = sub.slice(0, 60)
    }
    if (b.business_unit !== undefined) {
      if (!BUSINESS_UNITS.has(String(b.business_unit))) { res.status(400).json({ error: 'business_unit musi być jednym z: shc, gatelynk, shared' }); return }
      data.business_unit = String(b.business_unit)
    }
    if (!Object.keys(data).length) { res.status(400).json({ error: 'Brak pól do zmiany (pnl_mode, cost_category, subcategory, business_unit)' }); return }

    // Tylko przelewy z wyciągu: koszty ręczne edytuje admin w /manual-costs, koszty z dokumentów — skrzynka (approve/reject)
    const existing = await prisma.manualCost.findFirst({ where: { id: req.params.id, source: 'mt940' } })
    if (!existing) { res.status(404).json({ error: 'Przelew nie znaleziony' }); return }

    // Przelew wykluczony przez zatwierdzony dokument: koszt liczy dokument — przywrócenie liczyłoby go podwójnie
    if (data.pnl_mode !== undefined && data.pnl_mode !== 'exclude') {
      const doc = await prisma.costDocument.findFirst({
        where: { status: 'approved', duplicate_of: `mt940:${existing.id}` },
        select: { id: true, seller_name: true, doc_number: true },
      })
      if (doc) {
        res.status(409).json({
          error: `Ten przelew jest wykluczony z RZiS przez zatwierdzony dokument ${[doc.seller_name, doc.doc_number].filter(Boolean).join(' · ') || doc.id} (koszt liczy dokument). Żeby go przywrócić, odrzuć ten dokument w skrzynce kosztów.`,
          document_id: doc.id,
        })
        return
      }
    }

    // Jednorazowa decyzja = bez reguły + znacznik w notes (POST /apply i DELETE reguły jej nie nadpiszą);
    // pnl_mode=auto cofa decyzję — przelew znów podlega regułom i wraca na listę nierozpoznanych.
    const who = String((req as any).user?.email ?? '')
    const patch: Record<string, string | null> = { ...data, bank_rule_id: null }
    patch.notes = data.pnl_mode === 'auto'
      ? withoutManualDecisionMarker(existing.notes)
      : withManualDecisionMarker(existing.notes, who, now().slice(0, 10))
    const updated = await prisma.manualCost.update({ where: { id: existing.id }, data: patch })
    if (existing.bank_rule_id) await recomputeHits()
    res.json(updated)
  } catch (e) {
    console.error('[bank-rules/cost]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── PUT /api/finance/bank-rules/:id ───────────────────────────────────────────
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await prisma.bankRule.findUnique({ where: { id: req.params.id } })
    if (!existing) { res.status(404).json({ error: 'Reguła nie znaleziona' }); return }
    const v = ruleDataFromBody(req.body, true)
    if (v.error || !v.data) { res.status(400).json({ error: v.error ?? 'Nieprawidłowe dane' }); return }
    if (v.data.pattern) {
      const dup = await findDuplicatePattern(v.data.pattern, existing.id)
      if (dup) { res.status(409).json({ error: 'Inna reguła ma już taki sam fragment', existing_id: dup.id }); return }
    }
    const updated = await prisma.bankRule.update({
      where: { id: existing.id },
      data: { ...v.data, updated_at: now() },
    })
    res.json(updated)
  } catch (e) {
    console.error('[bank-rules/update]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── DELETE /api/finance/bank-rules/:id — koszty z tej reguły wracają do trybu auto ──
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await prisma.bankRule.findUnique({ where: { id: req.params.id } })
    if (!existing) { res.status(404).json({ error: 'Reguła nie znaleziona' }); return }
    // Przelewy, których pnl_mode ustawiono poza regułą (wykluczył je dokument / strażnik duplikatów),
    // tylko odpinamy od reguły — pnl_mode zostaje, inaczej koszt wróciłby do RZiS obok dokumentu.
    const [linked, excludedByDocument] = await Promise.all([
      prisma.manualCost.findMany({ where: { bank_rule_id: existing.id }, select: { id: true, pnl_mode: true, bank_rule_id: true, notes: true } }),
      loadExcludedByDocument(),
    ])
    const keepIds = linked.filter(c => isDecidedOutsideRules(c, excludedByDocument)).map(c => c.id)
    const kept = keepIds.length
      ? await prisma.manualCost.updateMany({ where: { id: { in: keepIds } }, data: { bank_rule_id: null } })
      : { count: 0 }
    const reset = await prisma.manualCost.updateMany({
      where: { bank_rule_id: existing.id, id: { notIn: keepIds } },
      data: { bank_rule_id: null, pnl_mode: 'auto' },
    })
    await prisma.bankRule.delete({ where: { id: existing.id } })
    res.json({ ok: true, costs_reset: reset.count, costs_kept_excluded: kept.count })
  } catch (e) {
    console.error('[bank-rules/delete]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
