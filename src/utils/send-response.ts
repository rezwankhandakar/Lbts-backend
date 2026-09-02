import type { Response } from 'express'

export interface ResponseMeta {
  page: number
  limit: number
  total: number
  totalPages: number
}

interface SuccessPayload<T> {
  statusCode: number
  message: string
  data: T
  meta?: ResponseMeta
}

/**
 * The single success shape for every endpoint. `statusCode` is echoed in the
 * body for readability, but the HTTP status is what clients actually read.
 */
export function sendResponse<T>(res: Response, payload: SuccessPayload<T>): void {
  res.status(payload.statusCode).json({
    success: true,
    statusCode: payload.statusCode,
    message: payload.message,
    data: payload.data,
    ...(payload.meta ? { meta: payload.meta } : {}),
  })
}
