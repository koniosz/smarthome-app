/**
 * KSeF 2.0 — Krajowy System e-Faktur
 * API 2.0 (od 1 lutego 2026)
 *
 * Dokumentacja: https://api.ksef.mf.gov.pl/docs/v2/index.html
 * Base URL: https://api.ksef.mf.gov.pl/v2
 */

import axios from 'axios'
import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'
import { v4 as uuidv4 } from 'uuid'

const prisma = new PrismaClient()

const KSEF_NIP   = (process.env.KSEF_NIP  || '').replace(/[-\s]/g, '')
const KSEF_TOKEN = process.env.KSEF_TOKEN || ''

const BASE_URL = 'https://api.ksef.mf.gov.pl/v2'

function now() { return new Date().toISOString() }

function axiosError(err: any): string {
  if (err?.response) {
    return `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
  }
  return err?.message ?? String(err)
}

/** Parsuj JWT exp claim → ISO string */
function parseJwtExpiry(jwt: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
    if (payload.exp) return new Date(payload.exp * 1000).toISOString()
  } catch {}
  return new Date(Date.now() + 60 * 60 * 1000).toISOString() // fallback 1h
}

/**
 * Pobierz klucz publiczny MF do szyfrowania tokenu KSeF (RSA-OAEP SHA-256)
 */
async function getEncryptionPublicKey(): Promise<crypto.KeyObject> {
  const res = await axios.get(`${BASE_URL}/security/public-key-certificates`, { timeout: 15000 })
  const certs: Array<{ certificate: string; usage: string; validFrom: string; validTo: string }> = res.data

  const hasUsage = (c: any, u: string) =>
    Array.isArray(c.usage) ? c.usage.includes(u) : c.usage === u

  const cert = certs.find(c => hasUsage(c, 'KsefTokenEncryption'))
  if (!cert) throw new Error(`Brak certyfikatu KsefTokenEncryption. Dostępne: ${certs.map(c => JSON.stringify(c.usage)).join(', ')}`)

  // certificate to Base64 DER — może być X.509 lub SubjectPublicKeyInfo
  // Próbuj jako PEM certyfikat (X.509)
  try {
    const pem = `-----BEGIN CERTIFICATE-----\n${cert.certificate}\n-----END CERTIFICATE-----`
    return crypto.createPublicKey(pem)
  } catch {
    // Fallback: SPKI DER
    return crypto.createPublicKey({
      key: Buffer.from(cert.certificate, 'base64'),
      format: 'der',
      type: 'spki',
    })
  }
}

/**
 * Szyfrowanie tokenu KSeF wg specyfikacji 2.0:
 * plaintext = "${token}|${timestampMs}"
 * encrypted = RSA-OAEP(SHA-256, publicKey, plaintext)
 * result = Base64(encrypted)
 */
function encryptTokenRsa(apiToken: string, timestampMs: number | string, publicKey: crypto.KeyObject): string {
  const plaintext = `${apiToken}|${timestampMs}`
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(plaintext, 'utf8'),
  )
  return encrypted.toString('base64')
}

/**
 * Odśwież accessToken używając refreshToken
 */
async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await axios.post(
    `${BASE_URL}/auth/token/refresh`,
    {},
    { headers: { Authorization: `Bearer ${refreshToken}` }, timeout: 15000 },
  )
  const { accessToken } = res.data
  if (!accessToken) throw new Error('Brak accessToken w refresh response')

  const expiresAt = parseJwtExpiry(accessToken)
  await prisma.ksefSession.updateMany({ data: { session_token: accessToken, expires_at: expiresAt } })
  console.log('[KSeF] Token odświeżony, ważny do:', expiresAt)
  return accessToken
}

/**
 * Pobierz aktywny accessToken (z bazy lub utwórz nowy)
 */
export async function getActiveSession(): Promise<string> {
  const existing = await prisma.ksefSession.findFirst({ orderBy: { created_at: 'desc' } })

  if (existing) {
    const expiresAt = new Date(existing.expires_at)
    const margin    = new Date(Date.now() + 5 * 60 * 1000) // 5 min margines

    if (expiresAt > margin) {
      return existing.session_token
    }

    // Spróbuj odświeżyć przez refreshToken
    if (existing.refresh_token) {
      try {
        return await refreshAccessToken(existing.refresh_token)
      } catch (err: any) {
        console.warn('[KSeF] Refresh token nieważny, tworzę nową sesję:', err.message)
      }
    }
  }

  return await createSession()
}

/**
 * Autoryzacja w KSeF 2.0 — 4-krokowy flow:
 * 1. POST /auth/challenge
 * 2. POST /auth/ksef-token (z zaszyfrowanym tokenem RSA-OAEP)
 * 3. Poll GET /auth/{referenceNumber} do czasu zakończenia
 * 4. POST /auth/token/redeem → accessToken + refreshToken
 */
async function createSession(): Promise<string> {
  if (!KSEF_NIP || !KSEF_TOKEN) {
    throw new Error('Brak konfiguracji KSeF (KSEF_NIP lub KSEF_TOKEN nie ustawione)')
  }

  // ── Krok 1: Pobierz klucz publiczny ───────────────────────────────────────
  let publicKey: crypto.KeyObject
  try {
    publicKey = await getEncryptionPublicKey()
  } catch (err: any) {
    throw new Error(`Błąd pobierania klucza publicznego MF: ${axiosError(err)}`)
  }

  // ── Krok 2: Challenge ──────────────────────────────────────────────────────
  let challengeData: { challenge: string; timestampMs: number }
  try {
    const res = await axios.post(`${BASE_URL}/auth/challenge`, {}, { timeout: 15000 })
    challengeData = res.data
    console.log(`[KSeF] Challenge: ${challengeData.challenge}, timestampMs: ${challengeData.timestampMs}`)
  } catch (err: any) {
    throw new Error(`Challenge failed: ${axiosError(err)}`)
  }
  if (!challengeData.challenge) {
    throw new Error(`Brak challenge w odpowiedzi: ${JSON.stringify(challengeData)}`)
  }

  // ── Krok 3: Zaszyfruj token i zainicjuj autoryzację ───────────────────────
  const encryptedToken = encryptTokenRsa(KSEF_TOKEN, challengeData.timestampMs, publicKey)

  let referenceNumber: string
  let authenticationToken: string
  try {
    const res = await axios.post(
      `${BASE_URL}/auth/ksef-token`,
      {
        challenge:         challengeData.challenge,
        contextIdentifier: { type: 'Nip', value: KSEF_NIP },
        encryptedToken,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
    )
    referenceNumber = res.data?.referenceNumber
    // authenticationToken może być stringiem lub obiektem { token, validUntil }
    const authTokenRaw = res.data?.authenticationToken
    authenticationToken = typeof authTokenRaw === 'string' ? authTokenRaw : authTokenRaw?.token
    console.log(`[KSeF] Auth init OK, referenceNumber: ${referenceNumber}`)
  } catch (err: any) {
    throw new Error(`Token auth init failed: ${axiosError(err)}`)
  }
  if (!referenceNumber || !authenticationToken) {
    throw new Error('Brak referenceNumber lub authenticationToken po init')
  }

  // ── Krok 4: Krótkie oczekiwanie — token auth weryfikuje się błyskawicznie ──
  // Polling dostępny, ale dla token-auth zwykle 1-2s wystarczy
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const statusRes = await axios.get(
        `${BASE_URL}/auth/${referenceNumber}`,
        { headers: { Authorization: `Bearer ${authenticationToken}` }, timeout: 15000 },
      )
      console.log(`[KSeF] Auth status (${i + 1}): ${JSON.stringify(statusRes.data)}`)
      const { status, isTokenRedeemed } = statusRes.data
      // Każdy status inny niż Pending oznacza gotowość do redeem
      if (status && status !== 'Pending') break
      if (isTokenRedeemed === false) break
    } catch (err: any) {
      console.warn(`[KSeF] Poll error (${i + 1}):`, axiosError(err))
      // Mimo błędu pollingu — spróbuj redeem
      break
    }
  }

  // ── Krok 5: Redeem — pobierz accessToken + refreshToken ───────────────────
  let accessToken: string
  let refreshToken: string | undefined
  try {
    const redeemRes = await axios.post(
      `${BASE_URL}/auth/token/redeem`,
      {},
      { headers: { Authorization: `Bearer ${authenticationToken}` }, timeout: 15000 },
    )
    const rawAccess  = redeemRes.data?.accessToken
    const rawRefresh = redeemRes.data?.refreshToken
    // API zwraca obiekty { token, validUntil } zamiast stringów
    accessToken  = typeof rawAccess  === 'string' ? rawAccess  : rawAccess?.token
    refreshToken = typeof rawRefresh === 'string' ? rawRefresh : rawRefresh?.token
    if (!accessToken) throw new Error(`Brak accessToken: ${JSON.stringify(redeemRes.data)}`)
  } catch (err: any) {
    throw new Error(`Token redeem failed: ${axiosError(err)}`)
  }

  const expiresAt = parseJwtExpiry(accessToken)

  await prisma.ksefSession.deleteMany()
  await prisma.ksefSession.create({
    data: {
      id:            uuidv4(),
      session_token: accessToken,
      refresh_token: refreshToken ?? null,
      expires_at:    expiresAt,
      created_at:    now(),
    },
  })

  console.log('[KSeF v2] Nowa sesja utworzona, ważna do:', expiresAt)
  return accessToken
}

/**
 * Zamknij sesję KSeF
 */
export async function terminateSession(): Promise<void> {
  const existing = await prisma.ksefSession.findFirst()
  if (!existing) return

  try {
    await axios.delete(`${BASE_URL}/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${existing.session_token}` },
      timeout: 10000,
    })
  } catch {
    // Ignoruj błąd — sesja mogła już wygasnąć
  }
  await prisma.ksefSession.deleteMany()
}

/**
 * Pobierz faktury zakupowe (Subject3 = nabywca) za podany okres
 */
async function fetchInvoices(accessToken: string, dateFrom: Date, dateTo: Date): Promise<any[]> {
  const all: any[] = []
  let pageOffset = 0
  const pageSize = 100

  while (true) {
    let res: any
    try {
      res = await axios.post(
        `${BASE_URL}/invoices/query/metadata`,
        {
          subjectType: 'Subject3', // nabywca (kupujący)
          dateRange: {
            dateType: 'Issue',
            from: dateFrom.toISOString().split('T')[0],
            to:   dateTo.toISOString().split('T')[0],
          },
        },
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          params:  { pageOffset, pageSize, sortOrder: 'Asc' },
          timeout: 30000,
        },
      )
    } catch (err: any) {
      throw new Error(`Invoice query failed: ${axiosError(err)}`)
    }

    const invoices: any[] = res.data.invoices ?? []
    all.push(...invoices)

    console.log(`[KSeF] Pobrano ${invoices.length} faktur (offset ${pageOffset}), hasMore=${res.data.hasMore}`)

    if (!res.data.hasMore || invoices.length === 0) break
    pageOffset += pageSize
  }

  return all
}

/**
 * Mapuj InvoiceMetadata z KSeF 2.0 na nasze pola
 */
function mapInvoice(inv: any) {
  return {
    ksef_number:    inv.ksefNumber ?? '',
    invoice_number: inv.invoiceNumber ?? '',
    seller_name:    inv.seller?.name ?? '',
    seller_nip:     inv.seller?.nip ?? '',
    net_amount:     parseFloat(inv.netAmount   ?? '0') || 0,
    vat_amount:     parseFloat(inv.vatAmount   ?? '0') || 0,
    gross_amount:   parseFloat(inv.grossAmount ?? '0') || 0,
    currency:       inv.currency ?? 'PLN',
    invoice_date:   inv.issueDate ?? inv.invoicingDate ?? now().split('T')[0],
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
    const accessToken = await getActiveSession()

    // Pobierz faktury od ostatniej synchronizacji (lub 90 dni wstecz)
    const lastSession = await prisma.ksefSession.findFirst()
    const dateFrom = lastSession?.last_sync_at
      ? new Date(lastSession.last_sync_at)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const dateTo = new Date()

    console.log(`[KSeF] Synchronizacja od ${dateFrom.toISOString()} do ${dateTo.toISOString()}`)

    const invoices = await fetchInvoices(accessToken, dateFrom, dateTo)
    fetched = invoices.length
    console.log(`[KSeF] Pobrano ${fetched} faktur łącznie`)

    for (const inv of invoices) {
      try {
        const mapped = mapInvoice(inv)
        if (!mapped.ksef_number) continue

        const exists = await prisma.ksefInvoice.findUnique({ where: { ksef_number: mapped.ksef_number } })
        if (exists) continue

        await prisma.ksefInvoice.create({
          data: {
            id:               uuidv4(),
            ...mapped,
            acquisition_date: now().split('T')[0],
            raw_data:         JSON.stringify(inv),
            created_at:       now(),
          },
        })
        saved++
      } catch (err: any) {
        errors.push(`Faktura ${inv.ksefNumber ?? '?'}: ${err.message}`)
      }
    }

    // Zaktualizuj czas ostatniej synchronizacji
    await prisma.ksefSession.updateMany({ data: { last_sync_at: now() } })

    console.log(`[KSeF] Zapisano ${saved} nowych faktur. Błędy: ${errors.length}`)
  } catch (err: any) {
    const msg = err?.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message
    console.error('[KSeF] Błąd synchronizacji:', msg)
    errors.push(msg)
  }

  return { fetched, saved, errors }
}

/**
 * Diagnostyka autoryzacji — zwraca szczegóły każdego kroku
 */
export async function debugAuth(): Promise<Record<string, any>> {
  const result: Record<string, any> = {
    config: {
      base_url:     BASE_URL,
      nip_set:      !!KSEF_NIP,
      nip_length:   KSEF_NIP.length,
      token_set:    !!KSEF_TOKEN,
      token_length: KSEF_TOKEN.length,
    },
  }

  if (!KSEF_NIP || !KSEF_TOKEN) {
    result.error = 'Brak konfiguracji KSEF_NIP lub KSEF_TOKEN'
    return result
  }

  // Klucze publiczne
  try {
    const keysRes = await axios.get(`${BASE_URL}/security/public-key-certificates`, { timeout: 15000 })
    result.public_keys = keysRes.data.map((c: any) => ({
      usage:    c.usage,
      validTo:  c.validTo,
      certLen:  c.certificate?.length,
    }))
  } catch (err: any) {
    result.public_keys_error = axiosError(err)
    return result
  }

  // Challenge
  try {
    const challengeRes = await axios.post(`${BASE_URL}/auth/challenge`, {}, { timeout: 15000 })
    result.challenge_response = { status: challengeRes.status, data: challengeRes.data }

    const { challenge, timestampMs } = challengeRes.data
    if (!challenge) {
      result.error = 'Brak challenge'
      return result
    }

    // Szyfrowanie
    try {
      const pk = await getEncryptionPublicKey()
      const enc = encryptTokenRsa(KSEF_TOKEN, timestampMs, pk)
      result.encrypted_token_length = enc.length

      // Auth init
      try {
        const authRes = await axios.post(
          `${BASE_URL}/auth/ksef-token`,
          { challenge, contextIdentifier: { type: 'Nip', value: KSEF_NIP }, encryptedToken: enc },
          { timeout: 15000 },
        )
        result.auth_init = { status: authRes.status, data: authRes.data }
        result.success = !!authRes.data?.authenticationToken
      } catch (err: any) {
        result.auth_init_error = { status: err?.response?.status, data: err?.response?.data, message: err?.message }
      }
    } catch (err: any) {
      result.encrypt_error = err.message
    }
  } catch (err: any) {
    result.challenge_error = { status: err?.response?.status, data: err?.response?.data, message: err?.message }
  }

  return result
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
  const session       = await prisma.ksefSession.findFirst()
  const invoiceCount  = await prisma.ksefInvoice.count()
  const unassignedCnt = await prisma.ksefInvoice.count({ where: { project_id: null } })

  return {
    configured:         !!(KSEF_NIP && KSEF_TOKEN),
    env:                'prod (v2)',
    nip:                KSEF_NIP ? `${KSEF_NIP.slice(0, 3)}***${KSEF_NIP.slice(-3)}` : '',
    has_session:        !!session,
    session_expires_at: session?.expires_at ?? null,
    last_sync_at:       session?.last_sync_at ?? null,
    invoice_count:      invoiceCount,
    unassigned_count:   unassignedCnt,
  }
}
