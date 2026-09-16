/**
 * Wspólny serwis importu kosztów z wyciągu MT940 → ManualCost (source='mt940') + zapis sald (BankBalance).
 * Używany przez POST /api/payables/import-mt940 i POST /api/manual-costs/import-mt940.
 *
 * Koszt = transakcja wychodząca (amount < 0), nie storno. Deduplikacja po kluczu
 * `date|abs(amount)|reference` (bez referencji — początek opisu) względem istniejących
 * ManualCost source='mt940'. Kategoria: autoClassifyManual → reguły bankowe (BankRule):
 * pierwsza pasująca, dłuższy wzorzec ma pierwszeństwo. Trafienie reguły nadaje kategorię,
 * jednostkę, pnl_mode (include/exclude) i bank_rule_id oraz zwiększa licznik trafień.
 *
 * Waluta obca (wyciąg z rachunku EUR/USD…): kwota przeliczana na PLN kursem średnim NBP
 * z dnia roboczego poprzedzającego datę operacji (notes: „1 000,00 EUR × kurs NBP … z dnia …”);
 * brak kursu → kwota i waluta oryginalna, pnl_mode=exclude, do ręcznej decyzji. Klucz
 * deduplikacji liczony po kwocie ORYGINALNEJ (odtwarzanej z notatki) i dodatkowo po kwocie
 * w PLN, żeby ponowny import tego samego pliku nie tworzył duplikatów.
 *
 * Ochrona przed podwójnym liczeniem, gdy reguła bankowa daje pnl_mode=include:
 *  - przelew dopasowany do faktury KSeF (BankTransaction.matched_invoice_id) → exclude,
 *    notes „płatność za fakturę KSeF” (koszt liczy alokacja faktury);
 *  - przelew pasujący do już ZATWIERDZONEGO dokumentu ze skrzynki (kwota ±max(2 zł, 2 %),
 *    wspólny token nazwy, data ±60 dni) → exclude, notes „duplikat dokumentu <id> — wykluczony
 *    przez dokument <id>”, a dokument dostaje duplicate_of='mt940:<id>' (reject/usunięcie
 *    dokumentu przywraca przelew).
 */
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import type { ParsedTransaction, StatementBalance } from '../utils/mt940Parser'
import { cleanMt940Fields } from '../routes/payables'
import { autoClassifyManual } from '../routes/manual-costs'
import { getNbpRate, type NbpRate } from './nbp-rates'
import { findMt940Duplicate } from './cost-duplicates'

export interface BankRuleLike {
  id: string
  pattern: string
  match_field?: string | null      // counterparty | description | any
  cost_category: string
  subcategory: string
  business_unit?: string | null
  pnl_mode?: string | null         // include | exclude
}

export interface RuleTarget {
  counterparty?: string | null     // brak pola (null/undefined) → rozbij description „kontrahent · tytuł"
  description?: string | null
  cost_category?: string
  subcategory?: string
  business_unit?: string
  pnl_mode?: string
  bank_rule_id?: string | null
}

export interface Mt940CostsResult {
  created: number
  skipped_existing: number
  rules_applied: number
}

/** Separator w opisie ManualCost z MT940: `kontrahent · tytuł przelewu`. */
export const DESC_SEPARATOR = ' · '

// Referencje, które nie identyfikują transakcji (bank nie nadał numeru)
const NON_REFERENCES = new Set(['', 'NONREF', 'NOTPROVIDED', 'BRAK'])

// ── Czyste funkcje (testowane) ────────────────────────────────────────────────

