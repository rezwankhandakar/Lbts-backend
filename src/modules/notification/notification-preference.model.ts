import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { NOTIFICATION_CATEGORIES } from './notification.constants'

/**
 * What one person has asked not to be told about.
 *
 * A document per user, created the first time somebody changes something —
 * **absent means the default**, which is everything on. That is deliberate:
 * seeding a preference row for every account would put a write on the sign-up
 * path to record the absence of a decision, and a collection of rows that all
 * say "no opinion" is a collection that has to be kept in step with the
 * category list forever.
 *
 * It stores what is **off** rather than what is on, for the same reason. A
 * stored allow-list would silently exclude any category added later — somebody
 * who set their preferences in 2026 would never hear about a kind of event
 * introduced in 2027, and nothing anywhere would say why.
 *
 * The categories are stored rather than the events, because muting is a
 * decision about a kind of interruption and never about one sentence. See
 * `NOTIFICATION_CATEGORIES`.
 */
const notificationPreferenceSchema = new Schema(
  {
    /**
     * One row per account, and the unique index is what says so. Not a
     * reference anybody follows — it is the key.
     */
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    /**
     * Categories this person has switched off.
     *
     * The enum is the full category list rather than the mutable subset, so an
     * `account` value written by some future caller is *storable* — and then
     * ignored, because `mutedCategoriesOf` filters against
     * `MUTABLE_CATEGORIES` on the way out. Refusing it at the schema would
     * make a whole preference document unsaveable over one stale value, which
     * is the Mongoose whole-document-validation trap this codebase has been
     * caught by twice already.
     */
    mutedCategories: {
      type: [{ type: String, enum: NOTIFICATION_CATEGORIES }],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

export type NotificationPreference = InferSchemaType<typeof notificationPreferenceSchema>

export const NotificationPreferenceModel = model(
  'NotificationPreference',
  notificationPreferenceSchema,
)

export type NotificationPreferenceDocument = InstanceType<typeof NotificationPreferenceModel>
