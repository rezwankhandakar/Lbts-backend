import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { LOCATION_MANAGE_ROLES, LOCATION_READ_ROLES } from './location.constants'
import {
  deleteLocation,
  getDistricts,
  getLocations,
  getStats,
  getThanas,
  patchLocation,
  postLocation,
  postResolve,
} from './location.controller'
import {
  createLocationSchema,
  listLocationsQuerySchema,
  locationIdParamSchema,
  resolveLocationSchema,
  thanaQuerySchema,
  updateLocationSchema,
} from './location.validation'

/**
 * The master collection has two audiences with two different rights, so the
 * router has two halves.
 *
 * **Reading** is open to everyone who may reach a challan. The entry form
 * needs the districts and thanas to offer a cascading selector, and a details
 * page needs them to say what a location type is — refusing that to an
 * Operation Executive would make the module unusable by the people who use it
 * most.
 *
 * **Writing** is Admin-only. This is reference data the whole operation
 * classifies deliveries against; one careless edit reclassifies every future
 * challan in a district, and there is no per-record owner to scope it to.
 *
 * Order is the same as everywhere else in the API: requireDb first, because
 * auth reads the profile from MongoDB; then auth; then requireRole, which
 * reads `role` from that profile rather than from the token.
 */
const router = Router()

router.use(requireDb, auth, requireRole(...(LOCATION_READ_ROLES as UserRole[])))

const canManage = requireRole(...(LOCATION_MANAGE_ROLES as UserRole[]))

/**
 * Declared before `/:id`, or Express matches these as an id and the parameter
 * schema rejects them with an unhelpful 400.
 */
router.get('/districts', getDistricts)
router.get('/thanas', validateRequest({ query: thanaQuerySchema }), getThanas)
router.get('/stats', canManage, getStats)

/**
 * Resolving a piece of text.
 *
 * Its own budget, and a modest one. It is the only endpoint in the API that
 * can reach an external service, and although the local matcher answers most
 * calls without one, a form wired up wrongly — one request per keystroke —
 * would burn a day's quota in a minute. The client debounces and resolves on
 * blur; this is what makes that a property of the system rather than of the
 * client.
 */
const resolveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many location lookups. Please try again in a few minutes.',
    errorSources: [{ path: 'location', message: 'Location lookup rate limit exceeded.' }],
  },
})

router.post(
  '/resolve',
  resolveLimiter,
  validateRequest({ body: resolveLocationSchema }),
  postResolve,
)

router.get('/', validateRequest({ query: listLocationsQuerySchema }), getLocations)

router.post('/', canManage, validateRequest({ body: createLocationSchema }), postLocation)

router.patch(
  '/:id',
  canManage,
  validateRequest({ params: locationIdParamSchema, body: updateLocationSchema }),
  patchLocation,
)

router.delete(
  '/:id',
  canManage,
  validateRequest({ params: locationIdParamSchema }),
  deleteLocation,
)

export const locationRoutes = router
