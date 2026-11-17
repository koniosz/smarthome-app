/**
 * Koszty pracy memoriałowo: do którego miesiąca należy każdy przelew płacowy z wyciągu (pensja, ZUS, PIT-4)
 * + szacunek ZUS i PIT-4 za miesiące, za które przelewu jeszcze nie było.
 *
 * Po co: pensje wychodzą pod koniec miesiąca, ale ZUS i PIT-4 za miesiąc M są płatne w połowie M+1, a w praktyce
 * bywają płacone z kilkumiesięcznym opóźnieniem. RZiS liczony po dacie przelewu pokazywałby kilka miesięcy ZUS
 * w jednym miesiącu i zero w pozostałych, a raport za poprzedni miesiąc (wysyłany 1. dnia) zawsze byłby bez
 * ZUS i PIT-4 tego miesiąca — czyli bez ok. 35–40 % kosztu pracy.
 *
 * Moduł jest CZYSTY (bez bazy, bez importów). Wejście przygotowuje wywołujący: tylko koszty, które wchodzą do
 * RZiS, w PLN, z podkategorią:
 *   salary_gross | salary_admin | salary_civil → „salaries" (przelewy wynagrodzeń),
 *   salary_pit                                 → „pit"      (zaliczka PIT-4),
 *   zus_employer                               → „zus"      (przelew do ZUS).
 * Inne podkategorie, wiersze bez poprawnej daty (YYYY-MM-DD) i z nieliczbową kwotą są pomijane (nie trafiają do
 * `monthOf` — wywołujący zostaje wtedy przy swoim miesiącu z daty).
 *
 * ALGORYTM
 * Krok 1 — miesiąc kosztu:
 *   • okres z tytułu przelewu (`period` = YYYY-MM: „26M09 PIT-4", „DRA 01.07.2026", „WYNAGRODZENIE 9/2026") wygrywa,
 *     o ile jest wiarygodny: nie późniejszy niż miesiąc przelewu + 1 i nie starszy niż 36 miesięcy od przelewu;
 *     okres niepoprawny lub spoza tego zakresu traktujemy jak brak okresu;
 *   • pensja bez okresu: przelew do 15. dnia miesiąca → miesiąc poprzedni, po 15. → miesiąc przelewu;
 *   • PIT-4 bez okresu → miesiąc poprzedni;
 *   • ZUS bez okresu → krok 2.
 * Krok 2 — ZUS bez okresu w tytule („WPŁATA DO ZUS", „SKŁADKI ZUS"), w kolejności dat przelewów:
 *   • mediana = mediana kwot przelewów do ZUS, które MAJĄ okres w tytule (gdy żaden nie ma — mediana wszystkich);
 *   • przelew „główny" = kwota ≥ 50 % mediany; mniejsze to odsetki / opłaty / dopłaty;
 *   • miesiąc jest „pokryty", gdy przypisano do niego przelew główny. Przelewy główne z okresem w tytule pokrywają
 *     swoje miesiące od razu — niezależnie od daty przelewu (okres z tytułu to fakt, a nie zgadywanie);
 *   • przelew główny bez okresu: spośród miesięcy od (miesiąc przelewu − 6) do (miesiąc przelewu − 1), w których
 *     były pensje i które nie są pokryte, bierzemy NAJSTARSZY (ZUS sam zalicza wpłatę na najstarszą zaległość);
 *     gdy takiego nie ma → miesiąc przelewu − 1;
 *   • mały przelew bez okresu → miesiąc przelewu − 1 i nigdy nie „pokrywa" miesiąca.
 * Krok 3 — szacunki (gdy `opts.estimate !== false`), dla każdego miesiąca M ≤ `opts.today`, w którym były pensje:
 *   • `zus_estimate`, gdy M nie jest pokryty: wskaźnik = Σ ZUS / Σ pensji z maks. 6 pokrytych miesięcy najbliższych M
 *     (najpierw wcześniejsze — od najbliższego wstecz, potem późniejsze — od najbliższego w przód; tylko miesiące
 *     z pensjami > 0); szacunek = max(0, wskaźnik × pensje(M) − ZUS już przypisany do M);
 *   • `pit_estimate`, gdy PIT-4 za M = 0: tak samo, miesiącami odniesienia są te z PIT-4 > 0;
 *   • brak miesięcy odniesienia → 0 (nie zgadujemy stawek); miesiące po `opts.today` — bez szacunku.
 *   Gdy przelew za M wreszcie się pojawi, miesiąc staje się pokryty i szacunek znika (zastępuje go kwota rzeczywista).
 *
 * OGRANICZENIA — to SZACUNEK, źródłem prawdy jest lista płac i deklaracje u księgowej:
 *   • „salaries" to przelewy netto do pracowników, a nie wynagrodzenia brutto z listy płac; wskaźnik ZUS/pensje
 *     i PIT/pensje jest empiryczny (z historii przelewów tej firmy), nie ustawowy — zmiana składu zespołu,
 *     premie, zwolnienia lekarskie, ulgi podatkowe czy przekroczenie progu przesuwają go z miesiąca na miesiąc;
 *   • miesiąc, w którym PIT-4 faktycznie wyniósł 0 zł (ulgi), dostanie szacunek, bo nie da się go odróżnić od
 *     miesiąca nieopłaconego; podobnie ZUS zapłacony częściowo (jedna „główna" rata) uznajemy za zapłacony w całości;
 *   • przelew do ZUS bez okresu w tytule przypisujemy heurystycznie (najstarsza zaległość z ostatnich 6 miesięcy) —
 *     ZUS może go rozliczyć inaczej; zaległości starsze niż 6 miesięcy nie są w ten sposób zamykane;
 *   • gdy żaden przelew do ZUS nie ma okresu, a małych wpłat (odsetek) jest więcej niż głównych, mediana wyjdzie
 *     zaniżona i małe wpłaty zostaną uznane za główne;
 *   • pensje wypłacone gotówką / z rachunku, którego wyciągu nie wgrano, nie istnieją dla modułu — miesiąc bez
 *     pensji nie dostaje szacunku, a miesiąc z niepełnymi pensjami zawyża wskaźnik;
 *   • szacujemy tylko ZUS i PIT-4, NIE same pensje: raport liczony, zanim pensje wyjdą lub zanim wgrano wyciąg
 *     z ich przelewami (np. 1. dnia miesiąca, gdy pensje idą 1.–2.), pokaże miesiąc bez kosztu pracy albo
 *     z kosztem zaniżonym — to wywołujący powinien wtedy ostrzec („brak pensji za miesiąc");
 *   • deklaracje (DRA, PIT-4) składa się za miesiąc WYPŁATY pensji: pensja za wrzesień wypłacona 1.–2. października
 *     trafia tu do września (reguła 15. dnia / okres z tytułu), a jej ZUS i PIT-4 — z okresem z deklaracji — do
 *     października. W skali roku suma się zgadza, pojedyncze miesiące mogą być przesunięte o jeden;
 *   • na początku wgranej historii (pierwszy wyciąg) miesiąc może mieć pensję, ale nie mieć widocznego przelewu
 *     ZUS / PIT-4 zapłaconego wcześniej — dostanie wtedy szacunek, choć zobowiązanie jest uregulowane;
 *   • wynik zależy od `opts.today` i od wgranych wyciągów: po dograniu przelewu kwoty miesięcy mogą się przesunąć.
 */

