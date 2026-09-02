import { destroyAsset, uploadBuffer } from '../../config/cloudinary'
import { config } from '../../config/index'

export interface StoredPhoto {
  url: string
  publicId: string
}

/**
 * Stores one avatar and returns the reference MongoDB will hold.
 *
 * The asset is normalised on the way in — square, 512px, content-aware crop,
 * automatic quality — so what is stored is a predictable thumbnail rather than
 * whatever came off the phone. That keeps the free-tier storage and bandwidth
 * budget flat no matter what anyone uploads.
 *
 * The public id is left to Cloudinary rather than derived from the account, so
 * each upload is a distinct asset. That is what lets a replacement be written
 * without ever touching the image the profile is still pointing at.
 */
export async function uploadAvatar(buffer: Buffer): Promise<StoredPhoto> {
  const result = await uploadBuffer(buffer, {
    folder: config.cloudinary?.folder,
    resource_type: 'image',
    transformation: [
      { width: 512, height: 512, crop: 'fill', gravity: 'auto' },
      { quality: 'auto' },
    ],
  })

  return { url: result.secure_url, publicId: result.public_id }
}

/**
 * Removes an asset that nothing references any more. Safe to call with null,
 * because a photo seeded from a Google account has no Cloudinary id to delete.
 */
export async function discardAvatar(publicId: string | null | undefined): Promise<void> {
  if (!publicId) {
    return
  }
  await destroyAsset(publicId)
}
