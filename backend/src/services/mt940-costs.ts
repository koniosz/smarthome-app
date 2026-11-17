/**
 * Wspólny serwis importu kosztów z wyciągu MT940 → ManualCost (source='mt940') + zapis sald (BankBalance).
 * Używany przez POST /api/payables/import-mt940 i POST /api/manual-costs/import-mt940.
 *
 * Koszt = transakcja wychodząca (amount < 0), nie storno. Deduplikacja po kluczu
 * `date|abs(amount)|reference` (bez referencji — początek opisu) względem istniejących
 * ManualCost source='mt940'.
 *
 * Kategoria (kolejność): klasyfikator strukturalny (services/bank-classify: ZUS, PIT-4, podatki,
 * pensje, opłaty bankowe, przelewy własne / rachunek VAT, dostawcy i przelewy zagraniczne) →
 * reguły bankowe użytkownika (BankRule: pierwsza pasująca, dłuższy wzorzec ma pierwszeństwo), które
 * NADPISUJĄ klasyfikator — poza przelewem własnym (`internal`), bo ten nigdy nie jest kosztem.
 * Trafienie reguły nadaje kategorię, jednostkę, pnl_mode (include/exclude) i bank_rule_id oraz
 * zwiększa licznik trafień. Gdy zdecydował klasyfikator, notes dostaje „rozpoznano: <etykieta> — <powód>”,
 * a auto_kind — rodzaj przelewu (zapisywany zawsze, także gdy kategorię nadała reguła).
 *
 * Naprawa starego importu: parser sprzed poprawki gubił drugie pole `:86:` mBanku, więc stare wiersze
 * mają opis = sam kod operacji („152”) i pustą referencję. Ponowne wgranie wyciągu NIE tworzy
 * duplikatów — plan importu (`createImportPlanner`) paruje transakcję z pliku ze starym wierszem
 * (ta sama data i kwota, opis = kod operacji) i uzupełnia go NA MIEJSCU. Wiersz, o którym ktoś już
 * zdecydował (reguła, „Pomiń”/„Licz w RZiS”, dokument, strażnik), dostaje tylko pola tekstowe.
 *
 * Waluta obca (wyciąg z rachunku EUR/USD…): kwota przeliczana na PLN kursem średnim NBP
 * z dnia roboczego poprzedzającego datę operacji (notes: „1 000,00 EUR × kurs NBP … z dnia …”);
 * brak kursu → kwota i waluta oryginalna, pnl_mode=exclude, do ręcznej decyzji. Klucz
 * deduplikacji liczony po kwocie ORYGINALNEJ (odtwarzanej z notatki) i dodatkowo po kwocie
 * w PLN, żeby ponowny import tego samego pliku nie tworzył duplikatów.
 *
 * Ochrona przed podwójnym liczeniem, gdy reguła bankowa ALBO klasyfikator daje pnl_mode=include:
 *  - przelew dopasowany do faktury KSeF (BankTransaction.matched_invoice_id) → exclude,
 *    notes „płatność za fakturę KSeF” (koszt liczy alokacja faktury);
 *  - przelew pasujący do już ZATWIERDZONEGO dokumentu ze skrzynki (kwota ±max(2 zł, 2 %),
 *    wspólny token nazwy, data ±60 dni) → exclude, notes „duplikat dokumentu <id> — wykluczony
 *    przez dokument <id>”, a dokument dostaje duplicate_of='mt940:<id>' (reject/usunięcie
 *    dokumentu przywraca przelew).
 */
import { v4 as uuidv4 } from 'uuid'
import { prisma, basePrisma } from '../db'
import { currentCompanyId, getDefaultCompanyId } from '../tenant'
import type { ParsedTransaction, StatementBalance } from '../utils/mt940Parser'
import { getNbpRate, type NbpRate } from './nbp-rates'
import { findMt940Duplicate } from './cost-duplicates'
import {
  classifyBankTransfer, buildAutoNote, AUTO_NOTE_PREFIX, KIND_LABELS, KIND_TARGETS,
  type BankKind, type Classification, type ClassifyContext,
} from './bank-classify'

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

/** Jedna grupa „rozpoznano w wyciągu”: rodzaj przelewu, etykieta, liczba wierszy i suma w PLN. */
export interface Mt940Recognized {
  kind: string
  label: string
  count: number
  total: number
}

