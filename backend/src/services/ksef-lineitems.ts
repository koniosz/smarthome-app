// Pozycje faktury (FaWiersz) i termin płatności z XML KSeF — pobranie i zapis w bazie.
// Samo czytanie XML jest w czystym module ./ksef-xml-extract (liniowy parser z ksef-document,
// bez wyrażeń regularnych na treści od kontrahenta); tu zostaje tylko część z bazą i magazynem XML.

import { prisma } from '../db'
import { getInvoiceXml } from './ksef-xml-store'
import { extractInvoiceDetails, type InvoiceLineItem } from './ksef-xml-extract'

// dotychczasowe importy z './ksef-lineitems' działają bez zmian
export { parseLineItemsFromXml, parsePaymentDueDateFromXml } from './ksef-xml-extract'
export type { InvoiceLineItem } from './ksef-xml-extract'

// Wspólny klient Prisma z zakresem aktywnej firmy (tenant). XML faktury bierzemy z magazynu
// (ksef-xml-store): cache w bazie, a gdy go nie ma — pobranie z KSeF (token per firma, wspólny
// ogranicznik równoległości max 2 pobrań naraz) i zapis do cache.

// Pobierz XML faktury (z cache magazynu albo z KSeF — wtedy trafia do cache) i zapisz z niego
// wszystko, co znamy: pozycje (cache) + termin płatności (payment_due_date; '' = faktura nie ma
// terminu w XML). Zwraca zapisany termin (albo null przy błędzie pobierania).
export async function fetchAndStoreInvoiceDetails(invoiceId: string): Promise<string | null> {
  const invoice = await prisma.ksefInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, ksef_number: true, line_items: true, payment_due_date: true },
  })
  if (!invoice?.ksef_number) return null

  try {
    const { xml } = await getInvoiceXml(invoice)
    const { items, dueDate } = extractInvoiceDetails(xml) // XML parsowany raz
    const data: any = { }
    if (!Array.isArray(invoice.line_items)) data.line_items = items as any
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

// Zwróć pozycje faktury — z cache w DB, a przy pierwszym wywołaniu weź XML z magazynu
// (cache XML albo KSeF), sparsuj i zapisz (razem z terminem płatności — ten sam XML, zero
// dodatkowych zapytań do KSeF). Błędy zwracają pustą listę (UI degraduje się cicho).
export async function getInvoiceLineItems(invoiceId: string): Promise<InvoiceLineItem[]> {
  const invoice = await prisma.ksefInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, ksef_number: true, line_items: true, payment_due_date: true },
  })
  if (!invoice) return []
  if (Array.isArray(invoice.line_items)) return invoice.line_items as unknown as InvoiceLineItem[]
  if (!invoice.ksef_number) return []

  try {
    const { xml } = await getInvoiceXml(invoice)
    const { items, dueDate } = extractInvoiceDetails(xml) // XML parsowany raz
    const data: any = { line_items: items as any }
    if (invoice.payment_due_date == null) data.payment_due_date = dueDate
    await prisma.ksefInvoice.update({ where: { id: invoiceId }, data })
    return items
  } catch (err: any) {
    console.error(`[KSeF] Nie udało się pobrać pozycji faktury ${invoiceId}:`, err?.message ?? err)
    return []
  }
}
