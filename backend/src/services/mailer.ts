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
  const { to, projectName, items, approveUrl, rejectUrl } = opts
  const total = items.reduce((s, i) => s + i.total_price, 0)

  // Resolve company name before building HTML — opts.companyName → SMTP from_name → fallback
  const { transport, from: cfgFrom, fromName: cfgFromName } = await buildTransport()
  const companyName = (opts.companyName && opts.companyName !== 'Wykonawca')
    ? opts.companyName
    : (cfgFromName || 'Smart Home Center')

  // Układ 2-kolumnowy (opis + wartość) — odporny na wąskie ekrany telefonów;
  // ilość × cena jednostkowa jako podlinijka pod opisem, więc opis nie zwija się literami.
  const rows = items.map((item, i) => `
    <tr style="border-bottom:1px solid #e5e7eb">
      <td style="padding:12px 14px;vertical-align:top">
        <div style="color:#111827;font-size:14px;font-weight:600;line-height:1.4">${i + 1}. ${item.description}${item.is_out_of_scope ? ' <span style="display:inline-block;background:#fff7ed;color:#c2410c;font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid #fed7aa;white-space:nowrap">⚠ ponadprogramowy</span>' : ''}</div>
        ${item.notes ? `<div style="font-size:12px;color:#6b7280;margin-top:3px;line-height:1.4">${item.notes}</div>` : ''}
        <div style="font-size:13px;color:#6b7280;margin-top:5px;white-space:nowrap">${item.quantity} szt. × ${fmt(item.unit_price)} PLN</div>
      </td>
      <td style="padding:12px 14px;text-align:right;vertical-align:top;font-weight:700;color:#111827;font-size:15px;white-space:nowrap">${fmt(item.total_price)} PLN</td>
    </tr>
  `).join('')

  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Koszty dodatkowe — ${projectName}</title>
  <style>
    @media only screen and (max-width:480px){
      .cardpad{padding-left:20px!important;padding-right:20px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:600px;width:100%">

        <!-- Header -->
        <tr>
          <td class="cardpad" style="background:linear-gradient(135deg,#7c3aed,#5b21b6);padding:32px 40px">
            <p style="margin:0;color:#ddd6fe;font-size:13px;letter-spacing:.05em;text-transform:uppercase">Prośba o akceptację</p>
            <h1 style="margin:8px 0 0;color:#fff;font-size:24px;font-weight:700">Koszty dodatkowe</h1>
            <p style="margin:6px 0 0;color:#c4b5fd;font-size:15px">Projekt: <strong>${projectName}</strong></p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td class="cardpad" style="padding:32px 40px">
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6">
              Szanowni Państwo,<br><br>
              Firma <strong>${companyName}</strong> przesyła zestawienie kosztów dodatkowych do Państwa projektu, które wymagają akceptacji przed rozpoczęciem prac.
            </p>

            <!-- Items table (2 kolumny — opis | wartość) -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:24px;border-collapse:separate">
              <thead>
                <tr style="background:#f3f4f6">
                  <th style="padding:10px 14px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Pozycja</th>
                  <th style="padding:10px 14px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">Wartość</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr style="background:#f5f3ff;border-top:2px solid #e5e7eb">
                  <td style="padding:14px 14px;text-align:left;font-weight:600;font-size:14px;color:#374151">Łącznie do akceptacji:</td>
                  <td style="padding:14px 14px;text-align:right;font-weight:700;font-size:18px;color:#7c3aed;white-space:nowrap">${fmt(total)} PLN</td>
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

  const senderAddr = cfgFrom
  await transport.sendMail({
    from: `${companyName} <${senderAddr}>`,
    to,
    subject: `[Akceptacja kosztów] Projekt: ${projectName} — ${fmt(total)} PLN`,
    html,
  })
}

// Prosty HTML do zwrócenia klientowi po kliknięciu linku
export function approvalConfirmationHtml(approved: boolean, projectName: string, total: number, clientComment?: string) {
  const icon  = approved ? '😊' : '😔'
  const title = approved ? 'Koszty zaakceptowane' : 'Koszty odrzucone'
  const color = approved ? '#16a34a' : '#dc2626'
  const bg    = approved ? 'linear-gradient(135deg,#16a34a,#15803d)' : 'linear-gradient(135deg,#dc2626,#b91c1c)'
  const msg   = approved
    ? 'Dziękujemy za akceptację. Firma wykonawcza została powiadomiona i wkrótce skontaktuje się z Państwem w celu ustalenia szczegółów.'
    : 'Dziękujemy za odpowiedź. Firma wykonawcza została powiadomiona o odmowie i skontaktuje się z Państwem w celu omówienia dalszych kroków.'

  const commentBlock = (!approved && clientComment)
    ? `<div style="margin:16px 0 0;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 16px">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#dc2626;text-transform:uppercase;letter-spacing:.05em">Powód odmowy</p>
        <p style="margin:0;color:#374151;font-size:15px;line-height:1.5">${clientComment}</p>
       </div>`
    : ''

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">
  <div style="max-width:520px;margin:60px auto;background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.1);overflow:hidden">
    <div style="background:${bg};padding:48px 40px;text-align:center">
      <div style="font-size:80px;margin-bottom:16px;line-height:1">${icon}</div>
      <h1 style="margin:0;color:#fff;font-size:26px;font-weight:700">${title}</h1>
    </div>
    <div style="padding:40px">
      <p style="margin:0 0 12px;color:#374151;font-size:16px;line-height:1.6">${msg}</p>
      <p style="margin:0;color:#6b7280;font-size:14px">Projekt: <strong style="color:#374151">${projectName}</strong></p>
      ${total > 0 ? `<p style="margin:8px 0 0;color:#6b7280;font-size:14px">Kwota: <strong style="color:${color}">${fmt(total)} PLN</strong></p>` : ''}
      ${commentBlock}
    </div>
    <div style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center">
      <p style="margin:0;font-size:12px;color:#9ca3af">Możesz zamknąć tę stronę.</p>
    </div>
  </div>
</body>
</html>`
}

export async function sendDueInvoicesEmail(invoices: Array<{
  id: string; invoice_number: string | null; seller_name: string | null
  gross_amount: number; currency: string; payment_due_date: string | null
}>, adminEmail: string): Promise<void> {
  const { transport, from: cfgFrom, fromName: cfgFromName } = await buildTransport()
  const total = invoices.reduce((s, i) => s + i.gross_amount, 0)
  const dateStr = new Date().toLocaleDateString('pl-PL', { day: '2-digit', month: 'long', year: 'numeric' })

  const rows = invoices.map(inv => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${inv.seller_name ?? '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${inv.invoice_number ?? '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${fmt(inv.gross_amount)} ${inv.currency}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${inv.payment_due_date ?? '—'}</td>
    </tr>
  `).join('')

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#4C1D95;padding:20px;border-radius:8px 8px 0 0;">
      <h1 style="color:white;margin:0;font-size:20px;">💳 Przypomnienie o płatnościach</h1>
      <p style="color:#DDD6FE;margin:4px 0 0;">${dateStr}</p>
    </div>
    <div style="background:#F9FAFB;padding:20px;">
      <p style="font-size:16px;color:#111827;">Dzisiaj masz <strong>${invoices.length} ${invoices.length === 1 ? 'fakturę' : invoices.length < 5 ? 'faktury' : 'faktur'}</strong> do opłacenia na łączną kwotę <strong>${fmt(total)} PLN</strong>.</p>
      <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;margin-top:12px;">
        <thead>
          <tr style="background:#EDE9FE;">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#5B21B6;">Sprzedawca</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#5B21B6;">Nr faktury</th>
            <th style="padding:10px 12px;text-align:right;font-size:13px;color:#5B21B6;">Kwota brutto</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#5B21B6;">Termin</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`

  await transport.sendMail({
    from: `"${cfgFromName}" <${cfgFrom}>`,
    to: adminEmail,
    subject: `💳 [${dateStr}] ${invoices.length} faktur do opłacenia — ${fmt(total)} PLN`,
    html,
  })
}

