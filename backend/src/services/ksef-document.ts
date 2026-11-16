/**
 * Wizualizacja faktury ustrukturyzowanej z KSeF (schemat FA(2) / FA(3)).
 *
 * KSeF oddaje wyłącznie XML — ten moduł zamienia go na pełny, samodzielny dokument HTML
 * (podgląd w iframe + „Drukuj / zapisz PDF”): XML → drzewo → model faktury → HTML.
 *
 * Moduł jest CZYSTY: zero importów (bez bazy, sieci, plików, bibliotek XML).
 * Treść faktury pisze kontrahent, więc traktujemy ją jak dane wrogie:
 *  - każda wartość przechodzi przez esc(), nie budujemy żadnych linków ani atrybutów z danych,
 *  - dokument nie ma skryptów ani zasobów zewnętrznych (CSP default-src 'none'),
 *  - parser i formatery działają liniowo (bez rekurencji i bez „ciężkich” regexów).
 *
 * Każde pole XML, którego układ poniżej nie zna, trafia do sekcji „Pozostałe dane z pliku XML”
 * — nic z faktury nie znika po cichu (schemat pisany z pamięci, FA(3) dokłada pola).
 */

export class KsefDocumentError extends Error {
  constructor(message = 'Nieprawidłowy dokument XML faktury KSeF.') {
    super(message)
    this.name = 'KsefDocumentError'
  }
}

export interface KsefDocMeta {
  ksefNumber?: string | null
  direction?: 'incoming' | 'outgoing' | string | null
}

// ═════════════════════════════════════════════════════════════════════════════
// A) Parser XML — tolerancyjny, iteracyjny (bez rekurencji), zwraca null dla
//    dokumentu uszkodzonego / uciętego / bez elementu głównego.
// ═════════════════════════════════════════════════════════════════════════════

export interface XmlNode {
  /** nazwa LOKALNA (bez prefiksu przestrzeni nazw, np. „tns:”) */
  name: string
  /** atrybuty po nazwie lokalnej; deklaracje xmlns / xmlns:* zostają pod pełną nazwą */
  attrs: Record<string, string>
  children: XmlNode[]
  /** własny tekst elementu (z CDATA, po dekodowaniu encji), przycięty */
  text: string
}

/** Limit KSeF to 1 MB (3 MB z załącznikami) — 8 MB zostawia zapas, a nie pozwala zająć pamięci drzewem z ogromnego pliku. */
const MAX_XML_LENGTH = 8 * 1024 * 1024
const MAX_XML_DEPTH = 128
/** Nazwy elementów FA mają poniżej 40 znaków; dłuższa nazwa to nie jest faktura (i mnożyłaby się w ścieżkach „Pozostałych danych”). */
const MAX_XML_NAME_LENGTH = 128
const XML_NAME_RE = /^[A-Za-z_À-￿][A-Za-z0-9_.\-:·À-￿]*$/

function isWs(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

function localName(qname: string): string {
  const i = qname.lastIndexOf(':')
  return i === -1 ? qname : qname.slice(i + 1)
}

const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
])

/** Jednoprzebiegowe dekodowanie encji (bez podwójnego dekodowania „&amp;lt;”). Nieznane encje zostają bez zmian. */
function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_m, body: string) => {
    if (body.charCodeAt(0) !== 35 /* # */) return NAMED_ENTITIES.get(body) ?? ''
    const code = body.charCodeAt(1) === 120 /* x */ ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
    return String.fromCodePoint(code)
  })
}

export function parseXml(input: string): XmlNode | null {
  if (typeof input !== 'string' || input.length > MAX_XML_LENGTH) return null
  const xml = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const len = xml.length
  const stack: XmlNode[] = []
  const qnames: string[] = []
  const texts: string[][] = []
  let root: XmlNode | null = null
  let i = 0

  while (i < len) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    if (lt > i && stack.length) texts[texts.length - 1].push(decodeEntities(xml.slice(i, lt)))
    const c1 = xml.charCodeAt(lt + 1)

    if (c1 === 33 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4)
        if (end === -1) return null
        i = end + 3
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9)
        if (end === -1 || !stack.length) return null
        texts[texts.length - 1].push(xml.slice(lt + 9, end))
        i = end + 3
      } else {
        // DOCTYPE itp. — pomijamy w całości (encji użytkownika NIE rozwijamy)
        if (stack.length) return null
        const gt = xml.indexOf('>', lt + 2)
        if (gt === -1) return null
        const br = xml.indexOf('[', lt + 2)
        if (br !== -1 && br < gt) {
          const close = xml.indexOf(']', br + 1)
          const gt2 = close === -1 ? -1 : xml.indexOf('>', close + 1)
          if (gt2 === -1) return null
          i = gt2 + 1
        } else {
          i = gt + 1
        }
      }
      continue
    }

    if (c1 === 63 /* ? */) {
      const end = xml.indexOf('?>', lt + 2)
      if (end === -1) return null
      i = end + 2
      continue
    }

    if (c1 === 47 /* / */) {
      const gt = xml.indexOf('>', lt + 2)
      if (gt === -1) return null
      const node = stack.pop()
      const qname = qnames.pop()
      const parts = texts.pop()
      if (!node || !parts || xml.slice(lt + 2, gt).trim() !== qname) return null
      node.text = parts.join('').trim()
      i = gt + 1
      if (!stack.length) return root // koniec elementu głównego — reszty pliku nie czytamy
      continue
    }

    // ── tag otwierający ──
    let j = lt + 1
    while (j < len) {
      const c = xml.charCodeAt(j)
      if (isWs(c) || c === 47 || c === 62) break
      j++
    }
    if (j - (lt + 1) > MAX_XML_NAME_LENGTH) return null
    const qname = xml.slice(lt + 1, j)
    if (!XML_NAME_RE.test(qname)) return null
    const name = localName(qname)
    if (!name) return null

    const attrs: Record<string, string> = {}
    let selfClosing = false
    for (;;) {
      while (j < len && isWs(xml.charCodeAt(j))) j++
      if (j >= len) return null
      const c = xml.charCodeAt(j)
      if (c === 62 /* > */) { j++; break }
      if (c === 47 /* / */) {
        if (xml.charCodeAt(j + 1) !== 62) return null
        j += 2
        selfClosing = true
        break
      }
      const start = j
      while (j < len) {
        const a = xml.charCodeAt(j)
        if (isWs(a) || a === 61 || a === 62 || a === 47) break
        j++
      }
      const aq = xml.slice(start, j)
      if (!XML_NAME_RE.test(aq)) return null
      while (j < len && isWs(xml.charCodeAt(j))) j++
      if (xml.charCodeAt(j) !== 61 /* = */) return null
      j++
      while (j < len && isWs(xml.charCodeAt(j))) j++
      const q = xml.charCodeAt(j)
      if (q !== 34 && q !== 39) return null
      const end = xml.indexOf(q === 34 ? '"' : "'", j + 1)
      if (end === -1) return null
      const key = aq === 'xmlns' || aq.startsWith('xmlns:') ? aq : localName(aq)
      if (key && key !== '__proto__') attrs[key] = decodeEntities(xml.slice(j + 1, end))
      j = end + 1
    }

    if (stack.length >= MAX_XML_DEPTH) return null
    const node: XmlNode = { name, attrs, children: [], text: '' }
    if (stack.length) stack[stack.length - 1].children.push(node)
    else root = node
    if (selfClosing) {
      if (!stack.length) return root // pusty element główny
    } else {
      stack.push(node)
      qnames.push(qname)
      texts.push([])
    }
    i = j
  }

  // brak elementu głównego albo niedomknięte elementy (plik ucięty)
  return null
}

// ═════════════════════════════════════════════════════════════════════════════
// B) Model faktury
// ═════════════════════════════════════════════════════════════════════════════

export interface KsefAddress { countryCode: string; lines: string[]; gln: string }
export interface KsefContact { email: string; phone: string }
export interface KsefIdentifier { label: string; value: string }

export interface KsefParty {
  name: string
  ids: KsefIdentifier[]
  address: KsefAddress | null
  corrAddress: KsefAddress | null
  contacts: KsefContact[]
  eori: string
  customerNo: string
  buyerId: string
  /** etykieta roli (Podmiot3 / PodmiotUpowazniony) */
  role: string
  /** udział procentowy (Podmiot3) */
  share: string
  notes: string[]
}

export interface KsefLine {
  nr: string
  name: string
  index: string
  gtin: string
  pkwiu: string
  cn: string
  pkob: string
  unit: string
  qty: string
  unitNet: string
  unitGross: string
  discount: string
  net: string
  gross: string
  vat: string
  rate: string
  rateOss: string
  excise: string
  gtu: string
  procedure: string
  fxRate: string
  deliveryDate: string
  annex15: boolean
  /** StanPrzed = 1 — wiersz „stan przed korektą” */
  before: boolean
}

export interface KsefVatRow {
  key: string
  label: string
  net: string
  vat: string
  vatPln: string
  /** netto + VAT (surowy zapis dziesiętny), '' gdy nie da się policzyć */
  gross: string
}

export interface KsefCorrectedInvoice { date: string; number: string; ksefNumber: string; outsideKsef: boolean }
export interface KsefCorrection {
  reason: string
  typeLabel: string
  corrected: KsefCorrectedInvoice[]
  period: string
  correctNumber: string
  sellerBefore: KsefParty | null
  buyersBefore: KsefParty[]
  amountBefore: string
  fxRateBefore: string
}

export interface KsefAmountReason { amount: string; reason: string }
export interface KsefSettlement {
  charges: KsefAmountReason[]
  chargesTotal: string
  deductions: KsefAmountReason[]
  deductionsTotal: string
  toPay: string
  toSettle: string
}

export interface KsefBankAccount { number: string; swift: string; bank: string; description: string; ownBank: string }
export interface KsefPaymentTerm { date: string; description: string }
export interface KsefPartialPayment { amount: string; date: string; method: string }
export interface KsefPayment {
  paid: boolean
  paidDate: string
  partialFlag: string
  partials: KsefPartialPayment[]
  terms: KsefPaymentTerm[]
  method: string
  accounts: KsefBankAccount[]
  factorAccounts: KsefBankAccount[]
  discountTerms: string
  discountAmount: string
  link: string
  ksefPaymentId: string
}

export interface KsefLabelValue { label: string; value: string }
export interface KsefDatedNumber { date: string; number: string }
export interface KsefTerms {
  contracts: KsefDatedNumber[]
  orders: KsefDatedNumber[]
  batches: string[]
  delivery: string
  contractRate: string
  contractCurrency: string
  intermediary: boolean
  transports: KsefLabelValue[][]
}

export interface KsefAdvancePayment { date: string; amount: string; fxRate: string }
export interface KsefAdditionalInfo { row: string; key: string; value: string }
export interface KsefRegistry { fullName: string; krs: string; regon: string; bdo: string }
export interface KsefAttachmentTable { description: string; meta: KsefLabelValue[]; header: string[]; rows: string[][]; sum: string[] }
export interface KsefAttachmentBlock { title: string; meta: KsefLabelValue[]; paragraphs: string[]; tables: KsefAttachmentTable[] }
export interface KsefExtraField { path: string; value: string }

