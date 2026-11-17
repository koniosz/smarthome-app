/**
 * Parser wyciągów bankowych MT940 (mBank / standard SWIFT).
 *
 * - `parseMT940(content)` — zgodność wsteczna: zwraca same transakcje.
 * - `parseMT940Statements(content)` — transakcje + salda otwarcia/zamknięcia
 *   każdego wyciągu (jeden plik może zawierać wiele wyciągów — bloki od `:20:`).
 *
 * Szczegóły przelewu (pole `:86:`):
 * - transakcja może mieć KILKA pól `:86:` pod rząd (mBank: pierwsze to sam kod operacji,
 *   drugie — właściwa treść z subpolami `~NN`); czytamy wszystkie, aż do następnego `:61:`/`:62x:`.
 * - treść strukturalna (`<kod><separator>NN…`, separator `~`, `?`, `<` lub `^`) jest rozkładana na
 *   tytuł, kontrahenta, rachunek i adres — `description` to CZYSTY tytuł, bez znaczników subpól.
 * - treść niestrukturalna (inne banki) — jak dotąd: cały tekst, kontrahent z `/NAME/` lub pierwszej linii.
 */
export interface ParsedTransaction {
  date: string          // ISO YYYY-MM-DD
  amount: number        // positive = credit, negative = debit
  is_reversal: boolean  // RC/RD — storno (zwrot wcześniejszej transakcji), nie zwykła płatność
  description: string   // CZYSTY tytuł (bez znaczników „~NN", pojedyncze spacje); :86: niestrukturalne — cały tekst
  counterparty: string  // nazwa kontrahenta lub '' — NIGDY sam kod operacji
  counterparty_iban: string  // wielkie litery, bez spacji; '' gdy wyciąg podaje tylko prefiks kraju
  reference: string     // referencja banku z :61: (po „//", a gdy jej brak — referencja klienta po kodzie typu); '' dla NONREF
  currency?: string     // waluta wyciągu (z :60F:/:60M:, fallback :25:), np. PLN
  account?: string      // rachunek z :25: (znormalizowany: same cyfry/litery)
  op_code?: string      // kod operacji banku z :86: (np. '152', 'D95'); '' gdy :86: niestrukturalne
  op_label?: string     // etykieta operacji z subpola 00 bez prefiksu „B<kod>" (np. 'PRZELEW ZEWNĘTRZNY WYCH')
  counterparty_address?: string  // adres kontrahenta (subpola 60–63)
  raw?: string          // surowa treść :86: (maks. 2000 znaków) — diagnostyka
  legacy_description?: string    // DOKŁADNIE to, co parser sprzed poprawki zwracał jako opis (mBank: sam kod operacji) — tylko do odnajdywania starych wierszy
}

export interface StatementBalance {
  account: string       // z :25:, znormalizowany (bez spacji, bez prefiksu „/")
  currency: string
  date: string          // YYYY-MM-DD — data salda zamknięcia (:62F:/:62M:)
  opening: number       // :60F:/:60M: (D = ujemne)
  closing: number       // :62F:/:62M: (D = ujemne)
  statement_no: string  // :28C:
}

export interface ParsedStatements {
  transactions: ParsedTransaction[]
  balances: StatementBalance[]
}

// ── Pomocnicze ────────────────────────────────────────────────────────────────

