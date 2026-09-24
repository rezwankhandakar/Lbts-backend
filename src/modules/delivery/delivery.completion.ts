import type { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { ChallanModel } from '../challan/challan.model'
import { applyDeliveryItems } from '../challan/challan.service'
import {
  COMPLIANCE_AUDIENCE_ROLES,
  OPERATIONS_AUDIENCE_ROLES,
} from '../notification/notification.constants'
import { notify } from '../notification/notification.recorder'
import type { UserDocument } from '../user/user.model'
import { recordActivity } from '../vendor/vendor.activity'
import { resolveActorNames } from '../vendor/vendor.lookups'
import { assertCanChangeTrip } from './delivery.access'
import { comparisonKey, rebuildChallanItems, sameItems } from './delivery.allocation'
import { carryingTotalOf } from './delivery.constants'
import { refreshChallanDispatch } from './delivery.dispatch'
import { findByScan, otherTripLinesFor, sourceLinesOf } from './delivery.lookups'
import { DeliveryModel } from './delivery.model'
import type { DeliveryDocument } from './delivery.model'
import { toTripRecord } from './delivery.serializer'
import type { TripRecord } from './delivery.serializer'
import { deleteReceivedCopy, uploadReceivedCopy } from './delivery.storage'
import type { CompletionInput } from './delivery.validation'

/**
 * The far end of a delivery: what came back, what it cost to get it upstairs,
 * and the signed copy that says it arrived.
 *
 * This is the half of the module that runs *after* the lorry has gone, and it
 * exists because the status timeline it replaced was a fiction. A trip used to
 * be stepped `Assigned → Dispatched → Delivered` by hand, which meant
 * `Delivered` recorded whether somebody remembered to press a button. What
 * actually ends a delivery is the receiver signing the challan copy and that
 * copy coming back to the office — so the evidence is the record, and the
 * trip's own status is arithmetic over its challans.
 *
 * Three things are recorded here, and they are deliberately separate:
 *
 * - **A return** is goods that went out and came back. It is a *retroactive
 *   split*: the challan keeps ordering them and another trip may take them.
 *   It is never a correction, which is the distinction the whole module turns
 *   on — see `rebuildChallanItems`.
 * - **A floor and a carrying charge** are what the delivery cost to finish.
 *   They belong to the trip's challan entry because they are facts about one
 *   run to one door, not about the office's paperwork.
 * - **The signed copy** completes it. Nothing else does; there is no flag.
 */

interface TripChallanTarget {
  trip: DeliveryDocument
  challan: DeliveryDocument['challans'][number]
}

async function findTargetOr404(tripId: string, challanId: string): Promise<TripChallanTarget> {
  const trip = await DeliveryModel.findById(tripId)
  if (!trip) {
    throw new AppError(404, 'Trip not found.')
  }

  const challan = trip.challans.find((entry) => String(entry.challanId) === String(challanId))
  if (!challan) {
    throw new AppError(404, 'That challan is not on this trip.')
  }

  return { trip, challan }
}

/** A single trip with its challans, as every write in the far half answers. */
export async function serialize(trip: DeliveryDocument): Promise<TripRecord> {
  const names = await resolveActorNames([
    trip.createdBy,
    trip.updatedBy,
    trip.billUpdatedBy,
    ...trip.challans.map((challan) => challan.completedBy),
  ])
  return toTripRecord(trip, names, { withChallans: true })
}

/**
 * Puts the challan back in step with every trip carrying it.
 *
 * Under the rebuild rule a return is conserved — what a trip stops carrying it
 * starts holding — so this is a no-op for an ordinary return, and that is the
 * point: recording that two refrigerators came back must never rewrite the
 * office's paperwork. It is run anyway because it is one read the caller has
 * already paid for and it makes the module self-correcting; `sameItems` is
 * what keeps a challan from being marked `Amended` by a delivery that changed
 * nothing about what was ordered.
 *
 * Never throws, for the reason `applyCorrections` does not: the trip is the
 * record of what physically happened, and a challan one write behind is a
 * filter reading slightly wrong rather than a reason to refuse it.
 */
async function syncChallanAfterCompletion(
  challanId: Types.ObjectId,
  actor: UserDocument,
): Promise<void> {
  try {
    const challan = await ChallanModel.findById(challanId)
    if (!challan) {
      return
    }

    const others = await otherTripLinesFor([challan._id], null)
    const entry = others.get(String(challan._id)) ?? { lines: [], reserved: [], trips: [] }
    const current = sourceLinesOf(challan)
    const next = rebuildChallanItems(current, entry.lines, entry.reserved)

    if (next.length === 0 || sameItems(current, next)) {
      return
    }

    await applyDeliveryItems(challan, next, actor)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] challan not synced after a completion change: ${message}`)
  }
}

/**
 * What came back, how far up it went, and what that cost.
 *
 * A **whole-list replace** for both the returns and the charges, exactly as the
 * Challan module's skipped pages are: it is idempotent, and undoing a return is
 * the same call with that line left out. The returned lines name positions on
 * *this trip's* manifest, and the product and quantity are read off the trip
 * rather than taken from the request — a body cannot return goods the lorry
 * never carried, which would be a way to put quantity back onto somebody's
 * challan.
 */
export async function recordCompletion(
  tripId: string,
  challanId: string,
  input: CompletionInput,
  actor: UserDocument,
): Promise<TripRecord> {
  const { trip, challan } = await findTargetOr404(tripId, challanId)
  assertCanChangeTrip(trip, actor)

  const returned = input.returned.map((entry) => {
    const line = challan.lines[entry.lineIndex]

    if (!line) {
      throw new AppError(400, 'A returned line is not on this trip.')
    }
    if (entry.qty > line.qty) {
      throw new AppError(
        409,
        `${entry.qty} × ${line.productName} cannot come back when the lorry took ${line.qty}.`,
      )
    }

    return {
      productName: line.productName,
      productModel: line.productModel,
      productModelKey: comparisonKey(line.productModel),
      qty: entry.qty,
      reason: entry.reason,
    }
  })

  challan.set('returned', returned)
  challan.set('floorNo', input.floorNo)
  challan.set(
    'carrying',
    input.carrying.map((entry) => ({
      kind: entry.kind,
      description: entry.description,
      amount: entry.amount,
    })),
  )
  challan.set('deliveryNote', input.deliveryNote)

  const wasComplete = Boolean(challan.completedAt)
  trip.updatedBy = actor._id
  await trip.save()
  const nowComplete = Boolean(challan.completedAt)

  await syncChallanAfterCompletion(challan.challanId, actor)
  await refreshChallanDispatch([challan.challanId])

  const returnedQty = returned.reduce((sum, line) => sum + line.qty, 0)
  const charged = carryingTotalOf(input.carrying)

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.updated',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary:
      `${challan.challanNumber} on ${trip.tripNumber}: ` +
      (returnedQty > 0 ? `${returnedQty} piece(s) returned` : 'nothing returned') +
      (input.floorNo === null ? '' : `, floor ${input.floorNo}`) +
      (charged > 0 ? `, carrying ${charged}` : '') +
      (!wasComplete && nowComplete ? '; returned in full and closed' : '') +
      (wasComplete && !nowComplete ? '; reopened' : ''),
    actor,
  })

  /**
   * Goods back at the depot are announced, and nothing else on this screen is.
   *
   * A floor number and a carrying charge are facts about a delivery that is
   * over; returned pieces are a **job**, and the distinction is the one
   * `attention.ts` draws on the dashboard between a reading and something
   * outstanding. The challan goes back to `Pending` with those pieces on a
   * shelf, and whoever loads tomorrow's lorry has no way of learning that short
   * of filtering the Challan list for it — which is a question somebody has to
   * think to ask.
   *
   * Only when something actually came back: a call that records a floor number
   * and no return has nothing to announce, and re-saving the same screen must
   * not ring the bell twice. There is deliberately no `groupKey` — a second
   * return recorded on the same trip *is* a second thing to be told about, and
   * the sweep's deduplication would swallow it.
   */
  if (returnedQty > 0) {
    await notify({
      event: 'delivery.goods-returned',
      audience: { kind: 'roles', roles: OPERATIONS_AUDIENCE_ROLES },
      title: `${returnedQty} ${returnedQty === 1 ? 'piece' : 'pieces'} came back on ${trip.tripNumber}`,
      body:
        `${challan.challanNumber}: ` +
        returned.map((line) => `${line.qty} × ${line.productName}`).join(', ') +
        `. The challan is waiting for a lorry again.`,
      entityType: 'Trip',
      entityId: trip._id,
      entityLabel: trip.tripNumber,
      actor,
    })
  }

  return serialize(trip)
}

/**
 * The signed copy arriving, which is what completes the delivery.
 *
 * The order is the safety property, and it is the one every storage path in
 * this codebase keeps: upload the new object, write the reference, *then*
 * delete the one it replaced. The worst outcome of a failure is an orphan in
 * the bucket, never a record pointing at a file that is gone. If the write
 * fails after an upload the new object is discarded rather than left behind.
 *
 * Re-uploading over an existing copy is allowed and ordinary — a page missed
 * off the feeder, a photograph too dark to read a signature on — and it does
 * not change who completed the delivery or when. Replacing the evidence is not
 * the same as completing it again.
 */
export async function attachReceivedCopy(
  tripId: string,
  challanId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
  pageCount: number | null,
  actor: UserDocument,
): Promise<TripRecord> {
  const { trip, challan } = await findTargetOr404(tripId, challanId)
  assertCanChangeTrip(trip, actor)

  const previous = challan.receivedCopy?.key ?? null
  const wasComplete = Boolean(challan.completedAt)

  const stored = await uploadReceivedCopy({
    tripId: String(trip._id),
    challanId: String(challan.challanId),
    tripDate: trip.tripDate,
    buffer: file.buffer,
    mimeType: file.mimetype,
    originalName: file.originalname,
    pageCount,
  })

  challan.set('receivedCopy', stored)
  // The copy turned up after all, so the declaration that it was lost is void.
  challan.set('copyMissing', false)
  challan.set('copyMissingReason', '')
  trip.updatedBy = actor._id

  try {
    await trip.save()
  } catch (error) {
    // The reference never landed, so the object just written is litter.
    await deleteReceivedCopy(stored.key)
    throw error
  }

  if (previous && previous !== stored.key) {
    await deleteReceivedCopy(previous)
  }

  await refreshChallanDispatch([challan.challanId])

  if (!wasComplete) {
    await recordActivity({
      vendorId: trip.vendorId,
      action: 'trip.status',
      entityType: 'Trip',
      entityId: trip._id,
      entityLabel: trip.tripNumber,
      summary: `${challan.challanNumber} on ${trip.tripNumber} signed for and completed`,
      actor,
    })
  }

  return serialize(trip)
}

/**
 * Taking the signed copy back off, which reopens the delivery.
 *
 * The correction path, and the reason there is no status to step backwards:
 * a copy filed against the wrong challan, or a scan nobody can read, is an
 * ordinary mistake and a record nobody may correct is one nobody trusts. It
 * reopens the trip by the same arithmetic that closed it.
 *
 * The reference is cleared *first* and the object deleted after, so the worst
 * outcome of a failure is an orphan rather than a completion pointing at
 * nothing.
 */
export async function clearReceivedCopy(
  tripId: string,
  challanId: string,
  actor: UserDocument,
): Promise<TripRecord> {
  const { trip, challan } = await findTargetOr404(tripId, challanId)
  assertCanChangeTrip(trip, actor)

  if (!challan.receivedCopy) {
    throw new AppError(409, `No signed copy is on record for ${challan.challanNumber}.`)
  }

  const key = challan.receivedCopy.key

  challan.set('receivedCopy', null)
  trip.updatedBy = actor._id
  // The hook reopens it — unless the goods all came back, which needs no copy.
  await trip.save()

  await deleteReceivedCopy(key)
  await refreshChallanDispatch([challan.challanId])

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.status',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary: challan.completedAt
      ? `${challan.challanNumber} on ${trip.tripNumber}: signed copy removed`
      : `${challan.challanNumber} on ${trip.tripNumber} reopened; its signed copy was removed`,
    actor,
  })

  return serialize(trip)
}

/**
 * Closing a delivery whose signed copy is lost.
 *
 * Paper goes missing off lorries, and a delivery that can never be closed
 * holds its whole trip open with it. So the operator may say so — with a
 * reason, which is kept — and the delivery completes on that statement. It is
 * refused while a copy is on record, because then nothing is missing; and
 * filing a copy later clears it, because the evidence outranks the excuse.
 */
export async function markCopyMissing(
  tripId: string,
  challanId: string,
  reason: string,
  actor: UserDocument,
): Promise<TripRecord> {
  const { trip, challan } = await findTargetOr404(tripId, challanId)
  assertCanChangeTrip(trip, actor)

  if (challan.receivedCopy) {
    throw new AppError(409, `A signed copy is already on record for ${challan.challanNumber}.`)
  }

  const wasComplete = Boolean(challan.completedAt)
  challan.set('copyMissing', true)
  challan.set('copyMissingReason', reason)
  trip.updatedBy = actor._id
  await trip.save()

  await refreshChallanDispatch([challan.challanId])

  if (!wasComplete) {
    await recordActivity({
      vendorId: trip.vendorId,
      action: 'trip.status',
      entityType: 'Trip',
      entityId: trip._id,
      entityLabel: trip.tripNumber,
      summary:
        `${challan.challanNumber} on ${trip.tripNumber} completed without a signed copy` +
        (reason ? `: ${reason}` : ''),
      actor,
    })

    /**
     * And the two roles who chase paper are told.
     *
     * This is the one statement in the whole delivery flow an operator can make
     * **without evidence** — every other completion rests on a scanned copy —
     * so it is the one that wants a second pair of eyes. The operator who
     * declared it is excluded, because they already know; that is exactly why
     * this is addressed to a role rather than to them.
     *
     * Guarded on `wasComplete` alongside the journal row, so withdrawing and
     * re-declaring does not announce the same lost sheet twice.
     */
    await notify({
      event: 'delivery.copy-missing',
      audience: { kind: 'roles', roles: COMPLIANCE_AUDIENCE_ROLES },
      title: `No signed copy for ${challan.challanNumber}`,
      body:
        `Closed on ${trip.tripNumber} without the receiver's copy.` +
        (reason ? ` Reason: ${reason}` : '') +
        ' Filing a copy later clears this.',
      entityType: 'Trip',
      entityId: trip._id,
      entityLabel: trip.tripNumber,
      actor,
    })
  }

  return serialize(trip)
}

