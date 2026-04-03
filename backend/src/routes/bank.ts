import { Router, Request, Response } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { parseMT940 } from '../utils/mt940Parser'
import { getPrzelewy24Status, getTransactions as p24GetTransactions } from '../utils/przelewy24Client'
import db from '../db'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

// ─── POST /api/bank/import-mt940 ─────────────────────────────────────────────
router.post('/import-mt940', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Brak pliku. Wyślij plik w polu "file".' })
    }

    // Try UTF-8 first, fallback to latin1 (MT940 from mBank often uses ISO-8859-1)
    let content: string
    try {
      content = req.file.buffer.toString('utf-8')
      // Quick check — if garbled Polish chars appear, try latin1
      if (content.includes('\ufffd')) {
        content = req.file.buffer.toString('latin1')
      }
    } catch {
      content = req.file.buffer.toString('latin1')
    }

    const parsed = parseMT940(content)

    const now = new Date().toISOString()
    const saved: any[] = []

    for (const tx of parsed) {
      const id = uuidv4()
      const record = await db.bank_transactions.insert({
        id,
        source:           'mt940',
        transaction_date: tx.date,
        amount:           tx.amount,
        currency:         'PLN',
        description:      tx.description,
        counterparty:     tx.counterparty,
        counterparty_iban: tx.counterparty_iban,
        reference:        tx.reference,
        matched_invoice_id: null,
        match_confidence:   null,
        created_at:       now,
      })
      saved.push(record)
    }

    return res.json({ imported: saved.length, transactions: saved })
  } catch (err: any) {
    console.error('[bank/import-mt940]', err)
    return res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/bank/match ──────────────────────────────────────────────────────
router.post('/match', async (_req: Request, res: Response) => {
  try {
    const unmatched = await db.bank_transactions.findUnmatched()
    const invoices  = await db.ksef_invoices.listAll()

    interface MatchResult {
      tx_id: string
      invoice_id: string
      confidence: number
      reason: string[]
    }

    const results: MatchResult[] = []
    let matchedCount = 0

    for (const tx of unmatched) {
      let bestMatch: { invoiceId: string; confidence: number; reasons: string[] } | null = null

      for (const invoice of invoices) {
        let confidence = 0
        const reasons: string[] = []

        // For cost invoices (we pay suppliers): look for DEBIT transactions (negative amount)
        // For P24 transactions (we receive payments): look for CREDIT transactions (positive amount)
        const txAbs = Math.abs(tx.amount)
        const invGross = invoice.gross_amount

        // Amount match within 0.01 tolerance
        if (Math.abs(txAbs - invGross) <= 0.01) {
          confidence += 0.5
          reasons.push('kwota')
        } else if (Math.abs(txAbs - invGross) / Math.max(invGross, 1) < 0.02) {
          // within 2% — partial match
          confidence += 0.25
          reasons.push('kwota~')
        }

        // For MT940 cost invoices: expect debit transactions
        if (tx.source === 'mt940' && tx.amount < 0) {
          confidence += 0.1
          reasons.push('kierunek:obciążenie')
        }
        // For P24: expect credit (incoming)
        if (tx.source === 'przelewy24' && tx.amount > 0) {
          confidence += 0.1
          reasons.push('kierunek:uznanie')
        }

        // Check same month
        if (invoice.invoice_date && tx.transaction_date) {
          const invMonth = invoice.invoice_date.slice(0, 7)
          const txMonth  = tx.transaction_date.slice(0, 7)
          if (invMonth === txMonth) {
            confidence += 0.1
            reasons.push('miesiąc')
          }
        }

        // NIP match in description
        if (invoice.seller_nip) {
          const nipClean = invoice.seller_nip.replace(/[^0-9]/g, '')
          if (nipClean.length === 10 && tx.description.includes(nipClean)) {
            confidence += 0.2
            reasons.push('NIP')
          }
        }

        // Invoice number in description
        if (invoice.invoice_number) {
          const invNum = invoice.invoice_number.trim()
          if (invNum && tx.description.toLowerCase().includes(invNum.toLowerCase())) {
            confidence += 0.2
            reasons.push('nr faktury')
          }
        }

        // Check if invoice already has a payment status
        if (invoice.payment_status === 'paid') {
          confidence = 0 // skip already paid
        }

        if (confidence > (bestMatch?.confidence ?? 0)) {
          bestMatch = { invoiceId: invoice.id, confidence, reasons }
        }
      }

      if (bestMatch && bestMatch.confidence >= 0.6) {
        // Mark as matched
        await db.bank_transactions.update(tx.id, {
          matched_invoice_id: bestMatch.invoiceId,
          match_confidence:   bestMatch.confidence,
        })

        await db.ksef_invoices.updatePayment(bestMatch.invoiceId, {
          payment_status: 'paid',
          payment_source: tx.source === 'przelewy24' ? 'przelewy24' : 'mt940',
          paid_amount:    Math.abs(tx.amount),
          paid_at:        tx.transaction_date,
          bank_tx_id:     tx.id,
        })

        results.push({
          tx_id:      tx.id,
          invoice_id: bestMatch.invoiceId,
          confidence: bestMatch.confidence,
          reason:     bestMatch.reasons,
        })
        matchedCount++
      }
    }

    return res.json({ matched: matchedCount, details: results })
  } catch (err: any) {
    console.error('[bank/match]', err)
    return res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/bank/transactions ──────────────────────────────────────────────
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { source, matched } = req.query as Record<string, string>

    const filter: any = {}
    if (source && source !== 'all') filter.source = source
    if (matched === 'true')  filter.matched_invoice_id = { not: null }
    if (matched === 'false') filter.matched_invoice_id = null

    const transactions = await db.bank_transactions.list(
      Object.keys(filter).length > 0 ? filter : undefined
    )

    return res.json(transactions)
  } catch (err: any) {
    console.error('[bank/transactions]', err)
    return res.status(500).json({ error: err.message })
  }
})

// ─── DELETE /api/bank/transactions ───────────────────────────────────────────
router.delete('/transactions', async (_req: Request, res: Response) => {
  try {
    await db.bank_transactions.deleteAll()
    return res.json({ success: true })
  } catch (err: any) {
    console.error('[bank/transactions delete]', err)
    return res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/bank/przelewy24/status ─────────────────────────────────────────
router.get('/przelewy24/status', (_req: Request, res: Response) => {
  const status = getPrzelewy24Status()
  return res.json(status)
})

// ─── POST /api/bank/przelewy24/sync ──────────────────────────────────────────
router.post('/przelewy24/sync', async (_req: Request, res: Response) => {
  try {
    const { configured } = getPrzelewy24Status()
    if (!configured) {
      return res.status(400).json({
        error: 'Przelewy24 nie jest skonfigurowane. Ustaw zmienne P24_MERCHANT_ID, P24_API_KEY, P24_CRC.',
      })
    }

    const dateTo   = new Date().toISOString().split('T')[0]
    const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const p24Txs = await p24GetTransactions(dateFrom, dateTo)

    const now = new Date().toISOString()
    const saved: any[] = []

    for (const tx of p24Txs) {
      if (tx.status !== 1) continue // only completed transactions

      const id = uuidv4()
      // P24 amounts are in grosze (1/100 PLN)
      const amountPLN = tx.amount / 100

      const record = await db.bank_transactions.insert({
        id,
        source:           'przelewy24',
        transaction_date: tx.date.split('T')[0] ?? tx.date,
        amount:           amountPLN, // positive = credit (received payment)
        currency:         tx.currency || 'PLN',
        description:      tx.description,
        counterparty:     tx.email,
        counterparty_iban: '',
        reference:        String(tx.orderId),
        matched_invoice_id: null,
        match_confidence:   null,
        created_at:       now,
      })
      saved.push(record)
    }

    return res.json({ imported: saved.length, transactions: saved })
  } catch (err: any) {
    console.error('[bank/przelewy24/sync]', err)
    return res.status(500).json({ error: err.message })
  }
})

// ─── PATCH /api/ksef/invoices/:id/payment — Manual override ──────────────────
// NOTE: This handler is exported and registered in index.ts as
//       app.patch('/api/ksef/invoices/:id/payment', updateKsefPayment)
export async function updateKsefPayment(req: Request, res: Response) {
  try {
    const { id } = req.params
    const { status, paid_amount, paid_at } = req.body as {
      status: 'paid' | 'unpaid'
      paid_amount?: number
      paid_at?: string
    }

    if (!status || !['paid', 'unpaid'].includes(status)) {
      return res.status(400).json({ error: 'Wymagane pole status: "paid" | "unpaid"' })
    }

    const updated = await db.ksef_invoices.updatePayment(id, {
      payment_status: status === 'unpaid' ? 'unpaid' : 'paid',
      payment_source: 'manual',
      paid_amount:    paid_amount ?? null,
      paid_at:        paid_at ?? (status === 'paid' ? new Date().toISOString().split('T')[0] : null),
      bank_tx_id:     null,
    })

    return res.json(updated)
  } catch (err: any) {
    console.error('[ksef/invoices/:id/payment]', err)
    return res.status(500).json({ error: err.message })
  }
}

// ─── POST /api/bank/przelewy24/webhook ───────────────────────────────────────
// This is exported so index.ts can register it BEFORE requireAuth
export async function p24WebhookHandler(req: Request, res: Response) {
  try {
    const { orderId, sessionId, amount, sign, originAmount, currency, statement } = req.body

    const { configured, merchantId: mId } = getPrzelewy24Status()
    if (!configured) {
      return res.status(400).json({ error: 'P24 not configured' })
    }

    // Verify signature
    const crc = process.env.P24_CRC || ''
    const crypto = require('crypto')
    const expectedSign = crypto
      .createHash('sha384')
      .update(JSON.stringify({ sessionId, orderId, amount, currency: currency || 'PLN', crc }))
      .digest('hex')

    if (sign !== expectedSign) {
      console.warn('[P24 webhook] Invalid signature')
      return res.status(400).json({ error: 'Invalid signature' })
    }

    // Find matching bank transaction by reference (orderId)
    const txs = await db.bank_transactions.list({ reference: String(orderId) })
    const tx  = txs[0]

    if (tx && tx.matched_invoice_id) {
      await db.ksef_invoices.updatePayment(tx.matched_invoice_id, {
        payment_status: 'paid',
        payment_source: 'przelewy24',
        paid_amount:    amount / 100,
        paid_at:        new Date().toISOString().split('T')[0],
        bank_tx_id:     tx.id,
      })
    }

    return res.json({ received: true })
  } catch (err: any) {
    console.error('[P24 webhook]', err)
    return res.status(500).json({ error: err.message })
  }
}

export default router