// ── Kontrakt ────────────────────────────────────────────────────────────────
export interface PayrollCost {
  id: string
  date: string            // data przelewu YYYY-MM-DD
  period: string | null   // miesiąc z tytułu przelewu (YYYY-MM) albo null
  subcategory: string     // salary_gross | salary_admin | salary_civil | salary_pit | zus_employer
  amount: number          // PLN, dodatnia
}

export interface PayrollMonth {
  period: string          // YYYY-MM
  salaries: number        // przelewy wynagrodzeń przypisane do miesiąca
  pit: number             // zapłacony PIT-4 za ten miesiąc
  zus: number             // zapłacony ZUS za ten miesiąc
  zus_estimate: number    // szacunek ZUS jeszcze niezapłaconego (0, gdy miesiąc pokryty)
  pit_estimate: number    // szacunek PIT-4 jeszcze niezapłaconego (0, gdy PIT-4 zapłacony)
}

export interface PayrollAllocation {
  monthOf: Map<string, string>          // id kosztu → miesiąc memoriałowy YYYY-MM
  months: Map<string, PayrollMonth>     // miesiąc → kwoty; klucze rosnąco
}

export type PayrollGroup = 'salaries' | 'pit' | 'zus'

// ── Parametry heurystyk ─────────────────────────────────────────────────────
/** Pensja bez okresu wypłacona do tego dnia miesiąca (włącznie) należy do miesiąca poprzedniego. */
export const SALARY_PREV_MONTH_MAX_DAY = 15
/** Okres z tytułu może wyprzedzać miesiąc przelewu najwyżej o tyle miesięcy… */
export const PERIOD_MAX_MONTHS_AHEAD = 1
/** …i być starszy od niego najwyżej o tyle. */
export const PERIOD_MAX_MONTHS_BACK = 36
/** Ile miesięcy wstecz szukamy niepokrytego miesiąca dla przelewu do ZUS bez okresu. */
export const ZUS_LOOKBACK_MONTHS = 6
/** Przelew do ZUS jest „główny", gdy kwota ≥ ten ułamek mediany. */
export const ZUS_MAIN_SHARE = 0.5
/** Z ilu miesięcy odniesienia (najbliższych) liczymy wskaźnik do szacunku. */
export const ESTIMATE_REFERENCE_MONTHS = 6
/** Wpłata zbiorcza pokrywa kolejny miesiąc, gdy po odjęciu składek „swojego" miesiąca zostaje ≥ tej części składek należnych za następny. */
export const LUMP_COVER_SHARE = 0.5
/** Szacunku nie dopisujemy miesiącom starszym niż tyle miesięcy wstecz od bieżącego (to raczej brak danych niż zaległość). */
export const ESTIMATE_MAX_AGE_MONTHS = 12

