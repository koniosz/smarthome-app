/**
 * KSeF — Krajowy System e-Faktur
 * Integracja z API KSeF MF (Ministerstwo Finansów)
 *
 * Dokumentacja: https://ksef.mf.gov.pl/api
 * Środowisko testowe: https://ksef-test.mf.gov.pl/api
 */

import axios from 'axios'
import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'
import { v4 as uuidv4 } from 'uuid'

const prisma = new PrismaClient()

const KSEF_ENV   = process.env.KSEF_ENV   || 'test'
const KSEF_NIP   = (process.env.KSEF_NIP  || '').replace(/[-\s]/g, '')
const KSEF_TOKEN = process.env.KSEF_TOKEN || ''

const BASE_URL = KSEF_ENV === 'prod'
  ? 'https://ksef.mf.gov.pl/api'
  : 'https://ksef-test.mf.gov.pl/api'

function now() { return new Date().toISOString() }

/**
 * Szyfrowanie tokenu API wg specyfikacji KSeF:
 * key = SHA-256(challenge)
 * iv  = pierwsze 16 bajtów klucza
 * cipher = AES-256-CBC
 */
function encryptToken(apiToken: string, challenge: string): string {
  const key = crypto.createHash('sha256').update(challenge, 'utf8').digest()
  const iv  = key.slice(0, 16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(apiToken, 'utf8')),
    cipher.final(),
  ])
  return encrypted.toString('base64')
}

/**
 * Pobierz aktywny token sesji (z bazy lub utwórz nowy)
 */
export async function getActiveSession(): Promise<string> {
  // Sprawdź czy mamy ważną sesję (z marginesem 5 min)
  const existing = await prisma.ksefSession.findFirst({
    orderBy: { created_at: 'desc' },
  })

  if (existing) {
    const expiresAt = new Date(existing.expires_at)
    const margin = new Date(Date.now() + 5 * 60 * 1000) // +5 min margines
    if (expiresAt > margin) {
      return existing.session_token
    }
  }

  // Utwórz nową sesję
  return await createSession()
}

/**
 * Autoryzacja w KSeF — tworzy nową sesję online
 */
