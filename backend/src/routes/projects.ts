import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

const router = Router()

function now() {
  return new Date().toISOString()
}

async function computeCosts(projectId: string) {
  const costItems = await db.cost_items.forProject(projectId)
  const laborEntries = await db.labor_entries.forProject(projectId)
  const payments = await db.client_payments.forProject(projectId)

  const cost_materials = costItems
    .filter((i: any) => i.category === 'materials')
    .reduce((s: number, i: any) => s + i.total_price, 0)
  const cost_subcontractors = costItems
    .filter((i: any) => i.category === 'subcontractor')
    .reduce((s: number, i: any) => s + i.total_price, 0)
  const cost_other = costItems
    .filter((i: any) => i.category === 'other')
    .reduce((s: number, i: any) => s + i.total_price, 0)
  const cost_labor = laborEntries.reduce((s: number, e: any) => s + e.hours * e.hourly_rate, 0)
  const cost_total = costItems.reduce((s: number, i: any) => s + i.total_price, 0) + cost_labor
  const payments_total = payments.reduce((s: number, p: any) => s + p.amount, 0)

  return { cost_materials, cost_subcontractors, cost_other, cost_labor, cost_total, payments_total }
}

// GET /api/projects
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    const allProjects = await db.projects.all()

    let memberProjectIds: Set<string> | null = null
    let pendingRequestProjectIds: Set<string> = new Set()

    if (user && user.role === 'employee') {
      const members = await db.project_members.forUser(user.id)
      memberProjectIds = new Set(members.map((m: any) => m.project_id))
      const allRequests = await db.access_requests.all()
      const pendingRequests = allRequests.filter(
        (r: any) => r.requester_id === user.id && r.status === 'pending'
      )
      pendingRequestProjectIds = new Set(pendingRequests.map((r: any) => r.project_id))
    }

    const result = await Promise.all(allProjects.map(async (p: any) => {
      const isCreator = user && p.created_by === user.id
      const isMember = memberProjectIds === null || memberProjectIds.has(p.id) || isCreator
      const hasPendingRequest = pendingRequestProjectIds.has(p.id)

      if (!isMember) {
        return {
          id: p.id, name: p.name, client_name: p.client_name,
          project_type: p.project_type, status: p.status,
          budget_amount: 0, area_m2: null, smart_features: [],
          start_date: p.start_date, end_date: p.end_date,
          description: '', created_at: p.created_at, updated_at: p.updated_at,
          user_is_member: false, has_pending_request: hasPendingRequest,
        }
      }

      const costs = await computeCosts(p.id)
      const revenue = Math.max(p.budget_amount, costs.payments_total)
      const margin_pln = revenue - costs.cost_total
      const margin_pct = revenue > 0 ? (margin_pln / revenue) * 100 : 0
      return { ...p, ...costs, margin_pln, margin_pct, user_is_member: true, has_pending_request: false }
    }))

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/projects
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    const {
      name, client_name, client_contact, project_type,
      status, budget_amount, area_m2, smart_features,
      start_date, end_date, description
    } = req.body

    if (!name) {
      res.status(400).json({ error: 'Nazwa projektu jest wymagana' })
      return
    }

    const project = {
      id: uuidv4(),
      name,
      client_name: client_name || '',
      client_contact: client_contact || '',
      project_type: project_type || 'installation',
      status: status || 'offer_submitted',
      budget_amount: budget_amount || 0,
      area_m2: area_m2 ? parseFloat(area_m2) : null,
      smart_features: Array.isArray(smart_features) ? smart_features : [],
      start_date: start_date || null,
      end_date: end_date || null,
      description: description || '',
      created_at: now(),
      updated_at: now(),
      created_by: user?.id || null,
    }

    await db.projects.insert(project)

    if (user?.id && user.role !== 'admin') {
      await db.project_members.add(project.id, user.id)
    }

    res.status(201).json(project)
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/projects/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const project = await db.projects.find(req.params.id)
    if (!project) {
      res.status(404).json({ error: 'Projekt nie znaleziony' })
      return
    }

    const [costs, costItems, laborEntries, clientPayments] = await Promise.all([
      computeCosts(req.params.id),
      db.cost_items.forProject(req.params.id),
      db.labor_entries.forProject(req.params.id),
      db.client_payments.forProject(req.params.id),
    ])

    const revenue = Math.max(project.budget_amount, costs.payments_total)
    const margin_pln = revenue - costs.cost_total
    const margin_pct = revenue > 0 ? (margin_pln / revenue) * 100 : 0

    res.json({
      ...project,
      ...costs,
      margin_pln,
      margin_pct,
      cost_items: costItems,
      labor_entries: laborEntries,
      client_payments: clientPayments,
    })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/projects/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.projects.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Projekt nie znaleziony' })
      return
    }

    const {
      name, client_name, client_contact, project_type,
      status, budget_amount, area_m2, smart_features,
      start_date, end_date, description
    } = req.body

    const patch: any = { updated_at: now() }
    if (name !== undefined) patch.name = name
    if (client_name !== undefined) patch.client_name = client_name
    if (client_contact !== undefined) patch.client_contact = client_contact
    if (project_type !== undefined) patch.project_type = project_type
    if (status !== undefined) patch.status = status
    if (budget_amount !== undefined) patch.budget_amount = budget_amount
    if (area_m2 !== undefined) patch.area_m2 = area_m2 ? parseFloat(area_m2) : null
    if (smart_features !== undefined) patch.smart_features = Array.isArray(smart_features) ? smart_features : []
    if (start_date !== undefined) patch.start_date = start_date
    if (end_date !== undefined) patch.end_date = end_date
    if (description !== undefined) patch.description = description

    await db.projects.update(req.params.id, patch)
    res.json(await db.projects.find(req.params.id))
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/projects/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.projects.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Projekt nie znaleziony' })
      return
    }
    await db.projects.delete(req.params.id)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
