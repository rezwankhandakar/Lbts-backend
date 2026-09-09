import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { uploadVendorDocumentFile, uploadVendorPhotoFile } from '../../middlewares/upload'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { VENDOR_MANAGE_ROLES, VENDOR_READ_ROLES } from './vendor.constants'
import {
  deleteAssignment,
  deleteDocument,
  deleteDriver,
  deleteDriverPhoto,
  deleteVehicle,
  deleteVendor,
  deleteVendorPhoto,
  getActivity,
  getAssignableDrivers,
  getAssignableVehicles,
  getAssignments,
  getDocumentFile,
  getDocumentOne,
  getDocuments,
  getDriverDocuments,
  getDriverHistory,
  getDriverOne,
  getDrivers,
  getMyVendor,
  getOne,
  getOptions,
  getStats,
  getSummary,
  getVehicleDocuments,
  getVehicleHistory,
  getVehicleOne,
  getVehicles,
  getVendors,
  patchAssignmentEnd,
  patchDocument,
  patchDriver,
  patchDriverStatus,
  patchVehicle,
  patchVehicleStatus,
  patchVendor,
  patchVendorStatus,
  postAssignment,
  postDriver,
  postDriverDocument,
  postDriverPhoto,
  postVehicle,
  postVehicleDocument,
  postVendor,
  postVendorPhoto,
} from './vendor.controller'
import {
  activityQuerySchema,
  createAssignmentSchema,
  createDocumentSchema,
  createDriverSchema,
  createVehicleSchema,
  createVendorSchema,
  driverStatusSchema,
  endAssignmentSchema,
  idParamSchema,
  listAssignmentsQuerySchema,
  listDocumentsQuerySchema,
  listDriversQuerySchema,
  listVehiclesQuerySchema,
  listVendorsQuerySchema,
  updateDocumentSchema,
  updateDriverSchema,
  updateVehicleSchema,
  updateVendorSchema,
  vehicleStatusSchema,
  vendorOptionsQuerySchema,
  vendorStatusSchema,
} from './vendor.validation'

/**
 * The Vendor module's boundary.
 *
 * Five routers rather than one deeply nested tree. `/vendors` owns the vendor
 * itself and the *lists* underneath it — a vehicle only makes sense inside a
 * vendor when you are asking for all of them — while a vehicle, a driver, an
 * assignment and a document each have a stable global id and are reached
 * directly. `/vendors/:vendorId/vehicles/:vehicleId` would carry the vendor
 * twice and invite the second copy to be trusted, which is precisely the thing
 * this module refuses to do.
 *
 * Order is the same as everywhere else in the API. `requireDb` first, because
 * `auth` reads the profile from MongoDB; then `auth`, which verifies the
 * Firebase ID token and loads that profile; then `requireRole`, which reads
 * `role` from the profile rather than from the token, so a role change takes
 * effect on the very next request. `requireRole` already includes
 * `requireActiveAccount`.
 *
 * **The role check is not the whole boundary here, and this is the one module
 * where that matters.** `Vendor` is inside the read set, so `requireRole` lets
 * a vendor account through — and every service function then narrows to the
 * vendor its profile is linked to, via `vendor.access.ts`. A vendor id in a URL
 * is a subject to be checked, never authority. The sidebar and the route guard
 * in the browser are courtesy; this file and that one are what count.
 */

const canRead = requireRole(...(VENDOR_READ_ROLES as UserRole[]))
const canManage = requireRole(...(VENDOR_MANAGE_ROLES as UserRole[]))

/**
 * Photo uploads get their own budget, tighter than the global API limit: each
 * one costs a resize on a small instance and a class-A write against the R2
 * free tier. Generous for anybody maintaining a fleet, useless for anybody
 * burning quota. The same shape the profile module's limiter uses.
 */
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many uploads. Please try again in a few minutes.',
    errorSources: [{ path: 'file', message: 'Upload rate limit exceeded.' }],
  },
})

// --- /vendors --------------------------------------------------------------

const vendors = Router()

vendors.use(requireDb, auth, canRead)

