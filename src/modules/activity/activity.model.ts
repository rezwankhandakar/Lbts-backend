import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_RETENTION_DAYS,
  MAX_ACTIVITY_CHANGES,
} from './activity.constants'

/**
 * One thing that happened, and who did it.
 *
 * Append-only: nothing in this codebase updates a row here, and there is no
 * endpoint that could. The collection is the promotion of `VendorActivity`
 * into the whole application's journal — see `activity.migration.ts`, which
 * folds the legacy rows in under their own ids so the fold is idempotent.
 *
 * **The action is a plain string rather than a Mongoose enum**, deliberately,
 * and it is the one place this module departs from the codebase's habit of
 * enumerating everything. Mongoose validates the whole document on save, and
 * this collection's whole job is to outlive the vocabulary that wrote it: an
 * action retired in 2027 must not make a 2025 row unreadable, and there is no
 * `user.migration.ts` to normalise a journal because a journal is not
 * something you are allowed to rewrite. The set is still closed where it
 * matters — `activity.validation.ts` refuses an unknown action on the way in,
 * and `actionMeta` degrades to a neutral reading on the way out.
 */
const activityChangeSchema = new Schema(
  {
    field: { type: String, required: true, trim: true, maxlength: 80 },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    /**
     * Rendered strings rather than raw values, and nullable rather than
     * defaulted to '': a cleared note and a note that was never written read
     * the same on screen and are not the same fact. See `activity.diff.ts`.
     */
    from: { type: String, default: null, maxlength: 400 },
    to: { type: String, default: null, maxlength: 400 },
  },
  { _id: false },
)

const activitySchema = new Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: 60, index: true },

    /** What the row is about, so a reader can filter to one kind of record. */
    entityType: { type: String, enum: ACTIVITY_ENTITY_TYPES, required: true },
    /** Kept even after the record is deleted — it is how the row is found again. */
    entityId: { type: Schema.Types.ObjectId, default: null },
    /**
     * A copy, not a reference. A row has to still read as a sentence after the
     * vehicle it names has been deleted, and "Vehicle removed" beside a
     * dangling id is not a sentence.
     */
    entityLabel: { type: String, default: '', trim: true, maxlength: 160 },

    /** One sentence, written by the service that did the thing. */
    summary: { type: String, required: true, trim: true, maxlength: 300 },

    /** Field-level detail, where the service had a before and an after. */
    changes: {
      type: [activityChangeSchema],
      default: [],
      validate: {
        validator: (value: unknown[]) => value.length <= MAX_ACTIVITY_CHANGES,
        message: `A row records at most ${MAX_ACTIVITY_CHANGES} changes.`,
      },
    },

    /**
     * Who did it — an id to filter by, and their name and role **as copies**.
     *
     * The copies are the point. Deleting a user must not blank a year of "who
     * did it", and the role is the audit-relevant fact anyway: what matters is
     * that this was done by a Manager at the time, not what that person's role
     * happens to be today. It is the same reasoning `entityLabel` above
     * follows, and the reason this module resolves no actor names at read time.
     */
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorName: { type: String, default: '', trim: true, maxlength: 160 },
    actorRole: { type: String, default: '', trim: true, maxlength: 40 },

    /**
     * The vendor a row belongs to, where it belongs to one.
     *
     * The only scope this collection carries, and it exists because a Vendor
     * account's page shows its own journal — the arrangement the legacy
     * collection had, kept. Everything else is scoped by role alone.
     */
    scopeVendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
)

/** The default list: everything, newest first. */
activitySchema.index({ createdAt: -1 })

/**
 * A module, a category or a severity filter all resolve to an `$in` over
 * actions rather than to a stored column — see `ACTION_META`. This is the
 * index that answers all three.
 */
activitySchema.index({ action: 1, createdAt: -1 })

/** One person's trail, which is the second question anybody asks of a journal. */
activitySchema.index({ actorId: 1, createdAt: -1 })

/** One record's history — "what has happened to this challan". */
activitySchema.index({ entityType: 1, entityId: 1, createdAt: -1 })

/** One vendor's journal, as the vendor page reads it. */
activitySchema.index({ scopeVendorId: 1, createdAt: -1 })

/**
 * Retention, as a TTL index. Declared here so a fresh database gets it, and
 * *corrected* by `syncActivityIndexes` on boot — MongoDB will not change an
 * existing TTL index's expiry, so editing `ACTIVITY_RETENTION_DAYS` alone
 * would silently keep the old one. See `activity.constants.ts` for why there
 * is a limit at all.
 */
if (ACTIVITY_RETENTION_DAYS > 0) {
  activitySchema.index(
    { createdAt: 1 },
    { name: 'activity_ttl', expireAfterSeconds: ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 },
  )
}

export type Activity = InferSchemaType<typeof activitySchema>

export const ActivityModel = model('ActivityLog', activitySchema)

export type ActivityDocument = InstanceType<typeof ActivityModel>
