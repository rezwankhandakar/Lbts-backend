import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import {
  ActiveAssignmentError,
  createAssignment,
  endAssignment,
  listAssignments,
  listDriverAssignments,
  listVehicleAssignments,
  removeAssignment,
} from './assignment.service'
import {
  changeDriverStatus,
  clearDriverPhoto,
  createDriver,
  getDriver,
  listAssignableDrivers,
  listDrivers,
  removeDriver,
  setDriverPhoto,
  updateDriver,
} from './driver.service'
import {
  createDocument,
  getDocument,
  listDocuments,
  listOwnerDocuments,
  readDocumentFile,
  removeDocument,
  updateDocument,
} from './document.service'
import { getVendorStats, getVendorSummary } from './summary.service'
import {
  changeVehicleStatus,
  createVehicle,
  getVehicle,
  listAssignableVehicles,
  listVehicles,
  removeVehicle,
  updateVehicle,
} from './vehicle.service'
import { listActivity } from './vendor.activity'
import { ownVendorIdOf } from './vendor.access'
import {
  changeVendorStatus,
  clearVendorPhoto,
  createVendor,
  getVendor,
  listVendorOptions,
  listVendors,
  removeVendor,
  setVendorPhoto,
  updateVendor,
} from './vendor.service'
import type {
  ActivityQuery,
  CreateAssignmentInput,
  CreateDocumentInput,
  CreateDriverInput,
  CreateVehicleInput,
  CreateVendorInput,
  DriverStatusInput,
  EndAssignmentInput,
  ListAssignmentsQuery,
  ListDocumentsQuery,
  ListDriversQuery,
  ListVehiclesQuery,
  ListVendorsQuery,
  UpdateDocumentInput,
  UpdateDriverInput,
  UpdateVehicleInput,
  UpdateVendorInput,
  VehicleStatusInput,
  VendorOptionsQuery,
  VendorStatusInput,
} from './vendor.validation'

/**
 * The authenticated profile. Every handler here runs behind requireDb, auth and
 * requireRole, so it is always present; reading it through one helper keeps
 * that guarantee in a single place rather than a non-null assertion in each
 * handler — and it stays honest if the route stack is ever changed.
 */
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

/** The paging half of a list envelope, computed the same way everywhere. */
function metaFor(query: { page: number; limit: number }, total: number) {
  return {
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  }
}

// --- Vendor ----------------------------------------------------------------

export async function getVendors(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListVendorsQuery
  const { records, total } = await listVendors(query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Vendors retrieved',
    data: records,
    meta: metaFor(query, total),
  })
}

export async function getStats(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor statistics retrieved',
    data: await getVendorStats(actorFrom(req)),
  })
}

export async function getOptions(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as VendorOptionsQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Vendors retrieved',
    data: await listVendorOptions(query, actorFrom(req)),
  })
}

/**
 * The caller's own vendor.
 *
 * The one endpoint in the module that takes no id at all — which is the point.
 * A Vendor account never has to know its own vendor id, and never sends one, so
 * there is nothing for it to tamper with: the answer is read from the profile
 * the auth middleware loaded out of MongoDB.
 */
export async function getMyVendor(req: Request, res: Response): Promise<void> {
  const actor = actorFrom(req)

  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor retrieved',
    data: await getVendor(ownVendorIdOf(actor), actor),
  })
}

export async function getOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor retrieved',
    data: await getVendor(idFrom(req), actorFrom(req)),
  })
}

export async function getSummary(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor overview retrieved',
    data: await getVendorSummary(idFrom(req), actorFrom(req)),
  })
}

export async function getActivity(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ActivityQuery
  const actor = actorFrom(req)
  const id = idFrom(req)

  // Scope first: the activity log is not a back door into a vendor whose
  // records the caller may not read.
  await getVendor(id, actor)

  sendResponse(res, {
    statusCode: 200,
    message: 'Activity retrieved',
    data: await listActivity(id, query.limit),
  })
}

export async function postVendor(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateVendorInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Vendor added',
    data: await createVendor(input, actorFrom(req)),
  })
}

export async function patchVendor(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateVendorInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor updated',
    data: await updateVendor(idFrom(req), input, actorFrom(req)),
  })
}

