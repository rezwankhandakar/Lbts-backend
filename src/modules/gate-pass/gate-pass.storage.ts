import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { deleteObject, putObject, requireStorage } from '../../config/r2'
import { AppError } from '../../utils/app-error'
import { maxBytesFor } from './gate-pass.constants'
import type { GatePassDocumentMimeType } from './gate-pass.constants'

export interface StoredDocument {
  key: string
  mimeType: GatePassDocumentMimeType
  size: number
  originalName: string
  uploadedAt: Date
  pageCount: number | null
}

export interface UploadDocumentInput {
  gatePassId: string
  tripDate: Date
  buffer: Buffer
  mimeType: string
  originalName: string
  /**
   * Reported by whatever produced the file — the scanner agent knows how many
   * sheets it fed. Never guessed: a page count nobody measured is worse than
   * no page count at all.
   */
  pageCount: number | null
}

const EXTENSIONS: Record<GatePassDocumentMimeType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * A scan at 300 dpi is 2480 x 3508 for A4, so nothing an operator produces on
 * the MF270 is touched by this. It exists for the 600 dpi or phone-camera
 * outlier, where the extra pixels cost bandwidth on both sides and add nothing
 * a reader can use.
 */
const MAX_IMAGE_EDGE = 4000

/**
 * Safe to cache forever because every upload lands on a fresh key — replacing
 * a document is a different key, so no cached copy is ever stale. `private`
 * rather than `public`: this object is served through the authenticated API,
 * and no shared cache should be holding a copy of it.
 */
const DOCUMENT_CACHE_CONTROL = 'private, max-age=31536000, immutable'

function isSupportedMimeType(value: string): value is GatePassDocumentMimeType {
  return value in EXTENSIONS
}

/**
 * The bytes have to agree with the declared type. Multer trusts the Content-Type
 * the client sent, which is a claim and not a fact — and an executable renamed
 * to .pdf would otherwise be stored and later handed back with a PDF header.
 *
 * For images, sharp decoding the buffer *is* the proof. For PDFs there is no
 * decoder here, so the file signature is checked directly.
 */
function assertPdfSignature(buffer: Buffer): void {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AppError(400, 'That file is not a readable PDF. Choose a different file.')
  }
}

interface NormalizedImage {
  buffer: Buffer
  mimeType: GatePassDocumentMimeType
}

/**
 * Prepares a scanned image for storage without degrading it.
 *
 * This is the opposite of what profile.storage.ts does to an avatar, and
 * deliberately so: a gate pass is a legal record that somebody has to be able
 * to read a vehicle number off, so it is never cropped, never squared, and
 * never re-encoded unless there is a reason.
 *
 * There are exactly two reasons. An EXIF orientation tag has to be applied and
 * dropped, or the document is stored sideways for every viewer that ignores
 * the tag; and an image far beyond scanning resolution is scaled back to
 * MAX_IMAGE_EDGE. When neither applies, the original bytes are stored
 * untouched.
 */