/** Withdrawing the lost-copy declaration, which reopens the delivery. */
export async function clearCopyMissing(
  tripId: string,
  challanId: string,
  actor: UserDocument,
): Promise<TripRecord> {
  const { trip, challan } = await findTargetOr404(tripId, challanId)
  assertCanChangeTrip(trip, actor)

  if (!challan.copyMissing) {
    throw new AppError(409, `${challan.challanNumber} is not marked as missing its signed copy.`)
  }

  challan.set('copyMissing', false)
  challan.set('copyMissingReason', '')
  trip.updatedBy = actor._id
  await trip.save()

  await refreshChallanDispatch([challan.challanId])

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.status',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary: `${challan.challanNumber} on ${trip.tripNumber}: missing-copy mark withdrawn`,
    actor,
  })

  return serialize(trip)
}

export interface ReceivedCopyRef {
  key: string
  mimeType: string
  originalName: string
}

/**
 * The stored object's key, once the caller has been proved able to read it.
 *
 * The route streams it. A signed challan carries the customer's address, their
 * phone number and somebody's signature, so the bucket never serves it and
 * this is the only read path.
 */
export async function findReceivedCopy(
  tripId: string,
  challanId: string,
): Promise<ReceivedCopyRef> {
  const { challan } = await findTargetOr404(tripId, challanId)

  if (!challan.receivedCopy) {
    throw new AppError(404, `No signed copy is on record for ${challan.challanNumber}.`)
  }

  return {
    key: challan.receivedCopy.key,
    mimeType: challan.receivedCopy.mimeType,
    originalName: challan.receivedCopy.originalName || `${challan.challanNumber}.pdf`,
  }
}

