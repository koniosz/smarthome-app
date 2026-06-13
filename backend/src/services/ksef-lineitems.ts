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

async function fetchInvoiceXml(ksefNumber: string): Promise<string> {
  const token = await getActiveSession()
  const res = await axios.get(
    `https://api.ksef.mf.gov.pl/v2/invoices/ksef/${encodeURIComponent(ksefNumber)}`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'text', timeout: 15000 },
  )
  return typeof res.data === 'string' ? res.data : String(res.data)
}

// Zwróć pozycje faktury — z cache w DB, a przy pierwszym wywołaniu pobierz XML,
// sparsuj i zapisz. Błędy zwracają pustą listę (UI degraduje się cicho).
export async function getInvoiceLineItems(invoiceId: string): Promise<InvoiceLineItem[]> {
  const invoice = await prisma.ksefInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, ksef_number: true, line_items: true },
  })
  if (!invoice) return []
  if (Array.isArray(invoice.line_items)) return invoice.line_items as unknown as InvoiceLineItem[]
  if (!invoice.ksef_number) return []

  try {
    const xml = await fetchInvoiceXml(invoice.ksef_number)
    const items = parseLineItemsFromXml(xml)
    await prisma.ksefInvoice.update({
      where: { id: invoiceId },
      data: { line_items: items as any },
    })
    return items
  } catch (err: any) {
    console.error(`[KSeF] Nie udało się pobrać pozycji faktury ${invoiceId}:`, err?.message ?? err)
    return []
  }
}
