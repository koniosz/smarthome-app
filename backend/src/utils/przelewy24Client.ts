import axios from 'axios'

export interface P24Transaction {
  orderId: number
  sessionId: string
  amount: number    // in grosze (divide by 100)
  currency: string
  description: string
  email: string
  date: string
  status: number   // 1 = completed
}

function getConfig() {
  const merchantId = process.env.P24_MERCHANT_ID || ''
  const apiKey     = process.env.P24_API_KEY || ''
  const crc        = process.env.P24_CRC || ''
  const sandbox    = process.env.P24_SANDBOX === 'true'
  const configured = !!(merchantId && apiKey && crc)

  const baseURL = sandbox
    ? 'https://sandbox.przelewy24.pl/api/v1'
    : 'https://secure.przelewy24.pl/api/v1'

  return { merchantId, apiKey, crc, sandbox, configured, baseURL }
}

function makeClient() {
  const { merchantId, apiKey, baseURL } = getConfig()
  const token = Buffer.from(`${merchantId}:${apiKey}`).toString('base64')

  return axios.create({
    baseURL,
    headers: {
      'Authorization': `Basic ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  })
}

/**
 * Test connection to Przelewy24 API
 */
export async function testConnection(): Promise<boolean> {
  const { configured } = getConfig()
  if (!configured) return false

  try {
    const client = makeClient()
    const { merchantId } = getConfig()
    // P24 test endpoint
    const res = await client.get(`/testAccess`)
    return res.status === 200
  } catch (err: any) {
    console.error('[P24] testConnection error:', err.response?.data ?? err.message)
    return false
  }
}

/**
 * Get transaction list from Przelewy24 for a given date range.
 * NOTE: The actual endpoint may vary depending on P24 API version.
 * If GET /transaction/list is not available on your plan, this will throw.
 */
export async function getTransactions(dateFrom: string, dateTo: string): Promise<P24Transaction[]> {
  const { configured } = getConfig()
  if (!configured) {
    throw new Error('Przelewy24 nie jest skonfigurowane. Ustaw P24_MERCHANT_ID, P24_API_KEY, P24_CRC.')
  }

  const client = makeClient()

  try {
    const res = await client.get('/transaction/list', {
      params: { dateFrom, dateTo },
    })
    const data = res.data?.data ?? res.data ?? []
    if (!Array.isArray(data)) return []

    return data.map((t: any) => ({
      orderId:     t.orderId     ?? t.order_id     ?? 0,
      sessionId:   t.sessionId   ?? t.session_id   ?? '',
      amount:      t.amount      ?? 0,
      currency:    t.currency    ?? 'PLN',
      description: t.description ?? '',
      email:       t.email       ?? '',
      date:        t.date        ?? t.dateTime ?? new Date().toISOString(),
      status:      t.status      ?? 0,
    }))
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message
    throw new Error(`Błąd pobierania transakcji P24: ${msg}`)
  }
}

/**
 * Verify a single Przelewy24 transaction
 */
export async function verifyTransaction(
  orderId: string,
  sessionId: string,
  amount: number,
): Promise<boolean> {
  const { configured, merchantId, crc } = getConfig()
  if (!configured) return false

  const client = makeClient()

  try {
    const res = await client.put('/transaction/verify', {
      merchantId: parseInt(merchantId, 10),
      posId:      parseInt(merchantId, 10),
      sessionId,
      amount,
      currency:   'PLN',
      orderId:    parseInt(orderId, 10),
      sign:       generateSign(sessionId, orderId, amount, crc),
    })
    return res.data?.data?.status === 'success'
  } catch (err: any) {
    console.error('[P24] verifyTransaction error:', err.response?.data ?? err.message)
    return false
  }
}

function generateSign(sessionId: string, orderId: string, amount: number, crc: string): string {
  // P24 signature: SHA384 of JSON string
  const crypto = require('crypto')
  const payload = JSON.stringify({ sessionId, orderId: parseInt(orderId, 10), amount, currency: 'PLN', crc })
  return crypto.createHash('sha384').update(payload).digest('hex')
}

export function getPrzelewy24Status() {
  const { configured, sandbox, merchantId } = getConfig()
  return { configured, sandbox, merchantId }
}

export function getPrzelewy24Client() {
  return { testConnection, getTransactions, verifyTransaction, getStatus: getPrzelewy24Status }
}
