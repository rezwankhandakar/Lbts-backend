import { getFirebaseAuth } from '../../config/firebase'
import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { toPublicUser } from '../user/user.serializer'
import type { PublicUser } from '../user/user.serializer'
import { discardAvatar, uploadAvatar } from './profile.cloudinary'
import type { UpdateProfileInput } from './profile.validation'

/**
 * Every function here takes the authenticated user's own document, loaded by
 * the auth middleware from the verified Firebase token. None of them accepts
 * an id, so there is no argument a client could supply to reach another
 * account: ownership is enforced by the shape of this module rather than by a
 * check somewhere inside it.
 */

/**
 * Keeps the display name Firebase holds in step with the one MongoDB holds.
 *
 * Firebase owns identity, so its copy of the name is what seeds a brand-new
 * profile and what `toDisplayUser` falls back to before the profile arrives.
 * Letting the two drift would show a stale name at exactly the moment the user
 * had just changed it.
 */
async function syncDisplayName(firebaseUid: string, name: string): Promise<void> {
  try {
    await getFirebaseAuth().updateUser(firebaseUid, { displayName: name })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[profile] failed to update Firebase displayName for ${firebaseUid}: ${message}`)
    throw new AppError(502, 'Your name could not be updated with the sign-in provider.')
  }
}

export async function updateMyProfile(
  user: UserDocument,
  input: UpdateProfileInput,
): Promise<PublicUser> {
  const name = input.name
  // One representation of "no phone number" in the database, never two.
  const phone = input.phone.length > 0 ? input.phone : null

  /**
   * Firebase first, deliberately. If the provider refuses, nothing has been
   * written anywhere and the user simply sees the error; the reverse order
   * would leave MongoDB ahead of the identity provider with nothing to tell
   * the two apart afterwards.
   */
  if (name !== user.name) {
    await syncDisplayName(user.firebaseUid, name)
  }

  user.name = name
  user.phone = phone
  await user.save()

  return toPublicUser(user)
}

/**
 * Replaces the profile photo.
 *
 * The order is the whole point: the new asset is uploaded first, the reference
 * is written second, and only then is the previous asset deleted. At no point
 * does the profile point at an image that no longer exists — the worst outcome
 * of a failure here is an orphaned file, never a broken avatar.
 */
export async function setProfilePhoto(user: UserDocument, buffer: Buffer): Promise<PublicUser> {
  const previousPublicId = user.photoPublicId

  const uploaded = await uploadAvatar(buffer)

  user.photoUrl = uploaded.url
  user.photoPublicId = uploaded.publicId

  try {
    await user.save()
  } catch (error) {
    // The upload succeeded but the reference never landed, so the new asset is
    // already unreachable. Clean it up rather than leave it behind.
    await discardAvatar(uploaded.publicId)
    throw error
  }

  await discardAvatar(previousPublicId)

  return toPublicUser(user)
}

/**
 * Clears the profile photo.
 *
 * The reference goes first here too. Deleting the asset first would leave the
 * profile pointing at a dead URL if the write then failed, which every viewer
 * would see; an orphaned asset is visible to no one.
 *
 * A photo seeded from a Google account carries no Cloudinary id, so in that
 * case there is nothing to delete — only a reference to clear.
 */
export async function clearProfilePhoto(user: UserDocument): Promise<PublicUser> {
  if (!user.photoUrl && !user.photoPublicId) {
    throw new AppError(409, 'There is no profile photo to remove.')
  }

  const previousPublicId = user.photoPublicId

  user.photoUrl = null
  user.photoPublicId = null
  await user.save()

  await discardAvatar(previousPublicId)

  return toPublicUser(user)
}
