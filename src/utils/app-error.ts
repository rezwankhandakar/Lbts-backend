/**
 * Error carrying an HTTP status. Anything thrown that is not an AppError is
 * treated as unexpected by the global handler and reported as a 500.
 */
export class AppError extends Error {
  public readonly statusCode: number
  public readonly isOperational: boolean

  constructor(statusCode: number, message: string, stack = '') {
    super(message)
    this.statusCode = statusCode
    this.isOperational = true

    if (stack) {
      this.stack = stack
    } else {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}
