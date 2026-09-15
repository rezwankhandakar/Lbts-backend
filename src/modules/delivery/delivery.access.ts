import { AppError } from '../../utils/app-error'
import type { UserRole } from '../user/user.constants'
import type { UserDocument } from '../user/user.model'
import { canManageVendors } from '../vendor/vendor.constants'
import { canManageAnyTrip } from './delivery.constants'

/**
 * Who may act on which trip.
 *
 * The route stack has already proved the caller may reach this module at all.
 * What is left is the part a role cannot express, and it is the same rule
 * Challan and Gate Pass keep: an operator changes their own work, and Admin and
 * Manager change anybody's. There is no visibility rule — a trip exists only
 * once it is confirmed, so there is no private draft to hide.
 *
 * Every check takes the authenticated MongoDB profile. Nothing accepts a user
 * id from a request.
 */

function roleOf(actor: UserDocument): UserRole {
  return actor.role as UserRole
}

export function assertCanChangeTrip(trip: { createdBy: unknown }, actor: UserDocument): void {
  if (!canManageAnyTrip(roleOf(actor)) && String(trip.createdBy) !== String(actor._id)) {
    throw new AppError(403, 'You can only change trips you created.')
  }
}

/**
 * Setting the photo of a driver somebody added from a trip.
 *
 * Wider than the fleet master, which is Admin and Manager, and narrower than
 * "any delivery writer": the operator who added this driver may give them a
 * face, and nobody else's driver is theirs to change.
 */
export function assertCanPhotographDriver(
  driver: { createdBy: unknown },
  actor: UserDocument,
): void {
  if (!canManageVendors(roleOf(actor)) && String(driver.createdBy) !== String(actor._id)) {
    throw new AppError(403, 'You can only set the photo of a driver you added.')
  }
}
