import type { NextFunction, Request, Response } from 'express'

/**
 * Mounted pathless (app.use(notFound)) rather than on '*'. Express 5 uses
 * path-to-regexp v8, where a bare '*' is invalid and would need to be written
 * '/{*splat}'; mounting without a path avoids the issue entirely.
 */
export function notFound(req: Request, res: Response, _next: NextFunction): void {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    errorSources: [
      {
        path: req.originalUrl,
        message: 'This endpoint does not exist.',
      },
    ],
  })
}