export interface KsefInvoiceDoc {
  /** np. „FA (3)” */
  schema: string
  schemaVersion: string
  generatedAt: string
  systemInfo: string
  /** RodzajFaktury: VAT | KOR | ZAL | ROZ | UPR | KOR_ZAL | KOR_ROZ */
  type: string
  typeLabel: string
  number: string
  issueDate: string
  issuePlace: string
  saleDate: string
  periodFrom: string
  periodTo: string
  currency: string
  wz: string[]
  seller: KsefParty | null
  buyer: KsefParty | null
  otherParties: KsefParty[]
  authorized: KsefParty | null
  lines: KsefLine[]
  orderLines: KsefLine[]
  orderValue: string
  vatRows: KsefVatRow[]
  /** P_15 — kwota należności ogółem */
  total: string
  fxRateAdvance: string
  annotations: string[]
  correction: KsefCorrection | null
  advancePayments: KsefAdvancePayment[]
  advanceInvoices: string[]
  additional: KsefAdditionalInfo[]
  settlement: KsefSettlement | null
  payment: KsefPayment | null
  terms: KsefTerms | null
  footerTexts: string[]
  registries: KsefRegistry[]
  attachment: KsefAttachmentBlock[]
  /** pola XML nieujęte w modelu — pokazywane w „Pozostałe dane z pliku XML” */
  extra: KsefExtraField[]
  /** true, gdy takich pól było więcej niż limit i `extra` zawiera tylko pierwsze z nich */
  extraTruncated?: boolean
}

// ── słowniki (Map, nie obiekt — klucz pochodzi z faktury, np. „constructor”) ──

const TYPE_LABELS = new Map<string, string>([
  ['VAT', 'Faktura VAT'],
  ['KOR', 'Faktura korygująca'],
  ['ZAL', 'Faktura zaliczkowa'],
  ['ROZ', 'Faktura rozliczeniowa'],
  ['UPR', 'Faktura uproszczona'],
  ['KOR_ZAL', 'Faktura korygująca fakturę zaliczkową'],
  ['KOR_ROZ', 'Faktura korygująca fakturę rozliczeniową'],
])

const ROLE_LABELS = new Map<string, string>([
  ['1', 'Faktor'], ['2', 'Odbiorca'], ['3', 'Podmiot pierwotny'], ['4', 'Dodatkowy nabywca'],
  ['5', 'Wystawca faktury'], ['6', 'Dokonujący płatności'], ['7', 'JST – wystawca'], ['8', 'JST – odbiorca'],
  ['9', 'Członek grupy VAT – wystawca'], ['10', 'Członek grupy VAT – odbiorca'], ['11', 'Pracownik'],
])

const AUTHORIZED_ROLE_LABELS = new Map<string, string>([
  ['1', 'Organ egzekucyjny'], ['2', 'Komornik sądowy'], ['3', 'Przedstawiciel podatkowy'],
])

const TAXPAYER_STATUS_LABELS = new Map<string, string>([
  ['1', 'Podatnik w stanie likwidacji'],
  ['2', 'Podatnik w trakcie postępowania restrukturyzacyjnego'],
  ['3', 'Podatnik w stanie upadłości'],
  ['4', 'Przedsiębiorstwo w spadku'],
])

const PAYMENT_METHOD_LABELS = new Map<string, string>([
  ['1', 'Gotówka'], ['2', 'Karta'], ['3', 'Bon'], ['4', 'Czek'], ['5', 'Kredyt'], ['6', 'Przelew'], ['7', 'Płatność mobilna'],
])

const OWN_BANK_ACCOUNT_LABELS = new Map<string, string>([
  ['1', 'rachunek banku lub SKOK do rozliczeń nabytych wierzytelności'],
  ['2', 'rachunek banku lub SKOK do pobrania należności i przekazania jej dostawcy'],
  ['3', 'rachunek banku lub SKOK w ramach gospodarki własnej'],
])

const CORRECTION_TYPE_LABELS = new Map<string, string>([
  ['1', 'Korekta skutkująca w dacie ujęcia faktury pierwotnej'],
  ['2', 'Korekta skutkująca w dacie wystawienia faktury korygującej'],
  ['3', 'Korekta skutkująca w innej dacie (w tym różnej dla poszczególnych pozycji)'],
])

const TRANSPORT_TYPE_LABELS = new Map<string, string>([
  ['1', 'Transport morski'], ['2', 'Transport kolejowy'], ['3', 'Transport drogowy'], ['4', 'Transport lotniczy'],
  ['5', 'Przesyłka pocztowa'], ['7', 'Stałe instalacje przesyłowe'], ['8', 'Żegluga śródlądowa'],
])

const CARGO_LABELS = new Map<string, string>([
  ['1', 'Bańka'], ['2', 'Beczka'], ['3', 'Butla'], ['4', 'Karton'], ['5', 'Kanister'], ['6', 'Klatka'], ['7', 'Kontener'],
  ['8', 'Kosz/koszyk'], ['9', 'Łubianka'], ['10', 'Opakowanie zbiorcze'], ['11', 'Paczka'], ['12', 'Pakiet'], ['13', 'Paleta'],
  ['14', 'Pojemnik'], ['15', 'Pojemnik do ładunków masowych stałych'], ['16', 'Pojemnik do ładunków masowych w postaci płynnej'],
  ['17', 'Pudełko'], ['18', 'Puszka'], ['19', 'Skrzynia'], ['20', 'Worek'],
])

const COUNTRY_NAMES = new Map<string, string>([
  ['AT', 'Austria'], ['BE', 'Belgia'], ['BG', 'Bułgaria'], ['CH', 'Szwajcaria'], ['CN', 'Chiny'], ['CY', 'Cypr'],
  ['CZ', 'Czechy'], ['DE', 'Niemcy'], ['DK', 'Dania'], ['EE', 'Estonia'], ['ES', 'Hiszpania'], ['FI', 'Finlandia'],
  ['FR', 'Francja'], ['GB', 'Wielka Brytania'], ['GR', 'Grecja'], ['HR', 'Chorwacja'], ['HU', 'Węgry'], ['IE', 'Irlandia'],
  ['IT', 'Włochy'], ['LT', 'Litwa'], ['LU', 'Luksemburg'], ['LV', 'Łotwa'], ['MT', 'Malta'], ['NL', 'Holandia'],
  ['NO', 'Norwegia'], ['PT', 'Portugalia'], ['RO', 'Rumunia'], ['SE', 'Szwecja'], ['SI', 'Słowenia'], ['SK', 'Słowacja'],
  ['UA', 'Ukraina'], ['US', 'Stany Zjednoczone'], ['XI', 'Irlandia Północna'],
])

/** Grupy podsumowania VAT (pola P_13_x / P_14_x / P_14_xW w elemencie Fa). */
const VAT_GROUPS: { key: string; label: string; net: string; vat?: string; vatPln?: string; rates?: [string, string] }[] = [
  { key: '1', label: '23% lub 22%', net: 'P_13_1', vat: 'P_14_1', vatPln: 'P_14_1W', rates: ['23', '22'] },
  { key: '2', label: '8% lub 7%', net: 'P_13_2', vat: 'P_14_2', vatPln: 'P_14_2W', rates: ['8', '7'] },
  { key: '3', label: '5%', net: 'P_13_3', vat: 'P_14_3', vatPln: 'P_14_3W' },
  { key: '4', label: 'ryczałt dla taksówek', net: 'P_13_4', vat: 'P_14_4', vatPln: 'P_14_4W', rates: ['4', '3'] },
  // P_13_5 / P_14_5 = dział XII rozdz. 6a ustawy (procedura unijna OSS); IOSS (rozdz. 9) tu nie trafia
  { key: '5', label: 'procedura szczególna (OSS)', net: 'P_13_5', vat: 'P_14_5' },
  { key: '6_1', label: '0% (kraj)', net: 'P_13_6_1' },
  { key: '6_2', label: '0% (WDT)', net: 'P_13_6_2' },
  { key: '6_3', label: '0% (eksport)', net: 'P_13_6_3' },
  { key: '6', label: '0%', net: 'P_13_6' },
  { key: '7', label: 'zwolnione (zw)', net: 'P_13_7' },
  { key: '8', label: 'np. — poza terytorium kraju', net: 'P_13_8' },
  { key: '9', label: 'np. — art. 100 ust. 1 pkt 4', net: 'P_13_9' },
  { key: '10', label: 'odwrotne obciążenie (oo)', net: 'P_13_10' },
  { key: '11', label: 'procedura marży', net: 'P_13_11' },
]

// ── arytmetyka dziesiętna na NAPISACH (BigInt) — bez artefaktów float ──

interface Dec { neg: boolean; int: string; frac: string }
const MAX_DEC_LENGTH = 40

function parseDec(raw: string): Dec | null {
  const s = (raw ?? '').trim()
  if (!s || s.length > MAX_DEC_LENGTH) return null
  const m = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(s)
  if (!m) return null
  const intRaw = m[2] ?? ''
  const frac = m[3] ?? ''
  if (!intRaw && !frac) return null
  const int = intRaw.replace(/^0+/, '') || '0'
  const zero = int === '0' && !/[1-9]/.test(frac)
  return { neg: m[1] === '-' && !zero, int, frac }
}

/** Zaokrąglenie „połówki od zera” do zadanej liczby miejsc. */
function roundDec(d: Dec, places: number): Dec {
  if (d.frac.length <= places) return d
  const up = d.frac.charCodeAt(places) >= 53 /* '5' */
  let scaled = BigInt(d.int + d.frac.slice(0, places))
  if (up) scaled += BigInt(1)
  const digits = scaled.toString().padStart(places + 1, '0')
  const int = digits.slice(0, digits.length - places)
  const frac = places ? digits.slice(digits.length - places) : ''
  const zero = !/[1-9]/.test(digits)
  return { neg: d.neg && !zero, int, frac }
}

function groupThousands(int: string): string {
  if (int.length <= 3) return int
  const head = int.length % 3
  const out: string[] = []
  if (head) out.push(int.slice(0, head))
  for (let i = head; i < int.length; i += 3) out.push(int.slice(i, i + 3))
  return out.join(' ')
}

/**
 * Zapis polski: spacja co 3 cyfry, przecinek dziesiętny.
 * min — minimalna liczba miejsc; max — zaokrąglenie (-1 = bez); trim — obcięcie końcowych zer (do min).
 * Wartość, której nie da się odczytać jako liczby, wraca bez zmian (i tak przejdzie przez esc()).
 */
function fmtDec(raw: string, min: number, max: number, trim: boolean): string {
  const parsed = parseDec(raw)
  if (!parsed) return (raw ?? '').trim()
  const d = max >= 0 ? roundDec(parsed, max) : parsed
  let frac = d.frac
  if (trim) {
    let end = frac.length
    while (end > min && frac.charCodeAt(end - 1) === 48) end--
    frac = frac.slice(0, end)
  }
  if (frac.length < min) frac = frac.padEnd(min, '0')
  const zero = d.int === '0' && !/[1-9]/.test(frac)
  return (d.neg && !zero ? '-' : '') + groupThousands(d.int) + (frac ? ',' + frac : '')
}

/** Kwota: zawsze 2 miejsca. */
function fmtAmount(raw: string): string { return fmtDec(raw, 2, 2, false) }
/** Cena jednostkowa: min. 2 miejsca, większa precyzja zostaje. */
function fmtPrice(raw: string): string { return fmtDec(raw, 2, -1, true) }
/** Ilość / procent: bez końcowych zer. */
function fmtQty(raw: string): string { return fmtDec(raw, 0, -1, true) }
/** Kurs waluty: zapis jak w fakturze (min. 2 miejsca). */
function fmtRate(raw: string): string { return fmtDec(raw, 2, -1, false) }

function isNonZero(raw: string): boolean {
  const s = (raw ?? '').trim()
  if (!s) return false
  const d = parseDec(s)
  return !d || d.int !== '0' || /[1-9]/.test(d.frac)
}

/** Suma zapisów dziesiętnych → surowy zapis z kropką ('' gdy żaden składnik nie jest liczbą). */
function decSum(values: string[]): string {
  const parsed: Dec[] = []
  for (const v of values) {
    const d = parseDec(v)
    if (d) parsed.push(d)
  }
  if (!parsed.length) return ''
  let scale = 0
  for (const d of parsed) if (d.frac.length > scale) scale = d.frac.length
  let sum = BigInt(0)
  for (const d of parsed) {
    const v = BigInt(d.int + d.frac.padEnd(scale, '0'))
    sum = d.neg ? sum - v : sum + v
  }
  const neg = sum < BigInt(0)
  const digits = (neg ? -sum : sum).toString().padStart(scale + 1, '0')
  const int = digits.slice(0, digits.length - scale)
  const frac = scale ? digits.slice(digits.length - scale) : ''
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '')
}

