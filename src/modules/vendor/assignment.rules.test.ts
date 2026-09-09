import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  closeBefore,
  isCurrentOn,
  isForwardRange,
  normalizeRange,
  rangeLength,
  rangesOverlap,
} from './assignment.rules'

/**
 * The arithmetic behind an assignment.
 *
 * These are the decisions that keep a vehicle's history honest — whether two
 * periods put two drivers on one lorry, and where a handover falls. Tested as
 * decisions rather than through a database, in the same spirit as
 * `page-ranges.ts` in Challan.
 */

const day = (value: string) => new Date(`${value}T00:00:00.000Z`)

describe('normalizeRange', () => {
  it('reduces both ends to UTC midnight', () => {
    // An assignment starts on a date, not at an instant. Storing the instant is
    // how a period ends a day early for a viewer west of Greenwich.
    const range = normalizeRange({
      from: new Date('2026-09-01T18:30:00.000Z'),
      until: new Date('2026-09-15T23:59:59.000Z'),
    })

    assert.equal(range.from.toISOString(), '2026-09-01T00:00:00.000Z')
    assert.equal(range.until?.toISOString(), '2026-09-15T00:00:00.000Z')
  })

  it('leaves an open-ended range open', () => {
    assert.equal(normalizeRange({ from: day('2026-09-01'), until: null }).until, null)
  })
})

describe('isForwardRange', () => {
  it('accepts a single-day assignment', () => {
    // A driver put on a vehicle for one day's run is an assignment, not a typo.
    assert.equal(isForwardRange({ from: day('2026-09-01'), until: day('2026-09-01') }), true)
  })

  it('accepts an open-ended assignment, which is the ordinary case', () => {
    assert.equal(isForwardRange({ from: day('2026-09-01'), until: null }), true)
  })

  it('refuses a range that runs backwards', () => {
    assert.equal(isForwardRange({ from: day('2026-09-10'), until: day('2026-09-01') }), false)
  })
})

describe('rangesOverlap', () => {
  it('sees a plain overlap', () => {
    assert.equal(
      rangesOverlap(
        { from: day('2026-08-01'), until: day('2026-08-20') },
        { from: day('2026-08-15'), until: day('2026-08-31') },
      ),
      true,
    )
  })

  it('treats a shared boundary day as an overlap', () => {
    // One ending on the 15th and the next starting on the 15th puts two drivers
    // on one vehicle for a day. That is exactly the state this refuses.
    assert.equal(
      rangesOverlap(
        { from: day('2026-08-01'), until: day('2026-08-15') },
        { from: day('2026-08-15'), until: day('2026-08-31') },
      ),
      true,
    )
  })

  it('accepts a clean handover on consecutive days', () => {
    assert.equal(
      rangesOverlap(
        { from: day('2026-08-01'), until: day('2026-08-15') },
        { from: day('2026-08-16'), until: day('2026-08-31') },
      ),
      false,
    )
  })

  it('makes an open-ended range reach forever', () => {
    assert.equal(
      rangesOverlap(
        { from: day('2026-09-01'), until: null },
        { from: day('2030-01-01'), until: day('2030-02-01') },
      ),
      true,
    )
  })

  it('makes two open-ended ranges always collide', () => {
    // The one-active-driver rule falling out of the arithmetic rather than
    // being asserted separately.
    assert.equal(
      rangesOverlap(
        { from: day('2026-01-01'), until: null },
        { from: day('2026-09-01'), until: null },
      ),
      true,
    )
  })

  it('leaves a closed period before an open one alone', () => {
    assert.equal(
      rangesOverlap(
        { from: day('2026-08-01'), until: day('2026-08-31') },
        { from: day('2026-09-01'), until: null },
      ),
      false,
    )
  })

  it('is symmetric', () => {
    const a = { from: day('2026-08-01'), until: day('2026-08-20') }
    const b = { from: day('2026-08-15'), until: null }

    assert.equal(rangesOverlap(a, b), rangesOverlap(b, a))
  })
})

describe('closeBefore', () => {
  it('ends the outgoing assignment the day before the new one starts', () => {
    // Karim's last day is the 31st when Rahim starts on the 1st, so the vehicle
    // is never recorded as having two drivers.
    const closed = closeBefore(day('2026-08-16'), day('2026-09-01'))

    assert.equal(closed.toISOString(), '2026-08-31T00:00:00.000Z')
    assert.equal(
      rangesOverlap(
        { from: day('2026-08-16'), until: closed },
        { from: day('2026-09-01'), until: null },
      ),
      false,
    )
  })

  it('collapses to a single day rather than running backwards', () => {
    // Back-filling a replacement that starts on the day the old one began. An
    // assignment that ran for no time is still a row somebody created, and
    // rewriting its start would falsify when it was made.
    const closed = closeBefore(day('2026-09-01'), day('2026-09-01'))
    assert.equal(closed.toISOString(), '2026-09-01T00:00:00.000Z')
  })

  it('never moves the start date', () => {
    const closed = closeBefore(day('2026-09-10'), day('2026-09-01'))
    assert.equal(closed.toISOString(), '2026-09-10T00:00:00.000Z')
  })
})

describe('the worked history from the specification', () => {
  /**
   * Rahim  01 Aug - 15 Aug
   * Karim  16 Aug - 31 Aug
   * Rahim  01 Sep - current
   *
   * Three periods on one vehicle, none of them overlapping, and the last one
   * still open. This is the history the module exists to preserve.
   */
  const rahimFirst = { from: day('2026-08-01'), until: day('2026-08-15') }
  const karim = { from: day('2026-08-16'), until: day('2026-08-31') }
  const rahimAgain = { from: day('2026-09-01'), until: null }

  it('holds together without a single collision', () => {
    assert.equal(rangesOverlap(rahimFirst, karim), false)
    assert.equal(rangesOverlap(karim, rahimAgain), false)
    assert.equal(rangesOverlap(rahimFirst, rahimAgain), false)
  })

  it('knows which one was in force on a given day', () => {
    assert.equal(isCurrentOn(rahimFirst, day('2026-08-11')), true)
    assert.equal(isCurrentOn(karim, day('2026-08-11')), false)
    assert.equal(isCurrentOn(rahimAgain, day('2026-09-09')), true)
  })

  it('refuses a fourth period back-filled over August', () => {
    // The overlap check runs over every status, not just the active ones: an
    // assignment that ended in August still occupied August.
    assert.equal(rangesOverlap({ from: day('2026-08-10'), until: day('2026-08-18') }, rahimFirst), true)
    assert.equal(rangesOverlap({ from: day('2026-08-10'), until: day('2026-08-18') }, karim), true)
  })

  it('counts a period inclusively at both ends', () => {
    assert.equal(rangeLength(rahimFirst), 15)
    assert.equal(rangeLength(karim), 16)
    assert.equal(rangeLength(rahimAgain, day('2026-09-09')), 9)
  })
})
