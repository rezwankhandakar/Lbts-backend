import type { Types } from 'mongoose'
import { completionMethodFor } from './delivery.constants'
import { DeliveryModel } from './delivery.model'
import { toTripLines } from './delivery.serializer'

/**
 * The signed copies a challan has, across every trip that carried it.
 *
 * `delivery.dispatch.ts` answers *how much* of a challan has gone; this answers
 * *what paper came back for it*, which is the question anything assembling a
 * challan's evidence asks — the Walton Labour Bill printing the copies behind
 * a month's handling charges is the first caller.
 *
 * It lives here rather than in whichever module wants it because a signed copy
 * is a fact about a trip: the object key, who may read it and the endpoint that
 * streams it all belong to Delivery, and a second reader of `challans` would be
 * a second place to get the "which trip is this copy filed under" wrong.
 *
 * A challan split across two lorries is signed for twice, so the answer is a
 * **list** per challan and never one copy. Nothing here is an ownership check —
 * the callers sit behind their own module's read roles, which are the same set
 * `DELIVERY_READ_ROLES` is.
 */

type IdLike = Types.ObjectId | string

/** One signed copy, as it is filed against one trip. */
export interface ChallanSignedCopy {
  tripId: string
  tripNumber: string
  /** The trip's calendar day, YYYY-MM-DD. */
  tripDate: string
  /**
   * The R2 object key. **Internal** — it is what a merge reads the bytes with,
   * and no serializer may put it on the wire. `url` is the client's half.
   */
  key: string
  /** The authenticated API path the browser fetches, as `toTripChallan` builds it. */
  url: string
  mimeType: string
  size: number
  originalName: string
  pageCount: number | null
  uploadedAt: string
}

/**
 * What one challan's paper looks like: the copies that are in, and — for the
 * trips with none — why, in the module's own completion vocabulary, so a caller
 * can say "still waiting" and "declared lost" apart rather than reporting a
 * blank.
 */
export interface ChallanCopyState {
  copies: ChallanSignedCopy[]
  /** Trips carrying it whose signed copy has not come back yet. */
  awaiting: number
  /** Trips where the copy has been declared lost. */
  declaredMissing: number
  /** Trips whose goods all came back, so no copy was ever asked for. */
  returnedInFull: number
  /** Every trip carrying it, whatever its state. */
  trips: number
}

export const EMPTY_COPY_STATE: ChallanCopyState = {
  copies: [],
  awaiting: 0,
  declaredMissing: 0,
  returnedInFull: 0,
  trips: 0,
}

/**
 * Every trip carrying each of these challans, reduced to what paper came back.
 *
 * One multikey read on `challans.challanId` whatever the number of challans —
 * the rule every lookup in this module follows — sorted the way the trips ran,
 * so a challan split across two lorries lists its copies oldest first.
 */
export async function readChallanSignedCopies(
  challanIds: IdLike[],
): Promise<Map<string, ChallanCopyState>> {
  const result = new Map<string, ChallanCopyState>()
  const wanted = new Set(challanIds.map(String))

  if (wanted.size === 0) {
    return result
  }

  const trips = await DeliveryModel.find({ 'challans.challanId': { $in: [...wanted] } })
    .select('tripNumber tripDate challans')
    .sort({ tripDate: 1, createdAt: 1 })

  for (const trip of trips) {
    const tripId = String(trip._id)
    const tripDate = trip.tripDate.toISOString().slice(0, 10)

    for (const challan of trip.challans) {
      const key = String(challan.challanId)
      if (!wanted.has(key)) {
        continue
      }

      const state = result.get(key) ?? { ...EMPTY_COPY_STATE, copies: [] }
      state.trips += 1

      const lines = toTripLines(challan)
      const method = completionMethodFor({
        hasCopy: Boolean(challan.receivedCopy),
        copyMissing: Boolean(challan.copyMissing),
        carried: lines.reduce((sum, line) => sum + line.qty, 0),
        returned: (challan.returned ?? []).reduce((sum, line) => sum + line.qty, 0),
      })

      if (challan.receivedCopy) {
        state.copies.push({
          tripId,
          tripNumber: trip.tripNumber,
          tripDate,
          key: challan.receivedCopy.key,
          url: `/deliveries/${tripId}/challans/${key}/received-copy`,
          mimeType: challan.receivedCopy.mimeType,
          size: challan.receivedCopy.size,
          originalName: challan.receivedCopy.originalName ?? '',
          pageCount: challan.receivedCopy.pageCount ?? null,
          uploadedAt: challan.receivedCopy.uploadedAt.toISOString(),
        })
      } else if (method === 'Returned') {
        state.returnedInFull += 1
      } else if (method === 'CopyMissing') {
        state.declaredMissing += 1
      } else {
        state.awaiting += 1
      }

      result.set(key, state)
    }
  }

  return result
}