// ── daty / rachunki ──

function fmtDate(raw: string): string {
  const s = (raw ?? '').trim()
  if (s.length > 40) return s
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(s)
  if (m) return `${m[3]}.${m[2]}.${m[1]}`
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s)
  if (m) return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}${m[6] ? (m[6] === 'Z' ? ' UTC' : ' ' + m[6]) : ''}`
  return s
}

/**
 * Znaki sterujące kierunkiem tekstu (bidi): ALM, LRM, RLM, osadzenia / nadpisania (LRE, RLE, PDF, LRO, RLO)
 * i izolaty (LRI, RLI, FSI, PDI). Niewidoczne, a potrafią odwrócić kolejność cyfr na ekranie i w PDF
 * (np. numeru rachunku) — w dokumencie nie mają czego szukać.
 */
const BIDI_CONTROLS_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

function stripBidi(s: string): string {
  return s.replace(BIDI_CONTROLS_RE, '')
}

/** NRB (26 cyfr) → 2 + 6×4; IBAN → grupy po 4; inne zapisy bez zmian (znaki bidi są usuwane przed rozpoznaniem). */
function fmtAccount(raw: string): string {
  const s = stripBidi(raw ?? '').trim()
  if (s.length > 64) return s
  const compact = s.replace(/[\s-]/g, '').toUpperCase()
  if (/^\d{26}$/.test(compact)) return compact.slice(0, 2) + ' ' + chunk(compact.slice(2), 4)
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return chunk(compact, 4)
  return s
}

function chunk(s: string, size: number): string {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out.join(' ')
}

/** Stawka wiersza: P_12 i/lub P_12_XII (OSS). Gdy faktura podaje obie — pokazujemy obie, np. „23% · 21% (OSS)”. */
function rateLabel(rate: string, rateOss: string): string {
  const base = baseRateLabel(rate)
  const oss = rateOss ? `${fmtQty(rateOss)}% (OSS)` : ''
  return base && oss ? `${base} · ${oss}` : base || oss
}

function baseRateLabel(rate: string): string {
  const s = (rate ?? '').trim()
  if (!s) return ''
  if (s.length <= 12 && /^\d+(?:[.,]\d+)?$/.test(s)) return fmtQty(s) + '%'
  switch (s.toLowerCase()) {
    case '0 kr': return '0% (kraj)'
    case '0 wdt': return '0% (WDT)'
    case '0 ex': return '0% (eksport)'
    case 'np i': return 'np. I'
    case 'np ii': return 'np. II'
    case 'np': return 'np.'
    default: return s
  }
}

function countryName(code: string): string {
  const c = (code ?? '').trim().toUpperCase()
  if (!c || c === 'PL') return ''
  const name = COUNTRY_NAMES.get(c)
  return name ? `${name} (${c})` : c
}

// ── czytnik drzewa: każdy odczyt jest względny wobec RODZICA (Nazwa, NIP, Adres, Termin…
//    powtarzają się w różnych sekcjach) i oznacza węzeł jako „przeczytany” ──

class Reader {
  readonly seen = new Set<XmlNode>()

  kids(parent: XmlNode | null | undefined, name: string): XmlNode[] {
    if (!parent) return []
    const out: XmlNode[] = []
    for (const c of parent.children) {
      if (c.name === name) {
        this.seen.add(c)
        out.push(c)
      }
    }
    return out
  }

  kid(parent: XmlNode | null | undefined, name: string): XmlNode | undefined {
    if (!parent) return undefined
    for (const c of parent.children) {
      if (c.name === name) {
        this.seen.add(c)
        return c
      }
    }
    return undefined
  }

  /** tekst pierwszego dziecka o danej nazwie ('' gdy brak) */
  val(parent: XmlNode | null | undefined, name: string): string {
    const c = this.kid(parent, name)
    return c ? c.text : ''
  }

  vals(parent: XmlNode | null | undefined, name: string): string[] {
    return this.kids(parent, name).map(c => c.text).filter(Boolean)
  }

  /** znacznik „1 = tak” (wartość „2” oznacza „nie dotyczy”) */
  is1(parent: XmlNode | null | undefined, name: string): boolean {
    return this.val(parent, name) === '1'
  }
}

const MAX_EXTRA_FIELDS = 200
/** Górny limit liczby wierszy FaWiersz / ZamowienieWiersz w schemacie FA(2)/FA(3). */
const MAX_INVOICE_LINES = 10_000
/** Ścieżka powtarza się w każdym wierszu „Pozostałych danych” — bez limitu głębokie / długie nazwy mnożyłyby rozmiar HTML. */
const MAX_EXTRA_PATH_LENGTH = 300

/** Za długa ścieżka: zostaje KONIEC (nazwa pola i najbliżsi rodzice), początek zastępuje „…”. */
function clipPath(path: string): string {
  if (path.length <= MAX_EXTRA_PATH_LENGTH) return path
  let tail = path.slice(-(MAX_EXTRA_PATH_LENGTH - 1))
  const first = tail.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1) // nie zaczynamy od połówki pary zastępczej
  return '…' + tail
}

/**
 * Liście XML, których model nie przeczytał — ścieżka techniczna + wartość.
 * Najwyżej MAX_EXTRA_FIELDS pól; `truncated` mówi, że było ich więcej (dokument musi to napisać wprost).
 */
function collectExtras(root: XmlNode, seen: Set<XmlNode>): { fields: KsefExtraField[]; truncated: boolean } {
  const out: KsefExtraField[] = []
  // na stosie leży ścieżka RODZICA (jeden napis wspólny dla całego rodzeństwa); własną ścieżkę węzeł składa
  // dopiero, gdy jest potrzebna — przycięty napis na każde z miliona dzieci kosztowałby setki MB
  const stack: { node: XmlNode; parentPath: string }[] = []
  for (let i = root.children.length - 1; i >= 0; i--) stack.push({ node: root.children[i], parentPath: '' })
  while (stack.length) {
    const { node, parentPath } = stack.pop()!
    const hasChildren = node.children.length > 0
    const unread = !!node.text && !seen.has(node)
    if (!hasChildren && !unread) continue
    const path = clipPath(parentPath ? `${parentPath} › ${node.name}` : node.name)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], parentPath: path })
    if (unread) out.push({ path, value: node.text })
    // zbieramy o jedno pole więcej niż pokazujemy — tylko po to, żeby wiedzieć, że lista została ucięta
    if (out.length > MAX_EXTRA_FIELDS) break
  }
  const truncated = out.length > MAX_EXTRA_FIELDS
  return { fields: truncated ? out.slice(0, MAX_EXTRA_FIELDS) : out, truncated }
}

function findInvoiceRoot(root: XmlNode): XmlNode | null {
  const hasFa = (n: XmlNode) => n.children.some(c => c.name === 'Fa')
  if (root.name === 'Faktura') return hasFa(root) ? root : null
  // tolerancyjnie: faktura opakowana w inny element (np. kopertę)
  const queue: XmlNode[] = [root]
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const n = queue[i]
    if (n.name === 'Faktura' && hasFa(n)) return n
    for (const c of n.children) queue.push(c)
  }
  return null
}

function parseAddress(r: Reader, n: XmlNode | undefined): KsefAddress | null {
  if (!n) return null
  let countryCode = r.val(n, 'KodKraju')
  let lines = [r.val(n, 'AdresL1'), r.val(n, 'AdresL2')].filter(Boolean)
  const gln = r.val(n, 'GLN')
  if (!lines.length) {
    // starszy układ (FA(1)): AdresPol / AdresZagr z polami szczegółowymi
    const old = r.kid(n, 'AdresPol') ?? r.kid(n, 'AdresZagr')
    if (old) {
      const street = r.val(old, 'Ulica')
      const house = r.val(old, 'NrDomu')
      const flat = r.val(old, 'NrLokalu')
      const city = r.val(old, 'Miejscowosc')
      const zip = r.val(old, 'KodPocztowy')
      const l1 = [street || city, house ? house + (flat ? '/' + flat : '') : ''].filter(Boolean).join(' ')
      const l2 = [zip, street ? city : r.val(old, 'Poczta')].filter(Boolean).join(' ')
      lines = [l1, l2].filter(Boolean)
      countryCode = countryCode || r.val(old, 'KodKraju')
    }
  }
  if (!lines.length && !countryCode && !gln) return null
  return { countryCode, lines, gln }
}

function parseParty(r: Reader, n: XmlNode | undefined): KsefParty | null {
  if (!n) return null
  const di = r.kid(n, 'DaneIdentyfikacyjne')
  const ids: KsefIdentifier[] = []
  const prefix = r.val(n, 'PrefiksPodatnika')
  const nip = r.val(di, 'NIP')
  if (nip) ids.push({ label: 'NIP', value: prefix ? `${prefix} ${nip}` : nip })
  const idWew = r.val(di, 'IDWew')
  if (idWew) ids.push({ label: 'Identyfikator wewnętrzny', value: idWew })
  const kodUe = r.val(di, 'KodUE')
  const vatUe = r.val(di, 'NrVatUE')
  if (vatUe) ids.push({ label: 'Nr VAT UE', value: kodUe + vatUe })
  const idCountry = r.val(di, 'KodKraju')
  const nrId = r.val(di, 'NrID')
  if (nrId) ids.push({ label: 'Identyfikator podatkowy', value: idCountry ? `${nrId} (${idCountry})` : nrId })
  if (r.is1(di, 'BrakID')) ids.push({ label: '', value: 'Brak identyfikatora podatkowego' })

  const name = r.val(di, 'Nazwa') || r.val(di, 'PelnaNazwa')
    || [r.val(di, 'ImiePierwsze'), r.val(di, 'Nazwisko')].filter(Boolean).join(' ')

  const contacts: KsefContact[] = []
  for (const c of r.kids(n, 'DaneKontaktowe')) {
    const email = r.val(c, 'Email') || r.val(c, 'EmailPU')
    const phone = r.val(c, 'Telefon') || r.val(c, 'TelefonPU')
    if (email || phone) contacts.push({ email, phone })
  }

  let role = ''
  const roleCode = r.val(n, 'Rola')
  if (roleCode) role = ROLE_LABELS.get(roleCode) ?? `Rola ${roleCode}`
  const otherRole = r.is1(n, 'RolaInna')
  const roleDesc = r.val(n, 'OpisRoli')
  if (!role && (otherRole || roleDesc)) role = roleDesc || 'Inna rola'
  const rolePu = r.val(n, 'RolaPU')
  if (!role && rolePu) role = AUTHORIZED_ROLE_LABELS.get(rolePu) ?? `Rola ${rolePu}`

  const notes: string[] = []
  const status = r.val(n, 'StatusInfoPodatnika')
  if (status) notes.push(TAXPAYER_STATUS_LABELS.get(status) ?? `Status podatnika: ${status}`)
  if (r.is1(n, 'JST')) notes.push('Faktura dotyczy jednostki podrzędnej JST')
  if (r.is1(n, 'GV')) notes.push('Faktura dotyczy członka grupy VAT')

  return {
    name,
    ids,
    address: parseAddress(r, r.kid(n, 'Adres')),
    corrAddress: parseAddress(r, r.kid(n, 'AdresKoresp')),
    contacts,
    eori: r.val(n, 'NrEORI'),
    customerNo: r.val(n, 'NrKlienta'),
    buyerId: r.val(n, 'IDNabywcy'),
    role,
    share: r.val(n, 'Udzial'),
    notes,
  }
}

function parseLine(r: Reader, n: XmlNode): KsefLine {
  r.val(n, 'UU_ID') // identyfikator techniczny wiersza — nie pokazujemy
  return {
    nr: r.val(n, 'NrWierszaFa') || r.val(n, 'NrWiersza'),
    name: r.val(n, 'P_7'),
    index: r.val(n, 'Indeks'),
    gtin: r.val(n, 'GTIN'),
    pkwiu: r.val(n, 'PKWiU'),
    cn: r.val(n, 'CN'),
    pkob: r.val(n, 'PKOB'),
    unit: r.val(n, 'P_8A'),
    qty: r.val(n, 'P_8B'),
    unitNet: r.val(n, 'P_9A'),
    unitGross: r.val(n, 'P_9B'),
    discount: r.val(n, 'P_10'),
    net: r.val(n, 'P_11'),
    gross: r.val(n, 'P_11A'),
    vat: r.val(n, 'P_11Vat'),
    rate: r.val(n, 'P_12'),
    rateOss: r.val(n, 'P_12_XII'),
    excise: r.val(n, 'KwotaAkcyzy'),
    gtu: r.val(n, 'GTU'),
    procedure: r.val(n, 'Procedura'),
    fxRate: r.val(n, 'KursWaluty'),
    deliveryDate: r.val(n, 'P_6A'),
    annex15: r.is1(n, 'P_12_Zal_15'),
    before: r.is1(n, 'StanPrzed'),
  }
}

/** Wiersz zamówienia / umowy na fakturze zaliczkowej (pola z sufiksem „Z”). */
function parseOrderLine(r: Reader, n: XmlNode): KsefLine {
  r.val(n, 'UU_IDZ')
  return {
    nr: r.val(n, 'NrWierszaZam'),
    name: r.val(n, 'P_7Z'),
    index: r.val(n, 'IndeksZ'),
    gtin: r.val(n, 'GTINZ'),
    pkwiu: r.val(n, 'PKWiUZ'),
    cn: r.val(n, 'CNZ'),
    pkob: r.val(n, 'PKOBZ'),
    unit: r.val(n, 'P_8AZ'),
    qty: r.val(n, 'P_8BZ'),
    unitNet: r.val(n, 'P_9AZ'),
    unitGross: '',
    discount: '',
    net: r.val(n, 'P_11NettoZ'),
    gross: '',
    vat: r.val(n, 'P_11VatZ'),
    rate: r.val(n, 'P_12Z'),
    rateOss: r.val(n, 'P_12Z_XII'),
    excise: r.val(n, 'KwotaAkcyzyZ'),
    gtu: r.val(n, 'GTUZ'),
    procedure: r.val(n, 'ProceduraZ'),
    fxRate: '',
    deliveryDate: '',
    annex15: r.is1(n, 'P_12Z_Zal_15'),
    before: r.is1(n, 'StanPrzedZ'),
  }
}

function parseAnnotations(r: Reader, fa: XmlNode): string[] {
  const out: string[] = []
  const adn = r.kid(fa, 'Adnotacje')
  if (adn) {
    if (r.is1(adn, 'P_16')) out.push('Metoda kasowa')
    if (r.is1(adn, 'P_17')) out.push('Samofakturowanie')
    if (r.is1(adn, 'P_18')) out.push('Odwrotne obciążenie')
    if (r.is1(adn, 'P_18A')) out.push('Mechanizm podzielonej płatności')

    // FA(2)/FA(3): pola w podsekcjach; starszy układ: bezpośrednio w Adnotacje
    const zw = r.kid(adn, 'Zwolnienie') ?? adn
    const p19 = r.is1(zw, 'P_19')
    const p19a = r.val(zw, 'P_19A')
    const p19b = r.val(zw, 'P_19B')
    const p19c = r.val(zw, 'P_19C')
    r.val(zw, 'P_19N')
    if (p19 || p19a || p19b || p19c) {
      const basis = [
        p19a ? `przepis ustawy: ${p19a}` : '',
        p19b ? `przepis dyrektywy 2006/112/WE: ${p19b}` : '',
        p19c ? `inna podstawa prawna: ${p19c}` : '',
      ].filter(Boolean).join('; ')
      out.push('Dostawa towarów lub świadczenie usług zwolnione od podatku' + (basis ? ` — ${basis}` : ''))
    }

    const nst = r.kid(adn, 'NoweSrodkiTransportu') ?? adn
    r.val(nst, 'P_22N')
    if (r.is1(nst, 'P_22')) out.push('Wewnątrzwspólnotowa dostawa nowych środków transportu')
    if (r.is1(nst, 'P_42_5')) out.push('Obowiązek, o którym mowa w art. 42 ust. 5 ustawy o VAT')
    for (const v of r.kids(nst, 'NowySrodekTransportu')) {
      const row = r.val(v, 'P_NrWierszaNST')
      const bits = [
        [r.val(v, 'P_22BMK'), r.val(v, 'P_22BMD')].filter(Boolean).join(' '),
        r.val(v, 'P_22BK') ? `kolor: ${r.val(v, 'P_22BK')}` : '',
        r.val(v, 'P_22BNR') ? `nr rej.: ${r.val(v, 'P_22BNR')}` : '',
        r.val(v, 'P_22BRP') ? `rok produkcji: ${r.val(v, 'P_22BRP')}` : '',
        r.val(v, 'P_22A') ? `data dopuszczenia do użytku: ${fmtDate(r.val(v, 'P_22A'))}` : '',
        r.val(v, 'P_22B') ? `przebieg: ${r.val(v, 'P_22B')}` : '',
        r.val(v, 'P_22B1') ? `VIN: ${r.val(v, 'P_22B1')}` : '',
      ].filter(Boolean).join(', ')
      if (bits) out.push(`Nowy środek transportu${row ? ` (wiersz ${row})` : ''}: ${bits}`)
    }

    if (r.is1(adn, 'P_23')) out.push('Procedura uproszczona — transakcja trójstronna')

    const pm = r.kid(adn, 'PMarzy') ?? adn
    r.val(pm, 'P_PMarzyN')
    const marza = r.is1(pm, 'P_PMarzy')
    const kinds = [
      r.is1(pm, 'P_PMarzy_2') ? 'biura podróży' : '',
      r.is1(pm, 'P_PMarzy_3_1') ? 'towary używane' : '',
      r.is1(pm, 'P_PMarzy_3_2') ? 'dzieła sztuki' : '',
      r.is1(pm, 'P_PMarzy_3_3') ? 'przedmioty kolekcjonerskie i antyki' : '',
    ].filter(Boolean)
    if (marza || kinds.length) out.push('Procedura marży' + (kinds.length ? ` — ${kinds.join(', ')}` : ''))
  }
  if (r.is1(fa, 'FP')) out.push('Faktura wystawiona do paragonu')
  if (r.is1(fa, 'TP')) out.push('Podmioty powiązane (istniejące powiązania między nabywcą a dostawcą)')
  if (r.is1(fa, 'ZwrotAkcyzy')) out.push('Informacja dodatkowa związana ze zwrotem podatku akcyzowego zawartego w cenie oleju napędowego')
  return out
}

function parseCorrection(r: Reader, fa: XmlNode): KsefCorrection | null {
  const reason = r.val(fa, 'PrzyczynaKorekty')
  const typeCode = r.val(fa, 'TypKorekty')
  const corrected: KsefCorrectedInvoice[] = []
  for (const d of r.kids(fa, 'DaneFaKorygowanej')) {
    r.val(d, 'NrKSeF') // znacznik „faktura korygowana ma numer KSeF”
    const item: KsefCorrectedInvoice = {
      date: r.val(d, 'DataWystFaKorygowanej'),
      number: r.val(d, 'NrFaKorygowanej'),
      ksefNumber: r.val(d, 'NrKSeFFaKorygowanej'),
      outsideKsef: r.is1(d, 'NrKSeFN'),
    }
    if (item.date || item.number || item.ksefNumber) corrected.push(item)
  }
  const sellerBefore = parseParty(r, r.kid(fa, 'Podmiot1K'))
  const buyersBefore: KsefParty[] = []
  for (const p of r.kids(fa, 'Podmiot2K')) {
    const party = parseParty(r, p)
    if (party) buyersBefore.push(party)
  }
  const c: KsefCorrection = {
    reason,
    typeLabel: typeCode ? CORRECTION_TYPE_LABELS.get(typeCode) ?? `Typ korekty: ${typeCode}` : '',
    corrected,
    period: r.val(fa, 'OkresFaKorygowanej'),
    correctNumber: r.val(fa, 'NrFaKorygowany'),
    sellerBefore,
    buyersBefore,
    amountBefore: r.val(fa, 'P_15ZK'),
    fxRateBefore: r.val(fa, 'KursWalutyZK'),
  }
  const any = c.reason || c.typeLabel || c.corrected.length || c.period || c.correctNumber
    || c.sellerBefore || c.buyersBefore.length || c.amountBefore || c.fxRateBefore
  return any ? c : null
}

function parseSettlement(r: Reader, n: XmlNode | undefined): KsefSettlement | null {
  if (!n) return null
  const list = (name: string): KsefAmountReason[] =>
    r.kids(n, name)
      .map(x => ({ amount: r.val(x, 'Kwota'), reason: r.val(x, 'Powod') }))
      .filter(x => x.amount || x.reason)
  const s: KsefSettlement = {
    charges: list('Obciazenia'),
    chargesTotal: r.val(n, 'SumaObciazen'),
    deductions: list('Odliczenia'),
    deductionsTotal: r.val(n, 'SumaOdliczen'),
    toPay: r.val(n, 'DoZaplaty'),
    toSettle: r.val(n, 'DoRozliczenia'),
  }
  const any = s.charges.length || s.chargesTotal || s.deductions.length || s.deductionsTotal || s.toPay || s.toSettle
  return any ? s : null
}

function paymentMethodLabel(r: Reader, n: XmlNode): string {
  const code = r.val(n, 'FormaPlatnosci')
  const other = r.is1(n, 'PlatnoscInna')
  const desc = r.val(n, 'OpisPlatnosci')
  if (code) return PAYMENT_METHOD_LABELS.get(code) ?? `Forma płatności ${code}`
  if (desc) return `Inna: ${desc}`
  return other ? 'Inna' : ''
}

function parseAccounts(r: Reader, n: XmlNode, name: string): KsefBankAccount[] {
  const out: KsefBankAccount[] = []
  for (const a of r.kids(n, name)) {
    const own = r.val(a, 'RachunekWlasnyBanku')
    const acc: KsefBankAccount = {
      number: r.val(a, 'NrRB') || r.val(a, 'NrRBPL') || r.val(a, 'NrRBZagr'),
      swift: r.val(a, 'SWIFT'),
      bank: r.val(a, 'NazwaBanku'),
      description: r.val(a, 'OpisRachunku'),
      ownBank: own ? OWN_BANK_ACCOUNT_LABELS.get(own) ?? '' : '',
    }
    if (acc.number || acc.swift || acc.bank || acc.description) out.push(acc)
  }
  return out
}

function parsePayment(r: Reader, n: XmlNode | undefined): KsefPayment | null {
  if (!n) return null
  const terms: KsefPaymentTerm[] = []
  for (const t of r.kids(n, 'TerminPlatnosci')) {
    if (!t.children.length) {
      if (t.text) terms.push({ date: t.text, description: '' })
      continue
    }
    const date = r.val(t, 'Termin')
    const opis = r.kid(t, 'TerminOpis')
    let description = ''
    if (opis) {
      if (opis.children.length) {
        // FA(3): opis strukturalny {Ilosc, Jednostka, ZdarzeniePoczatkowe}
        const span = [r.val(opis, 'Ilosc'), r.val(opis, 'Jednostka')].filter(Boolean).join(' ')
        const event = r.val(opis, 'ZdarzeniePoczatkowe')
        description = [span, event ? `zdarzenie początkowe: ${event}` : ''].filter(Boolean).join(', ')
      } else {
        description = opis.text
      }
    }
    if (date || description) terms.push({ date, description })
  }
  // starszy układ: TerminyPlatnosci {TerminPlatnosci, TerminPlatnosciOpis}
  for (const t of r.kids(n, 'TerminyPlatnosci')) {
    const date = r.val(t, 'TerminPlatnosci')
    const description = r.val(t, 'TerminPlatnosciOpis')
    if (date || description) terms.push({ date, description })
  }

  const partials: KsefPartialPayment[] = []
  for (const z of r.kids(n, 'ZaplataCzesciowa')) {
    const p: KsefPartialPayment = {
      amount: r.val(z, 'KwotaZaplatyCzesciowej'),
      date: r.val(z, 'DataZaplatyCzesciowej'),
      method: paymentMethodLabel(r, z),
    }
    if (p.amount || p.date) partials.push(p)
  }

  const skonto = r.kid(n, 'Skonto')
  const p: KsefPayment = {
    paid: r.is1(n, 'Zaplacono'),
    paidDate: r.val(n, 'DataZaplaty'),
    partialFlag: r.val(n, 'ZnacznikZaplatyCzesciowej'),
    partials,
    terms,
    method: paymentMethodLabel(r, n),
    accounts: parseAccounts(r, n, 'RachunekBankowy'),
    factorAccounts: parseAccounts(r, n, 'RachunekBankowyFaktora'),
    discountTerms: r.val(skonto, 'WarunkiSkonta'),
    discountAmount: r.val(skonto, 'WysokoscSkonta'),
    link: r.val(n, 'LinkDoPlatnosci'),
    ksefPaymentId: r.val(n, 'IPKSeF'),
  }
  const any = p.paid || p.paidDate || p.partialFlag === '1' || p.partialFlag === '2' || p.partials.length || p.terms.length
    || p.method || p.accounts.length || p.factorAccounts.length || p.discountTerms || p.discountAmount || p.link || p.ksefPaymentId
  return any ? p : null
}

function addressOneLine(a: KsefAddress | null): string {
  if (!a) return ''
  return [...a.lines, countryName(a.countryCode), a.gln ? `GLN: ${a.gln}` : ''].filter(Boolean).join(', ')
}

function parseTransport(r: Reader, t: XmlNode): KsefLabelValue[] {
  const rows: KsefLabelValue[] = []
  const add = (label: string, value: string) => { if (value) rows.push({ label, value }) }
  const kind = r.val(t, 'RodzajTransportu')
  r.val(t, 'TransportInny')
  add('Rodzaj transportu', kind ? TRANSPORT_TYPE_LABELS.get(kind) ?? `kod ${kind}` : r.val(t, 'OpisInnegoTransportu'))
  const carrier = r.kid(t, 'Przewoznik')
  if (carrier) {
    const di = r.kid(carrier, 'DaneIdentyfikacyjne')
    const nip = r.val(di, 'NIP')
    const name = r.val(di, 'Nazwa')
    const addr = addressOneLine(parseAddress(r, r.kid(carrier, 'AdresPrzewoznika')))
    add('Przewoźnik', [name, nip ? `NIP ${nip}` : '', addr].filter(Boolean).join(', '))
  }
  add('Nr zlecenia transportu', r.val(t, 'NrZleceniaTransportu'))
  const cargo = r.val(t, 'OpisLadunku')
  r.val(t, 'LadunekInny')
  const cargoLabel = cargo ? CARGO_LABELS.get(cargo) : ''
  add('Ładunek', cargo ? (cargoLabel ? `${cargoLabel} (kod ${cargo})` : `kod ${cargo}`) : r.val(t, 'OpisInnegoLadunku'))
  add('Jednostka opakowania', r.val(t, 'JednostkaOpakowania'))
  add('Rozpoczęcie transportu', fmtDate(r.val(t, 'DataGodzRozpTransportu')))
  add('Zakończenie transportu', fmtDate(r.val(t, 'DataGodzZakTransportu')))
  add('Wysyłka z', addressOneLine(parseAddress(r, r.kid(t, 'WysylkaZ'))))
  for (const via of r.kids(t, 'WysylkaPrzez')) add('Wysyłka przez', addressOneLine(parseAddress(r, via)))
  add('Wysyłka do', addressOneLine(parseAddress(r, r.kid(t, 'WysylkaDo'))))
  return rows
}

function parseTerms(r: Reader, n: XmlNode | undefined): KsefTerms | null {
  if (!n) return null
  const t: KsefTerms = {
    contracts: r.kids(n, 'Umowy')
      .map(u => ({ date: r.val(u, 'DataUmowy'), number: r.val(u, 'NrUmowy') }))
      .filter(u => u.date || u.number),
    orders: r.kids(n, 'Zamowienia')
      .map(z => ({ date: r.val(z, 'DataZamowienia'), number: r.val(z, 'NrZamowienia') }))
      .filter(z => z.date || z.number),
    batches: r.vals(n, 'NrPartiiTowaru'),
    delivery: r.val(n, 'WarunkiDostawy'),
    contractRate: r.val(n, 'KursUmowny'),
    contractCurrency: r.val(n, 'WalutaUmowna'),
    intermediary: r.is1(n, 'PodmiotPosredniczacy'),
    transports: r.kids(n, 'Transport').map(x => parseTransport(r, x)).filter(rows => rows.length > 0),
  }
  const any = t.contracts.length || t.orders.length || t.batches.length || t.delivery || t.contractRate
    || t.contractCurrency || t.intermediary || t.transports.length
  return any ? t : null
}

/** FA(3): Zalacznik > BlokDanych {ZNaglowek, MetaDane*, Tekst{Akapit*}, Tabela*} — czytane tolerancyjnie. */
function parseAttachment(r: Reader, n: XmlNode | undefined): KsefAttachmentBlock[] {
  if (!n) return []
  const blocks: KsefAttachmentBlock[] = []
  for (const b of r.kids(n, 'BlokDanych')) {
    const tables: KsefAttachmentTable[] = []
    for (const t of r.kids(b, 'Tabela')) {
      const head = r.kid(t, 'TNaglowek')
      const table: KsefAttachmentTable = {
        description: r.val(t, 'Opis'),
        meta: r.kids(t, 'TMetaDane')
          .map(m => ({ label: r.val(m, 'TKlucz'), value: r.val(m, 'TWartosc') }))
          .filter(m => m.label || m.value),
        header: r.kids(head, 'Kol').map(k => r.val(k, 'NKom') || k.text),
        rows: r.kids(t, 'Wiersz').map(w => r.kids(w, 'WKom').map(c => c.text)).filter(row => row.length > 0),
        sum: r.kids(r.kid(t, 'Suma'), 'SKom').map(c => c.text),
      }
      if (table.header.length || table.rows.length || table.description || table.meta.length) tables.push(table)
    }
    const block: KsefAttachmentBlock = {
      title: r.val(b, 'ZNaglowek'),
      meta: r.kids(b, 'MetaDane')
        .map(m => ({ label: r.val(m, 'ZKlucz'), value: r.val(m, 'ZWartosc') }))
        .filter(m => m.label || m.value),
      paragraphs: r.vals(r.kid(b, 'Tekst'), 'Akapit'),
      tables,
    }
    if (block.title || block.meta.length || block.paragraphs.length || block.tables.length) blocks.push(block)
  }
  return blocks
}

function vatGroupLabel(group: (typeof VAT_GROUPS)[number], lineRates: Set<string>): string {
  if (!group.rates) return group.label
  const [a, b] = group.rates
  const hasA = lineRates.has(a)
  const hasB = lineRates.has(b)
  if (hasA === hasB) return group.label // brak stawki w wierszach albo obie naraz — zostaje opis grupy
  const rate = `${hasA ? a : b}%`
  return group.key === '4' ? `${rate} (ryczałt dla taksówek)` : rate
}

export function parseKsefInvoice(xml: string): KsefInvoiceDoc {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new KsefDocumentError('Brak treści XML faktury.')
  }
  const root = parseXml(xml)
  if (!root) {
    throw new KsefDocumentError('Nie udało się odczytać XML faktury — plik jest uszkodzony albo niekompletny.')
  }
  const faktura = findInvoiceRoot(root)
  const fa = faktura?.children.find(c => c.name === 'Fa')
  if (!faktura || !fa) {
    throw new KsefDocumentError('To nie jest faktura ustrukturyzowana KSeF (brak elementu Faktura/Fa).')
  }

  const r = new Reader()
  r.seen.add(fa)

  // ── Naglowek ──
  const head = r.kid(faktura, 'Naglowek')
  const kod = r.kid(head, 'KodFormularza')
  const variant = r.val(head, 'WariantFormularza')
  const schema = (kod?.attrs.kodSystemowy ?? '').trim() || (variant ? `FA (${variant})` : '')

  // ── podmioty ──
  const seller = parseParty(r, r.kid(faktura, 'Podmiot1'))
  const buyer = parseParty(r, r.kid(faktura, 'Podmiot2'))
  const otherParties: KsefParty[] = []
  for (const p of r.kids(faktura, 'Podmiot3')) {
    const party = parseParty(r, p)
    if (party) otherParties.push(party)
  }
  const authorized = parseParty(r, r.kid(faktura, 'PodmiotUpowazniony'))

  // ── Fa ──
  const type = r.val(fa, 'RodzajFaktury').toUpperCase()
  const period = r.kid(fa, 'OkresFa')
  const lineNodes = r.kids(fa, 'FaWiersz')
  const order = r.kid(fa, 'Zamowienie')
  const orderNodes = r.kids(order, 'ZamowienieWiersz')
  // Schemat FA dopuszcza najwyżej 10 000 wierszy faktury / zamówienia — więcej oznacza plik spreparowany;
  // odrzucamy go przed budowaniem modelu i HTML (ograniczenie pamięci i czasu renderowania).
  if (lineNodes.length > MAX_INVOICE_LINES || orderNodes.length > MAX_INVOICE_LINES) {
    throw new KsefDocumentError('Faktura ma zbyt wiele pozycji, aby zbudować jej podgląd.')
  }
  const lines = lineNodes.map(n => parseLine(r, n))
  const orderLines = orderNodes.map(n => parseOrderLine(r, n))

  // stawki faktycznie użyte w wierszach — do opisania grup „23% lub 22%” / „8% lub 7%”
  const lineRates = new Set<string>()
  for (const l of lines) if (l.rate) lineRates.add(fmtQty(l.rate))
  for (const l of orderLines) if (l.rate) lineRates.add(fmtQty(l.rate))

  const vatRows: KsefVatRow[] = []
  for (const g of VAT_GROUPS) {
    const net = r.val(fa, g.net)
    const vat = g.vat ? r.val(fa, g.vat) : ''
    const vatPln = g.vatPln ? r.val(fa, g.vatPln) : ''
    if (!net && !vat && !vatPln) continue
    // grupa ze stawką: brutto = netto + VAT (gdy znamy oba); grupy bez podatku: brutto = netto
    const gross = g.vat ? (net && vat ? decSum([net, vat]) : '') : net
    vatRows.push({ key: g.key, label: vatGroupLabel(g, lineRates), net, vat, vatPln, gross })
  }

  const additional: KsefAdditionalInfo[] = r.kids(fa, 'DodatkowyOpis')
    .map(d => ({ row: r.val(d, 'NrWiersza'), key: r.val(d, 'Klucz'), value: r.val(d, 'Wartosc') }))
    .filter(d => d.key || d.value)

  const advancePayments: KsefAdvancePayment[] = r.kids(fa, 'ZaliczkaCzesciowa')
    .map(z => ({ date: r.val(z, 'P_6Z'), amount: r.val(z, 'P_15Z'), fxRate: r.val(z, 'KursWalutyZW') }))
    .filter(z => z.date || z.amount)

  const advanceInvoices: string[] = []
  for (const f of r.kids(fa, 'FakturaZaliczkowa')) {
    // NrKSeFZN = 1 → faktura zaliczkowa wystawiona poza KSeF; podaje się wtedy jej własny numer (NrFaZaliczkowej)
    const outsideKsef = r.is1(f, 'NrKSeFZN')
    const ksefNr = r.val(f, 'NrKSeFFaZaliczkowej')
    const nr = ksefNr || r.val(f, 'NrFaZaliczkowej')
    if (nr) advanceInvoices.push(outsideKsef || !ksefNr ? `${nr} (poza KSeF)` : nr)
  }

  // ── Stopka ──
  const stopka = r.kid(faktura, 'Stopka')
  const footerTexts: string[] = []
  for (const info of r.kids(stopka, 'Informacje')) footerTexts.push(...r.vals(info, 'StopkaFaktury'))
  const registries: KsefRegistry[] = r.kids(stopka, 'Rejestry')
    .map(x => ({ fullName: r.val(x, 'PelnaNazwa'), krs: r.val(x, 'KRS'), regon: r.val(x, 'REGON'), bdo: r.val(x, 'BDO') }))
    .filter(x => x.fullName || x.krs || x.regon || x.bdo)

  const doc: KsefInvoiceDoc = {
    schema,
    schemaVersion: (kod?.attrs.wersjaSchemy ?? '').trim(),
    generatedAt: r.val(head, 'DataWytworzeniaFa'),
    systemInfo: r.val(head, 'SystemInfo'),
    type,
    typeLabel: TYPE_LABELS.get(type) ?? 'Faktura',
    number: r.val(fa, 'P_2'),
    issueDate: r.val(fa, 'P_1'),
    issuePlace: r.val(fa, 'P_1M'),
    saleDate: r.val(fa, 'P_6'),
    periodFrom: r.val(period, 'P_6_Od'),
    periodTo: r.val(period, 'P_6_Do'),
    currency: r.val(fa, 'KodWaluty'),
    wz: r.vals(fa, 'WZ'),
    seller,
    buyer,
    otherParties,
    authorized,
    lines,
    orderLines,
    orderValue: r.val(order, 'WartoscZamowienia'),
    vatRows,
    total: r.val(fa, 'P_15'),
    fxRateAdvance: r.val(fa, 'KursWalutyZ'),
    annotations: parseAnnotations(r, fa),
    correction: parseCorrection(r, fa),
    advancePayments,
    advanceInvoices,
    additional,
    settlement: parseSettlement(r, r.kid(fa, 'Rozliczenie')),
    payment: parsePayment(r, r.kid(fa, 'Platnosc')),
    terms: parseTerms(r, r.kid(fa, 'WarunkiTransakcji')),
    footerTexts,
    registries,
    attachment: parseAttachment(r, r.kid(faktura, 'Zalacznik')),
    extra: [],
    extraTruncated: false,
  }
  const extras = collectExtras(faktura, r.seen)
  doc.extra = extras.fields
  doc.extraTruncated = extras.truncated
  return doc
}

// ═════════════════════════════════════════════════════════════════════════════
// C) Render HTML
// ═════════════════════════════════════════════════════════════════════════════

/** Escapowanie HTML (treść i atrybuty) + usunięcie znaków sterujących (C0, DEL, bidi). null/undefined → ''. */
function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return stripBidi(String(value))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function money(amount: string, currency: string): string {
  if (!amount) return ''
  return fmtAmount(amount) + (currency ? ' ' + currency : '')
}

function section(title: string, body: string, cls = ''): string {
  if (!body) return ''
  return `<section${cls ? ` class="${cls}"` : ''}><h2>${esc(title)}</h2>${body}</section>`
}

/** Lista „etykieta: wartość”; puste wartości są pomijane, pusta lista → ''. */
function kvList(rows: [string, string][], cls = 'kv'): string {
  const html = rows
    .filter(([, v]) => v)
    .map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`)
    .join('')
  return html ? `<dl class="${cls}">${html}</dl>` : ''
}