export function rejectionFormHtml(projectName: string, total: number, postUrl: string) {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Odmowa akceptacji kosztów</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">
  <div style="max-width:520px;margin:60px auto;background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.1);overflow:hidden">
    <div style="background:linear-gradient(135deg,#dc2626,#b91c1c);padding:40px;text-align:center">
      <div style="font-size:72px;margin-bottom:12px;line-height:1">😔</div>
      <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Odmowa akceptacji kosztów</h1>
    </div>
    <div style="padding:36px 40px">
      <p style="margin:0 0 6px;color:#6b7280;font-size:14px">Projekt: <strong style="color:#374151">${projectName}</strong></p>
      ${total > 0 ? `<p style="margin:0 0 20px;color:#6b7280;font-size:14px">Kwota: <strong style="color:#dc2626">${fmt(total)} PLN</strong></p>` : '<div style="margin-bottom:20px"></div>'}
      <form method="POST" action="${postUrl}">
        <label style="display:block;font-size:14px;font-weight:600;color:#374151;margin-bottom:8px">
          Powód odmowy <span style="font-weight:400;color:#9ca3af">(opcjonalnie)</span>
        </label>
        <textarea
          name="comment"
          rows="4"
          placeholder="Napisz dlaczego nie akceptujesz tych kosztów..."
          style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:15px;font-family:inherit;color:#374151;resize:vertical;outline:none"
          onfocus="this.style.borderColor='#dc2626'"
          onblur="this.style.borderColor='#d1d5db'"
        ></textarea>
        <button
          type="submit"
          style="margin-top:20px;width:100%;background:#dc2626;color:#fff;border:none;border-radius:10px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit"
        >
          ❌&nbsp; Potwierdź odmowę
        </button>
      </form>
    </div>
    <div style="background:#f9fafb;padding:16px 40px;border-top:1px solid #e5e7eb;text-align:center">
      <p style="margin:0;font-size:12px;color:#9ca3af">Twoja odpowiedź zostanie przekazana firmie wykonawczej.</p>
    </div>
  </div>
</body>
</html>`
}

// Strona decyzji klienta (link SMS / udostępniony) — 2 przyciski: Akceptuj / Nie akceptuję.
// "Nie akceptuję" odsłania pole komentarza. Akcja wykonuje się dopiero przez POST (klik),
// więc samo otwarcie linku (lub podgląd w komunikatorze) niczego nie zatwierdza.
export function approvalDecisionHtml(
  projectName: string,
  total: number,
  items: Array<{ description: string; quantity: number; unit_price: number; total_price: number }>,
  postUrl: string,
) {
  const rows = items.map(i => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#374151;font-size:14px">${i.description}${i.quantity > 1 ? ` <span style="color:#9ca3af">(${i.quantity} × ${fmt(i.unit_price)})</span>` : ''}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;color:#111827;font-size:14px;white-space:nowrap">${fmt(i.total_price)} PLN</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Akceptacja kosztów dodatkowych</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.1);overflow:hidden">
      <div style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:36px 40px;text-align:center">
        <div style="font-size:56px;margin-bottom:8px;line-height:1">📋</div>
        <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Prośba o akceptację kosztów</h1>
      </div>
      <div style="padding:32px 28px">
        <p style="margin:0 0 4px;color:#6b7280;font-size:14px">Projekt: <strong style="color:#374151">${projectName}</strong></p>
        <p style="margin:0 0 16px;color:#6b7280;font-size:14px">Prosimy o akceptację poniższych kosztów dodatkowych:</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
          <tbody>${rows}</tbody>
        </table>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:14px;margin-top:6px;border-top:2px solid #111827">
          <span style="font-size:15px;font-weight:600;color:#374151">Razem</span>
          <span style="font-size:20px;font-weight:800;color:#2563eb">${fmt(total)} PLN</span>
        </div>

        <form method="POST" action="${postUrl}" style="margin-top:28px">
          <div id="choiceButtons">
            <button type="submit" name="action" value="approve"
              style="width:100%;background:#16a34a;color:#fff;border:none;border-radius:12px;padding:17px;font-size:17px;font-weight:700;cursor:pointer;font-family:inherit">
              ✅&nbsp; Akceptuję
            </button>
            <button type="button" onclick="document.getElementById('rejectBox').style.display='block';document.getElementById('choiceButtons').style.display='none'"
              style="width:100%;margin-top:12px;background:#fff;color:#dc2626;border:2px solid #dc2626;border-radius:12px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit">
              ❌&nbsp; Nie akceptuję
            </button>
          </div>

          <div id="rejectBox" style="display:none">
            <label style="display:block;font-size:14px;font-weight:600;color:#374151;margin:8px 0 8px">
              Powód odmowy <span style="font-weight:400;color:#9ca3af">(opcjonalnie)</span>
            </label>
            <textarea name="comment" rows="4" placeholder="Napisz dlaczego nie akceptujesz tych kosztów..."
              style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:15px;font-family:inherit;color:#374151;resize:vertical;outline:none"></textarea>
            <button type="submit" name="action" value="reject"
              style="margin-top:16px;width:100%;background:#dc2626;color:#fff;border:none;border-radius:12px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit">
              Potwierdź odmowę
            </button>
            <button type="button" onclick="document.getElementById('rejectBox').style.display='none';document.getElementById('choiceButtons').style.display='block'"
              style="margin-top:10px;width:100%;background:none;color:#6b7280;border:none;padding:8px;font-size:14px;cursor:pointer;font-family:inherit">
              ← Wróć
            </button>
          </div>
        </form>
      </div>
      <div style="background:#f9fafb;padding:16px 40px;border-top:1px solid #e5e7eb;text-align:center">
        <p style="margin:0;font-size:12px;color:#9ca3af">Twoja odpowiedź zostanie przekazana firmie wykonawczej.</p>
      </div>
    </div>
  </div>
</body>
</html>`
}

