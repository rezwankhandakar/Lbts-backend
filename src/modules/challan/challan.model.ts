import { Schema, model } from "mongoose";
import type { InferSchemaType } from "mongoose";
import {
  LOCATION_SOURCES,
  LOCATION_STATUSES,
  LOCATION_TYPES,
  PENDING_LOCATION_STATUS,
} from "../location/location.constants";
import {
  CHALLAN_STATUSES,
  INITIAL_CHALLAN_STATUS,
  MAX_CHALLAN_ITEMS,
  MAX_CHALLAN_PAGES,
} from "./challan.constants";

/**
 * One submitted challan.
 *
 * A record here exists only because an operator pressed Submit on one challan
 * inside a WhatsApp PDF. Opening that PDF creates nothing; selecting a page
 * range creates nothing; nine filled-in fields create nothing. That is the
 * module's central rule and this collection is where it is visible — there is
 * no draft state to hold a half-finished entry, because a half-finished entry
 * is not a business record and does not belong in the database.
 *
 * MongoDB holds the reference to the generated document and never the bytes.
 * Unlike a profile photo it is never public: a challan carries a customer's
 * home address and phone number, so the only read path is
 * GET /challans/:id/document, which re-checks authentication and role.
 */
const documentSchema = new Schema(
  {
    key: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    /**
     * Front pages plus the one generated back page. Stored rather than derived
     * so a list can say "4 pages" without opening the object, and so a
     * regeneration can assert the shape it expects to find.
     */
    pageCount: { type: Number, required: true, min: 2 },
    generatedAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * One product line on a challan.
 *
 * The stored path is `productModel`, not `model`: `model` collides with
 * Mongoose's own `Document.model()` and produces an unreadable type error. The
 * API and the UI still call the field `model` — see the serializer. The same
 * arrangement, and the same reason, as the Gate Pass item schema.
 */
const challanItemSchema = new Schema(
  {
    productName: { type: String, required: true, trim: true, maxlength: 200 },
    productModel: { type: String, required: true, trim: true, maxlength: 120 },
    /**
     * Normalised comparison key for the model — case and punctuation removed.
     * Duplicate detection reads this; nothing displays it.
     */
    productModelKey: { type: String, required: true },
    qty: { type: Number, required: true, min: 1, max: 100000 },
  },
  { _id: false },
);

/**
 * Where this challan actually went, decided against the Location Master.
 *
 * A pointer plus a copy. `masterId` is the reference — correcting a
 * misclassified pair in the master collection corrects every challan holding
 * one — and the three values beside it are what that row said at the time,
 * kept so a list can be rendered and exported without joining six hundred rows
 * to every page.
 *
 * `source` and `confidence` record how it was decided, which is the difference
 * between a location somebody chose and one a string comparison worked out.
 * `admin_manual` is the top of that order and nothing re-resolves over it.
 *
 * Null is a first-class value here and means exactly what it says: nobody has
 * determined this yet. It never blocks anything.
 */
const resolvedLocationSchema = new Schema(
  {
    masterId: {
      type: Schema.Types.ObjectId,
      ref: "LocationMaster",
      required: true,
    },
    district: { type: String, required: true, trim: true, maxlength: 120 },
    thana: { type: String, required: true, trim: true, maxlength: 120 },
    locationType: {
      type: String,
      required: true,
      enum: LOCATION_TYPES,
    },
    source: { type: String, required: true, enum: LOCATION_SOURCES },
    /** 1 for a person's choice; a probability for anything worked out. */
    confidence: { type: Number, required: true, min: 0, max: 1 },
    resolvedAt: { type: Date, required: true },
    /** Set when somebody chose it. Null for anything the system decided. */
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false },
);

const challanSchema = new Schema(
  {
    /**
     * The running serial. Globally unique and allocated from an atomic
     * counter, so two operators submitting at the same instant cannot be given
     * the same one. Printed large on the back page.
     */
    slNumber: { type: Number, required: true, unique: true, index: true },
    /**
     * LBTS-CH-2026-000001. The human-facing identifier and the barcode
     * payload — one value, so what a scanner reads and what a person reads
     * off the page can never be two different things.
     */
    challanNumber: { type: String, required: true, unique: true, index: true },

    /** The source batch this challan was cut out of. */
    batchId: {
      type: Schema.Types.ObjectId,
      ref: "ChallanBatch",
      required: true,
      index: true,
    },

    // --- Where it came from in the source PDF ------------------------------
    /**
     * The WhatsApp file's name, and the pages of it this challan occupied.
     * The file itself is never stored — it is a temporary working source — so
     * these three fields are the whole of what remains about its provenance.
     */
    sourceFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 260,
    },
    sourcePageStart: { type: Number, required: true, min: 1 },
    sourcePageEnd: { type: Number, required: true, min: 1 },

    // --- Customer and delivery --------------------------------------------
    /** Stored as Unicode. Legacy Bijoy text is converted before it gets here. */
    customerName: { type: String, required: true, trim: true, maxlength: 200 },
    customerNameKey: { type: String, required: true, index: true },
    deliveryAddress: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    /**
     * The thana and district **exactly as they were transcribed**, and
     * optional.
     *
     * Optional because a Walton challan does not always carry them: some print
     * only a delivery address, some print a thana and no district, and some
     * print a spelling no list contains. A required field would mean an
     * operator inventing one to get past a form, which is a worse record than
     * a blank.
     *
     * Never rewritten by resolution. What the paper said is a fact about the
     * paper, and the back page prints it; where the system decided that is,
     * once it could tell, is `resolvedLocation` below. Keeping the two apart
     * is what makes a wrong classification traceable to the text that caused
     * it.
     */
    thana: { type: String, default: "", trim: true, maxlength: 120 },
    district: { type: String, default: "", trim: true, maxlength: 120 },
    /** Normalised to the eleven-digit local form where it is recognisable. */
    receiverMobile: { type: String, required: true, trim: true, maxlength: 40 },
    senderMobile: { type: String, default: null, trim: true, maxlength: 40 },
    /**
     * Deliberately one free-text field and not Gate Pass's discriminated
     * zone/PO pair: on a Walton challan this is printed as a single "Zone/PO"
     * cell, and splitting a value nobody separated on paper would mean
     * guessing which half is which.
     */
    zonePo: { type: String, default: null, trim: true, maxlength: 120 },

    // --- Where it actually went -------------------------------------------
    /** The Location Master row this delivery belongs to, or null. */
    resolvedLocation: { type: resolvedLocationSchema, default: null },
    /**
     * Whether the location is settled. Derived from `resolvedLocation` by the
     * service and stored anyway, because it is what the records list filters
     * on — deriving it in a query would mean an unindexed `$exists` scan on
     * every page, which on M0 is the difference between a list and an outage.
     */
    locationStatus: {
      type: String,
      enum: LOCATION_STATUSES,
      default: PENDING_LOCATION_STATUS,
      index: true,
    },

    // --- Goods -------------------------------------------------------------
    /**
     * One line per product on the challan. A Walton challan routinely lists
     * several, each with its own model and quantity, so this is an array even
     * when there is only one of them — the shape does not change with the
     * contents.
     *
     * Required and non-empty: a challan carrying nothing is not a challan.
     * `totalQty` is derived at serialisation rather than stored, so it cannot
     * drift from the rows it is a total of.
     */
    items: {
      type: [challanItemSchema],
      required: true,
      validate: {
        validator: (value: unknown[]) =>
          value.length >= 1 && value.length <= MAX_CHALLAN_ITEMS,
        message: `A challan needs between 1 and ${MAX_CHALLAN_ITEMS} product rows.`,
      },
    },

    // --- Lifecycle ---------------------------------------------------------
    status: {
      type: String,
      enum: CHALLAN_STATUSES,
      default: INITIAL_CHALLAN_STATUS,
      index: true,
    },

    // --- Generated document ------------------------------------------------
    document: { type: documentSchema, required: true },

    // --- Audit -------------------------------------------------------------
    /**
     * Always the authenticated MongoDB profile, never an id from a request
     * body. Ownership is what scopes an OpEx to their own records.
     */
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    submittedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    submittedAt: { type: Date, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** Set the first time a filed challan is corrected. Null until then. */
    amendedAt: { type: Date, default: null },

    // --- Printing ----------------------------------------------------------
    /**
     * When this challan was last sent to a printer from LBTS, and by whom.
     *
     * A challan exists to be printed and handed over with the goods, so the
     * question an operator working through a stack actually has is which
     * sheets have already come out. Nothing else on the record answers it:
     * `Submitted` says the challan was filed, not that anybody printed it.
     *
     * It records a *dispatch*, not a sheet of paper. The browser hands the
     * document to the print dialog and has no way to learn whether the
     * operator pressed Print or Cancel, or whether the printer had paper — so
     * this is a claim to be corrected rather than a measurement, which is why
     * it can be cleared again, exactly like a page marked blank.
     */
    printedAt: { type: Date, default: null },
    printedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

/**
 * A range has to run forwards and stay within one challan's worth of pages.
 * Enforced in the service against the batch as well; this is the floor under
 * it, so a document that somehow bypassed the service still cannot be saved.
 */
challanSchema.path("sourcePageEnd").validate(function validateRange(
  this: unknown,
  value: number,
) {
  const record = this as { sourcePageStart?: number };
  const start = record.sourcePageStart ?? 1;
  return value >= start && value - start + 1 <= MAX_CHALLAN_PAGES;
}, "The page range is not a valid challan page range.");

/** The list always sorts newest first, and usually filters by status too. */
challanSchema.index({ createdAt: -1 });
challanSchema.index({ status: 1, createdAt: -1 });
/**
 * Opening a batch: its challans in the order the source PDF had them — and
 * unique, because two challans in one batch cannot begin on the same page.
 *
 * The service checks for any overlap, which is the real rule; this index is
 * the floor under the most likely way that check could be raced, which is the
 * same sheet being filed twice from two tabs at the same instant. A partial
 * overlap can still slip past it in theory, which is why the check exists.
 */
challanSchema.index({ batchId: 1, sourcePageStart: 1 }, { unique: true });
/**
 * The batch page, which reads every challan of a source file to say how much
 * of it has been printed. Compound with `batchId` because that is the only
 * question ever asked of this field — nothing looks up "everything printed on
 * Tuesday" across the whole collection.
 */
challanSchema.index({ batchId: 1, printedAt: 1 });
/** "My challans", the default view for an operator working through a stack. */
challanSchema.index({ createdBy: 1, createdAt: -1 });
/** The list filters, and the type-ahead that reads distinct values off them. */
challanSchema.index({ district: 1 });
challanSchema.index({ thana: 1 });
/**
 * "Which challans still need a location?" — the question an Admin sitting down
 * to clear the backlog actually asks. Compound with `createdAt` because the
 * answer is always rendered newest first, so one index serves the filter and
 * the sort together.
 */
challanSchema.index({ locationStatus: 1, createdAt: -1 });
/**
 * The reverse lookup, used when a master row is about to be removed: does
 * anything still point at it? Sparse, because most of the interesting
 * challans in a young deployment have no resolved location at all and there is
 * nothing to be gained from indexing a null.
 */
challanSchema.index({ "resolvedLocation.masterId": 1 }, { sparse: true });
challanSchema.index({ customerName: 1 });
challanSchema.index({ "items.productName": 1 });
challanSchema.index({ "items.productModel": 1 });
/** The duplicate probe, which asks about one delivery inside one batch. */
challanSchema.index({
  batchId: 1,
  customerNameKey: 1,
  "items.productModelKey": 1,
});

export type Challan = InferSchemaType<typeof challanSchema>;

export const ChallanModel = model("Challan", challanSchema);

/**
 * Derived from the model rather than written by hand: Mongoose 9 folds schema
 * options into the hydrated type, so a hand-written HydratedDocument<Challan>
 * does not structurally match what queries return.
 */
export type ChallanDocument = InstanceType<typeof ChallanModel>;
