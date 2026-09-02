import type { NextFunction, Request, Response } from 'express'
import type { ZodType } from 'zod'

interface RequestSchemas {
  body?: ZodType
  query?: ZodType
  params?: ZodType
}

/**
 * Validates any combination of body, query and params against Zod schemas.
 *
 * Parsed output is attached to req.validated rather than written back onto the
 * request: Express 5 turned req.query into a read-only getter, so assigning to
 * it throws. req.body is still writable and is replaced in place so handlers
 * that read req.body get the coerced values.
 *
 * A ZodError thrown here is caught by the global handler, which maps it to a
 * 400 with per-field errorSources.
 */
export function validateRequest(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const validated: Request['validated'] = {}

    if (schemas.body) {
      const parsedBody = schemas.body.parse(req.body)
      validated.body = parsedBody
      req.body = parsedBody
    }

    if (schemas.query) {
      validated.query = schemas.query.parse(req.query)
    }

    if (schemas.params) {
      validated.params = schemas.params.parse(req.params)
    }

    req.validated = validated
    next()
  }
}