/** Numer rachunku z :25: → same cyfry/litery (bez „/", spacji, myślników), wielkie litery. */
export function normalizeAccount(raw: string): string {
  return String(raw ?? '').trim().replace(/^\/+/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function yymmddToIso(yymmdd: string): string {
  const year = 2000 + parseInt(yymmdd.slice(0, 2), 10)
  return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
}

/** Kwota MT940 „12345,67" → 12345.67 (przecinek dziesiętny, bez separatora tysięcy). */
function parseAmount(raw: string): number {
  const n = parseFloat(raw.replace(/\s/g, '').replace(',', '.'))
  return isNaN(n) ? 0 : n
}

/**
 * Pole salda `:60F:`/`:60M:`/`:62F:`/`:62M:` ma format `[CD]YYMMDD<CUR><kwota,gr>`,
 * np. `C240115PLN16734,56`. D = saldo ujemne (debetowe).
 */
export function parseBalanceField(body: string): { date: string; currency: string; amount: number } | null {
  const m = String(body ?? '').trim().match(/^([CD])(\d{6})([A-Za-z]{3})([\d,\.]+)/)
  if (!m) return null
  const sign = m[1] === 'D' ? -1 : 1
  return { date: yymmddToIso(m[2]), currency: m[3].toUpperCase(), amount: sign * parseAmount(m[4]) }
}

/** Pojedyncze spacje, bez białych znaków na brzegach. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// ── Linia :61: ────────────────────────────────────────────────────────────────

/**
 * `:61:` wg SWIFT: YYMMDD [MMDD] znak(C|D|RC|RD) [litera waluty] kwota, typ(1 litera + 3 znaki)
 * referencja klienta [//referencja banku]. Np. `2401150115D1000,00NTRFNONREF//REF123`,
 * mBank: `2609010901D140,64SC2207312345678` (bez „//" — 11-cyfrowa referencja banku po kodzie typu).
 * Kolejność alternatywy ma znaczenie: „RC1000,00" to storno uznania, a „CR1000,00" to uznanie
 * z literą waluty R (EUR) — znak storna zawsze zaczyna się od R.
 */
const LINE61_RE = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+(?:[.,]\d*)?)(.*)$/
/** Kod typu transakcji: litera (S/N/F) + 3 znaki, np. `NTRF`, `S152`, `SC22`. */
const TX_TYPE_RE = /^[A-Z][A-Z0-9]{3}/
/** Referencje, które nie identyfikują transakcji (bank nie nadał numeru). */
const NON_REFERENCES = new Set(['', 'NONREF', 'NOTPROVIDED'])

function meaningfulRef(raw: string): string {
  const r = raw.trim()
  return NON_REFERENCES.has(r.toUpperCase()) ? '' : r
}

/** Referencja z reszty linii :61: (po kwocie): bankowa po „//", w jej braku — klienta po kodzie typu. */
function parseReference(afterAmount: string): string {
  const rest = afterAmount.replace(TX_TYPE_RE, '')
  const sep = rest.indexOf('//')
  const customer = sep >= 0 ? rest.slice(0, sep) : rest
  const bank = sep >= 0 ? rest.slice(sep + 2) : ''
  return (meaningfulRef(bank) || meaningfulRef(customer)).slice(0, 100)
}

// ── Pola :86: ─────────────────────────────────────────────────────────────────

const TAG_RE = /^:([0-9A-Z]{2,3}):/
/** Tagi kończące bieżącą transakcję (następna transakcja, salda, nagłówek kolejnego wyciągu). */
const TX_END_TAG_RE = /^(20|21|25|28C?|60[FM]?|61|62[FM]?|64|65)$/
/** Koniec komunikatu SWIFT („-" / „-}") albo nagłówek koperty następnego („{1:…"). */
const ENVELOPE_RE = /^(-$|-\}|\{\d:)/

/**
 * Zbiera WSZYSTKIE pola :86: transakcji (surowe linie, bez przycinania — spacje dopełniające
 * są istotne przy sklejaniu subpól). `start` = pierwsza linia po `:61:`. Linie kontynuacji `:61:`
 * (supplementary details) i pola o nieznanych tagach są pomijane.
 */
function collectFields86(lines: string[], start: number): { fields: string[][]; next: number } {
  const fields: string[][] = []
  let current: string[] | null = null
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i]
    const tag = TAG_RE.exec(line)
    if (tag) {
      if (tag[1] === '86') {
        current = [line.slice(4)]
        fields.push(current)
        continue
      }
      if (TX_END_TAG_RE.test(tag[1])) break
      current = null // nieznany tag — pomijamy razem z jego liniami kontynuacji
      continue
    }
    if (ENVELOPE_RE.test(line.trim())) { current = null; continue }
    if (current) current.push(line)
  }
  return { fields, next: i }
}

