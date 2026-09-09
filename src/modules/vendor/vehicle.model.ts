import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import {
  DEFAULT_VEHICLE_STATUS,
  VEHICLE_OWNERSHIP_TYPES,
  VEHICLE_STATUSES,
} from './vendor.constants'

/**
 * One vehicle in a vendor's fleet.
 *
 * Every vehicle belongs to exactly one vendor, and `vendorId` is what makes
 * that enforceable rather than conventional: a Vendor user's whole scope is
 * this one indexed field, and an assignment is refused unless the vehicle and
 * the driver carry the same value.
 *
 * There is deliberately **no `currentDriverId`**. Who is driving this vehicle
 * is a question the assignment collection answers, and duplicating the answer
 * here would give it two sources that quietly come to disagree — which is
 * exactly what destroys assignment history. The list resolves the active
 * driver for a page of vehicles in one indexed lookup instead.
 */
const vehicleSchema = new Schema(
  {
    /** Human-facing identifier, VH-0001. Allocated from the shared counter. */
    vehicleCode: { type: String, required: true, unique: true, index: true },

    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },

    /** Exactly as it is painted on the plate, spacing and all. */
    registrationNo: { type: String, required: true, trim: true, maxlength: 60 },
    /**
     * Normalised comparison key for the registration number — case and
     * punctuation removed.
     *
     * Unique across the whole collection, unlike the deliberately
     * unconstrained keys in Gate Pass. The reason is that this one is a
     * confirmed business invariant rather than an assumption: a registration
     * plate identifies one physical vehicle, and the same plate under two
     * vendors is either a data-entry mistake or a transfer that has not been
     * carried out properly. A transfer is a controlled operation — retire the
     * old record, create the new one — and the service reports the conflict by
     * naming the vendor that currently holds the plate rather than failing
     * with an index error.
     *
     * It is also the join key back to Gate Pass: `vehicleNoKey` there is
     * produced by the identical normalisation.
     */
    registrationNoKey: { type: String, required: true, unique: true, index: true },

    /** Optional: plenty of fleets record a plate and nothing else. */
    brand: { type: String, default: '', trim: true, maxlength: 80 },
    /**
     * The stored path is `vehicleModel`, not `model`: `model` collides with
     * Mongoose's own `Document.model()` and produces an unreadable type error.
     * The API and the UI still call the field `model` — see the serializer.
     * The same arrangement Gate Pass and Challan already use for a product.
     */
    vehicleModel: { type: String, default: '', trim: true, maxlength: 80 },

    ownershipType: {
      type: String,
      enum: VEHICLE_OWNERSHIP_TYPES,
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: VEHICLE_STATUSES,
      default: DEFAULT_VEHICLE_STATUS,
      index: true,
    },
    statusNote: { type: String, default: null, trim: true, maxlength: 400 },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * The vehicles tab filters by status inside one vendor and sorts by
 * registration, which is the query every page of this module runs. The vendor
 * comes first because it is the most selective field by a wide margin.
 */
vehicleSchema.index({ vendorId: 1, status: 1, registrationNo: 1 })
vehicleSchema.index({ vendorId: 1, createdAt: -1 })

export type Vehicle = InferSchemaType<typeof vehicleSchema>

export const VehicleModel = model('Vehicle', vehicleSchema)

export type VehicleDocument = InstanceType<typeof VehicleModel>