export interface ReceiptScanResult {
  /** The trip whose delivery this barcode is about. */
  trip: TripRecord
  challanId: string
  challanNumber: string
  /**
   * Every trip carrying this challan, so a challan split across two lorries can
   * say which one the operator meant rather than silently choosing.
   */
  otherTrips: { id: string; tripNumber: string; tripDate: string; outcome: string }[]
}

/**
 * Where a scanned challan copy belongs.
 *
 * An operator at the desk holds the signed sheet that came back and reads its
 * barcode; this says which delivery it is the receipt for. **Deliberately a
 * different endpoint from the cart's scan**, which asks the opposite question
 * — what is still to go, so a challan can be put on a lorry. One endpoint
 * answering both would mean a scan meaning different things depending on which
 * page happened to be open, which is exactly the kind of thing somebody
 * discovers at a gate.
 *
 * The trip it opens is the **oldest open one** carrying the challan: a challan
 * split across two lorries is signed for twice, and the receipts come back in
 * the order the lorries went. When every trip carrying it is already complete
 * it opens the most recent, so a copy that has to be replaced still lands
 * somewhere sensible.
 */
export async function findDeliveryByScan(code: string): Promise<ReceiptScanResult> {
  const challan = await findByScan(code)

  if (!challan) {
    throw new AppError(404, `No challan carries the barcode ${code.trim()}.`)
  }

  const trips = await DeliveryModel.find({ 'challans.challanId': challan._id }).sort({
    tripDate: 1,
    createdAt: 1,
  })

  if (trips.length === 0) {
    throw new AppError(
      409,
      `${challan.challanNumber} has not gone out on any trip yet, so there is no delivery to complete. Add it to a trip first.`,
    )
  }

  const entryOn = (trip: DeliveryDocument) =>
    trip.challans.find((entry) => String(entry.challanId) === String(challan._id))

  const chosen = trips.find((trip) => !entryOn(trip)?.completedAt) ?? trips[trips.length - 1]

  return {
    trip: await serialize(chosen),
    challanId: String(challan._id),
    challanNumber: challan.challanNumber,
    otherTrips: trips
      .filter((trip) => String(trip._id) !== String(chosen._id))
      .map((trip) => ({
        id: String(trip._id),
        tripNumber: trip.tripNumber,
        tripDate: trip.tripDate.toISOString().slice(0, 10),
        outcome: entryOn(trip)?.completedAt ? 'Complete' : 'Pending',
      })),
  }
}
