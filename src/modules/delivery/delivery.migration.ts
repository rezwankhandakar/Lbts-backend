import type { Types } from 'mongoose'
import { ChallanModel } from '../challan/challan.model'
import { INITIAL_DISPATCH_STATUS } from './delivery.constants'
import { refreshChallanDispatch } from './delivery.dispatch'
import { DeliveryModel } from './delivery.model'

/**
 * Removes delivery records written by an **earlier, different** implementation
 * of this module.
 *
 * The `deliveries` collection was used once before, by a design that is no
 * longer anywhere in this repository: those documents carry a `deliveryCode`
 * (`DL-000001`), a `Draft`/`Confirmed` status, `vendorSnapshot` / `vehicleSnapshot`
 * instead of `vendor` / `vehicle`, a separate `tripId`, and product lines with
 * `originalLineIndex` and `shortfall`. Nothing maps them onto a trip, because
 * the two designs disagree about what a delivery *is* — the old one kept a
 * draft in the database and a trip in a second collection, and this one says a
 * trip does not exist until it is confirmed.
 *
 * So this is a deletion rather than a fold, for the reason
 * `purgeCancelledGatePasses` deletes rather than converts: there is no honest
 * record to convert them into. It matters more than tidiness — one of those
 * documents has no `challans[].original`, which is required now, and the list
 * endpoint answered 500 for the whole page because of it.
 *
 * **`submissionKey` is the marker.** Every trip this module writes carries one
 * (it is required, and it is what makes a confirmation idempotent), and no
 * document from the old design has one. That makes the rule precise and
 * self-describing rather than a guess at a shape.
 *
 * Idempotent — after the first run there is nothing to match — and it never
 * throws: a migration that takes the API down on boot is worse than the records
 * it was trying to clear.
 */
export async function purgeLegacyDeliveries(): Promise<void> {
  try {
    /**
     * Through the driver rather than the model: these documents hold paths the
     * schema no longer has, and several hold values its enums would refuse, so
     * a Mongoose query would strip the very fields being looked for.
     */
    const result = await DeliveryModel.collection.deleteMany({
      submissionKey: { $exists: false },
    })

    if (result.deletedCount > 0) {
      console.warn(
        `[delivery] removed ${result.deletedCount} record(s) from an earlier delivery design; ` +
          'they carried no trip number this module could honour.',
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] legacy purge skipped: ${message}`)
  }
}

/**
 * Brings the collection's **indexes** in line with this model, and this is the
 * half that actually stopped the module working.
 *
 * The earlier design left a `deliveryCode_1` index behind — and it was
 * *unique*. No trip this module writes has a `deliveryCode`, so every one of
 * them indexes as null: the first insert took the null key, and the second was
 * refused with "A record with this deliveryCode already exists". Deleting the
 * old documents does not touch an index, so the purge above could never have
 * fixed it. Several other leftovers (`tripId_1`, `status_1_updatedAt_-1`,
 * `challans.challanId_1_status_1`) were merely dead weight on every write.
 *
 * `syncIndexes` is the honest tool for it: drop what the schema does not
 * declare, create what it does. It is safe here because this collection
 * belongs to this module alone — nothing else writes it, and no index on it is
 * created by hand. It is a no-op once the two agree, so it costs one
 * `listIndexes` on a boot that has nothing to do.
 *
 * Never throws: an API that will not start is worse than an index that is one
 * boot late.
 */
/**
 * Gives every challan a dispatch status, and recomputes the ones on a trip.
 *
 * Two passes, in the shape `backfillChallanChargeStatus` uses. The first is one
 * `updateMany` over challans written before the field existed — they are
 * `Pending` by definition, because a challan nothing carries has not been
 * dispatched. The second recomputes only the challans a trip actually names,
 * which is bounded by the trips on record rather than by the collection.
 *
 * Idempotent, and it never throws: a status one boot stale is a filter reading
 * slightly wrong, not a reason to refuse to start.
 */
export async function backfillChallanDispatch(): Promise<void> {
  try {
    const filled = await ChallanModel.collection.updateMany(
      { dispatchStatus: { $exists: false } },
      { $set: { dispatchStatus: INITIAL_DISPATCH_STATUS, dispatchedQty: 0 } },
    )

    if (filled.modifiedCount > 0) {
      console.warn(
        `[delivery] ${filled.modifiedCount} challan(s) had no dispatch status and are Pending`,
      )
    }

    // Written later than the status, so a challan can have one and not these.
    await ChallanModel.collection.updateMany(
      { returnedQty: { $exists: false } },
      { $set: { returnedQty: 0, resentQty: 0 } },
    )

    const carried = await DeliveryModel.distinct('challans.challanId')

    if (carried.length > 0) {
      await refreshChallanDispatch(carried as Types.ObjectId[])
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] dispatch backfill skipped: ${message}`)
  }
}

/**
 * Converts trips written under the old status vocabulary.
 *
 * A trip used to be stepped `Assigned → Dispatched → Delivered` by hand, and
 * it is now `Open` or `Completed`, derived from whether every challan on it
 * has its signed copy in. No historical trip has a signed copy — the field did
 * not exist — so every one of them is `Open`, which is the honest answer: the
 * paperwork has not come back, because nobody was ever asked for it.
 *
 * That is a real loss of information for a trip somebody had marked
 * `Delivered`, and it is taken deliberately. The old flag recorded that an
 * operator pressed a button, which is the very thing this module stopped
 * treating as evidence; carrying it forward as a completion would mean a
 * `Completed` trip with nothing behind it, and the first person to open one
 * looking for the signed copy would find nothing and trust neither. An
 * operator who has the paper can scan it in, which is one barcode read.
 *
 * It matters more than tidiness: Mongoose validates the **whole document** on
 * save, so a trip still carrying `Dispatched` would refuse an unrelated edit
 * with an opaque "Validation failed" — the same reason `user.migration.ts`
 * normalises the old role and status vocabulary.
 *
 * Through the driver rather than the model, because these documents hold a
 * value the schema's enum no longer accepts. Idempotent — after the first run
 * nothing matches — and it never throws.
 */
export async function migrateTripStatuses(): Promise<void> {
  try {
    const result = await DeliveryModel.collection.updateMany(
      { status: { $nin: ['Open', 'Completed'] } },
      {
        $set: { status: 'Open', completedAt: null },
        $unset: { dispatchedAt: '', dispatchedBy: '', deliveredAt: '', deliveredBy: '' },
      },
    )

    if (result.modifiedCount > 0) {
      console.warn(
        `[delivery] ${result.modifiedCount} trip(s) written under the old Assigned/Dispatched/Delivered ` +
          'vocabulary are now Open; a trip is Completed when every challan on it has been signed for.',
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] trip status migration skipped: ${message}`)
  }
}

export async function syncDeliveryIndexes(): Promise<void> {
  try {
    const dropped = await DeliveryModel.syncIndexes()

    if (dropped.length > 0) {
      console.warn(
        `[delivery] dropped ${dropped.length} index(es) left by an earlier delivery design: ${dropped.join(', ')}`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] index sync skipped: ${message}`)
  }
}
