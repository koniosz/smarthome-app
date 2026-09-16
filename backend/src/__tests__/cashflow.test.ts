/**
 * Prognoza gotówki — logika czysta: terminy wpływów/wypływów (przeterminowane → +7 / +3 dni),
 * „stałe" wypływy z historii MT940 (średnia z 3 miesięcy, mediana dnia), projekcja dzień po dniu,
 * minimum i ostrzeżenia.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/cashflow.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectCashflow, computeRecurring, expectedInflowDate, expectedOutflowDate, addDays, daysBetween, isoDate } from '../routes/cashflow'

test('addDays / daysBetween: przełom miesiąca i roku (UTC)', () => {
  assert.equal(addDays('2026-01-30', 3), '2026-02-02')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(daysBetween('2026-09-15', '2026-09-18'), 3)
  assert.equal(daysBetween('2026-09-18', '2026-09-15'), -3)
})

test('addDays / daysBetween / isoDate: daty spoza YYYY-MM-DD nie wywalają prognozy (RangeError)', () => {
  // format polski, pusty string, datetime z sufiksem ISO
  assert.equal(addDays('15.08.2026', 14), '', 'nie-ISO → "" (brak terminu)')
  assert.equal(addDays('', 14), '')
  assert.equal(addDays('2026-08-15T00:00:00.000Z', 14), '2026-08-29', 'sufiks czasu tolerowany')
  assert.equal(daysBetween('15.08.2026', '2026-09-15'), 0)
  assert.equal(daysBetween('2026-09-15', ''), 0)
  assert.equal(daysBetween('2026-09-10T12:00:00Z', '2026-09-15'), 5)
  assert.equal(isoDate('2026-08-15'), '2026-08-15')
  assert.equal(isoDate('2026-08-15T00:00:00.000Z'), '2026-08-15')
  assert.equal(isoDate('15.08.2026'), '')
  assert.equal(isoDate(null), '')
  assert.equal(isoDate(undefined), '')
  // ścieżka routera: zły sale_date + brak due_date → jak brak terminu → +14 dni od dziś, bez wyjątku
  const due = isoDate('') || addDays(isoDate('15.08.2026'), 14)
  assert.equal(due, '')
  assert.deepEqual(expectedInflowDate(due, '2026-09-15'), { date: '2026-09-29', overdue: false })
  // zły balance_date → brak ostrzeżenia o starym saldzie i brak wyjątku
  const p = projectCashflow({ as_of: '2026-09-15', days: 7, start_balance: 500, balance_date: '20.08.2026', receivables: [], payables: [], recurring: [] })
  assert.equal(p.warnings.length, 0)
})

test('expectedInflowDate: termin, przeterminowany → +7 dni, brak terminu → +14 dni', () => {
  assert.deepEqual(expectedInflowDate('2026-09-20', '2026-09-15'), { date: '2026-09-20', overdue: false })
  assert.deepEqual(expectedInflowDate('2026-09-15', '2026-09-15'), { date: '2026-09-15', overdue: false })
  assert.deepEqual(expectedInflowDate('2026-09-01', '2026-09-15'), { date: '2026-09-22', overdue: true })
  assert.deepEqual(expectedInflowDate('', '2026-09-15'), { date: '2026-09-29', overdue: false })
})

test('expectedOutflowDate: przeterminowany → +3 dni', () => {
  assert.deepEqual(expectedOutflowDate('2026-09-01', '2026-09-15'), { date: '2026-09-18', overdue: true })
  assert.deepEqual(expectedOutflowDate('2026-10-01', '2026-09-15'), { date: '2026-10-01', overdue: false })
})

test('computeRecurring: średnia z podanych miesięcy (Σ/3) i mediana dnia; obce podkategorie i miesiące pomijane', () => {
  const months = ['2026-06', '2026-07', '2026-08']
  const costs = [
    { date: '2026-06-15', amount: 1000, subcategory: 'zus_employer' },
    { date: '2026-07-14', amount: 1100, subcategory: 'zus_employer' },
    { date: '2026-08-16', amount: 1200, subcategory: 'zus_employer' },
    { date: '2026-08-10', amount: 5000, subcategory: 'salary_gross' },
    { date: '2026-08-10', amount: 3000, subcategory: 'salary_gross' }, // dwie pensje tego samego dnia
    { date: '2026-05-15', amount: 9999, subcategory: 'zus_employer' }, // poza zakresem
    { date: '2026-07-01', amount: 700, subcategory: 'software' },      // nie „stałe"
  ]
  const rec = computeRecurring(costs, months)
  assert.deepEqual(rec.map(r => r.subcategory), ['salary_gross', 'zus_employer'])
  const zus = rec.find(r => r.subcategory === 'zus_employer')!
  assert.equal(zus.amount, 1100)
  assert.equal(zus.day_of_month, 15)
  const sal = rec.find(r => r.subcategory === 'salary_gross')!
  assert.equal(sal.amount, Math.round(8000 / 3 * 100) / 100, 'jeden miesiąc z pensjami → średnia z 3')
  assert.equal(sal.day_of_month, 10)
  assert.ok(sal.label.length > 0)
  assert.deepEqual(computeRecurring(costs, []), [])
})

const BASE = {
  as_of: '2026-09-15',
  days: 30,
  start_balance: 10000,
  receivables: [
    { label: 'FV 1 · Klient A', amount: 5000, due_date: '2026-09-20' },
    { label: 'FV 2 · Klient B', amount: 1000, due_date: '2026-09-10' }, // przeterminowana → 22.09
    { label: 'FV 3 · Klient C', amount: 99999, due_date: '2026-12-01' }, // poza horyzontem
  ],
  payables: [
    { label: 'Dostawca X · F/1', amount: 3000, due_date: '2026-09-18' },
    { label: 'Dostawca Y · F/2', amount: 2000, due_date: '2026-09-01' }, // przeterminowana → 18.09
  ],
  recurring: [{ label: 'ZUS', amount: 4000, day_of_month: 15, subcategory: 'zus_employer' }],
}

test('projectCashflow: saldo dzień po dniu, minimum, koniec, pozycje w dniach', () => {
  const p = projectCashflow(BASE)
  assert.equal(p.days.length, 31, 'dzień 0 (dziś) + 30 dni')
  assert.equal(p.days[0].date, '2026-09-15')
  assert.equal(p.days[30].date, '2026-10-15')

  const byDate = new Map(p.days.map(d => [d.date, d]))
  // 15.09: ZUS 4000 (dzień wypłaty = dziś) → 6000
  assert.equal(byDate.get('2026-09-15')!.outflow, 4000)
  assert.equal(byDate.get('2026-09-15')!.balance, 6000)
  // 18.09: faktura 3000 + przeterminowana 2000 (+3 dni) → 1000
  assert.equal(byDate.get('2026-09-18')!.outflow, 5000)
  assert.equal(byDate.get('2026-09-18')!.balance, 1000)
  assert.deepEqual(byDate.get('2026-09-18')!.items.map(i => i.kind), ['payable', 'payable'])
  // 20.09: wpływ 5000 → 6000; 22.09: przeterminowana należność (+7 dni) 1000 → 7000
  assert.equal(byDate.get('2026-09-20')!.inflow, 5000)
  assert.equal(byDate.get('2026-09-22')!.inflow, 1000)
  assert.equal(byDate.get('2026-09-22')!.balance, 7000)
  // 15.10: kolejny ZUS → 3000
  assert.equal(byDate.get('2026-10-15')!.outflow, 4000)
  assert.equal(p.end_balance, 3000)
  assert.deepEqual(p.min, { date: '2026-09-18', balance: 1000 })

  // listy: tylko pozycje w horyzoncie, przeterminowane oznaczone
  assert.equal(p.receivables.length, 2)
  assert.equal(p.receivables.find(r => r.label.startsWith('FV 2'))!.overdue, true)
  assert.equal(p.payables.find(r => r.label.startsWith('Dostawca Y'))!.overdue, true)
  assert.equal(p.recurring.length, 1)
  // brak ujemnego salda → brak ostrzeżenia o gotówce; jest info o przeterminowanych
  assert.ok(!p.warnings.some(w => w.includes('zabraknąć')))
  assert.ok(p.warnings.some(w => w.includes('przeterminowanych')))
})

test('projectCashflow: „stałe" już opłacone w bieżącym miesiącu nie są liczone drugi raz', () => {
  const p = projectCashflow({ ...BASE, paid_this_month: ['zus_employer'] })
  const byDate = new Map(p.days.map(d => [d.date, d]))
  assert.equal(byDate.get('2026-09-15')!.outflow, 0)
  assert.equal(byDate.get('2026-10-15')!.outflow, 4000, 'następny miesiąc nadal prognozowany')
  assert.equal(p.end_balance, 7000)
  assert.deepEqual(p.min, { date: '2026-09-18', balance: 5000 })
})

test('projectCashflow: ujemne minimum → ostrzeżenie „Za N dni może zabraknąć gotówki"', () => {
  const p = projectCashflow({
    as_of: '2026-09-15', days: 7, start_balance: 1000, receivables: [], recurring: [],
    payables: [{ label: 'Duża faktura', amount: 5000, due_date: '2026-09-17' }],
  })
  assert.deepEqual(p.min, { date: '2026-09-17', balance: -4000 })
  assert.ok(p.warnings.some(w => w.startsWith('Za 2 dni może zabraknąć gotówki')), p.warnings.join(' | '))
})

test('projectCashflow: brak sald → start 0 + ostrzeżenie; stare saldo → ostrzeżenie o nowszym wyciągu', () => {
  const none = projectCashflow({ as_of: '2026-09-15', days: 7, start_balance: null, receivables: [], payables: [], recurring: [] })
  assert.equal(none.days[0].balance, 0)
  assert.ok(none.warnings.includes('Brak sald — wgraj wyciąg MT940'))

  const stale = projectCashflow({ as_of: '2026-09-15', days: 7, start_balance: 500, balance_date: '2026-08-20', receivables: [], payables: [], recurring: [] })
  assert.ok(stale.warnings.some(w => w.includes('nowszy wyciąg')))
  const fresh = projectCashflow({ as_of: '2026-09-15', days: 7, start_balance: 500, balance_date: '2026-09-12', receivables: [], payables: [], recurring: [] })
  assert.equal(fresh.warnings.length, 0)
})

test('projectCashflow: horyzont ograniczony do 7–90 dni; dzień wypłaty przycięty do długości miesiąca', () => {
  assert.equal(projectCashflow({ ...BASE, days: 200 }).days.length, 91)
  assert.equal(projectCashflow({ ...BASE, days: 1 }).days.length, 8)
  const p = projectCashflow({
    as_of: '2026-02-20', days: 30, start_balance: 0, receivables: [], payables: [],
    recurring: [{ label: 'Czynsz', amount: 100, day_of_month: 31, subcategory: 'rent' }],
  })
  const feb = p.days.find(d => d.date === '2026-02-28')!
  assert.equal(feb.outflow, 100, 'luty: 31 → 28')
  assert.equal(p.days.find(d => d.date === '2026-03-21')!.balance, -100)
})
