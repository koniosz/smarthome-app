/**
 * Panel Płatności (zobowiązania) — faktury kosztowe z KSeF do opłacenia + import MT940.
 * Dostęp: admin lub użytkownik z flagą can_view_payments (księgowy).
 *
 * Przepływ MT940: upload pliku → parsowanie → deduplikacja → auto-dopasowanie
 * obciążeń do nieopłaconych faktur (pewność ≥ AUTO_MATCH_THRESHOLD ⇒ faktura
 * oznaczona jako opłacona). Niedopasowane obciążenia lądują na liście
 * „do sprawdzenia" z kandydatami do ręcznego przypisania.
 */
import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { parseMT940 } from '../utils/mt940Parser'
import db, { prisma } from '../db'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const AUTO_MATCH_THRESHOLD = 0.75
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

function invoiceView(inv: any) {
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
    project_id: inv.project_id,
    overdue: isOverdue(inv),
  }
}

// ── Scoring dopasowania obciążenia bankowego do faktury ──────────────────────
function alnum(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Pole :86: z mBanku ma subpola ~NN — wyciągnij czytelny tytuł (~20–25),
// kontrahenta (~32–33) i IBAN (~38). Bez subpól zwraca dane bez zmian.
export function cleanMt940Fields(tx: { description: string; counterparty: string; counterparty_iban: string }) {
  const d = tx.description || ''
  if (!d.includes('~')) return { description: d, counterparty: tx.counterparty, counterparty_iban: tx.counterparty_iban }
  const fields: Record<string, string> = {}
  for (const part of d.split('~')) {
    const code = part.slice(0, 2)
    if (/^\d{2}$/.test(code)) fields[code] = ((fields[code] || '') + ' ' + part.slice(2)).trim()
  }
  const title = ['20', '21', '22', '23', '24', '25'].map(c => fields[c] || '').join(' ').replace(/\s+/g, ' ').trim()
  const cp = ['32', '33'].map(c => fields[c] || '').join(' ').replace(/\s+/g, ' ').trim()
  const iban = (fields['38'] || '').replace(/\s+/g, '')
  return {
    description: title || d,
    counterparty: cp || tx.counterparty,
    counterparty_iban: iban || tx.counterparty_iban,
  }
}

export function scoreMatch(tx: any, inv: any): { confidence: number; reasons: string[] } {
  let confidence = 0
  const reasons: string[] = []
  const txAbs = Math.abs(tx.amount)
  const gross = inv.gross_amount || 0
  const desc = `${tx.description || ''} ${tx.counterparty || ''}`
  const descAlnum = alnum(desc)

  // Kwota — najsilniejszy sygnał. Tolerancja na prowizję pośrednika (P24/BLIK):
  // max(5 zł, 2% brutto). Zgodna kwota + zgodny kontrahent ⇒ automatyczna kwalifikacja.
  const diff = Math.abs(txAbs - gross)
  const feeTolerance = Math.max(5, gross * 0.02)
  if (diff <= 0.01) {
    confidence += 0.55; reasons.push('kwota')
  } else if (gross > 0 && diff <= feeTolerance) {
    confidence += 0.5; reasons.push('kwota ±prowizja')
  }

  // Numer faktury w tytule przelewu (porównanie po znakach alfanumerycznych)
  const invNum = alnum(inv.invoice_number || '')
  if (invNum.length >= 5 && descAlnum.includes(invNum)) {
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

  return { confidence: Math.min(1, confidence), reasons }
}

function bestMatches(tx: any, invoices: any[], limit: number) {
  return invoices
    .map(inv => ({ invoice: inv, ...scoreMatch(tx, inv) }))
    .filter(m => m.confidence >= CANDIDATE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit)
}

// Wybór faktury do automatycznego oznaczenia — wspólne dla importu i ponownego
// dopasowania. Zwraca null przy braku kwalifikującego dopasowania lub realnej
// niejednoznaczności (dwie faktury kwalifikują się jednocześnie; dokładna kwota
// wygrywa z kwotą ±prowizja).
function pickAutoMatch(tx: any, candidates: any[]): { invoice: any; confidence: number; reasons: string[] } | null {
  const [best, second] = bestMatches(tx, candidates, 2)
  if (!best || best.confidence < AUTO_MATCH_THRESHOLD) return null
  const bestExact = best.reasons.includes('kwota')
  const secondExact = !!second && second.reasons.includes('kwota')
  const ambiguous = !!second
    && second.confidence >= AUTO_MATCH_THRESHOLD
    && best.confidence - second.confidence < 0.1
    && !(bestExact && !secondExact)
  return ambiguous ? null : best
}

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

    res.json(list.slice(0, 500).map(invoiceView))
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

// ── POST /api/payables/import-mt940 — upload + auto-dopasowanie w jednym kroku ─
router.post('/import-mt940', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Brak pliku. Wyślij plik w polu "file".' }); return }

    let content = req.file.buffer.toString('utf-8')
    if (content.includes('�')) content = req.file.buffer.toString('latin1')

    const parsed = parseMT940(content)
    if (!parsed.length) { res.status(400).json({ error: 'Nie znaleziono transakcji w pliku. Sprawdź, czy to poprawny wyciąg MT940.' }); return }

    // Deduplikacja względem już zaimportowanych (data + kwota + referencja + opis).
    // Klucze liczone na OPISACH ZNORMALIZOWANYCH (cleanMt940Fields jest no-opem dla czystych opisów),
    // żeby złapać też wiersze zapisane surowo przez starszy import /api/bank/import-mt940.
    // Licznik wystąpień zamiast Set: dwa identyczne autentyczne przelewy tego samego dnia
    // nie mogą się nawzajem "deduplikować".
    const existing = await db.bank_transactions.list({ source: 'mt940' })
    const keyOf = (t: { date?: string; transaction_date?: string; amount: number; description?: string; reference?: string }) =>
      `${t.date ?? t.transaction_date}|${t.amount.toFixed(2)}|${alnum(t.reference || '')}|${alnum(t.description || '').slice(0, 80)}`
    const existingCount = new Map<string, number>()
    for (const t of existing) {
      const k = keyOf({ ...t, ...cleanMt940Fields(t) })
      existingCount.set(k, (existingCount.get(k) ?? 0) + 1)
    }

    const unpaidInvoices = (await db.ksef_invoices.listAll()).filter((i: any) => isIncoming(i) && isUnpaid(i))
    const paidNow = new Set<string>() // faktury opłacone w trakcie tego importu

    let imported = 0, duplicates = 0, autoMatched = 0, toReview = 0, credits = 0
    const matchedDetails: any[] = []

    for (const rawTx of parsed) {
      // transaction_date jawnie: scoreMatch i insert czytają to pole, a parser zwraca `date`
      const tx = { ...rawTx, ...cleanMt940Fields(rawTx), transaction_date: rawTx.date }
      const key = keyOf(tx)
      const remaining = existingCount.get(key) ?? 0
      if (remaining > 0) { existingCount.set(key, remaining - 1); duplicates++; continue }

      const id = uuidv4()
      const isDebit = tx.amount < 0
      let matchedInvoiceId: string | null = null
      let matchConfidence: number | null = null
      let reviewStatus = 'pending'

      if (!isDebit) {
        // Uznania (wpływy) nie dotyczą płacenia faktur kosztowych — pomijamy w sprawdzaniu
        reviewStatus = 'dismissed'
        credits++
      } else if (tx.is_reversal) {
        // Storno (RC) to zwrot wcześniejszej transakcji, nie płatność — nie dopasowujemy
        // automatycznie; ląduje na liście "do sprawdzenia" do ręcznej decyzji
        toReview++
      } else {
        const candidates = unpaidInvoices.filter((i: any) => !paidNow.has(i.id))
        const best = pickAutoMatch(tx, candidates)
        if (best) {
          matchedInvoiceId = best.invoice.id
          matchConfidence = best.confidence
          reviewStatus = 'matched'
          await markInvoicePaid(best.invoice.id, { source: 'mt940', amount: Math.abs(tx.amount), paidAt: tx.date, txId: id })
          paidNow.add(best.invoice.id)
          matchedDetails.push({
            invoice_id: best.invoice.id, invoice_number: best.invoice.invoice_number,
            seller_name: best.invoice.seller_name, amount: Math.abs(tx.amount),
            confidence: best.confidence, reasons: best.reasons,
          })
          autoMatched++
        } else {
          toReview++
        }
      }

      await db.bank_transactions.insert({
        id, source: 'mt940',
        transaction_date: tx.date, amount: tx.amount, currency: 'PLN',
        description: tx.description, counterparty: tx.counterparty,
        counterparty_iban: tx.counterparty_iban, reference: tx.reference,
        matched_invoice_id: matchedInvoiceId, match_confidence: matchConfidence,
        review_status: reviewStatus, created_at: now(),
      })
      imported++
    }

    res.json({ imported, duplicates, auto_matched: autoMatched, to_review: toReview, credits_skipped: credits, matched: matchedDetails })
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
router.get('/invoices/:id/xml', async (req: Request, res: Response) => {
  try {
    const invoice = await prisma.ksefInvoice.findUnique({ where: { id: req.params.id } })
    if (!invoice) { res.status(404).json({ error: 'Faktura nie znaleziona' }); return }
    if (!invoice.ksef_number) { res.status(400).json({ error: 'Brak numeru KSeF' }); return }
    const { getActiveSession } = await import('../services/ksef')
    const axios = (await import('axios')).default
    const xmlRes = await axios.get(
      `https://api.ksef.mf.gov.pl/v2/invoices/ksef/${encodeURIComponent(invoice.ksef_number)}`,
      { headers: { Authorization: `Bearer ${await getActiveSession()}` }, responseType: 'text', timeout: 15000 },
    )
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="faktura-${(invoice.invoice_number ?? invoice.ksef_number).replace(/[^\w.-]/g, '_')}.xml"`)
    res.send(xmlRes.data)
  } catch (err: any) {
    const msg = err?.response ? `KSeF HTTP ${err.response.status}` : err.message
    res.status(500).json({ error: msg })
  }
})

// ── POST /api/payables/fetch-due-dates — uzupełnij terminy płatności z XML KSeF ──
// Nieopłacone faktury kosztowe bez terminu (null = nigdy nie pobrano; '' = faktura
// nie ma terminu w XML — nie ponawiamy). Partia max 30 na wywołanie (limiter XML
// w ksef-lineitems trzyma równoległość 2, a limit partii chroni rate-limit KSeF).
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

// ── POST /api/payables/rematch — przepuść zaległe obciążenia przez aktualne reguły ─
// Auto-dopasowanie działa przy imporcie; po zmianie reguł (albo po dojściu nowych
// faktur z KSeF) ten endpoint ponownie ocenia listę "do sprawdzenia".
router.post('/rematch', async (_req: Request, res: Response) => {
  try {
    const pending = await db.bank_transactions.list({ matched_invoice_id: null, review_status: 'pending', amount: { lt: 0 } })
    const unpaidInvoices = (await db.ksef_invoices.listAll()).filter((i: any) => isIncoming(i) && isUnpaid(i))
    const paidNow = new Set<string>()
    let matched = 0
    const details: any[] = []

    for (const tx of pending) {
      const candidates = unpaidInvoices.filter((i: any) => !paidNow.has(i.id))
      const best = pickAutoMatch(tx, candidates)
      if (!best) continue
      await markInvoicePaid(best.invoice.id, { source: 'mt940', amount: Math.abs(tx.amount), paidAt: tx.transaction_date, txId: tx.id })
      await db.bank_transactions.update(tx.id, { matched_invoice_id: best.invoice.id, match_confidence: best.confidence, review_status: 'matched' })
      paidNow.add(best.invoice.id)
      matched++
      details.push({
        invoice_id: best.invoice.id, invoice_number: best.invoice.invoice_number,
        seller_name: best.invoice.seller_name, amount: Math.abs(tx.amount),
        confidence: best.confidence, reasons: best.reasons,
      })
    }

    res.json({ checked: pending.length, matched, remaining: pending.length - matched, details })
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
