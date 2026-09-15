/**
 * How much of each challan line has gone out, what is deliberately held back,
 * and what the challan should say afterwards.
 *
 * Pure arithmetic with no database behind it, in the same spirit as
 * `page-ranges.ts` in Challan and `assignment.rules.ts` in Vendor: every
 * decision here is one the server has to make the same way every time, and
 * each is tested as a decision.
 *
 * **The model, and the one distinction the whole module turns on.** A challan
 * line says "Refrigerator WFC-1D5 × 4". A trip takes some of it, and what the
 * operator meant by taking less than four is *not* something arithmetic can
 * work out — so it is not guessed at, it is recorded:
 *
 * - **Split** — "two now, two on the next lorry". The two left over are
 *   `reserved`, the challan keeps saying four, and the next trip is offered
 *   the remaining two.
 * - **Anything else** — a quantity trimmed, a line removed, a model replaced,
 *   a product added — is a **correction of the challan**. The paper said four
 *   and three is what exists, so the challan is rewritten to three and there is
 *   nothing left for a later trip to collect.
 *
 * `rebuildChallanItems` is that second rule as a function, and it is why a
 * trip line's identity is its **product**, not its position: once a challan is
 * rewritten, lines move and disappear, and an index would point at whatever
 * slid into its place.
 */

/** One product line as the challan prints it. */
export interface SourceLine {
  productName: string
  model: string
  qty: number
}

/** One line on a trip, reduced to what allocation needs. */
export interface TripLine {
  /**
   * The challan line this came from, or null for a line the paper never
   * listed. Kept for the workspace, which shows a line beside the row it
   * corrects; matching is by product, not by this.
   */
  sourceIndex: number | null
  /**
   * What the source line said when the trip took it. It is what makes a
   * manifest readable afterwards — "3 of 4" is a sentence about a challan that
   * has since been corrected to 3 — and it is what identifies which line this
   * one draws on.
   */
  source: SourceLine | null
  productName: string
  model: string
  qty: number
  /**
   * How many of this line's pieces came back off the lorry.
   *
   * A **return** is the third thing a trip can do to a line, beside carrying it
   * and holding it back, and it is the only one that happens *after* the lorry
   * left. The goods went out, the receiver took some or none of them, and the
   * rest came back — so the customer still owes nothing for them, the challan
   * still orders them, and another trip may take them.
   *
   * Which is to say a return is a **retroactive split**: it releases the pieces
   * exactly as a reservation does, and the only difference is when it was
   * decided. That is why `netQty` is what every allocation reads, and why
   * `rebuildChallanItems` treats a return as something held.
   */
  returned?: number
}

/** What a trip line actually left with the receiver. */
export function netQty(line: TripLine): number {
  return Math.max(0, line.qty - (line.returned ?? 0))
}

/**
 * Part of a challan line a trip is not accounting for — held back by a split
 * before it left, or returned to the depot after it came back.
 *
 * `tripKey` is what stops two trips' holds stacking. Two trips can both be
 * holding the same two refrigerators — the first reserved them, the second
 * collected them and is now holding nothing — and adding the holds together
 * would raise the challan to six for a delivery of four. The challan is
 * rebuilt against the **largest** single hold instead, which is the most any
 * one trip claims is still outstanding. See `rebuildChallanItems`.
 */
export interface ReservedLine {
  productName: string
  model: string
  qty: number
  /** Which trip is holding it. Any stable string; ids are what callers pass. */
  tripKey: string
}

/**
 * The comparison key for a product or a model: case, spacing and punctuation
 * set aside, Bangla kept. Byte-identical to `comparisonKey` in
 * `challan.constants.ts`, and copied rather than imported so this file stays
 * dependency-free for its tests.
 */
export function comparisonKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9ঀ-৿]/g, '')
}

/** A line's identity: its product and model, normalised. */
export function lineKey(line: { productName: string; model: string }): string {
  return `${comparisonKey(line.productName)}|${comparisonKey(line.model)}`
}

/**
 * Whether a trip line draws on this challan line.
 *
 * By product, deliberately. A correction rewrites the challan — lines change
 * quantity, disappear, and new ones are appended — so a position is not stable
 * and a quantity is not an identity. What does not change is which product a
 * line is about.
 *
 * A **substitution** therefore does not draw on the line it replaced: it is a
 * different product, it consumes that line's quantity by correcting it away,
 * and it appears on the challan in its own right.
 */
