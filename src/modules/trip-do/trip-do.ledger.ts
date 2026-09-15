import { lineKey } from '../delivery/delivery.allocation'
import type { TripDoRowKind } from './trip-do.constants'

/**
 * What the Trip DO sheet should hold for one challan, and how to bring the
 * stored rows in line with it.
 *
 * Pure arithmetic with no database behind it, in the spirit of
 * `delivery.allocation.ts`: the sync runs these the same way every time, and
 * each rule is tested as a decision.
 *
 * **The sheet is a projection with two things of its own.** Everything on a
 * row — the customer, the product, the rate, the trip numbers, the delivery
 * status — is read off the challan and its trips and rewritten whenever they
 * change. What the sheet owns is how a line's quantity is divided into rows
 * (a split) and which gate pass each row is linked to (a Trip DO). The
 * reconciliation below exists to keep those two when everything around them
 * moves.
 */

/** One product line on a trip, reduced to what the sheet needs. */
export interface LedgerTripLine {
  productName: string
  model: string
  qty: number
}

/** One trip carrying the challan, in the order the trips ran. */
export interface LedgerTrip {
  id: string
  tripNumber: string
  /** This trip's copy of the challan has been signed for, returned or closed. */
  completed: boolean
  /** What the lorry carried — including anything that later came back. */
  lines: LedgerTripLine[]
  /** What came back off it. */
  returned: LedgerTripLine[]
}

/**
 * Something the sheet has rows for: a challan line, a return off one trip, or
 * a re-send on one trip. Its rows' quantities always add up to `qty`.
 */
export interface LedgerSource {
  /** Stable across corrections — see `ledgerSourcesFor`. */
  sourceKey: string
  kind: TripDoRowKind
  /** Which challan line this belongs under, for ordering. */
  position: number
  /** Order within that line: the order row first, then trips as they ran. */
  rowSeq: number
  /** The challan line index for an order row, so its rate can be read. */
  itemIndex: number | null
  tripId: string | null
  tripNumbers: string[]
  /** Return and re-send only: whether that trip's delivery is complete. */
  tripCompleted: boolean
  productName: string
  model: string
  qty: number
  /**
   * Order only: pieces of this line that went out the **first** time on trips
   * whose delivery is complete — including any that later came back, which the
   * return row accounts for. Re-sent pieces are the re-send row's. Zero on a
   * return or re-send.
   */
  firstDeliveredQty: number
}

function sumByKey(lines: LedgerTripLine[]): Map<string, { line: LedgerTripLine; qty: number }> {
  const result = new Map<string, { line: LedgerTripLine; qty: number }>()
  for (const line of lines) {
    const key = lineKey(line)
    const existing = result.get(key)
    if (existing) {
      existing.qty += line.qty
    } else {
      result.set(key, { line, qty: line.qty })
    }
  }
  return result
}

/**
 * Every source one challan produces.
 *
 * **Keys are identities, not positions.** An order row is keyed by its product
 * and model plus which occurrence of that product it is, never by its index:
 * the Delivery module rewrites a challan's lines, and an index would hand one
 * product's Trip DO to whatever line slid into its place. A return and a
 * re-send are keyed by the trip and the product, which is exactly what they
 * are a fact about.
 *
 * Returns and re-sends are worked out per product with the rule
 * `returnFlowFor` uses for the whole challan: a trip loads from the depot shelf
 * first, so it re-sends at most what is on the shelf and at most what it
 * carried; what comes back off it goes onto the shelf afterwards. A trip never
 * re-sends what came back off itself.
 */
export function ledgerSourcesFor(
  challanId: string,
  items: LedgerTripLine[],
  trips: LedgerTrip[],
): LedgerSource[] {
  const sources: LedgerSource[] = []
  const positionOf = new Map<string, number>()
  const occurrences = new Map<string, number>()

  items.forEach((item, index) => {
    const key = lineKey(item)
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    if (!positionOf.has(key)) {
      positionOf.set(key, index)
    }

    const tripNumbers = trips
      .filter((trip) => trip.lines.some((line) => lineKey(line) === key))
      .map((trip) => trip.tripNumber)

    sources.push({
      sourceKey: `${challanId}|O|${key}|${occurrence}`,
      kind: 'Order',
      position: index,
      rowSeq: 0,
      itemIndex: index,
      tripId: null,
      tripNumbers: [...new Set(tripNumbers)],
      tripCompleted: false,
      productName: item.productName,
      model: item.model,
      qty: item.qty,
      firstDeliveredQty: 0,
    })
  })

  const atDepot = new Map<string, number>()
  const firstOut = new Map<string, number>()

  trips.forEach((trip, tripIndex) => {
    const carried = sumByKey(trip.lines)
    const returned = sumByKey(trip.returned)
    const keys = new Set([...carried.keys(), ...returned.keys()])

    for (const key of keys) {
      // A product the paper never listed sorts after every line it did.
      const position = positionOf.get(key) ?? items.length
      const shelf = atDepot.get(key) ?? 0
      const load = carried.get(key)
      const resent = Math.min(load?.qty ?? 0, shelf)
      const back = returned.get(key)

      if (trip.completed) {
        firstOut.set(key, (firstOut.get(key) ?? 0) + Math.max(0, (load?.qty ?? 0) - resent))
      }

      if (resent > 0 && load) {
        sources.push({
          sourceKey: `${challanId}|S|${trip.id}|${key}`,
          kind: 'Resent',
          position,
          rowSeq: tripIndex * 2 + 1,
          itemIndex: null,
          tripId: trip.id,
          tripNumbers: [trip.tripNumber],
          tripCompleted: trip.completed,
          productName: load.line.productName,
          model: load.line.model,
          qty: resent,
          firstDeliveredQty: 0,
        })
      }

      if (back && back.qty > 0) {
        sources.push({
          sourceKey: `${challanId}|R|${trip.id}|${key}`,
          kind: 'Return',
          position,
          rowSeq: tripIndex * 2 + 2,
          itemIndex: null,
          tripId: trip.id,
          tripNumbers: [trip.tripNumber],
          tripCompleted: trip.completed,
          productName: back.line.productName,
          model: back.line.model,
          qty: back.qty,
          firstDeliveredQty: 0,
        })
      }

      atDepot.set(key, shelf - resent + (back?.qty ?? 0))
    }
  })

  // Two lines of one product share what went out, in printed order.
  for (const source of sources) {
    if (source.kind !== 'Order') {
      continue
    }
    const key = lineKey(source)
    const left = firstOut.get(key) ?? 0
    source.firstDeliveredQty = Math.min(source.qty, left)
    firstOut.set(key, left - source.firstDeliveredQty)
  }

  return sources
}

