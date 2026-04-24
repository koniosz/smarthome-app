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
 * Pobierz faktury za jeden chunk (max 3 miesiące) dla danego subjectType.
 * Każda faktura jest oznaczona polem _subjectType aby mapInvoice mógł
 * wiarygodnie ustalić kierunek (Subject1=sprzedażowa, Subject2=zakupowa).
 */
async function fetchInvoicesChunk(
  accessToken: string,
  dateFrom: Date,
  dateTo: Date,
  subjectType: 'Subject1' | 'Subject2' | 'Subject3' | 'SubjectAuthorized' | string,
): Promise<any[]> {
  const all: any[] = []
  let pageOffset = 0
  const pageSize = 100
  const fromStr = dateFrom.toISOString().split('T')[0]
  const toStr   = dateTo.toISOString().split('T')[0]

  while (true) {
    let res: any
    try {
      res = await axios.post(
        `${BASE_URL}/invoices/query/metadata`,
        {
          subjectType,
          dateRange: { dateType: 'Issue', from: fromStr, to: toStr },
        },
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          params:  { pageOffset, pageSize, sortOrder: 'Asc' },
          timeout: 30000,
        },
      )
    } catch (err: any) {
      throw new Error(`Invoice query failed (${subjectType} ${fromStr}–${toStr}): ${axiosError(err)}`)
    }

    const invoices: any[] = res.data.invoices ?? []
    // Oznacz każdą fakturę żeby mapInvoice wiedział z jakiego zapytania pochodzi
    const tagged = invoices.map(inv => ({ ...inv, _subjectType: subjectType }))
    all.push(...tagged)
    console.log(`[KSeF] ${subjectType} ${fromStr}–${toStr}: ${invoices.length} faktur (offset ${pageOffset}), hasMore=${res.data.hasMore}`)

    if (!res.data.hasMore || invoices.length === 0) break
    pageOffset += pageSize
  }

  return all
}

/**
 * Pobierz faktury za cały okres.
 *
 * Tryb inteligentny:
 *  - Jeśli zakres <= 89 dni  → 1 request na subject type (2 requestów łącznie)
 *  - Jeśli zakres > 89 dni   → chunki 89-dniowe z opóźnieniem 3s między nimi
 *    (żeby nie przekroczyć limitu 20 req/h przy historycznych synchronizacjach)
 *
 * Subject1 = Podmiot1 = sprzedażowe (my jako sprzedawca)
 * Subject2 = Podmiot2 = zakupowe   (my jako nabywca)
 */
async function fetchInvoices(
  accessToken: string,
  dateFrom: Date,
  dateTo: Date,
  errors: string[],
): Promise<any[]> {
  const all: any[] = []
  const CHUNK_MS     = 89 * 24 * 60 * 60 * 1000
  const totalMs      = dateTo.getTime() - dateFrom.getTime()
  const subjectTypes = ['Subject1', 'Subject2'] as const
  const seen         = new Set<string>()

  // Jeśli zakres mieści się w jednym chunku (typowa codzienna sync) — bez chunków
  const isShortRange = totalMs <= CHUNK_MS
  if (isShortRange) {
    console.log(`[KSeF] Krótki zakres (${Math.round(totalMs / 86400000)}d) — 1 request na subject type`)
  }

  for (const subjectType of subjectTypes) {
    let chunkStart = new Date(dateFrom)
    let chunkIndex = 0

    while (chunkStart < dateTo) {
      const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_MS, dateTo.getTime()))
      const fromStr  = chunkStart.toISOString().split('T')[0]
      const toStr    = chunkEnd.toISOString().split('T')[0]

      // Opóźnienie 3s między chunkiami (nie dotyczy pierwszego i krótkich zakresów)
      if (!isShortRange && chunkIndex > 0) {
        await new Promise(r => setTimeout(r, 3000))
      }

      try {
        const chunk = await fetchInvoicesChunk(accessToken, chunkStart, chunkEnd, subjectType)
        for (const inv of chunk) {
          const key = inv.ksefNumber ?? JSON.stringify(inv)
          if (!seen.has(key)) { seen.add(key); all.push(inv) }
        }
      } catch (err: any) {
        const msg = `${subjectType} ${fromStr}–${toStr}: ${axiosError(err)}`
        console.warn('[KSeF] Chunk error:', msg)
        errors.push(msg)
        // Jeśli 429 — przerwij chunki dla tego subject type (nie ma sensu dalej próbować)
        if (axiosError(err).includes('429')) {
          console.warn(`[KSeF] 429 rate limit dla ${subjectType} — przerywam chunki`)
          break
        }
      }

      chunkStart = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000)
      chunkIndex++
    }
  }

  console.log(`[KSeF] Łącznie unikalnych faktur: ${all.length}`)
  return all
}

