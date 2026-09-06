import { Schema, model } from "mongoose";
import type { InferSchemaType } from "mongoose";
import { CHALLAN_BATCH_STATUSES, MAX_SOURCE_PAGES } from "./challan.constants";

/**
 * One WhatsApp PDF, and the challans cut out of it.
 *
 * The batch is created by the *first* submission out of a source file, never
 * by opening one. If an operator uploads a 24-page PDF, reads it, and closes
 * the tab, nothing here was written — which is the point: the source file is a
 * temporary working document and a row created merely because somebody looked
 * at one would be a permanent record of nothing.
 *
 * The PDF itself is never stored. What survives is its name, how many pages it
 * had, and which of those pages became which challan — enough to say whether
 * the file was fully processed, and to reassemble the processed output, but
 * not a copy of a file the business never asked us to archive.
 */
const challanBatchSchema = new Schema(
  {
    /**
     * The workspace session that produced this batch, generated in the browser
     * when the source PDF was opened.
     *
     * It exists so the *second* challan out of the same PDF joins the batch the
     * first one created, rather than starting another. Scoped to its owner and
     * unique with them, so one operator's key can never attach their challan to
     * somebody else's batch, and so two submissions racing to be first cannot
     * create two batches for one file — the unique index makes the loser of
     * that race find the winner's batch instead.
     */
    sessionKey: { type: String, required: true, maxlength: 64 },

    sourceFileName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 260,
    },
    /**
     * As reported by the browser that read the file. This API never sees the
     * source PDF, so this is a declaration rather than a measurement — what is
     * actually proved is narrower and stronger: every submission's uploaded
     * extract must carry exactly as many pages as its range claims, and no two
     * challans in a batch may claim the same page.
     */
    sourcePageCount: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SOURCE_PAGES,
    },
    /** Bytes of the source file, for the record. Never used as a key. */
    sourceFileSize: { type: Number, default: null, min: 0 },

    /**
     * Pages of the source PDF that are not a challan and never will be.
     *
     * A WhatsApp file occasionally carries a blank sheet, a cover page or a
     * duplicate — nothing to file, but pages all the same. Without a way to
     * say so the batch could never be completed, and a completed batch is the
     * only thing that can be downloaded and printed as one document. Filing a
     * junk challan to get past it would be worse: a permanent record, a serial
     * and a barcode for a blank page.
     *
     * So the operator marks them, and a marked page counts as accounted for
     * without becoming a record. It is a deliberate statement about the source
     * file, not a silent gap — the batch page lists exactly which pages were
     * marked, and marking one can be undone.
     */
    skippedPages: { type: [Number], required: true, default: [] },

    /**
     * Denormalised progress, recomputed from the batch's challans after every
     * write. Kept on the document because the list renders a progress bar per
     * row, and an aggregation per row on an M0 cluster is exactly the query
     * the free tier cannot afford.
     */
    challanCount: { type: Number, required: true, default: 0, min: 0 },
    /** Pages belonging to a filed challan, or marked as not being one. */
    assignedPageCount: { type: Number, required: true, default: 0, min: 0 },
    /**
     * How many of this batch's challans have been sent to a printer.
     *
     * Denormalised for the same reason the two counts above it are: the batch
     * list renders "3 of 3 printed" per row, and an aggregation per row is
     * exactly what an M0 cluster cannot afford. Recomputed from the challans
     * by `refreshBatchProgress` rather than incremented, so it cannot drift
     * away from the records it is a count of.
     */
    printedChallanCount: { type: Number, required: true, default: 0, min: 0 },

    /**
     * Two states, and neither is a button. A batch is Completed exactly when
     * every page of the source is accounted for — belonging to a submitted
     * challan, or marked as not being one — which is arithmetic rather than a
     * decision. A batch with pages nobody has looked at cannot be marked
     * finished by anybody, however much they would like to.
     */
    status: {
      type: String,
      enum: CHALLAN_BATCH_STATUSES,
      default: "Processing",
      index: true,
    },
    completedAt: { type: Date, default: null },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

/**
 * What makes "join the batch my first challan created" safe under concurrency:
 * two simultaneous first submissions both upsert on this key, and exactly one
 * of them wins.
 */
challanBatchSchema.index({ createdBy: 1, sessionKey: 1 }, { unique: true });
challanBatchSchema.index({ createdAt: -1 });
challanBatchSchema.index({ status: 1, createdAt: -1 });

export type ChallanBatch = InferSchemaType<typeof challanBatchSchema>;

export const ChallanBatchModel = model("ChallanBatch", challanBatchSchema);

export type ChallanBatchDocument = InstanceType<typeof ChallanBatchModel>;
