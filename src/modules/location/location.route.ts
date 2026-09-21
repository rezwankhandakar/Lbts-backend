import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import {
  LOCATION_LOOKUP_ROLES,
  LOCATION_MANAGE_ROLES,
  LOCATION_READ_ROLES,
} from './location.constants'
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
 * router has two halves — and the halves are *questions*, not URL prefixes.
 *
 * **The master list is Admin-only**: listing it, adding a row, correcting one,
 * removing one, and the resolver statistics. It is reference data the whole
 * operation classifies deliveries against, one careless edit re-classifies
 * every future challan in a district, and there is no per-row owner to scope
 * it to.
 *
 * **The lookups belong to the Challan audience**: `/districts`, `/thanas` and
 * `/resolve`. Those are not this module being read — they are the Challan and
 * Gate Pass entry forms asking it a question, and closing them would leave a
 * Manager, a CEO or an Operation Executive unable to set a location on a
 * challan at all. Making the collection private and its lookups usable is the
 * whole point of the split; `location.constants.ts` says so at more length.
 *
 * So there is deliberately **no router-wide role check** here. Every route
 * states its own, which is what stops a lookup added later from quietly
 * inheriting the wrong one. `requireDb` and `auth` still run across the
 * router, in that order, because `auth` reads the profile from MongoDB and
 * `requireRole` reads the role from that profile rather than from the token.
 */
const router = Router()

router.use(requireDb, auth)

const canLookUp = requireRole(...(LOCATION_LOOKUP_ROLES as UserRole[]))
const canRead = requireRole(...(LOCATION_READ_ROLES as UserRole[]))
const canManage = requireRole(...(LOCATION_MANAGE_ROLES as UserRole[]))

/**
 * Declared before `/:id`, or Express matches these as an id and the parameter
 * schema rejects them with an unhelpful 400.
 */
router.get('/districts', canLookUp, getDistricts)
router.get('/thanas', canLookUp, validateRequest({ query: thanaQuerySchema }), getThanas)
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
  canLookUp,
  resolveLimiter,
  validateRequest({ body: resolveLocationSchema }),
  postResolve,
)

router.get('/', canRead, validateRequest({ query: listLocationsQuerySchema }), getLocations)

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