/**
 * Opis DOKŁADNIE taki, jaki zwracał parser sprzed poprawki: pierwsze pole :86: (treść przycięta)
 * + kolejne linie aż do następnego tagu `:NN:` (każda przycięta, „-" pominięte), sklejone spacją.
 * Dla mBanku to sam kod operacji (drugie `:86:` było gubione). Nie zmieniać — po tym opisie
 * odnajdujemy wiersze zapisane przez stary import.
 */
function legacyDescription(lines: string[], start: number): string {
  let i = start
  while (i < lines.length && !lines[i].startsWith(':')) i++
  if (i >= lines.length || !lines[i].startsWith(':86:')) return ''
  const parts: string[] = [lines[i].slice(4).trim()]
  i++
  while (i < lines.length && !lines[i].match(/^:\d{2}[A-Z]?:/)) {
    const t = lines[i].trim()
    if (t && t !== '-') parts.push(t)
    i++
  }
  return parts.join(' ')
}

/**
 * Treść strukturalna: opcjonalny 3-znakowy kod operacji, separator i dwie cyfry numeru subpola,
 * np. `152~00B152PRZELEW…` (mBank, ING), `166?00GUTSCHRIFT?20…` (styl SWIFT/niemiecki), `020<00…`, `020^00…`.
 */
const STRUCTURED_RE = /^\s*([A-Z0-9]{3})?([~?<^])\d{2}/
/** Samotny kod operacji (pierwsze :86: mBanku), np. `152`, `C22`, `90A`. */
const BARE_CODE_RE = /^[A-Z0-9]{3}$/
/** Szerokość kawałka tytułu / nazwy w subpolach (mBank, standard niemiecki). */
const CHUNK_LEN = 27
const IBAN_LIKE_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/
const NRB_RE = /^\d{26}$/

interface Subfield { code: string; text: string }

/** Rozkłada treść strukturalną na subpola NN → tekst (w kolejności wystąpienia; subpole może się powtarzać). */
function splitSubfields(content: string): { code: string; subfields: Subfield[] } | null {
  const head = STRUCTURED_RE.exec(content)
  if (!head) return null
  const sep = head[2]
  const body = content.slice(content.indexOf(sep))
  const re = new RegExp(`\\${sep}(\\d{2})`, 'g')
  const subfields: Subfield[] = []
  let last: Subfield | null = null
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    if (last) last.text = body.slice(pos, m.index)
    last = { code: m[1], text: '' }
    subfields.push(last)
    pos = m.index + m[0].length
  }
  if (last) last.text = body.slice(pos)
  return { code: head[1] ?? '', subfields }
}

/**
 * Skleja kawałki tytułu / nazwy: kawałek o długości dokładnie 27 znaków (surowy, nieprzycięty) łączy się
 * BEZPOŚREDNIO z następnym — bank pociął tekst w środku słowa albo dopełnił go spacjami; krótszy kawałek
 * kończy fragment, więc dostaje spację. Na koniec wielokrotne spacje → jedna.
 */
function joinChunks(chunks: string[]): string {
  let out = ''
  for (const c of chunks) out += c.length === CHUNK_LEN ? c : `${c} `
  return collapse(out)
}

function compactUpper(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase()
}

/** Rachunek z subpola → IBAN: 26 cyfr (NRB) dostaje prefiks PL, pełny IBAN zostaje; inaczej ''. */
function accountToIban(compact: string): string {
  if (NRB_RE.test(compact)) return `PL${compact}`
  return IBAN_LIKE_RE.test(compact) ? compact : ''
}

interface Details86 {
  description: string
  counterparty: string
  counterparty_iban: string
  op_code: string
  op_label: string
  counterparty_address: string
}