async function createSession(): Promise<string> {
  if (!KSEF_NIP || !KSEF_TOKEN) {
    throw new Error('Brak konfiguracji KSeF (KSEF_NIP lub KSEF_TOKEN nie ustawione)')
  }

  // Krok 1: AuthorisationChallenge
  const challengeRes = await axios.post(
    `${BASE_URL}/online/Session/AuthorisationChallenge`,
    { contextIdentifier: { type: 'onip', identifier: KSEF_NIP } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
  )
  const { challenge, timestamp } = challengeRes.data
  if (!challenge) throw new Error('KSeF nie zwróciło challenge')

  // Krok 2: Szyfrowanie tokenu
  const encryptedToken = encryptToken(KSEF_TOKEN, challenge)

  // Krok 3: Authorisation
  const authRes = await axios.post(
    `${BASE_URL}/online/Session/Authorisation`,
    {
      contextIdentifier: { type: 'onip', identifier: KSEF_NIP },
      documentType: { version: '1-0E', value: 'KSeF' },
      encryptedToken,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
  )

  const sessionToken = authRes.data?.sessionToken
  if (!sessionToken) throw new Error('KSeF nie zwróciło sessionToken')

  // Sesja ważna 24h — zapisz z expires_at
  const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString()

  // Usuń stare sesje
  await prisma.ksefSession.deleteMany()

  await prisma.ksefSession.create({
    data: {
      id: uuidv4(),
      session_token: sessionToken,
      expires_at: expiresAt,
      created_at: now(),
    },
  })

  console.log('[KSeF] Nowa sesja utworzona, ważna do:', expiresAt)
  return sessionToken
}

/**
 * Zamknij sesję KSeF
 */
export async function terminateSession(): Promise<void> {
  const existing = await prisma.ksefSession.findFirst()
  if (!existing) return

  try {
    await axios.get(`${BASE_URL}/online/Session/Terminate`, {
      headers: { 'SessionToken': existing.session_token },
      timeout: 10000,
    })
  } catch {
    // Ignoruj błąd — sesja mogła już wygasnąć
  }
  await prisma.ksefSession.deleteMany()
}

/**
 * Pobierz faktury zakupowe z KSeF za podany okres
 */
async function fetchInvoices(sessionToken: string, dateFrom: Date, dateTo: Date): Promise<any[]> {
  // KSeF query — faktury wystawione dla naszego NIP (zakupowe/received)
  const queryRes = await axios.post(
    `${BASE_URL}/online/Invoice/query`,
    {
      queryCriteria: {
        subjectType: 'subject3',  // subject3 = nabywca (kupujący)
        dateRange: {
          startDate: dateFrom.toISOString().split('T')[0],
          endDate:   dateTo.toISOString().split('T')[0],
        },
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'SessionToken': sessionToken,
      },
      timeout: 30000,
    },
  )

  return queryRes.data?.invoiceHeaderList ?? []
}

/**
 * Pobierz szczegóły jednej faktury (XML)
 */
async function fetchInvoiceDetails(sessionToken: string, ksefNumber: string): Promise<string | null> {
  try {
    const res = await axios.get(
      `${BASE_URL}/online/Invoice/get/${ksefNumber}`,
      {
        headers: { 'SessionToken': sessionToken },
        responseType: 'text',
        timeout: 15000,
      },
    )
    return res.data
  } catch {
    return null
  }
}

/**
 * Parsuje nagłówek faktury z odpowiedzi KSeF
 */
function parseInvoiceHeader(header: any): {
  ksef_number: string
  invoice_number: string
  seller_name: string
  seller_nip: string
  net_amount: number
  vat_amount: number
  gross_amount: number
  currency: string
  invoice_date: string
} {
  return {
    ksef_number:    header.ksefReferenceNumber ?? header.referenceNumber ?? '',
    invoice_number: header.invoiceReferenceNumber ?? header.invoiceNumber ?? '',
    seller_name:    header.subjectBy?.name ?? header.sellerName ?? '',
    seller_nip:     header.subjectBy?.issuedToIdentifier?.identifier ?? header.sellerNip ?? '',
    net_amount:     parseFloat(header.net   ?? header.netAmount   ?? '0') || 0,
    vat_amount:     parseFloat(header.vat   ?? header.vatAmount   ?? '0') || 0,
    gross_amount:   parseFloat(header.gross ?? header.grossAmount ?? '0') || 0,
    currency:       header.currency ?? 'PLN',
    invoice_date:   header.invoiceDate ?? header.issuedDate ?? now().split('T')[0],
  }
}

/**
 * Główna funkcja synchronizacji — wywołana co 30 min przez cron
 */
export async function syncInvoices(): Promise<{ fetched: number; saved: number; errors: string[] }> {
  const errors: string[] = []
  let fetched = 0
  let saved   = 0

  try {
    const sessionToken = await getActiveSession()

    // Pobierz faktury z ostatnich 90 dni (lub od ostatniej synchronizacji)
    const lastSession = await prisma.ksefSession.findFirst()
    const lastSync = lastSession?.last_sync_at
      ? new Date(lastSession.last_sync_at)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // 90 dni wstecz

    const dateTo   = new Date()
    const dateFrom = lastSync

    console.log(`[KSeF] Synchronizacja od ${dateFrom.toISOString()} do ${dateTo.toISOString()}`)

    const headers = await fetchInvoices(sessionToken, dateFrom, dateTo)
    fetched = headers.length
    console.log(`[KSeF] Pobrano ${fetched} nagłówków faktur`)

    for (const header of headers) {
      try {
        const parsed = parseInvoiceHeader(header)
        if (!parsed.ksef_number) continue

        // Sprawdź czy już mamy tę fakturę
        const existing = await prisma.ksefInvoice.findUnique({
          where: { ksef_number: parsed.ksef_number },
        })
        if (existing) continue

        await prisma.ksefInvoice.create({
          data: {
            id:               uuidv4(),
            ksef_number:      parsed.ksef_number,
            invoice_number:   parsed.invoice_number,
            seller_name:      parsed.seller_name,
            seller_nip:       parsed.seller_nip,
            net_amount:       parsed.net_amount,
            vat_amount:       parsed.vat_amount,
            gross_amount:     parsed.gross_amount,
            currency:         parsed.currency,
            invoice_date:     parsed.invoice_date,
            acquisition_date: now().split('T')[0],
            raw_data:         JSON.stringify(header),
            created_at:       now(),
          },
        })
        saved++
      } catch (err: any) {
        errors.push(`Faktura ${header.ksefReferenceNumber ?? '?'}: ${err.message}`)
      }
    }

    // Zaktualizuj czas ostatniej synchronizacji
    await prisma.ksefSession.updateMany({
      data: { last_sync_at: now() },
    })

    console.log(`[KSeF] Zapisano ${saved} nowych faktur. Błędy: ${errors.length}`)
  } catch (err: any) {
    console.error('[KSeF] Błąd synchronizacji:', err.message)
    errors.push(err.message)
  }

  return { fetched, saved, errors }
}

/**
 * Status połączenia z KSeF
 */
export async function getStatus(): Promise<{
  configured: boolean
  env: string
  nip: string
  has_session: boolean
  session_expires_at: string | null
  last_sync_at: string | null
  invoice_count: number
  unassigned_count: number
}> {
  const session = await prisma.ksefSession.findFirst()
  const invoiceCount    = await prisma.ksefInvoice.count()
  const unassignedCount = await prisma.ksefInvoice.count({ where: { project_id: null } })

  return {
    configured:         !!(KSEF_NIP && KSEF_TOKEN),
    env:                KSEF_ENV,
    nip:                KSEF_NIP ? `${KSEF_NIP.slice(0, 3)}***${KSEF_NIP.slice(-3)}` : '',
    has_session:        !!session,
    session_expires_at: session?.expires_at ?? null,
    last_sync_at:       session?.last_sync_at ?? null,
    invoice_count:      invoiceCount,
    unassigned_count:   unassignedCount,
  }
}
