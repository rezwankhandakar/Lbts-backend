import multer from 'multer'
import { MulterError } from 'multer'
import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../utils/app-error'

/** Formats a browser can render everywhere, and Cloudinary can transform. */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/**
 * 5 MB. Large enough for a photo straight off a phone, small enough that a
 * cold Render instance is not asked to hold much in memory at once — and the
 * stored asset is resized to 512px regardless of what arrives.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const ALLOWED_IMAGE_EXTENSIONS = 'JPG, PNG or WEBP'

/**
 * Memory storage, deliberately: the buffer goes straight to Cloudinary and
 * nothing is ever written to disk. Render's filesystem is ephemeral, and a
 * temporary file is one more thing that can be left behind.
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