/** Treść strukturalna (przynajmniej jedno pole :86: z subpolami). */
function parseStructured(parsed: Array<{ code: string; subfields: Subfield[] }>, freeTexts: string[]): Details86 {
  // Kod operacji: z pola strukturalnego, a gdy go tam nie ma — z samotnego kodu w osobnym :86:
  const bareCodes = freeTexts.map(t => t.trim()).filter(t => BARE_CODE_RE.test(t))
  const opCode = (parsed.find(p => p.code)?.code ?? bareCodes[0] ?? '').toUpperCase()

  const titleChunks: string[] = []
  const nameChunks: string[] = []
  const addressChunks: string[] = []
  let label = ''
  let acc29 = ''
  let acc31 = ''
  let iban38 = ''

  for (const { subfields } of parsed) {
    for (const { code, text } of subfields) {
      const n = parseInt(code, 10)
      if (n === 0) {
        if (!label) label = collapse(text)
      } else if (n >= 20 && n <= 28) {
        titleChunks.push(text)
      } else if (n === 29) {
        // rachunek kontrahenta (26 cyfr NRB albo pełny IBAN); w innym razie — kolejny kawałek tytułu
        const compact = compactUpper(text)
        if (accountToIban(compact)) { if (!acc29) acc29 = compact } else titleChunks.push(text)
      } else if (n === 31) {
        if (!acc31) acc31 = compactUpper(text)
      } else if (n === 32 || n === 33) {
        nameChunks.push(text)
      } else if (n === 38) {
        if (!iban38) iban38 = compactUpper(text)
      } else if (n >= 60 && n <= 63) {
        addressChunks.push(text)
      }
      // 30 (kod banku), 34 (powtórzony kod operacji) i pozostałe — nie niosą treści dla nas
    }
  }

  // Etykieta operacji bez prefiksu „B<kod>" / „<kod>"
  if (opCode) {
    const upper = label.toUpperCase()
    if (upper.startsWith(`B${opCode}`)) label = label.slice(opCode.length + 1).trim()
    else if (upper.startsWith(opCode)) label = label.slice(opCode.length).trim()
  }

  // Wolny tekst z pozostałych pól :86: (poza samotnym kodem operacji) dopisujemy do tytułu — nic nie gubimy
  const extra = freeTexts.map(collapse).filter(t => t && !BARE_CODE_RE.test(t))
  const description = collapse([joinChunks(titleChunks), ...extra].join(' '))

  let counterparty = joinChunks(nameChunks)
  if (opCode && counterparty.toUpperCase() === opCode) counterparty = ''

  // IBAN: subpole 38 (dłuższe niż sam prefiks kraju), potem rachunek z 29, na końcu z 31
  let iban = ''
  if (iban38.length > 4) {
    // mBank buduje ~38 jako „PL" + ~29 — gdy ~29 ma już prefiks kraju, wychodzi „PLPL…"/„PLDE…"
    const doubled = /^[A-Z]{2}([A-Z]{2}\d{2}[A-Z0-9]{10,30})$/.exec(iban38)
    iban = doubled ? doubled[1] : (NRB_RE.test(iban38) ? `PL${iban38}` : iban38)
  } else {
    iban = accountToIban(acc29) || accountToIban(acc31)
  }

  return {
    description,
    counterparty,
    counterparty_iban: iban,
    op_code: opCode,
    op_label: label,
    counterparty_address: joinChunks(addressChunks),
  }
}

/** Treść niestrukturalna (inne banki) — zachowanie jak dotąd, ale ze WSZYSTKICH pól :86:. */
function parseUnstructured(fields: string[][]): Details86 {
  const descLines: string[] = []
  for (const field of fields) {
    for (const line of field) {
      const t = line.trim()
      if (t) descLines.push(t)
    }
  }
  const description = descLines.join(' ')

  let counterparty = ''
  const nameMatch = description.match(/\/NAME\/([^/]+)/)
  if (nameMatch) {
    counterparty = nameMatch[1].trim()
  } else {
    const firstLine = descLines[0] || ''
    // Pomijamy etykiety ogólne oraz samotny 3-znakowy kod operacji — kod nigdy nie jest kontrahentem
    if (!firstLine.startsWith('Tytułem:') && !firstLine.startsWith('/') && !BARE_CODE_RE.test(firstLine)) {
      counterparty = firstLine.slice(0, 80)
    }
  }

  // IBAN z opisu (polski: PL + 26 cyfr), w jego braku — wzorzec /ACC/
  let iban = ''
  const ibanMatch = description.match(/\bPL\d{26}\b/)
  if (ibanMatch) {
    iban = ibanMatch[0]
  } else {
    const accMatch = description.match(/\/ACC\/([^/\s]+)/)
    if (accMatch) iban = compactUpper(accMatch[1])
  }

  return { description, counterparty, counterparty_iban: iban, op_code: '', op_label: '', counterparty_address: '' }
}

