import { Schema, model } from "mongoose";
import type { InferSchemaType } from "mongoose";

/**
 * The claim that stops one challan being filed twice.
 *
 * Submitting a challan allocates two numbers, builds a PDF and writes an
 * object to R2 — several seconds of work on a cold instance, which is exactly
 * how long an operator waits before pressing the button again. Disabling the
 * button covers the impatient click and nothing else: a retried request from a
 * flaky connection, a refresh mid-submission, or two tabs on the same entry
 * all arrive at the server as a second POST, and the server is the only place
 * that can refuse them.
 *
 * So the first thing a submission does is *insert* a claim keyed on an
 * idempotency key the browser generated for that entry. `_id` carries a unique
 * index by definition, so the second insert of the same key fails with a
 * duplicate-key error rather than racing — no read-then-write window, no
 * transaction, one round trip.
 *
 * What happens next depends on what the claim says:
 *
 * - `completed` — the work already finished. The original challan is returned
 *   as if this were the first request, which is what makes a retry safe rather
 *   than merely refused.
 * - `pending` — another request is mid-flight. Answered with a 409 rather than
 *   a second document.
 *
 * A submission that fails deletes its own claim, so the operator can correct
 * whatever went wrong and try again with the same key. The numbers it had
 * already allocated are not reused — a gap in the SL sequence is cheap, and
 * recycling identifiers is how two challans end up sharing one.
 */
const challanSubmissionSchema = new Schema(
  {
    /** The idempotency key itself, so the unique index is free. */
    _id: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "completed"],
      required: true,
      default: "pending",
    },
    /** Set when the work finishes; the record a replay is answered with. */
    challanId: { type: Schema.Types.ObjectId, ref: "Challan", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);

/**
 * Claims are swept after a day.
 *
 * They exist to make a retry within one working session safe, not to be a
 * second copy of the challan collection — a completed claim a month old
 * protects against nothing, because no browser is still holding that key. The
 * TTL keeps the collection at roughly a day's submissions on an M0 cluster
 * with little room to spare.
 */
challanSubmissionSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60 },
);

export type ChallanSubmission = InferSchemaType<typeof challanSubmissionSchema>;

export const ChallanSubmissionModel = model(
  "ChallanSubmission",
  challanSubmissionSchema,
);

export type ChallanSubmissionDocument = InstanceType<
  typeof ChallanSubmissionModel
>;