function addressHtml(a: KsefAddress | null, label = ''): string {
  if (!a) return ''
  const lines = [...a.lines, countryName(a.countryCode)].filter(Boolean)
  const out: string[] = []
  if (lines.length) {
    out.push(`<div class="addr">${label ? `<span class="lbl">${esc(label)}:</span> ` : ''}${lines.map(esc).join('<br>')}</div>`)
  }
  if (a.gln) out.push(`<div><span class="lbl">GLN:</span> ${esc(a.gln)}</div>`)
  return out.join('')
}

function partyHtml(title: string, p: KsefParty | null): string {
  if (!p) return ''
  const rows: string[] = []
  if (p.name) rows.push(`<div class="name">${esc(p.name)}</div>`)
  for (const id of p.ids) {
    rows.push(id.label
      ? `<div><span class="lbl">${esc(id.label)}:</span> <b>${esc(id.value)}</b></div>`
      : `<div>${esc(id.value)}</div>`)
  }
  if (p.eori) rows.push(`<div><span class="lbl">Nr EORI:</span> ${esc(p.eori)}</div>`)
  rows.push(addressHtml(p.address))
  rows.push(addressHtml(p.corrAddress, 'Adres korespondencyjny'))
  for (const c of p.contacts) {
    if (c.email) rows.push(`<div><span class="lbl">E-mail:</span> ${esc(c.email)}</div>`)
    if (c.phone) rows.push(`<div><span class="lbl">Tel.:</span> ${esc(c.phone)}</div>`)
  }
  if (p.customerNo) rows.push(`<div><span class="lbl">Nr klienta:</span> ${esc(p.customerNo)}</div>`)
  if (p.buyerId) rows.push(`<div><span class="lbl">ID nabywcy:</span> ${esc(p.buyerId)}</div>`)
  if (p.share) rows.push(`<div><span class="lbl">Udział:</span> ${esc(fmtQty(p.share))}%</div>`)
  for (const n of p.notes) rows.push(`<div class="muted">${esc(n)}</div>`)
  const body = rows.filter(Boolean).join('')
  if (!body) return ''
  return `<div class="party"><h2>${esc(title)}</h2>${body}</div>`
}

