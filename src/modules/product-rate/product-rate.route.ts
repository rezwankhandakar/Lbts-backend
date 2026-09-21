import { Router } from 'express'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import {
  PRODUCT_RATE_LOOKUP_ROLES,
  PRODUCT_RATE_MANAGE_ROLES,
  PRODUCT_RATE_READ_ROLES,
} from './product-rate.constants'
import {
  deleteProductRate,
  getModelMatches,
  getProductNames,
  getProductRates,
  getStats,
  patchProductRate,
  postProductRate,
  postQuote,
} from './product-rate.controller'
import {
  createProductRateSchema,
  listProductRatesQuerySchema,
  modelLookupQuerySchema,
  productLookupQuerySchema,
  productRateIdParamSchema,
  quoteRatesSchema,
  updateProductRateSchema,
} from './product-rate.validation'

/**
 * The rate card has two audiences with two different rights, so the router has
 * two halves — the same shape the Location master takes, and the halves are
 * *questions* rather than URL prefixes.
 *
 * **The card itself is Admin-only**: listing it, adding a row, correcting one,
 * removing one, and the statistics. A rate is money — one careless edit
 * changes what every future challan in a category is charged at, there is no
 * per-row owner to scope it to, and what a delivery costs is not something the
 * whole office needs to read down a page.
 *
 * **The lookups belong to the Challan audience**: `/models`, `/products` and
 * `/quote`. Those are the Challan and Gate Pass entry forms asking the card a
 * question — is this pasted model on it, what does it call this product, what
 * would these lines come to — and closing them would leave a Manager, a CEO or
 * an Operation Executive typing product names against a card they cannot see,
 * which is how a line silently ends up with no rate at all.
 *
 * So there is deliberately **no router-wide role check** here. Every route
 * states its own, which is what stops a lookup added later from quietly
 * inheriting the wrong one. `requireDb` and `auth` still run across the
 * router, in that order, because `auth` reads the profile from MongoDB and
 * `requireRole` reads the role from that profile rather than from the token.
 */
const router = Router()

router.use(requireDb, auth)

const canLookUp = requireRole(...(PRODUCT_RATE_LOOKUP_ROLES as UserRole[]))
const canRead = requireRole(...(PRODUCT_RATE_READ_ROLES as UserRole[]))
const canManage = requireRole(...(PRODUCT_RATE_MANAGE_ROLES as UserRole[]))

/**
 * Declared before `/:id`, or Express matches these as an id and the parameter
 * schema rejects them with an unhelpful 400.
 */
router.get(
  '/models',
  canLookUp,
  validateRequest({ query: modelLookupQuerySchema }),
  getModelMatches,
)
router.get(
  '/products',
  canLookUp,
  validateRequest({ query: productLookupQuerySchema }),
  getProductNames,
)
router.get('/stats', canManage, getStats)

/**
 * A preview of what a set of lines would be charged.
 *
 * A POST because it carries a list, and a read because it changes nothing. It
 * needs no rate limit of its own: unlike the location resolver it reaches no
 * external service, it is one indexed query, and the client only asks once a
 * location is actually known.
 */
router.post('/quote', canLookUp, validateRequest({ body: quoteRatesSchema }), postQuote)

router.get(
  '/',
  canRead,
  validateRequest({ query: listProductRatesQuerySchema }),
  getProductRates,
)

router.post('/', canManage, validateRequest({ body: createProductRateSchema }), postProductRate)

router.patch(
  '/:id',
  canManage,
  validateRequest({ params: productRateIdParamSchema, body: updateProductRateSchema }),
  patchProductRate,
)

router.delete(
  '/:id',
  canManage,
  validateRequest({ params: productRateIdParamSchema }),
  deleteProductRate,
)

export const productRateRoutes = router
