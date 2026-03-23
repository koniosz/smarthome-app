import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import jwksRsa from 'jwks-rsa'
import jwt from 'jsonwebtoken'
import db from '../db'
import { requireAuth, signToken, AuthUser } from '../middleware/auth'

const router = Router()

const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || ''
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || ''

function now() {
  return new Date().toISOString()
}

function makeUser(row: any): AuthUser {
  return { id: row.id, email: row.email, display_name: row.display_name, role: row.role }
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      res.status(400).json({ error: 'Email i hasło są wymagane' }); return
    }

    const user = await db.users.findByEmail(email.toLowerCase())
    if (!user || !user.password_hash) {
      res.status(401).json({ error: 'Nieprawidłowy email lub hasło' }); return
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      res.status(401).json({ error: 'Nieprawidłowy email lub hasło' }); return
    }

    const token = signToken(makeUser(user))
    res.json({ token, user: makeUser(user) })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, display_name } = req.body
    if (!email || !password || !display_name) {
      res.status(400).json({ error: 'Email, hasło i imię są wymagane' }); return
    }

    const existing = await db.users.findByEmail(email.toLowerCase())
    if (existing) {
      res.status(409).json({ error: 'Użytkownik z tym emailem już istnieje' }); return
    }

    const isFirstUser = (await db.users.count()) === 0
    const hash = await bcrypt.hash(password, 10)
    const user = {
      id: uuidv4(),
      email: email.toLowerCase(),
      display_name,
      role: isFirstUser ? 'admin' : 'employee',
      azure_oid: null,
      password_hash: hash,
      created_at: now(),
    }
    await db.users.insert(user)

    const token = signToken(makeUser(user))
    res.status(201).json({ token, user: makeUser(user) })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/auth/azure
router.post('/azure', async (req: Request, res: Response) => {
  try {
    const { id_token } = req.body
    if (!id_token) { res.status(400).json({ error: 'Brak tokenu Azure' }); return }

    if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID) {
      res.status(501).json({ error: 'Azure AD nie jest skonfigurowany na serwerze' }); return
    }

    const jwksClient = jwksRsa({
      jwksUri: `https://login.microsoftonline.com/${AZURE_TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      rateLimit: true,
    })

    const decoded = jwt.decode(id_token, { complete: true }) as any
    if (!decoded?.header?.kid) {
      res.status(401).json({ error: 'Nieprawidłowy token Azure' }); return
    }

    const key = await jwksClient.getSigningKey(decoded.header.kid)
    const publicKey = key.getPublicKey()

    const payload = jwt.verify(id_token, publicKey, {
      algorithms: ['RS256'],
      audience: AZURE_CLIENT_ID,
    }) as any

    const oid: string = payload.oid
    const email: string = (payload.preferred_username || payload.email || '').toLowerCase()
    const display_name: string = payload.name || email

    let user = await db.users.findByAzureOid(oid) || await db.users.findByEmail(email)
    if (!user) {
      const isFirstUser = (await db.users.count()) === 0
      user = {
        id: uuidv4(),
        email,
        display_name,
        role: isFirstUser ? 'admin' : 'employee',
        azure_oid: oid,
        password_hash: null,
        created_at: now(),
      }
      await db.users.insert(user)
    } else if (!user.azure_oid) {
      await db.users.update(user.id, { azure_oid: oid })
      user = await db.users.find(user.id)
    }

    const token = signToken(makeUser(user))
    res.json({ token, user: makeUser(user) })
  } catch (err: any) {
    res.status(401).json({ error: 'Weryfikacja tokenu Azure nie powiodła się' })
  }
})

// GET /api/auth/me
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json(req.user)
})

// POST /api/auth/change-password — zmiana własnego hasła (każdy zalogowany user)
router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
  try {
    const { current_password, new_password } = req.body
    if (!current_password || !new_password) {
      res.status(400).json({ error: 'Wymagane pola: current_password, new_password' }); return
    }
    if (new_password.length < 6) {
      res.status(400).json({ error: 'Nowe hasło musi mieć co najmniej 6 znaków' }); return
    }

    const user = await db.users.find(req.user!.id)
    if (!user) {
      res.status(404).json({ error: 'Użytkownik nie istnieje' }); return
    }
    if (!user.password_hash) {
      res.status(400).json({ error: 'Konto Azure AD — zmiana hasła nie jest możliwa tą metodą' }); return
    }

    const valid = await bcrypt.compare(current_password, user.password_hash)
    if (!valid) {
      res.status(401).json({ error: 'Obecne hasło jest nieprawidłowe' }); return
    }

    const hash = await bcrypt.hash(new_password, 10)
    await db.users.update(user.id, { password_hash: hash })
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
