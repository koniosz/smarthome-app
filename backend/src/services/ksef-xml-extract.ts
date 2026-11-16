/**
 * Pozycje faktury (FaWiersz) i termin płatności z XML faktury KSeF (FA(2)/FA(3)).
 *
 * Moduł CZYSTY: importuje wyłącznie ./ksef-document (bez bazy, sieci i plików) — testowalny wprost.
 * Treść XML pisze kontrahent, więc czytamy ją liniowym parserem z ksef-document (drzewo → model faktury),
 * a NIE wyrażeniami regularnymi: dawne wzorce „<FaWiersz …>[\s\S]*?</FaWiersz>” przy tagu otwierającym
 * bez zamknięcia skanowały plik do końca dla każdego wystąpienia (koszt kwadratowy, sekundy blokady
 * pętli zdarzeń na pliku ~1 MB).
 *
 * Wartości są po dekodowaniu encji i CDATA („A &amp; B” → „A & B”).
 * Pusty / uszkodzony / niefakturowy XML → brak pozycji i brak terminu (funkcje nigdy nie rzucają).
 */
import { parseKsefInvoice } from './ksef-document'

export interface InvoiceLineItem {
  nr: string
  name: string
  unit: string
  qty: string
  unitPrice: string
  netValue: string
  vatRate: string
}

export interface InvoiceDetails {
  /** wiersze FaWiersz z niepustą nazwą (P_7), w kolejności z faktury (także „stan przed korektą”) */
  items: InvoiceLineItem[]
  /** najpóźniejszy termin płatności YYYY-MM-DD; '' gdy faktura nie ma terminu w XML */
  dueDate: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Pozycje + termin płatności z JEDNEGO przebiegu parsera (XML czytany raz). */
export function extractInvoiceDetails(xml: string): InvoiceDetails {
  if (typeof xml !== 'string' || !xml) return { items: [], dueDate: '' }
  let doc: ReturnType<typeof parseKsefInvoice>
  try {
    doc = parseKsefInvoice(xml)
  } catch {
    // KsefDocumentError (to nie faktura / plik uszkodzony) albo nieprzewidziany błąd — jak „brak danych”
    return { items: [], dueDate: '' }
  }

  const items: InvoiceLineItem[] = []
  for (const l of doc.lines) {
    if (!l.name) continue
    items.push({
      nr:        l.nr,                       // NrWierszaFa
      name:      l.name,                     // P_7
      unit:      l.unit,                     // P_8A
      qty:       l.qty,                      // P_8B
      unitPrice: l.unitNet || l.unitGross,   // P_9A, a gdy brak — P_9B (cena brutto)
      netValue:  l.net || l.gross,           // P_11, a gdy brak — P_11A (wartość brutto)
      vatRate:   l.rate,                     // P_12 — surowa wartość („23”, „zw”, „np I” …)
    })
  }

  // Platnosc > TerminPlatnosci > Termin; faktura może mieć kilka terminów (raty) — bierzemy najpóźniejszy
  let dueDate = ''
  for (const t of doc.payment?.terms ?? []) {
    if (ISO_DATE_RE.test(t.date) && t.date > dueDate) dueDate = t.date
  }

  return { items, dueDate }
}

export function parseLineItemsFromXml(xml: string): InvoiceLineItem[] {
  return extractInvoiceDetails(xml).items
}

/** Zwraca '' gdy faktura nie ma terminu w XML (odróżniamy od null = jeszcze nie pobrano). */
export function parsePaymentDueDateFromXml(xml: string): string {
  return extractInvoiceDetails(xml).dueDate
}
