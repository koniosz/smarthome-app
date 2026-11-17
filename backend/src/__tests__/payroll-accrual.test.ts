/**
 * Testy czystego modułu kosztów pracy memoriałowo (bez bazy): przypisanie pensji / ZUS / PIT-4 do miesięcy
 * i szacunek ZUS / PIT-4 za miesiące jeszcze nieopłacone. Dane w pełni syntetyczne.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/payroll-accrual.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocatePayroll, payrollGroupOf,
  type PayrollCost, type PayrollMonth, ESTIMATE_MAX_AGE_MONTHS, LUMP_COVER_SHARE,
} from '../services/payroll-accrual'

let seq = 0
const cost = (subcategory: string, date: string, amount: number, period: string | null = null, id?: string): PayrollCost =>
  ({ id: id ?? `c${++seq}`, date, period, subcategory, amount })
const sal = (date: string, amount: number, period: string | null = null, id?: string) => cost('salary_gross', date, amount, period, id)
const zus = (date: string, amount: number, period: string | null = null, id?: string) => cost('zus_employer', date, amount, period, id)
const pit = (date: string, amount: number, period: string | null = null, id?: string) => cost('salary_pit', date, amount, period, id)

const month = (period: string, v: Partial<Omit<PayrollMonth, 'period'>> = {}): PayrollMonth =>
  ({ period, salaries: 0, pit: 0, zus: 0, zus_estimate: 0, pit_estimate: 0, ...v })
const keys = (r: { months: Map<string, PayrollMonth> }) => [...r.months.keys()]

/** Trzy „zamknięte" miesiące: pensja 10 000, ZUS 5 000 (50 %), PIT-4 800 (8 %) — każdy przelew z okresem w tytule. */
const history = (periods: string[]): PayrollCost[] => periods.flatMap(p => {
  const [y, m] = p.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return [sal(`${p}-28`, 10000, p), zus(`${next}-15`, 5000, p), pit(`${next}-20`, 800, p)]
})

describe('wejście brzegowe', () => {
  test('puste wejście → puste mapy', () => {
    const r = allocatePayroll([], { today: '2026-11' })
    assert.equal(r.monthOf.size, 0)
    assert.equal(r.months.size, 0)
  })

  test('payrollGroupOf: podkategorie płacowe i cała reszta', () => {
    assert.equal(payrollGroupOf('salary_gross'), 'salaries')
    assert.equal(payrollGroupOf('salary_admin'), 'salaries')
    assert.equal(payrollGroupOf('salary_civil'), 'salaries')
    assert.equal(payrollGroupOf('salary_pit'), 'pit')
    assert.equal(payrollGroupOf('zus_employer'), 'zus')
    for (const s of ['bank_fee', 'tax_vat', 'tax_income', 'other', '', 'toString', 'constructor', null, undefined]) {
      assert.equal(payrollGroupOf(s), null, String(s))
    }
  })

  test('inne podkategorie, zła data i nieliczbowa kwota są pomijane', () => {
    const r = allocatePayroll([
      cost('bank_fee', '2026-09-30', 12, null, 'fee'),
      cost('tax_vat', '2026-09-25', 4000, '2026-08', 'vat'),
      cost('tax_income', '2026-09-20', 900, null, 'cit'),
      sal('2026-13-01', 100, null, 'bad-month'),
      sal('30.09.2026', 100, null, 'bad-format'),
      sal('', 100, null, 'no-date'),
      sal('2026-09-30', Number.NaN, null, 'nan'),
      sal('2026-09-30', 7000, null, 'ok'),
    ], { today: '2026-11' })
    assert.deepEqual([...r.monthOf], [['ok', '2026-09']])
    assert.deepEqual([...r.months.values()], [month('2026-09', { salaries: 7000 })])
  })

  test('salary_admin i salary_civil liczą się do pensji; data ISO z godziną też jest czytana', () => {
    const r = allocatePayroll([
      cost('salary_gross', '2026-09-30', 5000),
      cost('salary_admin', '2026-09-30T10:15:00.000Z', 3000),
      cost('salary_civil', '2026-09-29', 1500),
    ], { today: '2026-11' })
    assert.deepEqual([...r.months.values()], [month('2026-09', { salaries: 9500 })])
  })

  test('kwoty sumowane w groszach — bez dryfu zmiennoprzecinkowego', () => {
    const r = allocatePayroll([sal('2026-09-30', 0.1), sal('2026-09-30', 0.2), sal('2026-09-29', 1234.56)], { today: '2026-11' })
    assert.equal(r.months.get('2026-09')!.salaries, 1234.86)
  })

  test('miesiąc bez żadnej kwoty nie trafia do `months`, ale koszt ma swój miesiąc w `monthOf`', () => {
    const r = allocatePayroll([sal('2026-09-30', 0, null, 'zero')], { today: '2026-11' })
    assert.equal(r.months.size, 0)
    assert.equal(r.monthOf.get('zero'), '2026-09')
  })
})

