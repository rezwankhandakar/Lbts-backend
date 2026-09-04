import multer from 'multer'
import { MulterError } from 'multer'
import type { NextFunction, Request, Response } from 'express'
import {
  GATE_PASS_DOCUMENT_MIME_TYPES,
  MAX_GATE_PASS_DOCUMENT_BYTES,
} from '../modules/gate-pass/gate-pass.constants'
import { AppError } from '../utils/app-error'

/** Formats a browser can render everywhere, and sharp can decode. */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/**
 * 5 MB. Large enough for a photo straight off a phone, small enough that a
 * cold Render instance is not asked to hold much in memory at once — and the
 * stored asset is resized to 512px regardless of what arrives.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const ALLOWED_IMAGE_EXTENSIONS = 'JPG, PNG or WEBP'

/**
 * Memory storage, deliberately: the buffer is resized in process and pushed
 * straight to Cloudflare R2, and nothing is ever written to disk. Render's
 * filesystem is ephemeral, and a temporary file is one more thing that can be
 * left behind.
 *
 * Both limits are enforced here rather than in the handler, so a malicious
 * upload is rejected while it is still streaming.
 */
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 4 },
  fileFilter(_req, file, callback) {
    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      callback(new AppError(400, `Unsupported image type. Use ${ALLOWED_IMAGE_EXTENSIONS}.`))
      return
    }
    callback(null, true)
  },
}).single('photo')

/** Multer's own failures are internal codes; these are what a user should read. */
function translate(error: MulterError): AppError {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return new AppError(413, 'That image is larger than 5 MB. Choose a smaller file.')
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return new AppError(400, 'Send exactly one image, in a field named "photo".')
    default:
      return new AppError(400, 'The upload could not be read. Please try again.')
  }
}

/**
 * Wraps the multer middleware so a rejected upload arrives at the global error
 * handler as an AppError with a real status, rather than as an unknown 500.
 */
export function uploadProfilePhoto(req: Request, res: Response, next: NextFunction): void {
  uploadImage(req, res, (error: unknown) => {
    if (error instanceof MulterError) {
      next(translate(error))
      return
    }
    if (error) {
      next(error)
      return
    }
    next()
  })
}

/**
 * A scanned gate pass. Same memory-only storage and the same reasoning, but a
 * different contract: PDFs are accepted, and the ceiling is the higher of the
 * module's two limits rather than the avatar's 5 MB.
 *
 * The parser can only enforce one size for everything, so this is the PDF
 * allowance. The tighter image limit is applied in gate-pass.storage.ts, once
 * the real type is known — a 20 MB "image" gets through here and is refused
 * there.
 */
const uploadScan = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_GATE_PASS_DOCUMENT_BYTES, files: 1, fields: 4 },
  fileFilter(_req, file, callback) {
    if (!(GATE_PASS_DOCUMENT_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      callback(new AppError(400, 'Unsupported document type. Use PDF, JPG, PNG or WEBP.'))
      return
    }
    callback(null, true)
  },
}).single('document')

function translateScan(error: MulterError): AppError {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return new AppError(413, 'That document is larger than 25 MB. Scan it at a lower resolution.')
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return new AppError(400, 'Send exactly one file, in a field named "document".')
    default:
      return new AppError(400, 'The upload could not be read. Please try again.')
  }
}

export function uploadGatePassScan(req: Request, res: Response, next: NextFunction): void {
  uploadScan(req, res, (error: unknown) => {
    if (error instanceof MulterError) {
      next(translateScan(error))
      return
    }
    if (error) {
      next(error)
      return
    }
    next()
  })
}
