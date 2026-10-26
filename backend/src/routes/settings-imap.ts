/**
 * Ustawienia skrzynki e-mail (IMAP) na faktury spoza KSeF — tylko admin.
 * Mount: /api/settings/imap
 *
 * GET  /          → ustawienia (hasło zamaskowane)
 * PUT  /          → zapis (hasło = maska → zachowaj stare; zmiana host/login/folder zeruje last_uid)
 * POST /test      → próba połączenia → { ok, mailbox: { exists, unseen } } lub { ok:false, error }
 * POST /check-now → uruchamia checkImapInbox() W TLE i odpowiada od razu 202 { started:true, started_at }
 *                   (409 { error } gdy poprzednie ręczne sprawdzenie jeszcze trwa; 400 gdy skrzynka nieskonfigurowana).
 *                   Wynik frontend odczytuje przez GET / (last_checked_at ≥ started_at, last_error) — pełne
 *                   sprawdzenie (IMAP + odczyt AI każdego załącznika) trwa minuty i przekraczało timeout proxy.
 */
import { Router, Request, Response } from 'express'
import { prisma } from '../db'
import { requireAdmin } from '../middleware/auth'
import { checkImapInbox, createImapClient, type ImapCheckResult } from '../services/cost-inbox-imap'
import { getImapSettings, saveImapSettings } from '../settings-store'

const router = Router()
router.use(requireAdmin)

const MASKED = '••••••••'
const TEST_TIMEOUT_MS = 20_000

function now(): string { return new Date().toISOString() }

const DEFAULTS = { id: 'default', enabled: false, host: '', port: 993, secure: true, user: '', pass: '', folder: 'INBOX', last_uid: 0, last_checked_at: '', last_error: '', updated_at: '' }

function masked(s: any) {
  return {
    enabled: !!s.enabled,
    host: s.host ?? '',
    port: Number(s.port) || 993,
    secure: s.secure !== false,
    user: s.user ?? '',
    pass: s.pass ? MASKED : '',
    folder: s.folder || 'INBOX',
    last_uid: Number(s.last_uid) || 0,
    last_checked_at: s.last_checked_at ?? '',
    last_error: s.last_error ?? '',
    updated_at: s.updated_at ?? '',
  }
}