export interface Mt940CostsResult {
  created: number
  skipped_existing: number
  rules_applied: number
  repaired: number                 // wiersze starego importu uzupełnione na miejscu
  recognized: Mt940Recognized[]    // rozpoznane rodzaje (utworzone + naprawione), malejąco po sumie
  to_review: number                // utworzone + naprawione, które nie weszły do RZiS i czekają na decyzję
  to_review_from: string | null    // najwcześniejszy miesiąc (YYYY-MM) wśród czekających — zakres listy „do decyzji"
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

// ── Decyzje spoza reguł i klasyfikatora (znaczniki w notes) ───────────────────

/**
 * Znaczniki w `notes` kosztu MT940 oznaczające, że pnl_mode ustawiono poza regułami bankowymi i poza
 * klasyfikatorem (po normalizacji: małe litery, bez polskich znaków). Zapisują je: cost-documents
 * (approve „mimo to"), PATCH /bank-rules/cost/:id (decyzja ręczna) i strażnik importu (płatność za
 * KSeF / duplikat dokumentu). Notatka klasyfikatora („rozpoznano: …") NIE jest znacznikiem decyzji.
 */
const DECISION_MARKERS = ['wykluczony przez dokument', 'decyzja reczna', 'duplikat dokumentu', 'platnosc za fakture ksef']

export function hasDecisionMarker(notes: string | null | undefined): boolean {
  const n = normalizeForMatch(notes)
  return !!n && DECISION_MARKERS.some(m => n.includes(m))
}

/**
 * Kategoria, którą stary import nadawał KAŻDEMU wierszowi z „gołym" kodem operacji: z opisu „152" nic
 * nie dało się rozpoznać, więc zawsze wychodziło ga/other. Inna kategoria na takim wierszu = ktoś ją
 * zmienił ręcznie (edycja w „Inne koszty").
 */
export function hasLegacyDefaultCategory(c: { cost_category?: string | null; subcategory?: string | null }): boolean {
  return (c.cost_category ?? 'ga') === 'ga' && (c.subcategory ?? 'other') === 'other'
}

/**
 * Czy o wierszu kosztu starego importu ktoś już zdecydował: reguła bankowa, pnl_mode ≠ auto, znacznik
 * decyzji w notes, sparowanie z zatwierdzonym dokumentem albo ręcznie zmieniona kategoria (inna niż
 * ga/other — patrz `hasLegacyDefaultCategory`; sprawdzana tylko, gdy wiersz niesie kategorię).
 * Naprawa starego importu uzupełnia takiemu wierszowi tylko pola tekstowe — kategoria, pnl_mode,
 * reguła i notatki zostają.
 */
export function isTouchedCost(
  c: {
    id?: string | null; pnl_mode?: string | null; bank_rule_id?: string | null; notes?: string | null
    cost_category?: string | null; subcategory?: string | null; business_unit?: string | null
  },
  excludedByDocument?: Set<string>,
): boolean {
  if (c.bank_rule_id) return true
  if ((c.pnl_mode ?? 'auto') !== 'auto') return true
  if (hasDecisionMarker(c.notes)) return true
  if ((c.cost_category != null || c.subcategory != null) && !hasLegacyDefaultCategory(c)) return true
  // stary import nadawał gołym wierszom jednostkę 'shared' — inna = ktoś przypisał koszt do jednostki ręcznie
  if (c.business_unit != null && c.business_unit !== '' && c.business_unit !== 'shared') return true
  return !!c.id && !!excludedByDocument?.has(c.id)
}

/** Notes bez notatki klasyfikatora „rozpoznano: …" (gdy kategorię przejmuje reguła użytkownika). */
export function withoutAutoNote(notes: string | null | undefined): string {
  return String(notes ?? '').split(' · ')
    .filter(part => !part.trim().startsWith(AUTO_NOTE_PREFIX))
    .join(' · ').trim()
}

/** Dopisuje do notes brakujące fragmenty (bez dublowania), limit 1000 znaków. */
export function appendNoteParts(notes: string | null | undefined, parts: Array<string | null | undefined>): string {
  const out = String(notes ?? '').trim()
  const add = parts.map(p => String(p ?? '').trim()).filter(p => p && !out.includes(p))
  return [out, ...add].filter(Boolean).join(' · ').slice(0, 1000)
}

// ── Stary import (parser sprzed poprawki) i plan importu ──────────────────────

/** „Goły" opis starego importu: mBank zapisywał sam 3-znakowy kod operacji (np. „152", „C22"). */
export const LEGACY_BARE_MAX_LEN = 3

/**
 * Czy istniejący wiersz (ManualCost / BankTransaction) został zapisany przez parser sprzed poprawki
 * dla TEJ transakcji: zapisany opis to sam kod operacji (albo dokładnie to, co zwracał stary parser —
 * `legacy_description`), jest „goły" (≤ 3 znaki) i nie ma referencji banku.
 */
export function isLegacyRow(
  existing: { description?: string | null; reference?: string | null },
  tx: { op_code?: string | null; legacy_description?: string | null },
): boolean {
  const stored = String(existing.description ?? '').trim()
  if (!stored || stored.length > LEGACY_BARE_MAX_LEN) return false
  if (!NON_REFERENCES.has(String(existing.reference ?? '').trim().toUpperCase())) return false
  const op = String(tx.op_code ?? '').trim()
  const legacy = String(tx.legacy_description ?? '').trim()
  return (op !== '' && stored.toUpperCase() === op.toUpperCase()) || (legacy !== '' && stored === legacy)
}

export type ImportAction = 'skip' | 'repair' | 'create'
/** Decyzja planu: `index` = pozycja istniejącego wiersza (skip / repair); -1 dla create. */
export interface ImportDecision { action: ImportAction; index: number }

export interface ImportPlannerConfig<E, T> {
  existingKeys: (row: E) => string[]      // klucze deduplikacji istniejącego wiersza (format nowego parsera)
  txKeys: (tx: T) => string[]             // klucze deduplikacji transakcji z pliku
  existingDate: (row: E) => string
  existingAmounts: (row: E) => number[]   // kwota(y) wiersza do porównania ze starym importem
  txDate: (tx: T) => string
  txAmount: (tx: T) => number
  isLegacy: (row: E, tx: T) => boolean
}

export interface ImportPlanner<T> { decide(tx: T): ImportDecision }

/** Tolerancja porównania kwot przy parowaniu ze starym wierszem (pół grosza + błąd zmiennoprzecinkowy). */
const LEGACY_AMOUNT_TOLERANCE = 0.005 + 1e-9

/**
 * Plan importu: paruje transakcje z pliku z istniejącymi wierszami. Każdy istniejący wiersz może być
 * „zużyty" tylko RAZ — dwa identyczne autentyczne przelewy tego samego dnia nie mogą się nawzajem
 * zdeduplikować ani naprawić tego samego wiersza. Kolejność dla transakcji:
 *   1) wiersz o NOWYM kluczu (już zaimportowany poprawionym parserem)        → skip
 *   2) wiersz starego importu z tą samą datą i kwotą (±0,005), `isLegacy`    → repair (na miejscu)
 *   3) w pozostałych przypadkach                                             → create
 * Stare wiersze o tym samym (data, kwota, kod operacji) są nierozróżnialne — k starych wierszy
 * dostaje k pierwszych transakcji z pliku, w kolejności pliku.
 */
export function createImportPlanner<E, T>(existing: E[], cfg: ImportPlannerConfig<E, T>): ImportPlanner<T> {
  const byKey = new Map<string, number[]>()
  const byDate = new Map<string, number[]>()
  existing.forEach((row, i) => {
    for (const k of cfg.existingKeys(row)) {
      const list = byKey.get(k) ?? []
      list.push(i)
      byKey.set(k, list)
    }
    const d = cfg.existingDate(row)
    const list = byDate.get(d) ?? []
    list.push(i)
    byDate.set(d, list)
  })
  const consumed = new Set<number>()

  return {
    decide(tx: T): ImportDecision {
      for (const k of cfg.txKeys(tx)) {
        for (const i of byKey.get(k) ?? []) {
          if (!consumed.has(i)) { consumed.add(i); return { action: 'skip', index: i } }
        }
      }
      const amount = cfg.txAmount(tx)
      for (const i of byDate.get(cfg.txDate(tx)) ?? []) {
        if (consumed.has(i)) continue
        const row = existing[i]
        if (!cfg.existingAmounts(row).some(a => Math.abs(a - amount) <= LEGACY_AMOUNT_TOLERANCE)) continue
        if (!cfg.isLegacy(row, tx)) continue
        consumed.add(i)
        return { action: 'repair', index: i }
      }
      return { action: 'create', index: -1 }
    },
  }
}

/** Plan dla całej listy transakcji (w kolejności pliku). */
export function planImport<E, T>(txs: T[], existing: E[], cfg: ImportPlannerConfig<E, T>): ImportDecision[] {
  const planner = createImportPlanner(existing, cfg)
  return txs.map(tx => planner.decide(tx))
}

/** Transakcja z pliku w postaci, w jakiej trafia do ManualCost (kwota bezwzględna, opis złożony). */
export interface CostPlanTx {
  date: string
  amount: number                       // |kwota| w walucie wyciągu (albo po przeliczeniu na PLN — drugie podejście)
  reference?: string | null
  description?: string | null          // `kontrahent · tytuł`
  op_code?: string | null
  legacy_description?: string | null
}

export interface CostPlanRow {
  date: string
  amount: number
  reference?: string | null
  description: string
  notes?: string | null
}

/**
 * Konfiguracja planu dla ManualCost source='mt940'. Transakcja ma dwa klucze: po referencji oraz po
 * początku opisu — ten drugi trafia w wiersz zapisany BEZ referencji (stary parser brał referencję tylko
 * po „//"), żeby wyciąg banku, który parser czytał poprawnie, nie zdublował się po poprawce.
 * Kwota starego wiersza: zapisana oraz — dla kosztu przeliczonego z waluty — oryginalna z notatki kursowej.
 */
export const COST_PLAN_CONFIG: ImportPlannerConfig<CostPlanRow, CostPlanTx> = {
  existingKeys: row => existingCostKeys(row),
  txKeys: tx => {
    const keys = [mt940CostKey(tx)]
    const noRef = mt940CostKey({ ...tx, reference: '' })
    if (!keys.includes(noRef)) keys.push(noRef)
    return keys
  },
  existingDate: row => row.date,
  existingAmounts: row => {
    const amounts = [Math.abs(Number(row.amount) || 0)]
    const fx = parseFxNote(row.notes)
    if (fx) amounts.push(fx.amount)
    return amounts
  },
  txDate: tx => tx.date,
  txAmount: tx => Math.abs(Number(tx.amount) || 0),
  isLegacy: (row, tx) => isLegacyRow(row, tx),
}

export function createCostImportPlanner<E extends CostPlanRow>(existing: E[]): ImportPlanner<CostPlanTx> {
  return createImportPlanner<CostPlanRow, CostPlanTx>(existing, COST_PLAN_CONFIG)
}

export function planMt940CostImport(txs: CostPlanTx[], existing: CostPlanRow[]): ImportDecision[] {
  return planImport(txs, existing, COST_PLAN_CONFIG)
}

// ── Decyzja o koszcie: klasyfikator → reguły użytkownika → strażnicy ──────────

/**
 * Rodzaje, których reguła bankowa użytkownika NIE może nadpisać, bo to z definicji nie koszt:
 * przelew własny / rachunek VAT oraz zapłata VAT do urzędu (VAT tylko przepływa przez konto). Szeroka
 * reguła („URZĄD SKARBOWY", „PRZELEW") wciągnęłaby je inaczej do RZiS jako koszt.
 */
export const RULE_IMMUNE_KINDS: ReadonlySet<string> = new Set(['internal', 'tax_vat'])
export function isRuleImmuneKind(kind: string | null | undefined): boolean {
  return RULE_IMMUNE_KINDS.has(String(kind ?? ''))
}

export interface Mt940CostDecision<D extends ApprovedDocLite = ApprovedDocLite> {
  cost_category: string
  subcategory: string
  business_unit: string
  pnl_mode: string                   // auto | include | exclude
  bank_rule_id: string | null
  rule: BankRuleLike | null          // reguła użytkownika, która zdecydowała (null = klasyfikator)
  auto_kind: string | null           // rodzaj z klasyfikatora ('unknown' → null) — także gdy kategorię nadała reguła
  period: string | null              // miesiąc memoriałowy z tytułu (null → RZiS wyznacza sam)
  reasons: string[]                  // notatki strażników: brak kursu NBP / płatność za KSeF / duplikat dokumentu
  auto_note: string                  // „rozpoznano: …" gdy zdecydował klasyfikator (nie reguła) i rodzaj ≠ unknown
  ksef_payment: boolean              // strażnik: przelew opłaca fakturę KSeF
  document: D | null                 // strażnik: zatwierdzony dokument, który wyklucza ten przelew (do sparowania)
}

/**
 * Jedna decyzja o koszcie z wyciągu (czysta funkcja — strażnicy podawani jako funkcje, wołane leniwie):
 *   1) start: wynik klasyfikatora (kategoria, podkategoria, pnl_mode),
 *   2) reguła bankowa użytkownika NADPISUJE klasyfikator — poza `internal` (przelew własny / rachunek VAT)
 *      i `tax_vat` (zapłata VAT): to nigdy nie jest koszt, żadna reguła nie może ich wciągnąć do RZiS,
 *   3) brak kursu NBP → exclude (kwota nie jest w PLN),
 *   4) gdy końcowy pnl_mode = include — NIEZALEŻNIE od tego, czy dała go reguła, czy klasyfikator:
 *      płatność za fakturę KSeF → exclude; duplikat zatwierdzonego dokumentu → exclude + parowanie.
 */
export function decideMt940Cost<D extends ApprovedDocLite = ApprovedDocLite>(input: {
  classification: Classification
  counterparty?: string | null
  description?: string | null        // tytuł przelewu (bez kontrahenta)
  rules: BankRuleLike[]
  fxMissing?: boolean
  isKsefPayment?: () => boolean
  findDocument?: () => D | null
}): Mt940CostDecision<D> {
  const c = input.classification
  const base: RuleTarget = {
    counterparty: input.counterparty ?? '', description: input.description ?? '',
    cost_category: c.cost_category, subcategory: c.subcategory, business_unit: c.business_unit,
    pnl_mode: c.pnl_mode, bank_rule_id: null,
  }
  let cost: RuleTarget = base
  let rule: BankRuleLike | null = null
  if (!isRuleImmuneKind(c.kind)) {
    const applied = applyBankRules(base, input.rules)
    cost = applied.cost
    rule = applied.rule
  }

  const reasons: string[] = []
  let pnl_mode = cost.pnl_mode ?? 'auto'
  let ksef_payment = false
  let document: D | null = null
  if (input.fxMissing) {
    pnl_mode = 'exclude'
    reasons.push(NOTE_NO_NBP_RATE)
  } else if (pnl_mode === 'include') {
    if (input.isKsefPayment?.()) {
      // Ten przelew opłaca fakturę z KSeF — koszt liczy alokacja faktury (netto), nie przelew (brutto)
      pnl_mode = 'exclude'
      ksef_payment = true
      reasons.push(NOTE_KSEF_PAYMENT)
    } else {
      const doc = input.findDocument?.() ?? null
      if (doc) {
        // Koszt jest już w RZiS z zatwierdzonego dokumentu (faktura przyszła przed wyciągiem)
        pnl_mode = 'exclude'
        document = doc
        reasons.push(noteDocumentDuplicate(doc.id))
      }
    }
  }

  return {
    cost_category: cost.cost_category ?? 'ga',
    subcategory: cost.subcategory ?? 'other',
    business_unit: cost.business_unit ?? 'shared',
    pnl_mode,
    bank_rule_id: cost.bank_rule_id ?? null,
    rule,
    auto_kind: c.kind === 'unknown' ? null : c.kind,
    period: c.period ?? null,
    reasons,
    auto_note: rule ? '' : buildAutoNote(c),
    ksef_payment,
    document,
  }
}

/**
 * Klasyfikacja ZAPISANEGO kosztu MT940 (bez pliku): opis `kontrahent · tytuł` jest rozbijany, kwota
 * (zapisana dodatnio) wraca jako obciążenie, waluta wyciągu — z notatki kursowej, a gdy jej brak — z wiersza.
 * Nazwa operacji (~00) nie jest przechowywana, więc decyduje kod operacji, rachunek i tytuł.
 */
export function classifyStoredCost(
  c: { date: string; amount: number; description: string; op_code?: string | null; counterparty_iban?: string | null; currency?: string | null; notes?: string | null },
  ctx: ClassifyContext = {},
): Classification {
  const { counterparty, description } = splitStoredDescription(c.description)
  const fx = parseFxNote(c.notes)
  return classifyBankTransfer({
    date: c.date,
    amount: -Math.abs(Number(c.amount) || 0),
    description,
    counterparty,
    counterparty_iban: c.counterparty_iban ?? '',
    op_code: c.op_code ?? '',
    op_label: '',
    currency: fx?.currency ?? c.currency ?? 'PLN',
  }, ctx)
}

/**
 * Czy pnl_mode wiersza pochodzi z KLASYFIKATORA: jest rodzaj (auto_kind), nie ma reguły ani znacznika
 * decyzji, a pnl_mode jest dokładnie taki, jaki klasyfikator nadaje temu rodzajowi. Taki wiersz NIE jest
 * „decyzją spoza reguł" — reguła użytkownika może go nadpisać (poza rodzajem `internal`).
 */
export function isClassifierDecision(
  c: { pnl_mode?: string | null; bank_rule_id?: string | null; notes?: string | null; auto_kind?: string | null },
): boolean {
  if (c.bank_rule_id) return false
  const kind = String(c.auto_kind ?? '')
  if (!kind || !Object.prototype.hasOwnProperty.call(KIND_TARGETS, kind)) return false
  if (hasDecisionMarker(c.notes)) return false
  return (c.pnl_mode ?? 'auto') === KIND_TARGETS[kind as BankKind].pnl_mode
}

/** Podsumowanie „rozpoznano w wyciągu": per rodzaj (bez nierozpoznanych), suma tylko z kwot w PLN, malejąco po sumie. */
export function summarizeRecognized(items: Array<{ kind: string | null | undefined; amount: number; currency?: string | null }>): Mt940Recognized[] {
  const by = new Map<string, { count: number; grosze: number }>()
  for (const it of items) {
    const kind = String(it.kind ?? '')
    if (!kind || kind === 'unknown') continue
    const cur = by.get(kind) ?? { count: 0, grosze: 0 }
    cur.count += 1
    const currency = String(it.currency ?? 'PLN').trim().toUpperCase() || 'PLN'
    if (currency === 'PLN') cur.grosze += Math.round(Math.abs(Number(it.amount) || 0) * 100)
    by.set(kind, cur)
  }
  return [...by.entries()]
    .map(([kind, v]) => ({
      kind,
      label: Object.prototype.hasOwnProperty.call(KIND_LABELS, kind) ? KIND_LABELS[kind as BankKind] : kind,
      count: v.count,
      total: v.grosze / 100,
    }))
    .sort((a, b) => b.total - a.total || b.count - a.count || a.kind.localeCompare(b.kind))
}

/**
 * Opis zastępczy operacji BEZ tytułu (opłaty bankowe, natychmiastowe transakcje walutowe A60/A61 — parser
 * zwraca dla nich pusty tytuł): nazwa operacji z wyciągu (~00) → etykieta klasyfikatora → „Operacja bankowa
 * <kod>". Zapisany opis NIGDY nie jest pusty ani „goły" (≤ 3 znaki) — taki wyglądałby jak wiersz starego importu.
 */
export function operationFallbackDescription(
  tx: { op_label?: string | null; op_code?: string | null },
  classification?: { kind: string; label: string } | null,
): string {
  const label = String(tx.op_label ?? '').replace(/\s+/g, ' ').trim()
  if (label.length > LEGACY_BARE_MAX_LEN) return label.slice(0, 500)
  if (classification && classification.kind !== 'unknown' && classification.label.trim().length > LEGACY_BARE_MAX_LEN) {
    return classification.label.trim()
  }
  const code = String(tx.op_code ?? '').trim()
  return code ? `Operacja bankowa ${code}` : 'Operacja bankowa'
}

/** Opis kosztu do zapisu: `kontrahent · tytuł`, a dla operacji bez tytułu i kontrahenta — opis zastępczy (nazwa operacji). */
export function costDescription(
  tx: { counterparty?: string | null; description?: string | null; op_label?: string | null; op_code?: string | null },
  classification?: { kind: string; label: string } | null,
): string {
  return composeDescription(tx.counterparty, tx.description) || operationFallbackDescription(tx, classification)
}

/**
 * Opis transakcji bankowej do zapisu (BankTransaction.description): tytuł przelewu, a dla operacji bez tytułu —
 * opis zastępczy (nazwa operacji). Kontrahent ma w tej tabeli własną kolumnę, więc do opisu nie trafia.
 * TEN SAM opis wchodzi do klucza deduplikacji — dlatego liczy go jedna funkcja dla planu importu i dla zapisu.
 */
export function bankTxDescription(
  tx: { description?: string | null; op_label?: string | null; op_code?: string | null },
  classification?: { kind: string; label: string } | null,
): string {
  const title = String(tx.description ?? '')
  return title.trim() ? title : operationFallbackDescription(tx, classification)
}

// ── Kontekst klasyfikatora i strażników (odczyt z bazy) ───────────────────────

/**
 * Własne rachunki (BankBalance.account — zakres firmy nakłada rozszerzenie Prisma — plus rachunki
 * wyciągów z bieżącego pliku) i nazwiska pracowników (także byłych: historia wypłat).
 */
export async function loadClassifyContext(extraAccounts: Array<string | null | undefined> = []): Promise<ClassifyContext> {
  const [balances, employees] = await Promise.all([
    prisma.bankBalance.findMany({ distinct: ['account'], select: { account: true } }),
    prisma.employee.findMany({ select: { name: true } }),
  ])
  const accounts = new Set<string>()
  for (const a of [...balances.map(b => b.account), ...extraAccounts]) {
    const v = String(a ?? '').trim()
    if (v) accounts.add(v)
  }
  const names = new Set<string>()
  for (const e of employees) {
    const v = String(e.name ?? '').trim()
    if (v) names.add(v)
  }
  return { ownAccounts: [...accounts], employeeNames: [...names] }
}

export type GuardDoc = ApprovedDocLite & { duplicate_of: string }

export interface IncludeGuardContext {
  ksefIndex: Map<string, MatchedTxLite[]>   // transakcje bankowe dopasowane do faktur KSeF (po dacie)
  docs: GuardDoc[]                          // zatwierdzone dokumenty, które jeszcze nie wykluczyły żadnego przelewu
  usedDocs: Set<string>                     // dokumenty zużyte w bieżącym przebiegu (dokument wyklucza JEDEN przelew)
}

/**
 * Dane dla strażników podwójnego liczenia w zakresie dat `from..to`: płatności za faktury KSeF
 * (BankTransaction z matched_invoice_id) oraz — z `withDocs` — zatwierdzone dokumenty ze skrzynki (±60 dni).
 */
export async function loadIncludeGuardContext(from: string, to: string, opts: { withDocs?: boolean } = {}): Promise<IncludeGuardContext> {
  const [matchedTx, docs] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { source: 'mt940', matched_invoice_id: { not: null }, transaction_date: { gte: from, lte: to } },
      select: { transaction_date: true, amount: true, reference: true },
    }),
    opts.withDocs
      ? prisma.costDocument.findMany({
          where: { status: 'approved', gross_pln: { gt: 0 }, doc_date: { gte: shiftDate(from, -60), lte: shiftDate(to, 60) } },
          select: { id: true, seller_name: true, seller_nip: true, doc_number: true, doc_date: true, gross_pln: true, duplicate_of: true },
        })
      : Promise.resolve([] as GuardDoc[]),
  ])
  let candidateDocs: GuardDoc[] = []
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
  return { ksefIndex: buildMatchedIndex(matchedTx), docs: candidateDocs, usedDocs: new Set<string>() }
}