describe('krok 1 — miesiąc kosztu', () => {
  test('same pensje: po 15. → miesiąc przelewu, do 15. → miesiąc poprzedni; bez historii nie ma szacunków', () => {
    const r = allocatePayroll([
      sal('2026-09-30', 6000, null, 'a'),
      sal('2026-10-02', 4000, null, 'b'),   // druga część pensji za wrzesień
      sal('2026-10-15', 500, null, 'c'),    // 15. dzień jeszcze „za poprzedni"
      sal('2026-10-16', 700, null, 'd'),    // 16. dzień już „za bieżący"
      sal('2026-10-30', 6000, null, 'e'),
    ], { today: '2026-11' })
    assert.deepEqual(Object.fromEntries(r.monthOf), { a: '2026-09', b: '2026-09', c: '2026-09', d: '2026-10', e: '2026-10' })
    assert.deepEqual([...r.months.values()], [
      month('2026-09', { salaries: 10500 }),
      month('2026-10', { salaries: 6700 }),
    ])
  })

  test('spóźnione przelewy z okresem w tytule: miesiąc z tytułu, nie z daty', () => {
    const r = allocatePayroll([
      zus('2026-10-12', 5000, '2026-07', 'z'),   // DRA za lipiec zapłacona w październiku
      pit('2026-10-20', 800, '2026-06', 'p'),    // PIT-4 za czerwiec zapłacony w październiku
      sal('2026-10-05', 9000, '2026-08', 's'),   // pensja za sierpień; reguła daty dałaby wrzesień
    ], { today: '2026-11', estimate: false })
    assert.deepEqual(Object.fromEntries(r.monthOf), { z: '2026-07', p: '2026-06', s: '2026-08' })
    assert.deepEqual(keys(r), ['2026-06', '2026-07', '2026-08'])
    assert.equal(r.months.get('2026-07')!.zus, 5000)
    assert.equal(r.months.get('2026-06')!.pit, 800)
    assert.equal(r.months.get('2026-08')!.salaries, 9000)
    assert.equal(r.months.has('2026-10'), false)
  })

  test('PIT-4 bez okresu → miesiąc poprzedni', () => {
    const r = allocatePayroll([pit('2026-10-20', 800, null, 'p1'), pit('2026-10-31', 50, null, 'p2')], { today: '2026-11' })
    assert.deepEqual(Object.fromEntries(r.monthOf), { p1: '2026-09', p2: '2026-09' })
    assert.equal(r.months.get('2026-09')!.pit, 850)
  })

  test('niepoprawny okres jest ignorowany (działa reguła daty)', () => {
    const bad = ['2026-13', '2026-00', '09/2026', '2026-9', '26M09', '', 'abc', '2026-09-01']
    const costs = bad.map((p, i) => sal('2026-10-30', 100, p, `bad${i}`))
    const r = allocatePayroll(costs, { today: '2026-11' })
    for (let i = 0; i < bad.length; i++) assert.equal(r.monthOf.get(`bad${i}`), '2026-10', bad[i])
    assert.equal(r.months.get('2026-10')!.salaries, 100 * bad.length)
    // typ spoza kontraktu (np. liczba z bazy) też nie wywraca modułu
    const weird = allocatePayroll([{ ...sal('2026-10-30', 100, null, 'w'), period: 202609 as unknown as string }], { today: '2026-11' })
    assert.equal(weird.monthOf.get('w'), '2026-10')
  })

  test('okres spoza wiarygodnego zakresu: > miesiąc przelewu + 1 albo starszy niż 36 miesięcy → ignorowany', () => {
    const r = allocatePayroll([
      sal('2026-10-30', 100, '2026-11', 'plus1'),     // zaliczka na następny miesiąc — dozwolone
      sal('2026-10-30', 100, '2026-12', 'plus2'),     // za daleko w przód → reguła daty (październik)
      zus('2026-10-12', 100, '2023-10', 'minus36'),   // dokładnie 36 miesięcy wstecz — dozwolone
      pit('2026-10-20', 100, '2023-09', 'minus37'),   // 37 miesięcy wstecz → reguła daty (wrzesień 2026)
    ], { today: '2026-12', estimate: false })
    assert.deepEqual(Object.fromEntries(r.monthOf), {
      plus1: '2026-11', plus2: '2026-10', minus36: '2023-10', minus37: '2026-09',
    })
  })

  test('przełom roku: pensja za grudzień wypłacona 2 stycznia, ZUS i PIT-4 za grudzień w styczniu', () => {
    const r = allocatePayroll([
      sal('2026-11-30', 9000, null, 's11'),
      zus('2026-12-15', 4500, '2026-11', 'z11'),
      pit('2026-12-18', 700, '2026-11', 'p11'),
      sal('2027-01-02', 9000, null, 's12'),          // do 15. → grudzień 2026
      zus('2027-01-15', 4600, null, 'z12'),          // bez okresu → najstarszy niepokryty z pensjami = grudzień
      pit('2027-01-20', 720, null, 'p12'),           // bez okresu → miesiąc poprzedni = grudzień
    ], { today: '2027-01' })
    assert.deepEqual(Object.fromEntries(r.monthOf), {
      s11: '2026-11', z11: '2026-11', p11: '2026-11', s12: '2026-12', z12: '2026-12', p12: '2026-12',
    })
    assert.deepEqual([...r.months.values()], [
      month('2026-11', { salaries: 9000, zus: 4500, pit: 700 }),
      month('2026-12', { salaries: 9000, zus: 4600, pit: 720 }),
    ])
  })

  test('przełom roku z okresem w tytule: „12/2026" zapłacone w styczniu 2027', () => {
    const r = allocatePayroll([
      sal('2027-01-02', 9000, '2026-12', 's'),
      zus('2027-01-15', 4600, '2026-12', 'z'),
      pit('2027-01-20', 720, '2026-12', 'p'),
    ], { today: '2027-01' })
    assert.deepEqual([...r.months.values()], [month('2026-12', { salaries: 9000, zus: 4600, pit: 720 })])
  })
})

