import type { Response } from 'express'

export interface ResponseMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  /**
   * A total the list is itself about, summed over every matching record rather
   * than the page on screen — Gate Pass sends the quantity carried by the
   * filtered set. Optional, because most lists count rows and nothing else.
   */
  totalQty?: number
  /**
   * The same idea for money: every charge on every matching record. Challan
   * sends it beside the quantity, and `unpricedChallans` beside that — a
   * charge total that silently omits the records nothing could price is a
   * figure somebody would put in a report, so how much is missing from it
   * travels with it rather than being left to be worked out.
   */
  totalAmount?: number
  unpricedChallans?: number
  /**
   * Backlog counts a list draws as chips beside its totals — how many of the
   * matching records still want somebody's attention, and for what. Challan
   * sends four; every one of them is also a filter, so a chip is a way in
   * rather than a number to look at.
   */
  blankAmount?: number
  partialAmount?: number
  locationPending?: number
  locationReview?: number
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