function headerHtml(doc: KsefInvoiceDoc, ksefNumber: string, direction: string): string {
  const dirLabel = direction === 'incoming' ? 'Faktura zakupowa (otrzymana)'
    : direction === 'outgoing' ? 'Faktura sprzedażowa (wystawiona)' : ''
  const left = `<div class="head-main">`
    + `<div class="doctype">${esc(doc.typeLabel)}${dirLabel ? ` <span class="chip noprint">${esc(dirLabel)}</span>` : ''}</div>`
    + (doc.number ? `<h1 class="docno">${esc(doc.number)}</h1>` : '')
    + `</div>`
  const rightRows: string[] = []
  if (ksefNumber) rightRows.push(`<div class="lbl">Numer KSeF</div><div class="ksefno">${esc(ksefNumber)}</div>`)
  const schemaBits = [doc.schema ? `Schemat ${doc.schema}` : '', doc.schemaVersion ? `wersja ${doc.schemaVersion}` : ''].filter(Boolean).join(', ')
  if (schemaBits) rightRows.push(`<div class="schema">${esc(schemaBits)}</div>`)
  const right = rightRows.length ? `<div class="head-side">${rightRows.join('')}</div>` : ''

  const fx = commonFxRate(doc.lines)
  // P_6 na fakturze zaliczkowej to data otrzymania zapłaty, na pozostałych — data dostawy / wykonania usługi
  const advance = doc.type === 'ZAL' || doc.type === 'KOR_ZAL'
  const facts: [string, string][] = [
    ['Data wystawienia', fmtDate(doc.issueDate)],
    ['Miejsce wystawienia', doc.issuePlace],
    [advance ? 'Data otrzymania zapłaty' : 'Data dostawy / wykonania usługi', fmtDate(doc.saleDate)],
    ['Okres, którego dotyczy faktura',
      doc.periodFrom || doc.periodTo ? `${fmtDate(doc.periodFrom) || '…'} – ${fmtDate(doc.periodTo) || '…'}` : ''],
    ['Waluta', doc.currency],
    ['Kurs waluty', fx ? fmtRate(fx) : ''],
    ['Dokumenty WZ', doc.wz.join(', ')],
  ]
  return `<header class="head">${left}${right}</header>${kvList(facts, 'facts')}`
}

