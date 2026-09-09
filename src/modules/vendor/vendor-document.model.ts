import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { DOCUMENT_MIME_TYPES, DOCUMENT_OWNER_TYPES, DOCUMENT_TYPES } from './vendor.constants'

/**
 * The file behind a compliance document. MongoDB holds the reference and never
 * the bytes — the object lives in Cloudflare R2, exactly as a gate pass scan
 * does.
 *
 * There is deliberately no public URL here. A registration certificate carries
 * an owner's name and address and a driving licence carries a licence number,
 * so unlike a vendor photo these are never served from the public bucket: the
 * only read path is `GET /vendor-documents/:id/file`, which re-checks
 * authentication, role and vendor scope before streaming the object.
 */
const attachmentSchema = new Schema(
  {
    key: { type: String, required: true },
    mimeType: { type: String, required: true, enum: DOCUMENT_MIME_TYPES },
    size: { type: Number, required: true, min: 1 },
    /** What the file was called on the way in. Shown, never used as a key. */
    originalName: { type: String, required: true, trim: true, maxlength: 200 },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
)

/**
 * One compliance document, for a vehicle or for a driver.
 *
 * Both live in one collection rather than two, because everything anybody does
 * with them is the same: a vendor's documents tab lists them together, the
 * compliance counts sum them together, and the expiry arithmetic is identical.
 * Two collections would mean two of every query and a union in front of each.
 * `ownerType` says which kind, and the service refuses a document type that
 * does not belong to it — an NID on a lorry is not a data model this system
 * needs to represent.
 *
 * **Status is not stored.** Whether a document is valid, expiring or expired is
 * derived from `expiryDate` by `documentStatusFor`, because a stored status is
 * wrong the morning after it was written and nothing would be there to notice.
 * That is what makes `expiryDate` the indexed field rather than a status.
 */
const vendorDocumentSchema = new Schema(
  {
    /**
     * Denormalised from the owner, and proved rather than claimed: the service
     * reads it off the vehicle or driver being documented. It is what scopes a
     * Vendor user's documents tab to one indexed clause.
     */
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },

    ownerType: { type: String, enum: DOCUMENT_OWNER_TYPES, required: true, index: true },
    /**
     * The vehicle or the driver. Deliberately not a Mongoose `refPath`: the two
     * are never populated together and a discriminated reference would invite
     * exactly the kind of polymorphic query that is slow on M0.
     */
    ownerId: { type: Schema.Types.ObjectId, required: true, index: true },

    documentType: { type: String, enum: DOCUMENT_TYPES, required: true, index: true },
    documentNumber: { type: String, default: '', trim: true, maxlength: 80 },

    /** Calendar days at UTC midnight, like every other date in this module. */
    issueDate: { type: Date, default: null },
    /**
     * Null means the document does not lapse — an NID does not. Indexed
     * because the compliance panel asks "what expires in the next thirty days"
     * on every vendor page, which is a range query.
     */
    expiryDate: { type: Date, default: null, index: true },

    attachment: { type: attachmentSchema, default: null },
    note: { type: String, default: null, trim: true, maxlength: 400 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * One document of each type per vehicle or driver.
 *
 * A vehicle has one fitness certificate at a time — the renewed one replaces
 * the old, it does not sit beside it — and two rows for the same type would
 * make "is this vehicle's fitness valid" a question with two answers. Renewing
 * is an edit that moves the expiry date forward and replaces the attachment,
 * which is also what keeps the alert count honest.
 */
vendorDocumentSchema.index({ ownerType: 1, ownerId: 1, documentType: 1 }, { unique: true })

/** The documents tab: one vendor, soonest expiry first. */
vendorDocumentSchema.index({ vendorId: 1, expiryDate: 1 })
vendorDocumentSchema.index({ vendorId: 1, ownerType: 1, expiryDate: 1 })

export type VendorDocumentRow = InferSchemaType<typeof vendorDocumentSchema>

export const VendorDocumentModel = model('VendorDocument', vendorDocumentSchema)

export type VendorDocumentDocument = InstanceType<typeof VendorDocumentModel>