describe('krok 2 — ZUS bez okresu w tytule', () => {
  test('dwa przelewy za ten sam miesiąc: pensja w dwóch częściach, ZUS główny + mała dopłata', () => {
    const r = allocatePayroll([
      sal('2026-09-30', 6000, '2026-09', 's1'),
      sal('2026-10-02', 4000, '2026-09', 's2'),
      zus('2026-10-15', 5000, '2026-09', 'main'),
      zus('2026-10-15', 62.4, null, 'small'),        // odsetki / opłata — bez okresu → miesiąc przelewu − 1
    ], { today: '2026-11' })
    assert.equal(r.monthOf.get('small'), '2026-09')
    assert.deepEqual([...r.months.values()], [month('2026-09', { salaries: 10000, zus: 5062.4 })])
  })

  test('przelew bez okresu wypełnia NAJSTARSZY niepokryty miesiąc z pensjami', () => {
    const r = allocatePayroll([
      sal('2026-06-30', 10000), sal('2026-07-31', 10000), sal('2026-08-31', 10000), sal('2026-09-30', 10000),
      zus('2026-07-15', 5000, '2026-06', 'jun'),
      zus('2026-10-10', 5200, null, 'a'),            // czerwiec pokryty → lipiec
      zus('2026-10-25', 5100, null, 'b'),            // lipiec już pokryty → sierpień
    ], { today: '2026-10' })
    assert.equal(r.monthOf.get('a'), '2026-07')
    assert.equal(r.monthOf.get('b'), '2026-08')
    assert.equal(r.months.get('2026-07')!.zus, 5200)
    assert.equal(r.months.get('2026-08')!.zus, 5100)
    // wrzesień nadal bez przelewu → szacunek ze wskaźnika (5000 + 5200 + 5100) / 30000 = 0,51
    assert.deepEqual(r.months.get('2026-09'), month('2026-09', { salaries: 10000, zus_estimate: 5100 }))
    for (const p of ['2026-06', '2026-07', '2026-08']) assert.equal(r.months.get(p)!.zus_estimate, 0, p)
  })

  test('wszystko pokryte → przelew bez okresu idzie do miesiąca poprzedniego', () => {
    const r = allocatePayroll([
      sal('2026-08-31', 10000), sal('2026-09-30', 10000),
      zus('2026-09-15', 5000, '2026-08'),
      zus('2026-10-15', 5000, '2026-09'),
      zus('2026-10-20', 5000, null, 'extra'),
    ], { today: '2026-10' })
    assert.equal(r.monthOf.get('extra'), '2026-09')
    assert.equal(r.months.get('2026-08')!.zus, 5000)
    assert.equal(r.months.get('2026-09')!.zus, 10000)
  })

  test('brak pensji w ogóle → przelew bez okresu idzie do miesiąca poprzedniego', () => {
    const r = allocatePayroll([zus('2026-10-15', 5000, null, 'z')], { today: '2026-11' })
    assert.equal(r.monthOf.get('z'), '2026-09')
    assert.deepEqual([...r.months.values()], [month('2026-09', { zus: 5000 })])
  })

  test('okno 6 miesięcy: miesiąc −6 jeszcze się łapie, −7 już nie', () => {
    const inWindow = allocatePayroll([sal('2026-03-31', 10000), zus('2026-09-10', 5000, null, 'z')], { today: '2026-09' })
    assert.equal(inWindow.monthOf.get('z'), '2026-03')

    const outOfWindow = allocatePayroll([sal('2026-02-27', 10000), zus('2026-09-10', 5000, null, 'z')], { today: '2026-09' })
    assert.equal(outOfWindow.monthOf.get('z'), '2026-08')
    // sierpień jest „pokryty", ale nie ma pensji → nie jest miesiącem odniesienia → luty bez szacunku
    assert.deepEqual([...outOfWindow.months.values()], [
      month('2026-02', { salaries: 10000 }),
      month('2026-08', { zus: 5000 }),
    ])
  })

  test('miesiąc bieżący przelewu nigdy nie jest celem (ZUS płaci się za miesiące minione)', () => {
    const r = allocatePayroll([sal('2026-10-05', 10000, '2026-10'), zus('2026-10-20', 5000, null, 'z')], { today: '2026-10' })
    assert.equal(r.monthOf.get('z'), '2026-09')
  })

  test('mała wpłata nigdy nie pokrywa miesiąca — przelew główny i tak trafia do niego, a nie dalej', () => {
    const r = allocatePayroll([
      sal('2026-07-31', 10000), sal('2026-08-31', 10000),
      zus('2026-08-15', 5000, '2026-07'),
      zus('2026-09-03', 55, null, 'small'),          // → sierpień (miesiąc przelewu − 1), nie pokrywa
      zus('2026-09-20', 5000, null, 'main'),         // sierpień nadal niepokryty → sierpień
    ], { today: '2026-09' })
    assert.equal(r.monthOf.get('small'), '2026-08')
    assert.equal(r.monthOf.get('main'), '2026-08')
    assert.deepEqual(r.months.get('2026-08'), month('2026-08', { salaries: 10000, zus: 5055 }))
  })

  test('mała wpłata Z okresem w tytule też nie pokrywa miesiąca', () => {
    const r = allocatePayroll([
      ...history(['2026-06', '2026-07']),
      sal('2026-08-31', 10000),
      zus('2026-09-15', 60, '2026-08', 'small'),
    ], { today: '2026-09' })
    // mediana wpłat z okresem = 5000 → 60 zł nie jest przelewem głównym → sierpień dalej szacowany (5000 − 60)
    assert.deepEqual(r.months.get('2026-08'), month('2026-08', { salaries: 10000, zus: 60, zus_estimate: 4940, pit_estimate: 800 }))
  })

  test('próg przelewu głównego: dokładnie 50 % mediany jest główny, grosz mniej — nie', () => {
    const base = [
      sal('2026-06-30', 10000), sal('2026-07-31', 10000),
      zus('2026-07-15', 6000, '2026-06'),             // jedyna wpłata z okresem → mediana 6000, próg 3000
    ]
    const atThreshold = allocatePayroll([...base, zus('2026-09-10', 3000, null, 'z')], { today: '2026-09' })
    assert.equal(atThreshold.monthOf.get('z'), '2026-07')        // główny → najstarszy niepokryty
    const below = allocatePayroll([...base, zus('2026-09-10', 2999.99, null, 'z')], { today: '2026-09' })
    assert.equal(below.monthOf.get('z'), '2026-08')              // mały → miesiąc przelewu − 1
  })

  test('żaden przelew nie ma okresu → mediana ze wszystkich wpłat', () => {
    const r = allocatePayroll([
      sal('2026-06-30', 10000), sal('2026-07-31', 10000), sal('2026-08-31', 10000),
      zus('2026-07-15', 5000, null, 'a'),
      zus('2026-08-17', 5200, null, 'b'),
      zus('2026-08-17', 60, null, 'odsetki'),        // mediana (5000, 5200, 60) = 5000 → 60 zł to mała wpłata
    ], { today: '2026-08' })
    assert.equal(r.monthOf.get('a'), '2026-06')
    assert.equal(r.monthOf.get('b'), '2026-07')
    assert.equal(r.monthOf.get('odsetki'), '2026-07')
    assert.deepEqual(r.months.get('2026-06'), month('2026-06', { salaries: 10000, zus: 5000 }))
    assert.deepEqual(r.months.get('2026-07'), month('2026-07', { salaries: 10000, zus: 5260 }))
    // sierpień (miesiąc bieżący, pensje wypłacone) → szacunek ze wskaźnika (5000 + 5260) / 20000
    assert.equal(r.months.get('2026-08')!.zus_estimate, 5130)
  })

  test('przelew z okresem pokrywa swój miesiąc także wtedy, gdy zapłacono go PÓŹNIEJ niż przelew bez okresu', () => {
    const r = allocatePayroll([
      sal('2026-07-31', 10000), sal('2026-08-31', 10000),
      zus('2026-09-10', 5000, null, 'bez'),          // lipiec jest pokryty przelewem z 5 października → sierpień
      zus('2026-10-05', 5000, '2026-07', 'lipiec'),
    ], { today: '2026-10' })
    assert.equal(r.monthOf.get('bez'), '2026-08')
    assert.equal(r.months.get('2026-07')!.zus, 5000)
    assert.equal(r.months.get('2026-08')!.zus, 5000)
  })
})