/**
 * Declared before `/:id`, or Express matches these as an id and the parameter
 * schema rejects them with an unhelpful 400.
 */
vendors.get('/stats', getStats)
vendors.get('/options', validateRequest({ query: vendorOptionsQuerySchema }), getOptions)
/**
 * The vendor account's own record. No id anywhere in the request — the answer
 * comes from the profile the auth middleware loaded, which is what makes it
 * impossible to point at somebody else's.
 */
vendors.get('/me', getMyVendor)

vendors.get('/', validateRequest({ query: listVendorsQuerySchema }), getVendors)
vendors.post('/', canManage, validateRequest({ body: createVendorSchema }), postVendor)

vendors.get('/:id', validateRequest({ params: idParamSchema }), getOne)
vendors.get('/:id/summary', validateRequest({ params: idParamSchema }), getSummary)
vendors.get(
  '/:id/activity',
  validateRequest({ params: idParamSchema, query: activityQuerySchema }),
  getActivity,
)

vendors.patch(
  '/:id',
  canManage,
  validateRequest({ params: idParamSchema, body: updateVendorSchema }),
  patchVendor,
)
vendors.patch(
  '/:id/status',
  canManage,
  validateRequest({ params: idParamSchema, body: vendorStatusSchema }),
  patchVendorStatus,
)
vendors.delete('/:id', canManage, validateRequest({ params: idParamSchema }), deleteVendor)

/**
 * The photo endpoints mount the parser *after* the role check, so an
 * unauthorised upload is never even read off the wire — the same order the
 * profile module uses for the same reason.
 */
vendors.post(
  '/:id/photo',
  canManage,
  uploadLimiter,
  validateRequest({ params: idParamSchema }),
  uploadVendorPhotoFile,
  postVendorPhoto,
)
vendors.delete(
  '/:id/photo',
  canManage,
  validateRequest({ params: idParamSchema }),
  deleteVendorPhoto,
)

// The sub-collections: everything under one vendor.
vendors.get(
  '/:id/vehicles',
  validateRequest({ params: idParamSchema, query: listVehiclesQuerySchema }),
  getVehicles,
)
vendors.get(
  '/:id/vehicles/assignable',
  validateRequest({ params: idParamSchema }),
  getAssignableVehicles,
)
vendors.post(
  '/:id/vehicles',
  canManage,
  validateRequest({ params: idParamSchema, body: createVehicleSchema }),
  postVehicle,
)

vendors.get(
  '/:id/drivers',
  validateRequest({ params: idParamSchema, query: listDriversQuerySchema }),
  getDrivers,
)
vendors.get(
  '/:id/drivers/assignable',
  validateRequest({ params: idParamSchema }),
  getAssignableDrivers,
)
vendors.post(
  '/:id/drivers',
  canManage,
  validateRequest({ params: idParamSchema, body: createDriverSchema }),
  postDriver,
)

vendors.get(
  '/:id/assignments',
  validateRequest({ params: idParamSchema, query: listAssignmentsQuerySchema }),
  getAssignments,
)
vendors.post(
  '/:id/assignments',
  canManage,
  validateRequest({ params: idParamSchema, body: createAssignmentSchema }),
  postAssignment,
)

vendors.get(
  '/:id/documents',
  validateRequest({ params: idParamSchema, query: listDocumentsQuerySchema }),
  getDocuments,
)

export const vendorRoutes = vendors

// --- /vehicles -------------------------------------------------------------

const vehicles = Router()

vehicles.use(requireDb, auth, canRead)

vehicles.get('/:id', validateRequest({ params: idParamSchema }), getVehicleOne)
vehicles.get('/:id/assignments', validateRequest({ params: idParamSchema }), getVehicleHistory)
vehicles.get('/:id/documents', validateRequest({ params: idParamSchema }), getVehicleDocuments)

vehicles.patch(
  '/:id',
  canManage,
  validateRequest({ params: idParamSchema, body: updateVehicleSchema }),
  patchVehicle,
)
/**
 * Status is its own endpoint rather than a field on the edit form, because it
 * has a consequence a change of brand does not: a vehicle that is not `Active`
 * cannot be given a driver.
 */