/** Jeden kurs wspólny dla wszystkich wierszy → pokazujemy go raz w nagłówku zamiast przy każdej pozycji. */
function commonFxRate(lines: KsefLine[]): string {
  let rate = ''
  for (const l of lines) {
    if (!l.fxRate) return ''
    if (rate && l.fxRate !== rate) return ''
    rate = l.fxRate
  }
  return rate
}

function lineMeta(l: KsefLine, showFx: boolean, advance: boolean): string {
  const bits: string[] = []
  if (l.index) bits.push(`Indeks: ${l.index}`)
  if (l.gtin) bits.push(`GTIN: ${l.gtin}`)
  if (l.pkwiu) bits.push(`PKWiU: ${l.pkwiu}`)
  if (l.cn) bits.push(`CN: ${l.cn}`)
  if (l.pkob) bits.push(`PKOB: ${l.pkob}`)
  if (l.gtu) bits.push(`GTU: ${l.gtu}`)
  if (l.procedure) bits.push(`Procedura: ${l.procedure}`)
  // P_6A na fakturze zaliczkowej to data otrzymania zapłaty (jak P_6 w nagłówku)
  if (l.deliveryDate) bits.push(`${advance ? 'Data otrzymania zapłaty' : 'Data dostawy / wykonania'}: ${fmtDate(l.deliveryDate)}`)
  // kolumna ceny pokazuje P_9A; gdy wiersz ma też P_9B, cena brutto trafia tutaj (nie może zniknąć)
  if (l.unitNet && l.unitGross) bits.push(`Cena jedn. brutto: ${fmtPrice(l.unitGross)}`)
  if (l.excise) bits.push(`Akcyza: ${fmtAmount(l.excise)}`)
  if (showFx && l.fxRate) bits.push(`Kurs waluty: ${fmtRate(l.fxRate)}`)
  if (l.annex15) bits.push('Załącznik nr 15 do ustawy o VAT')
  return bits.join(' · ')
}