export async function patchVendorStatus(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as VendorStatusInput

  sendResponse(res, {
    statusCode: 200,
    message: `Vendor ${input.status.toLowerCase()}`,
    data: await changeVendorStatus(idFrom(req), input, actorFrom(req)),
  })
}

export async function postVendorPhoto(req: Request, res: Response): Promise<void> {
  const file = req.file
  if (!file) {
    throw new AppError(400, 'Choose an image to upload.')
  }

  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor photo updated',
    data: await setVendorPhoto(idFrom(req), file.buffer, actorFrom(req)),
  })
}

export async function deleteVendorPhoto(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor photo removed',
    data: await clearVendorPhoto(idFrom(req), actorFrom(req)),
  })
}

/**
 * Removing a vendor.
 *
 * Answers 200 either way and says which of the two things happened — a vendor
 * with records behind it is deactivated rather than deleted, and calling that
 * an error would be wrong: the request was honoured, and the caller needs to
 * know the history was kept. The same shape the Location module's delete uses.
 */
export async function deleteVendor(req: Request, res: Response): Promise<void> {
  const result = await removeVendor(idFrom(req), actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: result.deactivated
      ? 'Deactivated instead of deleted: vehicles, drivers, assignments or user accounts still reference this vendor.'
      : 'Vendor deleted',
    data: result,
  })
}

// --- Vehicles --------------------------------------------------------------

export async function getVehicles(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListVehiclesQuery
  const { records, total } = await listVehicles(idFrom(req), query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Vehicles retrieved',
    data: records,
    meta: metaFor(query, total),
  })
}

export async function getAssignableVehicles(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vehicles retrieved',
    data: await listAssignableVehicles(idFrom(req), actorFrom(req)),
  })
}

export async function postVehicle(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateVehicleInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Vehicle added',
    data: await createVehicle(idFrom(req), input, actorFrom(req)),
  })
}

export async function getVehicleOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vehicle retrieved',
    data: await getVehicle(idFrom(req), actorFrom(req)),
  })
}

export async function patchVehicle(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateVehicleInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Vehicle updated',
    data: await updateVehicle(idFrom(req), input, actorFrom(req)),
  })
}

export async function patchVehicleStatus(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as VehicleStatusInput

  sendResponse(res, {
    statusCode: 200,
    message: `Vehicle marked ${input.status}`,
    data: await changeVehicleStatus(idFrom(req), input, actorFrom(req)),
  })
}

export async function deleteVehicle(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vehicle deleted',
    data: await removeVehicle(idFrom(req), actorFrom(req)),
  })
}

export async function getVehicleHistory(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Assignment history retrieved',
    data: await listVehicleAssignments(idFrom(req), actorFrom(req)),
  })
}

export async function getVehicleDocuments(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Documents retrieved',
    data: await listOwnerDocuments('Vehicle', idFrom(req), actorFrom(req)),
  })
}

// --- Drivers ---------------------------------------------------------------

export async function getDrivers(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListDriversQuery
  const { records, total } = await listDrivers(idFrom(req), query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Drivers retrieved',
    data: records,
    meta: metaFor(query, total),
  })
}

export async function getAssignableDrivers(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Drivers retrieved',
    data: await listAssignableDrivers(idFrom(req), actorFrom(req)),
  })
}

export async function postDriver(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateDriverInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Driver added',
    data: await createDriver(idFrom(req), input, actorFrom(req)),
  })
}

export async function getDriverOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Driver retrieved',
    data: await getDriver(idFrom(req), actorFrom(req)),
  })
}

export async function patchDriver(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateDriverInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Driver updated',
    data: await updateDriver(idFrom(req), input, actorFrom(req)),
  })
}

export async function patchDriverStatus(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as DriverStatusInput

  sendResponse(res, {
    statusCode: 200,
    message: `Driver marked ${input.status}`,
    data: await changeDriverStatus(idFrom(req), input, actorFrom(req)),
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
    data: await setDriverPhoto(idFrom(req), file.buffer, actorFrom(req)),
  })
}

export async function deleteDriverPhoto(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Driver photo removed',
    data: await clearDriverPhoto(idFrom(req), actorFrom(req)),
  })
}

export async function deleteDriver(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Driver deleted',
    data: await removeDriver(idFrom(req), actorFrom(req)),
  })
}

