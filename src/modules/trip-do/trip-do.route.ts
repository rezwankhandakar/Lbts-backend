import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { TRIP_DO_READ_ROLES, TRIP_DO_WRITE_ROLES } from './trip-do.constants'
import {
  deleteLink,
  getColumnValues,
  getExport,
  getGatePassOptions,
  getGatePassStatus,
  getRows,
  patchLink,
  postBulkLink,
  postMerge,
  postSplit,
} from './trip-do.controller'
import {
  bulkLinkSchema,
  columnValuesQuerySchema,
  exportTripDoQuerySchema,
  gatePassIdParamSchema,
  gatePassOptionsQuerySchema,
  linkRowSchema,
  listTripDoQuerySchema,
  splitRowSchema,
  tripDoRowIdParamSchema,
} from './trip-do.validation'

/**
 * The Trip DO sheet. Read by everyone who reads challans and gate passes;
 * written by everyone who writes them. Order as everywhere else: requireDb,
 * then auth, then requireRole, which reads the role from the profile.
 */
const router = Router()

router.use(requireDb, auth, requireRole(...(TRIP_DO_READ_ROLES as UserRole[])))

const canWrite = requireRole(...(TRIP_DO_WRITE_ROLES as UserRole[]))

/**
 * The export builds a whole workbook in memory — the one read here that is
 * neither paged nor cheap — so it has a budget of its own, the gate pass one.
 */
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many exports. Please try again in a few minutes.',
    errorSources: [{ path: 'export', message: 'Export rate limit exceeded.' }],
  },
})

// Declared before `/:id` so they are never matched as an id.
router.get('/export', exportLimiter, validateRequest({ query: exportTripDoQuerySchema }), getExport)
router.get(
  '/gate-passes/:id',
  validateRequest({ params: gatePassIdParamSchema }),
  getGatePassStatus,
)
router.get('/column-values', validateRequest({ query: columnValuesQuerySchema }), getColumnValues)
router.post('/bulk-link', canWrite, validateRequest({ body: bulkLinkSchema }), postBulkLink)

router.get('/', validateRequest({ query: listTripDoQuerySchema }), getRows)

router.get(
  '/:id/gate-pass-options',
  validateRequest({ params: tripDoRowIdParamSchema, query: gatePassOptionsQuerySchema }),
  getGatePassOptions,
)
router.patch(
  '/:id/link',
  canWrite,
  validateRequest({ params: tripDoRowIdParamSchema, body: linkRowSchema }),
  patchLink,
)
router.delete(
  '/:id/link',
  canWrite,
  validateRequest({ params: tripDoRowIdParamSchema }),
  deleteLink,
)
router.post(
  '/:id/split',
  canWrite,
  validateRequest({ params: tripDoRowIdParamSchema, body: splitRowSchema }),
  postSplit,
)
router.post(
  '/:id/merge',
  canWrite,
  validateRequest({ params: tripDoRowIdParamSchema }),
  postMerge,
)

export const tripDoRoutes = router
