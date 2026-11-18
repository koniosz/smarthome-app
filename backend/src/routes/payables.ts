/**
 * Panel Płatności (zobowiązania) — faktury kosztowe z KSeF do opłacenia + import MT940.
 * Dostęp: admin lub użytkownik z flagą can_view_payments (księgowy).
 *
 * Przepływ MT940: upload pliku → parsowanie → plan importu (pomiń już zaimportowane / uzupełnij
 * na miejscu wiersze starego importu / utwórz nowe) → auto-dopasowanie obciążeń do nieopłaconych
 * faktur (pewność ≥ AUTO_MATCH_THRESHOLD ⇒ faktura oznaczona jako opłacona). Niedopasowane obciążenia
 * lądują na liście „do sprawdzenia" z kandydatami do ręcznego przypisania.
 *
 * Higiena listy „do sprawdzenia": przelew, który z natury NIE może być zapłatą za fakturę zakupową
 * (ZUS, urząd skarbowy, wynagrodzenie, opłata bankowa, przelew własny / rachunek VAT — klasyfikator
 * services/bank-classify, `not_invoice_payment`), jest od razu odrzucany i nigdy nie jest
 * auto-dopasowywany do faktury.
 */
import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { parseMT940Statements } from '../utils/mt940Parser'
import {
  saveBankBalances, upsertMt940Costs, loadClassifyContext, createImportPlanner, planImport, isLegacyRow, bankTxDescription,
  accountInOtherCompanyMessage,
  type ImportPlannerConfig, type ImportPlanner, type ImportDecision, type Mt940Recognized,
} from '../services/mt940-costs'
import { classifyBankTransfer } from '../services/bank-classify'
import { decideAutoMatch, payableCandidates, titleNamesInvoice, PREPAYMENT_GRACE_DAYS } from '../services/payment-match'
import db, { prisma } from '../db'
import { assignInvoiceToProject, AssignError } from './ksef'
import { getInvoiceXml, getInvoiceDocument, sendKsefXmlError, NO_KSEF_NUMBER_MSG } from '../services/ksef-xml-store'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// Próg PODPOWIEDZI na liście „do sprawdzenia". O automatycznym oznaczeniu faktury jako opłaconej decyduje
// wyłącznie ścisła reguła z services/payment-match (decideAutoMatch) — nie suma punktów.
const CANDIDATE_THRESHOLD = 0.25

function today() { return new Date().toISOString().slice(0, 10) }
function now() { return new Date().toISOString() }

// ── Dostęp: admin lub can_view_payments (świeży odczyt z DB — nadanie działa bez re-loginu) ──
// Eksportowane: index.ts gate'uje nim też /api/bank i PATCH /api/ksef/invoices/:id/payment.
export async function requirePayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const u: any = await db.users.find((req as any).user?.id)
    if (!u || (u.role !== 'admin' && !u.can_view_payments)) {
      res.status(403).json({ error: 'Brak dostępu do płatności' }); return
    }
    next()
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
}
router.use(requirePayments)

// ── Pomocnicze ────────────────────────────────────────────────────────────────
// „Do zapłaty" = faktura kosztowa bez statusu paid (null/unpaid/partial)
function isUnpaid(inv: any): boolean {
  return inv.payment_status !== 'paid'
}
function isIncoming(inv: any): boolean {
  return (inv.invoice_direction ?? 'incoming') === 'incoming'
}
function isOverdue(inv: any): boolean {
  return isUnpaid(inv) && !!inv.payment_due_date && inv.payment_due_date < today()
}

type InvoiceExtra = {
  projectId?: string | null; projectName?: string | null; allocationsCount?: number; allocatedAmount?: number
  internalAllocation?: boolean; autoClassified?: boolean; multiProject?: boolean
}
function invoiceView(inv: any, extra?: InvoiceExtra) {
  return {
    id: inv.id,
    ksef_number: inv.ksef_number,
    invoice_number: inv.invoice_number,
    seller_name: inv.seller_name,
    seller_nip: inv.seller_nip,
    gross_amount: inv.gross_amount,
    currency: inv.currency,
    invoice_date: inv.invoice_date,
    payment_due_date: inv.payment_due_date,
    payment_status: inv.payment_status ?? 'unpaid',
    payment_source: inv.payment_source,
    paid_amount: inv.paid_amount,
    paid_at: inv.paid_at,
    // projekt, w którym koszt faktycznie leży (alokacja ma pierwszeństwo przed legacy project_id)
    project_id: extra ? (extra.projectId ?? null) : inv.project_id,
    project_name: extra?.projectName ?? null,
    allocations_count: extra?.allocationsCount ?? 0,
    allocated_amount: extra?.allocatedAmount ?? 0,
    internal_allocation: extra?.internalAllocation ?? false, // ręcznie rozpisana jako koszt firmowy — tylko w KSeF
    auto_classified: extra?.autoClassified ?? false,         // automatyczna klasyfikacja z synchronizacji — można nadpisać
    multi_project: extra?.multiProject ?? false,             // rozpisana na kilka projektów — podział tylko w KSeF
    overdue: isOverdue(inv),
  }
}