/** Strażnik „duplikat dokumentu" z pamięcią: dokument trafiony raz nie wykluczy kolejnego przelewu. */
export function takeGuardDocument(
  cost: { date: string; amount: number; description: string; reference?: string | null },
  ctx: IncludeGuardContext,
): GuardDoc | null {
  const doc = matchTransferToDocument(cost, ctx.docs.filter(d => !ctx.usedDocs.has(d.id)))
  if (doc) ctx.usedDocs.add(doc.id)
  return doc
}

export interface DocumentPair { doc: GuardDoc; costId: string; date: string; amount: number; description: string }

/**
 * Dokument dostaje wskazanie na wykluczony przelew (jak przy zatwierdzeniu „mimo to"), żeby
 * odrzucenie/usunięcie dokumentu przywróciło przelew do RZiS. Nie nadpisujemy innego duplicate_of.
 */
export async function saveDocumentPairs(pairs: DocumentPair[]): Promise<void> {
  for (const p of pairs) {
    if (p.doc.duplicate_of) continue
    await prisma.costDocument.update({
      where: { id: p.doc.id },
      data: {
        duplicate_of: `mt940:${p.costId}`,
        duplicate_note: `Przelew z wyciągu bankowego (${p.date}, ${plnFmt.format(p.amount)} zł, „${p.description.slice(0, 80)}”) został oznaczony jako duplikat tego dokumentu — koszt liczy się raz.`,
      },
    })
  }
}

