import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { BILL_READ_ROLES, BILL_REVIEW_ROLES, BILL_WRITE_ROLES } from './bill.constants'
import {
  getBill,
  getBillExport,
  getBillUnits,
  getBills,
  getCandidates,
  patchBill,
  postBill,
  postFinalize,
  postLines,
  postRefresh,
  postRemoveLines,
  postReopen,
  removeBill,
} from './bill.controller'
import {
  addBillLinesSchema,
  billCandidatesQuerySchema,
  billIdParamSchema,
  createBillSchema,
  listBillsQuerySchema,
  removeBillLinesSchema,
  updateBillSchema,
} from './bill.validation'

/**
 * Bills. Read by everyone who reads the Trip DO sheet, prepared by everyone who
 * writes it, finalized and reopened by Admin and Manager. Order as everywhere
 * else: requireDb, then auth, then requireRole, which reads the role from the
 * profile and includes the active-account gate.
 */
const router = Router()

router.use(requireDb, auth, requireRole(...(BILL_READ_ROLES as UserRole[])))

const canWrite = requireRole(...(BILL_WRITE_ROLES as UserRole[]))
const canReview = requireRole(...(BILL_REVIEW_ROLES as UserRole[]))
const withId = validateRequest({ params: billIdParamSchema })

/** A workbook is built whole in memory, so it has a budget of its own, as every export does. */
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many exports. Please try again in a few minutes.',
    errorSources: [{ path: 'export', message: 'Export rate limit exceeded.' }],
  },
})

// Declared before `/:id` so it is never matched as an id.
router.get('/units', getBillUnits)

router.get('/', validateRequest({ query: listBillsQuerySchema }), getBills)
router.post('/', canWrite, validateRequest({ body: createBillSchema }), postBill)

router.get('/:id/export', exportLimiter, withId, getBillExport)
router.get(
  '/:id/candidates',
  canWrite,
  validateRequest({ params: billIdParamSchema, query: billCandidatesQuerySchema }),
  getCandidates,
)
router.post(
  '/:id/lines',
  canWrite,
  validateRequest({ params: billIdParamSchema, body: addBillLinesSchema }),
  postLines,
)
router.post(
  '/:id/lines/remove',
  canWrite,
  validateRequest({ params: billIdParamSchema, body: removeBillLinesSchema }),
  postRemoveLines,
)
router.post('/:id/refresh', canWrite, withId, postRefresh)
router.post('/:id/finalize', canReview, withId, postFinalize)
router.post('/:id/reopen', canReview, withId, postReopen)

router.get('/:id', withId, getBill)
router.patch('/:id', canWrite, validateRequest({ params: billIdParamSchema, body: updateBillSchema }), patchBill)
router.delete('/:id', canWrite, withId, removeBill)

export const billRoutes = router
