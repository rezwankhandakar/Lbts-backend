import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import {
  DEFAULT_GATE_PASS_STATUS,
  GATE_PASS_DOCUMENT_MIME_TYPES,
  GATE_PASS_REFERENCE_TYPES,
  GATE_PASS_STATUSES,
  MAX_GATE_PASS_ITEMS,
} from './gate-pass.constants'

/**
 * The scanned gate pass itself. MongoDB holds the reference and never the
 * bytes - the object lives in Cloudflare R2, exactly as profile photos do.
 *
 * There is deliberately no public URL here. A gate pass carries customer
 * addresses and phone numbers, so unlike an avatar it is not something to hand
 * out on a public bucket: the only read path is GET /gate-passes/:id/document,
 * which re-checks authentication and role before streaming the object.
 */
const documentSchema = new Schema(
  {
    key: { type: String, required: true },
    mimeType: { type: String, required: true, enum: GATE_PASS_DOCUMENT_MIME_TYPES },
    size: { type: Number, required: true, min: 1 },
    /** What the file was called on the way in. Shown, never used as a key. */
    originalName: { type: String, required: true, trim: true, maxlength: 200 },
    uploadedAt: { type: Date, required: true },
    /**
     * Known only when the producer reported it - the scanner agent knows how
     * many sheets it fed. Null for anything else, and the UI shows a page
     * count only when there is a real one.
     */
    pageCount: { type: Number, default: null, min: 1 },
  },
  { _id: false },
)

/**
 * One product line on a gate pass.
 *
 * The stored path is `productModel`, not `model`: `model` collides with
 * Mongoose's own `Document.model()` and produces an unreadable type error.
 * The API and the UI still call the field `model` — see the serializer.
 */
const gatePassItemSchema = new Schema(
  {
    productName: { type: String, required: true, trim: true, maxlength: 160 },
    productModel: { type: String, required: true, trim: true, maxlength: 80 },
    /**
     * Normalised comparison key for the model — case and punctuation removed.
     * Duplicate detection reads this; nothing displays it.
     */
    productModelKey: { type: String, required: true },
    qty: { type: Number, required: true, min: 1, max: 100000 },
  },
  { _id: false },
)

const gatePassSchema = new Schema(
  {
    /**
     * Human-facing identifier, GP-YYYY-000123. Allocated from an atomic
     * counter at creation, so it is stable for the life of the record and safe
     * to print on paper.
     */
    gatePassId: { type: String, required: true, unique: true, index: true },

    // --- Trip -------------------------------------------------------------
    /** Delivery order number, exactly as printed on the challan. */
    tripDo: { type: String, required: true, trim: true, maxlength: 60 },
    /**
     * Normalised comparison key for tripDo - case and punctuation removed.
     * Duplicate detection reads this; nothing displays it. See comparisonKey.
     */
    tripDoKey: { type: String, required: true, index: true },
    tripDate: { type: Date, required: true },
    /** Customer service depot code, e.g. CSD-04. */
    csd: { type: String, required: true, trim: true, maxlength: 24, uppercase: true },
    /** Operating unit, e.g. WFR or WAC. */
    unit: { type: String, required: true, trim: true, maxlength: 24, uppercase: true },

    // --- Customer and vehicle --------------------------------------------
    customerName: { type: String, required: true, trim: true, maxlength: 160 },
    vehicleNo: { type: String, required: true, trim: true, maxlength: 60 },
    vehicleNoKey: { type: String, required: true, index: true },

    // --- Reference --------------------------------------------------------
    /**
     * Zone and PO are stored in their own fields rather than in one ambiguous
     * "Zone / PO" column, so a report can group by zone without parsing free
     * text. referenceType says which of the two - if either - this record
     * carries, and the service guarantees the other stays null.
     */
    referenceType: {
      type: String,
      enum: GATE_PASS_REFERENCE_TYPES,
      default: 'None',
      index: true,
    },
    zone: { type: String, default: null, trim: true, maxlength: 60 },
    po: { type: String, default: null, trim: true, maxlength: 60 },

    // --- Goods ------------------------------------------------------------
    /**
     * One line per product on the vehicle. A challan routinely carries several
     * — the indoor and outdoor halves of an air conditioner, or two models on
     * one trip — and each is its own row with its own quantity.
     *
     * Required and non-empty: a gate pass with nothing on it is not a gate
     * pass. The upper bound is a sanity limit, not a business rule.
     */
    items: {
      type: [gatePassItemSchema],
      required: true,
      validate: {
        validator: (value: unknown[]) => value.length >= 1 && value.length <= MAX_GATE_PASS_ITEMS,
        message: `A gate pass needs between 1 and ${MAX_GATE_PASS_ITEMS} product rows.`,
      },
    },

    // --- Lifecycle --------------------------------------------------------
    status: {
      type: String,
      enum: GATE_PASS_STATUSES,
      default: DEFAULT_GATE_PASS_STATUS,
      index: true,
    },
    /** Null until the record first leaves Draft. Not reset by a rejection. */
    submittedAt: { type: Date, default: null },
    /**
     * Provenance for the latest lifecycle move, mirroring the shape the user
     * document uses for role and status changes. It records only the most
     * recent change - that is metadata an audit module would backfill from,
     * not an audit log.
     */
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Why it was rejected or cancelled. Cleared when the record moves on. */
    statusNote: { type: String, default: null, trim: true, maxlength: 400 },

    // --- Document ---------------------------------------------------------
    document: { type: documentSchema, default: null },

    // --- Audit ------------------------------------------------------------
    /**
     * Always the authenticated MongoDB profile, never an id from a request
     * body. Ownership is what scopes an OpEx to their own records.
     */
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * The records page filters by status and always sorts newest first, so that
 * exact query shape gets its own compound index. M0 has little CPU to spend on
 * collection scans, and this is the query every operator runs all day.
 */
gatePassSchema.index({ status: 1, createdAt: -1 })
gatePassSchema.index({ createdAt: -1 })
/** Date-range filtering, and the duplicate probe's second key. */
gatePassSchema.index({ tripDate: -1 })
gatePassSchema.index({ tripDate: 1, vehicleNoKey: 1, 'items.productModelKey': 1 })
/** "My gate passes" - the default view for an OpEx working through a queue. */
gatePassSchema.index({ createdBy: 1, createdAt: -1 })
/**
 * Type-ahead. The suggestion endpoint groups these fields by value, and an
 * index is what keeps that off a collection scan as the record grows.
 */
gatePassSchema.index({ customerName: 1 })
gatePassSchema.index({ vehicleNo: 1 })
gatePassSchema.index({ 'items.productName': 1 })
gatePassSchema.index({ 'items.productModel': 1 })

export type GatePass = InferSchemaType<typeof gatePassSchema>

export const GatePassModel = model('GatePass', gatePassSchema)

/**
 * Derived from the model rather than written by hand: Mongoose 9 folds schema
 * options into the hydrated type, so a hand-written HydratedDocument<GatePass>
 * does not structurally match what queries return.
 */
export type GatePassDocument = InstanceType<typeof GatePassModel>
