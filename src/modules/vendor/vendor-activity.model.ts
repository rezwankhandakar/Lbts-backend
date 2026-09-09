import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { ACTIVITY_ACTIONS } from './vendor.constants'

/**
 * What happened to a vendor, and who did it.
 *
 * CLAUDE.md records that this system has no audit module — the user document
 * keeps provenance (who last changed a role) rather than a log. This is
 * deliberately the minimum integration that gives the Vendor module the
 * Activity tab it needs without inventing a general audit system: one
 * append-only collection, scoped to a vendor, written only by this module's
 * services and read only by this module's activity endpoint.
 *
 * Two properties make it safe to have. It is never read by anything that makes
 * a decision — nothing branches on an activity row — so a missing entry costs
 * a gap in a list and nothing else. And `recordActivity` never throws: a
 * failure to log must not fail the write it was logging, because the write is
 * the thing that mattered.
 *
 * `entityLabel` is a copy rather than a reference on purpose. A row has to
 * still read as a sentence after the vehicle it names has been deleted, and
 * "Vehicle removed" with a dangling id is not a sentence.
 */
const vendorActivitySchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },

    action: { type: String, enum: ACTIVITY_ACTIONS, required: true },
    /** What the row is about, so the UI can put the right icon beside it. */
    entityType: {
      type: String,
      enum: ['Vendor', 'Vehicle', 'Driver', 'Assignment', 'Document'],
      required: true,
    },
    /** Null once the thing it named has been removed — the label survives. */
    entityId: { type: Schema.Types.ObjectId, default: null },
    entityLabel: { type: String, default: '', trim: true, maxlength: 160 },

    /** One sentence, written by the service that did the thing. */
    summary: { type: String, required: true, trim: true, maxlength: 300 },

    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
)

/** The only query this collection ever serves: one vendor, newest first. */
vendorActivitySchema.index({ vendorId: 1, createdAt: -1 })

export type VendorActivity = InferSchemaType<typeof vendorActivitySchema>

export const VendorActivityModel = model('VendorActivity', vendorActivitySchema)

export type VendorActivityDocument = InstanceType<typeof VendorActivityModel>
