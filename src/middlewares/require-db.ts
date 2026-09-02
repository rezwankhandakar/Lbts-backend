import type { NextFunction, Request, Response } from 'express'
import { isDatabaseConnected } from '../config/db'
import { AppError } from '../utils/app-error'

/**
 * Guards routes that touch MongoDB. The HTTP server starts before the database
 * connects, so without this a request arriving during an outage would fail
 * deep in Mongoose (bufferCommands is off) with an opaque error. This turns it
 * into an honest 503.
 *
 * Deliberately NOT applied to /health, which must stay 200 while the process
 * is alive.
 */
export function requireDb(_req: Request, _res: Response, next: NextFunction): void {
  if (!isDatabaseConnected()) {
    next(new AppError(503, 'Database unavailable. Please try again shortly.'))
    return
  }
  next()
}
