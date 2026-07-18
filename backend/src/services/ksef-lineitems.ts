// Parsowanie i cache'owanie pozycji faktury (FaWiersz) z KSeF XML.
// Brak biblioteki XML na backendzie — lekki parser oparty na regexie wystarcza
// dla dobrze zdefiniowanej struktury FA(2)/FA(3).

import axios from 'axios'
import { PrismaClient } from '@prisma/client'
import { getActiveSession } from './ksef'

const prisma = new PrismaClient()

export interface InvoiceLineItem {
  nr: string
  name: string
  unit: string
  qty: string
  unitPrice: string
  netValue: string
  vatRate: string
}

// wyciągnij tekst pierwszego z podanych tagów w obrębie fragmentu (ignoruje prefiks ns)
function tag(fragment: string, names: string[]): string {
  for (const name of names) {
    const m = fragment.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'))
    if (m && m[1] != null) return m[1].trim()
  }
  return ''
}

export function parseLineItemsFromXml(xml: string): InvoiceLineItem[] {
  if (!xml) return []
  const blocks = xml.match(/<(?:[\w-]+:)?FaWiersz\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?FaWiersz>/gi) ?? []
  return blocks
    .map(block => ({
      nr:        tag(block, ['NrWierszaFa', 'NrWiersza']),
      name:      tag(block, ['P_7']),
      unit:      tag(block, ['P_8A']),
      qty:       tag(block, ['P_8B']),
      unitPrice: tag(block, ['P_9A', 'P_9B']),
      netValue:  tag(block, ['P_11', 'P_11A']),
      vatRate:   tag(block, ['P_12']),
    }))
    .filter(i => i.name)
}

// Termin płatności z FA(2)/FA(3): Platnosc > TerminPlatnosci > Termin (YYYY-MM-DD).
// Faktura może mieć kilka terminów (raty) — bierzemy najpóźniejszy.
// Zwraca '' gdy faktura nie ma terminu w XML (odróżniamy od null = jeszcze nie pobrano).
export function parsePaymentDueDateFromXml(xml: string): string {
  if (!xml) return ''
  const blocks = xml.match(/<(?:[\w-]+:)?TerminPlatnosci\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?TerminPlatnosci>/gi) ?? []
  const dates = blocks
    .map(b => tag(b, ['Termin']))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
  return dates.length ? dates[dates.length - 1] : ''
}

// Ogranicznik równoległości — max 2 pobrania XML z KSeF naraz, reszta czeka
// w kolejce. Chroni przed rate-limitem, gdy lista odpyta wiele faktur naraz.
let active = 0
const queue: (() => void)[] = []
async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>(resolve => queue.push(resolve))
  active++
  try {
    return await fn()
  } finally {
    active--
    queue.shift()?.()
  }
}

async function fetchInvoiceXml(ksefNumber: string): Promise<string> {
  return withLimit(async () => {
    const token = await getActiveSession()
    const res = await axios.get(
      `https://api.ksef.mf.gov.pl/v2/invoices/ksef/${encodeURIComponent(ksefNumber)}`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'text', timeout: 15000 },
    )
    return typeof res.data === 'string' ? res.data : String(res.data)
  })
}

// Pobierz XML faktury raz i zapisz z niego wszystko, co znamy: pozycje (cache)
// + termin płatności (payment_due_date; '' = faktura nie ma terminu w XML).
// Zwraca zapisany termin (albo null przy błędzie pobierania).
export async function fetchAndStoreInvoiceDetails(invoiceId: string): Promise<string | null> {
  const invoice = await prisma.ksefInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, ksef_number: true, line_items: true, payment_due_date: true },
  })
  if (!invoice?.ksef_number) return null

  try {
    const xml = await fetchInvoiceXml(invoice.ksef_number)
    const dueDate = parsePaymentDueDateFromXml(xml)
    const data: any = { }
    if (!Array.isArray(invoice.line_items)) data.line_items = parseLineItemsFromXml(xml) as any
    // nie nadpisuj terminu ustawionego ręcznie — uzupełniamy tylko brakujący (null)
    if (invoice.payment_due_date == null) data.payment_due_date = dueDate
    if (Object.keys(data).length) {
      await prisma.ksefInvoice.update({ where: { id: invoiceId }, data })
    }
    return invoice.payment_due_date ?? dueDate
  } catch (err: any) {
    console.error(`[KSeF] Nie udało się pobrać szczegółów faktury ${invoiceId}:`, err?.message ?? err)
    return null
  }
}

// Zwróć pozycje faktury — z cache w DB, a przy pierwszym wywołaniu pobierz XML,
// sparsuj i zapisz (razem z terminem płatności — ten sam XML, zero dodatkowych
// zapytań do KSeF). Błędy zwracają pustą listę (UI degraduje się cicho).
export async function getInvoiceLineItems(invoiceId: string): Promise<InvoiceLineItem[]> {
  const invoice = await prisma.ksefInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, ksef_number: true, line_items: true, payment_due_date: true },
  })
  if (!invoice) return []
  if (Array.isArray(invoice.line_items)) return invoice.line_items as unknown as InvoiceLineItem[]
  if (!invoice.ksef_number) return []

  try {
    const xml = await fetchInvoiceXml(invoice.ksef_number)
    const items = parseLineItemsFromXml(xml)
    const data: any = { line_items: items as any }
    if (invoice.payment_due_date == null) data.payment_due_date = parsePaymentDueDateFromXml(xml)
    await prisma.ksefInvoice.update({ where: { id: invoiceId }, data })
    return items
  } catch (err: any) {
    console.error(`[KSeF] Nie udało się pobrać pozycji faktury ${invoiceId}:`, err?.message ?? err)
    return []
  }
}
