// Microsoft Graph — synchronizacja zadań portalu z kalendarzami Outlook / Office 365.
//
// Tryb aplikacyjny (client credentials): jedna rejestracja aplikacji w Entra ID
// z uprawnieniem aplikacyjnym Calendars.ReadWrite + zgoda administratora.
// Backend zapisuje wydarzenia bezpośrednio w kalendarzach użytkowników po emailu —
// pracownicy nie muszą się nigdzie logować.
//
// Wymagane zmienne środowiskowe:
//   MS_TENANT_ID     — Directory (tenant) ID
//   MS_CLIENT_ID     — Application (client) ID
//   MS_CLIENT_SECRET — Client secret (Value, nie Secret ID)
// Bez nich integracja jest wyłączona (no-op) — CRUD zadań działa normalnie.

import axios from 'axios'

const TENANT = process.env.MS_TENANT_ID
const CLIENT = process.env.MS_CLIENT_ID
const SECRET = process.env.MS_CLIENT_SECRET

const GRAPH = 'https://graph.microsoft.com/v1.0'
const TIMEZONE = 'Europe/Warsaw'

export function graphConfigured(): boolean {
  return Boolean(TENANT && CLIENT && SECRET)
}

// ── Token cache (client credentials) ─────────────────────────────────────────
let cached: { token: string; expiresAt: number } | null = null

async function getToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: CLIENT!,
      client_secret: SECRET!,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  )
  cached = {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in ?? 3600) * 1000,
  }
  return cached.token
}

// ── Event payload from a portal task ─────────────────────────────────────────
export interface TaskForCalendar {
  title: string
  date: string          // YYYY-MM-DD
  time: string          // HH:MM lub '' — początek
  endTime?: string      // HH:MM lub '' — koniec (puste = +1h od początku)
  type: string          // work | event | task
  done: boolean
  projectName?: string | null
}

const TYPE_LABELS: Record<string, string> = { work: 'Praca', event: 'Spotkanie', task: 'Zadanie' }