describe('krok 3 — szacunki', () => {
  test('miesiąc z pensjami bez ZUS i PIT-4 dostaje szacunek ze wskaźników poprzednich miesięcy', () => {
    const r = allocatePayroll([
      sal('2026-07-31', 10000), zus('2026-08-15', 5000, '2026-07'), pit('2026-08-20', 800, '2026-07'),
      sal('2026-08-31', 12000), zus('2026-09-15', 6000, '2026-08'), pit('2026-09-20', 960, '2026-08'),
      sal('2026-09-30', 11000),
    ], { today: '2026-10' })
    // ZUS: 11000 / 22000 = 0,5; PIT-4: 1760 / 22000 = 0,08
    assert.deepEqual(r.months.get('2026-09'), month('2026-09', { salaries: 11000, zus_estimate: 5500, pit_estimate: 880 }))
    assert.deepEqual(r.months.get('2026-07'), month('2026-07', { salaries: 10000, zus: 5000, pit: 800 }))
    assert.deepEqual(r.months.get('2026-08'), month('2026-08', { salaries: 12000, zus: 6000, pit: 960 }))
  })

  test('szacunek znika, gdy pojawi się prawdziwy przelew (zastępuje go kwota rzeczywista)', () => {
    const base = [...history(['2026-07', '2026-08']), sal('2026-09-30', 10000)]
    const before = allocatePayroll(base, { today: '2026-10' })
    assert.deepEqual(before.months.get('2026-09'), month('2026-09', { salaries: 10000, zus_estimate: 5000, pit_estimate: 800 }))

    const zusPaid = allocatePayroll([...base, zus('2026-10-15', 5400, '2026-09')], { today: '2026-10' })
    assert.deepEqual(zusPaid.months.get('2026-09'), month('2026-09', { salaries: 10000, zus: 5400, pit_estimate: 800 }))

    const bothPaid = allocatePayroll([...base, zus('2026-10-15', 5400, '2026-09'), pit('2026-10-20', 870, '2026-09')], { today: '2026-10' })
    assert.deepEqual(bothPaid.months.get('2026-09'), month('2026-09', { salaries: 10000, zus: 5400, pit: 870 }))

    // to samo, gdy przelew do ZUS nie ma okresu w tytule (wypełnia najstarszy niepokryty = wrzesień)
    const titleless = allocatePayroll([...base, zus('2026-10-15', 5400, null)], { today: '2026-10' })
    assert.deepEqual(titleless.months.get('2026-09'), month('2026-09', { salaries: 10000, zus: 5400, pit_estimate: 800 }))
  })

  test('szacunek pomniejsza się o ZUS już przypisany do miesiąca (mała wpłata) i nie schodzi poniżej zera', () => {
    const base = [...history(['2026-07', '2026-08']), sal('2026-09-30', 10000)]
    const r = allocatePayroll([...base, zus('2026-10-03', 60, null)], { today: '2026-10' })
    assert.deepEqual(r.months.get('2026-09'), month('2026-09', { salaries: 10000, zus: 60, zus_estimate: 4940, pit_estimate: 800 }))

    // dużo małych wpłat (każda < 50 % mediany) — łącznie ponad szacunek → 0, nigdy ujemny
    const many = allocatePayroll([...base, zus('2026-10-03', 2400, null), zus('2026-10-04', 2400, null), zus('2026-10-05', 2400, null)], { today: '2026-10' })
    assert.equal(many.months.get('2026-09')!.zus, 7200)
    assert.equal(many.months.get('2026-09')!.zus_estimate, 0)
  })

  test('miesiąc bieżący: szacunek dopiero, gdy pensje zostały wypłacone; miesiące po `today` — bez szacunku', () => {
    const base = [...history(['2026-07', '2026-08']), sal('2026-09-30', 10000)]
    const noOctober = allocatePayroll(base, { today: '2026-10' })
    assert.deepEqual(keys(noOctober), ['2026-07', '2026-08', '2026-09'])

    const withOctober = allocatePayroll([...base, sal('2026-10-30', 5000)], { today: '2026-10' })
    assert.deepEqual(withOctober.months.get('2026-10'), month('2026-10', { salaries: 5000, zus_estimate: 2500, pit_estimate: 400 }))

    // zaliczka na listopad wypłacona w październiku: pensja w listopadzie, ale szacunku jeszcze nie ma
    const advance = allocatePayroll([...base, sal('2026-10-30', 3000, '2026-11')], { today: '2026-10' })
    assert.deepEqual(advance.months.get('2026-11'), month('2026-11', { salaries: 3000 }))
    // miesiąc później ten sam listopad już jest szacowany
    const later = allocatePayroll([...base, sal('2026-10-30', 3000, '2026-11')], { today: '2026-11' })
    assert.deepEqual(later.months.get('2026-11'), month('2026-11', { salaries: 3000, zus_estimate: 1500, pit_estimate: 240 }))
  })

  test('estimate: false → przypisanie bez zmian, szacunki zerowe', () => {
    const base = [...history(['2026-07', '2026-08']), sal('2026-09-30', 10000, null, 'sep')]
    const off = allocatePayroll(base, { today: '2026-10', estimate: false })
    const on = allocatePayroll(base, { today: '2026-10' })
    assert.deepEqual([...off.monthOf], [...on.monthOf])
    assert.deepEqual(off.months.get('2026-09'), month('2026-09', { salaries: 10000 }))
    for (const m of off.months.values()) { assert.equal(m.zus_estimate, 0); assert.equal(m.pit_estimate, 0) }
    // estimate: true i brak pola znaczą to samo
    assert.deepEqual([...allocatePayroll(base, { today: '2026-10', estimate: true }).months], [...on.months])
  })

  test('brak miesięcy odniesienia → 0 (osobno dla ZUS i PIT-4)', () => {
    // jest historia ZUS, nie ma żadnego PIT-4 → szacunek tylko ZUS
    const r = allocatePayroll([
      sal('2026-08-31', 10000), zus('2026-09-15', 5000, '2026-08'),
      sal('2026-09-30', 10000),
    ], { today: '2026-10' })
    assert.deepEqual(r.months.get('2026-09'), month('2026-09', { salaries: 10000, zus_estimate: 5000 }))
    assert.equal(r.months.get('2026-08')!.pit_estimate, 0)
  })

  test('PIT-4: miesiącami odniesienia są tylko miesiące z zapłaconym PIT-4 i pensjami', () => {
    const r = allocatePayroll([
      sal('2026-06-30', 10000), pit('2026-07-20', 500, '2026-06'),
      sal('2026-07-31', 10000),                                     // PIT-4 za lipiec niezapłacony → nie jest odniesieniem
      pit('2026-08-20', 9999, '2026-05'),                           // PIT-4 za maj bez pensji w danych → nie jest odniesieniem
      sal('2026-08-31', 10000), pit('2026-09-20', 700, '2026-08'),
      sal('2026-09-30', 20000),
    ], { today: '2026-10' })
    // wskaźnik = (500 + 700) / 20000 = 0,06
    assert.equal(r.months.get('2026-07')!.pit_estimate, 600)
    assert.equal(r.months.get('2026-09')!.pit_estimate, 1200)
    assert.equal(r.months.get('2026-06')!.pit_estimate, 0)
    assert.equal(r.months.get('2026-08')!.pit_estimate, 0)
    assert.deepEqual(r.months.get('2026-05'), month('2026-05', { pit: 9999 }))
  })

  test('miesiące odniesienia: maks. 6 najbliższych WCZEŚNIEJSZYCH, późniejsze nie są brane, gdy wcześniejszych wystarcza', () => {
    const costs: PayrollCost[] = []
    const add = (p: string, zusAmount: number) => { costs.push(sal(`${p}-28`, 10000, p), zus(`${p}-28`, zusAmount, p)) }
    add('2025-11', 10000); add('2025-12', 10000)                    // 2 najstarsze — wskaźnik 1,0 (poza szóstką)
    for (const p of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) add(p, 5000)   // wskaźnik 0,5
    costs.push(sal('2026-07-28', 10000, '2026-07'))                 // miesiąc szacowany
    add('2026-08', 7000)                                            // późniejszy — wskaźnik 0,7 (niebrany; za mały na wpłatę zbiorczą)
    const r = allocatePayroll(costs, { today: '2026-09' })
    assert.equal(r.months.get('2026-07')!.zus_estimate, 5000)
  })

  test('miesiące odniesienia: gdy wcześniejszych jest mniej niż 6 — dobierane są najbliższe późniejsze', () => {
    const costs: PayrollCost[] = []
    const add = (p: string, zusAmount: number) => { costs.push(sal(`${p}-28`, 10000, p), zus(`${p}-28`, zusAmount, p)) }
    add('2026-01', 5000); add('2026-02', 5000)                      // 2 wcześniejsze — 0,5
    costs.push(sal('2026-03-28', 12000, '2026-03'))                 // miesiąc szacowany
    for (const p of ['2026-04', '2026-05', '2026-06', '2026-07']) add(p, 10000)   // 4 późniejsze — 1,0
    add('2026-08', 14000)                                           // siódmy z kolei — niebrany (za mały na wpłatę zbiorczą)
    const r = allocatePayroll(costs, { today: '2026-09' })
    // wskaźnik = (2 × 5000 + 4 × 10000) / 60000 = 5/6 → 12000 × 5/6 = 10000
    assert.equal(r.months.get('2026-03')!.zus_estimate, 10000)
  })

  test('tylko późniejsze miesiące odniesienia (początek historii) też dają szacunek', () => {
    const r = allocatePayroll([sal('2026-06-30', 8000), ...history(['2026-07', '2026-08'])], { today: '2026-10' })
    assert.deepEqual(r.months.get('2026-06'), month('2026-06', { salaries: 8000, zus_estimate: 4000, pit_estimate: 640 }))
  })

  test('szacunek zaokrąglany do groszy', () => {
    const r = allocatePayroll([
      sal('2026-08-31', 3000), zus('2026-09-15', 1000, '2026-08'), pit('2026-09-20', 200, '2026-08'),
      sal('2026-09-30', 3333.33),
    ], { today: '2026-10' })
    assert.equal(r.months.get('2026-09')!.zus_estimate, 1111.11)    // 3333,33 / 3
    assert.equal(r.months.get('2026-09')!.pit_estimate, 222.22)     // 3333,33 / 15
  })

  test('`today` niepoprawne → bez szacunków; `today` jako pełna data → brany miesiąc', () => {
    const base = [...history(['2026-07', '2026-08']), sal('2026-09-30', 10000)]
    for (const today of ['', 'dzisiaj', '2026-13']) {
      const r = allocatePayroll(base, { today })
      assert.deepEqual(r.months.get('2026-09'), month('2026-09', { salaries: 10000 }), today)
    }
    const full = allocatePayroll(base, { today: '2026-10-16' })
    assert.equal(full.months.get('2026-09')!.zus_estimate, 5000)
    // raport „na dzień" z przeszłości: wrzesień jest po `today` → bez szacunku
    const past = allocatePayroll(base, { today: '2026-08' })
    assert.deepEqual(past.months.get('2026-09'), month('2026-09', { salaries: 10000 }))
  })
})

