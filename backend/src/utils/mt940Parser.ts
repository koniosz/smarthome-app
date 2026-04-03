export interface ParsedTransaction {
  date: string          // ISO YYYY-MM-DD
  amount: number        // positive = credit, negative = debit
  description: string
  counterparty: string
  counterparty_iban: string
  reference: string
}

/**
 * Parse an MT940 bank statement file (mBank / standard SWIFT MT940 format).
 * Handles both UTF-8 and ISO-8859-1/Latin-1 encodings.
 */
export function parseMT940(content: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = []

  // Split into statement blocks (each starts with :20: or :60)
  // We look for :61: (transaction detail) blocks
  const lines = content.split(/\r?\n/)

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
    // Date: YYMMDD (first 6 chars after :61:)
    const body = line61.slice(4) // remove ':61:'

    // Date: first 6 chars = YYMMDD
    const dateRaw = body.slice(0, 6)
    const year  = 2000 + parseInt(dateRaw.slice(0, 2), 10)
    const month = dateRaw.slice(2, 4)
    const day   = dateRaw.slice(4, 6)
    const dateISO = `${year}-${month}-${day}`

    // After date there may be an optional 4-char value date (MMDD) — skip if present
    // The direction indicator (C/D/RD/RC) follows the date (+ optional 4-char value date)
    // Use a regex to extract direction and amount
    const amountMatch = body.match(/^(\d{6})(\d{4})?(C|D|RC|RD)([\d,]+)/)
    if (!amountMatch) {
      i++
      continue
    }

    const direction = amountMatch[3] // C = credit, D = debit, RC = return credit, RD = return debit
    const amountStr = amountMatch[4].replace(',', '.')
    const amountRaw = parseFloat(amountStr)
    const amount    = (direction === 'C' || direction === 'RC') ? amountRaw : -amountRaw

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
      // Collect multi-line :86: content (lines that don't start with :XX:)
      while (i < lines.length && !lines[i].match(/^:\d{2}[A-Z]?:/)) {
        if (lines[i].trim()) descLines.push(lines[i].trim())
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
      description,
      counterparty,
      counterparty_iban,
      reference,
    })
  }

  return transactions
}