export async function getDriverHistory(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Assignment history retrieved',
    data: await listDriverAssignments(idFrom(req), actorFrom(req)),
  })
}

export async function getDriverDocuments(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Documents retrieved',
    data: await listOwnerDocuments('Driver', idFrom(req), actorFrom(req)),
  })
}

// --- Assignments -----------------------------------------------------------

export async function getAssignments(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListAssignmentsQuery
  const { records, total } = await listAssignments(idFrom(req), query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Assignments retrieved',
    data: records,
    meta: metaFor(query, total),
  })
}

/**
 * Creating one.
 *
 * The only handler in the module with a second success-shaped failure: a
 * request that would displace a live assignment without saying so is answered
 * 409 with the assignment it would have closed, so the client can explain what
 * is about to happen and ask again with `replaceActive`. The same shape Gate
 * Pass uses for a possible duplicate, and for the same reason — it is a
 * question rather than a fault, and the feature that asked it needs the record
 * to render the question.
 */
export async function postAssignment(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateAssignmentInput

  try {
    sendResponse(res, {
      statusCode: 201,
      message: 'Driver assigned',
      data: await createAssignment(idFrom(req), input, actorFrom(req)),
    })
  } catch (error) {
    if (!(error instanceof ActiveAssignmentError)) {
      throw error
    }

    res.status(error.statusCode).json({
      success: false,
      message: error.message,
      errorSources: [{ path: 'driverId', message: error.message }],
      current: error.current,
    })
  }
}

export async function patchAssignmentEnd(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as EndAssignmentInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Assignment ended',
    data: await endAssignment(idFrom(req), input, actorFrom(req)),
  })
}

export async function deleteAssignment(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Assignment record removed',
    data: await removeAssignment(idFrom(req), actorFrom(req)),
  })
}

// --- Documents -------------------------------------------------------------

export async function getDocuments(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListDocumentsQuery
  const { records, total } = await listDocuments(idFrom(req), query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Documents retrieved',
    data: records,
    meta: metaFor(query, total),
  })
}

export async function getDocumentOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Document retrieved',
    data: await getDocument(idFrom(req), actorFrom(req)),
  })
}

/**
 * The file that arrived beside the form fields, or null.
 *
 * Optional by design: a document row may be created with its number and dates
 * and no attachment yet, because the expiry date is what raises the compliance
 * alert and waiting for somebody to find the scanner is how a lapsed
 * certificate goes unnoticed.
 */
function fileFrom(req: Request) {
  return req.file
    ? {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
      }
    : null
}

export async function postVehicleDocument(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateDocumentInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Document filed',
    data: await createDocument('Vehicle', idFrom(req), input, fileFrom(req), actorFrom(req)),
  })
}

export async function postDriverDocument(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateDocumentInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Document filed',
    data: await createDocument('Driver', idFrom(req), input, fileFrom(req), actorFrom(req)),
  })
}

export async function patchDocument(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateDocumentInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Document updated',
    data: await updateDocument(idFrom(req), input, fileFrom(req), actorFrom(req)),
  })
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Document removed',
    data: await removeDocument(idFrom(req), actorFrom(req)),
  })
}

/**
 * Streams a document's file.
 *
 * One of the two endpoints in the API that does not answer with the standard
 * JSON envelope, because the body is the file. `inline` rather than
 * `attachment`: the client fetches this into a blob for its viewer, and a
 * browser that ever opens the URL directly should render the page rather than
 * download it.
 *
 * Errors thrown before the first byte still reach the global handler as JSON.
 * Once bytes are flowing there is no way back to a JSON error, so a mid-stream
 * failure destroys the response instead of appending an error into the file.
 */
export async function getDocumentFile(req: Request, res: Response): Promise<void> {
  const download = await readDocumentFile(idFrom(req), actorFrom(req))

  res.setHeader('Content-Type', download.mimeType)
  res.setHeader('Content-Disposition', `inline; filename="${download.filename}"`)
  // The record is behind authentication, so no shared cache may keep a copy.
  res.setHeader('Cache-Control', 'private, no-store')
  if (download.contentLength !== undefined) {
    res.setHeader('Content-Length', String(download.contentLength))
  }

  try {
    await pipeline(download.body, res)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[vendor] document stream failed: ${message}`)
    res.destroy()
  }
}
