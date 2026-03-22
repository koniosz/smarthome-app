import { Router, Request, Response } from 'express'
import db from '../db'

const router = Router()

// GET /api/notifications
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Brak autoryzacji' }); return }
    res.json(await db.notifications.forUser(user.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/notifications/unread-count
router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Brak autoryzacji' }); return }
    res.json({ count: await db.notifications.unreadCount(user.id) })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/notifications/read
router.put('/read', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Brak autoryzacji' }); return }
    const { ids } = req.body
    await db.notifications.markRead(user.id, ids)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
