import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { recordActivity } from '../vendor/vendor.activity'
import { assertCanChangeTrip } from './delivery.access'
import { serialize } from './delivery.completion'
import { DeliveryModel } from './delivery.model'
import type { TripRecord } from './delivery.serializer'
import type { TripBillInput } from './delivery.validation'

function taka(amount: number | null): string {
  return amount === null ? 'not entered' : `৳${amount.toLocaleString('en-IN')}`
}

/**
 * What a trip cost: the lorry's rent and the labour bill.
 *
 * Allowed whatever the trip's status. A trip stops being editable once every
 * receiver has signed — its challans and its lorry are then history — but the
 * bill for that run is usually the last thing to arrive, and refusing it on a
 * completed trip would leave every finished trip unbilled. So the rule here is
 * *who* (the author, or Admin and Manager), never *when*.
 */
export async function recordTripBill(
  tripId: string,
  input: TripBillInput,
  actor: UserDocument,
): Promise<TripRecord> {
  const trip = await DeliveryModel.findById(tripId)
  if (!trip) {
    throw new AppError(404, 'Trip not found.')
  }
  assertCanChangeTrip(trip, actor)

  trip.set('tripRent', input.tripRent)
  trip.set('labourBill', input.labourBill)
  trip.set('billUpdatedAt', new Date())
  trip.set('billUpdatedBy', actor._id)
  trip.updatedBy = actor._id
  await trip.save()

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.updated',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary: `${trip.tripNumber} bill: rent ${taka(input.tripRent)}, labour ${taka(input.labourBill)}`,
    actor,
  })

  return serialize(trip)
}
