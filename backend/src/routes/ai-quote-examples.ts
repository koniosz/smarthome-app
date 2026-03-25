import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'
import { requireAuth, requireAdmin } from '../middleware/auth'

const router = Router()

const now = () => new Date().toISOString()

// GET /api/ai-quote-examples — lista wszystkich wzorców (admin only)
router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const examples = await db.ai_quote_examples.all()
    res.json(examples)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/ai-quote-examples — zapisz wycenę jako wzorzec
// Może wywołać każdy zalogowany user (z edytora wyceny)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      title,
      project_type,
      brands,
      area_m2,
      rooms_count,
      ai_prompt,
      ai_items,
      final_items,
      final_total_net,
      human_notes,
      source_quote_id,
    } = req.body

    if (!final_items || !Array.isArray(final_items) || final_items.length === 0) {
      res.status(400).json({ error: 'final_items jest wymagane i musi być niepustą tablicą' })
      return
    }
    if (!title || String(title).trim().length < 3) {
      res.status(400).json({ error: 'Podaj tytuł wzorca (min. 3 znaki)' })
      return
    }

    const user = (req as any).user
    const example = {
      id: uuidv4(),
      title: String(title).trim(),
      project_type: String(project_type || 'residential'),
      brands: Array.isArray(brands) ? brands : [],
      area_m2: area_m2 ? Number(area_m2) : null,
      rooms_count: rooms_count ? Number(rooms_count) : null,
      ai_prompt: ai_prompt ? String(ai_prompt) : null,
      ai_items: ai_items || null,
      final_items,
      final_total_net: final_total_net ? Number(final_total_net) : null,
      human_notes: human_notes ? String(human_notes).trim() : null,
      approved_by: user?.id || null,
      approved_by_name: user?.display_name || user?.email || null,
      source_quote_id: source_quote_id || null,
      created_at: now(),
    }

    const saved = await db.ai_quote_examples.insert(example)
    res.status(201).json(saved)
  } catch (err: any) {
    console.error('[AI Examples] Błąd zapisu wzorca:', err.message)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/ai-quote-examples/:id — usuń wzorzec (admin only)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const existing = await db.ai_quote_examples.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Wzorzec nie znaleziony' })
      return
    }
    await db.ai_quote_examples.delete(req.params.id)
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