const GROUP_BY_SUBCATEGORY: Record<string, PayrollGroup> = {
  salary_gross: 'salaries',
  salary_admin: 'salaries',
  salary_civil: 'salaries',
  salary_pit: 'pit',
  zus_employer: 'zus',
}

/** Grupa płacowa podkategorii kosztu albo null, gdy koszt nie jest kosztem pracy. */
export function payrollGroupOf(subcategory: string | null | undefined): PayrollGroup | null {
  const key = String(subcategory ?? '')
  return Object.prototype.hasOwnProperty.call(GROUP_BY_SUBCATEGORY, key) ? GROUP_BY_SUBCATEGORY[key] : null
}

// ── Miesiące jako liczby (rok × 12 + miesiąc − 1) — arytmetyka bez Date i stref czasowych ──
function periodToIndex(period: unknown): number | null {
  if (typeof period !== 'string') return null
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period.trim())
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null
}

function indexToPeriod(index: number): string {
  const y = Math.floor(index / 12)
  return `${String(y).padStart(4, '0')}-${String(index - y * 12 + 1).padStart(2, '0')}`
}

function parseDate(date: unknown): { key: string; month: number; day: number } | null {
  if (typeof date !== 'string') return null
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.exec(date.trim())
  if (!m) return null
  return { key: m[0], month: Number(m[1]) * 12 + Number(m[2]) - 1, day: Number(m[3]) }
}

/** Mediana (dla parzystej liczby — średnia dwóch środkowych); pusta lista → 0. */
function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function cmp<T extends string | number>(a: T, b: T): number { return a < b ? -1 : a > b ? 1 : 0 }

// Kwoty liczymy w groszach (liczby całkowite) — bez dryfu zmiennoprzecinkowego przy sumowaniu.
interface Row {
  id: string
  group: PayrollGroup
  dateKey: string           // YYYY-MM-DD
  payMonth: number          // miesiąc przelewu (indeks)
  day: number
  explicit: number | null   // wiarygodny okres z tytułu (indeks) albo null
  cents: number
}

interface MonthAcc { salaries: number; pit: number; zus: number; zusEst: number; pitEst: number }

/** Maks. `ESTIMATE_REFERENCE_MONTHS` miesięcy odniesienia: najpierw wcześniejsze (od najbliższego), potem późniejsze. */
function referenceMonths(month: number, sortedRefs: number[]): number[] {
  const earlier = sortedRefs.filter(r => r < month).reverse()
  const later = sortedRefs.filter(r => r > month)
  return [...earlier, ...later].slice(0, ESTIMATE_REFERENCE_MONTHS)
}