/** Do porównań: małe litery, bez polskich znaków diakrytycznych, pojedyncze spacje. */
export function normalizeForMatch(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Dłuższy wzorzec pierwszy (bardziej szczegółowa reguła wygrywa); remis — alfabetycznie. */
export function sortRules<T extends BankRuleLike>(rules: T[]): T[] {
  return [...rules].sort((a, b) => {
    const la = normalizeForMatch(a.pattern).length
    const lb = normalizeForMatch(b.pattern).length
    return lb - la || String(a.pattern).localeCompare(String(b.pattern))
  })
}

/** Opis zapisany w ManualCost (`kontrahent · tytuł`) → osobne pola. */
export function splitStoredDescription(description: string | null | undefined): { counterparty: string; description: string } {
  const d = String(description ?? '')
  const idx = d.indexOf(DESC_SEPARATOR)
  if (idx < 0) return { counterparty: '', description: d.trim() }
  return { counterparty: d.slice(0, idx).trim(), description: d.slice(idx + DESC_SEPARATOR.length).trim() }
}

/** `kontrahent · tytuł` (≤ 500 znaków); bez kontrahenta — sam tytuł. */
export function composeDescription(counterparty: string | null | undefined, description: string | null | undefined): string {
  const cp = String(counterparty ?? '').replace(/\s+/g, ' ').trim()
  const d = String(description ?? '').replace(/\s+/g, ' ').trim()
  const full = cp && d && cp !== d ? `${cp}${DESC_SEPARATOR}${d}` : (cp || d)
  return full.slice(0, 500)
}

/** Klucz deduplikacji: `date|abs(amount)|reference` (bez referencji — pierwsze 60 znaków opisu). */
export function mt940CostKey(c: { date: string; amount: number; reference?: string | null; description?: string | null }): string {
  const ref = String(c.reference ?? '').trim()
  const tail = NON_REFERENCES.has(ref.toUpperCase()) ? String(c.description ?? '').slice(0, 60) : ref
  return `${c.date}|${Math.abs(Number(c.amount) || 0).toFixed(2)}|${tail}`
}

/** Pierwsza pasująca reguła (po sortowaniu: dłuższy wzorzec pierwszy) lub null. */
export function matchBankRule(
  target: { counterparty?: string | null; description?: string | null },
  rules: BankRuleLike[],
): BankRuleLike | null {
  let cp: string
  let desc: string
  if (target.counterparty == null) {
    const split = splitStoredDescription(target.description)
    cp = normalizeForMatch(split.counterparty)
    desc = normalizeForMatch(split.description)
  } else {
    cp = normalizeForMatch(target.counterparty)
    desc = normalizeForMatch(target.description)
  }

  for (const rule of sortRules(rules)) {
    const p = normalizeForMatch(rule.pattern)
    if (!p) continue
    const field = rule.match_field || 'any'
    const hit = field === 'counterparty' ? cp.includes(p)
      : field === 'description' ? desc.includes(p)
      : (cp.includes(p) || desc.includes(p))
    if (hit) return rule
  }
  return null
}

/**
 * Przepuszcza koszt przez reguły bankowe. Trafienie → nowy obiekt z kategorią, podkategorią,
 * jednostką, pnl_mode i bank_rule_id z reguły. Brak trafienia → ten sam obiekt, rule = null.
 */
export function applyBankRules<T extends RuleTarget>(cost: T, rules: BankRuleLike[]): { cost: T; rule: BankRuleLike | null } {
  const rule = matchBankRule(cost, rules)
  if (!rule) return { cost, rule: null }
  return {
    cost: {
      ...cost,
      cost_category: rule.cost_category,
      subcategory: rule.subcategory,
      business_unit: rule.business_unit || cost.business_unit || 'shared',
      pnl_mode: rule.pnl_mode === 'exclude' ? 'exclude' : 'include',
      bank_rule_id: rule.id,
    },
    rule,
  }
}

// ── Waluta obca: notatka z kursem i odtworzenie kwoty oryginalnej ─────────────

/** Notatka kosztu, którego nie dało się przeliczyć (brak kursu NBP) — koszt jest wykluczony z RZiS. */
export const NOTE_NO_NBP_RATE = 'brak kursu NBP — przelicz ręcznie'
/** Notatka przelewu, który jest płatnością za fakturę KSeF (koszt liczy alokacja faktury). */
export const NOTE_KSEF_PAYMENT = 'płatność za fakturę KSeF'
/** Notatka przelewu wykluczonego, bo ten koszt jest już w RZiS z zatwierdzonego dokumentu ze skrzynki. */
export function noteDocumentDuplicate(docId: string): string {
  return `duplikat dokumentu ${docId} — wykluczony przez dokument ${docId}`
}

const plnFmt = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const r2 = (n: number): number => Math.round(n * 100) / 100

/** „1 000,00 EUR × kurs NBP 4,3012 z dnia 2026-08-13” — format, z którego `parseFxNote` odtwarza kwotę oryginalną. */
export function formatFxNote(original: number, currency: string, rate: number, rateDate: string): string {
  return `${plnFmt.format(original)} ${currency} × kurs NBP ${rate.toFixed(4).replace('.', ',')} z dnia ${rateDate}`
}

const FX_NOTE_RE = /([\d\s  ]+,\d{2}) ([A-Z]{3}) × kurs NBP/

/** Kwota i waluta oryginalna z notatki `formatFxNote` (null, gdy koszt nie był przeliczany). */
export function parseFxNote(notes: string | null | undefined): { amount: number; currency: string } | null {
  const m = FX_NOTE_RE.exec(String(notes ?? ''))
  if (!m) return null
  const amount = Number(m[1].replace(/[\s  ]/g, '').replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { amount, currency: m[2] }
}

/**
 * Klucze deduplikacji istniejącego ManualCost: po zapisanej kwocie oraz — gdy koszt został
 * przeliczony z waluty obcej — po kwocie oryginalnej z notatki. Nowa transakcja z pliku
 * sprawdza klucz z kwoty oryginalnej i (po przeliczeniu) z kwoty w PLN, więc ponowny import
 * tego samego wyciągu walutowego trafia w istniejący wiersz niezależnie od dostępności NBP.
 */
export function existingCostKeys(e: { date: string; amount: number; reference?: string | null; description?: string | null; notes?: string | null }): string[] {
  const keys = [mt940CostKey(e)]
  const fx = parseFxNote(e.notes)
  if (fx) {
    const k = mt940CostKey({ ...e, amount: fx.amount })
    if (!keys.includes(k)) keys.push(k)
  }
  return keys
}

// ── Płatność za fakturę KSeF (ta sama logika co GET /bank-rules/unmatched) ────

export interface MatchedTxLite { transaction_date: string; amount: number; reference: string | null }

function alnumRef(s: string | null | undefined): string {
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
 * Czy przelew jest płatnością za fakturę KSeF: ta sama data, |kwota| ± 0,01 i zgodna referencja
 * (gdy którakolwiek strona nie ma referencji — wystarczy data + kwota).
 */
export function isKsefPayment(
  cost: { date: string; amount: number; reference?: string | null },
  index: Map<string, MatchedTxLite[]>,
): boolean {
  const list = index.get(cost.date)
  if (!list || !list.length) return false
  const ref = alnumRef(cost.reference)
  const amt = Math.abs(Number(cost.amount) || 0)
  return list.some(t => {
    if (Math.abs(Math.abs(t.amount) - amt) > 0.01) return false
    const tref = alnumRef(t.reference)
    return !ref || !tref || ref === tref
  })
}

// ── Przelew ↔ zatwierdzony dokument ze skrzynki (kierunek: dokument był pierwszy) ──

export interface ApprovedDocLite {
  id: string
  seller_name: string
  seller_nip?: string | null
  doc_number: string
  doc_date: string
  gross_pln: number
}

/**
 * Dokument ze skrzynki, którego koszt jest już w RZiS, a ten przelew go opłaca: kwota w PLN
 * ±max(2 zł, 2 % brutto dokumentu), wspólny token nazwy (≥ 4 litery) z opisem/kontrahentem,
 * data ±60 dni — dokładnie reguła `findMt940Duplicate` (ta sama logika co przy zatwierdzaniu
 * dokumentu, tylko w drugą stronę). Przy kilku trafieniach — najbliższa kwota.
 */
export function matchTransferToDocument<T extends ApprovedDocLite>(
  cost: { date: string; amount: number; description: string; reference?: string | null },
  docs: T[],
): T | null {
  const amount = Math.abs(Number(cost.amount) || 0)
  if (amount <= 0) return null
  const lite = { id: '_', date: cost.date, amount, description: String(cost.description ?? ''), reference: String(cost.reference ?? '') }
  let best: { doc: T; diff: number } | null = null
  for (const d of docs) {
    const gross = Number(d.gross_pln) || 0
    if (gross <= 0) continue
    const hit = findMt940Duplicate(
      { id: d.id, seller_name: d.seller_name, seller_nip: String(d.seller_nip ?? ''), doc_number: d.doc_number, doc_date: d.doc_date, gross_pln: gross },
      [lite],
    )
    if (!hit) continue
    const diff = Math.abs(gross - amount)
    if (!best || diff < best.diff) best = { doc: d, diff }
  }
  return best?.doc ?? null
}

/** Id dokumentów, które już wykluczyły jakiś przelew (z notatek „wykluczony przez dokument <id>”). */
export function excludingDocIdsFromNotes(notes: Array<string | null | undefined>): Set<string> {
  const ids = new Set<string>()
  const re = /wykluczony przez dokument ([0-9a-zA-Z-]+)/g
  for (const n of notes) {
    for (const m of String(n ?? '').matchAll(re)) ids.add(m[1])
  }
  return ids
}

function shiftDate(iso: string, days: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

// ── Zapis do bazy ─────────────────────────────────────────────────────────────

/** Upsert sald wyciągów po [account, date, statement_no]. Zwraca liczbę zapisanych. */
export async function saveBankBalances(balances: StatementBalance[]): Promise<number> {
  let saved = 0
  for (const b of balances) {
    if (!b.account || !b.date) continue // bez :25: nie wiemy, którego rachunku to saldo
    await prisma.bankBalance.upsert({
      where: { account_date_statement_no: { account: b.account, date: b.date, statement_no: b.statement_no } },
      create: {
        id: uuidv4(), account: b.account, currency: b.currency, date: b.date,
        opening: b.opening, closing: b.closing, statement_no: b.statement_no,
        created_at: new Date().toISOString(),
      },
      update: { currency: b.currency, opening: b.opening, closing: b.closing },
    })
    saved++
  }
  return saved
}

/**
 * Tworzy ManualCost (source='mt940') dla obciążeń z wyciągu, pomijając już zaimportowane.
 * Kwota zapisywana dodatnio i w PLN (waluta obca → kurs NBP), pnl_mode domyślnie `auto`
 * (o włączeniu do RZiS decyduje includeManualCostInPnl), reguła bankowa może ustawić
 * include/exclude; include jest cofane do exclude dla płatności za fakturę KSeF i dla
 * przelewu opłacającego już zatwierdzony dokument ze skrzynki (patrz nagłówek pliku).
 */
export async function upsertMt940Costs(
  transactions: ParsedTransaction[],
  opts: { createdBy?: string } = {},
): Promise<Mt940CostsResult> {
  const outgoing = transactions.filter(t => t.amount < 0 && !t.is_reversal)
  if (!outgoing.length) return { created: 0, skipped_existing: 0, rules_applied: 0 }

  const rules = sortRules(await prisma.bankRule.findMany())

  // Jednorazowe wczytanie istniejących kosztów MT940 z dat występujących w pliku.
  // Każdy istniejący wiersz może „zużyć" tylko jedną transakcję z pliku: dwa identyczne
  // autentyczne przelewy tego samego dnia nie mogą się nawzajem deduplikować.
  const dates = [...new Set(outgoing.map(t => t.date))].sort()
  const existing = await prisma.manualCost.findMany({
    where: { source: 'mt940', date: { in: dates } },
    select: { date: true, amount: true, reference: true, description: true, notes: true },
  })
  const existingByKey = new Map<string, number[]>()
  existing.forEach((e, i) => {
    for (const k of existingCostKeys(e)) {
      const list = existingByKey.get(k) ?? []
      list.push(i)
      existingByKey.set(k, list)
    }
  })
  const consumed = new Set<number>()
  const takeExisting = (keys: string[]): boolean => {
    for (const k of keys) {
      for (const i of existingByKey.get(k) ?? []) {
        if (!consumed.has(i)) { consumed.add(i); return true }
      }
    }
    return false
  }

  // Płatności za faktury KSeF (BankTransaction z matched_invoice_id) i zatwierdzone dokumenty
  // ze skrzynki — potrzebne tylko, gdy jakaś reguła może dać pnl_mode=include.
  let ksefIndex = new Map<string, MatchedTxLite[]>()
  let candidateDocs: Array<ApprovedDocLite & { duplicate_of: string }> = []
  if (rules.some(r => r.pnl_mode !== 'exclude')) {
    const minDate = dates[0], maxDate = dates[dates.length - 1]
    const [matchedTx, docs] = await Promise.all([
      prisma.bankTransaction.findMany({
        where: { source: 'mt940', matched_invoice_id: { not: null }, transaction_date: { in: dates } },
        select: { transaction_date: true, amount: true, reference: true },
      }),
      prisma.costDocument.findMany({
        where: { status: 'approved', gross_pln: { gt: 0 }, doc_date: { gte: shiftDate(minDate, -60), lte: shiftDate(maxDate, 60) } },
        select: { id: true, seller_name: true, seller_nip: true, doc_number: true, doc_date: true, gross_pln: true, duplicate_of: true },
      }),
    ])
    ksefIndex = buildMatchedIndex(matchedTx)
    if (docs.length) {
      // Dokument może wykluczyć tylko JEDEN przelew: pomiń te, które już są sparowane
      // (duplicate_of='mt940:…' albo notatka „wykluczony przez dokument <id>" na jakimś przelewie).
      const excludedBy = await prisma.manualCost.findMany({
        where: { source: 'mt940', notes: { contains: 'wykluczony przez dokument' } },
        select: { notes: true },
      })
      const alreadyPaired = excludingDocIdsFromNotes(excludedBy.map(e => e.notes))
      candidateDocs = docs.filter(d => !String(d.duplicate_of).startsWith('mt940:') && !alreadyPaired.has(d.id))
    }
  }
  const usedDocs = new Set<string>()

  // Kurs NBP per (waluta, data) — getNbpRate cache'uje tylko sukcesy, więc przy awarii sieci
  // nie próbujemy 8 s dla każdej transakcji z tego samego dnia
  const rateCache = new Map<string, NbpRate>()
  const rateFor = async (cur: string, date: string): Promise<NbpRate> => {
    const k = `${cur}|${date}`
    let r = rateCache.get(k)
    if (!r) { r = await getNbpRate(cur, date); rateCache.set(k, r) }
    return r
  }

  const now = new Date().toISOString()
  const rows: Array<{
    id: string; date: string; description: string; amount: number; currency: string
    cost_category: string; subcategory: string; business_unit: string; period: string
    notes: string; reference: string; source: string; pnl_mode: string
    bank_rule_id: string | null; created_at: string; created_by: string
  }> = []
  // dokument → nowy koszt MT940, który wykluczył (po zapisie: duplicate_of='mt940:<id>')
  const docPairs: Array<{ doc: ApprovedDocLite & { duplicate_of: string }; costId: string; date: string; amount: number; description: string }> = []
  const hitsByRule = new Map<string, number>()
  let skipped = 0
  let rulesApplied = 0

  for (const tx of outgoing) {
    const clean = cleanMt940Fields(tx)
    const description = composeDescription(clean.counterparty, clean.description)
    const reference = String(tx.reference ?? '').trim().slice(0, 100)
    const currencyOrig = (String(tx.currency ?? '').trim().toUpperCase() || 'PLN')
    const original = r2(Math.abs(tx.amount))

    // Deduplikacja po kwocie oryginalnej (klucz z pliku = klucz z notatki kursowej)
    if (takeExisting([mt940CostKey({ date: tx.date, amount: original, reference, description })])) { skipped++; continue }

    // Waluta obca → PLN kursem NBP; brak kursu → kwota oryginalna, exclude, do ręcznej decyzji
    let amount = original
    let currency = 'PLN'
    let fxNote = ''
    let fxMissing = false
    if (currencyOrig !== 'PLN') {
      const { rate, date: rateDate } = await rateFor(currencyOrig, tx.date)
      if (rate > 0) {
        amount = r2(original * rate)
        fxNote = formatFxNote(original, currencyOrig, rate, rateDate)
        // Wiersz zapisany wcześniej w PLN, którego notatka kursowa została nadpisana — klucz po kwocie PLN
        if (takeExisting([mt940CostKey({ date: tx.date, amount, reference, description })])) { skipped++; continue }
      } else {
        currency = currencyOrig
        fxMissing = true
      }
    }

    const auto = autoClassifyManual(description, reference)
    const base: RuleTarget = {
      counterparty: clean.counterparty, description: clean.description,
      cost_category: auto.cost_category, subcategory: auto.subcategory, business_unit: auto.business_unit,
      pnl_mode: 'auto', bank_rule_id: null,
    }
    const applied = applyBankRules(base, rules)
    const rule = applied.rule
    let cost: RuleTarget = applied.cost
    if (rule) {
      rulesApplied++
      hitsByRule.set(rule.id, (hitsByRule.get(rule.id) ?? 0) + 1)
    }

    const id = uuidv4()
    const reasons: string[] = []
    if (fxMissing) {
      cost = { ...cost, pnl_mode: 'exclude' }
      reasons.push(NOTE_NO_NBP_RATE)
    } else if (rule && cost.pnl_mode === 'include') {
      if (isKsefPayment({ date: tx.date, amount: original, reference }, ksefIndex)) {
        // Ten przelew opłaca fakturę z KSeF — koszt liczy alokacja faktury (netto), nie przelew (brutto)
        cost = { ...cost, pnl_mode: 'exclude' }
        reasons.push(NOTE_KSEF_PAYMENT)
      } else {
        const doc = matchTransferToDocument({ date: tx.date, amount, description, reference }, candidateDocs.filter(d => !usedDocs.has(d.id)))
        if (doc) {
          // Koszt jest już w RZiS z zatwierdzonego dokumentu (faktura przyszła przed wyciągiem)
          usedDocs.add(doc.id)
          cost = { ...cost, pnl_mode: 'exclude' }
          reasons.push(noteDocumentDuplicate(doc.id))
          docPairs.push({ doc, costId: id, date: tx.date, amount, description })
        }
      }
    }

    rows.push({
      id,
      date: tx.date,
      description,
      amount,
      currency,
      cost_category: cost.cost_category ?? 'ga',
      subcategory: cost.subcategory ?? 'other',
      business_unit: cost.business_unit ?? 'shared',
      period: tx.date.slice(0, 7),
      notes: [fxNote, ...reasons].filter(Boolean).join(' · ').slice(0, 1000),
      reference,
      source: 'mt940',
      pnl_mode: cost.pnl_mode ?? 'auto',
      bank_rule_id: cost.bank_rule_id ?? null,
      created_at: now,
      created_by: opts.createdBy ?? '',
    })
  }

  if (rows.length) await prisma.manualCost.createMany({ data: rows })
  for (const [ruleId, n] of hitsByRule) {
    await prisma.bankRule.update({ where: { id: ruleId }, data: { hits: { increment: n } } })
  }
  // Dokument dostaje wskazanie na wykluczony przelew (jak przy zatwierdzeniu „mimo to"), żeby
  // odrzucenie/usunięcie dokumentu przywróciło przelew do RZiS. Nie nadpisujemy innego duplicate_of.
  for (const p of docPairs) {
    if (p.doc.duplicate_of) continue
    await prisma.costDocument.update({
      where: { id: p.doc.id },
      data: {
        duplicate_of: `mt940:${p.costId}`,
        duplicate_note: `Przelew z wyciągu bankowego (${p.date}, ${plnFmt.format(p.amount)} zł, „${p.description.slice(0, 80)}”) został oznaczony jako duplikat tego dokumentu — koszt liczy się raz.`,
      },
    })
  }

  return { created: rows.length, skipped_existing: skipped, rules_applied: rulesApplied }
}