/** Id przelewów MT940 wykluczonych z RZiS przez zatwierdzony dokument ze skrzynki (koszt liczy dokument). */
export async function loadExcludedByDocument(): Promise<Set<string>> {
  const docs = await prisma.costDocument.findMany({
    where: { status: 'approved', duplicate_of: { startsWith: 'mt940:' } },
    select: { duplicate_of: true },
  })
  return new Set(docs.map(d => String(d.duplicate_of).slice('mt940:'.length)).filter(Boolean))
}

/** Wykonuje zadania partiami (bez transakcji — pojedyncze krótkie zapytania, bezpieczne dla Neon). */
export async function runInBatches<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn))
  }
}

// ── Strażnik: wyciąg rachunku, który należy do INNEJ firmy ────────────────────

/**
 * Rachunek z wyciągu, który ma już salda zapisane w INNEJ firmie niż aktywna (czysta funkcja).
 * `company_id = null` w starych wierszach oznacza firmę domyślną. Rachunki porównywane po znakach
 * alfanumerycznych (jak normalizeAccount w parserze).
 */
export function foreignAccountOwner(
  accounts: Array<string | null | undefined>,
  balances: Array<{ account: string; company_id: string | null }>,
  activeCompanyId: string | null | undefined,
  defaultCompanyId: string | null | undefined,
): { account: string; company_id: string | null } | null {
  const norm = (a: string | null | undefined) => String(a ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const wanted = new Set(accounts.map(norm).filter(Boolean))
  if (!wanted.size) return null
  const active = activeCompanyId ?? defaultCompanyId ?? null
  // właściciele każdego rachunku z pliku; rachunek, który aktywna firma już prowadzi, NIE blokuje — nawet jeśli
  // jego salda trafiły kiedyś także do innej firmy (inaczej żadna z firm nie mogłaby wgrać wyciągu ponownie)
  const owners = new Map<string, Array<string | null>>()
  for (const b of balances) {
    const acc = norm(b.account)
    if (!wanted.has(acc)) continue
    const list = owners.get(acc) ?? []
    list.push(b.company_id ?? defaultCompanyId ?? null)
    owners.set(acc, list)
  }
  for (const [account, list] of owners) {
    if (list.includes(active)) continue
    return { account, company_id: list[0] }
  }
  return null
}

/**
 * Czy któryś rachunek z wgrywanego wyciągu jest już prowadzony w innej firmie (ma tam zapisane salda)?
 * Zwraca gotowy komunikat dla użytkownika albo null. Wyciąg wgrany w niewłaściwej firmie dopisałby jej
 * cudze przelewy i koszty do RZiS, a zapis sald (klucz unikalny rachunek + data + numer wyciągu jest
 * wspólny dla wszystkich firm) blokowałby potem import we właściwej firmie — dlatego odmawiamy z góry.
 * Zapytanie celowo BEZ zakresu firmy (basePrisma): pytamy właśnie o cudze wiersze.
 */
export async function accountInOtherCompanyMessage(accounts: Array<string | null | undefined>): Promise<string | null> {
  const list = [...new Set(accounts.map(a => String(a ?? '').trim()).filter(Boolean))]
  if (!list.length) return null
  const rows = await basePrisma.bankBalance.findMany({
    where: { account: { in: list } },
    select: { account: true, company_id: true },
    distinct: ['account', 'company_id'],
  })
  const hit = foreignAccountOwner(list, rows, currentCompanyId(), getDefaultCompanyId())
  if (!hit) return null
  const company = hit.company_id
    ? await basePrisma.company.findUnique({ where: { id: hit.company_id }, select: { name: true } })
    : null
  const tail = hit.account.slice(-4)
  return `Rachunek …${tail} z tego wyciągu jest już prowadzony w firmie „${company?.name ?? 'innej'}”. `
    + 'Przełącz się na tę firmę i wgraj wyciąg tam — w bieżącej firmie nic nie zostało zapisane.'
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
 * Zapisuje koszty z wyciągu jako ManualCost (source='mt940'): tworzy nowe wiersze, pomija już
 * zaimportowane, a wiersze starego importu (opis = sam kod operacji) uzupełnia NA MIEJSCU.
 * Kwota zapisywana dodatnio i w PLN (waluta obca → kurs NBP). Kategorię i pnl_mode nadaje klasyfikator,
 * reguła bankowa użytkownika może je nadpisać (poza przelewem własnym); końcowe include jest cofane do
 * exclude dla płatności za fakturę KSeF i dla przelewu opłacającego już zatwierdzony dokument ze skrzynki
 * (patrz nagłówek pliku). period = miesiąc z tytułu (ZUS / PIT-4 / pensja) albo null — RZiS wyznacza go sam.
 *
 * `opts.context` — gotowy kontekst klasyfikatora (rachunki własne, pracownicy); bez niego jest wczytywany
 * z bazy i uzupełniany o rachunki wyciągów z pliku (`opts.accounts` + `account` każdej transakcji).
 */
export async function upsertMt940Costs(
  transactions: ParsedTransaction[],
  opts: { createdBy?: string; context?: ClassifyContext; accounts?: Array<string | null | undefined> } = {},
): Promise<Mt940CostsResult> {
  const outgoing = transactions.filter(t => t.amount < 0 && !t.is_reversal)
  if (!outgoing.length) return { created: 0, skipped_existing: 0, rules_applied: 0, repaired: 0, recognized: [], to_review: 0, to_review_from: null }

  const [ruleRows, context] = await Promise.all([
    prisma.bankRule.findMany(),
    opts.context
      ? Promise.resolve(opts.context)
      : loadClassifyContext([...transactions.map(t => t.account), ...(opts.accounts ?? [])]),
  ])
  const rules = sortRules(ruleRows)

  // Transakcje z pliku w postaci do zapisu + klasyfikacja (kwota ZE ZNAKIEM i waluta wyciągu sprzed przeliczenia)
  const prepared = outgoing.map(tx => {
    const counterparty = String(tx.counterparty ?? '').replace(/\s+/g, ' ').trim()
    const title = String(tx.description ?? '').replace(/\s+/g, ' ').trim()
    const currencyOrig = String(tx.currency ?? '').trim().toUpperCase() || 'PLN'
    const cls = classifyBankTransfer({
      date: tx.date, amount: tx.amount, description: title, counterparty,
      counterparty_iban: tx.counterparty_iban, op_code: tx.op_code, op_label: tx.op_label, currency: currencyOrig,
    }, context)
    return {
      tx, counterparty, title, cls, currencyOrig,
      description: costDescription({ counterparty, description: title, op_label: tx.op_label, op_code: tx.op_code }, cls),
      reference: String(tx.reference ?? '').trim().slice(0, 100),
      original: r2(Math.abs(tx.amount)),
      // '' = bank bez kodów operacji; NULL zostaje tylko w wierszach starego importu (po tym poznaje je „Kondycja firmy")
      opCode: String(tx.op_code ?? '').trim().toUpperCase(),
      iban: String(tx.counterparty_iban ?? '').replace(/\s+/g, '').toUpperCase() || null,
    }
  })

  // Jednorazowe wczytanie istniejących kosztów MT940 z dat występujących w pliku.
  // Każdy istniejący wiersz może „zużyć" tylko jedną transakcję z pliku: dwa identyczne
  // autentyczne przelewy tego samego dnia nie mogą się nawzajem deduplikować.
  const dates = [...new Set(outgoing.map(t => t.date))].sort()
  const existing = await prisma.manualCost.findMany({
    where: { source: 'mt940', date: { in: dates } },
    select: {
      id: true, date: true, amount: true, currency: true, reference: true, description: true, notes: true,
      pnl_mode: true, bank_rule_id: true, period: true,
      // kategoria i jednostka MUSZĄ być wczytane: po nich isTouchedCost poznaje wiersz zmieniony ręcznie
      cost_category: true, subcategory: true, business_unit: true,
    },
  })
  const planner = createCostImportPlanner(existing)

  // Strażnicy podwójnego liczenia: płatności za faktury KSeF (zawsze — potrzebne też do licznika „do decyzji")
  // i zatwierdzone dokumenty ze skrzynki (tylko gdy reguła albo klasyfikator może dać pnl_mode=include).
  const needDocs = rules.some(r => r.pnl_mode !== 'exclude') || prepared.some(p => p.cls.pnl_mode === 'include')
  const hasLegacyShape = existing.some(e =>
    e.description.trim().length <= LEGACY_BARE_MAX_LEN && NON_REFERENCES.has(e.reference.trim().toUpperCase()))
  const [guards, excludedByDocument] = await Promise.all([
    loadIncludeGuardContext(dates[0], dates[dates.length - 1], { withDocs: needDocs }),
    hasLegacyShape ? loadExcludedByDocument() : Promise.resolve(new Set<string>()),
  ])

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
    cost_category: string; subcategory: string; business_unit: string; period: string | null
    notes: string; reference: string; source: string; pnl_mode: string
    bank_rule_id: string | null; auto_kind: string | null; op_code: string | null; counterparty_iban: string | null
    created_at: string; created_by: string
  }> = []
  const updates: Array<{ id: string; data: Record<string, string | null> }> = []
  // dokument → koszt MT940, który wykluczył (po zapisie: duplicate_of='mt940:<id>')
  const docPairs: DocumentPair[] = []
  const hitsByRule = new Map<string, number>()
  const recognizedItems: Array<{ kind: string | null; amount: number; currency: string }> = []
  // wiersze, o których nikt jeszcze nie zdecydował — kandydaci do licznika „do decyzji"
  const reviewCandidates: Array<{ source: string; subcategory: string; pnl_mode: string; currency: string; date: string }> = []
  let skipped = 0
  let rulesApplied = 0
  let repaired = 0

  for (const p of prepared) {
    const { tx, cls, description, reference, original, currencyOrig } = p
    const planTx: CostPlanTx = {
      date: tx.date, amount: original, reference, description,
      op_code: tx.op_code, legacy_description: tx.legacy_description,
    }

    // Deduplikacja / naprawa po kwocie oryginalnej (klucz z pliku = klucz z notatki kursowej)
    let decision = planner.decide(planTx)
    if (decision.action === 'skip') { skipped++; continue }

    // Waluta obca → PLN kursem NBP; brak kursu → kwota oryginalna, exclude, do ręcznej decyzji
    let amount = original
    let currency = 'PLN'
    let fxNote = ''
    let fxMissing = false
    if (decision.action === 'create' && currencyOrig !== 'PLN') {
      const { rate, date: rateDate } = await rateFor(currencyOrig, tx.date)
      if (rate > 0) {
        amount = r2(original * rate)
        fxNote = formatFxNote(original, currencyOrig, rate, rateDate)
        // Wiersz zapisany wcześniej w PLN, którego notatka kursowa została nadpisana — klucz po kwocie PLN
        const second = planner.decide({ ...planTx, amount })
        if (second.action === 'skip') { skipped++; continue }
        if (second.action === 'repair') decision = second
      } else {
        currency = currencyOrig
        fxMissing = true
      }
    }

    const textFields = { description, reference, op_code: p.opCode, counterparty_iban: p.iban, auto_kind: cls.kind === 'unknown' ? null : cls.kind }

    if (decision.action === 'repair') {
      // ── Wiersz starego importu: uzupełnij na miejscu (kwota i waluta zostają takie, jak zapisano) ──
      const row = existing[decision.index]
      repaired++
      recognizedItems.push({ kind: cls.kind, amount: row.amount, currency: row.currency })
      // period starego importu to zawsze miesiąc zapłaty (wpisany automatycznie) — zastępujemy go okresem
      // z tytułu; inny period ktoś wpisał ręcznie i zostaje
      const period = row.period && row.period !== row.date.slice(0, 7) ? row.period : (cls.period ?? null)
      const foreignRow = (String(row.currency ?? '').trim().toUpperCase() || 'PLN') !== 'PLN'
      if (foreignRow || isTouchedCost(row, excludedByDocument)) {
        // O tym wierszu ktoś już zdecydował (reguła / decyzja ręczna / dokument) — tylko pola tekstowe.
        // Wyjątek: przelew własny / rachunek VAT / zapłata VAT. Na „gołym" wierszu dało się zgadywać tylko po
        // kwocie, a nóżka z rachunku VAT ma DOKŁADNIE kwotę prawdziwego przelewu do ZUS / US — oznaczona
        // ręcznie jako ZUS liczyłaby się drugi raz. To z definicji nie koszt, więc klasyfikator wygrywa.
        if (!foreignRow && isRuleImmuneKind(cls.kind)) {
          updates.push({
            id: row.id,
            data: {
              ...textFields, period: null,
              cost_category: cls.cost_category, subcategory: cls.subcategory, business_unit: cls.business_unit,
              pnl_mode: cls.pnl_mode, bank_rule_id: null,
              notes: appendNoteParts(row.notes, [buildAutoNote(cls)]),
            },
          })
        } else {
          updates.push({ id: row.id, data: { ...textFields, period } })
        }
        continue
      }
      const dec = decideMt940Cost<GuardDoc>({
        classification: cls, counterparty: p.counterparty, description: p.title, rules,
        isKsefPayment: () => isKsefPayment({ date: tx.date, amount: original, reference }, guards.ksefIndex),
        findDocument: () => takeGuardDocument({ date: tx.date, amount: row.amount, description, reference }, guards),
      })
      if (dec.rule) {
        rulesApplied++
        hitsByRule.set(dec.rule.id, (hitsByRule.get(dec.rule.id) ?? 0) + 1)
      }
      if (dec.document) docPairs.push({ doc: dec.document, costId: row.id, date: tx.date, amount: row.amount, description })
      updates.push({
        id: row.id,
        data: {
          ...textFields, period,
          cost_category: dec.cost_category, subcategory: dec.subcategory, business_unit: dec.business_unit,
          pnl_mode: dec.pnl_mode, bank_rule_id: dec.bank_rule_id,
          notes: appendNoteParts(row.notes, [...dec.reasons, dec.auto_note]),
        },
      })
      if (!dec.rule && cls.kind !== 'internal' && !dec.ksef_payment && !dec.document
        && !isKsefPayment({ date: tx.date, amount: original, reference }, guards.ksefIndex)) {
        reviewCandidates.push({ source: 'mt940', subcategory: dec.subcategory, pnl_mode: dec.pnl_mode, currency: row.currency, date: tx.date })
      }
      continue
    }

    // ── Nowy wiersz ──
    const id = uuidv4()
    const dec = decideMt940Cost<GuardDoc>({
      classification: cls, counterparty: p.counterparty, description: p.title, rules, fxMissing,
      isKsefPayment: () => isKsefPayment({ date: tx.date, amount: original, reference }, guards.ksefIndex),
      findDocument: () => takeGuardDocument({ date: tx.date, amount, description, reference }, guards),
    })
    if (dec.rule) {
      rulesApplied++
      hitsByRule.set(dec.rule.id, (hitsByRule.get(dec.rule.id) ?? 0) + 1)
    }
    if (dec.document) docPairs.push({ doc: dec.document, costId: id, date: tx.date, amount, description })
    recognizedItems.push({ kind: cls.kind, amount, currency })
    if (!dec.rule && cls.kind !== 'internal' && !dec.ksef_payment && !dec.document
      && !isKsefPayment({ date: tx.date, amount: original, reference }, guards.ksefIndex)) {
      reviewCandidates.push({ source: 'mt940', subcategory: dec.subcategory, pnl_mode: dec.pnl_mode, currency, date: tx.date })
    }

    rows.push({
      id,
      date: tx.date,
      description,
      amount,
      currency,
      cost_category: dec.cost_category,
      subcategory: dec.subcategory,
      business_unit: dec.business_unit,
      period: dec.period,
      notes: [fxNote, ...dec.reasons, dec.auto_note].filter(Boolean).join(' · ').slice(0, 1000),
      reference,
      source: 'mt940',
      pnl_mode: dec.pnl_mode,
      bank_rule_id: dec.bank_rule_id,
      auto_kind: textFields.auto_kind,
      op_code: p.opCode,
      counterparty_iban: p.iban,
      created_at: now,
      created_by: opts.createdBy ?? '',
    })
  }

  if (rows.length) await prisma.manualCost.createMany({ data: rows })
  // Naprawa starych wierszy: pojedyncze krótkie UPDATE-y po 10 naraz (bez transakcji — Neon)
  await runInBatches(updates, 10, u => prisma.manualCost.update({ where: { id: u.id }, data: u.data }))
  for (const [ruleId, n] of hitsByRule) {
    await prisma.bankRule.update({ where: { id: ruleId }, data: { hits: { increment: n } } })
  }
  await saveDocumentPairs(docPairs)

  // „Do decyzji" = to, co pokaże lista nierozpoznanych przelewów: nie w RZiS, bez reguły, nie przelew własny,
  // nie płatność za KSeF, nie duplikat dokumentu. Import leniwy — routes/finance ładuje routes/payables.
  const { includeManualCostInPnl } = await import('../routes/finance')
  const waiting = reviewCandidates.filter(c => !includeManualCostInPnl(c))
  const to_review = waiting.length
  const to_review_from = waiting.length ? waiting.map(c => c.date.slice(0, 7)).sort()[0] : null

  return {
    created: rows.length,
    skipped_existing: skipped,
    rules_applied: rulesApplied,
    repaired,
    recognized: summarizeRecognized(recognizedItems),
    to_review,
    to_review_from,
  }
}
