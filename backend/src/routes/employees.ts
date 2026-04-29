import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db'

const router = Router()

function now() { return new Date().toISOString() }

// ── Assets (must be before /:id to avoid 'assets'/'documents' being treated as id)

router.get('/assets/:assetId', async (req: Request, res: Response) => {
  try {
    const asset = await db.employee_assets.find(req.params.assetId)
    if (!asset) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    res.json(asset)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.put('/assets/:assetId', async (req: Request, res: Response) => {
  try {
    const existing = await db.employee_assets.find(req.params.assetId)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    const { asset_type, name, serial_no, notes, assigned_at } = req.body
    await db.employee_assets.update(req.params.assetId, {
      ...(asset_type !== undefined && { asset_type }),
      ...(name !== undefined && { name: name.trim() }),
      ...(serial_no !== undefined && { serial_no }),
      ...(notes !== undefined && { notes }),
      ...(assigned_at !== undefined && { assigned_at }),
    })
    res.json(await db.employee_assets.find(req.params.assetId))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.delete('/assets/:assetId', async (req: Request, res: Response) => {
  try {
    const existing = await db.employee_assets.find(req.params.assetId)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    await db.employee_assets.delete(req.params.assetId)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Documents (must be before /:id)

router.get('/documents/:docId/download', async (req: Request, res: Response) => {
  try {
    const doc = await db.employee_documents.find(req.params.docId)
    if (!doc) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    const buffer = Buffer.from((doc as any).file_data, 'base64')
    res.setHeader('Content-Type', (doc as any).mime_type)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent((doc as any).file_name)}"`)
    res.send(buffer)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.delete('/documents/:docId', async (req: Request, res: Response) => {
  try {
    const existing = await db.employee_documents.find(req.params.docId)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    await db.employee_documents.delete(req.params.docId)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Employees CRUD ─────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try { res.json(await db.employees.all()) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const emp = await db.employees.find(req.params.id)
    if (!emp) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    const [assets, documents] = await Promise.all([
      db.employee_assets.forEmployee(req.params.id),
      db.employee_documents.forEmployee(req.params.id),
    ])
    // Don't send file_data in list — only metadata
    const docsWithoutData = documents.map((d: any) => {
      const { file_data, ...meta } = d
      return meta
    })
    res.json({ ...emp, assets, documents: docsWithoutData })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, hourly_rate, employment_type, position, email, phone, address, start_date, end_date, notes, medical_exam_last_date, medical_exam_date, bhp_last_date, bhp_date } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'Imię i nazwisko jest wymagane' }); return }
    const employee = {
      id: uuidv4(), name: name.trim(),
      hourly_rate: Number(hourly_rate) || 0,
      employment_type: employment_type || 'employment',
      position: position || '', email: email || '', phone: phone || '',
      address: address || '', start_date: start_date || null, end_date: end_date || null,
      notes: notes || '',
      medical_exam_last_date: medical_exam_last_date || null,
      medical_exam_date: medical_exam_date || null,
      bhp_last_date: bhp_last_date || null,
      bhp_date: bhp_date || null,
      created_at: now(), updated_at: now(),
    }
    await db.employees.insert(employee)
    res.status(201).json(employee)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.employees.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    const { name, hourly_rate, employment_type, position, email, phone, address, start_date, end_date, notes, medical_exam_last_date, medical_exam_date, bhp_last_date, bhp_date } = req.body
    await db.employees.update(req.params.id, {
      ...(name !== undefined && { name: name.trim() }),
      ...(hourly_rate !== undefined && { hourly_rate: Number(hourly_rate) || 0 }),
      ...(employment_type !== undefined && { employment_type }),
      ...(position !== undefined && { position }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
      ...(address !== undefined && { address }),
      ...(start_date !== undefined && { start_date: start_date || null }),
      ...(end_date !== undefined && { end_date: end_date || null }),
      ...(notes !== undefined && { notes }),
      ...(medical_exam_last_date !== undefined && { medical_exam_last_date: medical_exam_last_date || null }),
      ...(medical_exam_date !== undefined && { medical_exam_date: medical_exam_date || null }),
      ...(bhp_last_date !== undefined && { bhp_last_date: bhp_last_date || null }),
      ...(bhp_date !== undefined && { bhp_date: bhp_date || null }),
      updated_at: now(),
    })
    res.json(await db.employees.find(req.params.id))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.employees.find(req.params.id)
    if (!existing) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    await db.employees.delete(req.params.id)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Per-employee assets and documents ─────────────────────────────────────────

router.get('/:id/assets', async (req: Request, res: Response) => {
  try { res.json(await db.employee_assets.forEmployee(req.params.id)) }
  catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.post('/:id/assets', async (req: Request, res: Response) => {
  try {
    const { asset_type, name, serial_no, notes, assigned_at } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'Nazwa assetu jest wymagana' }); return }
    const asset = {
      id: uuidv4(), employee_id: req.params.id,
      asset_type: asset_type || 'other', name: name.trim(),
      serial_no: serial_no || '', notes: notes || '',
      assigned_at: assigned_at || now().slice(0, 10),
      created_at: now(),
    }
    await db.employee_assets.insert(asset)
    res.status(201).json(asset)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

router.post('/:id/documents', async (req: Request, res: Response) => {
  try {
    const { doc_type, name, file_name, mime_type, file_data, expires_at, notes } = req.body
    if (!file_data || !file_name) { res.status(400).json({ error: 'Brak pliku' }); return }
    const doc = {
      id: uuidv4(), employee_id: req.params.id,
      doc_type: doc_type || 'other', name: name || file_name,
      file_name, mime_type: mime_type || 'application/octet-stream',
      file_data, expires_at: expires_at || null,
      notes: notes || '', uploaded_at: now(),
    }
    await db.employee_documents.insert(doc)
    const { file_data: _, ...meta } = doc
    res.status(201).json(meta)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

export default router
