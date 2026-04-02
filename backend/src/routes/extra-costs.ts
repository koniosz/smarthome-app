import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'crypto'
import db from '../db'
import { sendExtraCostApprovalEmail, approvalConfirmationHtml } from '../services/mailer'

const router = Router({ mergeParams: true })

function now() {
  return new Date().toISOString()
}

// GET /api/projects/:projectId/extra-costs
router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await db.extra_costs.forProject(req.params.projectId))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/extra-costs/send — stara ścieżka (oznacz jako wysłane bez emaila)
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids?: string[] }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'Brak pozycji do wysłania' }); return
    }
    const sentAt = now()
    for (const id of ids) {
      const item = await db.extra_costs.find(id)
      if (item && item.project_id === req.params.projectId) {
        await db.extra_costs.update(id, { status: 'sent', sent_at: sentAt, updated_at: sentAt })
      }
    }
    res.json({ sent: ids.length, sent_at: sentAt })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/extra-costs/send-email — wyślij email do klienta z linkami akceptacji
router.post('/send-email', async (req: Request, res: Response) => {
  try {
    const { ids, client_email } = req.body as { ids?: string[]; client_email?: string }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'Brak pozycji do wysłania' }); return
    }
    if (!client_email || !client_email.includes('@')) {
      res.status(400).json({ error: 'Podaj poprawny adres email klienta' }); return
    }

    const project = await db.projects.find(req.params.projectId)
    if (!project) { res.status(404).json({ error: 'Projekt nie znaleziony' }); return }

    // Pobierz pozycje
    const allItems = await db.extra_costs.forProject(req.params.projectId)
    const items = allItems.filter((i: any) => ids.includes(i.id))
    if (items.length === 0) { res.status(400).json({ error: 'Nie znaleziono pozycji' }); return }

    // Generuj wspólny token dla całej wysyłki (batch)
    const token = randomBytes(32).toString('hex')
    const sentAt = now()
    const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')

    // Zapisz token i email do każdej pozycji
    for (const item of items) {
      await db.extra_costs.update(item.id, {
        status: 'sent',
        sent_at: sentAt,
        updated_at: sentAt,
        client_email,
        approval_token: token,
      })
    }

    // Wyślij email
    await sendExtraCostApprovalEmail({
      to: client_email,
      projectName: project.name,
      companyName: process.env.COMPANY_NAME,
      items: items.map((i: any) => ({
        description: i.description,
        quantity: i.quantity,
        unit_price: i.unit_price,
        total_price: i.total_price,
        is_out_of_scope: i.is_out_of_scope,
        notes: i.notes,
      })),
      approveUrl: `${appUrl}/api/extra-costs/approve/${token}`,
      rejectUrl:  `${appUrl}/api/extra-costs/reject/${token}`,
    })

    res.json({ sent: items.length, sent_at: sentAt, email: client_email })
  } catch (e: any) {
    console.error('[extra-costs/send-email]', e)
    res.status(500).json({ error: e.message ?? 'Błąd wysyłania emaila' })
  }
})

// POST /api/projects/:projectId/extra-costs
router.post('/', async (req: Request, res: Response) => {
  try {
    const { description, quantity, unit_price, date, is_out_of_scope, notes } = req.body
    if (!description) { res.status(400).json({ error: 'Opis jest wymagany' }); return }

    const qty = Number(quantity) || 1
    const unitPrice = Number(unit_price) || 0
    const item = {
      id: uuidv4(),
      project_id: req.params.projectId,
      description: String(description).trim(),
      quantity: qty,
      unit_price: unitPrice,
      total_price: qty * unitPrice,
      date: date || new Date().toISOString().slice(0, 10),
      is_out_of_scope: Boolean(is_out_of_scope),
      status: 'pending',
      notes: String(notes || '').trim(),
      created_at: now(),
      updated_at: now(),
    }
    await db.extra_costs.insert(item)
    res.status(201).json(item)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/extra-costs/:id
export async function updateExtraCost(req: Request, res: Response): Promise<void> {
  try {
    const existing = await db.extra_costs.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }

    const { description, quantity, unit_price, date, is_out_of_scope, status, notes } = req.body
    const patch: any = { updated_at: now() }
    if (description !== undefined) patch.description = String(description).trim()
    if (quantity !== undefined) patch.quantity = Number(quantity) || 1
    if (unit_price !== undefined) patch.unit_price = Number(unit_price) || 0
    if (quantity !== undefined || unit_price !== undefined) {
      patch.total_price = (patch.quantity ?? existing.quantity) * (patch.unit_price ?? existing.unit_price)
    }
    if (date !== undefined) patch.date = date
    if (is_out_of_scope !== undefined) patch.is_out_of_scope = Boolean(is_out_of_scope)
    if (status !== undefined) patch.status = status
    if (notes !== undefined) patch.notes = String(notes).trim()

    await db.extra_costs.update(req.params.id, patch)
    res.json(await db.extra_costs.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// DELETE /api/extra-costs/:id
export async function deleteExtraCost(req: Request, res: Response): Promise<void> {
  try {
    const existing = await db.extra_costs.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    await db.extra_costs.delete(req.params.id)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// ── Publiczne endpointy zatwierdzenia (bez JWT) ────────────────────────────────
// GET /api/extra-costs/approve/:token
export async function approveExtraCost(req: Request, res: Response): Promise<void> {
  try {
    const { token } = req.params
    const items = await db.extra_costs.findByToken(token)
    if (!items || items.length === 0) {
      res.status(404).send('<h1>Link nieważny lub już wykorzystany.</h1>'); return
    }

    const project = await db.projects.find(items[0].project_id)
    const total = items.reduce((s: number, i: any) => s + i.total_price, 0)

    for (const item of items) {
      await db.extra_costs.update(item.id, {
        status: 'approved',
        updated_at: now(),
        approval_token: null, // unieważnij token po użyciu
      })
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(approvalConfirmationHtml(true, project?.name ?? '', total))
  } catch (e) {
    res.status(500).send('<h1>Błąd serwera. Spróbuj ponownie.</h1>')
  }
}

// GET /api/extra-costs/reject/:token
export async function rejectExtraCost(req: Request, res: Response): Promise<void> {
  try {
    const { token } = req.params
    const items = await db.extra_costs.findByToken(token)
    if (!items || items.length === 0) {
      res.status(404).send('<h1>Link nieważny lub już wykorzystany.</h1>'); return
    }

    const project = await db.projects.find(items[0].project_id)
    const total = items.reduce((s: number, i: any) => s + i.total_price, 0)

    for (const item of items) {
      await db.extra_costs.update(item.id, {
        status: 'rejected',
        updated_at: now(),
        approval_token: null,
      })
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(approvalConfirmationHtml(false, project?.name ?? '', total))
  } catch (e) {
    res.status(500).send('<h1>Błąd serwera. Spróbuj ponownie.</h1>')
  }
}

export default router
