/**
 * Raport „Kondycja firmy" e-mailem — HTML (inline CSS, tabelki, bez zasobów zewnętrznych),
 * wysyłka do adminów + księgowego + dodatkowych adresów, log do ReportDispatch.
 *
 * buildReportEmail()     — pełny raport (ten sam HTML co podgląd w aplikacji)
 * buildIncompleteEmail() — „raport czeka na dane" (lista błędów z linkami)
 * sendReport()           — liczy health, wybiera wariant (force = pełny mimo braków), wysyła, loguje
 *
 * Log wysyłki (ReportDispatch): wpis `sending` powstaje PRZED wysyłką i po niej zmienia status na
 * `sent` | `incomplete`; gdy zapis po wysyłce się nie uda, wpis zostaje jako `sending` (e-mail już poszedł,
 * nie rzucamy). Wpis `sending` młodszy niż 2 h = wysyłka w toku → sendReport odmawia (bez duplikatu e-maila).
 * Błąd przed/podczas wysyłki → wpis `sending` jest usuwany, log `failed` (raz dziennie per okres).
 */
import nodemailer from 'nodemailer'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db'
import { getSmtpConfig } from './mailer'
import { computeHealth, formatPln, plural, warsawToday, type HealthResponse, type HealthKind, type HealthCheck } from './finance-health'
import { getCompanySettings } from '../settings-store'
import { currentCompanyId, getDefaultCompanyId } from '../tenant'

export const appUrl = () => process.env.APP_URL || 'https://smarthome-app-ssrv.onrender.com'
const now = () => new Date().toISOString()

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const STATUS_META = {
  green:  { color: '#15803d', bg: '#dcfce7', word: 'Jest dobrze', emoji: '🟢' },
  yellow: { color: '#a16207', bg: '#fef9c3', word: 'Uwaga',       emoji: '🟡' },
  red:    { color: '#b91c1c', bg: '#fee2e2', word: 'Strata',      emoji: '🔴' },
} as const

const SEVERITY_META = {
  error: { icon: '⛔', color: '#b91c1c', label: 'brakuje danych' },
  warn:  { icon: '⚠️', color: '#a16207', label: 'do sprawdzenia' },
  info:  { icon: 'ℹ️', color: '#1d4ed8', label: 'informacja' },
} as const

/** „▲ +12 %" / „▼ −5 %" / „—" (brak bazy). */
export function deltaText(cur: number, prev: number): string {
  if (!prev) return '—'
  const pct = Math.round((cur - prev) / Math.abs(prev) * 100)
  if (pct === 0) return '= 0 %'
  return pct > 0 ? `▲ +${pct} %` : `▼ −${Math.abs(pct)} %`
}

const td = (content: string, extra = '') => `<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;${extra}">${content}</td>`
const th = (content: string, extra = '') => `<th style="padding:10px 12px;text-align:left;font-size:13px;color:#5B21B6;${extra}">${content}</th>`
const table = (head: string, body: string) =>
  `<table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;margin-top:8px;font-size:14px;">
    <thead><tr style="background:#EDE9FE;">${head}</tr></thead><tbody>${body}</tbody></table>`
const h2 = (t: string) => `<h2 style="font-size:16px;color:#111827;margin:24px 0 4px;">${t}</h2>`
const muted = (t: string) => `<p style="font-size:12px;color:#6b7280;margin:4px 0 0;">${t}</p>`

function tile(label: string, value: string, hint: string, color = '#111827'): string {
  return `<td style="width:25%;padding:6px;vertical-align:top;">
    <div style="background:white;border:1px solid #e5e7eb;border-radius:10px;padding:12px;">
      <div style="font-size:12px;color:#6b7280;">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color};margin:4px 0;">${value}</div>
      <div style="font-size:11px;color:#9ca3af;line-height:1.3;">${hint}</div>
    </div></td>`
}

