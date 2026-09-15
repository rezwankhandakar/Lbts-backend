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
  /** Delivery: every challan on every matching trip. */
  totalChallans?: number
  /** Delivery: every trip rent and every labour bill on the matching trips. */
  totalRent?: number
  totalLabour?: number
  /** Delivery: matching trips whose rent / labour bill has not been entered. */
  blankRent?: number
  blankLabour?: number
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
  /** Challan: filed and on no trip, and split with something still to go. */
  notDispatched?: number
  partlyDispatched?: number
  /** Challan: came back off a trip and not out again. */
  returnedAtDepot?: number
  /** Trip DO: matching rows with and without a gate pass, in rows and pieces. */
  linkedRows?: number
  unlinkedRows?: number
  linkedQty?: number
  unlinkedQty?: number
  /** Gate Pass: pieces the linked challans say were delivered, and the rest. */
  deliveredQty?: number
  notDeliveredQty?: number
  /** Trip DO: matching rows that are a return, and that are a re-send. */
  returnRows?: number
  resentRows?: number
  /** Bills: matching bills still being prepared, and signed off. */
  draftBills?: number
  finalizedBills?: number
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
