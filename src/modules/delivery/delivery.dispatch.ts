import type { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { ChallanModel } from '../challan/challan.model'
import type { ChallanDocument } from '../challan/challan.model'
import { lineKey, netQty } from './delivery.allocation'
import type { SourceLine } from './delivery.allocation'
import { dispatchStatusFor, returnFlowFor } from './delivery.constants'
import type { DeliveryOutcome, DispatchStatus, TripStatus } from './delivery.constants'
import { DeliveryModel } from './delivery.model'
import { toTripLines } from './delivery.serializer'
import { syncTripDoLedger } from '../trip-do/trip-do.sync'

/**
 * What the trips say about a challan — the one direction in which Delivery
 * writes onto a challan without being asked to correct it.
 *
 * Everything here answers the same question from a different distance: how much
 * of this challan has left the gate. The records list needs it as a stored
 * status it can filter on, the challan's own page needs it line by line with
 * the trips named, and the Challan module needs it as a refusal — a challan
 * cannot be deleted out from under a lorry, or corrected down below what has
 * already gone.
 *
 * It lives in the Delivery module because it is a fact about trips. Challan
 * imports it; nothing here imports Challan's service, so the two do not circle.
 */

type IdLike = Types.ObjectId | string

export interface TripRef {
  id: string
  tripNumber: string
  status: TripStatus
  tripDate: string
  registrationNo: string
  driverName: string
  /** What this trip left with the receiver — carried, less what came back. */
  qty: number
  /** What went out on this trip and came back. */
  returnedQty: number
  /** Whether this trip's copy of the challan has been signed for. */
  outcome: DeliveryOutcome
}

export interface DispatchedProduct {
  productName: string
  model: string
  qty: number
  /** Pieces of this product that went out and came back. */
  returned: number
}

/** One product that came back off one trip, with the operator's reason. */
export interface DispatchReturn {
  tripId: string
  tripNumber: string
  productName: string
  model: string
  qty: number
  reason: string
}

export interface ChallanDispatch {
  trips: TripRef[]
  dispatchedQty: number
  /** What has gone out, by product — `lineKey` to the quantity. */
  byProduct: Map<string, DispatchedProduct>
  returns: DispatchReturn[]
}

const EMPTY: ChallanDispatch = { trips: [], dispatchedQty: 0, byProduct: new Map(), returns: [] }

/**
 * Every trip carrying each of these challans, with what it carried.
 *
 * One multikey read on `challans.challanId`, whatever the number of challans —
 * the same rule every lookup in this module follows. Every status counts: a
 * delivered refrigerator is exactly as gone as one on a lorry.
 */
export async function readChallanDispatch(
  challanIds: IdLike[],
): Promise<Map<string, ChallanDispatch>> {
  const result = new Map<string, ChallanDispatch>()

  if (challanIds.length === 0) {
    return result
  }

  const trips = await DeliveryModel.find({ 'challans.challanId': { $in: challanIds } })
    .select('tripNumber status tripDate vehicle driver challans')
    .sort({ tripDate: 1, createdAt: 1 })

  const wanted = new Set(challanIds.map(String))

  for (const trip of trips) {
    for (const challan of trip.challans) {
      const key = String(challan.challanId)
      if (!wanted.has(key)) {
        continue
      }

      const entry = result.get(key) ?? {
        trips: [],
        dispatchedQty: 0,
        byProduct: new Map<string, DispatchedProduct>(),
        returns: [],
      }

      for (const back of challan.returned ?? []) {
        entry.returns.push({
          tripId: String(trip._id),
          tripNumber: trip.tripNumber,
          productName: back.productName,
          model: back.productModel,
          qty: back.qty,
          reason: back.reason ?? '',
        })
      }

      /**
       * **Net**, throughout. A refrigerator that went out on Tuesday and came
       * back on Tuesday evening has not been dispatched — it is on a shelf at
       * the depot, and this challan is waiting for another lorry exactly as it
       * was before. Counting it as gone would leave the customer's order
       * showing as delivered and offer nothing to the next trip.
       */
      let delivered = 0
      let returned = 0

      for (const line of toTripLines(challan)) {
        const net = netQty(line)
        delivered += net
        returned += line.returned ?? 0

        const product = { productName: line.productName, model: line.model }
        const existing = entry.byProduct.get(lineKey(product))

        if (existing) {
          existing.qty += net
          existing.returned += line.returned ?? 0
        } else {
          entry.byProduct.set(lineKey(product), { ...product, qty: net, returned: line.returned ?? 0 })
        }
      }

      entry.dispatchedQty += delivered
      entry.trips.push({
        id: String(trip._id),
        tripNumber: trip.tripNumber,
        status: trip.status as TripStatus,
        tripDate: trip.tripDate.toISOString().slice(0, 10),
        registrationNo: trip.vehicle.registrationNo,
        driverName: trip.driver.name,
        qty: delivered,
        returnedQty: returned,
        outcome: challan.completedAt ? 'Complete' : 'Pending',
      })

      result.set(key, entry)
    }
  }

  return result
}

export async function readOneChallanDispatch(challanId: IdLike): Promise<ChallanDispatch> {
  return (await readChallanDispatch([challanId])).get(String(challanId)) ?? EMPTY
}

/**
 * Writes `dispatchStatus` and `dispatchedQty` back onto each challan.
 *
 * Called wherever a trip changes what it carries — created, corrected, moved
 * along, deleted — in the same spirit as `refreshBatchProgress` in Challan:
 * derived and rewritten from the source, never incremented, so it cannot drift.
 *
 * Two things it deliberately does **not** do. It never throws: a challan whose
 * status is one boot stale is a filter reading slightly wrong, and refusing a
 * trip over it would be refusing the thing that actually happened. And it
 * writes with `timestamps: false`, because a challan whose lorry left is not a
 * challan somebody edited — touching `updatedAt` would say it was.
 */
export async function refreshChallanDispatch(challanIds: IdLike[]): Promise<void> {
  const unique = [...new Set(challanIds.map(String))]

  if (unique.length === 0) {
    return
  }

  try {
    const [challans, dispatch] = await Promise.all([
      ChallanModel.find({ _id: { $in: unique } }).select(
        'items dispatchStatus dispatchedQty returnedQty resentQty',
      ),
      readChallanDispatch(unique),
    ])

    const writes = challans.flatMap((challan) => {
      const entry = dispatch.get(String(challan._id)) ?? EMPTY
      const ordered = challan.items.reduce((sum, item) => sum + item.qty, 0)

      const dispatchStatus: DispatchStatus = dispatchStatusFor({
        ordered,
        dispatched: entry.dispatchedQty,
        trips: entry.trips.length,
        everyTripCompleted: entry.trips.every((trip) => trip.outcome === 'Complete'),
      })

      // `readChallanDispatch` sorts the trips in the order they ran.
      const { returnedQty, resentQty } = returnFlowFor(
        entry.trips.map((trip) => ({ delivered: trip.qty, returned: trip.returnedQty })),
      )

      // Nothing to say is nothing to write: most trips leave most challans
      // exactly where they were.
      if (
        challan.dispatchStatus === dispatchStatus &&
        challan.dispatchedQty === entry.dispatchedQty &&
        challan.returnedQty === returnedQty &&
        challan.resentQty === resentQty
      ) {
        return []
      }

      return [
        {
          updateOne: {
            filter: { _id: challan._id },
            update: {
              $set: { dispatchStatus, dispatchedQty: entry.dispatchedQty, returnedQty, resentQty },
            },
            timestamps: false,
          },
        },
      ]
    })

    if (writes.length > 0) {
      await ChallanModel.bulkWrite(writes, { timestamps: false })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] dispatch status not refreshed: ${message}`)
  }

  /**
   * And the Trip DO sheet, which copies what was just written and what the
   * trips did — returns and re-sends become rows of their own. Every trip
   * change reaches here, which is why this is the one place Delivery calls it.
   * Never throws.
   */
  await syncTripDoLedger(unique)
}

// --- What the challan's own page shows -------------------------------------

/** One challan line, with how much of it has gone out. */
export interface DispatchedLine {
  productName: string
  model: string
  ordered: number
  dispatched: number
  remaining: number
  /** Pieces that went out and came back — part of `remaining`, not a cut. */
  returned: number
}

/** A trip's correction to this challan, as the manifest recorded it. */
export interface DispatchCorrection {
  tripId: string
  tripNumber: string
  productName: string
  model: string
  /** What the line said when the trip took it, and what actually went. */
  from: number
  to: number
  /** The model it replaced, when the trip stood a different one in. */
  replaced: string | null
}

export interface ChallanDispatchDetail {
  challanId: string
  status: DispatchStatus
  ordered: number
  dispatched: number
  remaining: number
  lines: DispatchedLine[]
  trips: TripRef[]
  /** What came back off which trip — goods the challan still orders. */
  returns: DispatchReturn[]
  /**
   * What the trips changed about this challan's goods — read off each trip's
   * own line sources rather than stored anywhere, so `Amended` on a challan can
   * say *who* amended it and to what. The challan record keeps only that it
   * was amended and by whom.
   */
  corrections: DispatchCorrection[]
}

/**
 * Everything the challan's page needs to explain its dispatch state: which
 * trips carried it, how much of each line went, and what those trips corrected.
 *
 * One read of the trips carrying it — the challan is already in hand.
 */
export async function readChallanDispatchDetail(
  challan: ChallanDocument,
): Promise<ChallanDispatchDetail> {
  const dispatch = await readOneChallanDispatch(challan._id)

  const lines: DispatchedLine[] = challan.items.map((item) => {
    const key = lineKey({ productName: item.productName, model: item.productModel })
    const product = dispatch.byProduct.get(key)
    const gone = product?.qty ?? 0

    return {
      productName: item.productName,
      model: item.productModel,
      ordered: item.qty,
      dispatched: gone,
      remaining: Math.max(0, item.qty - gone),
      returned: product?.returned ?? 0,
    }
  })

  const ordered = lines.reduce((sum, line) => sum + line.ordered, 0)

  const corrections = await readCorrections(challan._id)

  return {
    challanId: String(challan._id),
    status: dispatchStatusFor({
      ordered,
      dispatched: dispatch.dispatchedQty,
      trips: dispatch.trips.length,
      everyTripCompleted: dispatch.trips.every((trip) => trip.outcome === 'Complete'),
    }),
    ordered,
    dispatched: dispatch.dispatchedQty,
    remaining: lines.reduce((sum, line) => sum + line.remaining, 0),
    lines,
    trips: dispatch.trips,
    returns: dispatch.returns,
    corrections,
  }
}

/**
 * The corrections the trips made, from what each line said when it was taken.
 *
 * A trip stores the source line beside what actually went, and that pair is the
 * only record of what the challan said before — so this is where "Amended"
 * gets its explanation from.
 */
async function readCorrections(challanId: IdLike): Promise<DispatchCorrection[]> {
  const trips = await DeliveryModel.find({ 'challans.challanId': challanId })
    .select('tripNumber challans')
    .sort({ tripDate: 1, createdAt: 1 })

  const corrections: DispatchCorrection[] = []

  for (const trip of trips) {
    for (const challan of trip.challans) {
      if (String(challan.challanId) !== String(challanId)) {
        continue
      }

      /**
       * Only a split's reservation is held back *from the lorry*. A return is
       * not: the line still carries what went out, and what came back is
       * recorded beside it — so adding returns here would make "took 6, 3 came
       * back" read as a correction to 6 of 6. Returns are listed on their own.
       */
      const reserved = new Map<string, number>()
      for (const line of challan.reserved ?? []) {
        const key = lineKey({ productName: line.productName, model: line.productModel })
        reserved.set(key, (reserved.get(key) ?? 0) + line.qty)
      }

      for (const line of challan.lines) {
        const source = line.source
        const carried = { productName: line.productName, model: line.productModel }

        if (!source) {
          corrections.push({
            tripId: String(trip._id),
            tripNumber: trip.tripNumber,
            ...carried,
            from: 0,
            to: line.qty,
            replaced: null,
          })
          continue
        }

        const swapped =
          lineKey(carried) !==
          lineKey({ productName: source.productName, model: source.productModel })
        const held = reserved.get(lineKey({ productName: source.productName, model: source.productModel })) ?? 0

        // A split changed nothing about the challan, so it is not a correction.
        if (!swapped && line.qty + held === source.qty) {
          continue
        }

        corrections.push({
          tripId: String(trip._id),
          tripNumber: trip.tripNumber,
          ...carried,
          from: source.qty,
          to: line.qty,
          replaced: swapped ? source.productModel : null,
        })
      }
    }
  }

  return corrections
}

// --- The refusals Challan needs --------------------------------------------

function tripList(trips: TripRef[]): string {
  return trips.map((trip) => trip.tripNumber).join(', ')
}

/**
 * A challan on a lorry cannot be deleted.
 *
 * The trip keeps its own copy of everything, so the manifest would still read —
 * but the link back would be dead, and a delivery that happened would have no
 * paperwork behind it. Taking it off the trip first is the honest order, and it
 * is one click on the trip.
 */
export async function assertChallanNotDispatched(challan: ChallanDocument): Promise<void> {
  const dispatch = await readOneChallanDispatch(challan._id)

  if (dispatch.trips.length > 0) {
    throw new AppError(
      409,
      `${challan.challanNumber} went out on ${tripList(dispatch.trips)}. Remove it from ${
        dispatch.trips.length === 1 ? 'that trip' : 'those trips'
      } first, then delete it.`,
    )
  }
}

/**
 * A correction cannot cut a challan below what has already gone out.
 *
 * The paper may be corrected long after a lorry has left — that is ordinary —
 * but not to say that less went than went. A trip is a record of a physical
 * event and the challan has to be able to account for it; the way to record
 * that less was actually delivered is to correct it **on the trip**, where the
 * two move together.
 */
export async function assertItemsCoverDispatched(
  challan: ChallanDocument,
  items: SourceLine[],
): Promise<void> {
  const dispatch = await readOneChallanDispatch(challan._id)

  if (dispatch.trips.length === 0) {
    return
  }

  const proposed = new Map<string, number>()
  for (const item of items) {
    proposed.set(lineKey(item), (proposed.get(lineKey(item)) ?? 0) + item.qty)
  }

  for (const [key, gone] of dispatch.byProduct) {
    const kept = proposed.get(key) ?? 0

    if (kept < gone.qty) {
      throw new AppError(
        409,
        `${gone.qty} × ${gone.productName} ${gone.model} already went out on ${tripList(
          dispatch.trips,
        )}, so this challan cannot say ${kept}. Correct it on the trip instead.`,
      )
    }
  }
}