/** advance — faktura zaliczkowa (ZAL / KOR_ZAL): zmienia opis daty P_6A w wierszu. */
function linesTable(lines: KsefLine[], advance = false): string {
  if (!lines.length) return ''
  const netPrice = lines.some(l => l.unitNet)
  const grossOnlyPrice = lines.some(l => !l.unitNet && l.unitGross)
  const priceMode: 'net' | 'gross' | 'mixed' = netPrice && grossOnlyPrice ? 'mixed' : grossOnlyPrice ? 'gross' : 'net'
  const showPrice = netPrice || grossOnlyPrice
  const showQty = lines.some(l => l.qty)
  const showUnit = lines.some(l => l.unit)
  const showDiscount = lines.some(l => isNonZero(l.discount))
  const showRate = lines.some(l => l.rate || l.rateOss)
  const showNet = lines.some(l => l.net)
  const showVat = lines.some(l => l.vat)
  const showGross = lines.some(l => l.gross)
  const showFx = !commonFxRate(lines)

  const th: string[] = ['<th class="c-lp">Lp.</th>', '<th class="c-name">Nazwa towaru / usługi</th>']
  if (showQty) th.push('<th class="num">Ilość</th>')
  if (showUnit) th.push('<th class="c-unit">J.m.</th>')
  if (showPrice) th.push(`<th class="num">Cena jedn.${priceMode === 'net' ? ' netto' : priceMode === 'gross' ? ' brutto' : ''}</th>`)
  if (showDiscount) th.push('<th class="num">Rabat</th>')
  if (showRate) th.push('<th class="num">Stawka VAT</th>')
  if (showNet) th.push('<th class="num">Wartość netto</th>')
  if (showVat) th.push('<th class="num">Kwota VAT</th>')
  if (showGross) th.push('<th class="num">Wartość brutto</th>')

  const rows = lines.map((l, idx) => {
    const meta = lineMeta(l, showFx, advance)
    const td: string[] = [
      `<td class="c-lp">${esc(l.nr || String(idx + 1))}</td>`,
      `<td class="c-name">${esc(l.name)}`
        + (l.before ? ' <span class="tag">stan przed korektą</span>' : '')
        + (meta ? `<div class="sub">${esc(meta)}</div>` : '')
        + '</td>',
    ]
    if (showQty) td.push(`<td class="num">${esc(fmtQty(l.qty))}</td>`)
    if (showUnit) td.push(`<td class="c-unit">${esc(l.unit)}</td>`)
    if (showPrice) {
      const price = l.unitNet || l.unitGross
      const suffix = priceMode === 'mixed' && price ? ` <span class="sub-inline">${l.unitNet ? 'netto' : 'brutto'}</span>` : ''
      td.push(`<td class="num">${esc(price ? fmtPrice(price) : '')}${suffix}</td>`)
    }
    // P_10 ma w schemacie precyzję ceny jednostkowej (do 8 miejsc) — bez zaokrąglania do groszy
    if (showDiscount) td.push(`<td class="num">${esc(isNonZero(l.discount) ? fmtPrice(l.discount) : '')}</td>`)
    if (showRate) td.push(`<td class="num">${esc(rateLabel(l.rate, l.rateOss))}</td>`)
    if (showNet) td.push(`<td class="num">${esc(l.net ? fmtAmount(l.net) : '')}</td>`)
    if (showVat) td.push(`<td class="num">${esc(l.vat ? fmtAmount(l.vat) : '')}</td>`)
    if (showGross) td.push(`<td class="num">${esc(l.gross ? fmtAmount(l.gross) : '')}</td>`)
    return `<tr${l.before ? ' class="before"' : ''}>${td.join('')}</tr>`
  })

  // przy wielu kolumnach nagłówki liczbowe mogą się zawijać — tabela mieści się na A4
  return `<table class="items${th.length >= 9 ? ' dense' : ''}"><thead><tr>${th.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
}

function vatSummaryHtml(doc: KsefInvoiceDoc): string {
  const rows = doc.vatRows
  let table = ''
  if (rows.length) {
    const showPln = rows.some(v => v.vatPln)
    const cell = (v: string) => `<td class="num">${v ? esc(fmtAmount(v)) : '—'}</td>`
    const body = rows.map(v =>
      `<tr><td>${esc(v.label)}</td>${cell(v.net)}${cell(v.vat)}${cell(v.gross)}${showPln ? cell(v.vatPln) : ''}</tr>`,
    ).join('')
    let foot = ''
    if (rows.length > 1) {
      // „Razem” liczone wyłącznie z pól podsumowania (kolumna brutto tylko gdy każda grupa ma brutto)
      const allGross = rows.every(v => v.gross)
      foot = `<tfoot><tr><td>Razem</td>${cell(decSum(rows.map(v => v.net)))}${cell(decSum(rows.map(v => v.vat)))}`
        + `${cell(allGross ? decSum(rows.map(v => v.gross)) : '')}${showPln ? cell(decSum(rows.map(v => v.vatPln))) : ''}</tr></tfoot>`
    }
    table = `<table class="vat"><thead><tr><th>Stawka VAT</th><th class="num">Wartość netto</th><th class="num">Kwota VAT</th>`
      + `<th class="num">Wartość brutto</th>${showPln ? '<th class="num">VAT w PLN</th>' : ''}</tr></thead>`
      + `<tbody>${body}</tbody>${foot}</table>`
  }
  const total = doc.total
    ? `<div class="total"><span>Kwota należności ogółem</span><strong>${esc(money(doc.total, doc.currency))}</strong></div>`
    : ''
  const fx = doc.fxRateAdvance
    ? `<div class="muted right">Kurs waluty zastosowany do wyliczenia podatku: ${esc(fmtRate(doc.fxRateAdvance))}</div>`
    : ''
  return section(rows.length ? 'Podsumowanie stawek VAT' : 'Podsumowanie', table + total + fx)
}

function correctionHtml(doc: KsefInvoiceDoc): string {
  const c = doc.correction
  if (!c) return ''
  const parts: string[] = []
  parts.push(kvList([
    ['Przyczyna korekty', c.reason],
    ['Typ korekty', c.typeLabel],
    ['Okres, którego dotyczy korekta', c.period],
    ['Poprawny numer faktury korygowanej', c.correctNumber],
    ['Kwota przed korektą', money(c.amountBefore, doc.currency)],
    ['Kurs waluty przed korektą', c.fxRateBefore ? fmtRate(c.fxRateBefore) : ''],
  ]))
  if (c.corrected.length) {
    const rows = c.corrected.map(x =>
      `<tr><td>${esc(x.number)}</td><td>${esc(fmtDate(x.date))}</td>`
      + `<td>${esc(x.ksefNumber || (x.outsideKsef ? 'faktura wystawiona poza KSeF' : ''))}</td></tr>`,
    ).join('')
    parts.push(`<table><thead><tr><th>Numer faktury korygowanej</th><th>Data wystawienia</th><th>Numer KSeF</th></tr></thead><tbody>${rows}</tbody></table>`)
  }
  const before = [
    partyHtml('Sprzedawca — dane przed korektą', c.sellerBefore),
    ...c.buyersBefore.map(b => partyHtml('Nabywca — dane przed korektą', b)),
  ].filter(Boolean).join('')
  if (before) parts.push(`<div class="parties">${before}</div>`)
  return section('Dane faktury korygowanej', parts.filter(Boolean).join(''))
}

function advancesHtml(doc: KsefInvoiceDoc): string {
  const parts: string[] = []
  if (doc.advancePayments.length) {
    const showFx = doc.advancePayments.some(a => a.fxRate)
    const rows = doc.advancePayments.map(a =>
      `<tr><td>${esc(fmtDate(a.date))}</td><td class="num">${esc(money(a.amount, doc.currency))}</td>`
      + `${showFx ? `<td class="num">${esc(a.fxRate ? fmtRate(a.fxRate) : '')}</td>` : ''}</tr>`,
    ).join('')
    parts.push(`<table class="narrow"><thead><tr><th>Data otrzymania płatności</th><th class="num">Kwota</th>`
      + `${showFx ? '<th class="num">Kurs waluty</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`)
  }
  if (doc.advanceInvoices.length) {
    parts.push(`<div><span class="lbl">Faktury zaliczkowe:</span> ${doc.advanceInvoices.map(esc).join(', ')}</div>`)
  }
  return section('Zaliczki', parts.join(''))
}

function settlementHtml(doc: KsefInvoiceDoc): string {
  const s = doc.settlement
  if (!s) return ''
  const rows: string[] = []
  const amount = (v: string) => `<td class="num">${esc(money(v, doc.currency))}</td>`
  for (const c of s.charges) rows.push(`<tr><td>Obciążenie${c.reason ? `: ${esc(c.reason)}` : ''}</td>${amount(c.amount)}</tr>`)
  if (s.chargesTotal) rows.push(`<tr class="strong"><td>Suma obciążeń</td>${amount(s.chargesTotal)}</tr>`)
  for (const d of s.deductions) rows.push(`<tr><td>Odliczenie${d.reason ? `: ${esc(d.reason)}` : ''}</td>${amount(d.amount)}</tr>`)
  if (s.deductionsTotal) rows.push(`<tr class="strong"><td>Suma odliczeń</td>${amount(s.deductionsTotal)}</tr>`)
  if (s.toPay) rows.push(`<tr class="strong"><td>Do zapłaty</td>${amount(s.toPay)}</tr>`)
  if (s.toSettle) rows.push(`<tr class="strong"><td>Do rozliczenia</td>${amount(s.toSettle)}</tr>`)
  return section('Rozliczenie', rows.length ? `<table class="narrow"><tbody>${rows.join('')}</tbody></table>` : '')
}

function accountsTable(title: string, accounts: KsefBankAccount[]): string {
  if (!accounts.length) return ''
  const items = accounts.map(a => {
    const sub = [
      a.bank,
      a.swift ? `SWIFT: ${a.swift}` : '',
      a.description,
      a.ownBank,
    ].filter(Boolean).join(' · ')
    return `<div class="account"><span class="lbl">${esc(title)}:</span> <b class="nw">${esc(fmtAccount(a.number))}</b>`
      + `${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`
  })
  return items.join('')
}

function paymentHtml(doc: KsefInvoiceDoc): string {
  const p = doc.payment
  if (!p) return ''
  const status = p.paid ? 'Zapłacono'
    : p.partialFlag === '2' ? 'Zapłacono w całości (w częściach)'
    : p.partialFlag === '1' ? 'Zapłacono częściowo' : ''
  const terms = p.terms
    .map(t => [fmtDate(t.date), t.description ? (t.date ? `(${t.description})` : t.description) : ''].filter(Boolean).join(' '))
    .filter(Boolean)
  const parts: string[] = []
  parts.push(kvList([
    ['Informacja o płatności', status],
    ['Data zapłaty', fmtDate(p.paidDate)],
    [terms.length > 1 ? 'Terminy płatności' : 'Termin płatności', terms.join('; ')],
    ['Forma płatności', p.method],
    ['Skonto — warunki', p.discountTerms],
    ['Skonto — wysokość', p.discountAmount],
    ['Link do płatności', p.link],
    ['Identyfikator płatności KSeF', p.ksefPaymentId],
  ]))
  if (p.partials.length) {
    const showMethod = p.partials.some(x => x.method)
    const rows = p.partials.map(x =>
      `<tr><td>${esc(fmtDate(x.date))}</td><td class="num">${esc(money(x.amount, doc.currency))}</td>`
      + `${showMethod ? `<td>${esc(x.method)}</td>` : ''}</tr>`,
    ).join('')
    parts.push(`<table class="narrow"><thead><tr><th>Data zapłaty częściowej</th><th class="num">Kwota</th>`
      + `${showMethod ? '<th>Forma płatności</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`)
  }
  parts.push(accountsTable('Rachunek bankowy', p.accounts))
  parts.push(accountsTable('Rachunek bankowy faktora', p.factorAccounts))
  return section('Płatność', parts.filter(Boolean).join(''))
}

function termsHtml(doc: KsefInvoiceDoc): string {
  const t = doc.terms
  if (!t) return ''
  const dated = (items: KsefDatedNumber[]) =>
    items.map(x => [x.number, x.date ? `z dnia ${fmtDate(x.date)}` : ''].filter(Boolean).join(' ')).join('; ')
  const parts: string[] = []
  parts.push(kvList([
    [t.contracts.length > 1 ? 'Umowy' : 'Umowa', dated(t.contracts)],
    [t.orders.length > 1 ? 'Zamówienia' : 'Zamówienie', dated(t.orders)],
    ['Numery partii towaru', t.batches.join(', ')],
    ['Warunki dostawy', t.delivery],
    ['Kurs umowny', t.contractRate ? fmtRate(t.contractRate) + (t.contractCurrency ? ` ${t.contractCurrency}` : '') : ''],
    ['Waluta umowna', t.contractRate ? '' : t.contractCurrency],
    ['Podmiot pośredniczący', t.intermediary ? 'Dostawa dokonana przez podmiot pośredniczący (art. 22 ust. 2d ustawy o VAT)' : ''],
  ]))
  t.transports.forEach((rows, i) => {
    const list = kvList(rows.map(x => [x.label, x.value] as [string, string]))
    if (list) parts.push(`<h3>Transport${t.transports.length > 1 ? ` ${i + 1}` : ''}</h3>${list}`)
  })
  return section('Warunki transakcji', parts.filter(Boolean).join(''))
}

