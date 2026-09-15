import type { Request, Response } from 'express'
import { getObjectStream } from '../../config/r2'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import {
  attachReceivedCopy,
  clearCopyMissing,
  clearReceivedCopy,
  findDeliveryByScan,
  findReceivedCopy,
  markCopyMissing,
  recordCompletion,
} from './delivery.completion'
import { recordTripBill } from './delivery.bill'
import {
  buildCandidates,
  findByScan,
  findChallansByIds,
  searchChallans,
  searchVehicles,
} from './delivery.lookups'
import {
  TripOverageError,
  createDriverForTrip,
  createTrip,
  getChallanDispatch,
  getTrip,
  getTripStats,
  getVehicleOption,
  listTrips,
  removeTrip,
  setTripDriverPhoto,
  updateTrip,
} from './delivery.service'
import type {
  ChallanCandidatesQuery,
  ChallanScanQuery,
  CompletionInput,
  CopyMissingInput,
  CreateTripInput,
  ListTripsQuery,
  QuickDriverInput,
  ReceiptScanQuery,
  ReceivedCopyBody,
  StatsQuery,
  TripBillInput,
  TripChallanParams,
  UpdateTripInput,
  VehicleSearchQuery,
} from './delivery.validation'

function actorFrom(req: Request): UserDocument {
  if (!req.user) {
    throw new AppError(403, 'Profile not found. Sync the account first.')
  }
  return req.user
}

function idFrom(req: Request): string {
  const params = req.validated?.params as { id: string } | undefined
  if (!params) {
    throw new AppError(400, 'Invalid id.')
  }
  return params.id
}

/** A trip and one challan on it — what every completion endpoint is addressed by. */
function targetFrom(req: Request): TripChallanParams {
  const params = req.validated?.params as TripChallanParams | undefined
  if (!params) {
    throw new AppError(400, 'Invalid id.')
  }
  return params
}

/**
 * The over-allocation question, answered in the shape every "question rather
 * than a fault" in this API takes: a 409 carrying the records the client needs
 * to ask it, and a second request carrying the answer.
 */
function sendOverage(res: Response, error: TripOverageError): void {
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errorSources: [{ path: 'challans', message: error.message }],
    overages: error.overages,
  })
}

// --- Trips -----------------------------------------------------------------

export async function getTrips(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListTripsQuery
  const { records, total, totalQty, totalChallans, totalRent, totalLabour, blankRent, blankLabour } =
    await listTrips(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Trips retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
      totalQty,
      totalChallans,
      totalRent,
      totalLabour,
      blankRent,
      blankLabour,
    },
  })
}

export async function getStats(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as StatsQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Trip statistics retrieved',
    data: await getTripStats(query.today),
  })
}

/**
 * How much of one challan has gone out, and on which trips. Read by the
 * challan's own page, which is why it is addressed by challan rather than by
 * trip.
 */
export async function getChallanDispatchOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Challan dispatch retrieved',
    data: await getChallanDispatch(idFrom(req)),
  })
}

export async function getTripOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Trip retrieved',
    data: await getTrip(idFrom(req)),
  })
}

/**
 * Confirming a trip. `201` for a new one, `200` for a replay of a
 * confirmation that already succeeded — so a retried press looks like the
 * success it actually was, the same way Challan answers a replayed submission.
 */
export async function postTrip(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateTripInput

  try {
    const { record, replayed } = await createTrip(input, actorFrom(req))
    sendResponse(res, {
      statusCode: replayed ? 200 : 201,
      message: replayed ? 'Trip already created' : 'Trip created',
      data: record,
    })
  } catch (error) {
    if (!(error instanceof TripOverageError)) {
      throw error
    }
    sendOverage(res, error)
  }
}

export async function patchTrip(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateTripInput

  try {
    sendResponse(res, {
      statusCode: 200,
      message: 'Trip updated',
      data: await updateTrip(idFrom(req), input, actorFrom(req)),
    })
  } catch (error) {
    if (!(error instanceof TripOverageError)) {
      throw error
    }
    sendOverage(res, error)
  }
}

// --- Completing a delivery -------------------------------------------------

/**
 * What came back, how far up it went, and what that cost.
 *
 * Deliberately not the same call as the signed copy below. This is what
 * somebody types while looking at the returned goods; that is what a scanner
 * produces, and it is the one that completes the delivery.
 */
export async function patchCompletion(req: Request, res: Response): Promise<void> {
  const { id, challanId } = targetFrom(req)
  const input = req.validated?.body as CompletionInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Delivery updated',
    data: await recordCompletion(id, challanId, input, actorFrom(req)),
  })
}

