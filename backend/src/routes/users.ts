import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import db from '../db'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

function now() {
  return new Date().toISOString()
}

function safeUser(u: any) {
  const { password_hash, ...rest } = u
  return rest
}

// GET /api/users
router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json((await db.users.all()).map(safeUser))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/users
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, password, display_name, role } = req.body
    if (!email || !display_name) {
      res.status(400).json({ error: 'Email i imię są wymagane' }); return
    }
    if (await db.users.findByEmail(email.toLowerCase())) {
      res.status(409).json({ error: 'Użytkownik z tym emailem już istnieje' }); return
    }

    const hash = password ? await bcrypt.hash(password, 10) : null
    const user = {
      id: uuidv4(),
      email: email.toLowerCase(),
      display_name,
      role: role === 'admin' ? 'admin' : 'employee',
      azure_oid: null,
      password_hash: hash,
      created_at: now(),
    }
    await db.users.insert(user)
    res.status(201).json(safeUser(user))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/users/:id
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = await db.users.find(req.params.id)
    if (!user) { res.status(404).json({ error: 'Użytkownik nie znaleziony' }); return }

    const patch: any = {}
    if (req.body.display_name !== undefined) patch.display_name = req.body.display_name
    if (req.body.role !== undefined) patch.role = req.body.role === 'admin' ? 'admin' : 'employee'
    if (req.body.password) patch.password_hash = await bcrypt.hash(req.body.password, 10)

    await db.users.update(req.params.id, patch)
    res.json(safeUser(await db.users.find(req.params.id)))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { password } = req.body
    if (!password || password.length < 4) {
      res.status(400).json({ error: 'Hasło musi mieć co najmniej 4 znaki' }); return
    }
    const user = await db.users.find(req.params.id)
    if (!user) { res.status(404).json({ error: 'Użytkownik nie znaleziony' }); return }
    await db.users.update(req.params.id, { password_hash: await bcrypt.hash(password, 10) })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/users/:id
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    if (req.user?.id === req.params.id) {
      res.status(400).json({ error: 'Nie możesz usunąć własnego konta' }); return
    }
    const user = await db.users.find(req.params.id)
    if (!user) { res.status(404).json({ error: 'Użytkownik nie znaleziony' }); return }
    await db.users.delete(req.params.id)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/projects/:projectId/members
router.get('/projects/:projectId/members', async (req: Request, res: Response) => {
  try {
    const members = await db.project_members.forProject(req.params.projectId)
    const users = (await Promise.all(members.map((m: any) => db.users.find(m.user_id))))
      .filter(Boolean)
      .map(safeUser)
    res.json(users)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects/:projectId/members
router.post('/projects/:projectId/members', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { user_id } = req.body
    if (!user_id) { res.status(400).json({ error: 'user_id jest wymagany' }); return }
    if (!await db.users.find(user_id)) {
      res.status(404).json({ error: 'Użytkownik nie znaleziony' }); return
    }
    await db.project_members.add(req.params.projectId, user_id)
    res.status(201).json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/projects/:projectId/members/:userId
router.delete('/projects/:projectId/members/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    await db.project_members.remove(req.params.projectId, req.params.userId)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
