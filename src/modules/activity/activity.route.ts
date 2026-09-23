import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { ACTIVITY_EXPORT_ROLES, ACTIVITY_READ_ROLES } from './activity.constants'
import { getActivity, getExport, getFilters, getStats } from './activity.controller'
import {
  activityStatsQuerySchema,
  exportActivityQuerySchema,
  listActivityQuerySchema,
} from './activity.validation'

/**
 * The activity journal. Order as everywhere else: `requireDb`, then `auth`,
 * then `requireRole` — which reads the role from the profile and includes the
 * active-account gate.
 *
 * A router-wide role check is right here, unlike Location and Product Rate:
 * those carry lookups a wider audience genuinely needs, and every route states
 * its own. Nothing in this module is a lookup. Every route answers the same
 * question — who did what — to the same three roles, and the export narrows
 * from there.
 *
 * **There is no write route.** Rows are appended by services through
 * `recordActivity`; nothing a request can reach creates, edits or deletes one.
 */
const router = Router()

router.use(requireDb, auth, requireRole(...(ACTIVITY_READ_ROLES as UserRole[])))

/**
 * The workbook is built whole in memory, so it gets a budget of its own — the
 * arrangement every export in this codebase has.
 */
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many exports. Please try again in a few minutes.',
    errorSources: [{ path: 'export', message: 'Export rate limit exceeded.' }],
  },
})

// Declared before the list so neither is ever matched as the other.
router.get('/stats', validateRequest({ query: activityStatsQuerySchema }), getStats)
router.get('/filters', getFilters)
router.get(
  '/export',
  requireRole(...(ACTIVITY_EXPORT_ROLES as UserRole[])),
  exportLimiter,
  validateRequest({ query: exportActivityQuerySchema }),
  getExport,
)

router.get('/', validateRequest({ query: listActivityQuerySchema }), getActivity)

export const activityRoutes = router