function buildEvent(task: TaskForCalendar) {
  const subject = `${task.done ? '✓ ' : ''}${task.title}`
  const bodyLines = [
    task.projectName ? `Projekt: ${task.projectName}` : null,
    `Typ: ${TYPE_LABELS[task.type] ?? task.type}`,
    '',
    'Zadanie z portalu Smart Home Center ERP',
  ].filter(l => l !== null)

  if (!task.time) {
    // całodniowe: end = następny dzień (wymóg Graph dla isAllDay)
    const d = new Date(task.date + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    const next = d.toISOString().slice(0, 10)
    return {
      subject,
      body: { contentType: 'text', content: bodyLines.join('\n') },
      isAllDay: true,
      start: { dateTime: `${task.date}T00:00:00`, timeZone: TIMEZONE },
      end:   { dateTime: `${next}T00:00:00`,      timeZone: TIMEZONE },
      categories: ['SHC ERP'],
    }
  }

  // godzinowe: koniec z zadania, a gdy brak/niepoprawny — start + 1 h
  const [h, m] = task.time.split(':').map(Number)
  let end = (task.endTime ?? '').trim()
  if (!/^\d{2}:\d{2}$/.test(end) || end <= task.time) {
    end = `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  return {
    subject,
    body: { contentType: 'text', content: bodyLines.join('\n') },
    isAllDay: false,
    start: { dateTime: `${task.date}T${task.time}:00`, timeZone: TIMEZONE },
    end:   { dateTime: `${task.date}T${end}:00`, timeZone: TIMEZONE },
    categories: ['SHC ERP'],
  }
}

// ── CRUD wydarzeń w kalendarzu użytkownika ────────────────────────────────────
// Wszystkie funkcje zwracają wynik lub null/false przy błędzie — nigdy nie rzucają,
// żeby awaria integracji nie blokowała operacji na zadaniach.

export async function createCalendarEvent(userEmail: string, task: TaskForCalendar): Promise<string | null> {
  if (!graphConfigured() || !userEmail) return null
  try {
    const token = await getToken()
    const res = await axios.post(
      `${GRAPH}/users/${encodeURIComponent(userEmail)}/calendar/events`,
      buildEvent(task),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    console.log(`[Outlook] Utworzono wydarzenie dla ${userEmail}: ${task.title}`)
    return res.data.id ?? null
  } catch (err: any) {
    console.error(`[Outlook] Błąd tworzenia wydarzenia (${userEmail}):`, err?.response?.data?.error?.message ?? err.message)
    return null
  }
}

export async function updateCalendarEvent(userEmail: string, eventId: string, task: TaskForCalendar): Promise<boolean> {
  if (!graphConfigured() || !userEmail || !eventId) return false
  try {
    const token = await getToken()
    await axios.patch(
      `${GRAPH}/users/${encodeURIComponent(userEmail)}/events/${encodeURIComponent(eventId)}`,
      buildEvent(task),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    return true
  } catch (err: any) {
    console.error(`[Outlook] Błąd aktualizacji wydarzenia (${userEmail}):`, err?.response?.data?.error?.message ?? err.message)
    return false
  }
}

export async function deleteCalendarEvent(userEmail: string, eventId: string): Promise<boolean> {
  if (!graphConfigured() || !userEmail || !eventId) return false
  try {
    const token = await getToken()
    await axios.delete(
      `${GRAPH}/users/${encodeURIComponent(userEmail)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    return true
  } catch (err: any) {
    // 404 = już nie istnieje — traktuj jako sukces
    if (err?.response?.status === 404) return true
    console.error(`[Outlook] Błąd usuwania wydarzenia (${userEmail}):`, err?.response?.data?.error?.message ?? err.message)
    return false
  }
}

// ── Odczyt wydarzeń z kalendarza Outlook (kierunek Outlook → aplikacja) ─────────
export interface OutlookCalendarEvent {
  id: string
  subject: string
  date: string        // YYYY-MM-DD (czas lokalny Europe/Warsaw)
  startTime: string   // HH:MM ('' dla całodniowych)
  endTime: string     // HH:MM ('' dla całodniowych)
  isAllDay: boolean
}

// Wydarzenia kalendarza pracownika w zakresie dat. Pomija wydarzenia utworzone
// przez aplikację (kategoria „SHC ERP"), bo te już widać jako zadania portalu.
export async function listCalendarEvents(userEmail: string, fromDate: string, toDate: string): Promise<OutlookCalendarEvent[]> {
  if (!graphConfigured() || !userEmail) return []
  try {
    const token = await getToken()
    const url = `${GRAPH}/users/${encodeURIComponent(userEmail)}/calendarView`
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TIMEZONE}"` },
      params: {
        startDateTime: `${fromDate}T00:00:00`,
        endDateTime: `${toDate}T23:59:59`,
        $select: 'id,subject,start,end,isAllDay,categories,isCancelled',
        $orderby: 'start/dateTime',
        $top: 150,
      },
      timeout: 15000,
    })
    const items: any[] = res.data?.value ?? []
    return items
      .filter(ev => !ev.isCancelled && !(Array.isArray(ev.categories) && ev.categories.includes('SHC ERP')))
      .map(ev => {
        const startDt: string = ev.start?.dateTime ?? '' // "2026-06-15T10:00:00.0000000"
        const endDt: string = ev.end?.dateTime ?? ''
        const date = startDt.slice(0, 10)
        return {
          id: ev.id as string,
          subject: (ev.subject ?? '(bez tytułu)') as string,
          date,
          startTime: ev.isAllDay ? '' : startDt.slice(11, 16),
          endTime: ev.isAllDay ? '' : endDt.slice(11, 16),
          isAllDay: Boolean(ev.isAllDay),
        }
      })
      .filter(ev => ev.date)
  } catch (err: any) {
    console.error(`[Outlook] Błąd odczytu kalendarza (${userEmail}):`, err?.response?.data?.error?.message ?? err.message)
    return []
  }
}
