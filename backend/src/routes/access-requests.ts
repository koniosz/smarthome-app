import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'
import { requireAdmin } from '../middleware/auth'

const router = Router()

function now() {
  return new Date().toISOString()
}

// POST /api/access-requests
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Brak autoryzacji' }); return }
    if (user.role === 'admin') {
      res.status(400).json({ error: 'Administrator ma dostęp do wszystkich projektów' }); return
    }

    const { project_id } = req.body
    if (!project_id) { res.status(400).json({ error: 'project_id jest wymagany' }); return }

    const project = await db.projects.find(project_id)
    if (!project) { res.status(404).json({ error: 'Projekt nie znaleziony' }); return }

    if (await db.project_members.has(project_id, user.id)) {
      res.status(400).json({ error: 'Masz już dostęp do tego projektu' }); return
    }

    if (await db.access_requests.pendingForUser(project_id, user.id)) {
      res.status(400).json({ error: 'Wniosek o dostęp już oczekuje na rozpatrzenie' }); return
    }

    const request: any = {
      id: uuidv4(),
      project_id,
      project_name: project.name,
      requester_id: user.id,
      requester_name: user.display_name,
      requester_email: user.email,
      status: 'pending',
      created_at: now(),
      updated_at: now(),
    }
    await db.access_requests.insert(request)

    const admins = (await db.users.all()).filter((u: any) => u.role === 'admin')
    for (const admin of admins) {
      await db.notifications.insert({
        id: uuidv4(),
        user_id: admin.id,
        type: 'access_request',
        message: `${user.display_name} prosi o dostęp do projektu „${project.name}"`,
        data: {
          request_id: request.id,
          project_id,
          project_name: project.name,
          requester_id: user.id,
          requester_name: user.display_name,
        },
        read: false,
        created_at: now(),
      })
    }

    if (project.created_by && !admins.find((a: any) => a.id === project.created_by)) {
      await db.notifications.insert({
        id: uuidv4(),
        user_id: project.created_by,
        type: 'access_request',
        message: `${user.display_name} prosi o dostęp do projektu „${project.name}"`,
        data: {
          request_id: request.id,
          project_id,
          project_name: project.name,
          requester_id: user.id,
          requester_name: user.display_name,
        },
        read: false,
        created_at: now(),
      })
    }

    res.status(201).json(request)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/access-requests
router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await db.access_requests.all())
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/access-requests/:id
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const request = await db.access_requests.find(req.params.id)
    if (!request) { res.status(404).json({ error: 'Wniosek nie znaleziony' }); return }

    const { status } = req.body
    if (!['approved', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'status musi być "approved" lub "rejected"' }); return
    }
    if (request.status !== 'pending') {
      res.status(400).json({ error: 'Wniosek został już rozpatrzony' }); return
    }

    await db.access_requests.update(req.params.id, { status, updated_at: now() })

    if (status === 'approved') {
      await db.project_members.add(request.project_id, request.requester_id)
    }

    const resolvedType = status === 'approved' ? 'access_approved' : 'access_rejected'
    await db.notifications.resolveByRequestId(req.params.id, resolvedType)

    const project = await db.projects.find(request.project_id)
    await db.notifications.insert({
      id: uuidv4(),
      user_id: request.requester_id,
      type: status === 'approved' ? 'access_approved' : 'access_rejected',
      message: status === 'approved'
        ? `Twój wniosek o dostęp do projektu „${project?.name ?? request.project_name}" został zaakceptowany ✅`
        : `Twój wniosek o dostęp do projektu „${project?.name ?? request.project_name}" został odrzucony ❌`,
      data: {
        request_id: request.id,
        project_id: request.project_id,
        project_name: project?.name ?? request.project_name,
      },
      read: false,
      created_at: now(),
    })

    res.json(await db.access_requests.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
