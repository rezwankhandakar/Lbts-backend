import type { DecodedIdToken } from 'firebase-admin/auth'
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

  const user = await UserModel.findOneAndUpdate(
    { firebaseUid: token.uid },
    {
      $set: fieldsToSet,
      $setOnInsert: fieldsOnInsert,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  return user
}

export async function findUserByFirebaseUid(firebaseUid: string): Promise<UserDocument | null> {
  return UserModel.findOne({ firebaseUid })
}