vehicles.patch(
  '/:id/status',
  canManage,
  validateRequest({ params: idParamSchema, body: vehicleStatusSchema }),
  patchVehicleStatus,
)
vehicles.delete('/:id', canManage, validateRequest({ params: idParamSchema }), deleteVehicle)

/**
 * Filing a document against a vehicle.
 *
 * Multipart, because the row and its attachment are created together — the
 * expiry date is what raises the alert and the scan is the evidence for it, and
 * two requests would leave a window where one existed without the other. The
 * parser runs after the role check, so an unauthorised upload is never read.
 */
vehicles.post(
  '/:id/documents',
  canManage,
  uploadLimiter,
  validateRequest({ params: idParamSchema }),
  uploadVendorDocumentFile,
  validateRequest({ body: createDocumentSchema }),
  postVehicleDocument,
)

export const vehicleRoutes = vehicles

// --- /drivers --------------------------------------------------------------

const drivers = Router()

drivers.use(requireDb, auth, canRead)

drivers.get('/:id', validateRequest({ params: idParamSchema }), getDriverOne)
drivers.get('/:id/assignments', validateRequest({ params: idParamSchema }), getDriverHistory)
drivers.get('/:id/documents', validateRequest({ params: idParamSchema }), getDriverDocuments)

drivers.patch(
  '/:id',
  canManage,
  validateRequest({ params: idParamSchema, body: updateDriverSchema }),
  patchDriver,
)
drivers.patch(
  '/:id/status',
  canManage,
  validateRequest({ params: idParamSchema, body: driverStatusSchema }),
  patchDriverStatus,
)
drivers.delete('/:id', canManage, validateRequest({ params: idParamSchema }), deleteDriver)

drivers.post(
  '/:id/photo',
  canManage,
  uploadLimiter,
  validateRequest({ params: idParamSchema }),
  uploadVendorPhotoFile,
  postDriverPhoto,
)
drivers.delete(
  '/:id/photo',
  canManage,
  validateRequest({ params: idParamSchema }),
  deleteDriverPhoto,
)

drivers.post(
  '/:id/documents',
  canManage,
  uploadLimiter,
  validateRequest({ params: idParamSchema }),
  uploadVendorDocumentFile,
  validateRequest({ body: createDocumentSchema }),
  postDriverDocument,
)

export const driverRoutes = drivers

// --- /vendor-assignments ---------------------------------------------------

const assignments = Router()

assignments.use(requireDb, auth, canRead)

/**
 * Ending an assignment is a PATCH rather than a DELETE, because the row
 * survives — that is the whole point of the collection. Deleting is the narrow
 * escape hatch for a row that should never have existed, and it is a different
 * verb for a different thing.
 */
assignments.patch(
  '/:id/end',
  canManage,
  validateRequest({ params: idParamSchema, body: endAssignmentSchema }),
  patchAssignmentEnd,
)
assignments.delete('/:id', canManage, validateRequest({ params: idParamSchema }), deleteAssignment)

export const assignmentRoutes = assignments

// --- /vendor-documents -----------------------------------------------------

const documents = Router()

documents.use(requireDb, auth, canRead)

documents.get('/:id', validateRequest({ params: idParamSchema }), getDocumentOne)
/**
 * The only read path for a document's file. These objects are never served from
 * the public bucket, so a registration certificate carrying an owner's address
 * is behind the same authentication, role check and vendor scope as the record
 * it belongs to.
 */
documents.get('/:id/file', validateRequest({ params: idParamSchema }), getDocumentFile)

documents.patch(
  '/:id',
  canManage,
  uploadLimiter,
  validateRequest({ params: idParamSchema }),
  uploadVendorDocumentFile,
  validateRequest({ body: updateDocumentSchema }),
  patchDocument,
)
documents.delete('/:id', canManage, validateRequest({ params: idParamSchema }), deleteDocument)

export const vendorDocumentRoutes = documents
