/**
 * Parser wyciągów bankowych MT940 (mBank / standard SWIFT).
 *
 * - `parseMT940(content)` — zgodność wsteczna: zwraca same transakcje.
 * - `parseMT940Statements(content)` — transakcje + salda otwarcia/zamknięcia
 *   każdego wyciągu (jeden plik może zawierać wiele wyciągów — bloki od `:20:`).
 */
export interface ParsedTransaction {
  date: string          // ISO YYYY-MM-DD
  amount: number        // positive = credit, negative = debit
  is_reversal: boolean  // RC/RD — storno (zwrot wcześniejszej transakcji), nie zwykła płatność
  description: string
  counterparty: string
  counterparty_iban: string
  reference: string
  currency?: string     // waluta wyciągu (z :60F:/:60M:, fallback :25:), np. PLN
  account?: string      // rachunek z :25: (znormalizowany: same cyfry/litery)
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

// ── Transakcje (:61: + :86:) w obrębie listy linii ────────────────────────────
function parseTransactionLines(lines: string[]): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = []

  let i = 0
  while (i < lines.length) {
    // Find :61: line
    if (!lines[i].startsWith(':61:')) {
      i++
      continue
    }

    const line61 = lines[i].trim()

    // :61: format: YYMMDDMMDDCAmount[N]TRANSFER_CODE[/BANK_REF[//CLIENT_REF]]
    // e.g. :61:2401150115D1000,00NTRFNONREF//REF123
    const body = line61.slice(4) // remove ':61:'

    // Date: first 6 chars = YYMMDD
    const dateISO = yymmddToIso(body.slice(0, 6))

    // After date there may be an optional 4-char value date (MMDD) — skip if present
    // The direction indicator (C/D/RD/RC) follows the date (+ optional 4-char value date)
    const amountMatch = body.match(/^(\d{6})(\d{4})?(C|D|RC|RD)([\d,]+)/)
    if (!amountMatch) {
      i++
      continue
    }

    // C = uznanie (+), D = obciążenie (−), RD = storno obciążenia (środki WRACAJĄ, +),
    // RC = storno uznania (środki WYCHODZĄ, −) — zgodnie ze specyfikacją SWIFT
    const direction = amountMatch[3]
    const amountRaw = parseAmount(amountMatch[4])
    const amount    = (direction === 'C' || direction === 'RD') ? amountRaw : -amountRaw
    const is_reversal = direction === 'RC' || direction === 'RD'

    // Extract reference: everything after '//' in :61: line
    const refMatch = line61.match(/\/\/(.+)$/)
    const reference = refMatch ? refMatch[1].trim() : ''

    // Move to next lines to collect :86: description block
    i++
    let description = ''
    let counterparty = ''
    let counterparty_iban = ''

    // Collect continuation lines for :61: (lines that don't start with :XX:)
    while (i < lines.length && !lines[i].startsWith(':')) {
      i++
    }

    // Now we should be at :86: or another field
    if (i < lines.length && lines[i].startsWith(':86:')) {
      const descLines: string[] = [lines[i].slice(4).trim()]
      i++
      // Collect multi-line :86: content (lines that don't start with :XX:); „-" kończy komunikat SWIFT
      while (i < lines.length && !lines[i].match(/^:\d{2}[A-Z]?:/)) {
        const t = lines[i].trim()
        if (t && t !== '-') descLines.push(t)
        i++
      }

      description = descLines.join(' ')

      // Try to extract counterparty from /NAME/ pattern
      const nameMatch = description.match(/\/NAME\/([^/]+)/)
      if (nameMatch) {
        counterparty = nameMatch[1].trim()
      } else {
        // Take first meaningful line as counterparty
        const firstLine = descLines[0] || ''
        // Skip if it looks like a generic label
        if (!firstLine.startsWith('Tytułem:') && !firstLine.startsWith('/')) {
          counterparty = firstLine.slice(0, 80)
        }
      }

      // Try to extract IBAN from description (Polish IBAN: PL + 26 digits)
      const ibanMatch = description.match(/\bPL\d{26}\b/)
      if (ibanMatch) {
        counterparty_iban = ibanMatch[0]
      } else {
        // Try to find /ACC/ pattern for account number
        const accMatch = description.match(/\/ACC\/([^/\s]+)/)
        if (accMatch) counterparty_iban = accMatch[1].trim()
      }
    }

    transactions.push({
      date: dateISO,
      amount,
      is_reversal,
      description,
      counterparty,
      counterparty_iban,
      reference,
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
  const lines = String(content ?? '').replace(/^\ufeff/, '').split(/\r?\n/)
  const transactions: ParsedTransaction[] = []
  const balances: StatementBalance[] = []

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
    for (const tx of parseTransactionLines(block)) {
      tx.currency = cur
      if (account) tx.account = account
      transactions.push(tx)
    }

    // Saldo zapisujemy tylko, gdy znamy saldo zamknięcia (data salda = data :62x:)
    if (closing) {
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

  return { transactions, balances }
}

/**
 * Parse an MT940 bank statement file (mBank / standard SWIFT MT940 format).
 * Handles both UTF-8 and ISO-8859-1/Latin-1 encodings (dekodowanie robi wywołujący).
 * Zgodność wsteczna — zwraca same transakcje.
 */
export function parseMT940(content: string): ParsedTransaction[] {
  return parseMT940Statements(content).transactions
}
