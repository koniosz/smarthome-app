/**
 * Testy czystej wyceny magazynu (bez bazy): docs/finance-automation-spec.md §C.
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/inventory-valuation.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeValuation, computeCurrentValuation, computeMonthlyChanges,
  periodEndExclusive, prevPeriod, movementDelta,
  type ValuationItem, type ValuationMovement,
} from '../services/inventory-valuation'

const item = (id: string, quantity: number, unit_price: number): ValuationItem => ({ id, quantity, unit_price })
const mv = (warehouse_item_id: string, type: string, quantity: number, created_at: string, unit_price = 0): ValuationMovement =>
  ({ warehouse_item_id, type, quantity, unit_price, created_at })

describe('okresy i granice miesiąca (Europe/Warsaw)', () => {
  test('prevPeriod przechodzi przez rok', () => {
    assert.equal(prevPeriod('2026-01'), '2025-12')
    assert.equal(prevPeriod('2026-08'), '2026-07')
  })

  test('koniec miesiąca latem = 22:00 UTC, zimą = 23:00 UTC', () => {
    assert.equal(periodEndExclusive('2026-08'), '2026-08-31T22:00:00.000Z')
    assert.equal(periodEndExclusive('2026-12'), '2026-12-31T23:00:00.000Z')
    assert.equal(periodEndExclusive('2026-02'), '2026-02-28T23:00:00.000Z')
  })

  test('movementDelta: in/initial dodają, out odejmuje, adjust ze znakiem, nieznany 0', () => {
    assert.equal(movementDelta({ type: 'in', quantity: 3 }), 3)
    assert.equal(movementDelta({ type: 'initial', quantity: 5 }), 5)
    assert.equal(movementDelta({ type: 'out', quantity: 2 }), -2)
    assert.equal(movementDelta({ type: 'adjust', quantity: -4 }), -4)
    assert.equal(movementDelta({ type: 'adjust', quantity: 1.5 }), 1.5)
    assert.equal(movementDelta({ type: 'foo', quantity: 9 }), 0)
  })
})

describe('computeValuation', () => {
  test('brak pozycji i ruchów → 0', () => {
    const v = computeValuation([], [], ['2026-08'])
    assert.deepEqual(v.get('2026-08'), { value: 0, unpriced_items: 0 })
  })

  test('ruchy sprzed końca miesiąca są już w stanie — nie zmieniają wyceny', () => {
    const items = [item('A', 10, 12.5)]
    const movements = [
      mv('A', 'initial', 4, '2026-07-01T10:00:00.000Z'),
      mv('A', 'in', 8, '2026-08-10T10:00:00.000Z'),
      mv('A', 'out', 2, '2026-08-20T10:00:00.000Z'),
    ]
    assert.deepEqual(computeValuation(items, movements, ['2026-08']).get('2026-08'), { value: 125, unpriced_items: 0 })
  })

  test('ruchy po końcu miesiąca są cofane: in odejmowany, out dodawany', () => {
    const items = [item('A', 10, 10)]
    const movements = [
      mv('A', 'in', 6, '2026-09-05T10:00:00.000Z'),   // po sierpniu → stan na koniec sierpnia = 10 − 6
      mv('A', 'out', 3, '2026-09-12T10:00:00.000Z'),  // po sierpniu → +3
    ]
    const v = computeValuation(items, movements, ['2026-08', '2026-09'])
    assert.deepEqual(v.get('2026-08'), { value: 70, unpriced_items: 0 })   // (10 − 6 + 3) × 10
    assert.deepEqual(v.get('2026-09'), { value: 100, unpriced_items: 0 })  // stan bieżący
  })

  test('initial (stan początkowy) NIE jest cofany — bilans otwarcia istnieje we wszystkich wcześniejszych okresach', () => {
    // Import Excel / formularz „nowa pozycja” zapisują `initial` z created_at = chwila zasilenia (2026-06-05),
    // ale towar był kupiony wcześniej → wartość maja = wartość czerwca, Δ(czerwiec) = 0 (a nie +cały magazyn).
    const items = [item('A', 200, 900)]
    const movements = [mv('A', 'initial', 200, '2026-06-05T10:00:00.000Z', 900)]
    const v = computeValuation(items, movements, ['2026-05', '2026-06'])
    assert.deepEqual(v.get('2026-05'), { value: 180000, unpriced_items: 0 })
    assert.deepEqual(v.get('2026-06'), { value: 180000, unpriced_items: 0 })
    const ch = computeMonthlyChanges(items, movements, ['2026-06'])
    assert.deepEqual(ch.get('2026-06'), { period: '2026-06', value: 180000, change: 0, unpriced_items: 0 })
    // późniejsze in/out po initial nadal są cofane normalnie
    const withLater = [...movements, mv('A', 'out', 50, '2026-07-10T10:00:00.000Z')] // stan dziś 150
    const v2 = computeValuation([item('A', 150, 900)], withLater, ['2026-05', '2026-06', '2026-07'])
    assert.equal(v2.get('2026-05')!.value, 180000)
    assert.equal(v2.get('2026-06')!.value, 180000)
    assert.equal(v2.get('2026-07')!.value, 135000)
  })

  test('granica strefy: 31.08 22:30 UTC (1.09 00:30 w Warszawie) jest już po sierpniu; 21:30 UTC jeszcze w sierpniu', () => {
    const items = [item('A', 10, 1)]
    const late = [mv('A', 'in', 4, '2026-08-31T22:30:00.000Z')]
    const early = [mv('A', 'in', 4, '2026-08-31T21:30:00.000Z')]
    assert.equal(computeValuation(items, late, ['2026-08']).get('2026-08')!.value, 6)
    assert.equal(computeValuation(items, early, ['2026-08']).get('2026-08')!.value, 10)
    // zima: 31.12 23:30 UTC = 1.01 00:30 → po grudniu
    const winter = [mv('A', 'in', 4, '2026-12-31T23:30:00.000Z')]
    assert.equal(computeValuation(items, winter, ['2026-12']).get('2026-12')!.value, 6)
  })

  test('MM (out ze źródła + in do celu po tej samej cenie) jest neutralne dla wartości łącznej', () => {
    const items = [item('A', 2, 100), item('B', 5, 100)] // po MM: A=2, B=5 (przed: A=5, B=2)
    const movements = [
      mv('A', 'out', 3, '2026-09-03T08:00:00.000Z', 100),
      mv('B', 'in', 3, '2026-09-03T08:00:00.000Z', 100),
    ]
    const v = computeValuation(items, movements, ['2026-08', '2026-09'])
    assert.equal(v.get('2026-08')!.value, 700)
    assert.equal(v.get('2026-09')!.value, 700)
  })

  test('ujemny stan wsteczny traktowany jako 0', () => {
    const items = [item('A', 2, 50)]
    const movements = [mv('A', 'in', 10, '2026-09-01T12:00:00.000Z')] // 2 − 10 = −8 → 0
    assert.deepEqual(computeValuation(items, movements, ['2026-08']).get('2026-08'), { value: 0, unpriced_items: 0 })
  })

  test('adjust ze znakiem jest cofany zgodnie ze znakiem', () => {
    const items = [item('A', 7, 2)]
    const movements = [mv('A', 'adjust', -3, '2026-09-02T12:00:00.000Z')] // 7 − (−3) = 10
    assert.equal(computeValuation(items, movements, ['2026-08']).get('2026-08')!.value, 20)
  })

  test('brak ceny na pozycji → cena ostatniego ruchu in/initial z ceną > 0', () => {
    const items = [item('A', 4, 0)]
    const movements = [
      mv('A', 'initial', 4, '2026-06-01T10:00:00.000Z', 9),
      mv('A', 'in', 2, '2026-07-01T10:00:00.000Z', 11),
      mv('A', 'in', 1, '2026-07-15T10:00:00.000Z', 0), // bez ceny — pomijany
      mv('A', 'out', 3, '2026-08-01T10:00:00.000Z', 99), // out nie jest źródłem ceny
    ]
    assert.deepEqual(computeValuation(items, movements, ['2026-08']).get('2026-08'), { value: 44, unpriced_items: 0 })
  })

  test('cena z ruchu: preferuj ostatni sprzed końca okresu, inaczej dowolny późniejszy', () => {
    const items = [item('A', 1, 0)]
    const movements = [
      mv('A', 'initial', 1, '2026-05-01T10:00:00.000Z', 5),
      mv('A', 'in', 0, '2026-10-01T10:00:00.000Z', 8),
    ]
    const v = computeValuation(items, movements, ['2026-08', '2026-10'])
    assert.equal(v.get('2026-08')!.value, 5)
    assert.equal(v.get('2026-10')!.value, 8)
    // pozycja bez żadnej ceny sprzed okresu — bierze późniejszą, byle > 0
    const onlyLater = [mv('A', 'in', 0, '2026-10-01T10:00:00.000Z', 8)]
    assert.equal(computeValuation(items, onlyLater, ['2026-08']).get('2026-08')!.value, 8)
  })

  test('pozycja bez żadnej ceny i ze stanem → unpriced_items, wartość 0; bez stanu nie jest liczona', () => {
    const items = [item('A', 3, 0), item('B', 0, 0), item('C', 2, 4)]
    const movements = [mv('A', 'initial', 3, '2026-06-01T10:00:00.000Z', 0)]
    assert.deepEqual(computeValuation(items, movements, ['2026-08']).get('2026-08'), { value: 8, unpriced_items: 1 })
  })

  test('zaokrąglenie do groszy', () => {
    const items = [item('A', 3, 0.1), item('B', 3, 0.2)]
    assert.equal(computeValuation(items, [], ['2026-08']).get('2026-08')!.value, 0.9)
  })
})

describe('computeCurrentValuation i computeMonthlyChanges', () => {
  test('stan bieżący nie cofa żadnych ruchów', () => {
    const items = [item('A', 10, 3)]
    const movements = [mv('A', 'in', 5, '2999-01-01T00:00:00.000Z')]
    assert.deepEqual(computeCurrentValuation(items, movements), { value: 30, unpriced_items: 0 })
  })

  test('Δ(M) = value(M) − value(M−1), także dla pierwszego miesiąca listy', () => {
    const items = [item('A', 10, 10)] // stan dziś: 100
    const movements = [
      mv('A', 'in', 4, '2026-08-10T10:00:00.000Z'),  // koniec lipca: 10 − 4 − 2 = 4 → 40; koniec sierpnia: 10 − 2 = 8 → 80
      mv('A', 'in', 2, '2026-09-10T10:00:00.000Z'),  // koniec września: 10 → 100
    ]
    const ch = computeMonthlyChanges(items, movements, ['2026-08', '2026-09'])
    assert.deepEqual(ch.get('2026-08'), { period: '2026-08', value: 80, change: 40, unpriced_items: 0 })
    assert.deepEqual(ch.get('2026-09'), { period: '2026-09', value: 100, change: 20, unpriced_items: 0 })
  })

  test('magazyn zmalał → ujemna zmiana; brak danych → 0', () => {
    const items = [item('A', 1, 25)]
    const movements = [mv('A', 'out', 3, '2026-09-15T10:00:00.000Z')] // koniec sierpnia: 4 → 100; wrzesień: 1 → 25
    const ch = computeMonthlyChanges(items, movements, ['2026-09'])
    assert.deepEqual(ch.get('2026-09'), { period: '2026-09', value: 25, change: -75, unpriced_items: 0 })
    assert.deepEqual(computeMonthlyChanges([], [], ['2026-09']).get('2026-09'), { period: '2026-09', value: 0, change: 0, unpriced_items: 0 })
  })
})
