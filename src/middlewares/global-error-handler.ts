import type { NextFunction, Request, Response } from 'express'
import mongoose from 'mongoose'
import { ZodError } from 'zod'
import { config } from '../config/index'
import { AppError } from '../utils/app-error'

export interface ErrorSource {
  path: string
  message: string
}

interface NormalizedError {
  statusCode: number
  message: string
  errorSources: ErrorSource[]
}

interface MongoDuplicateKeyError {
  code: number
  keyValue?: Record<string, unknown>
}

function isDuplicateKeyError(error: unknown): error is MongoDuplicateKeyError {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}

interface FirebaseAuthError {
  code: string
  message: string
}

function isFirebaseAuthError(error: unknown): error is FirebaseAuthError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('auth/')
  )
}

function normalize(error: unknown): NormalizedError {
  // Zod 4: issues live on `err.issues`. `err.errors` was v3 and is gone.
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      message: 'Validation failed.',
      errorSources: error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    }
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return {
      statusCode: 400,
      message: 'Validation failed.',
      errorSources: Object.values(error.errors).map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    }
  }

  if (error instanceof mongoose.Error.CastError) {
    return {
      statusCode: 400,
      message: 'Invalid identifier.',
      errorSources: [{ path: error.path, message: `${String(error.value)} is not a valid value.` }],
    }
  }

  if (isDuplicateKeyError(error)) {
    const field = Object.keys(error.keyValue ?? {})[0] ?? 'field'
    return {
      statusCode: 409,
      message: 'Duplicate value.',
      errorSources: [{ path: field, message: `A record with this ${field} already exists.` }],
    }
  }

  // Firebase Admin rejects bad or expired ID tokens with an auth/* code.
  if (isFirebaseAuthError(error)) {
    const expired = error.code === 'auth/id-token-expired'
    return {
      statusCode: 401,
      message: expired ? 'Session expired. Please sign in again.' : 'Invalid authentication token.',
      errorSources: [{ path: 'token', message: error.message }],
    }
  }

  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
      errorSources: [{ path: '', message: error.message }],
    }
  }

  if (error instanceof Error) {
    /**
     * An unexpected error's message is internal detail — a driver or ODM
     * string that means nothing to a user and can describe the schema. It is
     * logged in full below either way; only development returns it.
     */
    return {
      statusCode: 500,
      message: config.isProduction ? 'Something went wrong.' : error.message,
      errorSources: [
        { path: '', message: config.isProduction ? 'Internal server error.' : error.message },
      ],
    }
  }

  return {
    statusCode: 500,
    message: 'Something went wrong.',
    errorSources: [{ path: '', message: 'An unknown error occurred.' }],
  }
}

/**
 * The single error shape for every failure.
 *
 * The HTTP status is what the frontend's axios interceptor reads
 * (error.response.status), so res.status() must always carry the real code —
 * a statusCode in the body alone would leave the client reading 0.
 */
export function globalErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const { statusCode, message, errorSources } = normalize(error)

  if (statusCode >= 500) {
    console.error('[error]', error)
  }

  res.status(statusCode).json({
    success: false,
    message,
    errorSources,
    // Never leak internals in production.
    ...(config.isProduction ? {} : { stack: error instanceof Error ? error.stack : undefined }),
  })
}
