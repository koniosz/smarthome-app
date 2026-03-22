import { Router, Request, Response } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import db from '../db'

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'attachments')
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`
    const ext = path.extname(file.originalname)
    cb(null, `${unique}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) cb(null, true)
    else cb(new Error('Dozwolone formaty: PDF, JPG, PNG, WEBP, HEIC'))
  },
})

const router = Router()

// POST /api/costs/:id/attachment
router.post('/costs/:id/attachment', upload.single('file'), (req: Request, res: Response) => {
  const existing = db.cost_items.find(req.params.id)
  if (!existing) {
    if (req.file) fs.unlinkSync(req.file.path)
    res.status(404).json({ error: 'Pozycja nie znaleziona' })
    return
  }

  // Delete old attachment if exists
  if (existing.attachment_filename) {
    const oldPath = path.join(UPLOADS_DIR, existing.attachment_filename)
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
  }

  if (!req.file) {
    res.status(400).json({ error: 'Brak pliku' })
    return
  }

  db.cost_items.update(req.params.id, {
    attachment_filename: req.file.filename,
    attachment_original: req.file.originalname,
  })

  res.json(db.cost_items.find(req.params.id))
})

// DELETE /api/costs/:id/attachment
router.delete('/costs/:id/attachment', (req: Request, res: Response) => {
  const existing = db.cost_items.find(req.params.id)
  if (!existing) { res.status(404).json({ error: 'Pozycja nie znaleziona' }); return }

  if (existing.attachment_filename) {
    const filePath = path.join(UPLOADS_DIR, existing.attachment_filename)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    db.cost_items.update(req.params.id, { attachment_filename: null, attachment_original: null })
  }

  res.json({ success: true })
})

// GET /api/attachments/:filename  — serve the file
router.get('/attachments/:filename', (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename) // prevent path traversal
  const filePath = path.join(UPLOADS_DIR, filename)
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Plik nie znaleziony' })
    return
  }
  res.sendFile(filePath)
})

export default router
