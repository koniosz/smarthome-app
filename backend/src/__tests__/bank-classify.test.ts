/**
 * Klasyfikator przelewów z wyciągu (services/bank-classify.ts) — czysty moduł, bez bazy.
 * Dane w testach są SYNTETYCZNE (zmyślone nazwy, NIP-y, numery rachunków); układ pól jak w MT940 mBanku:
 * kod operacji + nazwa operacji (subpole ~00), tytuł (~20–25), kontrahent (~32–33), IBAN (~38).
 *
 * Najważniejsze pułapki:
 *  - D96 / D41 (przelew własny z rachunku VAT) niesie tytuł właściwego przelewu do ZUS / US —
 *    liczony jako ZUS / podatek dublowałby koszt;
 *  - D52 (split payment do dostawcy) to PRAWDZIWA płatność za fakturę, nie przelew wewnętrzny;
 *  - „opłacenie", „premium", „pensjonat", wypłata gotówki — to nie wynagrodzenia;
 *  - BOLTON / EXPORT / NEONET / RENDERING — to nie Bolt / Expo / Neon / Render.
 *
 * Uruchomienie: cd backend && DATABASE_URL="postgresql://x:x@localhost:1/x" npx tsx --test src/__tests__/bank-classify.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyBankTransfer, parseTaxTitle, parseZusPeriod, parseSalaryPeriod, normalizeIban, normalizeText,
  matchForeignVendor, isNotInvoicePayment, buildAutoNote,
  KIND_LABELS, KIND_TARGETS, PAYROLL_SUBCATEGORIES, AUTO_NOTE_PREFIX, FOREIGN_VENDORS,
  type BankKind, type ClassifyInput, type ClassifyContext,
} from '../services/bank-classify'
import { MANUAL_SUBCATEGORIES } from '../routes/manual-costs'

// ── Dane syntetyczne ──────────────────────────────────────────────────────────
const ZUS_IBAN  = 'PL83600000020260001234567890'   // kk 6000 0002 026x … — rachunek składkowy
const TAX_IBAN  = 'PL06101000712223521000000000'   // kk 1010 0071 222x … — mikrorachunek podatkowy
const OWN_MAIN  = 'PL11114020040000300212345678'
const OWN_VAT   = 'PL22114020040000300212345679'
const PL_IBAN   = 'PL61109010140000071219812874'   // zwykły polski rachunek dostawcy / pracownika
const DE_IBAN   = 'DE89370400440532013000'
const NO_IBAN   = 'NO9386011117947'
const GB_IBAN   = 'GB29NWBK60161331926819'
const TR_IBAN   = 'TR330006100519786457841326'
const CTX: ClassifyContext = {
  ownAccounts: [`/${OWN_MAIN}`, 'PL22 1140 2004 0000 3002 1234 5679'],
  employeeNames: ['Kowalski Jan', 'Żółć Anna-Maria', 'Cher'],
}

const tx = (p: Partial<ClassifyInput>): ClassifyInput => ({
  date: '2026-10-01', amount: -1000, description: '', counterparty: '', counterparty_iban: '',
  op_code: '152', op_label: 'PRZELEW ZEWNĘTRZNY WYCH', currency: 'PLN', ...p,
})
const cls = (p: Partial<ClassifyInput>, ctx: ClassifyContext = CTX) => classifyBankTransfer(tx(p), ctx)
const kind = (p: Partial<ClassifyInput>, ctx: ClassifyContext = CTX): BankKind => cls(p, ctx).kind
const target = (p: Partial<ClassifyInput>, ctx: ClassifyContext = CTX) => {
  const c = cls(p, ctx)
  return `${c.kind}:${c.cost_category}/${c.subcategory}/${c.pnl_mode}`
}

// ── Kontrakt: etykiety, stałe, taksonomia ─────────────────────────────────────

test('etykiety, stałe i mapowanie rodzaj → kategoria / podkategoria / tryb RZiS (kontrakt)', () => {
  assert.deepEqual(KIND_LABELS, {
    zus: 'ZUS',
    tax_pit4: 'PIT-4 (podatek od wynagrodzeń)',
    tax_cit: 'Podatek dochodowy',
    tax_vat: 'VAT',
    tax_other: 'Inny podatek / opłata urzędowa',
    salary: 'Wynagrodzenie',
    bank_fee: 'Opłata bankowa',
    interest: 'Odsetki bankowe',
    internal: 'Przelew własny / rachunek VAT',
    foreign_vendor: 'Dostawca zagraniczny (bez KSeF)',
    foreign_transfer: 'Przelew zagraniczny',
    unknown: 'Nierozpoznany',
  })
  assert.deepEqual(PAYROLL_SUBCATEGORIES, ['salary_gross', 'salary_admin', 'salary_civil', 'salary_pit', 'zus_employer'])
  assert.equal(AUTO_NOTE_PREFIX, 'rozpoznano: ')
  const t = (k: BankKind) => `${KIND_TARGETS[k].cost_category}/${KIND_TARGETS[k].subcategory}/${KIND_TARGETS[k].pnl_mode}`
  assert.equal(t('zus'), 'ga/zus_employer/auto')
  assert.equal(t('tax_pit4'), 'ga/salary_pit/auto')
  assert.equal(t('salary'), 'ga/salary_gross/auto')
  assert.equal(t('tax_cit'), 'financial/tax_income/auto')
  assert.equal(t('tax_vat'), 'financial/tax_vat/auto')
  assert.equal(t('tax_other'), 'financial/tax_other/auto')
  assert.equal(t('bank_fee'), 'financial/bank_fee/auto')
  assert.equal(t('interest'), 'financial/interest/auto')
  assert.equal(t('internal'), 'financial/internal_transfer/exclude')
  assert.equal(KIND_TARGETS.foreign_vendor.pnl_mode, 'include')
  assert.equal(t('foreign_transfer'), 'cogs/hardware_eu/include')
  assert.equal(t('unknown'), 'ga/other/auto')
})

test('każda emitowana kategoria/podkategoria istnieje w taksonomii kosztów (+ nowe klucze kontraktu)', () => {
  // MANUAL_SUBCATEGORIES (backend) + klucze spoza niej: sales/marketing (COST_TAXONOMY w ksef.ts i
  // frontend costTaxonomy.ts) oraz nowe klucze z kontraktu: ga/salary_pit, financial/internal_transfer.
  const known = new Set<string>(['sales/marketing', 'ga/salary_pit', 'financial/internal_transfer'])
  for (const [cat, subs] of Object.entries(MANUAL_SUBCATEGORIES)) for (const sub of Object.keys(subs)) known.add(`${cat}/${sub}`)
  for (const [k, t] of Object.entries(KIND_TARGETS)) assert.ok(known.has(`${t.cost_category}/${t.subcategory}`), `rodzaj ${k}: ${t.cost_category}/${t.subcategory}`)
  for (const v of FOREIGN_VENDORS) assert.ok(known.has(`${v.cost_category}/${v.subcategory}`), `dostawca ${v.key}: ${v.cost_category}/${v.subcategory}`)
  assert.ok(known.has('cogs/hardware_noneu'))
  assert.equal(new Set(FOREIGN_VENDORS.map(v => v.key)).size, FOREIGN_VENDORS.length, 'klucze dostawców są unikalne')
})

test('isNotInvoicePayment / buildAutoNote / normalizeIban / normalizeText', () => {
  for (const k of ['internal', 'zus', 'tax_pit4', 'tax_cit', 'tax_vat', 'tax_other', 'bank_fee', 'interest', 'salary']) {
    assert.equal(isNotInvoicePayment(k), true, k)
  }
  for (const k of ['foreign_vendor', 'foreign_transfer', 'unknown', '', null, undefined]) assert.equal(isNotInvoicePayment(k), false, String(k))

  const zus = cls({ op_code: '153', op_label: 'PRZELEW ZEWNĘTRZNY DO ZUS', counterparty_iban: ZUS_IBAN, description: 'DRA 01.09.2026 R.', date: '2026-10-15' })
  assert.equal(buildAutoNote(zus), `rozpoznano: ZUS — ${zus.reason}`)
  assert.ok(buildAutoNote(zus).startsWith(AUTO_NOTE_PREFIX))
  assert.equal(buildAutoNote(cls({ description: 'FV 12/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.' })), '', 'nierozpoznany → bez notatki')

  assert.equal(normalizeIban(' pl11 1140-2004 0000 3002 1234 5678 '), OWN_MAIN)
  assert.equal(normalizeIban('/de89 3704 0044 0532 0130 00'), DE_IBAN)
  assert.equal(normalizeIban(null), '')
  assert.equal(normalizeText('  ZAKŁAD   Ubezpieczeń\tSPOŁECZNYCH — Łódź '), 'zaklad ubezpieczen spolecznych — lodz')
})

test('każdy wynik niesie etykietę, niepuste uzasadnienie i business_unit = shared', () => {
  const samples: Partial<ClassifyInput>[] = [
    { op_code: '295', op_label: 'PRZELEW WŁASNY' },
    { op_code: '153', op_label: 'PRZELEW ZEWNĘTRZNY DO ZUS' },
    { op_code: '210', op_label: 'PRZELEW PODATKOWY', description: 'N5210000000 26M09 PIT-4' },
    { op_code: '776', op_label: 'OPŁATA ZA PRZELEW' },
    { description: 'WYNAGRODZENIE 9/2026', counterparty: 'JAN TESTOWY' },
    { op_code: '114', op_label: 'ZAKUP PRZY UŻYCIU KARTY', description: 'OPENAI *CHATGPT SUB/OPENAI.COM' },
    { op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', counterparty: 'MUSTER TECHNIK GMBH', counterparty_iban: DE_IBAN },
    { description: 'FV 1/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.' },
  ]
  for (const s of samples) {
    const c = cls(s)
    assert.equal(c.label, KIND_LABELS[c.kind])
    assert.equal(c.business_unit, 'shared')
    assert.ok(c.reason.length > 10, `${c.kind}: uzasadnienie`)
    assert.equal(c.not_invoice_payment, isNotInvoicePayment(c.kind))
  }
})

// ── 1. Przelew własny / rachunek VAT / wymiana walut ──────────────────────────

test('internal: kody 295 / D95 / D96 / D41 / A60 (+ uznania D93 / D94 / D40 / A61) → poza RZiS, nigdy płatność za fakturę', () => {
  const expected = 'internal:financial/internal_transfer/exclude'
  assert.equal(target({ op_code: '295', op_label: 'PRZELEW WŁASNY', counterparty: 'FIRMA TESTOWA SP. Z O.O.', counterparty_iban: OWN_VAT }), expected)
  assert.equal(target({ op_code: 'D95', op_label: 'PP/PRZELEW VAT WYCHODZĄ', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'FV 12/2026' }), expected)
  assert.equal(target({ op_code: 'A60', op_label: 'OBCIĄŻ. NATYCH. TRANSAK', amount: -43000 }), expected)
  for (const op of ['D93', 'D94', 'D40', 'A61']) {
    const c = cls({ op_code: op, op_label: op === 'A61' ? 'UZNANIE NATYCH. TRANSAK' : 'PP/PRZELEW VAT PRZYCH.', amount: 500 })
    assert.equal(c.kind, 'internal', op)
  }
  const c = cls({ op_code: 'D95', op_label: 'PP/PRZELEW VAT WYCHODZĄCY', description: 'FV 12/2026' })
  assert.equal(c.not_invoice_payment, true)
  assert.equal(c.period, null)
  assert.match(c.reason, /rachunku VAT/)
  assert.match(cls({ op_code: 'A60', op_label: 'OBCIĄŻ. NATYCH. TRANSAK' }).reason, /wymiany walut/)
})

test('internal: sama nazwa operacji (bez znanego kodu) — przelew własny, PP/przelew VAT, natychmiastowa transakcja, wymiana walut', () => {
  for (const label of ['PRZELEW WŁASNY', 'PP/PRZELEW VAT WYCH. WŁ', 'PP/PRZELEW VAT PRZYCHOD', 'OBCIĄŻ. NATYCH. TRANSAK', 'UZNANIE NATYCH. TRANSAK', 'WYMIANA WALUT', 'KUPNO WALUT', 'SPRZEDAŻ WALUT']) {
    assert.equal(kind({ op_code: 'X99', op_label: label }), 'internal', label)
    assert.equal(kind({ op_code: '', op_label: label }), 'internal', `${label} (bez kodu)`)
  }
})

test('PUŁAPKA: D96 / D41 z tytułem przelewu do ZUS / US to przelew własny z rachunku VAT — NIE ZUS i NIE podatek', () => {
  const d96 = cls({ op_code: 'D96', op_label: 'PP/PRZELEW VAT WYCH. WŁ', description: 'WPŁATA DO ZUS', amount: -9876.54 })
  assert.equal(d96.kind, 'internal')
  assert.equal(d96.pnl_mode, 'exclude')
  assert.equal(kind({ op_code: 'D96', op_label: 'PP/PRZELEW VAT WYCH. WŁ', description: 'DEKLARACJA: DRA 01.09.2026 R.' }), 'internal')
  // D41 niesie tytuł, kontrahenta i mikrorachunek właściwego przelewu podatkowego — nadal przelew własny
  const d41 = cls({ op_code: 'D41', op_label: 'PP/PRZELEW VAT WYCH. WŁ', description: 'N5210000000 26M09 PIT-4', counterparty: 'URZĄD SKARBOWY', counterparty_iban: TAX_IBAN, amount: -1500 })
  assert.equal(d41.kind, 'internal')
  assert.equal(d41.subcategory, 'internal_transfer')
  assert.equal(kind({ op_code: 'D41', op_label: 'PP/PRZELEW VAT WYCH. WŁ', description: 'N5210000000 26M09 VAT-7', counterparty_iban: TAX_IBAN }), 'internal')
  assert.equal(kind({ op_code: 'D41', op_label: 'PP/PRZELEW VAT WYCH. WŁ', description: 'WPŁATA DO ZUS', counterparty: 'ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH', counterparty_iban: ZUS_IBAN }), 'internal')
  // właściwe przelewy (153 / 210) z tym samym tytułem są liczone
  assert.equal(kind({ op_code: '153', op_label: 'PRZELEW ZEWNĘTRZNY DO Z', description: 'WPŁATA DO ZUS', counterparty: 'ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH', counterparty_iban: ZUS_IBAN }), 'zus')
  assert.equal(kind({ op_code: '210', op_label: 'PRZELEW PODATKOWY', description: 'N5210000000 26M09 PIT-4', counterparty: 'URZĄD SKARBOWY', counterparty_iban: TAX_IBAN }), 'tax_pit4')
})

test('D52 (split payment do dostawcy) to prawdziwa płatność za fakturę — NIE przelew wewnętrzny', () => {
  const c = cls({ op_code: 'D52', op_label: 'PP/PRZELEW ZEWNĘTRZNY W', description: 'FV 123/09/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN, amount: -12300 })
  assert.equal(c.kind, 'unknown')
  assert.equal(c.not_invoice_payment, false)
  assert.equal(kind({ op_code: 'D52', op_label: 'PP/PRZELEW ZEWNĘTRZNY WYCH.' }), 'unknown')
  assert.equal(kind({ op_code: 'D50', op_label: 'PP/PRZELEW ZEWNĘTRZNY P', amount: 12300 }), 'unknown', 'wpływ split payment od klienta')
})

test('internal: przelew na własny rachunek rozpoznany po IBAN-ie (26 cyfr, dowolny zapis)', () => {
  const p = { op_code: '169', op_label: 'PRZELEW WEWNĘTRZNY WYCH', counterparty: 'FIRMA TESTOWA SP. Z O.O.', description: 'ZASILENIE' }
  assert.equal(kind({ ...p, counterparty_iban: OWN_VAT }), 'internal')
  assert.equal(kind({ ...p, counterparty_iban: '22 1140 2004 0000 3002 1234 5679' }), 'internal', 'NRB bez prefiksu PL')
  assert.equal(kind({ ...p, counterparty_iban: OWN_MAIN }), 'internal')
  assert.equal(kind({ ...p, counterparty_iban: OWN_VAT, op_code: '160', op_label: 'PRZELEW WEWNĘTRZNY PRZY', amount: 5000 }), 'internal', 'uznanie z własnego rachunku')
  assert.equal(kind({ ...p, counterparty_iban: PL_IBAN }), 'unknown', 'obcy rachunek')
  assert.equal(kind({ ...p, counterparty_iban: OWN_VAT }, {}), 'unknown', 'bez listy rachunków własnych nie zgadujemy')
  assert.match(cls({ ...p, counterparty_iban: OWN_VAT }).reason, /własny rachunek/)
})

// ── 2. ZUS ────────────────────────────────────────────────────────────────────

test('zus: rachunek składkowy, kod 153 / 209, nazwa operacji, kontrahent — ga/zus_employer/auto', () => {
  const expected = 'zus:ga/zus_employer/auto'
  assert.equal(target({ op_code: '153', op_label: 'PRZELEW ZEWNĘTRZNY DO Z', counterparty: 'ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH', counterparty_iban: ZUS_IBAN, description: 'DRA 01.09.2026 R.' }), expected)
  assert.equal(target({ op_code: '209', op_label: 'PRZELEW PRZYSZŁY DO ZUS', description: 'SKŁADKI ZUS' }), expected)
  assert.equal(target({ op_code: '153', op_label: '' }), expected, 'sam kod operacji')
  assert.equal(target({ op_code: '', op_label: 'PRZELEW ZEWNĘTRZNY DO ZUS' }), expected, 'sama nazwa operacji')
  assert.equal(target({ op_code: 'Z01', op_label: 'PRZELEW ZEWNĘTRZNY DO Z' }), expected, 'nazwa ucięta do 27 znaków')
  assert.equal(target({ counterparty_iban: ZUS_IBAN, counterparty: 'ZUS', description: 'SKŁADKI' }), expected, 'zwykły przelew 152 na rachunek składkowy')
  assert.equal(target({ counterparty_iban: 'PL 83 6000 0002 0260 0012 3456 7890' }), expected, 'IBAN ze spacjami')
  assert.equal(target({ counterparty: 'ZAKŁAD UBEZPIECZEŃ SPOŁECZNYCH', counterparty_iban: PL_IBAN }), expected, 'po nazwie kontrahenta')
  assert.equal(target({ counterparty: 'Zaklad Ubezpieczen Spolecznych O/Warszawa' }), expected)
  assert.equal(target({ counterparty: 'ZUS O/WARSZAWA' }), expected, '„ZUS" jako całe słowo')
  const c = cls({ op_code: '153', op_label: 'PRZELEW ZEWNĘTRZNY DO Z', counterparty_iban: ZUS_IBAN, description: 'WPŁATA DO ZUS' })
  assert.equal(c.not_invoice_payment, true)
  assert.equal(c.reason, 'przelew na rachunek składkowy ZUS')
})

test('zus: NIE — „ZUS" wewnątrz słowa, sama wzmianka w tytule przelewu do firmy, zagraniczny IBAN z podobnymi cyframi', () => {
  assert.equal(kind({ counterparty: 'ZUSAMMEN GMBH', counterparty_iban: DE_IBAN, description: 'RECHNUNG 12' }), 'foreign_transfer')
  assert.equal(kind({ counterparty: 'KAZUS SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'FV 5/2026' }), 'unknown')
  assert.equal(kind({ counterparty: 'ZUS-BUD SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'FV 5/2026' }), 'unknown', 'skrót w nazwie firmy')
  assert.equal(kind({ counterparty: 'P.H.U. ZUS TESTOWY', counterparty_iban: PL_IBAN, description: 'FV 6/2026' }), 'unknown')
  assert.equal(kind({ counterparty: 'BIURO RACHUNKOWE TESTOWE SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'OBSŁUGA KADR I ZUS 09/2026 FV 44' }), 'unknown')
  assert.notEqual(kind({ counterparty: 'MUSTER GMBH', counterparty_iban: 'DE8360000002026000123456' }), 'zus')
})

test('zus: okres z tytułu — realne warianty (identyfikator deklaracji NN.MM.RRRR, OKRES <miesiąc>)', () => {
  const zus = (description: string, date: string) => cls({ op_code: '153', op_label: 'PRZELEW ZEWNĘTRZNY DO Z', counterparty_iban: ZUS_IBAN, description, date }).period
  assert.equal(zus('DEKLARACJA: DRA 01.12.2025 R.', '2026-01-15'), '2025-12', 'przełom roku: grudzień płacony w styczniu')
  assert.equal(zus('DRA 01.04.2026 R.', '2026-05-15'), '2026-04')
  assert.equal(zus('DEKLARACJA: DRA 01.03.2026 R OKRES MARZEC', '2026-04-10'), '2026-03')
  assert.equal(zus('1.06.2026', '2026-07-14'), '2026-06')
  assert.equal(zus('DRA 01.07.2026 R.', '2026-10-20'), '2026-07', 'płatność spóźniona o 3 miesiące')
  assert.equal(zus('WPŁATA DO ZUS', '2026-10-15'), null)
  assert.equal(zus('SKŁADKI ZUS', '2026-10-15'), null)
  assert.equal(zus('ZNAK: 123456.71.123456.2026.WZS', '2026-10-15'), null, 'znak sprawy to nie okres')
  const c = cls({ op_code: '153', op_label: 'PRZELEW ZEWNĘTRZNY DO Z', counterparty_iban: ZUS_IBAN, description: 'DRA 01.09.2026 R.', date: '2026-10-15' })
  assert.equal(c.reason, 'przelew na rachunek składkowy ZUS, składki za 2026-09')
})

test('parseZusPeriod: okno wiarygodności (nie później niż miesiąc płatności, najwyżej 24 miesiące wstecz) i przypadki brzegowe', () => {
  assert.equal(parseZusPeriod('DRA 01.10.2026', '2026-10-28'), '2026-10', 'miesiąc płatności dozwolony')
  assert.equal(parseZusPeriod('DRA 01.12.2026', '2026-10-15'), null, 'okres z przyszłości')
  assert.equal(parseZusPeriod('DRA 01.11.2026', '2026-10-31'), null)
  assert.equal(parseZusPeriod('DRA 01.10.2024', '2026-10-15'), '2024-10', 'dokładnie 24 miesiące wstecz')
  assert.equal(parseZusPeriod('DRA 01.09.2024', '2026-10-15'), null, '25 miesięcy wstecz')
  assert.equal(parseZusPeriod('DRA 01.01.2021', '2026-10-15'), null)
  assert.equal(parseZusPeriod('DRA 40.09.2026', '2026-10-15'), '2026-09', 'deklaracja korygująca nr 40')
  assert.equal(parseZusPeriod('DRA 99.09.2026', '2026-10-15'), null, 'numer deklaracji spoza 01–89')
  assert.equal(parseZusPeriod('DRA 01.13.2026', '2026-10-15'), null, 'miesiąc 13')
  assert.equal(parseZusPeriod('WPŁATA 15.10.2026', '2026-10-15'), null, 'zapis równy dacie przelewu to data, nie deklaracja')
  assert.equal(parseZusPeriod('01. 09. 2026', '2026-10-15'), '2026-09', 'spacje po kropkach')
  // nazwa miesiąca: rok = ostatni taki miesiąc nie później niż płatność
  assert.equal(parseZusPeriod('SKŁADKI OKRES GRUDZIEŃ', '2026-01-10'), '2025-12')
  assert.equal(parseZusPeriod('SKŁADKI OKRES MARZEC', '2026-04-10'), '2026-03')
  assert.equal(parseZusPeriod('SKŁADKI OKRES: WRZESIEŃ 2026', '2026-10-10'), '2026-09')
  assert.equal(parseZusPeriod('SKŁADKI ZA WRZESIEŃ 2026', '2026-10-10'), '2026-09')
  assert.equal(parseZusPeriod('SKŁADKI ZA M-C SIERPIEŃ', '2026-10-10'), '2026-08')
  assert.equal(parseZusPeriod('SKŁADKI 09/2026', '2026-10-10'), '2026-09')
  assert.equal(parseZusPeriod('', '2026-10-10'), null)
})

// ── 3. Urząd skarbowy ─────────────────────────────────────────────────────────

test('podatki: przelew podatkowy mBanku (kod 210, mikrorachunek, tytuł „N<NIP> <okres> <symbol>")', () => {
  const p = { op_code: '210', op_label: 'PRZELEW PODATKOWY', counterparty: 'URZĄD SKARBOWY', counterparty_iban: TAX_IBAN, date: '2026-10-20' }
  const pit4 = cls({ ...p, description: 'N5210000000 26M09 PIT-4' })
  assert.equal(`${pit4.kind}:${pit4.cost_category}/${pit4.subcategory}/${pit4.pnl_mode}`, 'tax_pit4:ga/salary_pit/auto')
  assert.equal(pit4.period, '2026-09')
  assert.equal(pit4.not_invoice_payment, true)
  assert.equal(pit4.reason, 'przelew podatkowy: PIT-4 za 2026-09')

  const vat = cls({ ...p, description: 'N5210000000 26M09 VAT-7' })
  assert.equal(`${vat.kind}:${vat.cost_category}/${vat.subcategory}/${vat.pnl_mode}`, 'tax_vat:financial/tax_vat/auto')
  assert.equal(vat.period, '2026-09')

  const cit = cls({ ...p, description: 'N5210000000 25R CIT-8', date: '2026-03-30' })
  assert.equal(`${cit.kind}:${cit.cost_category}/${cit.subcategory}/${cit.pnl_mode}`, 'tax_cit:financial/tax_income/auto')
  assert.equal(cit.period, '2025-12')
  assert.equal(cit.label, 'Podatek dochodowy')

  const pcc = cls({ ...p, description: 'N5210000000 26J1509 PCC-3' })
  assert.equal(`${pcc.kind}:${pcc.cost_category}/${pcc.subcategory}/${pcc.pnl_mode}`, 'tax_other:financial/tax_other/auto')
  assert.equal(pcc.period, '2026-09')
})

test('podatki: rozpoznanie po samym mikrorachunku, samym kodzie, samej nazwie operacji i po nazwie urzędu', () => {
  assert.equal(kind({ counterparty_iban: TAX_IBAN, description: 'N5210000000 26M09 PIT-4', date: '2026-10-20' }), 'tax_pit4', 'przelew 152 na mikrorachunek')
  assert.match(cls({ counterparty_iban: TAX_IBAN, description: 'N5210000000 26M09 PIT-4', date: '2026-10-20' }).reason, /^przelew na mikrorachunek podatkowy: PIT-4 za 2026-09$/)
  assert.equal(kind({ op_code: '210', op_label: '', description: 'CIT-8' }), 'tax_cit')
  assert.equal(kind({ op_code: '', op_label: 'PRZELEW PODATKOWY', description: 'VAT-7' }), 'tax_vat')
  for (const cp of ['URZĄD SKARBOWY WARSZAWA-MOKOTÓW', 'Pierwszy Urzad Skarbowy w Testowie', 'NACZELNIK URZĘDU SKARBOWEGO', 'IZBA ADMINISTRACJI SKARBOWEJ', 'KRAJOWA ADMINISTRACJA SKARBOWA', 'MIKRORACHUNEK PODATKOWY']) {
    assert.equal(kind({ counterparty: cp, counterparty_iban: PL_IBAN, description: 'CIT-8 zaliczka 08/2026', date: '2026-09-18' }), 'tax_cit', cp)
  }
  const manual = cls({ counterparty: 'URZĄD SKARBOWY WARSZAWA-MOKOTÓW', description: 'CIT-8 zaliczka 08/2026', date: '2026-09-18' })
  assert.equal(manual.period, '2026-08', 'tytuł wpisany ręcznie — okres „08/2026"')
  assert.equal(manual.reason, 'przelew do urzędu skarbowego: CIT-8 za 2026-08')
  // skrót „US" tylko razem z symbolem formularza / kodem okresu, nie dla firmy i nie przy fakturze
  assert.equal(kind({ counterparty: 'US Warszawa', description: 'PIT-4 za 08/2026', date: '2026-09-18' }), 'tax_pit4')
  assert.equal(kind({ counterparty: 'II US Testowo', description: 'N5210000000 26M08 VAT-7', date: '2026-09-18' }), 'tax_vat')
  assert.equal(kind({ counterparty: 'US Warszawa', description: 'opłata' }), 'unknown')
  assert.equal(kind({ counterparty: 'US ROBOTICS POLSKA', counterparty_iban: PL_IBAN, description: 'FAKTURA VAT 12/2026' }), 'unknown')
  assert.equal(kind({ counterparty: 'US TESTOWY', counterparty_iban: PL_IBAN, description: 'FV 12/2026 w tym VAT 23%' }), 'unknown')
})

test('podatki: „…us" wewnątrz słowa i „cit"/„vat" poza urzędem NIE są podatkiem', () => {
  for (const cp of ['GLOBUS SP. Z O.O.', 'ASUS POLSKA', 'STATUS SP. Z O.O.', 'FLIXBUS', 'CAMPUS SP Z OO', 'CITROEN POLSKA']) {
    assert.equal(kind({ counterparty: cp, counterparty_iban: PL_IBAN, description: 'FV 12/2026' }), 'unknown', cp)
  }
  assert.equal(kind({ counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'zaliczka, w tym podatek VAT 23%' }), 'unknown')
  assert.equal(kind({ counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'PIT-11 wydruk' }), 'unknown')
})

test('parseTaxTitle: symbole formularzy → rodzaj podatku', () => {
  const k = (title: string) => parseTaxTitle(title).kind
  const s = (title: string) => parseTaxTitle(title).symbol
  // zaliczki potrącone z wynagrodzeń
  for (const t of ['N5210000000 26M09 PIT-4', 'N5210000000 26R PIT-4R', 'PIT4R 2026', 'PIT 4', 'pit-4 za 09/2026']) {
    assert.equal(k(t), 'tax_pit4', t)
  }
  // podatek zryczałtowany PIT-8A / PIT-8AR (małe zlecenia, ale też dywidenda, odsetki) — NIE koszt płac: do decyzji
  for (const t of ['N5210000000 26M09 PIT-8A', 'N5210000000 26R PIT-8AR', '/TXT/PIT8AR']) {
    assert.equal(k(t), 'tax_other', t)
  }
  assert.equal(s('N5210000000 26M09 PIT-4'), 'PIT-4')
  assert.equal(s('PIT4R 2026'), 'PIT-4R')
  assert.equal(s('N5210000000 26R PIT-8AR'), 'PIT-8AR')
  // podatek dochodowy: CIT* oraz formularze właściciela
  for (const t of ['N5210000000 26M09 CIT-8', 'CIT', 'CIT8 08/2026', 'N5210000000 26M09 PIT-5', 'N5210000000 26K03 PIT-5L', 'N5210000000 25R PIT-28', 'N5210000000 25R PIT-36', 'N5210000000 25R PIT-36L', 'N5210000000 26M09 PIT', 'N5210000000 26M09 PPL', 'zaliczka na podatek dochodowy']) {
    assert.equal(k(t), 'tax_cit', t)
  }
  assert.equal(s('N5210000000 26K03 PIT-5L'), 'PIT-5L')
  assert.equal(s('N5210000000 26M09 PIT'), 'PIT')
  // VAT / JPK
  for (const t of ['N5210000000 26M09 VAT-7', 'N5210000000 26K03 VAT-7K', 'VAT 08/2026', 'N5210000000 26M09 JPK_V7M', 'N5210000000 26K03 JPKV7K', 'JPK_V7M 08/2026', 'VAT-UE', 'podatek VAT za wrzesień']) {
    assert.equal(k(t), 'tax_vat', t)
  }
  assert.equal(s('N5210000000 26M09 JPK_V7M'), 'JPK_V7M')
  assert.equal(s('N5210000000 26K03 JPKV7K'), 'JPK_V7K')
  assert.equal(s('VAT 08/2026'), 'VAT', 'okres „08/2026" nie jest częścią symbolu')
  // pozostałe
  for (const t of ['N5210000000 26J1509 PCC-3', 'AKC-4', 'odsetki za zwłokę', 'mandat karny nr 123', 'opłata skarbowa od pełnomocnictwa', 'koszty upomnienia', '']) {
    assert.equal(k(t), 'tax_other', t || '(pusty)')
  }
  assert.equal(s('N5210000000 26J1509 PCC-3'), 'PCC-3')
  assert.equal(s('odsetki za zwłokę'), '')
  assert.equal(k('zaliczka na podatek od wynagrodzeń'), 'tax_pit4')
})

test('parseTaxTitle: format Elixir /TI/…/OKR/…/SFP/…/TXT/… oraz sam symbol w tytule', () => {
  const a = parseTaxTitle('/TI/N5210000000/OKR/26M09/SFP/PIT-4/TXT/ZALICZKA', '2026-10-20')
  assert.deepEqual(a, { kind: 'tax_pit4', symbol: 'PIT-4', period: '2026-09', period_code: '26M09' })
  const b = parseTaxTitle('/TI/N5210000000/OKR/26K03/SFP/VAT-7K/TXT/VAT ZA III KW', '2026-10-25')
  assert.deepEqual(b, { kind: 'tax_vat', symbol: 'VAT-7K', period: '2026-09', period_code: '26K03' })
  const c = parseTaxTitle('/TI/N5210000000/OKR/25R/SFP/CIT-8/TXT/', '2026-03-31')
  assert.deepEqual(c, { kind: 'tax_cit', symbol: 'CIT-8', period: '2025-12', period_code: '25R' })
  // /TXT/ z innym symbolem nie nadpisuje pola /SFP/
  assert.equal(parseTaxTitle('/TI/N5210000000/OKR/26M09/SFP/PIT-4/TXT/NIE VAT', '2026-10-20').kind, 'tax_pit4')
  assert.equal(parseTaxTitle('/TI/N5210000000/OKR/26 M09/SFP/PIT-4/TXT/', '2026-10-20').period, '2026-09', 'spacja wstawiona przy łamaniu wiersza')
  assert.equal(parseTaxTitle('/SFP/CIT/2026').kind, 'tax_cit')
  assert.equal(parseTaxTitle('/SFP/VAT-7/2026').kind, 'tax_vat')
  assert.equal(parseTaxTitle('CIT-8 zaliczka 08/2026', '2026-09-18').period, '2026-08')
  assert.equal(parseTaxTitle('PIT-4 za wrzesień 2026', '2026-10-18').period, '2026-09')
})

test('parseTaxTitle: wszystkie kody okresu — R, P0n, K0n, Mnn, D<dekada><miesiąc>, J<dzień><miesiąc>', () => {
  const per = (code: string, date = '2027-06-30') => parseTaxTitle(`N5210000000 ${code} VAT-7`, date).period
  assert.equal(per('26R'), '2026-12', 'rok → grudzień')
  assert.equal(per('26P01'), '2026-06', 'I półrocze → czerwiec')
  assert.equal(per('26P02'), '2026-12', 'II półrocze → grudzień')
  assert.equal(per('26K01'), '2026-03')
  assert.equal(per('26K02'), '2026-06')
  assert.equal(per('26K03'), '2026-09')
  assert.equal(per('26K04'), '2026-12')
  assert.equal(per('26M01'), '2026-01')
  assert.equal(per('26M09'), '2026-09')
  assert.equal(per('26M12'), '2026-12')
  assert.equal(per('26D0109'), '2026-09', 'dekada 01 września')
  assert.equal(per('26D0312'), '2026-12', 'dekada 03 grudnia')
  assert.equal(per('26J0109'), '2026-09', 'dzień 01 września')
  assert.equal(per('26J3112'), '2026-12')
  assert.equal(parseTaxTitle('N5210000000 26M09 VAT-7').period_code, '26M09')
  // nieprawidłowe kody nie są okresem
  for (const bad of ['26M13', '26K05', '26P03', '26M00', '26X01', '2026M09']) {
    assert.equal(parseTaxTitle(`N5210000000 ${bad} VAT-7`, '2027-06-30').period, null, bad)
    assert.equal(parseTaxTitle(`N5210000000 ${bad} VAT-7`, '2027-06-30').period_code, '', bad)
  }
})

test('parseTaxTitle: okno wiarygodności — nie później niż miesiąc płatności, najwyżej 36 miesięcy wstecz', () => {
  const per = (code: string, date: string) => parseTaxTitle(`N5210000000 ${code} PIT-4`, date).period
  assert.equal(per('26M10', '2026-10-05'), '2026-10', 'miesiąc płatności dozwolony')
  assert.equal(per('26M12', '2026-10-20'), null, 'okres z przyszłości')
  assert.equal(per('26R', '2026-06-20'), null, 'rok bieżący (→ grudzień) płacony w czerwcu')
  assert.equal(per('23M10', '2026-10-20'), '2023-10', 'dokładnie 36 miesięcy wstecz')
  assert.equal(per('23M09', '2026-10-20'), null, '37 miesięcy wstecz')
  assert.equal(per('25M12', '2026-01-20'), '2025-12', 'przełom roku')
  assert.equal(per('25R', '2026-03-31'), '2025-12', 'rozliczenie roczne')
  // kod poza oknem zostaje w period_code, a okres NIE jest zgadywany z innych liczb w tytule
  const out = parseTaxTitle('N5210000000 26M12 PIT-4 09/2026', '2026-10-20')
  assert.equal(out.period, null)
  assert.equal(out.period_code, '26M12')
  // bez daty płatności — bez kontroli okna
  assert.equal(parseTaxTitle('N5210000000 19M03 PIT-4').period, '2019-03')
  // rodzaj podatku nie zależy od okna
  assert.equal(cls({ op_code: '210', op_label: 'PRZELEW PODATKOWY', description: 'N5210000000 26M12 PIT-4', date: '2026-10-20' }).kind, 'tax_pit4')
  assert.equal(cls({ op_code: '210', op_label: 'PRZELEW PODATKOWY', description: 'N5210000000 26M12 PIT-4', date: '2026-10-20' }).period, null)
})

// ── 4. Opłaty i odsetki bankowe ───────────────────────────────────────────────

test('bank_fee / interest: kody opłat, nazwa operacji zaczynająca się od OPŁATA / PROWIZJA / ODSETKI', () => {
  const fees: Array<[string, string]> = [
    ['776', 'OPŁATA ZA PRZELEW ZEWNĘ'], ['27A', 'OPŁATA ZA PROWADZENIE R'], ['91A', 'RAPORTY MT940 - OPŁATA'],
    ['563', 'OPŁATA ZA KARTĘ'], ['54A', 'OPŁATA ZA WIZERUNEK KAR'], ['D08', 'PRZEL. EXPRESS ELIXIR W'],
  ]
  for (const [op, label] of fees) {
    assert.equal(target({ op_code: op, op_label: label, amount: -1.5 }), 'bank_fee:financial/bank_fee/auto', op)
    assert.equal(target({ op_code: op, op_label: '', amount: -1.5 }), 'bank_fee:financial/bank_fee/auto', `${op} bez nazwy`)
  }
  assert.equal(kind({ op_code: 'Q11', op_label: 'OPŁATA ZA WYPŁATĘ GOTÓWKI' }), 'bank_fee')
  assert.equal(kind({ op_code: 'Q12', op_label: 'PROWIZJA OD KREDYTU' }), 'bank_fee')
  assert.equal(kind({ op_code: 'Q13', op_label: 'USŁUGA DODATKOWA - OPŁATA' }), 'bank_fee')
  assert.equal(target({ op_code: 'Q14', op_label: 'ODSETKI OD KREDYTU W RACH' }), 'interest:financial/interest/auto')
  assert.equal(kind({ op_code: 'Q15', op_label: 'KAPITALIZACJA ODSETEK', amount: 3.21 }), 'interest')
  const c = cls({ op_code: '776', op_label: 'OPŁATA ZA PRZELEW ZEWNĘ' })
  assert.equal(c.not_invoice_payment, true)
  assert.equal(c.reason, 'opłata bankowa: OPŁATA ZA PRZELEW ZEWNĘ')
  // „opłata" w TYTULE zwykłego przelewu do firmy to nie opłata bankowa
  assert.equal(kind({ counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'OPŁATA ZA SERWIS FV 3/2026' }), 'unknown')
  // przelew ekspresowy (D07) to przelew, opłatą jest dopiero D08
  assert.equal(kind({ op_code: 'D07', op_label: 'PRZELEW EXPRESS ELIXIR', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN, description: 'FV 3/2026' }), 'unknown')
})

// ── 5. Wynagrodzenia ──────────────────────────────────────────────────────────

test('salary: realne warianty tytułów (przelew 152 zewnętrzny i 169 wewnętrzny do osoby fizycznej)', () => {
  const titles = ['WYNAGRODZENIE 9/2026', 'WYNAGRODZENIE 9/2026 CZĘŚĆ 2', 'WYNAGRODZENIE 9/2026+PREMIA UZNANIOWA', 'WYNAGRODZENIE+PREMIA UZNANIOWA 9/2026']
  for (const description of titles) {
    for (const [op, label] of [['152', 'PRZELEW ZEWNĘTRZNY WYCH'], ['169', 'PRZELEW WEWNĘTRZNY WYCH']]) {
      const c = cls({ op_code: op, op_label: label, description, counterparty: 'JAN TESTOWY', counterparty_iban: PL_IBAN, date: '2026-09-30', amount: -6500 }, {})
      assert.equal(`${c.kind}:${c.cost_category}/${c.subcategory}/${c.pnl_mode}`, 'salary:ga/salary_gross/auto', `${description} / ${op}`)
      assert.equal(c.period, '2026-09', description)
      assert.equal(c.not_invoice_payment, true)
    }
  }
  // wypłata 1–2 dnia następnego miesiąca — okres nadal z tytułu
  assert.equal(cls({ description: 'WYNAGRODZENIE 9/2026', counterparty: 'JAN TESTOWY', date: '2026-10-02' }, {}).period, '2026-09')
  assert.match(cls({ description: 'WYNAGRODZENIE 9/2026', counterparty: 'JAN TESTOWY', date: '2026-10-02' }, {}).reason, /wynagrodzenia.*za 2026-09$/)
  // inne słowa płacowe
  for (const description of ['Pensja za wrzesień', 'LISTA PŁAC 09/2026', 'PREMIA UZNANIOWA', 'premię roczną 2026', 'UMOWA ZLECENIE 9/2026', 'umowa o dzieło nr 3', 'Wynagrodzenie za wrzesień 2026']) {
    assert.equal(kind({ description, counterparty: 'ANNA PRZYKŁADOWA', counterparty_iban: PL_IBAN }, {}), 'salary', description)
  }
  // BLIK na telefon z tytułem płacowym to też przelew
  assert.equal(kind({ op_code: '90A', op_label: 'BLIK P2P-WYCHODZĄCY', description: 'WYNAGRODZENIE 9/2026', counterparty: '' }, {}), 'salary')
  // kwota bez znaku (np. z ManualCost) — kierunek znany z kodu operacji
  assert.equal(kind({ description: 'WYNAGRODZENIE 9/2026', counterparty: 'JAN TESTOWY', amount: 6500 }, {}), 'salary')
})

test('salary NIE: firma jako odbiorca, znacznik faktury, zwrot wydatku, wypłata gotówki, „opłacenie", „premium", „pensjonat", zakup kartą, wpływ', () => {
  const companies = ['ALFA SERWIS SP. Z O.O.', 'BETA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', 'GAMMA S.A.', 'DELTA SP.K.', 'EPSILON SP. J.', 'KOWALSCY S.C.', 'MUSTER GMBH', 'SAMPLE LTD', 'EXAMPLE INC', 'KANCELARIA PRAWNA TESTOWA', 'F.H.U. TESTEX', 'JAN TESTOWY USŁUGI BUDOWLANE']
  for (const counterparty of companies) {
    assert.notEqual(kind({ description: 'wynagrodzenie za usługi faktura 12/2026', counterparty, counterparty_iban: PL_IBAN }), 'salary', counterparty)
    assert.notEqual(kind({ description: 'WYNAGRODZENIE 9/2026', counterparty, counterparty_iban: PL_IBAN }), 'salary', `${counterparty} (bez faktury)`)
  }
  assert.equal(kind({ description: 'wynagrodzenie za usługi faktura 12/2026', counterparty: 'ALFA SERWIS SP. Z O.O.', counterparty_iban: PL_IBAN }), 'unknown')
  // osoba fizyczna, ale tytuł wskazuje fakturę / rachunek
  for (const description of ['WYNAGRODZENIE ZA USŁUGI FAKTURA 12/2026', 'wynagrodzenie FV 12/2026', 'WYNAGRODZENIE FV12/2026', 'wynagrodzenie f-ra 7/09/2026', 'Wynagrodzenie FA 15/2026', 'wynagrodzenie rachunek nr 4/2026']) {
    assert.equal(kind({ description, counterparty: 'JAN TESTOWY', counterparty_iban: PL_IBAN }), 'unknown', description)
  }
  // pracownik z listy, ale to nie pensja
  for (const description of ['ZWROT WYDATKU SŁUŻBOWEGO', 'zwrot za paliwo', 'ZALICZKA NA DELEGACJĘ', 'ROZLICZENIE DELEGACJI 09/2026', 'POŻYCZKA - WYPŁATA', 'WYPŁATA DYWIDENDY', 'ZWROT KAUCJI', 'OPŁACENIE FAKTURY 12/2026', 'OPŁACENIE ZAMÓWIENIA', 'PRZELEW ŚRODKÓW', 'wypłata FV 3/2026']) {
    assert.equal(kind({ description, counterparty: 'JAN KOWALSKI', counterparty_iban: PL_IBAN }), 'unknown', description)
  }
  // wypłata gotówki / bankomat
  assert.equal(kind({ op_code: 'W01', op_label: 'WYPŁATA GOTÓWKI', description: 'WYPŁATA GOTÓWKI W ODDZIALE', counterparty: '' }), 'unknown')
  assert.equal(kind({ op_code: 'W02', op_label: 'WYPŁATA W BANKOMACIE', description: 'BANKOMAT TESTOWO UL. LIPOWA', counterparty: '' }), 'unknown')
  assert.equal(kind({ description: 'WYPŁATA GOTÓWKI', counterparty: 'JAN KOWALSKI' }), 'unknown', 'nawet gdy „kontrahentem" jest pracownik')
  // słowa tylko podobne do płacowych
  assert.equal(kind({ description: 'OPŁACENIE SKŁADKI CZŁONKOWSKIEJ', counterparty: 'JAN TESTOWY' }, {}), 'unknown', '„opłacenie" to nie „płac"')
  assert.equal(kind({ description: 'ABONAMENT PREMIUM 09/2026', counterparty: 'JAN TESTOWY' }, {}), 'unknown', '„premium" to nie „premia"')
  assert.equal(kind({ description: 'PENSJONAT POD LASEM NOCLEG', counterparty: 'ANNA PRZYKŁADOWA' }, {}), 'unknown', '„pensjonat" to nie „pensja"')
  assert.equal(kind({ description: 'PLAC ZBAWICIELA 1 CZYNSZ', counterparty: 'ANNA PRZYKŁADOWA' }, {}), 'unknown')
  // zakup kartą / BLIK w sklepie z „premią" w nazwie
  assert.equal(kind({ op_code: '114', op_label: 'ZAKUP PRZY UŻYCIU KARTY', description: 'PREMIA SKLEP/WARSZAWA DATA TRANSAKCJI: 2026-09-01', counterparty: '' }), 'unknown')
  assert.equal(kind({ op_code: 'C22', op_label: 'BLIK ZAKUP E-COMMERCE', description: 'WYNAGRODZENIE.PL', counterparty: '' }), 'unknown')
  // wpływ (uznanie) z tytułem płacowym to nie koszt wynagrodzeń
  assert.equal(kind({ op_code: '150', op_label: 'PRZELEW ZEWNĘTRZNY PRZY', description: 'ZWROT NADPŁACONEGO WYNAGRODZENIA 9/2026', counterparty: 'JAN TESTOWY', amount: 500 }, {}), 'unknown')
})

test('salary: dopasowanie do listy pracowników (zestaw tokenów, bez kolejności i ogonków) + szersze słowa płacowe', () => {
  for (const description of ['WYPŁATA 9/2026', 'NAGRODA ROCZNA', 'EKWIWALENT ZA URLOP', 'ODPRAWA', 'NADGODZINY 09/2026', 'PROWIZJA 09/2026', 'BONUS ZA PROJEKT']) {
    assert.equal(kind({ description, counterparty: 'JAN KOWALSKI', counterparty_iban: PL_IBAN }), 'salary', description)
    assert.equal(kind({ description, counterparty: 'JAN NOWAK', counterparty_iban: PL_IBAN }), 'unknown', `${description} — osoba spoza listy`)
    assert.equal(kind({ description, counterparty: 'JAN KOWALSKI', counterparty_iban: PL_IBAN }, {}), 'unknown', `${description} — bez listy pracowników`)
  }
  const c = cls({ description: 'WYPŁATA 9/2026', counterparty: 'KOWALSKI JAN', date: '2026-10-01' })
  assert.equal(c.period, '2026-09')
  assert.match(c.reason, /pracownika/)
  // kolejność, wielkość liter, ogonki, łącznik w nazwisku
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'kowalski  jan' }), 'salary')
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'ANNA MARIA ZOLC' }), 'salary')
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'ŻÓŁĆ ANNA-MARIA' }), 'salary')
  // jeden token nadmiarowy (drugie imię) dopuszczalny; inne nazwisko — nie
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'JAN ADAM KOWALSKI' }), 'salary')
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'ANNA ZOLC' }), 'salary', 'lista ma drugie imię, wyciąg nie')
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'JAN ADAM PIOTR KOWALSKI' }), 'unknown', 'dwa tokeny nadmiarowe')
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'JANINA KOWALSKA' }), 'unknown')
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'KOWALSKI' }), 'unknown', 'sam jeden token')
  assert.equal(kind({ description: 'WYPŁATA', counterparty: 'CHER' }), 'unknown', 'pozycja listy z jednym tokenem nie dopasowuje')
  // ścisłe słowo płacowe działa także dla osoby spoza listy
  assert.equal(kind({ description: 'WYNAGRODZENIE 9/2026', counterparty: 'JAN NOWAK' }), 'salary')
})

test('parseSalaryPeriod: formaty okresu i okno wiarygodności', () => {
  const p = (title: string, date = '2026-10-01') => parseSalaryPeriod(title, date)
  assert.equal(p('WYNAGRODZENIE 9/2026'), '2026-09')
  assert.equal(p('WYNAGRODZENIE 09/2026'), '2026-09')
  assert.equal(p('WYNAGRODZENIE 09.2026'), '2026-09')
  assert.equal(p('WYNAGRODZENIE 09-2026'), '2026-09')
  assert.equal(p('WYNAGRODZENIE 2026-09'), '2026-09')
  assert.equal(p('WYNAGRODZENIE 2026/09'), '2026-09')
  assert.equal(p('WYNAGRODZENIE-9/2026'), '2026-09')
  assert.equal(p('WYNAGRODZENIE ZA WRZESIEŃ 2026'), '2026-09')
  assert.equal(p('WYNAGRODZENIE WRZESIEŃ 2026'), '2026-09')
  assert.equal(p('wynagrodzenie za m-c września 2026 r.'), '2026-09')
  assert.equal(p('WYNAGRODZENIE ZA WRZESIEŃ'), '2026-09', 'bez roku: ostatni taki miesiąc nie po wypłacie')
  assert.equal(p('WYNAGRODZENIE ZA GRUDZIEŃ', '2026-01-02'), '2025-12', 'przełom roku')
  assert.equal(p('WYNAGRODZENIE 12/2025', '2026-01-02'), '2025-12')
  assert.equal(p('WYNAGRODZENIE 10/2026', '2026-10-30'), '2026-10', 'miesiąc wypłaty dozwolony')
  // poza oknem / bez okresu
  assert.equal(p('WYNAGRODZENIE 10/2026', '2026-09-30'), null, 'okres późniejszy niż wypłata')
  assert.equal(p('WYNAGRODZENIE 9/2027', '2026-10-01'), null)
  assert.equal(p('WYNAGRODZENIE 10/2024'), '2024-10', 'dokładnie 24 miesiące wstecz')
  assert.equal(p('WYNAGRODZENIE 9/2024'), null, '25 miesięcy wstecz')
  assert.equal(p('WYNAGRODZENIE'), null)
  assert.equal(p('PREMIA UZNANIOWA'), null)
  assert.equal(p('WYNAGRODZENIE 13/2026'), null)
  assert.equal(p('WYNAGRODZENIE CZĘŚĆ 2'), null)
  // pełna data to nie okres
  assert.equal(p('WYNAGRODZENIE 30.09.2026'), null)
  assert.equal(p('WYNAGRODZENIE 2026-09-30'), null)
  assert.equal(p('WYNAGRODZENIE 30.09.2026 ZA 9/2026'), '2026-09')
  // dwa okresy — pierwszy mieszczący się w oknie
  assert.equal(p('WYNAGRODZENIE 8/2026 I 9/2026'), '2026-08')
  assert.equal(p('WYNAGRODZENIE 11/2026 KOREKTA 9/2026'), '2026-09')
})

// ── 6. Dostawcy zagraniczni (bez KSeF) ────────────────────────────────────────

test('foreign_vendor: realne warianty tytułów płatności kartą („MERCHANT/MIASTO", kwota już w PLN)', () => {
  const card = (description: string) => cls({ op_code: '114', op_label: 'ZAKUP PRZY UŻYCIU KARTY', description: `${description} DATA TRANSAKCJI: 2026-09-01`, counterparty: '', counterparty_iban: '', amount: -99 })
  const cases: Array<[string, string, string]> = [
    ['OPENAI *CHATGPT SUB/OPENAI.COM', 'openai', 'ga/software'],
    ['CLAUDE.AI SUBSCRIPT/ANTHROPIC.', 'anthropic', 'ga/software'],
    ['GITHUB, INC. /GITHUB.COM', 'github', 'ga/software'],
    ['MSFT * E0800XXXXX /MSBILL.INF', 'microsoft', 'ga/software'],
    ['Autodesk ADY /Dublin 2', 'autodesk', 'ga/software'],
    ['APPLE.COM/PL /801-934-99', 'apple', 'ga/software'],
    ['APPLE.COM/BILL /ITUNES.COM', 'apple', 'ga/software'],
    ['ADOBE *CREATIVE CLOUD/Dublin', 'adobe', 'ga/software'],
    ['ZOOM.US 888-799-9666/SAN JOSE', 'zoom', 'ga/software'],
    ['NOTION LABS, INC. /NOTION.SO', 'notion', 'ga/software'],
    ['CURSOR, AI POWERED IDE/NEW YORK', 'cursor', 'ga/software'],
    ['HETZNER ONLINE GMBH/GUNZENHAUSEN', 'hetzner', 'ga/software'],
    ['RENDER.COM /SAN FRANCISCO', 'render', 'ga/software'],
    ['EXPO.DEV /PALO ALTO', 'expo', 'ga/software'],
    ['NEON.TECH /SAN FRANCISCO', 'neon', 'ga/software'],
    ['LINEAR.APP /SAN FRANCISCO', 'linear', 'ga/software'],
    ['FACEBK *ABCDE12345/fb.me/ads', 'meta', 'sales/marketing'],
    ['eibmarkt.com GmbH /Plauen', 'eibmarkt', 'cogs/hardware_eu'],
    ['EU.STORE.BAMBULAB.C/FRANKFURT', 'bambulab', 'operations/tools'],
    ['ALIEXPRESS.COM /LUXEMBOURG', 'aliexpress', 'cogs/hardware_noneu'],
    ['WIZZ AIRLINE XXXXX/Budapest', 'wizzair', 'operations/travel'],
    ['RYANAIR ABC123/DUBLIN', 'ryanair', 'operations/travel'],
    ['BOOKING.COM HOTEL/AMSTERDAM', 'booking', 'operations/travel'],
    ['AIRBNB * HMXXXXXX/LONDON', 'airbnb', 'operations/travel'],
  ]
  for (const [description, key, cat] of cases) {
    const c = card(description)
    assert.equal(c.kind, 'foreign_vendor', description)
    assert.equal(`${c.cost_category}/${c.subcategory}`, cat, description)
    assert.equal(matchForeignVendor(description)?.key, key, description)
    assert.equal(c.pnl_mode, 'include')
    assert.equal(c.not_invoice_payment, false)
    assert.equal(c.period, null)
    assert.ok(c.reason.includes(matchForeignVendor(description)!.name), `uzasadnienie nazywa dostawcę: ${description}`)
  }
  // lista zawiera co najmniej dostawców wymienionych w specyfikacji
  const keys = new Set(FOREIGN_VENDORS.map(v => v.key))
  for (const k of ['openai', 'anthropic', 'github', 'microsoft', 'autodesk', 'apple', 'adobe', 'atlassian', 'slack', 'zoom', 'notion', 'figma', 'canva', 'dropbox', 'jetbrains', 'digitalocean', 'hetzner', 'cloudflare', 'vercel', 'twilio', 'zapier', 'midjourney', 'cursor', 'perplexity', 'miro', 'sentry', 'mailchimp', 'linkedin', 'meta', 'eibmarkt', 'bambulab', 'aliexpress', 'wizzair', 'ryanair', 'lufthansa', 'easyjet', 'booking', 'airbnb']) {
    assert.ok(keys.has(k), k)
  }
})

test('foreign_vendor: także BLIK i przelew za granicę do znanego dostawcy (kategoria dostawcy, nie „przelew zagraniczny")', () => {
  assert.equal(target({ op_code: 'C22', op_label: 'BLIK ZAKUP E-COMMERCE', description: 'EIBMARKT.COM', counterparty: '' }), 'foreign_vendor:cogs/hardware_eu/include')
  assert.equal(target({ op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', description: 'RECHNUNG R123456', counterparty: 'HETZNER ONLINE GMBH', counterparty_iban: DE_IBAN }), 'foreign_vendor:ga/software/include')
})

test('foreign_vendor NIE: fałszywe trafienia (BOLTON, EXPORT, NEONET, RENDERING…) i celowo pominięci (Google, Amazon, Allegro, Uber, Bolt, Orlen)', () => {
  const card = (description: string) => kind({ op_code: '114', op_label: 'ZAKUP PRZY UŻYCIU KARTY', description: `${description} DATA TRANSAKCJI: 2026-09-01`, counterparty: '' })
  const notVendors = [
    'BOLTON SP. Z O.O./WARSZAWA', 'EXPORT-IMPORT TESTOWY/GDYNIA', 'EXPO XXI WARSZAWA/WARSZAWA', 'NEONET S.A./WROCLAW', 'NEON BAR/KRAKOW',
    'RENDERING STUDIO/POZNAN', 'RENDER SP Z OO/LODZ', 'LINEAR SP. Z O.O./GDANSK', 'MIROSLAW TESTOWY SKLEP/RADOM', 'MIRO MEBLE/KALISZ',
    'ZOOM FOTO/WARSZAWA', 'CANVAS PRINT/KRAKOW', 'NOTION CAFE/WARSZAWA', 'CURSOR SP. Z O.O./WARSZAWA', 'SENTRY OCHRONA/LUBLIN',
    'ISPOT APPLE PREMIUM RES/WARSZAWA', 'SLACKLINE SHOP/ZAKOPANE', 'MICROSOFT STORE POLSKA/WARSZAWA', 'FIGMART/WARSZAWA', 'VERCELLI PIZZA/WARSZAWA',
    // celowo poza listą — mogą fakturować przez polski podmiot w KSeF
    'GOOGLE *WORKSPACE/DUBLIN', 'GOOGLE CLOUD/WARSZAWA', 'AMAZON.PL*AB12CD34/AMAZON.PL', 'AWS EMEA/AWS.AMAZON.CO', 'ALLEGRO/POZNAN',
    'UBER *TRIP/AMSTERDAM', 'BOLT.EU/O/2609011234/TALLINN', 'ORLEN STACJA NR 123/WARSZAWA', 'LOT POLISH AIRLINES/WARSZAWA',
    // zwykły polski sklep
    'SKLEP BUDOWLANY KAS/WARSZAWA', 'JMP S.A. BIEDRONKA 1234/WARSZAWA',
  ]
  for (const d of notVendors) {
    assert.equal(card(d), 'unknown', d)
    assert.equal(matchForeignVendor(d), null, d)
  }
  assert.equal(matchForeignVendor(''), null)
  assert.equal(matchForeignVendor(null), null)
})

test('foreign_vendor NIE: polski odsprzedawca (polski rachunek / polska forma prawna) i zwrot na kartę', () => {
  // licencja kupiona u polskiego partnera — faktura jest w KSeF, przelew to zwykła płatność za fakturę
  assert.equal(kind({ description: 'AUTODESK AUTOCAD LICENCJA FV 1/2026', counterparty: 'PARTNER CAD SP. Z O.O.', counterparty_iban: PL_IBAN }), 'unknown')
  assert.equal(kind({ description: 'ADOBE CREATIVE CLOUD', counterparty: 'RESELLER TESTOWY', counterparty_iban: PL_IBAN }), 'unknown', 'pełny polski rachunek')
  assert.equal(kind({ description: 'GITHUB COPILOT 09/2026', counterparty: 'RESELLER TESTOWY SP. Z O.O.', counterparty_iban: '' }), 'unknown', 'polska forma prawna')
  // zwrot towaru (uznanie) nie jest kosztem
  assert.equal(kind({ op_code: '121', op_label: 'POS ZWROT TOWARU', description: 'eibmarkt.com GmbH /Plauen', counterparty: '', amount: 250 }), 'unknown')
  assert.equal(kind({ op_code: 'C23', op_label: 'BLIK KOR. ZAKUPU E-COMM', description: 'OPENAI', counterparty: '', amount: 99 }), 'unknown')
})

// ── 7. Przelew zagraniczny ────────────────────────────────────────────────────

test('foreign_transfer: zagraniczny IBAN / SEPA / SWIFT / rachunek walutowy — UE i EOG → hardware_eu, reszta → hardware_noneu', () => {
  const sepa = { op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', description: 'RECHNUNG 2026-1234', counterparty: 'MUSTER TECHNIK GMBH' }
  const de = cls({ ...sepa, counterparty_iban: DE_IBAN })
  assert.equal(`${de.kind}:${de.cost_category}/${de.subcategory}/${de.pnl_mode}`, 'foreign_transfer:cogs/hardware_eu/include')
  assert.equal(de.not_invoice_payment, false)
  assert.equal(de.period, null)
  assert.match(de.reason, /DE/)
  assert.equal(target({ ...sepa, counterparty: 'NORDIC SAMPLE AS', counterparty_iban: NO_IBAN }), 'foreign_transfer:cogs/hardware_eu/include', 'EOG (Norwegia)')
  assert.equal(target({ ...sepa, counterparty: 'SAMPLE TRADING LTD', counterparty_iban: GB_IBAN }), 'foreign_transfer:cogs/hardware_noneu/include', 'Wielka Brytania — poza UE')
  assert.equal(target({ ...sepa, counterparty: 'ORNEK TICARET', counterparty_iban: TR_IBAN }), 'foreign_transfer:cogs/hardware_noneu/include')
  // zwykły kod przelewu, ale rachunek zagraniczny
  assert.equal(target({ op_code: '152', op_label: 'PRZELEW ZEWNĘTRZNY WYCH', description: 'INVOICE 77', counterparty: 'MUSTER TECHNIK GMBH', counterparty_iban: 'DE89 3704 0044 0532 0130 00' }), 'foreign_transfer:cogs/hardware_eu/include')
  // bez IBAN-u: SEPA = strefa euro/UE; SWIFT / polecenie wypłaty = poza UE
  assert.equal(target({ ...sepa, counterparty_iban: '' }), 'foreign_transfer:cogs/hardware_eu/include')
  assert.equal(target({ op_code: 'S01', op_label: 'POLECENIE WYPŁATY', description: 'INVOICE 77', counterparty: 'SAMPLE ELECTRONICS CO' }), 'foreign_transfer:cogs/hardware_noneu/include')
  assert.equal(target({ op_code: 'S02', op_label: 'PRZELEW SWIFT WYCHODZĄCY', description: 'INVOICE 77', counterparty: 'SAMPLE ELECTRONICS CO' }), 'foreign_transfer:cogs/hardware_noneu/include')
  assert.equal(target({ op_code: 'S03', op_label: 'PRZELEW ZAGRANICZNY', description: 'INVOICE 77', counterparty: 'SAMPLE ELECTRONICS CO' }), 'foreign_transfer:cogs/hardware_noneu/include')
})

test('foreign_transfer: przelew z rachunku EUR / USD; polska firma opłacona przez SEPA lub z rachunku walutowego zostaje nierozpoznana', () => {
  // rachunek EUR (waluta wyciągu ≠ PLN), odbiorca bez polskich cech
  const eur = cls({ currency: 'EUR', description: 'RECHNUNG 55', counterparty: 'MUSTER TECHNIK GMBH', counterparty_iban: '', amount: -1200 })
  assert.equal(`${eur.kind}:${eur.cost_category}/${eur.subcategory}/${eur.pnl_mode}`, 'foreign_transfer:cogs/hardware_eu/include')
  assert.match(eur.reason, /EUR/)
  assert.equal(target({ currency: 'USD', description: 'INVOICE 55', counterparty: 'SAMPLE ELECTRONICS CO', amount: -1200 }), 'foreign_transfer:cogs/hardware_noneu/include')
  assert.equal(target({ currency: 'eur', description: 'RECHNUNG 55', counterparty: 'MUSTER TECHNIK GMBH', counterparty_iban: DE_IBAN }), 'foreign_transfer:cogs/hardware_eu/include')
  // polska firma: polski rachunek albo polska forma prawna — to zwykła płatność za fakturę z KSeF
  assert.equal(kind({ op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', description: 'FV 12/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN }), 'unknown')
  assert.equal(kind({ op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', description: 'FV 12/2026', counterparty: 'DOSTAWCA TESTOWY', counterparty_iban: PL_IBAN }), 'unknown', 'sam polski rachunek')
  assert.equal(kind({ op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', description: 'FV 12/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: '' }), 'unknown', 'sama polska forma prawna')
  assert.equal(kind({ currency: 'EUR', description: 'FV 12/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN }), 'unknown', 'rachunek EUR → polska spółka')
  assert.equal(cls({ op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', description: 'FV 12/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN }).not_invoice_payment, false)
})

test('foreign_transfer NIE: rachunek w neobanku (Revolut LT, Wise BE, N26, bunq) — kraj IBAN-u nie mówi, skąd jest kontrahent', () => {
  // polski freelancer z rachunkiem w Revolucie wystawia fakturę w KSeF — automatyczne „include" liczyłoby koszt podwójnie
  const neobanks = ['LT123250012345678901', 'LT98 3500 0123 4567 8901', 'BE68967123456789', 'DE12100110012345678901', 'NL91BUNQ0417164300', 'GB33REVO00996912345678', 'GB29TRWI23147012345678']
  for (const iban of neobanks) {
    assert.equal(kind({ description: 'FV 12/2026', counterparty: 'JAN TESTOWY PROJEKTOWANIE', counterparty_iban: iban }), 'unknown', iban)
    assert.equal(kind({ op_code: '340', op_label: 'PRZELEW SEPA WYCHODZĄCY', description: 'INVOICE 12', counterparty: 'SAMPLE STUDIO', counterparty_iban: iban }), 'unknown', `${iban} (SEPA)`)
  }
  // zwykły bank zagraniczny w tym samym kraju nadal jest przelewem zagranicznym
  assert.equal(kind({ description: 'INVOICE 12', counterparty: 'UAB PAVYZDYS', counterparty_iban: 'LT121000011101001000' }), 'foreign_transfer')
  // pensja na rachunek w Revolucie to nadal pensja; znany dostawca nadal jest dostawcą
  assert.equal(kind({ description: 'WYNAGRODZENIE 9/2026', counterparty: 'JAN TESTOWY', counterparty_iban: 'LT123250012345678901' }, {}), 'salary')
  assert.equal(kind({ description: 'INVOICE 55', counterparty: 'HETZNER ONLINE GMBH', counterparty_iban: 'BE68967123456789' }), 'foreign_vendor')
})

test('foreign_transfer NIE: zakup kartą / BLIK, opłata, gotówka i wpływ — nawet na rachunku walutowym', () => {
  assert.equal(kind({ currency: 'EUR', op_code: '114', op_label: 'ZAKUP PRZY UŻYCIU KARTY', description: 'RESTAURANT BEISPIEL/BERLIN DATA TRANSAKCJI: 2026-09-01', counterparty: '' }), 'unknown')
  assert.equal(kind({ currency: 'EUR', op_code: 'C01', op_label: 'BLIK ZAKUP', description: 'SKLEP', counterparty: '' }), 'unknown')
  assert.equal(kind({ currency: 'EUR', op_code: '27A', op_label: 'OPŁATA ZA PROWADZENIE R', counterparty: '' }), 'bank_fee')
  assert.equal(kind({ currency: 'EUR', op_code: 'W02', op_label: 'WYPŁATA W BANKOMACIE', description: 'ATM BERLIN', counterparty: '' }), 'unknown')
  assert.equal(kind({ currency: 'EUR', op_code: 'A60', op_label: 'OBCIĄŻ. NATYCH. TRANSAK', counterparty: '' }), 'internal', 'wymiana walut')
  assert.equal(kind({ op_code: '150', op_label: 'PRZELEW ZEWNĘTRZNY PRZY', description: 'PAYMENT INV 9', counterparty: 'MUSTER TECHNIK GMBH', counterparty_iban: DE_IBAN, amount: 4000 }), 'unknown', 'wpływ od klienta z zagranicy')
  assert.equal(kind({ currency: 'EUR', op_code: '150', op_label: 'PRZELEW ZEWNĘTRZNY PRZY', description: 'PAYMENT INV 9', counterparty: 'MUSTER TECHNIK GMBH', amount: 4000 }), 'unknown')
})

// ── 8. Nierozpoznane + wyciąg bez subpól ──────────────────────────────────────

test('unknown: zakup kartą w polskim sklepie i zwykła płatność za fakturę → ga/other/auto, do decyzji', () => {
  const c = cls({ op_code: '114', op_label: 'ZAKUP PRZY UŻYCIU KARTY', description: 'SKLEP BUDOWLANY KAS/WARSZAWA DATA TRANSAKCJI: 2026-09-01', counterparty: '', counterparty_iban: '', amount: -140.64 })
  assert.deepEqual(
    { kind: c.kind, cost_category: c.cost_category, subcategory: c.subcategory, business_unit: c.business_unit, pnl_mode: c.pnl_mode, period: c.period, not_invoice_payment: c.not_invoice_payment, label: c.label },
    { kind: 'unknown', cost_category: 'ga', subcategory: 'other', business_unit: 'shared', pnl_mode: 'auto', period: null, not_invoice_payment: false, label: 'Nierozpoznany' },
  )
  assert.equal(kind({ op_code: 'C22', op_label: 'BLIK ZAKUP E-COMMERCE', description: 'SKLEP-PRZYKLAD.PL', counterparty: '' }), 'unknown')
  assert.equal(kind({ description: 'FV 123/09/2026', counterparty: 'DOSTAWCA TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN }), 'unknown')
  assert.equal(kind({ op_code: '306', op_label: 'PRZELEW ZEWNĘTRZNY WYCH', description: 'RATA LEASINGOWA 09/2026 UMOWA 12345', counterparty: 'LEASING TESTOWY S.A.', counterparty_iban: PL_IBAN }), 'unknown')
  assert.equal(kind({ op_code: '088', op_label: 'PRZELEW ZEWNĘTRZNY WYCH', description: 'ZAJĘCIE EGZEKUCYJNE SYGN. KM 1/26', counterparty: '' }), 'unknown')
  assert.equal(kind({ op_code: '150', op_label: 'PRZELEW ZEWNĘTRZNY PRZY', description: 'ZAPŁATA ZA FV 5/2026', counterparty: 'KLIENT TESTOWY SP. Z O.O.', counterparty_iban: PL_IBAN, amount: 12300 }), 'unknown')
  // puste / brakujące pola nie wywracają klasyfikatora
  assert.equal(classifyBankTransfer({ date: '', amount: 0, description: '', counterparty: '' }).kind, 'unknown')
  assert.equal(classifyBankTransfer({ date: '2026-10-01', amount: -5, description: null as any, counterparty: undefined as any, counterparty_iban: null, op_code: null, op_label: null, currency: null }).kind, 'unknown')
})

test('wyciąg bez subpól (inny bank): cały tekst :86: w tytule, bez kodu operacji — instytucje rozpoznawane także z tytułu', () => {
  const raw = (description: string, extra: Partial<ClassifyInput> = {}) => cls({ op_code: '', op_label: '', counterparty: '', counterparty_iban: '', description, ...extra })
  const zus = raw('ZAKLAD UBEZPIECZEN SPOLECZNYCH SKLADKI 09/2026', { date: '2026-10-15' })
  assert.equal(zus.kind, 'zus')
  assert.equal(zus.period, '2026-09')
  assert.equal(raw('URZAD SKARBOWY WARSZAWA CIT-8 ZALICZKA 08/2026', { date: '2026-09-18' }).kind, 'tax_cit')
  assert.equal(raw('/TI/N5210000000/OKR/26M09/SFP/PIT-4/TXT/', { counterparty_iban: TAX_IBAN, date: '2026-10-20' }).kind, 'tax_pit4')
  assert.equal(raw('OPŁATA ZA PROWADZENIE RACHUNKU').kind, 'bank_fee')
  assert.equal(raw('WYNAGRODZENIE 9/2026 JAN TESTOWY').kind, 'salary')
  assert.equal(raw('WYNAGRODZENIE ZA USLUGI 9/2026 ALFA SERWIS SP. Z O.O.').kind, 'unknown', 'firma w tekście')
  // kwota dodatnia bez kodu operacji = uznanie → nie wynagrodzenie i nie przelew zagraniczny
  assert.equal(raw('WYNAGRODZENIE 9/2026 JAN TESTOWY', { amount: 6500 }).kind, 'unknown')
  assert.equal(raw('PAYMENT INVOICE 9', { amount: 900, counterparty: 'MUSTER GMBH', counterparty_iban: DE_IBAN }).kind, 'unknown')
  assert.equal(raw('PAYMENT INVOICE 9', { amount: -900, counterparty: 'MUSTER GMBH', counterparty_iban: DE_IBAN }).kind, 'foreign_transfer')
})
