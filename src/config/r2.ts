import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { AppError } from '../utils/app-error'
import { config } from './index'

type R2Config = NonNullable<typeof config.r2>

let client: S3Client | undefined

/**
 * The credentials, or a 503. Every entry point below starts here, so an
 * unconfigured deployment answers "uploads are not set up" rather than failing
 * somewhere inside the SDK — and it fails before any work is done on the image.
 */
export function requireStorage(): R2Config {
  if (!config.r2) {
    throw new AppError(503, 'Image uploads are not configured. Contact an administrator.')
  }
  return config.r2
}

/**
 * Lazily builds the S3 client once per process, mirroring config/firebase.ts:
 * the server must still boot — and /health must still answer — when the
 * credentials are missing or wrong.
 *
 * R2 speaks the S3 API, so the AWS SDK is the client. Two settings are not
 * optional here: `region: 'auto'`, because R2 has no regions to name, and the
 * two checksum options, because the SDK otherwise adds AWS-flavoured integrity
 * headers that S3-compatible endpoints are not obliged to understand. SigV4
 * already signs the body, so nothing is lost by asking for them only when a
 * command actually requires them.
 */
function getClient(): S3Client {
  if (client) {
    return client
  }

  const r2 = requireStorage()

  client = new S3Client({
    region: 'auto',
    endpoint: r2.endpoint,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })

  return client
}

/** Where the browser reads an object from, once it has been written. */
export function publicUrlFor(key: string): string {
  return `${requireStorage().publicBaseUrl}/${key}`
}

export interface PutObjectInput {
  key: string
  body: Buffer
  contentType: string
  /** Sent verbatim to whatever CDN fronts the bucket. */
  cacheControl?: string
}

/**
 * Writes one object. The buffer is held in memory and streamed straight out,
 * which matters on Render's free tier: the filesystem is ephemeral and the
 * instance is small.
 */
export async function putObject(input: PutObjectInput): Promise<void> {
  const r2 = requireStorage()

  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[r2] failed to upload ${input.key}: ${message}`)
    throw new AppError(502, 'The image could not be uploaded. Please try again.')
  }
}

/**
 * Deletes an object. Never throws: every caller deletes an image that has
 * already been replaced or unlinked in MongoDB, so a failure here leaves an
 * orphan in the bucket rather than a broken profile — the cheaper of the two.
 */
export async function deleteObject(key: string): Promise<void> {
  try {
    await getClient().send(
      new DeleteObjectCommand({
        Bucket: requireStorage().bucket,
        Key: key,
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[r2] failed to delete ${key}: ${message}`)
  }
}
