/**
 * Reguły bankowe — automatyczna kategoryzacja przelewów z wyciągu MT940 (ManualCost source='mt940').
 * Mount: /api/finance/bank-rules (admin lub can_view_payments).
 *
 * Przepływ: przelew z wyciągu → klasyfikator strukturalny (services/bank-classify: ZUS, podatki, pensje,
 * opłaty, przelewy własne, dostawcy zagraniczni) → pierwsza pasująca reguła użytkownika (dłuższy wzorzec
 * ma pierwszeństwo) NADPISUJE klasyfikator: nadaje kategorię i decyduje, czy koszt liczy się w RZiS
 * (pnl_mode include/exclude). Wyjątek: przelew własny / rachunek VAT (auto_kind='internal') — nigdy nie
 * jest kosztem, więc reguły go nie dotykają i nie pojawia się na liście nierozpoznanych.
 * „Nierozpoznane przelewy" = wychodzące bez reguły, które nie wchodzą do RZiS i nie są płatnością
 * za fakturę z KSeF (w tym pominięte jednorazowo, pnl_mode=exclude — żeby dało się cofnąć „Pomiń") —
 * użytkownik tworzy z nich regułę albo decyduje jednorazowo (PATCH /cost/:id).
 *
 * Decyzja o pnl_mode podjęta POZA regułami i klasyfikatorem (zatwierdzony dokument ze skrzynki,
 * „Pomiń"/„Licz w RZiS", strażnik duplikatów przy imporcie) jest nienaruszalna dla POST /apply
 * i DELETE /:id — inaczej koszt liczyłby się podwójnie (dokument + przelew) albo decyzja użytkownika
 * znikałaby po kliknięciu „Zastosuj reguły do historii". pnl_mode nadany przez KLASYFIKATOR taką decyzją
 * nie jest: reguła może go nadpisać, a usunięcie reguły przywraca wynik klasyfikatora (nie „gołe" auto).
 * Reguła dająca include przechodzi tych samych strażników co import (płatność za fakturę KSeF,
 * duplikat zatwierdzonego dokumentu).
 */
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { requirePayments } from './payables'
import { includeManualCostInPnl, addMonths } from './finance'
import {
  applyBankRules, normalizeForMatch, sortRules, splitStoredDescription, hasDecisionMarker, isClassifierDecision,
  classifyStoredCost, decideMt940Cost, loadClassifyContext, loadIncludeGuardContext, loadExcludedByDocument,
  takeGuardDocument, saveDocumentPairs, runInBatches, withoutAutoNote, appendNoteParts, parseFxNote,
  NOTE_KSEF_PAYMENT, noteDocumentDuplicate,
  type DocumentPair, type GuardDoc, type IncludeGuardContext, isRuleImmuneKind,
} from '../services/mt940-costs'
import { KIND_LABELS, KIND_TARGETS, type BankKind } from '../services/bank-classify'

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
  // słowa z tytułów kart i przelewów, które pasują do setek niepowiązanych operacji
  'transakcji', 'transakcje', 'data', 'operacja', 'operacji', 'bankowa', 'bankowy', 'wych', 'przych',
  'kasa', 'sklep', 'stacja', 'market', 'punkt', 'oddzial', 'online', 'store', 'shop',
  // formy prawne i ogólniki z nazw firm
  'odpowiedzialnoscia', 'ograniczona', 'przedsiebiorstwo', 'komandytowa', 'komandytowo', 'akcyjna', 'jawna',
  'cywilna', 'handlowo', 'handlowe', 'handlowa', 'uslugowe', 'uslugowa', 'uslugowo', 'produkcyjno', 'produkcyjne',
  'polska', 'poland', 'group', 'grupa', 'holding', 'international', 'gmbh', 'limited', 'company',
  // urzędy — fragment „SKARBOWY" / „URZĄD" złapałby VAT, PIT-4 i CIT naraz
  'urzad', 'skarbowy', 'skarbowa', 'administracji', 'zaklad',
  // miasta, które stoją w tytułach płatności kartą („SKLEP/WARSZAWA")
  'warszawa', 'krakow', 'wroclaw', 'poznan', 'gdansk', 'gdynia', 'lodz', 'katowice', 'lublin', 'szczecin',
])

/**
 * Tytuł przelewu oczyszczony do szukania słowa-wzorca: bez stopki płatności kartą („… DATA TRANSAKCJI: 2026-09-01"),
 * a dla kart tylko część sprzedawcy przed „/" („SKLEP BUDOWLANY KASA 8/WARSZAWA" → „SKLEP BUDOWLANY KASA 8");
 * bez struktury split payment („/VAT/…/IDC/…/INV/…/TXT/…" — to numery, nie nazwa).
 */
