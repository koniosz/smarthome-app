import nodemailer from 'nodemailer'
import db from '../db'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

// ─── SMTP config: DB first, env vars fallback ─────────────────────────────────
export async function getSmtpConfig(): Promise<{
  host: string; port: number; user: string; pass: string
  from: string; fromName: string
}> {
  // 1. Try database settings
  try {
    const s = await db.smtp_settings.get()
    if (s && s.host && s.user && s.pass) {
      return {
        host:     s.host,
        port:     s.port || 587,
        user:     s.user,
        pass:     s.pass,
        from:     s.from_email || s.user,
        fromName: s.from_name  || process.env.COMPANY_NAME || 'SHC Manager',
      }
    }
  } catch { /* DB not ready — fall through */ }

  // 2. Fall back to environment variables
  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT ?? '587')
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host || !user || !pass) {
    throw new Error(
      'Brak konfiguracji SMTP. Skonfiguruj pocztę w Panelu Administratora ' +
      '(⚙️ Ustawienia → Poczta) lub ustaw zmienne SMTP_HOST, SMTP_USER, SMTP_PASS.'
    )
  }

  return {
    host,
    port,
    user,
    pass,
    from:     process.env.SMTP_FROM ?? user,
    fromName: process.env.COMPANY_NAME ?? 'SHC Manager',
  }
}

async function buildTransport() {
  const cfg = await getSmtpConfig()
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: false },
  })
  return { transport, from: cfg.from, fromName: cfg.fromName }
}

export interface ExtraCostEmailItem {
  description: string
  quantity: number
  unit_price: number
  total_price: number
  is_out_of_scope: boolean
  notes: string
}