function parseDetails86(fields: string[][]): Details86 {
  const structured: Array<{ code: string; subfields: Subfield[] }> = []
  const freeTexts: string[] = []
  for (const field of fields) {
    // linie kontynuacji bez separatora należą do poprzedniego subpola — sklejamy bez spacji
    const parsed = splitSubfields(field.join(''))
    if (parsed) structured.push(parsed)
    else freeTexts.push(field.map(l => l.trim()).filter(Boolean).join(' '))
  }
  return structured.length ? parseStructured(structured, freeTexts) : parseUnstructured(fields)
}

// ── Transakcje (:61: + :86:) w obrębie listy linii ────────────────────────────
function parseTransactionLines(lines: string[]): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = []

  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith(':61:')) {
      i++
      continue
    }

    const m = LINE61_RE.exec(lines[i].slice(4).trim())
    if (!m) {
      i++
      continue
    }

    // C = uznanie (+), D = obciążenie (−), RD = storno obciążenia (środki WRACAJĄ, +),
    // RC = storno uznania (środki WYCHODZĄ, −) — zgodnie ze specyfikacją SWIFT
    const direction = m[3]
    const amountRaw = parseAmount(m[5])
    const amount = (direction === 'C' || direction === 'RD') ? amountRaw : -amountRaw
    const is_reversal = direction === 'RC' || direction === 'RD'

    const legacy = legacyDescription(lines, i + 1)
    const { fields, next } = collectFields86(lines, i + 1)
    const details = parseDetails86(fields)
    i = next

    transactions.push({
      date: yymmddToIso(m[1]),
      amount,
      is_reversal,
      description: details.description,
      counterparty: details.counterparty,
      counterparty_iban: details.counterparty_iban,
      reference: parseReference(m[6]),
      op_code: details.op_code,
      op_label: details.op_label,
      counterparty_address: details.counterparty_address,
      raw: fields.map(f => f.join('\n')).join('\n').slice(0, 2000),
      legacy_description: legacy,
    })
  }

  return transactions
}

// ── Wyciągi (bloki :20:) ──────────────────────────────────────────────────────

/** Dzieli treść pliku na bloki wyciągów — każdy zaczyna się od `:20:`. Bez `:20:` → jeden blok. */
function splitStatementBlocks(lines: string[]): string[][] {
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (line.startsWith(':20:')) {
      if (current) blocks.push(current)
      current = [line]
    } else {
      if (!current) current = []
      current.push(line)
    }
  }
  if (current && current.length) blocks.push(current)
  return blocks
}

/**
 * Parsuje plik MT940: transakcje (:61:/:86:) + salda otwarcia/zamknięcia (:60x:/:62x:)
 * dla każdego wyciągu w pliku. Transakcje dostają `account` i `currency` swojego wyciągu.
 */