async function load() {
  return (await getImapSettings()) ?? DEFAULTS
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(masked(await load()))
  } catch (e) {
    console.error('[settings/imap GET]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

router.put('/', async (req: Request, res: Response) => {
  try {
    const cur: any = await load()
    const b = req.body ?? {}
    const patch: any = { updated_at: now() }

    if (b.host !== undefined) {
      const host = String(b.host ?? '').trim().toLowerCase()
      if (host && !/^[a-z0-9.-]+$/.test(host)) { res.status(400).json({ error: 'Nieprawidłowy adres serwera IMAP (np. imap.gmail.com)' }); return }
      patch.host = host
    }
    if (b.port !== undefined) {
      const port = Number(b.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) { res.status(400).json({ error: 'Port musi być liczbą 1–65535 (zwykle 993)' }); return }
      patch.port = port
    }
    if (b.secure !== undefined) patch.secure = b.secure === true || b.secure === 'true'
    if (b.user !== undefined) patch.user = String(b.user ?? '').trim().slice(0, 200)
    if (b.pass !== undefined) {
      const pass = String(b.pass ?? '')
      if (pass !== MASKED) patch.pass = pass // maska = zachowaj stare hasło; '' = wyczyść
    }
    if (b.folder !== undefined) patch.folder = String(b.folder ?? '').trim().slice(0, 200) || 'INBOX'
    if (b.enabled !== undefined) patch.enabled = b.enabled === true || b.enabled === 'true'

    const merged = { ...cur, ...patch }
    if (merged.enabled && (!merged.host || !merged.user || !merged.pass)) {
      res.status(400).json({ error: 'Aby włączyć skrzynkę, podaj serwer, login i hasło' }); return
    }
    // UID-y są per skrzynka — zmiana serwera/konta/folderu unieważnia zapamiętany postęp
    if ((patch.host !== undefined && patch.host !== cur.host) || (patch.user !== undefined && patch.user !== cur.user) || (patch.folder !== undefined && patch.folder !== cur.folder)) {
      patch.last_uid = 0
      patch.last_error = ''
    }

    const saved = await saveImapSettings({ ...((await getImapSettings()) ? {} : DEFAULTS), ...patch })
    res.json(masked(saved))
  } catch (e) {
    console.error('[settings/imap PUT]', e)
    res.status(500).json({ error: 'Nie udało się zapisać ustawień' })
  }
})

/** POST /test — łączy się z podanymi (lub zapisanymi) danymi i zwraca stan folderu. */
router.post('/test', async (req: Request, res: Response) => {
  const cur: any = await load().catch(() => DEFAULTS)
  const b = req.body ?? {}
  const host = String(b.host ?? cur.host ?? '').trim()
  const port = Number(b.port ?? cur.port) || 993
  const secure = b.secure === undefined ? cur.secure !== false : (b.secure === true || b.secure === 'true')
  const user = String(b.user ?? cur.user ?? '').trim()
  const passRaw = b.pass === undefined ? cur.pass : String(b.pass)
  const pass = passRaw === MASKED ? cur.pass : passRaw
  const folder = String(b.folder ?? cur.folder ?? '').trim() || 'INBOX'

  if (!host || !user || !pass) { res.json({ ok: false, error: 'Podaj serwer, login i hasło' }); return }

  const client = createImapClient({ host, port, secure, user, pass })
  client.on('error', () => { /* raportujemy przez catch niżej */ })
  try {
    await withTimeout(client.connect(), TEST_TIMEOUT_MS, 'Przekroczono czas łączenia (20 s) — sprawdź serwer, port i SSL')
    const st = await withTimeout(client.status(folder, { messages: true, unseen: true }), TEST_TIMEOUT_MS, 'Przekroczono czas odczytu folderu')
    res.json({ ok: true, mailbox: { exists: Number(st.messages) || 0, unseen: Number(st.unseen) || 0 } })
  } catch (e: any) {
    const msg = String(e?.responseText ?? e?.message ?? e).slice(0, 300)
    res.json({ ok: false, error: /auth|login|credential|password/i.test(msg) ? `Logowanie odrzucone: ${msg}` : msg })
  } finally {
    try { await client.logout() } catch { /* ignoruj */ }
  }
})

// Blokada ręcznego „Sprawdź teraz” (poller ma własną blokadę w cost-inbox-imap.ts).
let checkNowRunning = false

export type CheckNowStart = { started: true; started_at: string } | { busy: true }

/**
 * Uruchamia sprawdzenie skrzynki w tle i od razu zwraca `{ started, started_at }`, albo `{ busy }` gdy poprzednie
 * ręczne sprawdzenie jeszcze trwa. Blokada jest zwalniana zawsze (także po wyjątku). `run` — do podmiany w testach.
 */
export function startCheckNow(run: () => Promise<ImapCheckResult> = checkImapInbox): CheckNowStart {
  if (checkNowRunning) return { busy: true }
  checkNowRunning = true
  const started_at = now()
  void Promise.resolve()
    .then(run)
    .then((r: any) => {
      if (r?.error) console.error('[settings/imap check-now] Sprawdzenie skrzynki:', r.error)
      else if (r) console.log(`[settings/imap check-now] Skrzynka: wiadomości ${r.fetched ?? 0}, nowe dokumenty ${r.created ?? 0}, pominięte ${r.skipped ?? 0}`)
    })
    .catch((e: any) => console.error('[settings/imap check-now] Błąd sprawdzania skrzynki:', e?.message ?? e))
    .finally(() => { checkNowRunning = false })
  return { started: true, started_at }
}

/** POST /check-now — start sprawdzenia skrzynki w tle → 202 { started:true, started_at } | 409 | 400. */
router.post('/check-now', async (_req: Request, res: Response) => {
  try {
    const cur: any = await load()
    if (!cur.host || !cur.user || !cur.pass) {
      res.status(400).json({ error: 'Skrzynka e-mail nie jest skonfigurowana (host, login, hasło)' }); return
    }
    const r = startCheckNow()
    if ('busy' in r) { res.status(409).json({ error: 'Sprawdzanie już trwa' }); return }
    res.status(202).json(r)
  } catch (e: any) {
    console.error('[settings/imap check-now]', e)
    res.status(500).json({ error: 'Błąd sprawdzania skrzynki' })
  }
})

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

export default router