function additionalHtml(doc: KsefInvoiceDoc): string {
  if (!doc.additional.length) return ''
  const showRow = doc.additional.some(a => a.row)
  const rows = doc.additional.map(a =>
    `<tr>${showRow ? `<td class="c-lp">${esc(a.row)}</td>` : ''}<td>${esc(a.key)}</td><td class="pre">${esc(a.value)}</td></tr>`,
  ).join('')
  return section('Dodatkowy opis',
    `<table><thead><tr>${showRow ? '<th class="c-lp">Wiersz</th>' : ''}<th>Rodzaj informacji</th><th>Treść</th></tr></thead><tbody>${rows}</tbody></table>`)
}

function attachmentHtml(doc: KsefInvoiceDoc): string {
  if (!doc.attachment.length) return ''
  const blocks = doc.attachment.map(b => {
    const parts: string[] = []
    if (b.title) parts.push(`<h3>${esc(b.title)}</h3>`)
    parts.push(kvList(b.meta.map(m => [m.label || '—', m.value] as [string, string])))
    for (const p of b.paragraphs) parts.push(`<p class="pre">${esc(p)}</p>`)
    for (const t of b.tables) {
      if (t.description) parts.push(`<p class="muted">${esc(t.description)}</p>`)
      parts.push(kvList(t.meta.map(m => [m.label || '—', m.value] as [string, string])))
      const head = t.header.length ? `<thead><tr>${t.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : ''
      const body = t.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
      const foot = t.sum.length ? `<tfoot><tr>${t.sum.map(c => `<td>${esc(c)}</td>`).join('')}</tr></tfoot>` : ''
      if (head || body || foot) parts.push(`<table>${head}<tbody>${body}</tbody>${foot}</table>`)
    }
    return parts.filter(Boolean).join('')
  }).filter(Boolean).join('')
  return section('Załącznik do faktury', blocks)
}

function footerHtml(doc: KsefInvoiceDoc): string {
  const parts: string[] = doc.footerTexts.map(t => `<p class="pre">${esc(t)}</p>`)
  for (const reg of doc.registries) {
    parts.push(kvList([
      ['Pełna nazwa', reg.fullName],
      ['KRS', reg.krs],
      ['REGON', reg.regon],
      ['BDO', reg.bdo],
    ], 'facts'))
  }
  return section('Stopka', parts.filter(Boolean).join(''))
}

function extrasHtml(doc: KsefInvoiceDoc): string {
  if (!doc.extra.length) return ''
  let rows = doc.extra.map(x => `<tr><td class="path">${esc(x.path)}</td><td class="pre">${esc(x.value)}</td></tr>`).join('')
  if (doc.extraTruncated) {
    rows += `<tr><td colspan="2" class="muted">Pokazano pierwsze ${doc.extra.length} pól — pozostałe dane są w pliku XML.</td></tr>`
  }
  return section('Pozostałe dane z pliku XML',
    `<p class="muted">Pola faktury nieujęte w układzie powyżej (nazwy techniczne ze schematu).</p>`
    + `<table><thead><tr><th>Pole</th><th>Wartość</th></tr></thead><tbody>${rows}</tbody></table>`)
}

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#eceef1;color:#1a1d21;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.doc{max-width:820px;margin:16px auto;padding:36px 40px;background:#fff;border:1px solid #d5d9df;overflow-wrap:anywhere}
h1,h2,h3,p,dl,dd,dt{margin:0}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:12px;border-bottom:2px solid #1a1d21}
.doctype{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#555d68}
.docno{font-size:22px;font-weight:700;line-height:1.2;margin-top:2px}
.head-side{text-align:right;flex:0 1 46%}
.ksefno{font-size:12px;font-weight:600}
.schema{font-size:10px;color:#6b7380;margin-top:2px}
.chip{display:inline-block;margin-left:6px;padding:1px 7px;border:1px solid #c5cad2;border-radius:10px;font-size:10px;letter-spacing:0;text-transform:none;font-weight:500}
.lbl,dt{color:#555d68}
.head-side .lbl,.facts dt{font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.facts{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:12px}
.facts dd{font-weight:600}
.kv>div{display:flex;gap:10px;padding:2px 0}
.kv dt{flex:0 0 34%;max-width:230px}
.kv dd{flex:1 1 0;min-width:0;font-weight:500}
section{margin-top:20px}
h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555d68;padding-bottom:3px;margin-bottom:8px;border-bottom:1px solid #c5cad2;break-after:avoid;page-break-after:avoid}
h3{font-size:12px;font-weight:700;margin:10px 0 4px;break-after:avoid;page-break-after:avoid}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:18px 28px;margin-top:20px}
section .parties{margin-top:10px}
.party{break-inside:avoid;page-break-inside:avoid;min-width:0}
.party .name{font-size:13px;font-weight:700;margin-bottom:2px}
.addr{margin-top:2px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-top:4px}
thead{display:table-header-group}
tfoot{display:table-row-group}
tr{break-inside:avoid;page-break-inside:avoid}
th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;color:#3f4650;text-align:left;vertical-align:bottom;padding:5px 6px;border-bottom:1.5px solid #1a1d21;overflow-wrap:normal}
td{padding:5px 6px;vertical-align:top;border-bottom:1px solid #dfe2e7}
tfoot td,tr.strong td{font-weight:700;border-bottom:0;border-top:1.5px solid #1a1d21}
tr.strong td{border-top:1px solid #9aa1ab}
.num{text-align:right;white-space:nowrap}
table.dense th.num{white-space:normal}
.nw{white-space:nowrap}
.c-lp{width:1%;white-space:nowrap}
td.c-name{min-width:150px}
.c-unit{overflow-wrap:normal}
.sub{font-size:10px;color:#6b7380;margin-top:1px}
.sub-inline{font-size:9.5px;color:#6b7380}
.tag{display:inline-block;padding:0 5px;border:1px solid #9aa1ab;border-radius:3px;font-size:9.5px;font-style:normal;color:#3f4650;white-space:nowrap}
tr.before td{color:#6b7380;font-style:italic}
table.vat,table.narrow{width:auto;min-width:58%;margin-left:auto}
.total{display:flex;justify-content:flex-end;align-items:baseline;gap:18px;margin-top:12px;padding-top:8px;border-top:2px solid #1a1d21;break-inside:avoid;page-break-inside:avoid}
.total span{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#555d68}
.total strong{font-size:20px;font-weight:700;white-space:nowrap}
.account{margin-top:6px;break-inside:avoid;page-break-inside:avoid}
.notes{margin:0;padding-left:18px}
.notes li{padding:1px 0}
.muted{color:#6b7380}
.right{text-align:right}
.pre{white-space:pre-line}
.path{color:#555d68;width:38%}
.source{margin-top:26px;padding-top:8px;border-top:1px solid #c5cad2;font-size:10px;color:#6b7380}
@page{size:A4;margin:12mm}
@media (max-width:640px){.doc{margin:0;border:0;padding:20px 16px}section{overflow-x:auto}td.c-name{min-width:110px}.parties{grid-template-columns:1fr}.head{flex-direction:column;align-items:flex-start}.head-side{text-align:left;flex-basis:auto}}
@media print{body{background:#fff;font-size:11px}.doc{max-width:none;margin:0;padding:0;border:0}.noprint{display:none}.parties{grid-template-columns:1fr 1fr}}
`.trim()

/** Tytuł dokumentu (przeglądarka proponuje go jako nazwę pliku PDF). */
export function ksefInvoiceTitle(doc: KsefInvoiceDoc, meta?: KsefDocMeta | null): string {
  const base = doc.type.startsWith('KOR') ? 'Faktura korygująca' : doc.type === 'ZAL' ? 'Faktura zaliczkowa' : 'Faktura'
  const nr = stripBidi(doc.number || clean(meta?.ksefNumber)).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 120)
  return nr ? `${base} ${nr}` : base
}

export function renderKsefInvoiceHtml(doc: KsefInvoiceDoc, meta?: KsefDocMeta | null): string {
  const ksefNumber = clean(meta?.ksefNumber)
  const title = ksefInvoiceTitle(doc, meta)

  const mainParties = [partyHtml('Sprzedawca', doc.seller), partyHtml('Nabywca', doc.buyer)].filter(Boolean).join('')
  const otherParties = [
    ...doc.otherParties.map(p => partyHtml(p.role ? `Inny podmiot — ${p.role}` : 'Inny podmiot', p)),
    partyHtml(doc.authorized?.role ? `Podmiot upoważniony — ${doc.authorized.role}` : 'Podmiot upoważniony', doc.authorized),
  ].filter(Boolean).join('')

  const orderBody = linesTable(doc.orderLines)
    + (doc.orderValue ? `<div class="right"><span class="lbl">Wartość zamówienia / umowy:</span> <b class="nw">${esc(money(doc.orderValue, doc.currency))}</b></div>` : '')

  const source = 'Wizualizacja faktury ustrukturyzowanej wygenerowana z pliku XML pobranego z KSeF. '
    + (ksefNumber ? 'Dokumentem źródłowym jest faktura w KSeF (numer KSeF powyżej).' : 'Dokumentem źródłowym jest faktura w KSeF.')
  const generated = [
    doc.generatedAt ? `Data wytworzenia faktury: ${fmtDate(doc.generatedAt)}` : '',
    doc.systemInfo ? `System wystawcy: ${doc.systemInfo}` : '',
  ].filter(Boolean).join(' · ')

  const body = [
    headerHtml(doc, ksefNumber, clean(meta?.direction)),
    mainParties ? `<div class="parties">${mainParties}</div>` : '',
    otherParties ? `<div class="parties">${otherParties}</div>` : '',
    correctionHtml(doc),
    section('Pozycje', linesTable(doc.lines, doc.type === 'ZAL' || doc.type === 'KOR_ZAL')),
    section('Zamówienie / umowa', orderBody),
    doc.vatRows.length || doc.total || doc.fxRateAdvance ? vatSummaryHtml(doc) : '',
    advancesHtml(doc),
    settlementHtml(doc),
    paymentHtml(doc),
    section('Adnotacje', doc.annotations.length ? `<ul class="notes">${doc.annotations.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''),
    termsHtml(doc),
    additionalHtml(doc),
    attachmentHtml(doc),
    footerHtml(doc),
    extrasHtml(doc),
    `<footer class="source">${esc(source)}${generated ? `<br>${esc(generated)}` : ''}</footer>`,
  ].filter(Boolean).join('\n')

  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<main class="doc">
${body}
</main>
</body>
</html>
`
}

// ═════════════════════════════════════════════════════════════════════════════
// D) XML → { html, title }
// ═════════════════════════════════════════════════════════════════════════════

/** Prawdziwa faktura (KSeF: do 3 MB XML) daje najwyżej kilka MB HTML; więcej oznacza plik spreparowany. */
const MAX_HTML_LENGTH = 10 * 1024 * 1024

export function buildKsefInvoiceHtml(xml: string, meta?: KsefDocMeta | null): { html: string; title: string } {
  const doc = parseKsefInvoice(xml)
  const html = renderKsefInvoiceHtml(doc, meta)
  if (html.length > MAX_HTML_LENGTH) {
    // nie wysyłamy dalej (JSON podwoiłby zużycie pamięci) — trasa odpowie 422, a użytkownik może pobrać XML
    throw new KsefDocumentError('Faktura jest zbyt obszerna, aby zbudować jej podgląd.')
  }
  return { html, title: ksefInvoiceTitle(doc, meta) }
}