/** A stored row, reduced to what reconciliation reads. */
export interface LedgerRowState {
  id: string
  sourceKey: string
  qty: number
  linked: boolean
  /** On a bill. Only ever a linked row. */
  billed?: boolean
  splitIndex: number
}

export interface ReconcilePlan {
  create: { sourceKey: string; qty: number; splitIndex: number }[]
  setQty: { id: string; qty: number }[]
  remove: string[]
}

/**
 * Brings the stored rows back to what the sources say, keeping every split and
 * every Trip DO it honestly can.
 *
 * - **A new source** gets one row, with no Trip DO.
 * - **A source that grew** puts the extra on a row with no Trip DO — a piece
 *   nobody has matched to a gate pass yet is exactly what that row is — or
 *   opens one.
 * - **A source that shrank** takes the difference from rows with no Trip DO
 *   first, newest part first, then from linked rows, and from a row on a bill
 *   only when nothing else is left. A row brought to zero is removed.
 * - **A source that is gone** — a line corrected off the challan, a trip
 *   deleted, the challan itself deleted — takes its rows with it.
 *
 * Linked rows are touched last because a Trip DO is the one thing on the sheet
 * a person decided; a quantity is the one thing the challan decides.
 */
export function reconcileRows(
  sources: { sourceKey: string; qty: number }[],
  rows: LedgerRowState[],
): ReconcilePlan {
  const plan: ReconcilePlan = { create: [], setQty: [], remove: [] }
  const bySource = new Map<string, LedgerRowState[]>()

  for (const row of rows) {
    const list = bySource.get(row.sourceKey) ?? []
    list.push(row)
    bySource.set(row.sourceKey, list)
  }

  const wanted = new Set<string>()

  for (const source of sources) {
    wanted.add(source.sourceKey)
    const existing = (bySource.get(source.sourceKey) ?? []).filter((row) => row.qty > 0)
    const zeroRows = (bySource.get(source.sourceKey) ?? []).filter((row) => row.qty <= 0)
    plan.remove.push(...zeroRows.map((row) => row.id))

    if (existing.length === 0) {
      if (source.qty > 0) {
        plan.create.push({ sourceKey: source.sourceKey, qty: source.qty, splitIndex: 0 })
      }
      continue
    }

    const current = existing.reduce((sum, row) => sum + row.qty, 0)
    let diff = source.qty - current

    if (diff === 0) {
      continue
    }

    if (diff > 0) {
      const open = existing
        .filter((row) => !row.linked)
        .sort((a, b) => a.splitIndex - b.splitIndex)[0]

      if (open) {
        plan.setQty.push({ id: open.id, qty: open.qty + diff })
      } else {
        const next = Math.max(...existing.map((row) => row.splitIndex)) + 1
        plan.create.push({ sourceKey: source.sourceKey, qty: diff, splitIndex: next })
      }
      continue
    }

    // Shrinking: unlinked rows first, then linked, then billed, newest part
    // first in each — a bill is the last decision on the sheet to disturb.
    const settled = (row: LedgerRowState) => (row.linked ? 1 : 0) + (row.billed ? 1 : 0)
    const order = [...existing].sort((a, b) => settled(a) - settled(b) || b.splitIndex - a.splitIndex)

    for (const row of order) {
      if (diff === 0) {
        break
      }
      const take = Math.min(row.qty, -diff)
      diff += take
      if (take === row.qty) {
        plan.remove.push(row.id)
      } else {
        plan.setQty.push({ id: row.id, qty: row.qty - take })
      }
    }
  }

  for (const [sourceKey, list] of bySource) {
    if (!wanted.has(sourceKey)) {
      plan.remove.push(...list.map((row) => row.id))
    }
  }

  return plan
}