export async function postReceivedCopy(req: Request, res: Response): Promise<void> {
  const file = req.file
  if (!file) {
    throw new AppError(400, 'Choose or scan the signed challan copy to upload.')
  }

  const { id, challanId } = targetFrom(req)
  const body = (req.validated?.body ?? { pageCount: null }) as ReceivedCopyBody

  sendResponse(res, {
    statusCode: 200,
    message: 'Delivery completed',
    data: await attachReceivedCopy(id, challanId, file, body.pageCount ?? null, actorFrom(req)),
  })
}

export async function deleteReceivedCopyFile(req: Request, res: Response): Promise<void> {
  const { id, challanId } = targetFrom(req)

  sendResponse(res, {
    statusCode: 200,
    message: 'Signed copy removed',
    data: await clearReceivedCopy(id, challanId, actorFrom(req)),
  })
}

export async function patchTripBill(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as TripBillInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Trip bill saved',
    data: await recordTripBill(idFrom(req), input, actorFrom(req)),
  })
}

export async function putCopyMissing(req: Request, res: Response): Promise<void> {
  const { id, challanId } = targetFrom(req)
  const input = req.validated?.body as CopyMissingInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Delivery completed without a signed copy',
    data: await markCopyMissing(id, challanId, input.reason, actorFrom(req)),
  })
}

export async function deleteCopyMissing(req: Request, res: Response): Promise<void> {
  const { id, challanId } = targetFrom(req)

  sendResponse(res, {
    statusCode: 200,
    message: 'Missing-copy mark withdrawn',
    data: await clearCopyMissing(id, challanId, actorFrom(req)),
  })
}

/**
 * Streams the signed copy.
 *
 * The bucket never serves this object — a signed challan carries a customer's
 * address, their phone number and a signature — so the route re-checks
 * authentication and role and pipes the bytes itself, exactly as a gate pass
 * scan and a vendor document do.
 */
export async function getReceivedCopyFile(req: Request, res: Response): Promise<void> {
  const { id, challanId } = targetFrom(req)
  const ref = await findReceivedCopy(id, challanId)
  const object = await getObjectStream(ref.key)

  res.setHeader('Content-Type', object.contentType ?? ref.mimeType)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${ref.originalName.replace(/"/g, '')}"`,
  )
  if (object.contentLength !== undefined) {
    res.setHeader('Content-Length', String(object.contentLength))
  }

  object.body.on('error', () => res.destroy())
  object.body.pipe(res)
}

/**
 * One barcode read on the deliveries page: which delivery is this signed copy
 * the receipt for?
 *
 * The opposite question to `getChallanScan`, which asks what is still to go so
 * a challan can be put on a lorry. Two endpoints rather than one, because a
 * scan that meant different things depending on which page was open is exactly
 * the sort of thing somebody discovers at a gate.
 */
export async function getReceiptScan(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ReceiptScanQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Delivery retrieved',
    data: await findDeliveryByScan(query.code),
  })
}

export async function deleteTrip(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Trip deleted',
    data: await removeTrip(idFrom(req), actorFrom(req)),
  })
}

// --- The workspace's lookups -----------------------------------------------

export async function getVehicleSearch(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as VehicleSearchQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Vehicles retrieved',
    data: await searchVehicles(query.q),
  })
}

export async function getVehicleOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vehicle retrieved',
    data: await getVehicleOption(idFrom(req)),
  })
}

export async function getChallanCandidates(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ChallanCandidatesQuery

  const challans =
    query.ids.length > 0
      ? await findChallansByIds(query.ids)
      : query.q
        ? await searchChallans(query.q)
        : []

  sendResponse(res, {
    statusCode: 200,
    message: 'Challans retrieved',
    data: await buildCandidates(challans, query.excludeTripId),
  })
}

/**
 * One barcode read. A 404 is the ordinary answer to a barcode that is not a
 * challan — a gate pass, a product, a smudge — and the workspace says so
 * beside the scanner rather than as a fault.
 */
export async function getChallanScan(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ChallanScanQuery
  const challan = await findByScan(query.code)

  if (!challan) {
    throw new AppError(404, `No challan carries the barcode ${query.code.trim()}.`)
  }

  const [candidate] = await buildCandidates([challan], query.excludeTripId)

  sendResponse(res, {
    statusCode: 200,
    message: 'Challan retrieved',
    data: candidate,
  })
}

export async function postDriver(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as QuickDriverInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Driver added',
    data: await createDriverForTrip(input, actorFrom(req)),
  })
}

export async function postDriverPhoto(req: Request, res: Response): Promise<void> {
  const file = req.file
  if (!file) {
    throw new AppError(400, 'Choose an image to upload.')
  }

  sendResponse(res, {
    statusCode: 200,
    message: 'Driver photo updated',
    data: await setTripDriverPhoto(idFrom(req), file.buffer, actorFrom(req)),
  })
}
