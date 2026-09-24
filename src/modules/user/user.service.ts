import type { DecodedIdToken } from 'firebase-admin/auth'
import { recordActivity } from '../activity/activity.recorder'
import { APPROVAL_AUDIENCE_ROLES } from '../notification/notification.constants'
import { notify } from '../notification/notification.recorder'
import { DEFAULT_USER_ROLE, DEFAULT_USER_STATUS } from './user.constants'
import { UserModel } from './user.model'
import type { UserDocument } from './user.model'
import type { SyncUserInput } from './user.validation'

/**
 * Creates the profile on first sign-in, or refreshes it on later ones.
 *
 * `role` and `status` are written with $setOnInsert, so they are set once at
 * creation and never overwritten by a later sync. That is what makes it safe
 * to call this on every login: an Admin cannot be silently demoted, and a
 * rejected or suspended account cannot revive itself by signing in again.
 *
 * Every account is therefore born least-privileged and Pending, and stays
 * unusable until an Admin approves it in the administration module.
 */
export async function syncUserProfile(
  token: DecodedIdToken,
  input: SyncUserInput,
): Promise<UserDocument> {
  const email = token.email
  if (!email) {
    throw new Error('Firebase token has no email claim')
  }

  const fieldsToSet: Record<string, unknown> = {
    email,
    emailVerified: Boolean(token.email_verified),
    lastLoginAt: new Date(),
  }

  const fieldsOnInsert: Record<string, unknown> = {
    firebaseUid: token.uid,
    role: DEFAULT_USER_ROLE,
    status: DEFAULT_USER_STATUS,
  }

  /**
   * Name and photo are owned by the profile once the account exists, so the
   * token's claims only ever seed them at creation.
   *
   * This is what makes the profile module safe: an ID token's `name` and
   * `picture` lag behind — a Google account keeps sending its own picture
   * forever — so setting them on every sync would silently undo an edited
   * name and restore a photo the user had just removed. An explicit
   * `input.name` is different: that is the client stating intent, and it is
   * what the sign-up flow sends alongside a fresh updateProfile() call.
   *
   * A field may appear in $set or in $setOnInsert, never both: MongoDB rejects
   * the update with "Updating the path 'name' would create a conflict at
   * 'name'". $set already applies on an upsert insert, so each field below
   * lands in exactly one of the two.
   */
  if (input.name) {
    fieldsToSet.name = input.name
  } else {
    fieldsOnInsert.name = token.name ?? email.split('@')[0] ?? 'User'
  }

  if (input.photoUrl) {
    fieldsToSet.photoUrl = input.photoUrl
  } else if (token.picture) {
    fieldsOnInsert.photoUrl = token.picture
  }

  /**
   * `includeResultMetadata` is what tells an account being created apart from
   * one signing in again, and it costs nothing: the driver already knows which
   * happened and this only asks it to say so. The alternative — a `findOne`
   * before the upsert — would be a second round trip on the one endpoint the
   * session listener calls on *every* page load, which on a sleeping M0
   * instance is exactly the cost this codebase spends its time avoiding.
   */
  const result = await UserModel.findOneAndUpdate(
    { firebaseUid: token.uid },
    {
      $set: fieldsToSet,
      $setOnInsert: fieldsOnInsert,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, includeResultMetadata: true },
  )

  const user = result.value as UserDocument

  /**
   * A new account, journalled once.
   *
   * The actor is the person themselves, which is the honest reading: nobody
   * granted this, somebody signed up. What makes the row worth having is the
   * pair it forms with the `user.status` row an Admin writes later — together
   * they say how long an account waited for approval, which is a question the
   * account document cannot answer because it keeps only the latest change.
   *
   * Guarded on `upserted` rather than written every sync, or this would be a
   * row per page load.
   */
  if (result.lastErrorObject?.upserted) {
    await recordActivity({
      action: 'user.created',
      entityType: 'User',
      entityId: user._id,
      entityLabel: user.name,
      summary: `${user.name} (${user.email}) signed up — created as ${user.role}, ${user.status}`,
      actor: user,
    })

    /**
     * And the announcement, which is the gap CLAUDE.md named twice: "an Admin
     * who never opens the dashboard still learns about a waiting account only by
     * going to look". Now they are told.
     *
     * Guarded on `upserted` alongside the journal row, or the session listener —
     * which calls this endpoint on **every page load** — would announce the same
     * account forever. Addressed to whoever can actually approve it, because a
     * message about a decision nobody reading it may make is a message that
     * teaches people to stop reading.
     */
    await notify({
      event: 'account.pending',
      audience: { kind: 'roles', roles: APPROVAL_AUDIENCE_ROLES },
      title: `${user.name} is waiting for account approval`,
      body: `${user.email} signed up and cannot use the system until an administrator approves the account and assigns a role.`,
      entityType: 'User',
      entityId: user._id,
      entityLabel: user.name,
      /**
       * The actor is the person who signed up, which is the honest reading —
       * nobody granted this. They cannot be in the Admin audience, so the
       * exclusion `notify` applies costs nothing and says the right thing.
       */
      actor: user,
    })
  }

  return user
}

export async function findUserByFirebaseUid(firebaseUid: string): Promise<UserDocument | null> {
  return UserModel.findOne({ firebaseUid })
}
