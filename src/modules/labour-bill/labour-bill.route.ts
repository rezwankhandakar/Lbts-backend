import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import {
  LABOUR_BILL_READ_ROLES,
  LABOUR_BILL_REVIEW_ROLES,
  LABOUR_BILL_WRITE_ROLES,
} from './labour-bill.constants'
import {
  getLabourBill,
  getLabourBillCompanies,
  getLabourBillExport,
  getLabourBillSignedCopies,
  getLabourBillSignedCopiesFile,
  getLabourBills,
  patchLabourBill,
  patchLabourBillLine,
  postLabourBill,
  postLabourBillFinalize,
  postLabourBillRefresh,
  postLabourBillReopen,
  postLabourBillScan,
  postRemoveLabourBillLines,
  removeLabourBill,
} from './labour-bill.controller'
import {
  createLabourBillSchema,
  labourBillIdParamSchema,
  labourBillLineParamSchema,
  listLabourBillsQuerySchema,
  removeLabourBillLinesSchema,
  scanLabourBillSchema,
  signedCopiesQuerySchema,
  updateLabourBillLineSchema,
  updateLabourBillSchema,
} from './labour-bill.validation'

/**
 * Walton Labour Bills. Read by everyone who reads the Trip DO sheet, scanned
 * and typed by everyone who writes it, finalized and reopened by Admin and
 * Manager. Order as everywhere else: requireDb, then auth, then requireRole,
 * which reads the role from the profile and includes the active-account gate.
 */
const router = Router()

router.use(requireDb, auth, requireRole(...(LABOUR_BILL_READ_ROLES as UserRole[])))

const canWrite = requireRole(...(LABOUR_BILL_WRITE_ROLES as UserRole[]))
const canReview = requireRole(...(LABOUR_BILL_REVIEW_ROLES as UserRole[]))
const withId = validateRequest({ params: labourBillIdParamSchema })

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
router.get('/companies', getLabourBillCompanies)

router.get('/', validateRequest({ query: listLabourBillsQuerySchema }), getLabourBills)
router.post('/', canWrite, validateRequest({ body: createLabourBillSchema }), postLabourBill)

router.get('/:id/export', exportLimiter, withId, getLabourBillExport)

/**
 * The receivers' signed copies behind the bill: what has come back, and those
 * copies as one PDF.
 *
 * Both are reads and sit under the router's own read roles — the paper proving
 * a month's deliveries happened is part of reading the bill, and a `CEO` who
 * may not type a labour amount may certainly look at it. The assembly is the
 * most expensive read in the module, so it keeps the export's budget: every
 * copy is pulled into memory because pdf-lib cannot stream.
 */
router.get('/:id/signed-copies', withId, getLabourBillSignedCopies)
router.get(
  '/:id/signed-copies/download',
  exportLimiter,
  validateRequest({ params: labourBillIdParamSchema, query: signedCopiesQuerySchema }),
  getLabourBillSignedCopiesFile,
)
router.post(
  '/:id/scan',
  canWrite,
  validateRequest({ params: labourBillIdParamSchema, body: scanLabourBillSchema }),
  postLabourBillScan,
)
router.patch(
  '/:id/lines/:lineId',
  canWrite,
  validateRequest({ params: labourBillLineParamSchema, body: updateLabourBillLineSchema }),
  patchLabourBillLine,
)
router.post(
  '/:id/lines/remove',
  canWrite,
  validateRequest({ params: labourBillIdParamSchema, body: removeLabourBillLinesSchema }),
  postRemoveLabourBillLines,
)
router.post('/:id/refresh', canWrite, withId, postLabourBillRefresh)
router.post('/:id/finalize', canReview, withId, postLabourBillFinalize)
router.post('/:id/reopen', canReview, withId, postLabourBillReopen)

router.get('/:id', withId, getLabourBill)
router.patch(
  '/:id',
  canWrite,
  validateRequest({ params: labourBillIdParamSchema, body: updateLabourBillSchema }),
  patchLabourBill,
)
router.delete('/:id', canWrite, withId, removeLabourBill)

export const labourBillRoutes = router
