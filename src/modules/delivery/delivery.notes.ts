import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { recordActivity } from '../vendor/vendor.activity'
import { assertCanChangeTrip } from './delivery.access'
import { serialize } from './delivery.completion'
import { MAX_TRIP_NOTES } from './delivery.constants'
import { DeliveryModel } from './delivery.model'
import type { TripRecord } from './delivery.serializer'
import type { TripNoteInput } from './delivery.validation'

/**
 * The trip's note log: what people had to say about a run.
 *
 * A trip is worked by several hands over several days — loaded at the gate in
 * the morning, part of it back at the depot by the afternoon, the vendor's
 * bill arriving the week after — and the single `note` the cart carries is a
 * property of the *confirmation*, written before any of that happened. So
 * this is a log rather than a field: each note is appended with its author and
 * its moment, and it is **never rewritten**. A note somebody could edit would
 * be a log nobody could rely on, which is the same reason the activity journal
 * has no write endpoint at all.
 *
 * Two rules it shares with the trip's bill, and both are deliberate:
 *
 * - **Who, never when.** Notes are allowed whatever the trip's status. A trip
 *   stops being *editable* once every receiver has signed, but a note about
 *   what happened on it is most often written afterwards — that is when the
 *   vendor rings about the labour bill, and when somebody asks why a delivery
 *   came back. A log that closed with the trip would be empty exactly when it
 *   was wanted.
 * - **`assertCanChangeTrip` answers it.** The module's per-trip ownership
 *   scope came off with every other module's, so that question is now the role
 *   alone: any delivery writer adds a note, and any delivery writer removes
 *   one — which includes, as the narrower case, the author removing their own.
 *
 * Adding a note deliberately does **not** move `updatedBy` on the trip. Nobody
 * corrected the trip; somebody wrote something down about it, and saying the
 * record changed would be a claim about the goods. The note carries its own
 * author, which is the honest place for that. The same call the Accounts
 * module makes when a voucher is attached to an entry.
 */
export async function addTripNote(
  tripId: string,
  input: TripNoteInput,
  actor: UserDocument,
): Promise<TripRecord> {
  const trip = await DeliveryModel.findById(tripId)
  if (!trip) {
    throw new AppError(404, 'Trip not found.')
  }
  assertCanChangeTrip(trip, actor)

  /**
   * Refused at the ceiling rather than quietly dropping the oldest. The notes
   * travel with the trip on every read of it, so the bound is real — but a log
   * that silently forgets its own beginning is worse than one that says it is
   * full and asks for a note to be removed.
   */
  if (trip.notes.length >= MAX_TRIP_NOTES) {
    throw new AppError(
      409,
      `This trip already carries ${MAX_TRIP_NOTES} notes. Remove one before adding another.`,
    )
  }

  trip.notes.push({ text: input.text, createdBy: actor._id, createdAt: new Date() })
  await trip.save()

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.updated',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary: `${trip.tripNumber} note added: ${input.text}`,
    actor,
  })

  return serialize(trip)
}

/**
 * Taking a note back off the trip.
 *
 * A removal rather than an edit, for the reason above — correcting a note is
 * removing it and writing the one that was meant. It is journalled with the
 * text it removed, because that sentence exists nowhere else afterwards and a
 * log whose deletions leave no trace is one somebody can write themselves out
 * of.
 */
export async function removeTripNote(
  tripId: string,
  noteId: string,
  actor: UserDocument,
): Promise<TripRecord> {
  const trip = await DeliveryModel.findById(tripId)
  if (!trip) {
    throw new AppError(404, 'Trip not found.')
  }
  assertCanChangeTrip(trip, actor)

  const note = trip.notes.find((entry) => String(entry._id) === String(noteId))
  if (!note) {
    throw new AppError(404, 'That note is not on this trip.')
  }

  const removed = note.text
  trip.notes.pull({ _id: note._id })
  await trip.save()

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.updated',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary: `${trip.tripNumber} note removed: ${removed}`,
    actor,
  })

  return serialize(trip)
}
