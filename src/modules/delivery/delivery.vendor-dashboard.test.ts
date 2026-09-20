import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  dashboardMonths,
  deliveryRate,
  fillMonthSeries,
} from './delivery.vendor-dashboard'
import type { MonthRow } from './delivery.vendor-dashboard'

/**
 * The vendor dashboard's arithmetic, as decisions.
 *
 * Only the pure half is here, which is the half that can be wrong without
 * anything saying so: a chart drawn off a series with a month missing is a
 * chart that reads perfectly and means something else.
 */

function row(year: number, month: number, over: Partial<MonthRow> = {}): MonthRow {
  return { year, month, trips: 1, qty: 10, bill: 1000, returnedQty: 0, openTrips: 0, ...over }
}

describe('dashboardMonths', () => {
  it('ends with the month today falls in', () => {
    const months = dashboardMonths('2026-09-19', 6)

    assert.deepEqual(months[months.length - 1], { year: 2026, month: 9 })
    assert.equal(months.length, 6)
  })

  it('runs oldest first', () => {
    assert.deepEqual(dashboardMonths('2026-09-19', 3), [
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ])
  })

  /** The whole reason the window is months-since-year-zero rather than a date. */
  it('crosses a year boundary without a special case', () => {
    assert.deepEqual(dashboardMonths('2026-02-01', 4), [
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ])
  })

  it('is the current month alone when one is asked for', () => {
    assert.deepEqual(dashboardMonths('2026-01-31', 1), [{ year: 2026, month: 1 }])
  })
})

describe('fillMonthSeries', () => {
  const months = dashboardMonths('2026-09-19', 3)

  it('keeps a month nothing ran in, as a zero rather than a gap', () => {
    const series = fillMonthSeries(months, [row(2026, 7, { trips: 4 }), row(2026, 9, { trips: 2 })])

    assert.equal(series.length, 3)
    assert.deepEqual(
      series.map((point) => [point.month, point.trips]),
      [
        [7, 4],
        [8, 0],
        [9, 2],
      ],
    )
  })

  it('carries each month its own figures', () => {
    const [july] = fillMonthSeries(months, [
      row(2026, 7, { trips: 4, qty: 88, bill: 12_500 }),
    ])

    assert.deepEqual(july, { year: 2026, month: 7, trips: 4, qty: 88, bill: 12_500 })
  })

  /** A row outside the window is not the window's business — and must not widen it. */
  it('ignores a row from outside the window', () => {
    const series = fillMonthSeries(months, [row(2026, 3, { trips: 9 })])

    assert.equal(series.length, 3)
    assert.deepEqual(
      series.map((point) => point.trips),
      [0, 0, 0],
    )
  })

  it('matches a month of one year to that year only', () => {
    const series = fillMonthSeries(dashboardMonths('2026-02-01', 2), [row(2025, 1, { trips: 7 })])

    assert.deepEqual(
      series.map((point) => point.trips),
      [0, 0],
    )
  })
})

describe('deliveryRate', () => {
  it('is the share of pieces that stayed delivered', () => {
    assert.equal(deliveryRate(9, 10), 90)
    assert.equal(deliveryRate(10, 10), 100)
  })

  /** A month with nothing on it has not delivered everything. */
  it('is zero when nothing was carried', () => {
    assert.equal(deliveryRate(0, 0), 0)
  })

  it('is zero when everything came back', () => {
    assert.equal(deliveryRate(0, 12), 0)
  })
})
