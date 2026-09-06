import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { LOCATION_TYPES } from './location.constants'
import { normalizeLocationName } from './location.normalize'

/**
 * One district / thana pair, and what kind of place it is.
 *
 * This is the authority. Nothing else in the system may decide that Mirpur
 * Model is ISD or that Savar is OSD-Thana — not a form, not a constant, and
 * certainly not a language model. A challan's location is a pointer into this
 * collection or it is blank, and those are the only two states.
 *
 * That is what makes the classification correctable: a pair filed under the
 * wrong type is fixed here once, and every future challan is classified
 * correctly. It is also why the collection is Admin-only to write and why a
 * referenced row is deactivated rather than deleted — a row removed out from
 * under a year of challans would leave them pointing at nothing.
 *
 * The district and thana are stored twice: as somebody typed them, and in the
 * normalised form the resolver matches on. The displayed value is always the
 * typed one, and the normalised one is a lookup key nothing renders.
 */
const locationSchema = new Schema(
  {
    /** As entered, and as displayed. `Cox's Bazar` keeps its apostrophe. */
    district: { type: String, required: true, trim: true, maxlength: 120 },
    thana: { type: String, required: true, trim: true, maxlength: 120 },

    /**
     * The comparison forms. Written by the service through
     * `normalizeLocationName`, never by a client, and never shown anywhere:
     * they exist so that "Mirpur Thana" and "mirpur" find the same row.
     */
    normalizedDistrict: { type: String, required: true, index: true },
    normalizedThana: { type: String, required: true, index: true },

    locationType: { type: String, required: true, enum: LOCATION_TYPES },

    /**
     * Whether this pair may still be chosen.
     *
     * Deactivating rather than deleting is the whole answer to "what happens
     * to the challans that reference it". An inactive row disappears from
     * every selector and from every resolution, and the historical records
     * that point at it keep resolving to a real district, thana and type. A
     * hard delete is offered only for a row nothing references.
     */
    isActive: { type: Boolean, default: true, index: true },

    /**
     * Where the row came from. Seeded rows are the master list the business
     * supplied; anything else was added by an Admin. Kept because it is the
     * difference between "this is wrong in our data entry" and "this is wrong
     * in the reference list", which are fixed in different places.
     */
    isSeeded: { type: Boolean, default: false },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/**
 * One row per district/thana pair, enforced on the normalised values rather
 * than the typed ones — otherwise "Mirpur" and "mirpur " would be two rows
 * that every lookup would have to choose between, which is exactly the
 * ambiguity the resolver refuses to guess at.
 *
 * The service checks for a duplicate first and answers with a readable
 * message; this index is the floor under that check when two Admins add the
 * same pair at the same instant.
 */
locationSchema.index({ normalizedDistrict: 1, normalizedThana: 1 }, { unique: true })
/** The cascading selector: every active thana in one district, in order. */
locationSchema.index({ isActive: 1, district: 1, thana: 1 })
/** The resolver's first question, asked on every unresolved challan. */
locationSchema.index({ isActive: 1, normalizedThana: 1 })

export type LocationMaster = InferSchemaType<typeof locationSchema>

export const LocationMasterModel = model('LocationMaster', locationSchema)

/**
 * Derived from the model rather than written by hand: Mongoose 9 folds schema
 * options into the hydrated type, so a hand-written HydratedDocument does not
 * structurally match what queries return. The same arrangement the other
 * modules use.
 */
export type LocationMasterDocument = InstanceType<typeof LocationMasterModel>

/** The normalised pair for a district and thana, as the schema stores them. */
export function normalizedPair(district: string, thana: string): {
  normalizedDistrict: string
  normalizedThana: string
} {
  return {
    normalizedDistrict: normalizeLocationName(district),
    normalizedThana: normalizeLocationName(thana),
  }
}
