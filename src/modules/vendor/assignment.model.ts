import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { ASSIGNMENT_STATUSES } from './vendor.constants'

/**
 * One period during which a driver was the vehicle's driver.
 *
 * This is a relationship entity rather than a field, and that is the central
 * decision of the module. A `currentDriverId` on the vehicle would answer
 * "who is driving it" and destroy "who was driving it on the eleventh", which
 * is the question a damaged-goods claim is actually settled by. So the vehicle
 * carries no driver, the driver carries no vehicle, and every change of hands
 * appends a row here that is never rewritten.
 *
 *   Rahim  01 Aug - 15 Aug   Ended
 *   Karim  16 Aug - 31 Aug   Ended
 *   Rahim  01 Sep - open     Active
 */
const assignmentSchema = new Schema(
  {
    /**
     * The vendor both sides belong to.
     *
     * Denormalised from the vehicle deliberately, and it is not a second source
     * of truth: the service refuses to create a row whose vehicle and driver do
     * not already agree on this value, so it is a copy of something that has
     * been proved rather than a claim. What it buys is that a Vendor user's
     * scope on the assignments tab is one indexed field rather than a lookup
     * through two collections on every page.
     */
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },

    /**
     * Calendar days, stored at UTC midnight. `assignedUntil` is null while the
     * assignment is open-ended, which is the ordinary case: a driver is put on
     * a vehicle and stays there until somebody else is.
     */
    assignedFrom: { type: Date, required: true },
    assignedUntil: { type: Date, default: null },

    status: {
      type: String,
      enum: ASSIGNMENT_STATUSES,
      default: 'Active',
      index: true,
    },
    /** Why it was closed, when somebody said. */
    note: { type: String, default: null, trim: true, maxlength: 400 },

    endedAt: { type: Date, default: null },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * **One active driver per vehicle, enforced by the database.**
 *
 * A partial unique index on the active rows only: an unlimited number of
 * `Ended` assignments may name the same vehicle — that is the history — and
 * exactly one `Active` row may. The service closes the previous assignment and
 * opens the new one inside a transaction, so the check and the write cannot be
 * raced apart; this index is the floor under that, and it is what makes the
 * rule true even if a future caller forgets to ask.
 *
 * `partialFilterExpression` takes an equality here, which is the form MongoDB
 * has always supported — deliberately not `{ $in: [...] }`, which would tie
 * the index to a server version for no gain.
 */
assignmentSchema.index(
  { vehicleId: 1 },
  { unique: true, partialFilterExpression: { status: 'Active' } },
)

/**
 * The assignments tab, and the history panel on a vehicle: newest first inside
 * one vendor, and newest first for one vehicle.
 */
assignmentSchema.index({ vendorId: 1, status: 1, assignedFrom: -1 })
assignmentSchema.index({ vehicleId: 1, assignedFrom: -1 })
assignmentSchema.index({ driverId: 1, assignedFrom: -1 })

export type Assignment = InferSchemaType<typeof assignmentSchema>

export const AssignmentModel = model('VehicleDriverAssignment', assignmentSchema)

export type AssignmentDocument = InstanceType<typeof AssignmentModel>