export function drawsOn(line: TripLine, current: SourceLine): boolean {
  return lineKey(line) === lineKey(current)
}

export interface LineAllocation {
  index: number
  productName: string
  model: string
  /** What the challan orders. */
  ordered: number
  /** What other trips already carry against it. */
  dispatched: number
  /** What is still to go: never negative, even when a line went out over. */
  remaining: number
}

/**
 * Where every line of one challan stands, given the lines other trips carry.
 *
 * "Other trips" is every trip on record except the one being edited — every
 * status counts, because a delivered refrigerator is exactly as gone as one on
 * a lorry. There is no cancelled state to exclude: a trip that did not happen
 * was deleted, and its quantities went with it.
 */
export function allocateLines(source: SourceLine[], otherTrips: TripLine[]): LineAllocation[] {
  return source.map((line, index) => {
    const dispatched = otherTrips
      .filter((tripLine) => drawsOn(tripLine, line))
      .reduce((sum, tripLine) => sum + netQty(tripLine), 0)

    return {
      index,
      productName: line.productName,
      model: line.model,
      ordered: line.qty,
      dispatched,
      remaining: Math.max(0, line.qty - dispatched),
    }
  })
}

export interface ChallanProgress {
  ordered: number
  dispatched: number
  remaining: number
  /** Every line has gone out in full. */
  complete: boolean
  /** Something has gone out, and something has not. */
  partial: boolean
}

export function progressOf(allocations: LineAllocation[]): ChallanProgress {
  const ordered = allocations.reduce((sum, line) => sum + line.ordered, 0)
  const dispatched = allocations.reduce(
    (sum, line) => sum + Math.min(line.dispatched, line.ordered),
    0,
  )
  const remaining = allocations.reduce((sum, line) => sum + line.remaining, 0)

  return {
    ordered,
    dispatched,
    remaining,
    complete: allocations.length > 0 && remaining === 0,
    partial: dispatched > 0 && remaining > 0,
  }
}

/**
 * A challan line this trip would take past what the paper orders.
 *
 * Still a question rather than a refusal, and now it asks something sharper
 * than it used to: sending more than the challan orders **raises the challan**,
 * because the challan is corrected to what actually went. A quantity typed as
 * 11 instead of 1 would otherwise rewrite the office's record silently, which
 * is exactly what this stops.
 */
export interface Overage {
  index: number
  productName: string
  model: string
  ordered: number
  onOtherTrips: number
  onThisTrip: number
}

export function findOverages(
  source: SourceLine[],
  otherTrips: TripLine[],
  thisTrip: TripLine[],
): Overage[] {
  const overages: Overage[] = []

  source.forEach((line, index) => {
    const onOtherTrips = otherTrips
      .filter((tripLine) => drawsOn(tripLine, line))
      .reduce((sum, tripLine) => sum + netQty(tripLine), 0)
    const onThisTrip = thisTrip
      .filter((tripLine) => drawsOn(tripLine, line))
      .reduce((sum, tripLine) => sum + netQty(tripLine), 0)

    if (onThisTrip > 0 && onOtherTrips + onThisTrip > line.qty) {
      overages.push({
        index,
        productName: line.productName,
        model: line.model,
        ordered: line.qty,
        onOtherTrips,
        onThisTrip,
      })
    }
  })

  return overages
}

/**
 * What the challan should say once these trips have run.
 *
 * The whole rule in one function: **a challan is what was delivered, plus what
 * somebody is still holding for it.** Every line of every trip carrying it
 * counts toward the product it actually carried — a substitution toward the
 * model that went, an added product toward itself — and anything a trip is
 * holding keeps the line from being cut away underneath it.
 *
 * Three quantities decide each line, and the order they are applied is the
 * design:
 *
 * - `carried` is what the trips **net** delivered. A returned piece is not
 *   delivered, so it does not count here.
 * - `held` is the largest amount any *single* trip is holding against the
 *   line — reserved by a split, or returned after one. The largest rather than
 *   the sum, because two trips can be holding the same two refrigerators: the
 *   first reserved them and the second has since collected them, and adding
 *   the two together would raise a challan of four to six.
 * - `current` is what the challan says now, which is the ceiling a hold may
 *   restore the line to. A hold can stop a line being cut; it can never raise
 *   one, because nobody holding goods has added any.
 *
 * So a line that everything was delivered on becomes what went — cut when less
 * existed, raised when more did. A line something is still held against keeps
 * its printed quantity. And a line nothing carries and nothing holds is gone,
 * which is what "remove the product" means.
 *
 * Lines the challan already has keep their place, so a corrected challan still
 * reads in the order it was printed; anything new is appended. Two lines of the
 * same product and model merge, because after a correction they are one line by
 * every question anybody asks of them.
 */