/**
 * Mapuj InvoiceMetadata z KSeF 2.0 na nasze pola.
 *
 * Kierunek faktury jest ustalany na podstawie _subjectType (priorytet):
 *   Subject1 = my jako sprzedawca (Podmiot1) → outgoing (sprzedażowa)
 *   Subject2 = my jako nabywca    (Podmiot2) → incoming (zakupowa)
 *
 * Fallback: porównanie seller_nip z naszym KSEF_NIP (mniej niezawodne,
 * bo KSeF metadata nie zawsze zwraca nip sprzedawcy).
 */
function mapInvoice(inv: any) {
  const sellerNip = (inv.seller?.nip ?? '').replace(/[-\s]/g, '')
  const ourNip    = KSEF_NIP.replace(/[-\s]/g, '')

  // Priorytet: _subjectType ustawiony przez fetchInvoicesChunk
  let invoice_direction: 'outgoing' | 'incoming'
  if (inv._subjectType === 'Subject1') {
    invoice_direction = 'outgoing'   // Subject1 = Podmiot1 = MY wystawiamy
  } else if (inv._subjectType === 'Subject2') {
    invoice_direction = 'incoming'   // Subject2 = Podmiot2 = ktoś wystawia NAM
  } else {
    // Fallback: jeśli nie ma tagu (np. ręcznie wgrywane dane)
    invoice_direction = (ourNip && sellerNip === ourNip) ? 'outgoing' : 'incoming'
  }

  // KSeF 2.0: nabywca może być w inv.buyer lub inv.subject2
  const buyerObj = inv.buyer ?? inv.subject2 ?? {}

  // Dla sprzedażowych: seller = MY, buyer = klient
  // Dla zakupowych:    seller = dostawca, buyer = MY (ignorujemy buyer)
  const effectiveBuyerObj = invoice_direction === 'outgoing' ? buyerObj : {}

  console.log(`[KSeF] mapInvoice ${inv.ksefNumber ?? '?'}: subjectType=${inv._subjectType}, direction=${invoice_direction}, sellerNip=${sellerNip}`)

  return {
    ksef_number:       inv.ksefNumber ?? '',
    invoice_number:    inv.invoiceNumber ?? '',
    seller_name:       inv.seller?.name ?? '',
    seller_nip:        sellerNip,
    buyer_name:        effectiveBuyerObj.name ?? null,
    buyer_nip:         (effectiveBuyerObj.nip ?? '').replace(/[-\s]/g, '') || null,
    invoice_direction,
    net_amount:        parseFloat(inv.netAmount   ?? '0') || 0,
    vat_amount:        parseFloat(inv.vatAmount   ?? '0') || 0,
    gross_amount:      parseFloat(inv.grossAmount ?? '0') || 0,
    currency:          inv.currency ?? 'PLN',
    invoice_date:      inv.issueDate ?? inv.invoicingDate ?? now().split('T')[0],
  }
}

