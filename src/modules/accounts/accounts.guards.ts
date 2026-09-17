import type { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { EntryModel } from './accounts.model'

/**
 * Called by the Delivery module before a trip is deleted.
 *
 * An advance paid against a trip is money that left the office on that trip's
 * account; deleting the trip would leave the advance pointing at nothing and
 * the vendor's month unable to say what it was for. So the trip stays until
 * the advance is removed in Accounts. Imports nothing but its own model, so
 * Delivery depends on this file and not on the rest of Accounts.
 */
export async function assertTripHasNoAdvances(tripId: Types.ObjectId, tripNumber: string): Promise<void> {
  const advances = await EntryModel.countDocuments({ kind: 'TripAdvance', tripId })
  if (advances > 0) {
    throw new AppError(
      409,
      `${tripNumber} has ${advances === 1 ? 'an advance' : `${advances} advances`} recorded against it in Accounts. ` +
        'Delete the advance there before deleting the trip.',
    )
  }
}