export function patternSourceTitle(description: string | null | undefined): string {
  let d = String(description ?? '')
  const card = /\s*DATA TRANSAKCJI\b.*$/i
  if (card.test(d)) {
    d = d.replace(card, '')
    const slash = d.indexOf('/')
    if (slash > 0) d = d.slice(0, slash)
  }
  if (/^\s*\/VAT\//i.test(d)) d = ''
  return d
}

/**
 * Propozycja fragmentu do nowej reguły: najdłuższe słowo (≥ 4 litery, bez cyfr) z kontrahenta,
 * a gdy brak — z opisu. Pomija słowa zbyt ogólne (przelew, faktura…).
 */
export function suggestPattern(counterparty: string | null | undefined, description: string | null | undefined): string {
  // PIERWSZE wyróżniające słowo (≥ 4 litery, nie ogólnik) — w nazwie firmy i w tytule płatności kartą to zwykle
  // marka („BRICOMAN KASA 8" → BRICOMAN). Najdłuższe słowo bywało ogólnikiem („ODPOWIEDZIALNOŚCIĄ", „TRANSAKCJI")
  // i reguła z niego pasowała do dziesiątek niepowiązanych przelewów.
  const pick = (s: string | null | undefined): string =>
    String(s ?? '')
      .split(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+/)
      .find(w => w.length >= 4 && !STOP_WORDS.has(normalizeForMatch(w))) ?? ''
  return pick(counterparty) || pick(patternSourceTitle(description))
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

// Znaczniki decyzji w `notes` (wykluczony przez dokument / decyzja ręczna / duplikat dokumentu / płatność
// za fakturę KSeF) rozpoznaje `hasDecisionMarker` — definicja w services/mt940-costs (korzysta z niej też
// naprawa starego importu), tu re-eksport dla dotychczasowych importów.
export { hasDecisionMarker }
export const MANUAL_DECISION_MARKER = 'decyzja ręczna'

/**
 * Czy o pnl_mode tego przelewu zdecydowano poza regułami: wykluczył go zatwierdzony dokument
 * (duplicate_of='mt940:<id>'), ma znacznik w notes, albo ma pnl_mode ≠ auto bez reguły (jednorazowa decyzja).
 * Takich wierszy POST /apply nie dotyka, a DELETE reguły nie cofa ich do auto.
 *
 * NIE jest taką decyzją pnl_mode nadany przez KLASYFIKATOR (auto_kind ustawiony, bez reguły i znacznika,
 * pnl_mode zgodny z rodzajem — np. dostawca zagraniczny = include): regułę użytkownika wolno na niego nałożyć.
 */
export function isDecidedOutsideRules(
  c: { id: string; pnl_mode?: string | null; bank_rule_id?: string | null; notes?: string | null; auto_kind?: string | null },
  excludedByDocument: Set<string>,
): boolean {
  if (excludedByDocument.has(c.id)) return true
  if (hasDecisionMarker(c.notes)) return true
  if ((c.pnl_mode ?? 'auto') === 'auto' || c.bank_rule_id) return false
  return !isClassifierDecision(c)
}

/**
 * Czy reguły bankowe NIE mogą zmienić tego wiersza: decyzja spoza reguł albo rodzaj, który z definicji nie
 * jest kosztem (przelew własny / rachunek VAT, zapłata VAT do urzędu — RULE_IMMUNE_KINDS).
 */
export function isImmuneToRules(
  c: { id: string; pnl_mode?: string | null; bank_rule_id?: string | null; notes?: string | null; auto_kind?: string | null },
  excludedByDocument: Set<string>,
): boolean {
  return isRuleImmuneKind(c.auto_kind) || isDecidedOutsideRules(c, excludedByDocument)
}

/** Etykieta rodzaju rozpoznanego przez klasyfikator (null, gdy przelew nierozpoznany / stary import). */
export function autoKindLabel(kind: string | null | undefined): string | null {
  const k = String(kind ?? '')
  return k && Object.prototype.hasOwnProperty.call(KIND_LABELS, k) ? KIND_LABELS[k as BankKind] : null
}

/** Kwota w walucie wyciągu (dla strażnika płatności KSeF): oryginalna z notatki kursowej albo zapisana. */
function statementAmount(c: { amount: number; notes?: string | null }): number {
  return parseFxNote(c.notes)?.amount ?? c.amount
}

/**
 * Strażnicy podwójnego liczenia dla wiersza, który właśnie dostaje pnl_mode=include (z reguły albo
 * z przywróconego wyniku klasyfikatora): płatność za fakturę KSeF → exclude; duplikat zatwierdzonego
 * dokumentu → exclude + parowanie z dokumentem. Zwraca notatki do dopisania (puste = include zostaje).
 */
function guardInclude(
  c: { id: string; date: string; amount: number; description: string; reference: string; notes?: string | null },
  guards: IncludeGuardContext,
  pairs: DocumentPair[],
): string[] {
  if (isKsefPayment({ date: c.date, amount: statementAmount(c), reference: c.reference }, guards.ksefIndex)) return [NOTE_KSEF_PAYMENT]
  const doc: GuardDoc | null = takeGuardDocument({ date: c.date, amount: c.amount, description: c.description, reference: c.reference }, guards)
  if (!doc) return []
  pairs.push({ doc, costId: c.id, date: c.date, amount: c.amount, description: c.description })
  return [noteDocumentDuplicate(doc.id)]
}

function dateRange(dates: string[]): { from: string; to: string } {
  const sorted = [...dates].sort()
  return { from: sorted[0], to: sorted[sorted.length - 1] }
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
    let skipped_internal = 0
    const by_rule: Record<string, number> = {}
    const changes: Array<{ c: typeof costs[number]; data: Record<string, string | null>; ruleId: string }> = []
    for (const c of costs) {
      // Przelew własny / rachunek VAT i zapłata VAT nigdy nie są kosztem — żadna reguła ich nie zmienia
      if (isRuleImmuneKind(c.auto_kind)) { skipped_internal++; continue }
      // Decyzja spoza reguł (dokument „mimo to", „Pomiń"/„Licz w RZiS", strażnik duplikatów) — nie ruszamy,
      // nawet z overwrite: przywrócenie include liczyłoby koszt podwójnie (dokument + przelew).
      // Wynik KLASYFIKATORA taką decyzją nie jest — reguła użytkownika ma przed nim pierwszeństwo.
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
      changes.push({
        c, ruleId: rule.id,
        data: {
          cost_category: cost.cost_category, subcategory: cost.subcategory, business_unit: cost.business_unit,
          pnl_mode: cost.pnl_mode, bank_rule_id: cost.bank_rule_id ?? null,
        },
      })
    }

    // Reguła daje include → ci sami strażnicy co przy imporcie: przelew opłacający fakturę KSeF albo
    // już zatwierdzony dokument ze skrzynki zostaje wykluczony (koszt liczy faktura / dokument).
    const including = changes.filter(ch => ch.data.pnl_mode === 'include' && ch.c.pnl_mode !== 'include')
    const pairs: DocumentPair[] = []
    if (including.length) {
      const { from, to } = dateRange(including.map(ch => ch.c.date))
      const guards = await loadIncludeGuardContext(from, to, { withDocs: true })
      for (const ch of including) {
        const reasons = guardInclude(ch.c, guards, pairs)
        if (!reasons.length) continue
        ch.data.pnl_mode = 'exclude'
        ch.data.notes = appendNoteParts(withoutAutoNote(ch.c.notes), reasons)
      }
    }
    for (const ch of changes) {
      // kategorię przejęła reguła — notatka klasyfikatora „rozpoznano: …" przestaje opisywać ten wiersz
      if (ch.data.notes === undefined && withoutAutoNote(ch.c.notes) !== String(ch.c.notes ?? '').trim()) {
        ch.data.notes = withoutAutoNote(ch.c.notes)
      }
    }
    await runInBatches(changes, 10, async ch => {
      await prisma.manualCost.update({ where: { id: ch.c.id }, data: ch.data })
    })
    await saveDocumentPairs(pairs)
    for (const ch of changes) {
      updated++
      by_rule[ch.ruleId] = (by_rule[ch.ruleId] ?? 0) + 1
    }
    await recomputeHits()
    res.json({ updated, by_rule, skipped_decided, skipped_internal })
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
      // Przelew własny / rachunek VAT (auto_kind='internal') nigdy tu nie trafia — to nie jest koszt do decyzji.
      .filter(c => c.auto_kind !== 'internal' && !c.bank_rule_id && !includeManualCostInPnl(c) && !isKsefPayment(c, index))
      .map(c => {
        const { counterparty, description } = splitStoredDescription(c.description)
        return {
          id: c.id, date: c.date, amount: c.amount, description: c.description, reference: c.reference,
          subcategory: c.subcategory, cost_category: c.cost_category, pnl_mode: c.pnl_mode,
          suggested_pattern: suggestPattern(counterparty, description),
          // co rozpoznał klasyfikator (np. „Inny podatek / opłata urzędowa") — null = nierozpoznany / stary import
          auto_kind: c.auto_kind ?? null,
          auto_label: autoKindLabel(c.auto_kind),
        }
      })
      // Limit 300: najpierw przelewy CZEKAJĄCE na decyzję (największe kwoty), dopiero potem pominięte —
      // po wgraniu wielu miesięcy naraz pominięte nie mogą wypchnąć z listy tych, które wymagają decyzji.
      .sort((a, b) => Number(a.pnl_mode === 'exclude') - Number(b.pnl_mode === 'exclude')
        || b.amount - a.amount || b.date.localeCompare(a.date))
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
    // „Przywróć" (pnl_mode=auto) na przelewie ROZPOZNANYM przez klasyfikator wraca do jego wyniku, a nie do
    // gołego `auto`: dostawca zagraniczny bez KSeF ma u klasyfikatora `include` — po `auto` wypadłby z RZiS,
    // choć notatka nadal mówi „rozpoznano". (Płatność za fakturę KSeF i tak odsiewa silnik RZiS przy odczycie.)
    if (data.pnl_mode === 'auto' && data.cost_category === undefined && data.subcategory === undefined) {
      const kind = String(existing.auto_kind ?? '')
      if (Object.prototype.hasOwnProperty.call(KIND_TARGETS, kind)) {
        const target = KIND_TARGETS[kind as BankKind]
        patch.pnl_mode = target.pnl_mode
        // kategoria z klasyfikatora tylko dla rodzajów o stałej kategorii; dostawca / przelew zagraniczny
        // ma kategorię zależną od sprzedawcy — zostaje ta zapisana przy imporcie
        if (kind !== 'foreign_vendor' && kind !== 'foreign_transfer') {
          patch.cost_category = target.cost_category
          patch.subcategory = target.subcategory
        }
      }
    }
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

// ── DELETE /api/finance/bank-rules/:id — koszty z tej reguły wracają do wyniku klasyfikatora ──
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await prisma.bankRule.findUnique({ where: { id: req.params.id } })
    if (!existing) { res.status(404).json({ error: 'Reguła nie znaleziona' }); return }
    // Przelewy, których pnl_mode ustawiono poza regułą (wykluczył je dokument / strażnik duplikatów),
    // tylko odpinamy od reguły — pnl_mode zostaje, inaczej koszt wróciłby do RZiS obok dokumentu.
    const [linked, excludedByDocument] = await Promise.all([
      prisma.manualCost.findMany({ where: { bank_rule_id: existing.id } }),
      loadExcludedByDocument(),
    ])
    const keepIds = linked.filter(c => isDecidedOutsideRules(c, excludedByDocument)).map(c => c.id)
    const kept = keepIds.length
      ? await prisma.manualCost.updateMany({ where: { id: { in: keepIds } }, data: { bank_rule_id: null } })
      : { count: 0 }

    // Pozostałe wracają do tego, co rozpoznaje KLASYFIKATOR (z zapisanego opisu, kodu operacji, rachunku,
    // daty i kwoty) — nie do „gołego" auto z kategorią po regule: pensja / ZUS / podatek znów liczą się
    // w RZiS, dostawca zagraniczny zostaje include, przelew własny exclude, nierozpoznany wraca na listę do
    // decyzji (ga/other). Wynik include przechodzi strażników (płatność KSeF / duplikat dokumentu).
    const restore = linked.filter(c => !keepIds.includes(c.id))
    const pairs: DocumentPair[] = []
    if (restore.length) {
      const context = await loadClassifyContext()
      const plans = restore.map(c => ({ c, cls: classifyStoredCost(c, context) }))
      const { from, to } = dateRange(restore.map(c => c.date))
      const guards = plans.some(p => p.cls.pnl_mode === 'include')
        ? await loadIncludeGuardContext(from, to, { withDocs: true })
        : null
      const updates = plans.map(({ c, cls }) => {
        const foreign = (String(c.currency ?? '').trim().toUpperCase() || 'PLN') !== 'PLN'
        const dec = decideMt940Cost<GuardDoc>({
          classification: cls, rules: [], fxMissing: foreign,
          isKsefPayment: () => !!guards && isKsefPayment({ date: c.date, amount: statementAmount(c), reference: c.reference }, guards.ksefIndex),
          findDocument: () => (guards ? takeGuardDocument({ date: c.date, amount: c.amount, description: c.description, reference: c.reference }, guards) : null),
        })
        if (dec.document) pairs.push({ doc: dec.document, costId: c.id, date: c.date, amount: c.amount, description: c.description })
        return {
          id: c.id,
          data: {
            bank_rule_id: null,
            cost_category: dec.cost_category, subcategory: dec.subcategory, business_unit: dec.business_unit,
            pnl_mode: dec.pnl_mode, auto_kind: dec.auto_kind,
            notes: appendNoteParts(withoutAutoNote(c.notes), [...dec.reasons, dec.auto_note]),
          },
        }
      })
      await runInBatches(updates, 10, async u => {
        await prisma.manualCost.update({ where: { id: u.id }, data: u.data })
      })
      await saveDocumentPairs(pairs)
    }
    await prisma.bankRule.delete({ where: { id: existing.id } })
    res.json({ ok: true, costs_reset: restore.length, costs_kept_excluded: kept.count })
  } catch (e) {
    console.error('[bank-rules/delete]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
