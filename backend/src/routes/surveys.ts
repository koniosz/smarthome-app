import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'
import { requireAuth } from '../middleware/auth'
import { getSmtpConfig, sendSurveyEmail } from '../services/mailer'

const router = Router({ mergeParams: true })

function now() { return new Date().toISOString() }

const BASE_URL = process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4001'

// ── Authenticated endpoints ───────────────────────────────────────────────────

// GET /api/projects/:projectId/surveys
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const surveys = await db.client_surveys.forProject(req.params.projectId)
    res.json(surveys)
  } catch (e: any) {
    console.error('[surveys] GET /', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/surveys
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { client_name, client_email, notes, expires_at } = req.body
    const survey = {
      id: uuidv4(),
      project_id: req.params.projectId,
      token: uuidv4(),
      client_name: client_name || '',
      client_email: client_email || '',
      status: 'draft',
      sent_at: null,
      viewed_at: null,
      submitted_at: null,
      responses: null,
      notes: notes || '',
      expires_at: expires_at || null,
      created_at: now(),
      created_by: req.user?.display_name || req.user?.email || '',
    }
    await db.client_surveys.insert(survey)
    res.status(201).json(survey)
  } catch (e: any) {
    console.error('[surveys] POST /', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/projects/:projectId/surveys/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const survey = await db.client_surveys.find(req.params.id)
    if (!survey) { res.status(404).json({ error: 'Nie znaleziono ankiety' }); return }
    res.json(survey)
  } catch (e: any) {
    console.error('[surveys] GET /:id', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/projects/:projectId/surveys/:id
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const survey = await db.client_surveys.find(req.params.id)
    if (!survey) { res.status(404).json({ error: 'Nie znaleziono ankiety' }); return }
    const { client_name, client_email, notes, expires_at, status } = req.body
    const patch: Record<string, any> = {}
    if (client_name !== undefined) patch.client_name = client_name
    if (client_email !== undefined) patch.client_email = client_email
    if (notes !== undefined) patch.notes = notes
    if (expires_at !== undefined) patch.expires_at = expires_at
    if (status !== undefined) patch.status = status
    const updated = await db.client_surveys.update(req.params.id, patch)
    res.json(updated)
  } catch (e: any) {
    console.error('[surveys] PUT /:id', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/projects/:projectId/surveys/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const survey = await db.client_surveys.find(req.params.id)
    if (!survey) { res.status(404).json({ error: 'Nie znaleziono ankiety' }); return }
    await db.client_surveys.delete(req.params.id)
    res.json({ success: true })
  } catch (e: any) {
    console.error('[surveys] DELETE /:id', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/surveys/:id/send
router.post('/:id/send', requireAuth, async (req: Request, res: Response) => {
  try {
    const survey = await db.client_surveys.find(req.params.id)
    if (!survey) { res.status(404).json({ error: 'Nie znaleziono ankiety' }); return }
    if (!survey.client_email) { res.status(400).json({ error: 'Brak adresu email klienta' }); return }

    const project = await db.projects.find(survey.project_id)
    const projectName = project?.name || 'Projekt'

    const cfg = await getSmtpConfig()
    const surveyUrl = `${BASE_URL}/survey/${survey.token}`

    await sendSurveyEmail(
      survey.client_email,
      survey.client_name || 'Kliencie',
      projectName,
      surveyUrl,
      cfg.fromName,
    )

    const updated = await db.client_surveys.update(req.params.id, {
      status: 'sent',
      sent_at: now(),
    })
    res.json(updated)
  } catch (e: any) {
    console.error('[surveys] POST /:id/send', e.message)
    res.status(500).json({ error: e.message || 'Błąd wysyłki' })
  }
})

// GET /api/projects/:projectId/surveys/:id/attachments/:attachId/download
router.get('/:id/attachments/:attachId/download', requireAuth, async (req: Request, res: Response) => {
  try {
    const attachment = await db.client_survey_attachments.find(req.params.attachId)
    if (!attachment || attachment.survey_id !== req.params.id) {
      res.status(404).json({ error: 'Nie znaleziono załącznika' }); return
    }
    const buffer = Buffer.from(attachment.file_data, 'base64')
    res.setHeader('Content-Type', attachment.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`)
    res.send(buffer)
  } catch (e: any) {
    console.error('[surveys] GET /:id/attachments/:attachId/download', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router

// ── Public endpoints (exported as named handlers for index.ts) ────────────────

// GET /api/surveys/public/:token
export async function publicGetSurvey(req: Request, res: Response): Promise<void> {
  try {
    const survey = await db.client_surveys.findByToken(req.params.token)
    if (!survey) { res.status(404).json({ error: 'Ankieta nie istnieje lub link jest nieprawidłowy' }); return }

    // Mark as viewed if it was in sent state
    if (survey.status === 'sent') {
      await db.client_surveys.update(survey.id, { status: 'viewed', viewed_at: now() })
      survey.status = 'viewed'
      survey.viewed_at = now()
    }

    // Return safe public data (no internal fields)
    const { project, attachments, ...surveyData } = survey as any
    res.json({
      ...surveyData,
      project_name: project?.name || '',
    })
  } catch (e: any) {
    console.error('[surveys] publicGetSurvey', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// POST /api/surveys/public/:token/submit
export async function publicSubmitSurvey(req: Request, res: Response): Promise<void> {
  try {
    const survey = await db.client_surveys.findByToken(req.params.token)
    if (!survey) { res.status(404).json({ error: 'Ankieta nie istnieje' }); return }
    if (survey.status === 'submitted') { res.status(409).json({ error: 'Ankieta została już wypełniona' }); return }

    const { responses } = req.body
    await db.client_surveys.update(survey.id, {
      responses: responses ?? null,
      status: 'submitted',
      submitted_at: now(),
    })
    res.json({ success: true })
  } catch (e: any) {
    console.error('[surveys] publicSubmitSurvey', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
}

// POST /api/surveys/public/:token/attachments
export async function publicAddAttachment(req: Request, res: Response): Promise<void> {
  try {
    const survey = await db.client_surveys.findByToken(req.params.token)
    if (!survey) { res.status(404).json({ error: 'Ankieta nie istnieje' }); return }

    const { file_name, mime_type, file_data, file_size } = req.body
    if (!file_name || !file_data) { res.status(400).json({ error: 'Brak wymaganych pól: file_name, file_data' }); return }

    const attachment = {
      id: uuidv4(),
      survey_id: survey.id,
      file_name,
      mime_type: mime_type || 'application/octet-stream',
      file_data,
      file_size: file_size || 0,
      uploaded_at: now(),
    }
    await db.client_survey_attachments.insert(attachment)
    const { file_data: _, ...meta } = attachment
    res.status(201).json(meta)
  } catch (e: any) {
    console.error('[surveys] publicAddAttachment', e.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
}
