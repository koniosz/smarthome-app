import { Router, Request, Response } from 'express'
import nodemailer from 'nodemailer'
import db from '../db'
import { requireAdmin } from '../middleware/auth'
import { getSmtpConfig } from '../services/mailer'

const router = Router()

const MASKED = '••••••••'

// GET /api/settings/smtp — zwróć aktualną konfigurację (hasło zamaskowane)
router.get('/smtp', requireAdmin, async (req: Request, res: Response) => {
  try {
    const s = await db.smtp_settings.get()

    if (s && s.host) {
      // Konfiguracja zapisana w DB
      res.json({
        source:     'database',
        host:       s.host,
        port:       s.port,
        user:       s.user,
        pass:       s.pass ? MASKED : '',
        from_email: s.from_email,
        from_name:  s.from_name,
        updated_at: s.updated_at,
        configured: !!(s.host && s.user && s.pass),
      })
    } else {
      // Brak konfiguracji w DB — sprawdź zmienne środowiskowe
      const hasEnv = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
      res.json({
        source:     hasEnv ? 'env' : 'none',
        host:       process.env.SMTP_HOST || '',
        port:       parseInt(process.env.SMTP_PORT || '587'),
        user:       process.env.SMTP_USER || '',
        pass:       process.env.SMTP_PASS ? MASKED : '',
        from_email: process.env.SMTP_FROM || '',
        from_name:  process.env.COMPANY_NAME || '',
        updated_at: '',
        configured: hasEnv,
      })
    }
  } catch (e) {
    console.error('[settings/smtp GET]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/settings/smtp — zapisz konfigurację poczty w bazie danych
router.put('/smtp', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { host, port, user, pass, from_email, from_name } = req.body

    if (!host?.trim())  { res.status(400).json({ error: 'Serwer SMTP (host) jest wymagany' }); return }
    if (!user?.trim())  { res.status(400).json({ error: 'Nazwa użytkownika / adres email jest wymagany' }); return }

    // Hasło: jeśli przesłano nowe (≠ maska), zapisz je; w przeciwnym razie zachowaj poprzednie
    let finalPass = pass
    if (!pass || pass === MASKED) {
      const existing = await db.smtp_settings.get()
      finalPass = existing?.pass || ''
    }

    if (!finalPass) { res.status(400).json({ error: 'Hasło SMTP jest wymagane' }); return }

    await db.smtp_settings.save({
      host:       host.trim(),
      port:       parseInt(String(port)) || 587,
      user:       user.trim(),
      pass:       finalPass,
      from_email: (from_email || '').trim(),
      from_name:  (from_name  || '').trim(),
    })

    res.json({ success: true, message: 'Konfiguracja poczty zapisana pomyślnie' })
  } catch (e) {
    console.error('[settings/smtp PUT]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/settings/smtp/test — wyślij testowy email (używa aktualnej konfiguracji)
router.post('/smtp/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { to } = req.body
    if (!to || !String(to).includes('@')) {
      res.status(400).json({ error: 'Podaj poprawny adres email do testu' }); return
    }

    // Pobierz konfigurację (DB lub env)
    let cfg: { host: string; port: number; user: string; pass: string; from: string; fromName: string }
    try {
      cfg = await getSmtpConfig()
    } catch (e: any) {
      res.status(400).json({ error: e.message || 'Brak konfiguracji SMTP' }); return
    }

    const transport = nodemailer.createTransport({
      host:   cfg.host,
      port:   cfg.port,
      secure: cfg.port === 465,
      auth:   { user: cfg.user, pass: cfg.pass },
      tls:    { rejectUnauthorized: false },
    })

    const sentAt = new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })

    await transport.sendMail({
      from:    `${cfg.fromName} <${cfg.from}>`,
      to,
      subject: '✅ Test konfiguracji poczty — SHC Manager',
      html: `
<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="500" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:500px;width:100%">
        <tr>
          <td style="background:linear-gradient(135deg,#7c3aed,#5b21b6);padding:32px 40px;text-align:center">
            <div style="font-size:48px;margin-bottom:12px">✅</div>
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Poczta działa poprawnie!</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px">
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6">
              Konfiguracja SMTP w systemie <strong>SHC Manager</strong> jest prawidłowa.
              Wysyłanie wiadomości do klientów będzie działać poprawnie.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;border-radius:8px;padding:16px">
              <tr><td style="padding:4px 0;font-size:13px;color:#6b7280">Serwer SMTP:</td><td style="padding:4px 0;font-size:13px;color:#374151;font-weight:600">${cfg.host}:${cfg.port}</td></tr>
              <tr><td style="padding:4px 0;font-size:13px;color:#6b7280">Użytkownik:</td><td style="padding:4px 0;font-size:13px;color:#374151;font-weight:600">${cfg.user}</td></tr>
              <tr><td style="padding:4px 0;font-size:13px;color:#6b7280">Wysłano:</td><td style="padding:4px 0;font-size:13px;color:#374151;font-weight:600">${sentAt}</td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 40px;border-top:1px solid #e5e7eb;text-align:center">
            <p style="margin:0;font-size:12px;color:#9ca3af">SHC Manager — Panel Administratora</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    })

    res.json({ success: true, message: `Email testowy wysłany na ${to}` })
  } catch (e: any) {
    console.error('[settings/smtp/test]', e)
    res.status(500).json({ error: e.message || 'Nie udało się wysłać emaila testowego' })
  }
})

// DELETE /api/settings/smtp — usuń konfigurację z DB (powrót do env vars)
router.delete('/smtp', requireAdmin, async (req: Request, res: Response) => {
  try {
    await db.smtp_settings.save({ host: '', port: 587, user: '', pass: '', from_email: '', from_name: '' })
    res.json({ success: true, message: 'Konfiguracja poczty usunięta z bazy danych' })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
