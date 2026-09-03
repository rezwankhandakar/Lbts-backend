import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { AppError } from '../../utils/app-error'
import { deleteObject, publicUrlFor, putObject, requireStorage } from '../../config/r2'

export interface StoredPhoto {
  url: string
  key: string
}

/** Square, and the largest an avatar is ever rendered at. */
const AVATAR_SIZE = 512

/**
 * One stored format, whatever arrives. WEBP is smaller than JPEG at the same
 * quality, keeps transparency where a PNG had it, and is supported by every
 * browser this app targets.
 */
const AVATAR_CONTENT_TYPE = 'image/webp'
const AVATAR_EXTENSION = 'webp'

/**
 * Safe to cache forever because every upload lands on a fresh key — a replaced
 * photo is a different URL, so no cached copy is ever stale. This is what keeps
 * repeat views off the bucket entirely.
 */
const AVATAR_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Normalises the image before it is stored.
 *
 * R2 is object storage and nothing more — unlike an image CDN it will hand back
 * exactly the bytes it was given, so the resizing that used to happen on the
 * way *out* has to happen here on the way *in*. That is the whole reason sharp
 * is a dependency: it keeps the free-tier storage and bandwidth budget flat no
 * matter what comes off someone's phone.
 *
 * `.rotate()` with no argument applies the EXIF orientation and then drops the
 * tag. Without it a portrait photo from a phone is stored on its side, because
 * the pixels are landscape and only the metadata says otherwise — and the crop
 * below would take the wrong part of the frame.
 */
async function normalizeAvatar(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { failOn: 'error' })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, {
        fit: 'cover',
        // Keeps the busiest region of the frame, which for a photo of a person
        // is the person. The closest equivalent to a content-aware crop.
        position: 'attention',
      })
      .webp({ quality: 82 })
      .toBuffer()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[profile] rejected an unreadable image: ${message}`)
    // The mime type said it was an image and the bytes disagreed. That is the
    // client's problem to fix, not a server fault.
    throw new AppError(400, 'That image could not be read. Choose a different file.')
  }
}

/**
 * Stores one avatar and returns the reference MongoDB will hold.
 *
 * The key is random rather than derived from the account, so each upload is a
 * distinct object. That is what lets a replacement be written without ever
 * touching the image the profile is still pointing at.
 */
export async function uploadAvatar(buffer: Buffer): Promise<StoredPhoto> {
  // Before decoding anything: an unconfigured deployment should answer 503
  // rather than spend a cold instance's CPU on an image it cannot store.
  const { keyPrefix } = requireStorage()

  const normalized = await normalizeAvatar(buffer)
  const key = `${keyPrefix}/${randomUUID()}.${AVATAR_EXTENSION}`

  await putObject({
    key,
    body: normalized,
    contentType: AVATAR_CONTENT_TYPE,
    cacheControl: AVATAR_CACHE_CONTROL,
  })

  return { url: publicUrlFor(key), key }
}

/**
 * Removes an object that nothing references any more. Safe to call with null,
 * because a photo seeded from a Google account has no object of ours to delete.
 */
export async function discardAvatar(key: string | null | undefined): Promise<void> {
  if (!key) {
    return
  }
  await deleteObject(key)
}