// ── Scoring dopasowania obciążenia bankowego do faktury ──────────────────────
function alnum(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ── Surowe pole :86: w starych wierszach ──────────────────────────────────────
// Parser (utils/mt940Parser) sam rozkłada subpola ~NN i zwraca CZYSTY tytuł, kontrahenta i IBAN — dla jego
// wyniku ta funkcja nic nie zmienia. Zostaje dla wierszy zapisanych SUROWO przez dawny import
// (opis zaczyna się od „[kod]~NN…"): wyciąga tytuł (~20–28, ~29 gdy to nie rachunek), kontrahenta (~32–33)
// i IBAN (~38). Kawałki sklejane jak w parserze: kawałek o długości dokładnie 27 znaków łączy się
// BEZPOŚREDNIO z następnym (bank tnie tekst co 27 znaków, także w środku słowa), krótszy dostaje spację.
const RAW_SUBFIELDS_RE = /^\s*(?:[A-Z0-9]{3}\s?)?~\d{2}/
const SUBFIELD_CHUNK_LEN = 27

function joinSubfieldChunks(chunks: string[]): string {
  let out = ''
  for (const raw of chunks) {
    // stary parser przycinał linie i sklejał je spacją — jedna spacja na końcu kawałka to ślad tego sklejenia
    const c = raw.endsWith(' ') ? raw.slice(0, -1) : raw
    out += c.length === SUBFIELD_CHUNK_LEN ? c : `${c} `
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function cleanMt940Fields(tx: { description: string; counterparty: string; counterparty_iban: string }) {
  const d = tx.description || ''
  if (!RAW_SUBFIELDS_RE.test(d)) return { description: d, counterparty: tx.counterparty, counterparty_iban: tx.counterparty_iban }

  const body = d.slice(d.indexOf('~'))
  const title: string[] = []
  const name: string[] = []
  let iban38 = ''
  let account = ''
  const re = /~(\d{2})/g
  const marks: Array<{ code: number; start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) marks.push({ code: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length })
  marks.forEach((mk, i) => {
    const text = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : body.length)
    const compact = text.replace(/\s+/g, '').toUpperCase()
    if (mk.code >= 20 && mk.code <= 28) title.push(text)
    else if (mk.code === 29) {
      // rachunek kontrahenta (26 cyfr albo pełny IBAN); w innym razie — kolejny kawałek tytułu
      if (/^\d{26}$/.test(compact) || /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) { if (!account) account = compact }
      else title.push(text)
    } else if (mk.code === 32 || mk.code === 33) name.push(text)
    else if (mk.code === 38 && !iban38) iban38 = compact
  })

  // IBAN: ~38 dłuższe niż sam prefiks kraju („PLPL…"/„PLDE…" → bez zdublowanego „PL"), potem rachunek z ~29
  let iban = ''
  if (iban38.length > 4) {
    const doubled = /^[A-Z]{2}([A-Z]{2}\d{2}[A-Z0-9]{10,30})$/.exec(iban38)
    iban = doubled ? doubled[1] : (/^\d{26}$/.test(iban38) ? `PL${iban38}` : iban38)
  } else if (account) {
    iban = /^\d{26}$/.test(account) ? `PL${account}` : account
  }

  const cleanTitle = joinSubfieldChunks(title)
  const cp = joinSubfieldChunks(name)
  // zapisany kontrahent surowego wiersza to początek pola :86: (kod operacji / znaczniki) — nie nazwa
  const storedCp = String(tx.counterparty ?? '')
  const storedCpIsRaw = storedCp.includes('~') || /^[A-Z0-9]{3}$/.test(storedCp.trim())
  return {
    description: cleanTitle || d,
    counterparty: cp || (storedCpIsRaw ? '' : storedCp),
    counterparty_iban: iban || tx.counterparty_iban,
  }
}

export function scoreMatch(tx: any, inv: any): { confidence: number; reasons: string[]; score: number } {
  let confidence = 0
  const reasons: string[] = []
  const txAbs = Math.abs(tx.amount)
  const gross = inv.gross_amount || 0
  const desc = `${tx.description || ''} ${tx.counterparty || ''}`
  const descAlnum = alnum(desc)

  // Punkty służą TYLKO do ułożenia podpowiedzi na liście „do sprawdzenia" (kandydaci do ręcznego przypisania).
  // Kwota w tolerancji prowizji (max(5 zł, 2 % brutto)) jest podpowiedzią — nigdy podstawą automatu.
  const diff = Math.abs(txAbs - gross)
  const feeTolerance = Math.max(5, gross * 0.02)
  if (diff <= 0.01) {
    confidence += 0.55; reasons.push('kwota')
  } else if (gross > 0 && diff <= feeTolerance) {
    confidence += 0.5; reasons.push('kwota ±prowizja')
  }

  // Numer faktury w tytule przelewu — jako CAŁY numer („2/09/2026" nie pasuje do „12/09/2026")
  if (titleNamesInvoice(tx.description, inv.invoice_number)) {
    confidence += 0.35; reasons.push('nr faktury')
  }

  // NIP sprzedawcy w tytule/kontrahencie
  const nip = (inv.seller_nip || '').replace(/[^0-9]/g, '')
  if (nip.length === 10 && descAlnum.includes(nip)) {
    confidence += 0.25; reasons.push('NIP')
  }

  // Nazwa sprzedawcy vs kontrahent przelewu (wspólny token ≥ 4 znaki)
  const sellerTokens = (inv.seller_name || '').toLowerCase().split(/[^a-ząćęłńóśźż0-9]+/).filter((t: string) => t.length >= 4)
  const descLower = desc.toLowerCase()
  if (sellerTokens.length && sellerTokens.some((t: string) => descLower.includes(t))) {
    confidence += 0.25; reasons.push('kontrahent')
  }

  // Data: płacimy często po terminie, więc odstęp NIE dyskwalifikuje — mały bonus
  // tylko za sanity (przelew nie wcześniejszy niż data faktury), bez limitu dni
  if (inv.invoice_date && tx.transaction_date && tx.transaction_date >= inv.invoice_date) {
    confidence += 0.05; reasons.push('data')
  }

  // `confidence` (0–1) trafia do bazy i na ekran; `score` to suma BEZ obcięcia — do rankingu kandydatów.
  // Odkąd wyciąg niesie tytuł i kontrahenta, kilka faktur tego samego dostawcy dobija do 1,0 (NIP + nazwa +
  // kwota w tolerancji), więc obcięta pewność przestaje je rozróżniać — numer faktury w tytule musi wygrać.
  return { confidence: Math.min(1, confidence), reasons, score: confidence }
}

function bestMatches(tx: any, invoices: any[], limit: number) {
  const exact = (m: { reasons: string[] }) => Number(m.reasons.includes('kwota'))
  return invoices
    .map(inv => ({ invoice: inv, ...scoreMatch(tx, inv) }))
    .filter(m => m.confidence >= CANDIDATE_THRESHOLD)
    // ranking po sumie nieobciętej; remis → dokładna kwota przed kwotą ±prowizja (wynik nie zależy od kolejności faktur)
    .sort((a, b) => b.score - a.score || exact(b) - exact(a))
    .slice(0, limit)
}

// Zgodność wsteczna importów: reguły automatu mieszkają w services/payment-match
export { decideAutoMatch, payableCandidates, PREPAYMENT_GRACE_DAYS }

async function markInvoicePaid(invoiceId: string, opts: { source: string; amount?: number | null; paidAt?: string | null; txId?: string | null }) {
  await db.ksef_invoices.updatePayment(invoiceId, {
    payment_status: 'paid',
    payment_source: opts.source,
    paid_amount: opts.amount ?? null,
    paid_at: opts.paidAt ?? today(),
    bank_tx_id: opts.txId ?? null,
  })
}

// ── GET /api/payables/summary — KPI panelu ────────────────────────────────────
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const all = (await db.ksef_invoices.listAll()).filter(isIncoming)
    const unpaid = all.filter(isUnpaid)
    const overdue = unpaid.filter(isOverdue)
    const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const dueSoon = unpaid.filter((i: any) => i.payment_due_date && i.payment_due_date >= today() && i.payment_due_date <= in7)
    const month = today().slice(0, 7)
    const paidThisMonth = all.filter((i: any) => i.payment_status === 'paid' && (i.paid_at || '').slice(0, 7) === month)
    const pendingReview = await db.bank_transactions.list({ matched_invoice_id: null, review_status: 'pending', amount: { lt: 0 } })

    const sum = (arr: any[]) => Math.round(arr.reduce((s, i) => s + (i.gross_amount || 0), 0) * 100) / 100
    res.json({
      unpaid_count: unpaid.length, unpaid_sum: sum(unpaid),
      overdue_count: overdue.length, overdue_sum: sum(overdue),
      due_soon_count: dueSoon.length, due_soon_sum: sum(dueSoon),
      paid_this_month_count: paidThisMonth.length,
      paid_this_month_sum: Math.round(paidThisMonth.reduce((s: number, i: any) => s + (i.paid_amount ?? i.gross_amount ?? 0), 0) * 100) / 100,
      review_count: pendingReview.length,
    })
  } catch (e) {
    console.error('[payables/summary]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── GET /api/payables/invoices?filter=unpaid|overdue|paid|all&search= ─────────
router.get('/invoices', async (req: Request, res: Response) => {
  try {
    const filter = String(req.query.filter ?? 'unpaid')
    const search = String(req.query.search ?? '').trim().toLowerCase()

    let list = (await db.ksef_invoices.listAll()).filter(isIncoming)
    if (filter === 'unpaid') list = list.filter(isUnpaid)
    else if (filter === 'overdue') list = list.filter(isOverdue)
    else if (filter === 'paid') list = list.filter((i: any) => i.payment_status === 'paid')

    if (search) {
      list = list.filter((i: any) =>
        [i.seller_name, i.seller_nip, i.invoice_number, i.ksef_number]
          .some(v => (v || '').toLowerCase().includes(search)))
    }

    // Nieopłacone: najpilniejsze terminy na górze (brak terminu na końcu); opłacone: ostatnio zapłacone na górze
    if (filter === 'paid') {
      list.sort((a: any, b: any) => (b.paid_at || '').localeCompare(a.paid_at || ''))
    } else {
      list.sort((a: any, b: any) => (a.payment_due_date || '9999').localeCompare(b.payment_due_date || '9999'))
    }

    // Projekt + alokacje (żeby pokazać „📁 projekt” i wiedzieć, czy można przenieść)
    const page = list.slice(0, 500)
    const ids = page.map((i: any) => i.id)
    const [projects, allocs] = await Promise.all([
      prisma.project.findMany({ select: { id: true, name: true } }),
      prisma.ksefInvoiceAllocation.findMany({
        where: { invoice_id: { in: ids } }, orderBy: { created_at: 'asc' },
        select: { invoice_id: true, project_id: true, allocation_type: true, amount: true, notes: true },
      }),
    ])
    const projectName = new Map(projects.map(p => [p.id, p.name]))
    type Agg = { count: number; amount: number; internal: boolean; auto: boolean; projectIds: string[] }
    const byInvoice = new Map<string, Agg>()
    for (const a of allocs) {
      const cur = byInvoice.get(a.invoice_id) ?? { count: 0, amount: 0, internal: false, auto: false, projectIds: [] }
      cur.count += 1; cur.amount += a.amount || 0
      if (a.allocation_type !== 'project' || !a.project_id) {
        if (String(a.notes || '').startsWith('Auto-klasyfikacja') && a.allocation_type === 'internal') cur.auto = true
        else cur.internal = true
      } else if (!cur.projectIds.includes(a.project_id)) cur.projectIds.push(a.project_id)
      byInvoice.set(a.invoice_id, cur)
    }
    res.json(page.map((inv: any) => {
      const al = byInvoice.get(inv.id)
      const autoOnly = !!al && al.auto && al.count === 1
      const pid = al?.projectIds[0] ?? inv.project_id ?? null
      return invoiceView(inv, {
        projectId: pid,
        projectName: pid ? (projectName.get(pid) ?? null) : null,
        allocationsCount: al?.count ?? 0,
        allocatedAmount: Math.round((al?.amount ?? 0) * 100) / 100,
        internalAllocation: !!al && (al.internal || (al.auto && !autoOnly)),
        autoClassified: autoOnly,
        multiProject: (al?.projectIds.length ?? 0) > 1,
      })
    }))
  } catch (e) {
    console.error('[payables/invoices]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/payables/invoices/:id/mark-paid ────────────────────────────────
router.post('/invoices/:id/mark-paid', async (req: Request, res: Response) => {
  try {
    const { paid_at } = req.body ?? {}
    await markInvoicePaid(req.params.id, { source: 'manual', paidAt: paid_at || today() })
    res.json({ ok: true })
  } catch (e) {
    console.error('[payables/mark-paid]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/payables/invoices/:id/mark-unpaid ──────────────────────────────
router.post('/invoices/:id/mark-unpaid', async (req: Request, res: Response) => {
  try {
    // Zwolnij powiązane transakcje bankowe z powrotem do „do sprawdzenia"
    const linked = await db.bank_transactions.list({ matched_invoice_id: req.params.id })
    for (const tx of linked) {
      await db.bank_transactions.update(tx.id, { matched_invoice_id: null, match_confidence: null, review_status: 'pending' })
    }
    await db.ksef_invoices.updatePayment(req.params.id, {
      payment_status: 'unpaid', payment_source: null, paid_amount: null, paid_at: null, bank_tx_id: null,
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('[payables/mark-unpaid]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── Import MT940: klucz deduplikacji, plan importu, higiena listy „do sprawdzenia" (czyste funkcje) ──

/**
 * Klucz deduplikacji transakcji bankowej: data | kwota ze znakiem | referencja | początek opisu
 * (referencja i opis porównywane po znakach alfanumerycznych — odstępy i polskie znaki nie mają znaczenia).
 */
export function bankTxKey(t: { date?: string; transaction_date?: string; amount: number; description?: string | null; reference?: string | null }): string {
  return `${t.date ?? t.transaction_date}|${t.amount.toFixed(2)}|${alnum(t.reference || '')}|${alnum(t.description || '').slice(0, 80)}`
}

export interface BankTxPlanRow {
  transaction_date: string
  amount: number
  description: string
  counterparty: string
  counterparty_iban: string
  reference: string
}

export interface BankTxPlanTx {
  date: string
  amount: number                       // ze znakiem (obciążenie ujemne)
  description: string
  reference: string
  op_code?: string
  legacy_description?: string
}

/**
 * Plan importu dla BankTransaction (te same zasady co dla kosztów — services/mt940-costs):
 *  - istniejące wiersze kluczowane po opisie ZNORMALIZOWANYM (cleanMt940Fields nic nie zmienia w czystych
 *    opisach, a surowe wiersze dawnego importu /api/bank/import-mt940 sprowadza do tej samej postaci),
 *  - transakcja ma dwa klucze: z referencją i bez — ten drugi trafia w wiersz zapisany BEZ referencji
 *    (stary parser brał referencję tylko po „//"),
 *  - wiersz starego importu (opis = sam kod operacji, brak referencji) parujemy po dacie i kwocie ZE ZNAKIEM.
 * Po naprawie wiersz ma opis i referencję z pliku, więc ponowne wgranie tego samego wyciągu daje same duplikaty.
 */
export const BANK_TX_PLAN_CONFIG: ImportPlannerConfig<BankTxPlanRow, BankTxPlanTx> = {
  existingKeys: row => [bankTxKey({ ...row, ...cleanMt940Fields(row) })],
  txKeys: tx => {
    const keys = [bankTxKey(tx)]
    const noRef = bankTxKey({ ...tx, reference: '' })
    if (!keys.includes(noRef)) keys.push(noRef)
    return keys
  },
  existingDate: row => row.transaction_date,
  existingAmounts: row => [Number(row.amount) || 0],
  txDate: tx => tx.date,
  txAmount: tx => tx.amount,
  isLegacy: (row, tx) => isLegacyRow(row, tx),
}

export function createBankTxPlanner<E extends BankTxPlanRow>(existing: E[]): ImportPlanner<BankTxPlanTx> {
  return createImportPlanner<BankTxPlanRow, BankTxPlanTx>(existing, BANK_TX_PLAN_CONFIG)
}

export function planBankTxImport(txs: BankTxPlanTx[], existing: BankTxPlanRow[]): ImportDecision[] {
  return planImport(txs, existing, BANK_TX_PLAN_CONFIG)
}

/**
 * Co zrobić z NOWĄ transakcją: `credit` — uznanie (nie dotyczy płacenia faktur), `dismiss` — obciążenie,
 * które nie może być zapłatą za fakturę (od razu odrzucone, bez auto-dopasowania), `review` — storno
 * (do ręcznej decyzji), `match` — próba auto-dopasowania do nieopłaconej faktury.
 */
export type NewTxDisposition = 'credit' | 'dismiss' | 'review' | 'match'
export function newTxDisposition(tx: { amount: number; is_reversal?: boolean }, notInvoicePayment: boolean): NewTxDisposition {
  if (!(tx.amount < 0)) return 'credit'
  if (notInvoicePayment) return 'dismiss'
  return tx.is_reversal ? 'review' : 'match'
}

/**
 * Co zrobić z ISTNIEJĄCYM wierszem (naprawianym albo już zaimportowanym) po poznaniu tytułu i kontrahenta:
 * `keep` — nie ruszać statusu (uznanie, wiersz dopasowany / przypisany / odrzucony), `dismiss` — nie może być
 * zapłatą za fakturę, a czeka (pending) albo jest spoza panelu (none), `review` — storno czekające na
 * decyzję, `match` — obciążenie czekające na sprawdzenie: próba auto-dopasowania.
 * Dopasowania (matched_invoice_id) NIGDY nie zmieniamy.
 */
export type ExistingTxDisposition = 'keep' | 'dismiss' | 'review' | 'match'
export function existingTxDisposition(
  row: { matched_invoice_id?: string | null; review_status?: string | null },
  tx: { amount: number; is_reversal?: boolean },
  notInvoicePayment: boolean,
): ExistingTxDisposition {
  if (!(tx.amount < 0) || row.matched_invoice_id) return 'keep'
  const status = row.review_status || 'none'
  if (notInvoicePayment) return status === 'pending' || status === 'none' ? 'dismiss' : 'keep'
  if (status !== 'pending') return 'keep'
  return tx.is_reversal ? 'review' : 'match'
}

/**
 * Zdublowane wiersze starego importu do odłożenia po imporcie pliku (czysta funkcja): „goły" wiersz (opis = sam
 * kod operacji, bez referencji i bez op_code), NIEnaprawiony w tym przebiegu, niedopasowany do faktury i jeszcze
 * nierozstrzygnięty ręcznie (pending / none / dismissed), którego dzień + kwota + kod operacji WYSTĘPUJĄ w pliku.
 * Plik miał więc taki przelew, ale każdy jego egzemplarz dostał już inny wiersz — ten jest nadwyżką.
 */
export function legacyOrphanIds(
  existing: Array<{ id: string; transaction_date: string; amount: number; description: string; reference?: string | null; op_code?: string | null; matched_invoice_id?: string | null; review_status?: string | null }>,
  parsed: Array<{ date: string; amount: number; op_code?: string; legacy_description?: string }>,
  repairedIds: Set<string>,
): string[] {
  const keyOf = (date: string, amount: number, code: string) => `${date}|${Number(amount).toFixed(2)}|${code.trim().toUpperCase()}`
  const fileKeys = new Set<string>()
  for (const t of parsed) {
    for (const code of [t.op_code, t.legacy_description]) {
      const c = String(code ?? '').trim()
      if (c && c.length <= 3) fileKeys.add(keyOf(t.date, t.amount, c))
    }
  }
  if (!fileKeys.size) return []
  const out: string[] = []
  for (const row of existing) {
    if (repairedIds.has(row.id) || row.op_code != null || row.matched_invoice_id) continue
    const d = String(row.description ?? '').trim()
    if (!/^[A-Za-z0-9]{1,3}$/.test(d) || String(row.reference ?? '').trim()) continue
    const status = row.review_status || 'none'
    if (status !== 'pending' && status !== 'none' && status !== 'dismissed') continue
    if (fileKeys.has(keyOf(row.transaction_date, row.amount, d))) out.push(row.id)
  }
  return out
}

// ── POST /api/payables/import-mt940 — upload + auto-dopasowanie w jednym kroku ─
router.post('/import-mt940', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Brak pliku. Wyślij plik w polu "file".' }); return }

    let content = req.file.buffer.toString('utf-8')
    if (content.includes('�')) content = req.file.buffer.toString('latin1')

    const { transactions: parsed, balances } = parseMT940Statements(content)
    if (!parsed.length) { res.status(400).json({ error: 'Nie znaleziono transakcji w pliku. Sprawdź, czy to poprawny wyciąg MT940.' }); return }

    // Wyciąg rachunku prowadzonego w innej firmie → odmowa, zanim cokolwiek zapiszemy (każda firma ma swoje księgi)
    const otherCompany = await accountInOtherCompanyMessage([...parsed.map(t => t.account), ...balances.map(b => b.account)])
    if (otherCompany) { res.status(409).json({ error: otherCompany, code: 'account_other_company' }); return }

    // Plan importu względem już zaimportowanych: pomiń (ten sam klucz: data + kwota + referencja + opis),
    // napraw na miejscu (wiersz starego importu: opis = sam kod operacji) albo utwórz. Każdy istniejący
    // wiersz jest „zużywany" raz — dwa identyczne autentyczne przelewy tego samego dnia nie mogą się
    // nawzajem "deduplikować".
    const existing = await db.bank_transactions.list({ source: 'mt940' })
    const planner = createBankTxPlanner(existing)

    // Kontekst klasyfikatora: rachunki własne (zapisane salda + rachunki wyciągów z tego pliku) i pracownicy
    const context = await loadClassifyContext([...parsed.map(t => t.account), ...balances.map(b => b.account)])

    const allInvoices = (await db.ksef_invoices.listAll()).filter(isIncoming)
    const paidNow = new Set<string>() // faktury opłacone w trakcie tego importu
    // faktury, z którymi jakiś przelew jest już powiązany (także opłacone ręcznie i potem powiązane)
    const linkedInvoiceIds = new Set<string>((existing as any[]).map(r => r.matched_invoice_id).filter(Boolean))
    let linkedPaid = 0 // przelewy powiązane z fakturą JUŻ opłaconą (bez zmiany jej statusu)

    let imported = 0, duplicates = 0, autoMatched = 0, toReview = 0, credits = 0, repaired = 0, autoDismissed = 0
    const matchedDetails: any[] = []
    const repairedIds = new Set<string>() // wiersze starego importu uzupełnione w tym przebiegu

    // Auto-dopasowanie obciążenia do nieopłaconej faktury (wspólne dla nowych i naprawianych wierszy)
    const autoMatch = async (tx: any, txId: string): Promise<{ invoiceId: string; confidence: number } | null> => {
      // Ścisła reguła: ten sam kontrahent + kwota co do grosza + (numer faktury z tytułu albo jedyna taka faktura).
      // Tytuł wskazujący fakturę już opłaconą tylko WIĄŻE przelew z nią — nigdy nie „opłaca" sąsiedniej.
      const best = decideAutoMatch(tx, allInvoices as any[], { taken: paidNow, linkedInvoiceIds })
      if (best.action === 'none') return null
      linkedInvoiceIds.add(best.invoice.id)
      if (best.action === 'link') {
        linkedPaid++
        return { invoiceId: best.invoice.id, confidence: best.confidence }
      }
      await markInvoicePaid(best.invoice.id, { source: 'mt940', amount: Math.abs(tx.amount), paidAt: tx.date, txId })
      paidNow.add(best.invoice.id)
      matchedDetails.push({
        invoice_id: best.invoice.id, invoice_number: best.invoice.invoice_number,
        seller_name: best.invoice.seller_name, amount: Math.abs(tx.amount),
        confidence: best.confidence, reasons: best.reasons,
      })
      autoMatched++
      return { invoiceId: best.invoice.id, confidence: best.confidence }
    }

    for (const rawTx of parsed) {
      // transaction_date jawnie: scoreMatch i insert czytają to pole, a parser zwraca `date`.
      // Operacja bez tytułu (opłata bankowa, transakcja natychmiastowa): opisem jest nazwa operacji z wyciągu —
      // ten sam opis trafia do planu importu (klucz deduplikacji) i do bazy, więc ponowne wgranie go rozpozna.
      const tx = { ...rawTx, description: bankTxDescription(rawTx), transaction_date: rawTx.date }
      const decision = planner.decide(tx)

      // Każde obciążenie przechodzi przez klasyfikator: ZUS / US / pensja / opłata / przelew własny
      // nigdy nie jest zapłatą za fakturę zakupową
      const cls = tx.amount < 0 ? classifyBankTransfer({
        date: tx.date, amount: tx.amount, description: rawTx.description, counterparty: tx.counterparty,
        counterparty_iban: tx.counterparty_iban, op_code: tx.op_code, op_label: tx.op_label, currency: tx.currency,
      }, context) : null
      const notInvoicePayment = !!cls?.not_invoice_payment
      // „Pensja" to jedyny rodzaj rozpoznawany po samym TYTULE przelewu (ZUS, US, opłaty i przelewy własne — po
      // rachunku / kodzie operacji). Podwykonawca-osoba fizyczna też pisze „wynagrodzenie", a wystawia fakturę
      // w KSeF — dlatego przed odrzuceniem takiego przelewu próbujemy go dopasować do nieopłaconej faktury.
      const tryInvoiceFirst = cls?.kind === 'salary' && !tx.is_reversal

      if (decision.action === 'skip') {
        duplicates++
        // Wiersz już zaimportowany (np. uzupełniony wcześniej dawnym importem /api/bank), który wciąż czeka
        // na sprawdzenie, a nie może być zapłatą za fakturę — odrzuć, żeby nie wisiał na liście
        const row: any = existing[decision.index]
        if (existingTxDisposition(row, tx, notInvoicePayment) === 'dismiss') {
          await db.bank_transactions.update(row.id, { review_status: 'dismissed' })
          autoDismissed++
        }
        continue
      }

      if (decision.action === 'repair') {
        // ── Wiersz starego importu: uzupełnij na miejscu tytuł, kontrahenta, rachunek, referencję i kod operacji ──
        const row: any = existing[decision.index]
        const patch: Record<string, any> = {
          description: tx.description, counterparty: tx.counterparty, counterparty_iban: tx.counterparty_iban,
          reference: tx.reference, op_code: tx.op_code ?? '', currency: tx.currency || row.currency || 'PLN',
        }
        const disposition = existingTxDisposition(row, tx, notInvoicePayment)
        repairedIds.add(row.id)
        if (disposition === 'dismiss') {
          const hit = tryInvoiceFirst ? await autoMatch(tx, row.id) : null
          if (hit) {
            patch.matched_invoice_id = hit.invoiceId
            patch.match_confidence = hit.confidence
            patch.review_status = 'matched'
          } else {
            patch.review_status = 'dismissed'
            autoDismissed++
          }
        } else if (disposition === 'match') {
          // Tytuł i kontrahent są już znane — ta sama próba auto-dopasowania co dla nowych wierszy
          const hit = await autoMatch(tx, row.id)
          if (hit) {
            patch.matched_invoice_id = hit.invoiceId
            patch.match_confidence = hit.confidence
            patch.review_status = 'matched'
          } else {
            toReview++
          }
        } else if (disposition === 'review') {
          toReview++
        }
        await db.bank_transactions.update(row.id, patch)
        repaired++
        continue
      }

      // ── Nowa transakcja ──
      const id = uuidv4()
      let matchedInvoiceId: string | null = null
      let matchConfidence: number | null = null
      let reviewStatus = 'pending'

      const disposition = newTxDisposition(tx, notInvoicePayment)
      if (disposition === 'credit') {
        // Uznania (wpływy) nie dotyczą płacenia faktur kosztowych — pomijamy w sprawdzaniu
        reviewStatus = 'dismissed'
        credits++
      } else if (disposition === 'dismiss') {
        // ZUS / podatek / pensja / opłata bankowa / przelew własny — nie trafia na listę „do sprawdzenia"
        const hit = tryInvoiceFirst ? await autoMatch(tx, id) : null
        if (hit) {
          matchedInvoiceId = hit.invoiceId
          matchConfidence = hit.confidence
          reviewStatus = 'matched'
        } else {
          reviewStatus = 'dismissed'
          autoDismissed++
        }
      } else if (disposition === 'review') {
        // Storno (RC) to zwrot wcześniejszej transakcji, nie płatność — nie dopasowujemy
        // automatycznie; ląduje na liście "do sprawdzenia" do ręcznej decyzji
        toReview++
      } else {
        const hit = await autoMatch(tx, id)
        if (hit) {
          matchedInvoiceId = hit.invoiceId
          matchConfidence = hit.confidence
          reviewStatus = 'matched'
        } else {
          toReview++
        }
      }

      await db.bank_transactions.insert({
        id, source: 'mt940',
        transaction_date: tx.date, amount: tx.amount, currency: tx.currency || 'PLN',
        description: tx.description, counterparty: tx.counterparty,
        counterparty_iban: tx.counterparty_iban, reference: tx.reference,
        op_code: tx.op_code ?? '', // '' = bank bez kodów operacji; NULL zostaje tylko w wierszach starego importu
        matched_invoice_id: matchedInvoiceId, match_confidence: matchConfidence,
        review_status: reviewStatus, created_at: now(),
      })
      imported++
    }

    // ── Pozostałości starego importu: zdublowane „gołe" wiersze, których żaden przelew z pliku już nie sparuje ──
    // Dawny import /api/bank nie deduplikował, więc wyciąg wgrany tam dwa razy zostawił dwa identyczne wiersze na
    // jeden przelew. Pierwszy został właśnie uzupełniony; drugi zostałby „gołym" wierszem na zawsze — wisiałby na
    // liście „do sprawdzenia", a „Kondycja firmy" bez końca kazałaby wgrywać wyciąg ponownie. Skoro plik zawiera
    // ten dzień, kwotę i kod operacji, a wszystkie jego przelewy mają już swój wiersz, nadwyżka to duplikat:
    // odkładamy ją (dismissed) i oznaczamy kodem operacji. Wierszy dopasowanych do faktur nie ruszamy.
    const orphanIds = legacyOrphanIds(existing as any[], parsed, repairedIds)
    for (const oid of orphanIds) {
      const row: any = (existing as any[]).find(r => r.id === oid)
      await db.bank_transactions.update(oid, { review_status: 'dismissed', op_code: String(row?.description ?? '').trim().toUpperCase() })
    }

    // ── Salda wyciągu (BankBalance) + koszty do RZiS (ManualCost source='mt940') — wspólny serwis ──
    // Transakcje bankowe są już zapisane; błąd tego etapu nie unieważnia importu (ponowny upload
    // zdeduplikuje), tylko trafia do odpowiedzi jako costs_error.
    let costs_created = 0, costs_skipped = 0, rules_applied = 0, balances_saved = 0
    let costs_repaired = 0, costs_to_review = 0
    let costs_to_review_from: string | null = null
    let recognized: Mt940Recognized[] = []
    let costs_error: string | undefined
    try {
      balances_saved = await saveBankBalances(balances)
      const c = await upsertMt940Costs(parsed, { createdBy: (req as any).user?.email ?? '', context })
      costs_created = c.created; costs_skipped = c.skipped_existing; rules_applied = c.rules_applied
      costs_repaired = c.repaired; costs_to_review = c.to_review; recognized = c.recognized
      costs_to_review_from = c.to_review_from
    } catch (ce: any) {
      console.error('[payables/import-mt940] koszty/salda:', ce)
      costs_error = ce?.message ?? 'Błąd zapisu kosztów z wyciągu'
    }

    res.json({
      imported, duplicates, auto_matched: autoMatched, to_review: toReview, credits_skipped: credits, matched: matchedDetails,
      costs_created, costs_skipped, rules_applied, balances_saved,
      // naprawa starego importu + rozpoznawanie przelewów (ZUS, podatki, pensje, przelewy własne, zagraniczne)
      repaired, auto_dismissed: autoDismissed, costs_repaired, recognized, costs_to_review, costs_to_review_from,
      legacy_duplicates: orphanIds.length, // zdublowane wpisy starego importu odłożone przy tym imporcie
      linked_paid: linkedPaid,             // przelewy powiązane z fakturą już wcześniej oznaczoną jako opłacona
      ...(costs_error ? { costs_error } : {}),
    })
  } catch (e: any) {
    console.error('[payables/import-mt940]', e)
    res.status(500).json({ error: e?.message ?? 'Błąd importu' })
  }
})

// ── GET /api/payables/invoices/:id/line-items — pozycje faktury (cache/XML KSeF) ──
router.get('/invoices/:id/line-items', async (req: Request, res: Response) => {
  try {
    const { getInvoiceLineItems } = await import('../services/ksef-lineitems')
    res.json({ items: await getInvoiceLineItems(req.params.id) })
  } catch (err: any) {
    res.json({ items: [], error: err?.message ?? 'Błąd' })
  }
})

// ── GET /api/payables/invoices/:id/xml — oryginalny XML faktury z KSeF ────────
// XML z magazynu (ksef-xml-store): cache w bazie, a przy pierwszym razie pobranie z KSeF.
router.get('/invoices/:id/xml', async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.ksefInvoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, ksef_number: true, invoice_number: true },
    })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (!invoice.ksef_number) { res.status(400).json({ error: 'Brak numeru KSeF' }); return }
    const { xml } = await getInvoiceXml(invoice)
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="faktura-${(invoice.invoice_number ?? invoice.ksef_number).replace(/[^\w.-]/g, '_')}.xml"`)
    res.send(xml)
  } catch (err: any) { sendKsefXmlError(res, err, 'payables/xml') }
})

// ── GET /api/payables/invoices/:id/document — pełny dokument faktury (podgląd / druk) ──
// HTML zbudowany z XML KSeF: { html, title, filename (bez rozszerzenia), source: 'cache'|'ksef' }.
// Błędy: { error, code? } — 404 brak faktury / nie ma jej w KSeF, 400 brak numeru KSeF lub konfiguracji,
// 429 rate_limited, 502 błąd KSeF/sieci, 422 unparseable.
router.get('/invoices/:id/document', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const invoice = await prisma.ksefInvoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, ksef_number: true, invoice_number: true, invoice_direction: true },
    })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (!invoice.ksef_number) { res.status(400).json({ error: NO_KSEF_NUMBER_MSG, code: 'no_ksef_number' }); return }
    res.json(await getInvoiceDocument(invoice))
  } catch (err: any) { sendKsefXmlError(res, err, 'payables/document') }
})

// ── POST /api/payables/invoices/:id/assign-project { project_id, category?, notes?, reassign? } ─
// Z Płatności: cała faktura jako koszt projektu (alokacja + CostItem), dla admina i księgowego.
router.post('/invoices/:id/assign-project', async (req: Request, res: Response) => {
  try {
    const u: any = (req as any).user
    const { project_id, category, notes, reassign } = req.body ?? {}
    if (!project_id) { res.status(400).json({ error: 'Wybierz projekt' }); return }
    const result = await assignInvoiceToProject(req.params.id,
      { project_id: String(project_id), category, notes, reassign: reassign === true },
      { user_id: u?.id ?? null, user_name: u?.display_name || u?.email || 'Płatności' })
    res.json({ ok: true, ...result })
  } catch (e: any) {
    if (e instanceof AssignError) { res.status(e.status).json({ error: e.message }); return }
    console.error('[payables/assign-project]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/payables/fetch-due-dates — uzupełnij terminy płatności z XML KSeF ──
// Nieopłacone faktury kosztowe bez terminu (null = nigdy nie pobrano; '' = faktura
// nie ma terminu w XML — nie ponawiamy). Partia max 30 na wywołanie (limiter XML
// w ksef-xml-store trzyma równoległość 2, a limit partii chroni rate-limit KSeF).
router.post('/fetch-due-dates', async (_req: Request, res: Response) => {
  try {
    const missing = (await db.ksef_invoices.listAll()).filter((i: any) =>
      isIncoming(i) && isUnpaid(i) && i.payment_due_date == null && i.ksef_number)
    const batch = missing.slice(0, 30)

    const { fetchAndStoreInvoiceDetails } = await import('../services/ksef-lineitems')
    let filled = 0, noDate = 0, failed = 0
    for (const inv of batch) {
      const due = await fetchAndStoreInvoiceDetails(inv.id)
      if (due === null) failed++
      else if (due === '') noDate++
      else filled++
    }

    res.json({
      checked: batch.length,
      filled,                                  // uzupełnione terminy
      no_date_in_invoice: noDate,              // faktura nie zawiera terminu w XML
      failed,                                  // błąd pobierania (spróbuj później)
      remaining: Math.max(0, missing.length - batch.length),
    })
  } catch (e) {
    console.error('[payables/fetch-due-dates]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

/**
 * Automatyczne dopasowania (review_status = 'matched'), których ścisła reguła by NIE zrobiła — do cofnięcia
 * (czysta funkcja). Dla każdego odtwarzamy stan „sprzed dopasowania" (faktura opłacona tym przelewem wraca
 * do nieopłaconych) i pytamy regułę jeszcze raz: dopasowanie zostaje tylko wtedy, gdy reguła wskaże TĘ SAMĄ
 * fakturę w ten sam sposób (zapłata albo samo powiązanie z fakturą opłaconą wcześniej).
 * Dopasowań ręcznych ('assigned') nie dotykamy — to decyzje użytkownika.
 */
export function invalidAutoMatches(
  autoRows: any[],
  invoices: any[],
  allLinks: Array<{ id: string; matched_invoice_id: string | null }>,
): Array<{ tx: any; invoice: any | null; paidByThisTx: boolean; why: string }> {
  const byId = new Map(invoices.map(i => [i.id, i]))
  const out: Array<{ tx: any; invoice: any | null; paidByThisTx: boolean; why: string }> = []
  for (const tx of autoRows) {
    if (!tx.matched_invoice_id) continue
    const inv = byId.get(tx.matched_invoice_id)
    if (!inv) { out.push({ tx, invoice: null, paidByThisTx: false, why: 'faktura nie istnieje' }); continue }
    const paidByThisTx = inv.payment_status === 'paid' && inv.payment_source === 'mt940' && inv.bank_tx_id === tx.id
    const view = paidByThisTx ? invoices.map(i => (i.id === inv.id ? { ...i, payment_status: 'unpaid', bank_tx_id: null } : i)) : invoices
    const linkedOther = new Set<string>(allLinks.filter(l => l.id !== tx.id && l.matched_invoice_id).map(l => l.matched_invoice_id as string))
    const d = decideAutoMatch(tx, view, { linkedInvoiceIds: linkedOther })
    const valid = d.action !== 'none' && d.invoice.id === inv.id && d.action === (paidByThisTx ? 'pay' : 'link')
    if (valid) continue
    out.push({ tx, invoice: inv, paidByThisTx, why: d.action === 'none' ? d.why : `przelew dotyczy faktury ${d.invoice.invoice_number ?? ''}`.trim() })
  }
  return out
}

// ── POST /api/payables/rematch — sprawdź automatyczne dopasowania i dopasuj czekające obciążenia ──
// 1) Cofa automatyczne dopasowania, które nie spełniają ścisłej reguły (faktura wraca do „do zapłaty",
//    przelew na listę „do sprawdzenia"). 2) Ponownie ocenia wszystkie czekające obciążenia.
router.post('/rematch', async (_req: Request, res: Response) => {
  try {
    const allInvoices: any[] = (await db.ksef_invoices.listAll()).filter(isIncoming)
    const linkedRows: any[] = await db.bank_transactions.list({ matched_invoice_id: { not: null } })

    // ── 1) weryfikacja dotychczasowych dopasowań automatycznych ──
    const autoRows = linkedRows.filter(t => t.review_status === 'matched')
    const invalid = invalidAutoMatches(autoRows, allInvoices, linkedRows)
    const undoneDetails: any[] = []
    for (const bad of invalid) {
      if (bad.invoice && bad.paidByThisTx) {
        await db.ksef_invoices.updatePayment(bad.invoice.id, {
          payment_status: 'unpaid', payment_source: null, paid_amount: null, paid_at: null, bank_tx_id: null,
        })
        Object.assign(bad.invoice, { payment_status: 'unpaid', payment_source: null, paid_amount: null, paid_at: null, bank_tx_id: null })
      }
      await db.bank_transactions.update(bad.tx.id, { matched_invoice_id: null, match_confidence: null, review_status: 'pending' })
      undoneDetails.push({
        invoice_id: bad.invoice?.id ?? null, invoice_number: bad.invoice?.invoice_number ?? null,
        seller_name: bad.invoice?.seller_name ?? null, amount: Math.abs(bad.tx.amount),
        transaction_date: bad.tx.transaction_date, invoice_unmarked: bad.paidByThisTx, why: bad.why,
      })
    }
    const undoneTx = new Set(invalid.map(b => b.tx.id))

    // ── 2) ponowne dopasowanie czekających obciążeń (w tym właśnie cofniętych) ──
    const pending: any[] = await db.bank_transactions.list({ matched_invoice_id: null, review_status: 'pending', amount: { lt: 0 } })
    const linkedInvoiceIds = new Set<string>(linkedRows.filter(t => !undoneTx.has(t.id)).map(t => t.matched_invoice_id).filter(Boolean))
    const paidNow = new Set<string>()
    let matched = 0, linked = 0
    const details: any[] = []

    for (const tx of pending) {
      const best = decideAutoMatch(tx, allInvoices, { taken: paidNow, linkedInvoiceIds })
      if (best.action === 'none') continue
      linkedInvoiceIds.add(best.invoice.id)
      if (best.action === 'pay') {
        await markInvoicePaid(best.invoice.id, { source: 'mt940', amount: Math.abs(tx.amount), paidAt: tx.transaction_date, txId: tx.id })
        paidNow.add(best.invoice.id)
        matched++
        details.push({
          invoice_id: best.invoice.id, invoice_number: best.invoice.invoice_number,
          seller_name: best.invoice.seller_name, amount: Math.abs(tx.amount),
          confidence: best.confidence, reasons: best.reasons,
        })
      } else {
        linked++ // faktura była już opłacona — przelew tylko schodzi z listy „do sprawdzenia"
      }
      await db.bank_transactions.update(tx.id, { matched_invoice_id: best.invoice.id, match_confidence: best.confidence, review_status: 'matched' })
    }

    res.json({
      checked: pending.length, matched, linked, undone: invalid.length,
      remaining: pending.length - matched - linked, details, undone_details: undoneDetails,
    })
  } catch (e) {
    console.error('[payables/rematch]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── GET /api/payables/review — obciążenia do sprawdzenia + kandydaci ──────────
router.get('/review', async (_req: Request, res: Response) => {
  try {
    const pending = await db.bank_transactions.list({ matched_invoice_id: null, review_status: 'pending', amount: { lt: 0 } })
    const unpaidInvoices = (await db.ksef_invoices.listAll()).filter((i: any) => isIncoming(i) && isUnpaid(i))

    const items = pending.map((tx: any) => ({
      id: tx.id,
      transaction_date: tx.transaction_date,
      amount: tx.amount,
      description: tx.description,
      counterparty: tx.counterparty,
      counterparty_iban: tx.counterparty_iban,
      candidates: bestMatches(tx, unpaidInvoices, 3).map(m => ({
        invoice: invoiceView(m.invoice), confidence: m.confidence, reasons: m.reasons,
      })),
    }))
    items.sort((a: any, b: any) => (b.transaction_date || '').localeCompare(a.transaction_date || ''))
    res.json(items)
  } catch (e) {
    console.error('[payables/review]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/payables/review/:txId/assign { invoice_id } ─────────────────────
router.post('/review/:txId/assign', async (req: Request, res: Response) => {
  try {
    const { invoice_id } = req.body ?? {}
    if (!invoice_id) { res.status(400).json({ error: 'Wymagane pole invoice_id' }); return }
    const tx: any = await db.bank_transactions.find(req.params.txId)
    if (!tx) { res.status(404).json({ error: 'Transakcja nie znaleziona' }); return }

    await markInvoicePaid(invoice_id, { source: 'mt940', amount: Math.abs(tx.amount), paidAt: tx.transaction_date, txId: tx.id })
    await db.bank_transactions.update(tx.id, { matched_invoice_id: invoice_id, match_confidence: 1, review_status: 'assigned' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[payables/review/assign]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/payables/review/:txId/dismiss — to nie płatność za fakturę ──────
router.post('/review/:txId/dismiss', async (req: Request, res: Response) => {
  try {
    await db.bank_transactions.update(req.params.txId, { review_status: 'dismissed' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[payables/review/dismiss]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
