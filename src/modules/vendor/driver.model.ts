import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { DEFAULT_DRIVER_STATUS, DRIVER_STATUSES } from './vendor.constants'

/**
 * One driver working for a vendor.
 *
 * Belongs to exactly one vendor, for the same reason a vehicle does — and an
 * assignment is refused unless both sides carry the same `vendorId`.
 *
 * `licenseNumber` and `licenseExpiry` are a denormalised copy of the driver's
 * `Driving License` document, kept so a table of eighteen drivers can render a
 * licence column without eighteen joins. They are written in exactly one place
 * — `syncDriverLicence` in the service — so the copy and the document cannot
 * disagree, and compliance is counted from the documents alone rather than
 * from both.
 *
 * There is deliberately no `currentVehicleId`, for the reason the vehicle has
 * no `currentDriverId`: the assignment collection is the only thing that knows
 * who is on what, and a second answer to that question is how history gets
 * quietly rewritten.
 */
const driverSchema = new Schema(
  {
    /** Human-facing identifier, DR-0001. Allocated from the shared counter. */
    driverCode: { type: String, required: true, unique: true, index: true },

    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 160 },
    /** Normalised comparison key. Duplicate detection reads it; nothing shows it. */
    nameKey: { type: String, required: true, index: true },

    mobile: { type: String, required: true, trim: true, maxlength: 32 },
    mobileKey: { type: String, required: true, index: true },

    /**
     * National ID.
     *
     * Personal data, so it is deliberately absent from the list serializer and
     * appears only on the driver's own detail view — see
     * `toDriverRecord` versus `toDriverDetail`. Storing it is what lets a
     * vendor prove who was driving; putting it in a table of eighteen rows is
     * spreading it around for no reason.
     */
    nidNumber: { type: String, default: '', trim: true, maxlength: 40 },
    nidKey: { type: String, default: '', index: true },

    address: { type: String, default: '', trim: true, maxlength: 400 },

    licenseNumber: { type: String, default: '', trim: true, maxlength: 60 },
    /**
     * A calendar day, stored at UTC midnight — the same treatment a challan's
     * trip date gets, and for the same reason: a licence expires on a date, not
     * at an instant, and storing an instant makes it expire a day early for
     * some viewers.
     *
     * Indexed because "whose licence lapses this month" is a range query the
     * compliance panel runs on every vendor page.
     */
    licenseExpiry: { type: Date, default: null, index: true },

    /**
     * The driver's photo. Public bucket, normalised to a 512px square, exactly
     * like a vendor photo and a profile avatar — see the note on the vendor
     * model for why photos and compliance documents are stored differently.
     */
    photoUrl: { type: String, default: null },
    photoKey: { type: String, default: null },

    status: {
      type: String,
      enum: DRIVER_STATUSES,
      default: DEFAULT_DRIVER_STATUS,
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

/** The drivers tab: one vendor, filtered by status, sorted by name. */
driverSchema.index({ vendorId: 1, status: 1, name: 1 })
driverSchema.index({ vendorId: 1, createdAt: -1 })
/**
 * Two drivers with the same mobile number under one vendor is a duplicate
 * record rather than two people, and a dispatcher ringing the number would
 * never learn which of the two they had reached. Across vendors it is
 * legitimate — a driver may work for two firms — so the constraint is scoped
 * rather than global.
 */
driverSchema.index({ vendorId: 1, mobileKey: 1 }, { unique: true })
/** The licence backlog: whose papers lapse, soonest first, within one vendor. */
driverSchema.index({ vendorId: 1, licenseExpiry: 1 })

export type Driver = InferSchemaType<typeof driverSchema>

export const DriverModel = model('Driver', driverSchema)

export type DriverDocument = InstanceType<typeof DriverModel>