export function allocatePayroll(
  costs: PayrollCost[],
  opts: { today: string /* YYYY-MM */; estimate?: boolean },
): PayrollAllocation {
  // ── Normalizacja wejścia ──
  const rows: Row[] = []
  for (const c of costs ?? []) {
    if (!c) continue
    const group = payrollGroupOf(c.subcategory)
    if (!group) continue
    const d = parseDate(c.date)
    const amount = Number(c.amount)
    if (!d || !Number.isFinite(amount)) continue
    const p = periodToIndex(c.period)
    const explicit = p !== null && p <= d.month + PERIOD_MAX_MONTHS_AHEAD && p >= d.month - PERIOD_MAX_MONTHS_BACK ? p : null
    rows.push({ id: String(c.id), group, dateKey: d.key, payMonth: d.month, day: d.day, explicit, cents: Math.round(amount * 100) })
  }
  // Stała kolejność niezależnie od kolejności wejścia: data przelewu, potem id (i reszta pól na wypadek duplikatów id).
  rows.sort((a, b) =>
    cmp(a.dateKey, b.dateKey) || cmp(a.id, b.id) || cmp(a.group, b.group) || cmp(a.cents, b.cents) || cmp(a.explicit ?? -1, b.explicit ?? -1))

  const monthOf = new Map<string, string>()
  const acc = new Map<number, MonthAcc>()
  const accOf = (month: number): MonthAcc => {
    let a = acc.get(month)
    if (!a) { a = { salaries: 0, pit: 0, zus: 0, zusEst: 0, pitEst: 0 }; acc.set(month, a) }
    return a
  }
  const assign = (r: Row, month: number) => {
    accOf(month)[r.group] += r.cents
    monthOf.set(r.id, indexToPeriod(month))
  }

  // ── Krok 1: okres z tytułu / reguła daty ──
  const zusWithoutPeriod: Row[] = []
  for (const r of rows) {
    if (r.explicit !== null) assign(r, r.explicit)
    else if (r.group === 'salaries') assign(r, r.day <= SALARY_PREV_MONTH_MAX_DAY ? r.payMonth - 1 : r.payMonth)
    else if (r.group === 'pit') assign(r, r.payMonth - 1)
    else zusWithoutPeriod.push(r)
  }

  // ── Krok 2: ZUS bez okresu → najstarszy niepokryty miesiąc z pensjami ──
  const zusPositive = rows.filter(r => r.group === 'zus' && r.cents > 0)
  const zusWithPeriod = zusPositive.filter(r => r.explicit !== null)
  const zusMedian = median((zusWithPeriod.length ? zusWithPeriod : zusPositive).map(r => r.cents))
  const isMain = (r: Row) => r.cents > 0 && r.cents >= ZUS_MAIN_SHARE * zusMedian

  const covered = new Set<number>()
  for (const r of zusWithPeriod) if (isMain(r)) covered.add(r.explicit as number)

  // Wpłata ZBIORCZA (jeden przelew za dwa–trzy zaległe miesiące — ZUS ma jeden rachunek składkowy, więc to normalne):
  // przelew wyraźnie większy niż składki należne za „swój" miesiąc pokrywa też kolejne niepokryte miesiące z pensjami.
  // Miarą jest stosunek ZUS do pensji z przelewów z okresem w tytule (mediana), liczony od pensji DANEGO miesiąca —
  // dzięki temu miesiąc z premią (wyższe pensje → wyższy ZUS) nie jest brany za dwa miesiące. Bez takiej miary
  // (brak przelewów z okresem) nie zgadujemy. Kwota zostaje w miesiącu, do którego przelew przypisano; kolejne
  // miesiące są tylko „pokryte", czyli nie dostają szacunku — inaczej szacunek wisiałby w wyniku na zawsze.
  const salariesOf = (m: number) => acc.get(m)?.salaries ?? 0
  const ratios = zusWithPeriod
    .filter(r => isMain(r) && salariesOf(r.explicit as number) > 0)
    .map(r => r.cents / salariesOf(r.explicit as number))
  const baseRatio = ratios.length ? median(ratios) : 0
  const lumpMonths = new Set<number>()            // miesiące, w których siedzi wpłata zbiorcza (zawyżają wskaźnik — poza odniesieniem)
  const coverExtra = (r: Row, target: number, candidates: number[]) => {
    if (baseRatio <= 0 || salariesOf(target) <= 0) return
    let remaining = r.cents - baseRatio * salariesOf(target)
    for (const m of candidates) {
      if (covered.has(m)) continue
      const expected = baseRatio * salariesOf(m)
      if (expected <= 0) continue
      if (remaining < LUMP_COVER_SHARE * expected) break
      covered.add(m)
      lumpMonths.add(target)
      remaining -= expected
    }
  }
  // przelew z okresem w tytule: nadwyżka spłaca najpierw STARSZE zaległości (ZUS rozlicza od najstarszych)
  for (const r of zusWithPeriod) {
    if (!isMain(r)) continue
    const target = r.explicit as number
    const older: number[] = []
    for (let m = target - 1; m >= target - ZUS_LOOKBACK_MONTHS; m--) older.push(m)
    coverExtra(r, target, older)
  }

  for (const r of zusWithoutPeriod) {            // `rows` są już posortowane po dacie przelewu
    let target = r.payMonth - 1
    if (isMain(r)) {
      for (let m = r.payMonth - ZUS_LOOKBACK_MONTHS; m <= r.payMonth - 1; m++) {
        if (!covered.has(m) && salariesOf(m) > 0) { target = m; break }
      }
      covered.add(target)
    }
    assign(r, target)
    if (isMain(r)) {
      // przelew bez okresu: nadwyżka idzie na KOLEJNE niepokryte miesiące (od najstarszego), ale nie późniejsze niż poprzedzający przelew
      const next: number[] = []
      for (let m = target + 1; m <= r.payMonth - 1; m++) next.push(m)
      coverExtra(r, target, next)
    }
  }

  // ── Krok 3: szacunek ZUS / PIT-4 za miesiące z pensjami, ale bez przelewu ──
  const today = periodToIndex(String(opts?.today ?? '').trim().slice(0, 7))
  if (opts?.estimate !== false && today !== null) {
    const sortedMonths = [...acc.keys()].sort((a, b) => a - b)
    // miesiąc z wpłatą zbiorczą ma ZUS za kilka miesięcy przy pensjach jednego — nie jest miarą „zwykłego" stosunku
    const zusRefs = sortedMonths.filter(m => { const a = acc.get(m)!; return covered.has(m) && !lumpMonths.has(m) && a.salaries > 0 && a.zus > 0 })
    const pitRefs = sortedMonths.filter(m => { const a = acc.get(m)!; return a.pit > 0 && a.salaries > 0 })
    const estimate = (month: number, refs: number[], key: 'zus' | 'pit'): number => {
      const picked = referenceMonths(month, refs)
      let num = 0, den = 0
      for (const r of picked) { const a = acc.get(r)!; num += a[key]; den += a.salaries }
      if (den <= 0) return 0
      const a = acc.get(month)!
      return Math.max(0, Math.round(num / den * a.salaries - a[key]))
    }
    for (const m of sortedMonths) {
      const a = acc.get(m)!
      if (m > today || a.salaries <= 0) continue
      // szacunek dotyczy przelewów, które DOPIERO przyjdą; miesiąc sprzed ponad roku bez przelewu to raczej brak danych
      // (niewgrany wyciąg, inny rachunek) niż zaległość — nie dopisujemy mu szacunku bezterminowo
      if (m < today - ESTIMATE_MAX_AGE_MONTHS) continue
      if (!covered.has(m)) a.zusEst = estimate(m, zusRefs, 'zus')
      if (a.pit <= 0) a.pitEst = estimate(m, pitRefs, 'pit')
    }
  }

  // ── Wynik: miesiące rosnąco, kwoty w zł do groszy; miesiące bez żadnej kwoty pomijamy ──
  const months = new Map<string, PayrollMonth>()
  for (const m of [...acc.keys()].sort((a, b) => a - b)) {
    const a = acc.get(m)!
    if (!a.salaries && !a.pit && !a.zus && !a.zusEst && !a.pitEst) continue
    const period = indexToPeriod(m)
    months.set(period, {
      period,
      salaries: a.salaries / 100,
      pit: a.pit / 100,
      zus: a.zus / 100,
      zus_estimate: a.zusEst / 100,
      pit_estimate: a.pitEst / 100,
    })
  }
  return { monthOf, months }
}
