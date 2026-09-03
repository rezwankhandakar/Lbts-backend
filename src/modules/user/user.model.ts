import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { DEFAULT_USER_ROLE, DEFAULT_USER_STATUS, USER_ROLES, USER_STATUSES } from './user.constants'

const userSchema = new Schema(
  {
    /** Firebase owns identity; this is the join key back to the auth provider. */
    firebaseUid: { type: String, required: true, unique: true, index: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    /** Optional contact number the user maintains from their own profile. */
    phone: { type: String, default: null, trim: true, maxlength: 24 },
    photoUrl: { type: String, default: null },
    /**
     * Cloudflare R2 object key for a photo uploaded through the profile module.
     * MongoDB stores the reference, never the image itself. Null means the
     * photo came from the auth provider (a Google picture) or there is none —
     * which is also what tells the service whether there is an object to clean
     * up when the photo is replaced or removed.
     */
    photoKey: { type: String, default: null },
    emailVerified: { type: Boolean, default: false },
    /**
     * Roles are assigned server-side only. Nothing in a request payload can set
     * this on sign-up — see user.service.ts, where role is written with
     * $setOnInsert. Only the Admin-only administration module changes it later.
     */
    role: {
      type: String,
      enum: USER_ROLES,
      default: DEFAULT_USER_ROLE,
      index: true,
    },
    status: {
      type: String,
      enum: USER_STATUSES,
      default: DEFAULT_USER_STATUS,
      index: true,
    },
    lastLoginAt: { type: Date, default: null },

    /**
     * Lightweight provenance for administrative changes: who last touched the
     * role or the status, and when. Not an audit log — an audit log records
     * every event, this records only the latest — but it is the metadata an
     * audit module would need to backfill from, and it makes the details panel
     * answer "who did this" without a second collection.
     */
    roleUpdatedAt: { type: Date, default: null },
    roleUpdatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    statusUpdatedAt: { type: Date, default: null },
    statusUpdatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    /** Optional reason captured when an account is rejected or suspended. */
    statusNote: { type: String, default: null, trim: true, maxlength: 240 },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * Serves the administration list, which filters on role and/or status and
 * always sorts by newest first. M0 has little CPU to spend on collection
 * scans, so the exact query shape gets its own compound index.
 */
userSchema.index({ role: 1, status: 1, createdAt: -1 })
userSchema.index({ createdAt: -1 })

export type User = InferSchemaType<typeof userSchema>

export const UserModel = model('User', userSchema)

/**
 * Derived from the model rather than built by hand: Mongoose 9 folds schema
 * options (versionKey, timestamps) into the hydrated type, so a hand-written
 * HydratedDocument<User> does not structurally match what queries return.
 */
export type UserDocument = InstanceType<typeof UserModel>

export { USER_ROLES, USER_STATUSES } from './user.constants'
export type { UserRole, UserStatus } from './user.constants'