export function rebuildChallanItems(
  current: SourceLine[],
  tripLines: TripLine[],
  held: ReservedLine[],
): SourceLine[] {
  const order: string[] = []
  const byKey = new Map<string, { productName: string; model: string; carried: number }>()

  const add = (line: { productName: string; model: string }, qty: number) => {
    const key = lineKey(line)
    const existing = byKey.get(key)

    if (existing) {
      existing.carried += qty
      return
    }

    order.push(key)
    byKey.set(key, { productName: line.productName, model: line.model, carried: qty })
  }

  // The challan's own lines first, at zero: they keep their printed order, and
  // the ones nothing accounts for drop out at the end.
  for (const line of current) {
    add(line, 0)
  }

  for (const line of tripLines) {
    add(line, netQty(line))
  }

  // What the challan says now — the ceiling a hold may restore a line to.
  const printed = new Map<string, number>()
  for (const line of current) {
    printed.set(lineKey(line), (printed.get(lineKey(line)) ?? 0) + line.qty)
  }

  // The largest hold any one trip has against each line, never the sum.
  const holds = new Map<string, number>()
  for (const line of held) {
    const key = lineKey(line)
    const perTrip = holds.get(`${key}::${line.tripKey}`) ?? 0
    holds.set(`${key}::${line.tripKey}`, perTrip + line.qty)

    if (!byKey.has(key)) {
      add(line, 0)
    }
  }

  const largestHold = (key: string): number => {
    let largest = 0
    for (const [composite, qty] of holds) {
      if (composite.slice(0, composite.lastIndexOf('::')) === key) {
        largest = Math.max(largest, qty)
      }
    }
    return largest
  }

  return order
    .map((key) => {
      const entry = byKey.get(key) as { productName: string; model: string; carried: number }
      const ceiling = printed.get(key) ?? 0
      const qty =
        entry.carried >= ceiling
          ? entry.carried
          : Math.min(ceiling, entry.carried + largestHold(key))

      return { productName: entry.productName, model: entry.model, qty }
    })
    .filter((line) => line.qty > 0)
}

/** Whether two item lists say the same thing — so an untouched challan is not rewritten. */
export function sameItems(a: SourceLine[], b: SourceLine[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (line, index) => lineKey(line) === lineKey(b[index]) && line.qty === b[index].qty,
    )
  )
}

/**
 * What a trip did to one line, relative to the paper.
 *
 * - `as-ordered` — the product, the model and the full quantity.
 * - `split` — fewer, with the rest deliberately reserved for a later trip. The
 *   challan is unchanged.
 * - `reduced` — fewer, with nothing reserved: the challan is corrected down to
 *   what went, and there is nothing left to collect later.
 * - `increased` — more than ordered; the challan is corrected up.
 * - `substituted` — a different product or model, which replaces the line it
 *   stands in for.
 * - `added` — a product the challan never listed, which is appended to it.
 */
export type LineChange =
  | 'as-ordered'
  | 'split'
  | 'reduced'
  | 'increased'
  | 'substituted'
  | 'added'

export function classifyLine(line: TripLine, reserved = 0): LineChange {
  if (line.sourceIndex === null || line.source === null) {
    return 'added'
  }
  if (lineKey(line) !== lineKey(line.source)) {
    return 'substituted'
  }
  if (line.qty < line.source.qty) {
    return reserved > 0 ? 'split' : 'reduced'
  }
  return line.qty > line.source.qty ? 'increased' : 'as-ordered'
}

/** How many lines on a trip differ from the paper in any way. */
export function countChanges(lines: TripLine[]): number {
  return lines.filter((line) => classifyLine(line) !== 'as-ordered').length
}

/** Every quantity on a set of lines, added up. */
export function totalQty(lines: { qty: number }[]): number {
  return lines.reduce((sum, line) => sum + line.qty, 0)
}
