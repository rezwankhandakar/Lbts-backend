import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { DEFAULT_VENDOR_STATUS, VENDOR_STATUSES } from './vendor.constants'

/**
 * A transport vendor: the company that supplies the vehicles and the drivers.
 *
 * Everything else in this module hangs off one of these. A vehicle belongs to
 * exactly one vendor, a driver belongs to exactly one vendor, and an
 * assignment belongs to the vendor both of its sides belong to — which is what
 * `vendorId` on all three is for, and what makes a Vendor user's scope a
 * single indexed clause rather than a traversal.
 */
const vendorSchema = new Schema(
  {
    /**
     * Human-facing identifier, V-0001. Allocated from the shared atomic
     * counter at creation, so it is stable for the life of the record and safe
     * to quote on a purchase order.
     *
     * Not year-scoped, unlike a gate pass or a challan number: a vendor is a
     * relationship rather than an event, and V-0007 means the seventh vendor
     * we ever worked with rather than the seventh this year.
     */
    vendorCode: { type: String, required: true, unique: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 160 },
    /**
     * Normalised comparison key for the name. Duplicate detection reads this;
     * nothing displays it. A client cannot set it — it is derived by the
     * service, exactly as `customerNameKey` is on a challan, because a client
     * that could set a comparison key could make a record match something it
     * does not say.
     */
    nameKey: { type: String, required: true, unique: true, index: true },

    mobile: { type: String, required: true, trim: true, maxlength: 32 },
    /** The eleven-digit form, so the same number typed three ways still matches. */
    mobileKey: { type: String, required: true, index: true },

    address: { type: String, default: '', trim: true, maxlength: 400 },

    /**
     * The vendor's photo or mark, stored in Cloudflare R2 exactly as a profile
     * avatar is — normalised to a 512px square WEBP on the way in, and served
     * from the public bucket.
     *
     * Public is deliberate and is the one place this module differs from its
     * own documents. A vendor photo is a company mark with no personal data on
     * it, it is rendered in a list of twenty rows at a time, and routing every
     * one of those through an authenticated stream would cost twenty requests
     * to a sleeping instance for a picture. Compliance documents — which carry
     * licence numbers and addresses — are private and streamed, and that split
     * is the same one the rest of the codebase already makes between an avatar
     * and a gate pass scan.
     */
    photoUrl: { type: String, default: null },
    photoKey: { type: String, default: null },

    status: {
      type: String,
      enum: VENDOR_STATUSES,
      default: DEFAULT_VENDOR_STATUS,
      index: true,
    },
    /** Why it was suspended or deactivated. Cleared when the vendor is reactivated. */
    statusNote: { type: String, default: null, trim: true, maxlength: 400 },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Always the authenticated MongoDB profile, never an id from a request
     * body — the same rule every other module in this codebase follows.
     */
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * The vendor list filters by status and sorts by name, which is what a
 * directory is read as — somebody looking for Malek Transport is looking under
 * M, not at whichever end of a creation date it landed. M0 has little CPU to
 * spend on collection scans, so the exact query shape gets its own index.
 */
vendorSchema.index({ status: 1, name: 1 })
vendorSchema.index({ name: 1 })
vendorSchema.index({ createdAt: -1 })

export type Vendor = InferSchemaType<typeof vendorSchema>

export const VendorModel = model('Vendor', vendorSchema)

/**
 * Derived from the model rather than written by hand: Mongoose 9 folds schema
 * options into the hydrated type, so a hand-written HydratedDocument<Vendor>
 * does not structurally match what queries return.
 */
export type VendorDocument = InstanceType<typeof VendorModel>
