import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { deleteObject, publicUrlFor, putObject, requireStorage } from '../../config/r2'
import { AppError } from '../../utils/app-error'
import { maxDocumentBytesFor } from './vendor.constants'
import type { DocumentMimeType } from './vendor.constants'

/**
 * Everything this module writes to Cloudflare R2, and there are two kinds of
 * it — which is the one design decision in this file.
 *
 * **Photos** (a vendor's mark, a driver's portrait) go to the public bucket,
 * normalised to a 512px square WEBP, exactly like a profile avatar. They carry
 * no licence number and no address, they are rendered twenty at a time in a
 * table, and routing each one through an authenticated stream would cost twenty
 * requests to a sleeping instance for a picture.
 *
 * **Compliance documents** (registration certificates, fitness certificates,
 * licences) are private. They carry an owner's name, an address and a licence
 * number, so the bucket never serves them: MongoDB stores only the object key
 * and `GET /vendor-documents/:id/file` re-checks authentication, role and
 * vendor scope before streaming.
 *
 * That is the same split the rest of the codebase already makes between an
 * avatar and a gate pass scan, and both halves reuse the machinery those two
 * modules established rather than growing a third copy of it.
 */

// --- Photos ----------------------------------------------------------------

/** Square, and the largest a vendor or driver photo is ever rendered at. */
const PHOTO_SIZE = 512
const PHOTO_CONTENT_TYPE = 'image/webp'
const PHOTO_EXTENSION = 'webp'

/**
 * Safe to cache forever because every upload lands on a fresh key — a replaced
 * photo is a different URL, so no cached copy is ever stale.
 */
const PHOTO_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export interface StoredPhoto {
  url: string
  key: string
}

/**
 * `.rotate()` with no argument applies the EXIF orientation and drops the tag.
 * Without it a portrait photo off a phone is stored on its side, and the crop
 * below would take the wrong part of the frame — the same reasoning
 * `profile.storage.ts` documents for an avatar.
 */
async function normalizePhoto(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { failOn: 'error' })
      .rotate()
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[vendor] rejected an unreadable image: ${message}`)
    // The mime type said image and the bytes disagreed. The client's problem.
    throw new AppError(400, 'That image could not be read. Choose a different file.')
  }
}

/**
 * Stores one photo and returns the reference MongoDB will hold.
 *
 * `scope` separates vendors from drivers inside the prefix, so the bucket stays
 * browsable and the two can be given different lifecycle rules later. The key
 * itself is random: nothing the user controls reaches it, because a
 * user-supplied filename in an object key is a path-traversal and overwrite
 * problem waiting to happen.
 */
export async function uploadVendorPhoto(
  buffer: Buffer,
  scope: 'vendors' | 'drivers',
): Promise<StoredPhoto> {
  // Before decoding anything: an unconfigured deployment should answer 503
  // rather than spend a cold instance's CPU on an image it cannot store.
  const { vendorKeyPrefix } = requireStorage()

  const normalized = await normalizePhoto(buffer)
  const key = `${vendorKeyPrefix}/${scope}/${randomUUID()}.${PHOTO_EXTENSION}`

  await putObject({
    key,
    body: normalized,
    contentType: PHOTO_CONTENT_TYPE,
    cacheControl: PHOTO_CACHE_CONTROL,
  })

  return { url: publicUrlFor(key), key }
}

// --- Documents -------------------------------------------------------------

const EXTENSIONS: Record<DocumentMimeType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * A scan at 300 dpi is 2480 x 3508 for A4, so nothing produced on an office
 * scanner is touched by this. It exists for the phone-camera outlier, where the
 * extra pixels cost bandwidth on both sides and add nothing a reader can use.
 */
const MAX_IMAGE_EDGE = 4000

/**
 * `private` rather than `public`: this object is served through the
 * authenticated API, and no shared cache should be holding a copy of it.
 * Immutable is still safe because every upload lands on a fresh key.
 */
const DOCUMENT_CACHE_CONTROL = 'private, max-age=31536000, immutable'

export interface StoredAttachment {
  key: string
  mimeType: DocumentMimeType
  size: number
  originalName: string
  uploadedAt: Date
}

export interface UploadAttachmentInput {
  /** The vendor id, which is what the object key is grouped under. */
  vendorRef: string
  documentType: string
  buffer: Buffer
  mimeType: string
  originalName: string
}

function isSupportedMimeType(value: string): value is DocumentMimeType {
  return value in EXTENSIONS
}

/**
 * The bytes have to agree with the declared type. Multer trusts the
 * Content-Type the client sent, which is a claim and not a fact — and an
 * executable renamed to .pdf would otherwise be stored and later handed back
 * with a PDF header. For images sharp decoding the buffer *is* the proof; for
 * PDFs there is no decoder here, so the file signature is checked directly.
 */
function assertPdfSignature(buffer: Buffer): void {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError(400, 'That file is not a readable PDF. Choose a different file.')
  }
}

/**
 * Prepares a scanned document for storage without degrading it.
 *
 * The opposite of what a photo gets, and deliberately so: a fitness certificate
 * is a record somebody has to read a number off, so it is never cropped, never
 * squared and never re-encoded unless there is a reason. There are exactly two
 * reasons — an EXIF orientation tag that has to be applied, or an image far
 * beyond scanning resolution. The same rule `gate-pass.storage.ts` follows.
 */
async function normalizeScan(
  buffer: Buffer,
  mimeType: DocumentMimeType,
): Promise<Buffer> {
  let metadata: sharp.Metadata

  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[vendor] rejected an unreadable document image: ${message}`)
    throw new AppError(400, 'That image could not be read. Choose a different file.')
  }

  const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0)
  const needsRotation = (metadata.orientation ?? 1) !== 1
  const needsResize = longestEdge > MAX_IMAGE_EDGE

  if (!needsRotation && !needsResize) {
    return buffer
  }

  const pipeline = sharp(buffer, { failOn: 'error' }).rotate()

  if (needsResize) {
    pipeline.resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, { fit: 'inside', withoutEnlargement: true })
  }

  /**
   * The output format matches the input. Converting everything to one format
   * would be tidier and wrong: a PNG scan is often a bi-level page where JPEG
   * would smear the text.
   */
  if (mimeType === 'image/png') {
    return pipeline.png({ compressionLevel: 9 }).toBuffer()
  }
  if (mimeType === 'image/webp') {
    return pipeline.webp({ quality: 90 }).toBuffer()
  }
  return pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
}