/**
 * Normalizuj nazwę firmy do porównania (usuń spację, przyimki, forma prawna)
 */
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(sp|z|o\.o\.|o\.o|s\.a\.|s\.a|s\.k\.a|sp\. z o\.o\.|spółka|limited|ltd|gmbh|inc|llc)\b/g, '')
    .replace(/[^a-z0-9ąćęłńóśźż]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Oceń podobieństwo nazw (0-1)
 */
function nameMatchScore(a: string, b: string): number {
  const na = normalizeCompanyName(a)
  const nb = normalizeCompanyName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1.0
  if (na.includes(nb) || nb.includes(na)) return 0.85
  const wa = new Set(na.split(' ').filter(w => w.length > 2))
  const wb = nb.split(' ').filter(w => w.length > 2)
  if (wa.size === 0 || wb.length === 0) return 0
  const common = wb.filter(w => wa.has(w)).length
  return common / Math.max(wa.size, wb.length)
}

/**
 * Dla nowej faktury sprzedażowej: spróbuj dopasować projekt po nazwie nabywcy / NIP
 */
async function tryAutoSuggestProject(invoiceId: string, buyerName: string | null, buyerNip: string | null): Promise<void> {
  if (!buyerName && !buyerNip) return
  const projects = await prisma.project.findMany({
    select: { id: true, client_name: true, client_contact: true },
  })

  let bestId: string | null = null
  let bestScore = 0

  for (const p of projects) {
    let score = 0

    // NIP match (jeśli klient ma NIP w polu kontaktowym)
    if (buyerNip && p.client_contact?.includes(buyerNip)) {
      score = 1.0
    } else if (buyerName && p.client_name) {
      score = nameMatchScore(buyerName, p.client_name)
    }

    if (score > bestScore) {
      bestScore = score
      bestId = p.id
    }
  }

  const THRESHOLD = 0.5
  if (bestId && bestScore >= THRESHOLD) {
    await prisma.ksefInvoice.update({
      where: { id: invoiceId },
      data: { suggested_project_id: bestId, suggestion_score: bestScore },
    })
    console.log(`[KSeF] Auto-sugestia: faktura ${invoiceId} → projekt ${bestId} (score: ${bestScore.toFixed(2)})`)
  }
}

/**
 * Naucz się kategorii z historii — znajdź najczęstszą alokację od tego samego dostawcy (wg NIP)
 * i jeśli jest spójna (>= 60% alokacji od tego dostawcy ma tę samą kategorię),
 * automatycznie utwórz alokację dla nowej faktury.
 *
 * @returns true jeśli alokacja została utworzona, false jeśli brak wzorca
 */
export async function tryAutoClassifyFromHistory(
  invoiceId: string,
  sellerNip: string | null,
  sellerName: string | null,
  grossAmount: number,
  invoiceDirection: string,
): Promise<boolean> {
  if (!sellerNip && !sellerName) return false

  // Szukamy alokacji faktur od tego samego sprzedawcy (wg NIP, lub wg nazwy gdy NIP brak)
  const pastInvoices = await prisma.ksefInvoice.findMany({
    where: sellerNip
      ? { seller_nip: sellerNip, id: { not: invoiceId } }
      : { seller_name: { contains: (sellerName ?? '').slice(0, 30), mode: 'insensitive' }, id: { not: invoiceId } },
    select: { id: true },
    take: 50,
  })

  if (pastInvoices.length === 0) return false

  const pastIds = pastInvoices.map(i => i.id)

  // Pobierz wszystkie alokacje od tych faktur (z pominięciem project-type — te uczą o kategorii CFO)
  const pastAllocs = await prisma.ksefInvoiceAllocation.findMany({
    where: {
      invoice_id: { in: pastIds },
      // Bierzemy tylko alokacje wewnętrzne (koszt) lub revenue (przychód)
      allocation_type: { in: ['internal', 'revenue'] },
    },
    select: { cost_category: true, subcategory: true, business_unit: true, allocation_type: true, amount: true },
  })

  if (pastAllocs.length === 0) return false

  // Znajdź najczęstszy wzorzec (cost_category + subcategory + business_unit + allocation_type)
  const freq: Record<string, { count: number; cost_category: string; subcategory: string; business_unit: string; allocation_type: string }> = {}
  for (const a of pastAllocs) {
    const key = `${a.allocation_type}|${a.cost_category ?? 'cogs'}|${a.subcategory ?? 'hardware'}|${a.business_unit ?? 'shc'}`
    if (!freq[key]) freq[key] = { count: 0, cost_category: a.cost_category ?? 'cogs', subcategory: a.subcategory ?? 'hardware', business_unit: a.business_unit ?? 'shc', allocation_type: a.allocation_type ?? 'internal' }
    freq[key].count++
  }

  const best = Object.values(freq).sort((a, b) => b.count - a.count)[0]
  const confidence = best.count / pastAllocs.length

  // Próg: 60% alokacji musi mieć ten sam wzorzec
  if (confidence < 0.6) {
    console.log(`[KSeF learn] ${sellerNip ?? sellerName}: wzorzec zbyt niejednorodny (confidence=${confidence.toFixed(2)}), pomijam`)
    return false
  }

  // Upewnij się że ta faktura jeszcze nie ma alokacji tego typu
  const existingAlloc = await prisma.ksefInvoiceAllocation.findFirst({
    where: { invoice_id: invoiceId, allocation_type: { in: ['internal', 'revenue'] } },
  })
  if (existingAlloc) return false  // już sklasyfikowana

  // Utwórz automatyczną alokację
  await prisma.ksefInvoiceAllocation.create({
    data: {
      id:              uuidv4(),
      invoice_id:      invoiceId,
      project_id:      null,
      amount:          grossAmount,
      notes:           `Auto-klasyfikacja (wzorzec z ${best.count} wcześniejszych faktur, pewność: ${Math.round(confidence * 100)}%)`,
      category:        best.cost_category === 'revenue' ? 'other' : 'other',
      allocation_type: best.allocation_type,
      cost_category:   best.cost_category,
      subcategory:     best.subcategory,
      business_unit:   best.business_unit,
      is_paid:         false,
      created_at:      new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    },
  })

  console.log(`[KSeF learn] Auto-klasyfikacja: faktura ${invoiceId} od ${sellerNip ?? sellerName} → ${best.allocation_type}/${best.cost_category}/${best.subcategory}/${best.business_unit} (confidence=${confidence.toFixed(2)})`)
  return true
}

/**
 * Główna funkcja synchronizacji — wywołana co 30 min przez cron
 */
export async function syncInvoices(forceDateFrom?: Date): Promise<{ fetched: number; saved: number; errors: string[] }> {
  const errors: string[] = []
  let fetched = 0
  let saved   = 0

  try {
    const accessToken = await getActiveSession()

    // Pobierz faktury od ostatniej synchronizacji
    // Pierwsza synchronizacja sięga do 1 stycznia 2024 (KSeF pilotaż)
    const lastSession = await prisma.ksefSession.findFirst()
    const dateFrom = forceDateFrom
      ?? (lastSession?.last_sync_at
        ? new Date(lastSession.last_sync_at)
        : new Date('2024-01-01'))
    const dateTo = new Date()

    console.log(`[KSeF] Synchronizacja od ${dateFrom.toISOString()} do ${dateTo.toISOString()}`)

    const invoices = await fetchInvoices(accessToken, dateFrom, dateTo, errors)
    fetched = invoices.length
    console.log(`[KSeF] Pobrano ${fetched} faktur łącznie`)

    for (const inv of invoices) {
      try {
        const mapped = mapInvoice(inv)
        if (!mapped.ksef_number) continue

        const exists = await prisma.ksefInvoice.findUnique({ where: { ksef_number: mapped.ksef_number } })
        if (exists) continue

        const created = await prisma.ksefInvoice.create({
          data: {
            id:               uuidv4(),
            ...mapped,
            acquisition_date: now().split('T')[0],
            raw_data:         JSON.stringify(inv),
            created_at:       now(),
          },
        })
        // Dla faktur sprzedażowych: spróbuj dopasować projekt
        if (mapped.invoice_direction === 'outgoing') {
          await tryAutoSuggestProject(created.id, mapped.buyer_name, mapped.buyer_nip).catch(() => {})
        }
        // Dla wszystkich faktur: spróbuj auto-klasyfikować na podstawie historii alokacji od tego dostawcy
        await tryAutoClassifyFromHistory(
          created.id,
          mapped.seller_nip || null,
          mapped.seller_name || null,
          mapped.gross_amount,
          mapped.invoice_direction,
        ).catch(() => {})

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