function checksHtml(checks: HealthCheck[]): string {
  if (!checks.length) return '<p style="font-size:14px;color:#15803d;">✅ Nic do sprawdzenia — wszystkie dane są na miejscu.</p>'
  const items = checks.map(c => {
    const m = SEVERITY_META[c.severity]
    const link = c.link ? ` <a href="${esc(appUrl() + c.link)}" style="color:#6d28d9;font-weight:600;text-decoration:none;">Przejdź →</a>` : ''
    return `<li style="margin:6px 0;color:#111827;"><span style="color:${m.color};">${m.icon}</span> ${esc(c.message)}${link}</li>`
  }).join('')
  return `<ul style="padding-left:18px;margin:8px 0;font-size:14px;line-height:1.45;">${items}</ul>`
}

function footer(): string {
  return `<p style="font-size:11px;color:#9ca3af;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:12px;">
    Raport wygenerowany automatycznie przez SHC Manager; liczby zarządcze, ostateczne — biuro rachunkowe.
    Pełne dane: <a href="${esc(appUrl())}/kondycja" style="color:#6d28d9;">${esc(appUrl())}/kondycja</a></p>`
}

// ── Pełny raport ─────────────────────────────────────────────────────────────
export function buildReportEmail(health: HealthResponse, companyName: string): { subject: string; html: string } {
  const s = STATUS_META[health.status]
  const t = health.tiles
  const net = health.lines.net_result
  const subject = `${s.emoji} Kondycja firmy — ${health.label}: ${net >= 0 ? 'zysk' : 'strata'} ${formatPln(Math.abs(net))}`
  const cashValue = t.cash === null ? '—' : formatPln(t.cash)
  const cashHint = t.cash === null ? 'brak sald — wgraj wyciąg MT940' : `stan na ${esc(t.cash_date ?? '')}`

  const cmpRow = (label: string, c: HealthResponse['compare']['prev']) => {
    if (!c) return `<tr>${td(label)}${td('brak danych', 'color:#9ca3af;')}${td('')}${td('')}</tr>`
    return `<tr>${td(esc(c.label))}
      ${td(`${formatPln(c.revenue)} <span style="color:#6b7280;font-size:12px;">${deltaText(t.revenue, c.revenue)}</span>`, 'text-align:right;')}
      ${td(`${formatPln(c.costs)} <span style="color:#6b7280;font-size:12px;">${deltaText(t.costs, c.costs)}</span>`, 'text-align:right;')}
      ${td(`${formatPln(c.ebitda)} <span style="color:#6b7280;font-size:12px;">${deltaText(t.ebitda, c.ebitda)}</span>`, 'text-align:right;')}</tr>`
  }

  const breakdownRows = health.cost_breakdown.length
    ? health.cost_breakdown.map(b => `<tr>${td(esc(b.label))}${td(formatPln(b.amount), 'text-align:right;font-weight:600;')}${td(`${b.pct} %`, 'text-align:right;color:#6b7280;')}</tr>`).join('')
    : `<tr>${td('Brak kosztów w tym okresie', 'color:#9ca3af;')}${td('')}${td('')}</tr>`

  const x = health.taxes
  const taxRows = [
    ['VAT do zapłaty (szacunek)', formatPln(x.vat_due_estimate), `VAT ze sprzedaży ${formatPln(x.vat_output)} − VAT z zakupów ${formatPln(x.vat_input)}`],
    [`CIT — szacunek od stycznia (${x.cit_rate} %)`, formatPln(x.cit_estimate_ytd), `podstawa ${formatPln(x.cit_base_ytd)}`],
    ['CIT zapłacony od stycznia', formatPln(x.cit_paid_ytd), ''],
    ['CIT do dopłaty (szacunek)', formatPln(x.cit_to_pay_estimate), ''],
    ['ZUS w tym okresie', formatPln(x.zus), ''],
  ].map(([l, v, h]) => `<tr>${td(`${esc(l)}${h ? `<br><span style="font-size:11px;color:#9ca3af;">${esc(h)}</span>` : ''}`)}${td(v, 'text-align:right;font-weight:600;white-space:nowrap;')}</tr>`).join('')

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
    <div style="background:${s.color};padding:20px;border-radius:10px 10px 0 0;">
      <div style="color:rgba(255,255,255,0.85);font-size:12px;">${esc(companyName || 'SHC Manager')}</div>
      <h1 style="color:white;margin:2px 0 0;font-size:20px;">📊 Kondycja firmy — ${esc(health.label)}</h1>
      <div style="display:inline-block;margin-top:10px;background:${s.bg};color:${s.color};font-weight:700;font-size:13px;padding:4px 10px;border-radius:999px;">${s.emoji} ${s.word}</div>
    </div>
    <div style="background:#F9FAFB;padding:20px;border-radius:0 0 10px 10px;">
      <p style="font-size:17px;font-weight:600;margin:0;">${esc(health.headline)}</p>
      <p style="font-size:13px;color:#6b7280;margin:4px 0 12px;">${esc(health.subline)}</p>

      <table style="width:100%;border-collapse:collapse;"><tr>
        ${tile('Przychód', formatPln(t.revenue), 'ile sprzedaliśmy (netto)')}
        ${tile('Koszty', formatPln(t.costs), 'towar, pensje, biuro, auta (bez CIT)')}
        ${tile('Zysk EBITDA', formatPln(t.ebitda), `czy biznes sam z siebie zarabia · marża ${t.ebitda_pct} %`, t.ebitda < 0 ? '#b91c1c' : '#15803d')}
        ${tile('Gotówka', cashValue, cashHint)}
      </tr></table>
      <p style="font-size:13px;color:#374151;margin:8px 0 0;">Na czysto (po amortyzacji, odsetkach i CIT): <strong>${formatPln(net)}</strong>.
        Do odebrania od klientów: <strong>${formatPln(health.cash.receivables)}</strong>${health.cash.overdue_receivables > 0 ? ` (po terminie ${formatPln(health.cash.overdue_receivables)})` : ''},
        do zapłaty dostawcom: <strong>${formatPln(health.cash.payables)}</strong>${health.cash.overdue_payables > 0 ? ` (po terminie ${formatPln(health.cash.overdue_payables)})` : ''}.</p>

      ${h2('Porównanie')}
      ${table(`${th('Okres')}${th('Przychód', 'text-align:right;')}${th('Koszty', 'text-align:right;')}${th('EBITDA', 'text-align:right;')}`,
        `<tr style="background:#faf5ff;">${td(`<strong>${esc(health.label)}</strong>`)}${td(`<strong>${formatPln(t.revenue)}</strong>`, 'text-align:right;')}${td(`<strong>${formatPln(t.costs)}</strong>`, 'text-align:right;')}${td(`<strong>${formatPln(t.ebitda)}</strong>`, 'text-align:right;')}</tr>`
        + cmpRow('Poprzedni okres', health.compare.prev) + cmpRow('Rok temu', health.compare.yoy))}
      ${muted('Strzałki pokazują zmianę względem tamtego okresu.')}

      ${h2('Na co idą pieniądze')}
      ${table(`${th('Kategoria')}${th('Kwota', 'text-align:right;')}${th('Udział', 'text-align:right;')}`, breakdownRows)}
      ${muted('Sześć największych grup kosztów (netto) w tym okresie.')}

      ${h2('Podatki')}
      ${table(`${th('Pozycja')}${th('Kwota', 'text-align:right;')}`, taxRows)}
      ${muted(esc(x.note))}

      ${h2('Do sprawdzenia')}
      ${checksHtml(health.checks)}
      ${footer()}
    </div>
  </div>`
  return { subject, html }
}

// ── „Raport czeka na dane" ───────────────────────────────────────────────────
export function buildIncompleteEmail(health: HealthResponse): { subject: string; html: string; missing: string[] } {
  const errors = health.checks.filter(c => c.severity === 'error')
  const missing = errors.map(c => c.message)
  const subject = `⏳ Raport „Kondycja firmy" za ${health.label} czeka na dane`
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
    <div style="background:#6b7280;padding:20px;border-radius:10px 10px 0 0;">
      <h1 style="color:white;margin:0;font-size:20px;">⏳ Raport za ${esc(health.label)} czeka na dane</h1>
    </div>
    <div style="background:#F9FAFB;padding:20px;border-radius:0 0 10px 10px;">
      <p style="font-size:15px;margin:0 0 8px;">Nie da się jeszcze rzetelnie policzyć wyniku za <strong>${esc(health.label)}</strong>. Brakuje:</p>
      ${checksHtml(errors)}
      <p style="font-size:13px;color:#374151;">Po uzupełnieniu danych raport wyśle się automatycznie (sprawdzamy co godzinę).
        Można go też wysłać ręcznie mimo braków: <a href="${esc(appUrl())}/kondycja" style="color:#6d28d9;">Kondycja firmy → Wyślij raport teraz</a>.</p>
      <p style="font-size:13px;color:#6b7280;">Wstępnie: ${esc(health.headline)}</p>
      ${footer()}
    </div>
  </div>`
  return { subject, html, missing }
}

// ── Odbiorcy ─────────────────────────────────────────────────────────────────
/** „a@x.pl, b@y.pl; c@z.pl" → ['a@x.pl','b@y.pl','c@z.pl'] (tylko wpisy z @). */
export function parseEmails(s?: string | null): string[] {
  return String(s ?? '').split(/[,;\s]+/).map(e => e.trim()).filter(e => e.includes('@'))
}

export async function collectRecipients(): Promise<string[]> {
  const [users, settings] = await Promise.all([
    // admini (globalni) + księgowi tylko z aktywnej firmy (company_id null = firma domyślna)
    (async () => {
      const cid = currentCompanyId() ?? getDefaultCompanyId()
      const isDefault = !cid || cid === getDefaultCompanyId()
      return prisma.user.findMany({
        where: { OR: [{ role: 'admin' }, { can_view_payments: true, ...(isDefault ? { OR: [{ company_id: null }, { company_id: cid ?? undefined }] } : { company_id: cid }) }] },
        select: { email: true },
      })
    })(),
    getCompanySettings().catch(() => null),
  ])
  const set = new Set<string>()
  for (const u of users) if (u.email?.includes('@')) set.add(u.email.trim().toLowerCase())
  for (const e of parseEmails(settings?.report_emails)) set.add(e.toLowerCase())
  return [...set]
}

// ── Wysyłka + log ────────────────────────────────────────────────────────────
async function deliver(recipients: string[], mail: { subject: string; html: string }): Promise<void> {
  const cfg = await getSmtpConfig()
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: false },
  })
  await transport.sendMail({ from: `"${cfg.fromName}" <${cfg.from}>`, to: recipients.join(', '), subject: mail.subject, html: mail.html })
}

export type DispatchStatus = 'sending' | 'sent' | 'incomplete' | 'failed'

async function logDispatch(kind: HealthKind, period: string, status: DispatchStatus, recipients: string[], summary: Record<string, unknown>): Promise<string> {
  const id = uuidv4()
  await prisma.reportDispatch.create({ data: { id, kind, period, status, recipients: recipients.join(', '), summary: summary as any, created_at: now() } })
  return id
}

/** Wpis `sending` młodszy niż tyle = wysyłka w toku (lub niedokończona po awarii) — nie wysyłamy drugi raz. */
export const SENDING_IN_PROGRESS_MS = 2 * 60 * 60 * 1000

/** Czysta: czy wśród logów (kind, period) jest wpis `sending` młodszy niż 2 h. Starsze `sending` traktujemy jak nieudane. */
export function sendingInProgress(logs: { status: string; created_at: string }[], nowDate: Date = new Date()): boolean {
  const cutoff = nowDate.getTime() - SENDING_IN_PROGRESS_MS
  return logs.some(l => l.status === 'sending' && Date.parse(l.created_at) >= cutoff)
}

/** Log „failed" — nie częściej niż raz dziennie (Europe/Warsaw) per (kind, period). */
export async function logFailed(kind: HealthKind, period: string, error: string): Promise<void> {
  try {
    const today = warsawToday().iso
    const existing = await prisma.reportDispatch.findFirst({ where: { kind, period, status: 'failed', created_at: { gte: `${today}T00:00:00` } } })
    if (existing) return
    await logDispatch(kind, period, 'failed', [], { error: String(error).slice(0, 500) })
  } catch (e: any) {
    console.error('[Raport] Nie udało się zapisać logu błędu:', e?.message ?? e)
  }
}

export type SendReportResult = {
  sent: boolean                       // czy jakikolwiek e-mail poszedł (pełny raport lub „czeka na dane")
  status: 'sent' | 'incomplete'       // sent = pełny raport; incomplete = wysłano tylko listę braków
  recipients: string[]
  missing: string[]
  message: string
}

/**
 * Wysyła raport za okres. Bez `force`: kompletny → pełny raport (log `sent`),
 * niekompletny → „czeka na dane" (log `incomplete`). Z `force` → zawsze pełny.
 * Błąd (SMTP, brak odbiorców) → log `failed` + rzut wyjątku.
 * Wpis `sending` (< 2 h) dla tego okresu → rzut wyjątku BEZ wysyłki i bez logu `failed` (wysyłka w toku).
 */
export async function sendReport(kind: HealthKind, period: string, opts: { force?: boolean; health?: HealthResponse } = {}): Promise<SendReportResult> {
  const pending = await prisma.reportDispatch.findMany({ where: { kind, period, status: 'sending' }, select: { status: true, created_at: true } })
  if (sendingInProgress(pending)) {
    throw new Error(`Wysyłka raportu za ${period} już trwa lub nie została dokończona — spróbuj ponownie za chwilę.`)
  }

  let dispatchId: string | null = null
  try {
    const health = opts.health ?? await computeHealth(period)
    const [recipients, settings] = await Promise.all([
      collectRecipients(),
      getCompanySettings().catch(() => null),
    ])
    if (!recipients.length) throw new Error('Brak odbiorców raportu — dodaj adresy w ustawieniach raportu.')
    const companyName = settings?.company_name || process.env.COMPANY_NAME || 'SHC Manager'
    const missing = health.checks.filter(c => c.severity === 'error').map(c => c.message)
    const full = health.complete || !!opts.force
    const status = full ? 'sent' : 'incomplete'
    const mail = full ? buildReportEmail(health, companyName) : buildIncompleteEmail(health)

    // Log „sending" PRZED wysyłką — gdyby zapis statusu po wysyłce się nie udał, wpis nie zniknie
    // i harmonogram / drugi klik nie wyśle tego samego raportu jeszcze raz.
    dispatchId = await logDispatch(kind, period, 'sending', recipients, {
      headline: health.headline, health_status: health.status, complete: health.complete, forced: !!opts.force && !health.complete, missing,
    })
    await deliver(recipients, mail)

    let logNote = ''
    try {
      await prisma.reportDispatch.update({ where: { id: dispatchId }, data: { status } })
    } catch (e: any) {
      // E-mail już poszedł — nie rzucamy (rzut = 500 dla użytkownika i ponowna wysyłka z harmonogramu).
      console.error(`[Raport] E-mail ${kind} ${period} wysłany, ale nie udało się zapisać statusu „${status}" w logu:`, e?.message ?? e)
      logNote = ' Uwaga: nie udało się zapisać statusu w logu wysyłek — wpis pozostanie jako „wysyłanie".'
    }
    const message = (full
      ? `Wysłano raport za ${health.label} do ${recipients.length} ${plural(recipients.length, 'odbiorcy', 'odbiorców', 'odbiorców')}${!health.complete ? ' (mimo braków w danych)' : ''}.`
      : `Dane za ${health.label} są niekompletne — wysłano listę braków do ${recipients.length} ${plural(recipients.length, 'odbiorcy', 'odbiorców', 'odbiorców')}. Użyj „wyślij mimo braków", aby wysłać pełny raport.`
    ) + logNote
    return { sent: true, status, recipients, missing, message }
  } catch (e: any) {
    // E-mail nie wyszedł — wpis „sending" nie może blokować ponowienia; log „failed" (raz dziennie).
    if (dispatchId) await prisma.reportDispatch.delete({ where: { id: dispatchId } }).catch(() => {})
    await logFailed(kind, period, e?.message ?? String(e))
    throw e
  }
}