describe('niezmienniki', () => {
  const scenario = (): PayrollCost[] => [
    sal('2026-05-29', 9000, null, 's05'),
    sal('2026-06-30', 6000, '2026-06', 's06a'),
    sal('2026-07-02', 3500, '2026-06', 's06b'),
    sal('2026-07-31', 9500, null, 's07'),
    sal('2026-09-01', 9800, null, 's08'),
    sal('2026-09-30', 9900, '2026-09', 's09'),
    cost('salary_admin', '2026-09-30', 2000, null, 'adm09'),
    cost('salary_civil', '2026-10-10', 1500, null, 'civ09'),
    zus('2026-06-15', 4500, '2026-05', 'z05'),
    zus('2026-10-12', 4700, '2026-06', 'z06'),
    zus('2026-10-20', 5300, null, 'zb'),            // ten sam dzień, dwa przelewy bez okresu
    zus('2026-10-20', 5100, null, 'za'),
    zus('2026-10-21', 58.33, null, 'zs'),
    pit('2026-06-20', 700, '2026-05', 'p05'),
    pit('2026-10-20', 720, null, 'p09'),
    cost('bank_fee', '2026-10-20', 9, null, 'fee'),
  ]

  test('suma kwot przypisanych do miesięcy = suma kwot wejściowych; każdy koszt płacowy ma miesiąc', () => {
    const costs = scenario()
    const r = allocatePayroll(costs, { today: '2026-10' })
    const payroll = costs.filter(c => payrollGroupOf(c.subcategory))
    assert.equal(r.monthOf.size, payroll.length)
    assert.equal(r.monthOf.has('fee'), false)
    const cents = (n: number) => Math.round(n * 100)
    const inSum = payroll.reduce((s, c) => s + cents(c.amount), 0)
    const outSum = [...r.months.values()].reduce((s, m) => s + cents(m.salaries) + cents(m.pit) + cents(m.zus), 0)
    assert.equal(outSum, inSum)
    assert.deepEqual(keys(r), [...keys(r)].sort())     // miesiące rosnąco
    for (const [k, m] of r.months) assert.equal(m.period, k)
  })

  test('wynik nie zależy od kolejności wejścia (remis dat rozstrzyga id)', () => {
    const costs = scenario()
    const ref = allocatePayroll(costs, { today: '2026-10' })
    // remis 20 października: „za" < „zb" → „za" bierze starszy niepokryty miesiąc (lipiec), „zb" następny (sierpień)
    assert.equal(ref.monthOf.get('za'), '2026-07')
    assert.equal(ref.monthOf.get('zb'), '2026-08')
    assert.equal(ref.monthOf.get('zs'), '2026-09')

    const snapshot = (r: ReturnType<typeof allocatePayroll>) => JSON.stringify({
      monthOf: [...r.monthOf].sort((a, b) => a[0].localeCompare(b[0])),
      months: [...r.months],
    })
    const expected = snapshot(ref)

    const permutations: PayrollCost[][] = [[...costs].reverse()]
    for (let k = 1; k < costs.length; k++) permutations.push([...costs.slice(k), ...costs.slice(0, k)])
    let seed = 12345                                   // deterministyczne tasowanie (LCG) — test powtarzalny
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let n = 0; n < 50; n++) {
      const a = [...costs]
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
      permutations.push(a)
    }
    for (const p of permutations) assert.equal(snapshot(allocatePayroll(p, { today: '2026-10' })), expected)
  })

  test('wejście nie jest modyfikowane', () => {
    const costs = scenario()
    const copy = JSON.parse(JSON.stringify(costs))
    allocatePayroll(costs, { today: '2026-10' })
    assert.deepEqual(costs, copy)
  })
})

