/**
 * Prywatne listy zadań (to-do) — każdy użytkownik widzi i edytuje TYLKO swoje.
 * Admin może podejrzeć listę wybranego pracownika (tylko odczyt — bez edycji).
 */
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'

const router = Router()

function now() { return new Date().toISOString() }
function me(req: Request): { id: string; role: string } {
  const u = (req as any).user
  return { id: u?.id ?? '', role: u?.role ?? 'employee' }
}

// ── GET /api/todos?user_id= — własna lista; admin może podać user_id innej osoby ──
router.get('/', async (req: Request, res: Response) => {
  try {
    const { id, role } = me(req)
    const requested = String(req.query.user_id ?? '') || id
    if (requested !== id && role !== 'admin') {
      res.status(403).json({ error: 'Lista prywatna — brak dostępu' }); return
    }
    const todos = await prisma.personalTodo.findMany({
      where: { user_id: requested },
      orderBy: [{ done: 'asc' }, { due_date: 'asc' }, { created_at: 'asc' }],
    })
    // niedokończone: termin rosnąco (puste na końcu); zrobione na dole, ostatnio odhaczone pierwsze
    todos.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      if (a.done) return (b.done_at || '').localeCompare(a.done_at || '')
      return (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.created_at.localeCompare(b.created_at)
    })
    res.json(todos)
  } catch (e) {
    console.error('[todos]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── POST /api/todos — dodaj własne zadanie ────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id } = me(req)
    const { title, notes, due_date } = req.body ?? {}
    if (!title || !String(title).trim()) { res.status(400).json({ error: 'Treść zadania jest wymagana' }); return }
    const todo = await prisma.personalTodo.create({ data: {
      id: uuidv4(), user_id: id,
      title: String(title).trim().slice(0, 500),
      notes: String(notes ?? '').slice(0, 2000),
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(due_date ?? '')) ? String(due_date) : '',
      done: false, created_at: now(), updated_at: now(),
    }})
    res.status(201).json(todo)
  } catch (e) {
    console.error('[todos/create]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── PATCH /api/todos/:id — edycja/odhaczenie (tylko właściciel) ───────────────
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = me(req)
    const todo = await prisma.personalTodo.findUnique({ where: { id: req.params.id } })
    if (!todo || todo.user_id !== id) { res.status(404).json({ error: 'Zadanie nie znalezione' }); return }

    const { title, notes, due_date, done } = req.body ?? {}
    const patch: any = { updated_at: now() }
    if (title !== undefined) {
      if (!String(title).trim()) { res.status(400).json({ error: 'Treść zadania jest wymagana' }); return }
      patch.title = String(title).trim().slice(0, 500)
    }
    if (notes !== undefined) patch.notes = String(notes ?? '').slice(0, 2000)
    if (due_date !== undefined) patch.due_date = /^\d{4}-\d{2}-\d{2}$/.test(String(due_date ?? '')) ? String(due_date) : ''
    if (done !== undefined) {
      patch.done = Boolean(done)
      patch.done_at = done ? now() : null
    }
    res.json(await prisma.personalTodo.update({ where: { id: req.params.id }, data: patch }))
  } catch (e) {
    console.error('[todos/update]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── DELETE /api/todos/:id — usuń (tylko właściciel) ───────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = me(req)
    const todo = await prisma.personalTodo.findUnique({ where: { id: req.params.id } })
    if (!todo || todo.user_id !== id) { res.status(404).json({ error: 'Zadanie nie znalezione' }); return }
    await prisma.personalTodo.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  } catch (e) {
    console.error('[todos/delete]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ── DELETE /api/todos/done/clear — wyczyść ukończone (tylko własne) ───────────
router.delete('/done/clear', async (req: Request, res: Response) => {
  try {
    const { id } = me(req)
    const r = await prisma.personalTodo.deleteMany({ where: { user_id: id, done: true } })
    res.json({ deleted: r.count })
  } catch (e) {
    console.error('[todos/clear]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
