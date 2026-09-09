import { startOfUtcDay } from './vendor.constants'

/**
 * The arithmetic behind an assignment, as pure functions.
 *
 * Everything here is a decision the server has to make the same way every time
 * — whether two periods overlap, what closing an assignment does to its end
 * date, whether a range runs forwards. None of it touches the database, which
 * is what lets it be tested as decisions rather than as an integration, in the
 * same spirit as `page-ranges.ts` in Challan.
 */

const DAY_MS = 86_400_000

/**
 * A period a driver held a vehicle. `until` is null while it is open-ended,
 * which is the ordinary case: somebody is put on a vehicle and stays there
 * until somebody else is.
 */
export interface DateRange {
  from: Date
  until: Date | null
}

/** A range as it will be stored: both ends reduced to UTC midnight. */
export function normalizeRange(range: DateRange): DateRange {
  return {
    from: startOfUtcDay(range.from),
    until: range.until ? startOfUtcDay(range.until) : null,
  }
}

/**
 * Whether a range runs forwards.
 *
 * The same day at both ends is legitimate — a driver put on a vehicle for a
 * single day's run is one assignment, not a mistake — so this is `>=` rather
 * than `>`.
 */
export function isForwardRange(range: DateRange): boolean {
  const { from, until } = normalizeRange(range)
  return until === null || until.getTime() >= from.getTime()
}

/**
 * Whether two periods share a day.
 *
 * Inclusive at both ends, because these are calendar days rather than
 * instants: an assignment ending on the 15th and one starting on the 15th put
 * two drivers on one vehicle for a day, which is exactly the state this
 * refuses. Ending one on the 15th and starting the next on the 16th is the
 * correct handover, and that is what `closeBefore` produces.
 *
 * An open-ended range reaches forever, so two open-ended ranges always
 * overlap — which is the one-active-driver rule falling out of the arithmetic
 * rather than being asserted separately.
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  const left = normalizeRange(a)
  const right = normalizeRange(b)

  const leftEnd = left.until?.getTime() ?? Number.POSITIVE_INFINITY
  const rightEnd = right.until?.getTime() ?? Number.POSITIVE_INFINITY

  return left.from.getTime() <= rightEnd && right.from.getTime() <= leftEnd
}

/**
 * Where a replaced assignment should end so the handover is clean.
 *
 * The day before the new one starts — so Karim's last day is the 31st when
 * Rahim starts on the 1st, and the vehicle is never recorded as having two
 * drivers. If the new assignment starts on or before the day the old one
 * began, the old one is collapsed to a single day rather than given a negative
 * length: an assignment that ran for no time at all is still a row somebody
 * created, and rewriting its start would falsify when it was made.
 */
export function closeBefore(existingFrom: Date, newFrom: Date): Date {
  const start = startOfUtcDay(existingFrom)
  const dayBefore = new Date(startOfUtcDay(newFrom).getTime() - DAY_MS)

  return dayBefore.getTime() < start.getTime() ? start : dayBefore
}

/**
 * Whether an assignment is in force on a given day.
 *
 * Used to describe an assignment rather than to decide anything — the stored
 * `status` is what queries filter on, because a date comparison cannot be
 * indexed as cheaply as an equality. The two agree by construction: a row is
 * `Ended` exactly when it has been closed.
 */
export function isCurrentOn(range: DateRange, day: Date): boolean {
  const { from, until } = normalizeRange(range)
  const at = startOfUtcDay(day).getTime()

  return at >= from.getTime() && (until === null || at <= until.getTime())
}

/** How a period reads on screen: "01 Sep 2026 — current". */
export function rangeLength(range: DateRange, now: Date = new Date()): number {
  const { from, until } = normalizeRange(range)
  const end = until ?? startOfUtcDay(now)

  return Math.max(0, Math.round((end.getTime() - from.getTime()) / DAY_MS)) + 1
}