describe('wpłata zbiorcza do ZUS i wygasanie szacunku', () => {
  // pensje 20 000 co miesiąc; ZUS 12 000 (wskaźnik 0,6) z okresem w tytule dla kwietnia, maja i sierpnia
  const base = (): PayrollCost[] => [
    ...['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map(p => sal(`${p}-28`, 20000, p)),
    zus('2026-05-15', 12000, '2026-04'), zus('2026-06-15', 12000, '2026-05'), zus('2026-09-15', 12000, '2026-08'),
  ]

  test('jeden przelew BEZ okresu za dwa zaległe miesiące pokrywa oba — żaden nie dostaje szacunku na zawsze', () => {
    const r = allocatePayroll([...base(), zus('2026-09-10', 24000, null, 'lump')], { today: '2026-10' })
    assert.equal(r.monthOf.get('lump'), '2026-06')                  // najstarszy niepokryty miesiąc
    assert.equal(r.months.get('2026-06')!.zus, 24000)               // kwota zostaje w jednym miesiącu…
    assert.equal(r.months.get('2026-07')!.zus, 0)
    assert.equal(r.months.get('2026-06')!.zus_estimate, 0)
    assert.equal(r.months.get('2026-07')!.zus_estimate, 0)          // …ale lipiec jest pokryty: bez szacunku
    // razem ZUS = dokładnie to, co zapłacono (5 miesięcy × 12 000), bez fantomowego szacunku
    const total = [...r.months.values()].reduce((s, m) => s + m.zus + m.zus_estimate, 0)
    assert.equal(total, 60000)
  })

  test('przelew Z okresem, wyraźnie większy niż składki tego miesiąca, spłaca też starszą zaległość', () => {
    const r = allocatePayroll([...base(), zus('2026-08-20', 24000, '2026-07', 'lump')], { today: '2026-10' })
    assert.equal(r.monthOf.get('lump'), '2026-07')
    assert.equal(r.months.get('2026-06')!.zus_estimate, 0)          // czerwiec pokryty nadwyżką z lipcowego przelewu
    assert.equal(r.months.get('2026-07')!.zus_estimate, 0)
  })

  test('miesiąc z premią (wyższe pensje → proporcjonalnie wyższy ZUS) NIE jest brany za wpłatę zbiorczą', () => {
    const costs = [
      ...base(),
      sal('2026-06-29', 15000, '2026-06', 'premia'),                // czerwiec: pensje 35 000 → ZUS 21 000 przy wskaźniku 0,6
      zus('2026-07-15', 21000, '2026-06'),
    ]
    const r = allocatePayroll(costs, { today: '2026-10' })
    // lipiec nadal niepokryty → dostaje szacunek (0,6 × 20 000), nie znika przez „zbiorczą" wpłatę czerwcową
    assert.equal(r.months.get('2026-07')!.zus_estimate, 12000)
    assert.equal(r.months.get('2026-06')!.zus_estimate, 0)
  })

  test('miesiąc z wpłatą zbiorczą nie zawyża wskaźnika do szacunku innych miesięcy', () => {
    const costs = [...base(), zus('2026-09-10', 24000, null, 'lump'), sal('2026-09-28', 20000, '2026-09')]
    const r = allocatePayroll(costs, { today: '2026-10' })
    // wrzesień bez przelewu: szacunek ze zwykłego wskaźnika 0,6 (czerwiec z 24 000 jest poza odniesieniem)
    assert.equal(r.months.get('2026-09')!.zus_estimate, 12000)
  })

  test('bez przelewów z okresem w tytule nie zgadujemy wpłaty zbiorczej (zachowanie jak dotąd)', () => {
    const costs = [
      sal('2026-06-28', 20000, '2026-06'), sal('2026-07-28', 20000, '2026-07'),
      zus('2026-09-10', 24000, null, 'x'),
    ]
    const r = allocatePayroll(costs, { today: '2026-10' })
    assert.equal(r.monthOf.get('x'), '2026-06')
    // lipiec nie ma miary („ile powinno być") — nie jest uznany za pokryty; brak miesięcy odniesienia poza czerwcem
    assert.ok(r.months.get('2026-07')!.zus_estimate > 0)
  })

  test('szacunek nie jest dopisywany miesiącom starszym niż rok — to raczej brak danych niż zaległość', () => {
    const costs = [
      sal('2025-03-28', 20000, '2025-03'),                          // bez ZUS, ponad rok temu
      sal('2026-06-28', 20000, '2026-06'), zus('2026-07-15', 12000, '2026-06'),
      sal('2026-07-28', 20000, '2026-07'),                          // bez ZUS, świeży
    ]
    const r = allocatePayroll(costs, { today: '2026-10' })
    assert.equal(r.months.get('2025-03')!.zus_estimate, 0)
    assert.equal(r.months.get('2026-07')!.zus_estimate, 12000)
    assert.equal(ESTIMATE_MAX_AGE_MONTHS, 12)
    assert.equal(LUMP_COVER_SHARE, 0.5)
  })
})
