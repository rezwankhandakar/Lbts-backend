import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { deleteObject, putObject, requireStorage } from '../../config/r2'
import { AppError } from '../../utils/app-error'
import { maxReceivedCopyBytesFor } from './delivery.constants'
import type { ReceivedCopyMimeType } from './delivery.constants'

/**
 * The one thing this module writes to Cloudflare R2: the receiver's signed
 * challan copy.
 *
 * It is the evidence a delivery actually happened, so it gets the treatment a
 * gate pass scan gets rather than the treatment an avatar gets — never cropped,
 * never squared, and never re-encoded unless there is a reason. Somebody has to
 * be able to read a signature and a date off it a year from now.
 *
 * Private, and streamed by the API. A signed challan carries the customer's
 * address, their phone number and their signature, so the bucket never serves
 * it: MongoDB holds the key, and
 * `GET /deliveries/:id/challans/:challanId/received-copy` re-checks
 * authentication and role before a byte moves.
 */

const EXTENSIONS: Record<ReceivedCopyMimeType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * A scan at 300 dpi is 2480 x 3508 for A4, so nothing produced on the office
 * scanner is touched by this. It exists for the phone-camera outlier — a
 * driver photographing a signed sheet at the gate — where the extra pixels cost
 * bandwidth on both sides and add nothing a reader can use.
 */
const MAX_IMAGE_EDGE = 4000

/**
 * `private` rather than `public`: this object is served through the
 * authenticated API, and no shared cache should be holding a copy of it.
 * Immutable is still safe because every upload lands on a fresh key.
 */
const RECEIPT_CACHE_CONTROL = 'private, max-age=31536000, immutable'

export interface StoredReceivedCopy {
  key: string
  mimeType: ReceivedCopyMimeType
  size: number
  originalName: string
  pageCount: number | null
  uploadedAt: Date
}

export interface UploadReceivedCopyInput {
  tripId: string
  challanId: string
  /** The trip's calendar day, which is what the key is filed under. */
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

function isSupportedMimeType(value: string): value is ReceivedCopyMimeType {
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
 * Applies an EXIF orientation tag and scales back anything far beyond scanning
 * resolution. Those are the only two reasons to touch a signed copy; when
 * neither applies the original bytes are stored untouched, for the reason
 * `gate-pass.storage.ts` gives at length.
 */
async function normalizeScan(
  buffer: Buffer,
  mimeType: ReceivedCopyMimeType,
): Promise<Buffer> {
  let metadata: sharp.Metadata

  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[delivery] rejected an unreadable signed copy: ${message}`)
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
   * would smear a signature.
   */
  if (mimeType === 'image/png') {
    return pipeline.png({ compressionLevel: 9 }).toBuffer()
  }
  if (mimeType === 'image/webp') {
    return pipeline.webp({ quality: 90 }).toBuffer()
  }
  return pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
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
  return (cleaned.length > 0 ? cleaned : 'received-copy').slice(0, 200)
}

/**
 * The object key. Dated folders keep the bucket browsable a year from now, and
 * the trip and challan ids group a delivery's evidence where somebody would
 * look for it. The filename itself is random: nothing the user controls reaches
 * a key, because a user-supplied filename there is a path-traversal and
 * overwrite problem waiting to happen.
 *
 * Every upload lands on a fresh key, which is what makes `immutable` safe and
 * what lets a replacement be written before the old object is deleted.
 */
export function buildReceivedCopyKey(
  prefix: string,
  tripId: string,
  challanId: string,
  tripDate: Date,
  extension: string,
): string {
  const year = tripDate.getUTCFullYear()
  const month = String(tripDate.getUTCMonth() + 1).padStart(2, '0')

  return `${prefix}/${year}/${month}/${tripId}/${challanId}/${randomUUID()}.${extension}`
}

/**
 * Validates, normalises and stores one signed challan copy.
 *
 * Size is checked here as well as in the multipart parser, because the parser
 * enforces one ceiling for everything and the two formats have different
 * limits: a 20 MB "image" gets through the parser on the PDF allowance and is
 * refused here.
 */
export async function uploadReceivedCopy(
  input: UploadReceivedCopyInput,
): Promise<StoredReceivedCopy> {
  // Before decoding anything: an unconfigured deployment should answer 503
  // rather than spend a cold instance's CPU on a file it cannot store.
  const { deliveryKeyPrefix } = requireStorage()

  if (!isSupportedMimeType(input.mimeType)) {
    throw new AppError(400, 'Unsupported document type. Use PDF, JPG, PNG or WEBP.')
  }

  if (input.buffer.length === 0) {
    throw new AppError(400, 'That file is empty. Choose a different file.')
  }

  const limit = maxReceivedCopyBytesFor(input.mimeType)
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

  const key = buildReceivedCopyKey(
    deliveryKeyPrefix,
    input.tripId,
    input.challanId,
    input.tripDate,
    EXTENSIONS[mimeType],
  )

  await putObject({ key, body, contentType: mimeType, cacheControl: RECEIPT_CACHE_CONTROL })

  return {
    key,
    mimeType,
    size: body.length,
    originalName: safeOriginalName(input.originalName),
    pageCount: input.pageCount,
    uploadedAt: new Date(),
  }
}

/**
 * Removes a signed copy's object.
 *
 * Never throws, and every caller has already cleared the reference in MongoDB
 * before reaching here — the order every storage path in this codebase keeps,
 * so the worst outcome of a failure is an orphan in the bucket rather than a
 * record pointing at a file that is gone.
 */
export async function deleteReceivedCopy(key: string): Promise<void> {
  await deleteObject(key)
}
