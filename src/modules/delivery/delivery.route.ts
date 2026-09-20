import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { uploadReceivedCopyFile, uploadVendorPhotoFile } from '../../middlewares/upload'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { DELIVERY_READ_ROLES, DELIVERY_WRITE_ROLES } from './delivery.constants'
import {
  deleteCopyMissing,
  deleteReceivedCopyFile,
  deleteTrip,
  getChallanCandidates,
  getChallanDispatchOne,
  getChallanScan,
  getReceiptScan,
  getTripScan,
  getReceivedCopyFile,
  getStats,
  getTripOne,
  getTrips,
  getVehicleOne,
  getVehicleSearch,
  patchCompletion,
  patchTrip,
  patchTripBill,
  postDriver,
  postDriverPhoto,
  postReceivedCopy,
  postTrip,
  putCopyMissing,
} from './delivery.controller'
import {
  challanCandidatesQuerySchema,
  challanScanQuerySchema,
  completionSchema,
  copyMissingSchema,
  createTripSchema,
  idParamSchema,
  listTripsQuerySchema,
  quickDriverSchema,
  receiptScanQuerySchema,
  tripScanQuerySchema,
  receivedCopyBodySchema,
  statsQuerySchema,
  tripBillSchema,
  tripChallanParamSchema,
  updateTripSchema,
  vehicleSearchQuerySchema,
} from './delivery.validation'

/**
 * The Delivery module's boundary.
 *
 * The usual order: `requireDb` first, because `auth` reads the profile from
 * MongoDB; then `auth`; then `requireRole`, which reads the role from the
 * profile rather than the token and includes `requireActiveAccount`. Per-trip
 * ownership — an operator changes their own trips — is `delivery.access.ts`.
 *
 * The lookups (`/vehicles`, `/challan-candidates`) are **read** endpoints and
 * sit behind the read roles, but they are only useful to somebody building a
 * trip, which is why the workspace route in the browser is a write route.
 */

const canRead = requireRole(...(DELIVERY_READ_ROLES as UserRole[]))
const canWrite = requireRole(...(DELIVERY_WRITE_ROLES as UserRole[]))

/**
 * The vehicle box and the challan box both search as somebody types, and a
 * barcode scanner can fire a read a second. Generous for a person at a gate,
 * a ceiling for anything else — and debounced on the client either way.
 */
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many searches. Please wait a moment and try again.',
    errorSources: [{ path: 'q', message: 'Search rate limit exceeded.' }],
  },
})

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many uploads. Please try again in a few minutes.',
    errorSources: [{ path: 'file', message: 'Upload rate limit exceeded.' }],
  },
})

const router = Router()

router.use(requireDb, auth, canRead)

// Declared before `/:id`, or Express matches these as an id.
router.get('/stats', validateRequest({ query: statsQuerySchema }), getStats)

router.get(
  '/vehicles',
  lookupLimiter,
  validateRequest({ query: vehicleSearchQuerySchema }),
  getVehicleSearch,
)
router.get('/vehicles/:id', validateRequest({ params: idParamSchema }), getVehicleOne)

router.get(
  '/challan-candidates',
  lookupLimiter,
  validateRequest({ query: challanCandidatesQuerySchema }),
  getChallanCandidates,
)
router.get(
  '/challan-candidates/scan',
  lookupLimiter,
  validateRequest({ query: challanScanQuerySchema }),
  getChallanScan,
)

/**
 * A signed challan copy coming back, read off its barcode: which delivery is
 * this the receipt for? Declared before `/:id` for the same reason every other
 * static segment here is.
 */
router.get(
  '/receipts/scan',
  lookupLimiter,
  validateRequest({ query: receiptScanQuerySchema }),
  getReceiptScan,
)

/**
 * A manifest's own barcode, read off the printed sheet: open this trip.
 *
 * The third scan endpoint here, declared before `/:id` like every other static
 * segment. It is a read, so it sits under the router's own `canRead` and takes
 * no write role — a CEO holding a manifest may open the trip it names.
 */
router.get(
  '/trips/scan',
  lookupLimiter,
  validateRequest({ query: tripScanQuerySchema }),
  getTripScan,
)

/**
 * One challan's dispatch state, for the challan's own page. Addressed by
 * challan and served from here, because every word of the answer is about
 * trips — the Challan module stores only the summary it filters on.
 */
router.get(
  '/by-challan/:id',
  validateRequest({ params: idParamSchema }),
  getChallanDispatchOne,
)

/**
 * Adding a driver without leaving the trip. A write, and a wider one than the
 * fleet master allows — see `DELIVERY_WRITE_ROLES`. The photo parser runs after
 * the role check, so an unauthorised upload is never read off the wire.
 */
router.post('/drivers', canWrite, validateRequest({ body: quickDriverSchema }), postDriver)
router.post(
  '/drivers/:id/photo',
  canWrite,
  uploadLimiter,
  validateRequest({ params: idParamSchema }),
  uploadVendorPhotoFile,
  postDriverPhoto,
)

router.get('/', validateRequest({ query: listTripsQuerySchema }), getTrips)
router.post('/', canWrite, validateRequest({ body: createTripSchema }), postTrip)

router.get('/:id', validateRequest({ params: idParamSchema }), getTripOne)
router.patch(
  '/:id',
  canWrite,
  validateRequest({ params: idParamSchema, body: updateTripSchema }),
  patchTrip,
)
/**
 * Completing a delivery, in two calls that are deliberately not one.
 *
 * The first is what an operator types while looking at the goods that came
 * back; the second is what the scanner produces, and it is the one that
 * completes the delivery. Keeping them apart means a return can be recorded
 * while the signed copy is still in the van, and a copy can be replaced
 * without anybody re-typing a floor number.
 *
 * The upload parser runs **after** the role check, so an unauthorised upload
 * is never read off the wire — the same order the profile and gate pass
 * endpoints keep.
 */
router.patch(
  '/:id/challans/:challanId/completion',
  canWrite,
  validateRequest({ params: tripChallanParamSchema, body: completionSchema }),
  patchCompletion,
)

router.get(
  '/:id/challans/:challanId/received-copy',
  validateRequest({ params: tripChallanParamSchema }),
  getReceivedCopyFile,
)
router.post(
  '/:id/challans/:challanId/received-copy',
  canWrite,
  uploadLimiter,
  validateRequest({ params: tripChallanParamSchema }),
  uploadReceivedCopyFile,
  validateRequest({ body: receivedCopyBodySchema }),
  postReceivedCopy,
)
router.delete(
  '/:id/challans/:challanId/received-copy',
  canWrite,
  validateRequest({ params: tripChallanParamSchema }),
  deleteReceivedCopyFile,
)
/**
 * The trip's rent and labour bill. Open to the same writers as the trip, and
 * deliberately not gated on the trip being open — see `recordTripBill`.
 */
router.patch(
  '/:id/bill',
  canWrite,
  validateRequest({ params: idParamSchema, body: tripBillSchema }),
  patchTripBill,
)

/**
 * The signed copy is lost: complete the delivery on that statement, or take
 * the statement back. A PUT because declaring it twice is declaring it once.
 */
router.put(
  '/:id/challans/:challanId/copy-missing',
  canWrite,
  validateRequest({ params: tripChallanParamSchema, body: copyMissingSchema }),
  putCopyMissing,
)
router.delete(
  '/:id/challans/:challanId/copy-missing',
  canWrite,
  validateRequest({ params: tripChallanParamSchema }),
  deleteCopyMissing,
)
router.delete('/:id', canWrite, validateRequest({ params: idParamSchema }), deleteTrip)

export const deliveryRoutes = router