export function parseMT940Statements(content: string): ParsedStatements {
  // Każdy BOM (także w środku — dwa pliki sklejone w jeden) i powtórzone CR (CR CR LF) znikają: inaczej
  // drugi nagłówek „:20:" nie zaczynałby bloku, a 27-znakowy kawałek tytułu miałby 28 znaków i nie skleiłby się.
  const lines = String(content ?? '').replace(/\ufeff/g, '').split(/\r*\n/)
  const transactions: ParsedTransaction[] = []
  const balances: StatementBalance[] = []
  // do uzgodnienia znaku sald: suma ruchu i liczba transakcji każdego wyciągu (równolegle do `balances`)
  const movement: Array<{ sum: number; count: number; hasOpening: boolean }> = []

  for (const block of splitStatementBlocks(lines)) {
    let account = ''
    let statementNo = ''
    let currency = ''
    let opening: { date: string; currency: string; amount: number } | null = null
    let closing: { date: string; currency: string; amount: number } | null = null

    for (const raw of block) {
      const line = raw.trim()
      if (line.startsWith(':25:')) {
        const rawAcc = line.slice(4).trim()
        account = normalizeAccount(rawAcc)
        // niektóre banki dopisują walutę do :25: (np. „…/PLN") — fallback dla waluty
        const curM = rawAcc.match(/(PLN|EUR|USD|GBP|CHF|CZK|SEK|NOK|DKK|HUF)\s*$/i)
        if (curM && !currency) currency = curM[1].toUpperCase()
      } else if (line.startsWith(':28C:') || line.startsWith(':28:')) {
        statementNo = line.slice(line.indexOf(':', 1) + 1).trim()
      } else if (/^:60[FM]:/.test(line)) {
        opening = parseBalanceField(line.slice(5))
        if (opening) currency = opening.currency
      } else if (/^:62[FM]:/.test(line)) {
        closing = parseBalanceField(line.slice(5))
        if (closing) currency = closing.currency
      }
    }

    const cur = currency || 'PLN'
    let blockSum = 0
    let blockCount = 0
    for (const tx of parseTransactionLines(block)) {
      tx.currency = cur
      if (account) tx.account = account
      transactions.push(tx)
      blockSum += tx.amount
      blockCount++
    }

    // Saldo zapisujemy tylko, gdy znamy saldo zamknięcia (data salda = data :62x:)
    if (closing) {
      movement.push({ sum: blockSum, count: blockCount, hasOpening: !!opening })
      balances.push({
        account,
        currency: cur,
        date: closing.date,
        opening: opening ? opening.amount : 0,
        closing: closing.amount,
        statement_no: statementNo,
      })
    }
  }

  reconcileBalanceSigns(balances, movement)
  return { transactions, balances }
}

/**
 * Uzgadnia ZNAK sald z ruchem na wyciągu. Standard mówi: C = saldo dodatnie, D = ujemne (debet) — ale część
 * banków (m.in. mBank w eksporcie MT940) oznacza literą „D" zwykłe, DODATNIE saldo. Zamiast ufać literze,
 * sprawdzamy arytmetykę samego wyciągu: saldo końcowe − saldo początkowe musi równać się sumie transakcji
 * (uznania +, obciążenia −). Jeśli równanie zgadza się dopiero po odwróceniu znaku obu sald — odwracamy.
 * Wyciąg bez ruchu (albo bez salda początkowego) niczego nie rozstrzyga: przejmuje decyzję innego wyciągu
 * tego samego rachunku z tego pliku, a gdy takiego nie ma — zostaje przy literze.
 * (Bez tego kafel „Gotówka" i prognoza pokazywały dla mBanku minus zamiast plusa.)
 */
function reconcileBalanceSigns(
  balances: StatementBalance[],
  movement: Array<{ sum: number; count: number; hasOpening: boolean }>,
): void {
  const EPS = 0.006
  const decision = new Map<string, 'keep' | 'flip' | 'mixed'>()   // per rachunek
  const undecided: number[] = []
  balances.forEach((b, i) => {
    const m = movement[i]
    if (!m || !m.hasOpening || m.count === 0) { undecided.push(i); return }
    const delta = b.closing - b.opening
    const asMarked = Math.abs(delta - m.sum) <= EPS
    const flipped = Math.abs(-delta - m.sum) <= EPS
    if (asMarked === flipped) { undecided.push(i); return }      // brak ruchu netto albo wyciąg niespójny — nie zgadujemy
    const d = flipped ? 'flip' : 'keep'
    if (flipped) { b.opening = -b.opening; b.closing = -b.closing }
    const prev = decision.get(b.account)
    decision.set(b.account, prev && prev !== d ? 'mixed' : d)
  })
  for (const i of undecided) {
    const b = balances[i]
    if (decision.get(b.account) === 'flip') { b.opening = -b.opening; b.closing = -b.closing }
  }
  // −0 → 0 (żeby saldo zerowe nie wychodziło jako „-0")
  for (const b of balances) { if (b.opening === 0) b.opening = 0; if (b.closing === 0) b.closing = 0 }
}

/**
 * Parse an MT940 bank statement file (mBank / standard SWIFT MT940 format).
 * Handles both UTF-8 and ISO-8859-1/Latin-1 encodings (dekodowanie robi wywołujący).
 * Zgodność wsteczna — zwraca same transakcje.
 */
export function parseMT940(content: string): ParsedTransaction[] {
  return parseMT940Statements(content).transactions
}