/** A document type is part of a key, so it must not carry a slash or a space. */
function keySegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document'
}

/**
 * Validates, normalises and stores one compliance document.
 *
 * Size is checked here as well as in the multipart parser, because the parser
 * enforces one ceiling for everything and the two formats have different
 * limits: a 20 MB "image" gets through the parser on the PDF allowance and is
 * refused here.
 */
export async function uploadVendorDocument(
  input: UploadAttachmentInput,
): Promise<StoredAttachment> {
  const { vendorDocumentKeyPrefix } = requireStorage()

  if (!isSupportedMimeType(input.mimeType)) {
    throw new AppError(400, 'Unsupported document type. Use PDF, JPG, PNG or WEBP.')
  }

  if (input.buffer.length === 0) {
    throw new AppError(400, 'That file is empty. Choose a different file.')
  }

  const limit = maxDocumentBytesFor(input.mimeType)
  if (input.buffer.length > limit) {
    const megabytes = Math.round(limit / (1024 * 1024))
    throw new AppError(
      413,
      input.mimeType === 'application/pdf'
        ? `That PDF is larger than ${megabytes} MB.`
        : `That image is larger than ${megabytes} MB. Scan it as a PDF, or at a lower resolution.`,
    )
  }

  const mimeType = input.mimeType
  let body = input.buffer

  if (mimeType === 'application/pdf') {
    assertPdfSignature(body)
  } else {
    body = await normalizeScan(body, mimeType)
  }

  const key = `${vendorDocumentKeyPrefix}/${input.vendorRef}/${keySegment(
    input.documentType,
  )}/${randomUUID()}.${EXTENSIONS[mimeType]}`

  await putObject({ key, body, contentType: mimeType, cacheControl: DOCUMENT_CACHE_CONTROL })

  return {
    key,
    mimeType,
    size: body.length,
    originalName: safeOriginalName(input.originalName),
    uploadedAt: new Date(),
  }
}

/**
 * The original filename, reduced to something safe to store and display. It is
 * metadata only — it never becomes part of a key — but it is still rendered, so
 * control characters and path separators have no business in it.
 */
export function safeOriginalName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value
  // Filtered by codepoint rather than by regex: no control character has to
  // appear in this source file for it to be removed.
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code > 31 && code !== 127
    })
    .join('')
    .trim()

  return (cleaned.length > 0 ? cleaned : 'document').slice(0, 200)
}

/**
 * Removes an object nothing references any more. Safe to call with null, and
 * never throws — every caller has already replaced or cleared the reference in
 * MongoDB, so a failure here leaves an orphan in the bucket rather than a
 * record pointing at a file that no longer exists.
 */
export async function discardVendorObject(key: string | null | undefined): Promise<void> {
  if (!key) {
    return
  }
  await deleteObject(key)
}
