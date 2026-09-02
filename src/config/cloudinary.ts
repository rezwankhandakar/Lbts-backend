import { v2 as cloudinary } from 'cloudinary'
import type { UploadApiOptions, UploadApiResponse } from 'cloudinary'
import { AppError } from '../utils/app-error'
import { config } from './index'

let configured = false

export function isCloudinaryConfigured(): boolean {
  return config.cloudinary !== null
}

/**
 * Lazily configures the SDK once per process, mirroring config/firebase.ts:
 * the server must still boot — and /health must still answer — when the
 * credentials are missing or wrong.
 *
 * The API secret lives only here. Uploads are signed server-side, so the
 * browser never holds a Cloudinary credential of any kind.
 */
function getCloudinary(): typeof cloudinary {
  if (!config.cloudinary) {
    throw new AppError(503, 'Image uploads are not configured. Contact an administrator.')
  }

  if (!configured) {
    cloudinary.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
      secure: true,
    })
    configured = true
  }

  return cloudinary
}

/**
 * Uploads a buffer held in memory. `upload_stream` is the only entry point
 * that takes a buffer without a temporary file, which matters on Render's
 * free tier: the filesystem is ephemeral and the instance is small.
 */
export function uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<UploadApiResponse> {
  const client = getCloudinary()

  return new Promise((resolve, reject) => {
    const stream = client.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(new AppError(502, 'The image could not be uploaded. Please try again.'))
        return
      }
      if (!result) {
        reject(new AppError(502, 'The image host returned an empty response.'))
        return
      }
      resolve(result)
    })

    stream.end(buffer)
  })
}

/**
 * Deletes an asset. Never throws: every caller deletes an image that has
 * already been replaced or unlinked in MongoDB, so a failure here leaves an
 * orphan in Cloudinary rather than a broken profile — the cheaper of the two.
 */
export async function destroyAsset(publicId: string): Promise<void> {
  try {
    await getCloudinary().uploader.destroy(publicId, { invalidate: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[cloudinary] failed to delete ${publicId}: ${message}`)
  }
}
