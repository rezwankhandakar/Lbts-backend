import type { Types } from 'mongoose'
import { CounterModel } from '../../utils/counter'
import { EntryModel } from '../accounts/accounts.model'
import { ChallanModel } from '../challan/challan.model'
import {
  formatTripNumber,
  INITIAL_DISPATCH_STATUS,
  TRIP_COUNTER_KEY,
} from './delivery.constants'
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

/**
 * The unique index behind the retired per-vendor serial. Mongoose named it
 * after its key pattern, and nothing declares it any more.
 */
const LEGACY_SERIAL_INDEX = 'vendorId_1_vendorTripSerial_1'

/**
 * Renumbers every trip onto the **one global serial** that replaced the
 * per-vendor one.
 *
 * A trip used to be `V-0007-TRIP-0012` — the twelfth trip that vendor ran —
 * and it is `TRIP-0012`, the twelfth trip the operation ran, by whoever. So
 * every trip already on record holds a number describing a sequence this module
 * no longer keeps, and two of them can genuinely be a twelfth trip.
 *
 * **It rewrites the identifier, which is why it is a migration and not a
 * display change.** Nothing can be derived from the old number — a vendor's
 * twelfth trip is not the operation's twelfth — so the serial is allocated here
 * from scratch, in `createdAt` order, which is the order the trips were
 * actually confirmed and therefore the only honest sequence to put them in.
 * `_id` breaks a tie, since an ObjectId is itself ordered by time.
 *
 * **Two passes, because a trip number is unique.** Assigning `TRIP-0001` to the
 * oldest trip collides with whatever already holds that string, so every trip
 * is first parked on a number nothing can clash with (`TMP-<id>`) and only then
 * given its serial. That is also what makes a half-finished run recoverable:
 * the marker is "some trip's number is not a bare serial yet", which a parked
 * trip satisfies, so a crash between the passes is retried on the next boot
 * rather than leaving the collection numbered two different ways.
 *
 * **The legacy index comes off first, and it is not optional.** The old unique
 * index was `{ vendorId, vendorTripSerial }`, and the second pass *unsets*
 * `vendorTripSerial` — which makes it null, and two trips of one vendor cannot
 * both hold a null under a unique index. So the renumbering refused itself
 * halfway with an `E11000` on a field it was in the middle of retiring. It
 * cannot be left to `syncDeliveryIndexes` either, which runs *after* this and
 * could not build the new unique index on `tripSerial` before there are any
 * values to build it over. It is read off the collection rather than assumed,
 * the way `syncVendorIndexes` reads what is actually there.
 *
 * Three more things follow the renumbering, and leaving any of them out would
 * be worse than not running at all:
 *
 * - **The counter is lifted to the highest serial written**, with `$max` so a
 *   second boot cannot pull it back down. Without it the next confirmation
 *   would ask for 1, meet the unique index, retry, meet it again and be
 *   refused — which is the one failure a trip number must never have.
 * - **The Accounts copy is rewritten.** An entry keeps `trip.tripNumber` as a
 *   copy on purpose, so a *correction* to the trip never moves it; a
 *   renumbering is not a correction but a new identifier for the same trip, and
 *   a copy left behind would name a trip that does not exist.
 * - **The old per-vendor counters are dropped.** `delivery-trip:<vendorId>`
 *   counts a sequence nothing allocates from now, and a stale counter restored
 *   out of a dump is exactly the kind of thing somebody later reads as current.
 *
 * The Trip DO sheet needs nothing here: `tripNumbers` is part of each row's
 * digest, so `backfillTripDoLedger` rewrites those copies on this same boot. A
 * **finalized** bill line keeps the old number, which is correct — a finalized
 * bill is never rewritten, and its own drift check is what reports it.
 *
 * Through the driver rather than the model, because these documents hold a path
 * the schema no longer has. **Before `syncDeliveryIndexes`**, or the unique
 * index on `tripSerial` would be asked to build across a collection where every
 * value is still missing. It never throws: an API that will not start is worse
 * than a number one boot late.
 */
export async function renumberTripsGlobally(): Promise<void> {
  try {
    const legacy = await DeliveryModel.collection.countDocuments({
      tripNumber: { $not: /^TRIP-\d+$/ },
    })

    if (legacy === 0) {
      return
    }

    // Before anything is written: the second pass unsets the field this one
    // indexes, and a unique index over two nulls is what refuses it.
    const indexes = await DeliveryModel.collection.indexes()

    if (indexes.some((index) => index.name === LEGACY_SERIAL_INDEX)) {
      await DeliveryModel.collection.dropIndex(LEGACY_SERIAL_INDEX)
      console.warn(`[delivery] dropped ${LEGACY_SERIAL_INDEX}, the per-vendor trip serial's index`)
    }

    const trips = await DeliveryModel.collection
      .find<{ _id: Types.ObjectId }>(
        {},
        { projection: { _id: 1 }, sort: { createdAt: 1, _id: 1 } },
      )
      .toArray()

    // Parked first, so no trip holds a serial another is about to be given.
    await DeliveryModel.collection.bulkWrite(
      trips.map((trip) => ({
        updateOne: {
          filter: { _id: trip._id },
          update: { $set: { tripNumber: `TMP-${String(trip._id)}` } },
        },
      })),
    )

    await DeliveryModel.collection.bulkWrite(
      trips.map((trip, index) => ({
        updateOne: {
          filter: { _id: trip._id },
          update: {
            $set: { tripNumber: formatTripNumber(index + 1), tripSerial: index + 1 },
            $unset: { vendorTripSerial: '' },
          },
        },
      })),
    )

    // So the next confirmation asks for one past the highest written.
    await CounterModel.updateOne(
      { _id: TRIP_COUNTER_KEY },
      { $max: { value: trips.length } },
      { upsert: true },
    )

    await Promise.all(
      trips.map((trip, index) =>
        EntryModel.collection.updateMany(
          { tripId: trip._id },
          { $set: { 'trip.tripNumber': formatTripNumber(index + 1) } },
        ),
      ),
    )

    await CounterModel.deleteMany({ _id: { $regex: `^${TRIP_COUNTER_KEY}:` } })

    console.warn(
      `[delivery] renumbered ${trips.length} trip(s) onto one global serial: ` +
        `TRIP-0001 to ${formatTripNumber(trips.length)}, in the order they were confirmed. ` +
        'A trip number no longer carries a vendor code.',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] trip renumbering skipped: ${message}`)
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