// ─── Protokół odbioru prac ────────────────────────────────────────────────────
export async function sendHandoverProtocolEmail(opts: {
  to: string; projectName: string; number: string; companyName?: string; signUrl: string; scope?: string
}): Promise<void> {
  const { transport, from, fromName } = await buildTransport()
  const company = opts.companyName || process.env.COMPANY_NAME || fromName
  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:32px 28px;border-radius:14px 14px 0 0;text-align:center">
      <div style="font-size:48px;line-height:1">✍️</div>
      <h1 style="margin:8px 0 0;color:#fff;font-size:22px">Protokół odbioru prac</h1>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:28px">
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 8px">Dzień dobry,</p>
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">
        ${company} przedstawia protokół odbioru wykonanych prac dla projektu <strong>${opts.projectName}</strong> (nr <strong>${opts.number}</strong>).
        Prosimy o potwierdzenie odbioru — wystarczy kliknąć poniższy przycisk, w razie potrzeby dopisać uwagi i podpisać się.
      </p>
      ${opts.scope ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 16px"><p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Zakres prac</p><p style="margin:0;color:#374151;font-size:14px;line-height:1.5;white-space:pre-line">${opts.scope}</p></div>` : ''}
      <div style="text-align:center;margin:8px 0 4px">
        <a href="${opts.signUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:15px 32px;border-radius:12px">Otwórz protokół i potwierdź odbiór</a>
      </div>
    </div>
  </div>`
  await transport.sendMail({ from: `"${fromName}" <${from}>`, to: opts.to, subject: `Protokół odbioru ${opts.number} — ${opts.projectName}`, html })
}

export function handoverSignPageHtml(p: { projectName: string; number: string; scope?: string | null; companyName?: string; clientName?: string | null; postUrl: string }) {
  return `<!DOCTYPE html>
<html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protokół odbioru ${p.number}</title></head>
<body style="margin:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.1);overflow:hidden">
      <div style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:32px 28px;text-align:center">
        <div style="font-size:48px;line-height:1">✍️</div>
        <h1 style="margin:8px 0 0;color:#fff;font-size:21px">Protokół odbioru prac</h1>
        <p style="margin:4px 0 0;color:#dbeafe;font-size:13px">${p.number}</p>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 4px;color:#6b7280;font-size:14px">Projekt: <strong style="color:#374151">${p.projectName}</strong></p>
        ${p.companyName ? `<p style="margin:0 0 14px;color:#6b7280;font-size:14px">Wykonawca: <strong style="color:#374151">${p.companyName}</strong></p>` : '<div style="margin-bottom:14px"></div>'}
        ${p.scope ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 18px"><p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Zakres prac</p><p style="margin:0;color:#374151;font-size:14px;line-height:1.5;white-space:pre-line">${p.scope}</p></div>` : ''}
        <form method="POST" action="${p.postUrl}">
          <label style="display:flex;gap:10px;align-items:flex-start;font-size:15px;color:#374151;margin:0 0 18px;cursor:pointer">
            <input type="checkbox" name="confirm" required style="margin-top:3px;width:18px;height:18px">
            <span><strong>Potwierdzam odbiór wykonanych prac</strong> i akceptuję ich realizację bez zastrzeżeń (chyba że wpisano poniżej).</span>
          </label>
          <label style="display:block;font-size:14px;font-weight:600;color:#374151;margin-bottom:8px">Uwagi <span style="font-weight:400;color:#9ca3af">(opcjonalnie)</span></label>
          <textarea name="comment" rows="3" placeholder="Ewentualne uwagi do odbioru…" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:15px;font-family:inherit;color:#374151;resize:vertical;margin-bottom:16px"></textarea>
          <label style="display:block;font-size:14px;font-weight:600;color:#374151;margin-bottom:8px">Podpis — imię i nazwisko *</label>
          <input type="text" name="signature" required placeholder="np. Jan Kowalski" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:18px;font-family:'Segoe Script','Brush Script MT',cursive;color:#1e3a8a;margin-bottom:22px">
          <button type="submit" style="width:100%;background:#2563eb;color:#fff;border:none;border-radius:12px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit">✅ Potwierdzam odbiór i podpisuję</button>
        </form>
      </div>
      <div style="background:#f9fafb;padding:14px 28px;border-top:1px solid #e5e7eb;text-align:center"><p style="margin:0;font-size:12px;color:#9ca3af">Potwierdzenie ma charakter elektroniczny — zapisujemy datę i godzinę akceptacji.</p></div>
    </div>
  </div>
</body></html>`
}

export function handoverConfirmationHtml(projectName: string, number: string, clientName: string) {
  return `<!DOCTYPE html>
<html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odbiór potwierdzony</title></head>
<body style="margin:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.1);overflow:hidden">
    <div style="background:linear-gradient(135deg,#16a34a,#15803d);padding:44px 40px;text-align:center">
      <div style="font-size:72px;line-height:1">✅</div>
      <h1 style="margin:12px 0 0;color:#fff;font-size:24px">Odbiór potwierdzony</h1>
    </div>
    <div style="padding:36px 40px;text-align:center">
      <p style="margin:0 0 8px;color:#374151;font-size:16px;line-height:1.6">Dziękujemy! Protokół odbioru <strong>${number}</strong> dla projektu <strong>${projectName}</strong> został potwierdzony${clientName ? ` przez <strong>${clientName}</strong>` : ''}.</p>
      <p style="margin:0;color:#6b7280;font-size:14px">Wykonawca otrzymał powiadomienie. Możesz zamknąć tę stronę.</p>
    </div>
  </div>
</body></html>`
}

// ─── Przypomnienia o wygasających badaniach lekarskich i BHP ─────────────────

export interface EmployeeExpiryItem {
  name: string
  type: 'medical' | 'bhp'
  expiryDate: string
  daysLeft: number
}

export async function sendEmployeeExpiryReminderEmail(
  items: EmployeeExpiryItem[],
  toEmail: string,
): Promise<void> {
  const { transport, from: cfgFrom, fromName: cfgFromName } = await buildTransport()
  const dateStr = new Date().toLocaleDateString('pl-PL', { day: '2-digit', month: 'long', year: 'numeric' })

  const typeLabel = (t: 'medical' | 'bhp') =>
    t === 'medical' ? '🩺 Badania lekarskie' : '🦺 Szkolenie BHP'

  const urgencyColor = (d: number) =>
    d <= 7 ? '#dc2626' : d <= 14 ? '#d97706' : '#ca8a04'

  const urgencyBg = (d: number) =>
    d <= 7 ? '#fef2f2' : d <= 14 ? '#fffbeb' : '#fefce8'

  const rows = items.map(it => `
    <tr style="border-bottom:1px solid #f0f0f0;">
      <td style="padding:10px 14px;font-size:14px;color:#111827;font-weight:500">${it.name}</td>
      <td style="padding:10px 14px;font-size:13px;color:#374151">${typeLabel(it.type)}</td>
      <td style="padding:10px 14px;font-size:13px;color:#374151;text-align:center">${it.expiryDate}</td>
      <td style="padding:10px 14px;text-align:center">
        <span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;color:${urgencyColor(it.daysLeft)};background:${urgencyBg(it.daysLeft)}">
          ${it.daysLeft <= 0 ? '❌ Wygasło!' : `⏳ ${it.daysLeft} dni`}
        </span>
      </td>
    </tr>
  `).join('')

  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Przypomnienie — badania pracownicze</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:600px;width:100%">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#0f766e,#134e4a);padding:28px 36px">
            <p style="margin:0;color:#99f6e4;font-size:12px;letter-spacing:.08em;text-transform:uppercase">HR · Bezpieczeństwo pracy</p>
            <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700">⚠️ Wygasające badania pracownicze</h1>
            <p style="margin:6px 0 0;color:#ccfbf1;font-size:13px">${dateStr}</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px 36px">
            <p style="margin:0 0 20px;color:#374151;font-size:14px;line-height:1.6">
              Poniżsi pracownicy mają badania lekarskie lub szkolenia BHP, których termin ważności upływa w ciągu <strong>30 dni</strong>. Prosimy o niezwłoczne umówienie wizyt / szkoleń.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
              <thead>
                <tr style="background:#f0fdf4">
                  <th style="padding:10px 14px;text-align:left;font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Pracownik</th>
                  <th style="padding:10px 14px;text-align:left;font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Rodzaj badania</th>
                  <th style="padding:10px 14px;text-align:center;font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Data ważności</th>
                  <th style="padding:10px 14px;text-align:center;font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:.05em">Pozostało</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>

            <div style="margin-top:24px;padding:14px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px">
              <p style="margin:0;font-size:13px;color:#166534;line-height:1.5">
                💡 <strong>Pamiętaj:</strong> Pracownik bez aktualnych badań nie może wykonywać pracy. Skontaktuj się z lekarzem medycyny pracy lub centrum szkoleniowym BHP jak najszybciej.
              </p>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 36px;border-top:1px solid #e5e7eb">
            <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center">
              Wiadomość wygenerowana automatycznie przez ${cfgFromName}. Prosimy nie odpowiadać.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`

  const count = items.length
  const label = count === 1 ? 'pracownik wymaga' : count < 5 ? 'pracowników wymaga' : 'pracowników wymaga'
  await transport.sendMail({
    from: `"${cfgFromName}" <${cfgFrom}>`,
    to: toEmail,
    subject: `⚠️ [HR] ${count} ${label} odnowienia badań — ${dateStr}`,
    html,
  })
}

// ─── Ankieta Smart Home — wysyłka do klienta ──────────────────────────────────

export async function sendSurveyEmail(
  to: string,
  clientName: string,
  projectName: string,
  surveyUrl: string,
  fromName: string,
): Promise<void> {
  const { transport, from: cfgFrom, fromName: cfgFromName } = await buildTransport()
  const senderName = fromName || cfgFromName || 'Smart Home Center'

  // Base64-embedded logos — avoids broken images in email clients that block external URLs
  // White logo: for dark hero background
  const LOGO_WHITE_B64 = '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'
  // Colored logo: for light footer background
  const LOGO_COLOR_B64 = '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'

  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ankieta — ${projectName}</title>
</head>
<body style="margin:0;padding:0;background:#efece6;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif">

<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#efece6">
  <tr>
    <td align="center" style="padding:48px 16px">

      <!-- ══ Main email card ══ -->
      <table width="640" cellpadding="0" cellspacing="0"
             style="max-width:640px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e6e1d3">

        <!-- ══ DARK HERO ══ -->
        <tr>
          <td bgcolor="#0d1223" style="padding:32px 44px 40px;color:#ffffff">

            <!-- Logo row + badge -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td valign="middle">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td valign="middle" style="padding-right:14px">
                        <img src="data:image/png;base64,${LOGO_WHITE_B64}"
                             alt="Smart Home Center" height="26"
                             style="display:block;height:26px;width:auto;border:0" />
                      </td>
                      <td valign="middle"
                          style="border-left:1px solid rgba(143,160,194,0.35);padding-left:14px">
                        <span style="font-size:10px;color:#8FA0C2;letter-spacing:0.9px;
                                     text-transform:uppercase;font-weight:bold;line-height:1.5;
                                     display:block">Projektowanie<br />inteligentnych dom&#xF3;w</span>
                      </td>
                    </tr>
                  </table>
                </td>
                <td valign="middle" align="right">
                  <span style="font-size:10px;color:#8FA0C2;letter-spacing:0.9px;
                               text-transform:uppercase;font-weight:bold;
                               border:1px solid rgba(143,160,194,0.35);border-radius:999px;
                               padding:6px 13px;display:inline-block;white-space:nowrap">
                    Ankieta przygotowawcza
                  </span>
                </td>
              </tr>
            </table>

            <!-- Project label + name -->
            <table cellpadding="0" cellspacing="0" style="margin-top:46px">
              <tr>
                <td valign="middle" style="padding-right:8px">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="width:18px;height:1px;background:#8FA0C2;font-size:0;line-height:0">&nbsp;</td>
                    </tr>
                  </table>
                </td>
                <td valign="middle">
                  <span style="font-size:11px;color:#8FA0C2;letter-spacing:1.2px;
                               text-transform:uppercase;font-weight:bold">Projekt</span>
                </td>
              </tr>
            </table>
            <div style="font-family:Georgia,'Times New Roman',serif;
                        font-size:42px;line-height:1.05;margin-top:10px;
                        letter-spacing:-0.5px;color:#ffffff;word-break:break-word">
              ${projectName}
            </div>

            <!-- ── Floating white card (nested inside dark hero) ── -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px">
              <tr>
                <td bgcolor="#ffffff"
                    style="background:#ffffff;border-radius:16px;
                           padding:30px 34px 28px;border:1px solid #ECEAF4">

                  <!-- Greeting -->
                  <p style="font-size:16px;line-height:1.5;color:#1a1626;
                             margin:0 0 14px;font-weight:bold;
                             font-family:Arial,'Helvetica Neue',sans-serif">
                    Szanowny/-a <strong style="font-weight:700">${clientName}</strong>,
                  </p>
                  <p style="font-size:14px;line-height:1.75;color:#3b3450;
                             margin:0 0 12px;font-family:Arial,'Helvetica Neue',sans-serif">
                    Przygotowujemy dla Pa&#x0144;stwa projekt <strong>inteligentnego domu</strong>
                    i&nbsp;chcemy, aby spe&#x0142;nia&#x0142; Wasze oczekiwania w&nbsp;100%.
                  </p>
                  <p style="font-size:14px;line-height:1.75;color:#3b3450;margin:0;
                             font-family:Arial,'Helvetica Neue',sans-serif">
                    Aby lepiej pozna&#x0107; Wasze potrzeby i&nbsp;preferencje,
                    przygotowali&#x015B;my kr&#xF3;tk&#x0105; ankiet&#x0119;.
                    Wype&#x0142;nienie zajmuje oko&#x0142;o&nbsp;<strong>5&#x2013;10&nbsp;minut</strong>.
                  </p>

                  <!-- Roadmap: 3 steps -->
                  <table width="100%" cellpadding="0" cellspacing="0"
                         style="margin-top:26px;border-top:1px solid #F1EEF9;padding-top:18px">
                    <tr>

                      <!-- Step 01 (active) -->
                      <td width="31%" valign="top">
                        <table cellpadding="0" cellspacing="0">
                          <tr>
                            <td>
                              <div style="width:26px;height:26px;border-radius:999px;
                                          background:#0070F0;color:#ffffff;font-size:11px;
                                          font-weight:bold;text-align:center;line-height:26px;
                                          margin-bottom:8px;
                                          font-family:Arial,sans-serif">01</div>
                            </td>
                          </tr>
                          <tr>
                            <td style="font-size:12px;color:#1a1626;font-weight:bold;
                                       line-height:1.3;font-family:Arial,sans-serif">
                              Wype&#x0142;nij ankiet&#x0119;
                            </td>
                          </tr>
                          <tr>
                            <td style="font-size:11px;color:#7A6E94;padding-top:3px;
                                       font-family:Arial,sans-serif">
                              Dzi&#x015B;&nbsp;&#xB7;&nbsp;5&#x2013;10&nbsp;min
                            </td>
                          </tr>
                        </table>
                      </td>

                      <!-- Connector -->
                      <td width="4%" valign="top" style="padding-top:13px">
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="height:1px;background:#E6E1F5;
                                       font-size:0;line-height:0">&nbsp;</td>
                          </tr>
                        </table>
                      </td>

                      <!-- Step 02 -->
                      <td width="31%" valign="top">
                        <table cellpadding="0" cellspacing="0">
                          <tr>
                            <td>
                              <div style="width:26px;height:26px;border-radius:999px;
                                          background:#F4F0FE;color:#7A6E94;font-size:11px;
                                          font-weight:bold;text-align:center;line-height:26px;
                                          margin-bottom:8px;
                                          font-family:Arial,sans-serif">02</div>
                            </td>
                          </tr>
                          <tr>
                            <td style="font-size:12px;color:#1a1626;font-weight:bold;
                                       line-height:1.3;font-family:Arial,sans-serif">
                              Spotkanie konsultacyjne
                            </td>
                          </tr>
                          <tr>
                            <td style="font-size:11px;color:#7A6E94;padding-top:3px;
                                       font-family:Arial,sans-serif">
                              W ci&#x0105;gu&nbsp;7&nbsp;dni
                            </td>
                          </tr>
                        </table>
                      </td>

                      <!-- Connector -->
                      <td width="4%" valign="top" style="padding-top:13px">
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="height:1px;background:#E6E1F5;
                                       font-size:0;line-height:0">&nbsp;</td>
                          </tr>
                        </table>
                      </td>

                      <!-- Step 03 -->
                      <td width="30%" valign="top">
                        <table cellpadding="0" cellspacing="0">
                          <tr>
                            <td>
                              <div style="width:26px;height:26px;border-radius:999px;
                                          background:#F4F0FE;color:#7A6E94;font-size:11px;
                                          font-weight:bold;text-align:center;line-height:26px;
                                          margin-bottom:8px;
                                          font-family:Arial,sans-serif">03</div>
                            </td>
                          </tr>
                          <tr>
                            <td style="font-size:12px;color:#1a1626;font-weight:bold;
                                       line-height:1.3;font-family:Arial,sans-serif">
                              Projekt systemu
                            </td>
                          </tr>
                          <tr>
                            <td style="font-size:11px;color:#7A6E94;padding-top:3px;
                                       font-family:Arial,sans-serif">
                              Indywidualnie
                            </td>
                          </tr>
                        </table>
                      </td>

                    </tr>
                  </table>

                </td>
              </tr>
            </table>
            <!-- /floating card -->

          </td>
        </tr>
        <!-- /dark hero -->

        <!-- ══ CTA ══ -->
        <tr>
          <td bgcolor="#ffffff" style="padding:30px 44px 6px;text-align:center">

            <!-- Dark pill button -->
            <table cellpadding="0" cellspacing="0" style="margin:0 auto">
              <tr>
                <td bgcolor="#1a1626"
                    style="border-radius:999px;overflow:hidden;padding:0">
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:16px 16px 16px 28px;vertical-align:middle">
                        <a href="${surveyUrl}"
                           style="color:#ffffff;text-decoration:none;font-size:15px;
                                  font-weight:bold;letter-spacing:0.1px;white-space:nowrap;
                                  font-family:Arial,'Helvetica Neue',sans-serif">
                          Wype&#x0142;nij ankiet&#x0119;
                        </a>
                      </td>
                      <td style="padding:16px 20px 16px 0;vertical-align:middle">
                        <table cellpadding="0" cellspacing="0">
                          <tr>
                            <td bgcolor="#0070F0"
                                style="width:24px;height:24px;border-radius:999px;
                                       text-align:center;line-height:24px;
                                       vertical-align:middle;overflow:hidden">
                              <span style="color:#ffffff;font-size:15px;
                                           font-family:Arial,sans-serif;
                                           font-weight:bold;line-height:24px">&#8594;</span>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Meta: duration + no registration -->
            <p style="margin:14px 0 0;font-size:12px;color:#7A6E94;
                      font-family:Arial,sans-serif;line-height:1.5">
              &#x23F1;&nbsp;5&#x2013;10&nbsp;min &nbsp;&nbsp;&#xB7;&nbsp;&nbsp;
              &#x1F512;&nbsp;Bez rejestracji
            </p>

          </td>
        </tr>

        <!-- ══ FALLBACK LINK ══ -->
        <tr>
          <td bgcolor="#ffffff" style="padding:24px 44px 0">
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border:1px solid #F1EEF9;border-radius:12px;overflow:hidden">
              <tr>
                <td bgcolor="#FAF8FF"
                    style="background:#FAF8FF;padding:14px 18px;border-radius:12px">
                  <p style="margin:0 0 5px;font-size:12px;color:#7A6E94;font-weight:bold;
                             font-family:Arial,sans-serif;line-height:1.4">
                    Bezpo&#x015B;redni link, je&#x015B;li przycisk nie dzia&#x0142;a:
                  </p>
                  <p style="margin:0;font-size:11px;color:#0070F0;word-break:break-all;
                             font-family:'Courier New',Courier,monospace">
                    <a href="${surveyUrl}"
                       style="color:#0070F0;text-decoration:none">${surveyUrl}</a>
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ══ FOOTER ══ -->
        <tr>
          <td bgcolor="#ffffff" style="padding:24px 44px 36px">
            <p style="font-size:13px;color:#3b3450;margin:0 0 22px;line-height:1.7;
                      font-family:Arial,'Helvetica Neue',sans-serif">
              W razie pyta&#x0144; &#x2014; jeste&#x015B;my do dyspozycji.<br />
              Dzi&#x0119;kujemy za zaufanie i&nbsp;zapraszamy do wsp&#xF3;&#x0142;pracy.
            </p>
            <!-- Divider + logo + contact -->
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border-top:1px solid #F1EEF9">
              <tr>
                <td style="padding-top:18px" valign="middle">
                  <img src="data:image/webp;base64,${LOGO_COLOR_B64}"
                       alt="Smart Home Center" height="20"
                       style="display:block;height:20px;width:auto;border:0" />
                </td>
                <td style="padding-top:18px" valign="middle" align="right">
                  <a href="mailto:biuro@smarthomecenter.pl"
                     style="color:#0070F0;text-decoration:none;font-size:11px;
                            font-family:Arial,sans-serif">biuro@smarthomecenter.pl</a>
                  <span style="color:#D9D2E8;margin:0 8px;font-size:11px">&#xB7;</span>
                  <a href="https://smarthomecenter.pl"
                     style="color:#0070F0;text-decoration:none;font-size:11px;
                            font-family:Arial,sans-serif">smarthomecenter.pl</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
      <!-- /main card -->

    </td>
  </tr>
</table>

</body>
</html>`

  await transport.sendMail({
    from: `"${senderName}" <${cfgFrom}>`,
    to,
    subject: `Ankieta przygotowawcza — projekt: ${projectName}`,
    html,
  })
}
