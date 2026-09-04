import type { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
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

export interface ObjectStream {
  body: Readable
  contentType: string | undefined
  contentLength: number | undefined
}

/**
 * Reads one object back out of the bucket.
 *
 * Profile photos never need this — they are public and the browser fetches
 * them directly. Gate pass documents are the opposite case: the bucket must
 * not serve them, so the API is the only read path and it streams rather than
 * buffering, which keeps a 25 MB PDF off a small instance's heap.
 */
export async function getObjectStream(key: string): Promise<ObjectStream> {
  const r2 = requireStorage()

  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: r2.bucket, Key: key }),
    )

    if (!response.Body) {
      throw new AppError(404, 'That document is no longer available.')
    }

    return {
      // The SDK types Body as a union covering browser streams too; in Node it
      // is always a Readable, and nothing else can reach this line.
      body: response.Body as Readable,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error
    }

    const name = (error as { name?: string }).name
    if (name === 'NoSuchKey' || name === 'NotFound') {
      // The reference outlived the object. That is a real 404 for the caller,
      // not a server fault, and it is worth logging as a storage drift.
      console.warn(`[r2] missing object for key ${key}`)
      throw new AppError(404, 'That document is no longer available.')
    }

    const message = error instanceof Error ? error.message : String(error)
    console.error(`[r2] failed to read ${key}: ${message}`)
    throw new AppError(502, 'The document could not be retrieved. Please try again.')
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
