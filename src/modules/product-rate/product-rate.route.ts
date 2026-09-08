import { Router } from 'express'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { PRODUCT_RATE_MANAGE_ROLES, PRODUCT_RATE_READ_ROLES } from './product-rate.constants'
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
 * two halves — the same shape the Location master takes.
 *
 * **Reading** is open to everyone who may reach a challan. The entry form
 * offers product names off this collection when a model is pasted, and a
 * details page needs it to explain a figure; refusing that to an Operation
 * Executive would make the module unusable by the people who use it most.
 *
 * **Writing** is Admin-only, and the reason is sharper here than for
 * locations: a rate is money. One careless edit changes what every future
 * challan in a category is charged at, and there is no per-row owner to scope
 * it to.
 *
 * Order is the same as everywhere else in the API: requireDb first, because
 * auth reads the profile from MongoDB; then auth; then requireRole, which
 * reads `role` from that profile rather than from the token.
 */
const router = Router()

router.use(requireDb, auth, requireRole(...(PRODUCT_RATE_READ_ROLES as UserRole[])))

const canManage = requireRole(...(PRODUCT_RATE_MANAGE_ROLES as UserRole[]))

/**
 * Declared before `/:id`, or Express matches these as an id and the parameter
 * schema rejects them with an unhelpful 400.
 */
router.get('/models', validateRequest({ query: modelLookupQuerySchema }), getModelMatches)
router.get('/products', validateRequest({ query: productLookupQuerySchema }), getProductNames)
router.get('/stats', canManage, getStats)

/**
 * A preview of what a set of lines would be charged.
 *
 * A POST because it carries a list, and a read because it changes nothing. It
 * needs no rate limit of its own: unlike the location resolver it reaches no
 * external service, it is one indexed query, and the client only asks once a
 * location is actually known.
 */
router.post('/quote', validateRequest({ body: quoteRatesSchema }), postQuote)

router.get('/', validateRequest({ query: listProductRatesQuerySchema }), getProductRates)

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