async function normalizeImage(
  buffer: Buffer,
  mimeType: GatePassDocumentMimeType,
): Promise<NormalizedImage> {
  let metadata: sharp.Metadata

  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[gate-pass] rejected an unreadable image: ${message}`)
    // The mime type said image and the bytes disagreed. The client's problem.
    throw new AppError(400, 'That image could not be read. Choose a different file.')
  }

  const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0)
  const needsRotation = (metadata.orientation ?? 1) !== 1
  const needsResize = longestEdge > MAX_IMAGE_EDGE

  if (!needsRotation && !needsResize) {
    return { buffer, mimeType }
  }

  const pipeline = sharp(buffer, { failOn: 'error' }).rotate()

  if (needsResize) {
    pipeline.resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, { fit: 'inside', withoutEnlargement: true })
  }

  /**
   * The output format matches the input. Converting everything to one format
   * would be tidier and wrong: a PNG scan is often a bi-level page where JPEG
   * would smear the text, and re-encoding a JPEG as PNG would multiply its
   * size for no gain.
   */
  const encoded =
    mimeType === 'image/png'
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : mimeType === 'image/webp'
        ? await pipeline.webp({ quality: 90 }).toBuffer()
        : await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer()

  return { buffer: encoded, mimeType }
}

/**
 * The object key. Dated folders keep the bucket browsable a year from now, the
 * gate pass id groups a record's documents together, and the filename itself
 * is random.
 *
 * Nothing the user controls reaches the key. An operator-supplied filename in
 * an object key is a path-traversal and overwrite problem waiting to happen,
 * and a predictable key would make one gate pass guessable from another.
 */
export function buildDocumentKey(
  prefix: string,
  gatePassId: string,
  tripDate: Date,
  extension: string,
): string {
  const year = tripDate.getUTCFullYear()
  const month = String(tripDate.getUTCMonth() + 1).padStart(2, '0')
  const day = String(tripDate.getUTCDate()).padStart(2, '0')

  return `${prefix}/${year}/${month}/${day}/${gatePassId}/${randomUUID()}.${extension}`
}

/**
 * The original filename, reduced to something safe to store and display. It is
 * metadata only — it never becomes part of a key — but it is still rendered in
 * the UI, so control characters and path separators have no business in it.
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
 * Validates, normalises and stores one scanned gate pass.
 *
 * Size is checked here as well as in the multipart parser, because the parser
 * enforces one ceiling for everything and the two formats have different
 * limits: a 20 MB "image" is refused even though the parser would have let it
 * through on the PDF allowance.
 */
export async function uploadGatePassDocument(
  input: UploadDocumentInput,
): Promise<StoredDocument> {
  // Before decoding anything: an unconfigured deployment should answer 503
  // rather than spend a cold instance's CPU on a file it cannot store.
  const { gatePassKeyPrefix } = requireStorage()

  if (!isSupportedMimeType(input.mimeType)) {
    throw new AppError(400, 'Unsupported document type. Use PDF, JPG, PNG or WEBP.')
  }

  if (input.buffer.length === 0) {
    throw new AppError(400, 'That file is empty. Choose a different file.')
  }

  const limit = maxBytesFor(input.mimeType)
  if (input.buffer.length > limit) {
    const megabytes = Math.round(limit / (1024 * 1024))
    throw new AppError(
      413,
      input.mimeType === 'application/pdf'
        ? `That PDF is larger than ${megabytes} MB.`
        : `That image is larger than ${megabytes} MB. Scan it as a PDF, or at a lower resolution.`,
    )
  }

  let body = input.buffer
  const mimeType = input.mimeType

  if (mimeType === 'application/pdf') {
    assertPdfSignature(body)
  } else {
    const normalized = await normalizeImage(body, mimeType)
    body = normalized.buffer
  }

  const key = buildDocumentKey(gatePassKeyPrefix, input.gatePassId, input.tripDate, EXTENSIONS[mimeType])

  await putObject({
    key,
    body,
    contentType: mimeType,
    cacheControl: DOCUMENT_CACHE_CONTROL,
  })

  return {
    key,
    mimeType,
    size: body.length,
    originalName: safeOriginalName(input.originalName),
    uploadedAt: new Date(),
    // A PDF's page count is only trustworthy when the producer reported it.
    pageCount: input.pageCount && input.pageCount > 0 ? Math.trunc(input.pageCount) : null,
  }
}

/**
 * Removes an object nothing references any more. Safe to call with null, and
 * never throws — every caller has already replaced or cleared the reference in
 * MongoDB, so a failure here leaves an orphan in the bucket rather than a gate
 * pass pointing at a document that no longer exists.
 */
export async function discardGatePassDocument(key: string | null | undefined): Promise<void> {
  if (!key) {
    return
  }
  await deleteObject(key)
}
