import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'crypto'
import db from '../db'
import { sendHandoverProtocolEmail, handoverSignPageHtml, handoverConfirmationHtml } from '../services/mailer'

// Protokoły odbioru — projektowe (requireAuth) + publiczne podpisanie (bez auth, mount w index.ts).
const router = Router({ mergeParams: true })
const now = () => new Date().toISOString()
const appUrl = () => (process.env.APP_URL ?? 'https://smarthome-app-ssrv.onrender.com').replace(/\/$/, '')
const invalidPage = '<html><body style="font-family:sans-serif;text-align:center;padding:48px"><h2>⚠️ Link nieważny lub wygasł</h2><p>Skontaktuj się z wykonawcą.</p></body></html>'

// GET /api/projects/:projectId/handover
router.get('/', async (req: Request, res: Response) => {
  try { res.json(await db.handover_protocols.forProject(req.params.projectId)) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/projects/:projectId/handover — utwórz protokół (szkic)
router.post('/', async (req: Request, res: Response) => {
  try {
    const project = await db.projects.find(req.params.projectId)
    if (!project) { res.status(404).json({ error: 'Projekt nie znaleziony' }); return }
    const d = new Date()
    const prefix = `PO/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/`
    const count = await db.handover_protocols.countForPrefix(prefix)
    const number = `${prefix}${String(count + 1).padStart(3, '0')}`
    const item = {
      id: uuidv4(), project_id: req.params.projectId, number,
      title: req.body.title ? String(req.body.title).trim() : null,
      scope: req.body.scope ? String(req.body.scope).trim() : null,
      status: 'draft', token: null,
      client_email: req.body.client_email ? String(req.body.client_email).trim() : (project.client_contact?.includes('@') ? project.client_contact : null),
      client_name: null, client_comment: null, signature: null,
      sent_at: null, accepted_at: null,
      created_by: (req as any).user?.id || null, created_at: now(), updated_at: now(),
    }
    await db.handover_protocols.insert(item)
    res.status(201).json(item)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/projects/:projectId/handover/:id/send — wyślij do klienta
router.post('/:id/send', async (req: Request, res: Response) => {
  try {
    const proto: any = await db.handover_protocols.find(req.params.id)
    if (!proto || proto.project_id !== req.params.projectId) { res.status(404).json({ error: 'Protokół nie znaleziony' }); return }
    const client_email = String(req.body.client_email || proto.client_email || '').trim()
    if (!client_email.includes('@')) { res.status(400).json({ error: 'Podaj poprawny adres e-mail klienta' }); return }
    const project = await db.projects.find(req.params.projectId)
    const token = proto.token || randomBytes(24).toString('hex')
    const sentAt = now()
    await db.handover_protocols.update(proto.id, { status: proto.status === 'accepted' ? 'accepted' : 'sent', token, client_email, sent_at: sentAt, updated_at: sentAt })
    await sendHandoverProtocolEmail({
      to: client_email, projectName: project?.name || '', number: proto.number,
      signUrl: `${appUrl()}/api/handover/sign/${token}`, scope: proto.scope || undefined,
    })
    res.json(await db.handover_protocols.find(proto.id))
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Błąd wysyłania e-maila' })
  }
})

// DELETE /api/projects/:projectId/handover/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const proto: any = await db.handover_protocols.find(req.params.id)
    if (!proto || proto.project_id !== req.params.projectId) { res.status(404).json({ error: 'Protokół nie znaleziony' }); return }
    await db.handover_protocols.delete(req.params.id)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Publiczne: strona podpisu (bez auth) ──
export async function handoverSignPage(req: Request, res: Response): Promise<void> {
  try {
    const proto: any = await db.handover_protocols.findByToken(req.params.token)
    if (!proto) { res.status(404).send(invalidPage); return }
    const project = await db.projects.find(proto.project_id)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (proto.status === 'accepted') {
      res.send(handoverConfirmationHtml(project?.name || '', proto.number, proto.client_name || '')); return
    }
    res.send(handoverSignPageHtml({
      projectName: project?.name || '', number: proto.number, scope: proto.scope,
      companyName: process.env.COMPANY_NAME, clientName: project?.client_name,
      postUrl: `${appUrl()}/api/handover/sign/${req.params.token}`,
    }))
  } catch { res.status(500).send('<h1>Błąd serwera.</h1>') }
}

// ── Publiczne: zapis podpisu/akceptacji (bez auth) ──
export async function handoverSubmitSign(req: Request, res: Response): Promise<void> {
  try {
    const proto: any = await db.handover_protocols.findByToken(req.params.token)
    if (!proto) { res.status(404).send(invalidPage); return }
    const project = await db.projects.find(proto.project_id)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (proto.status === 'accepted') {
      res.send(handoverConfirmationHtml(project?.name || '', proto.number, proto.client_name || '')); return
    }
    const signature = String(req.body?.signature || '').trim()
    const comment = String(req.body?.comment || '').trim()
    if (!signature) { res.status(400).send('<html><body style="font-family:sans-serif;text-align:center;padding:48px"><h2>Podpis jest wymagany.</h2><a href="javascript:history.back()">← wróć</a></body></html>'); return }
    const ts = now()
    await db.handover_protocols.update(proto.id, {
      status: 'accepted', signature, client_name: signature, client_comment: comment || null,
      accepted_at: ts, updated_at: ts,
    })
    res.send(handoverConfirmationHtml(project?.name || '', proto.number, signature))
  } catch { res.status(500).send('<h1>Błąd serwera.</h1>') }
}

export default router