export async function sendExtraCostApprovalEmail(opts: {
  to: string
  projectName: string
  companyName?: string
  items: ExtraCostEmailItem[]
  approveUrl: string
  rejectUrl: string
}) {
  const { to, projectName, companyName, items, approveUrl, rejectUrl } = opts
  const total = items.reduce((s, i) => s + i.total_price, 0)

  const rows = items.map((item, i) => `
    <tr style="border-bottom:1px solid #e5e7eb">
      <td style="padding:10px 12px;color:#374151;font-size:14px">${i + 1}. ${item.description}${item.notes ? `<br><span style="font-size:12px;color:#6b7280">${item.notes}</span>` : ''}${item.is_out_of_scope ? ' <span style="background:#fff7ed;color:#c2410c;font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid #fed7aa">⚠ ponadprogramowy</span>' : ''}</td>
      <td style="padding:10px 12px;text-align:right;color:#6b7280;font-size:13px;white-space:nowrap">${item.quantity} szt.</td>
      <td style="padding:10px 12px;text-align:right;color:#6b7280;font-size:13px;white-space:nowrap">${fmt(item.unit_price)} PLN</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;color:#111827;font-size:14px;white-space:nowrap">${fmt(item.total_price)} PLN</td>
    </tr>
  `).join('')

  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Koszty dodatkowe — ${projectName}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:600px;width:100%">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#7c3aed,#5b21b6);padding:32px 40px">
            <p style="margin:0;color:#ddd6fe;font-size:13px;letter-spacing:.05em;text-transform:uppercase">Prośba o akceptację</p>
            <h1 style="margin:8px 0 0;color:#fff;font-size:24px;font-weight:700">Koszty dodatkowe</h1>
            <p style="margin:6px 0 0;color:#c4b5fd;font-size:15px">Projekt: <strong>${projectName}</strong></p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 40px">
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6">
              Szanowni Państwo,<br><br>
              Firma <strong>${companyName}</strong> przesyła zestawienie kosztów dodatkowych do Państwa projektu, które wymagają akceptacji przed rozpoczęciem prac.
            </p>

            <!-- Items table -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:24px">
              <thead>
                <tr style="background:#f3f4f6">
                  <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Opis</th>
                  <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Ilość</th>
                  <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Cena jedn.</th>
                  <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Razem</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr style="background:#f5f3ff;border-top:2px solid #e5e7eb">
                  <td colspan="3" style="padding:14px 12px;text-align:right;font-weight:600;font-size:14px;color:#374151">Łącznie do akceptacji:</td>
                  <td style="padding:14px 12px;text-align:right;font-weight:700;font-size:18px;color:#7c3aed">${fmt(total)} PLN</td>
                </tr>
              </tfoot>
            </table>

            <p style="margin:0 0 28px;color:#6b7280;font-size:13px;line-height:1.6">
              Prace zostaną rozpoczęte po uzyskaniu potwierdzenia. Kliknij jeden z poniższych przycisków, aby wyrazić swoją decyzję.
            </p>

            <!-- CTA Buttons -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:0 8px 0 0" width="50%">
                  <a href="${approveUrl}" style="display:block;background:#16a34a;color:#fff;text-decoration:none;text-align:center;padding:16px 24px;border-radius:10px;font-size:16px;font-weight:700;letter-spacing:.01em">
                    ✅&nbsp; Akceptuję
                  </a>
                </td>
                <td style="padding:0 0 0 8px" width="50%">
                  <a href="${rejectUrl}" style="display:block;background:#dc2626;color:#fff;text-decoration:none;text-align:center;padding:16px 24px;border-radius:10px;font-size:16px;font-weight:700;letter-spacing:.01em">
                    ❌&nbsp; Nie akceptuję
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.5">
              Jeśli przyciski nie działają, skopiuj i wklej poniższe linki w przeglądarce:<br>
              Akceptuję: <span style="color:#7c3aed">${approveUrl}</span><br>
              Nie akceptuję: <span style="color:#dc2626">${rejectUrl}</span>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center">
              Ta wiadomość została wygenerowana automatycznie przez system zarządzania projektami.<br>
              Prosimy nie odpowiadać na ten email.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`

  const { transport, from: cfgFrom, fromName: cfgFromName } = await buildTransport()
  // Allow caller to override from/fromName via companyName arg
  const senderName = companyName !== 'Wykonawca' ? companyName : cfgFromName
  const senderAddr = from ?? cfgFrom
  await transport.sendMail({
    from: `${senderName} <${senderAddr}>`,
    to,
    subject: `[Akceptacja kosztów] Projekt: ${projectName} — ${fmt(total)} PLN`,
    html,
  })
}

// Prosty HTML do zwrócenia klientowi po kliknięciu linku
export function approvalConfirmationHtml(approved: boolean, projectName: string, total: number) {
  const icon  = approved ? '✅' : '❌'
  const title = approved ? 'Koszty zaakceptowane' : 'Koszty odrzucone'
  const color = approved ? '#16a34a' : '#dc2626'
  const msg   = approved
    ? 'Dziękujemy za akceptację. Firma wykonawcza została powiadomiona i wkrótce skontaktuje się z Państwem w celu ustalenia szczegółów.'
    : 'Dziękujemy za odpowiedź. Firma wykonawcza została powiadomiona o odmowie i skontaktuje się z Państwem w celu omówienia dalszych kroków.'

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">
  <div style="max-width:520px;margin:60px auto;background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.1);overflow:hidden">
    <div style="background:${color};padding:48px 40px;text-align:center">
      <div style="font-size:64px;margin-bottom:16px">${icon}</div>
      <h1 style="margin:0;color:#fff;font-size:26px;font-weight:700">${title}</h1>
    </div>
    <div style="padding:40px">
      <p style="margin:0 0 12px;color:#374151;font-size:16px;line-height:1.6">${msg}</p>
      <p style="margin:0;color:#6b7280;font-size:14px">Projekt: <strong style="color:#374151">${projectName}</strong></p>
      ${total > 0 ? `<p style="margin:8px 0 0;color:#6b7280;font-size:14px">Kwota: <strong style="color:${color}">${fmt(total)} PLN</strong></p>` : ''}
    </div>
    <div style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center">
      <p style="margin:0;font-size:12px;color:#9ca3af">Możesz zamknąć tę stronę.</p>
    </div>
  </div>
</body>
</html>`
}
