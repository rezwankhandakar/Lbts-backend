import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import {
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_RETENTION_DAYS,
} from './notification.constants'

/**
 * One message, to one person.
 *
 * **The fan-out is the central decision here**, and it is the opposite of the
 * one the journal makes. A journal row is written once and read by whoever
 * opens the page; a notification is written once *per recipient*, so that
 * "how many unread have I got" is an indexed count rather than a scan with a
 * membership test in it.
 *
 * The alternative — one row carrying a `readBy` array — was rejected for two
 * reasons, and the first is the one that matters on M0. "Unread, for me,
 * newest first" cannot be answered from an index when membership of an array
 * is the predicate; it becomes a collection scan on the single query this
 * module runs most, on the free tier's smallest cluster, behind a badge that
 * is polled. The second is that a shared row has no honest place to put a
 * dismissal: clearing a message you have dealt with would either delete
 * somebody else's or need the same per-person array again.
 *
 * What the duplication costs is bounded and stated: a dozen staff accounts,
 * a small event vocabulary, and a ninety-day TTL under all of it.
 */
const notificationSchema = new Schema(
  {
    /**
     * Who this is for. The only scope the collection has, and it is on every
     * index below because it is on every query — there is no endpoint in this
     * module that reads a row belonging to anybody but the caller.
     */
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * A plain string rather than an enum, the departure `activity.model.ts`
     * makes and for its reason: Mongoose validates the whole document on save,
     * so an event retired next year would make an unread row written this year
     * impossible to mark as read. `notification.validation.ts` closes the set
     * on the way in and `notificationEventMeta` degrades on the way out.
     */
    event: { type: String, required: true, trim: true, maxlength: 60 },

    /** One line, written by the service that did the thing. */
    title: { type: String, required: true, trim: true, maxlength: 160 },
    /** The sentence under it. Optional: some events say everything in the title. */
    body: { type: String, default: '', trim: true, maxlength: 400 },

    /**
     * What the message is about. The label is a **copy**, not a reference, for
     * the reason `entityLabel` is one on a journal row: "Gate pass sent back"
     * beside a dangling id is not a sentence, and a gate pass withdrawn a week
     * later must not blank the message that asked somebody to look at it.
     *
     * There is deliberately **no stored link.** Where a record lives is a fact
     * about the client's router, not about the message, so the path is derived
     * from these two fields in the browser — the arrangement `recordPath` has
     * in the activity feature. A URL stored in June is a URL that breaks when
     * a route is renamed in September, silently and in a hundred rows.
     */
    entityType: { type: String, enum: NOTIFICATION_ENTITY_TYPES, default: null },
    entityId: { type: Schema.Types.ObjectId, default: null },
    entityLabel: { type: String, default: '', trim: true, maxlength: 160 },

    /**
     * Who caused it — the name and role as copies, again so that deleting an
     * account does not blank what it did, and so the role reads as the one
     * held at the time. Null for a message nobody caused: the compliance
     * sweep's rows have no actor, because a certificate expiring is the
     * calendar rather than a person.
     */
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '', trim: true, maxlength: 160 },
    actorRole: { type: String, default: '', trim: true, maxlength: 40 },

    /**
     * When this person read it. **Null is unread**, rather than a boolean,
     * because "unread" and "read at some point I cannot name" are not equally
     * useful and the timestamp costs the same byte count as the flag would.
     */
    readAt: { type: Date, default: null },

    /**
     * What makes a repeated announcement the *same* announcement.
     *
     * Only the compliance sweep sets it, and it is the whole of why that sweep
     * may run every six hours without telling anybody four times a day that
     * the same certificate expires on the same date. The unique partial index
     * below is what enforces it — a duplicate insert loses a key race rather
     * than racing a read, the arrangement the challan idempotency claim has.
     *
     * Event-driven rows leave it null on purpose: two gate passes submitted
     * ten minutes apart are two things to be told about, and a dedupe key
     * there would swallow the second.
     */
    groupKey: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
)

/**
 * The default list: one person's messages, newest first.
 *
 * Every other index here is this one with something in front of it, because
 * every query in this module starts with the same clause — there is no route
 * that reads anybody else's inbox.
 */
notificationSchema.index({ recipientId: 1, createdAt: -1 })

/**
 * The unread count, which is the single most-run query in the module: it sits
 * behind a badge the browser polls. Partial on `readAt: null` so the index
 * holds only what the count is about — on a collection where most rows are
 * read, that is the difference between an index and a small one.
 */
notificationSchema.index(
  { recipientId: 1, createdAt: -1 },
  { name: 'notification_unread', partialFilterExpression: { readAt: null } },
)

/**
 * Module, category and priority are all derived from the event rather than
 * stored beside it, so all three filters resolve to an `$in` over events. This
 * is the index that answers them.
 */
notificationSchema.index({ recipientId: 1, event: 1, createdAt: -1 })

/**
 * What makes the compliance sweep idempotent. Unique and partial: an unlimited
 * number of rows may carry no group key, and one person may hold exactly one
 * row per key.
 */
notificationSchema.index(
  { recipientId: 1, groupKey: 1 },
  {
    name: 'notification_group',
    unique: true,
    partialFilterExpression: { groupKey: { $type: 'string' } },
  },
)

/**
 * Retention, as a TTL index. Declared here so a fresh database gets it, and
 * *corrected* by `syncNotificationIndexes` on boot — MongoDB will not change
 * an existing TTL index's expiry, so editing the constant alone would silently
 * keep the old one. See `notification.constants.ts` for why there is a limit.
 */
if (NOTIFICATION_RETENTION_DAYS > 0) {
  notificationSchema.index(
    { createdAt: 1 },
    { name: 'notification_ttl', expireAfterSeconds: NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 },
  )
}

export type Notification = InferSchemaType<typeof notificationSchema>

export const NotificationModel = model('Notification', notificationSchema)

export type NotificationDocument = InstanceType<typeof NotificationModel>
