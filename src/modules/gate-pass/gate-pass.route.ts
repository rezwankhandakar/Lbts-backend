import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { uploadGatePassScan } from '../../middlewares/upload'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import {
  GATE_PASS_READ_ROLES,
  GATE_PASS_REVIEW_ROLES,
  GATE_PASS_WRITE_ROLES,
} from './gate-pass.constants'
import {
  deleteGatePass,
  getDocument,
  getDuplicates,
  getExport,
  getGatePasses,
  getOne,
  getStats,
  getSuggestions,
  patchGatePass,
  postDocument,
  postGatePass,
  postReview,
  postSubmit,
} from './gate-pass.controller'
import {
  createGatePassSchema,
  duplicateQuerySchema,
  exportGatePassesQuerySchema,
  gatePassIdParamSchema,
  listGatePassesQuerySchema,
  reviewGatePassSchema,
  submitGatePassSchema,
  suggestionQuerySchema,
  updateGatePassSchema,
} from './gate-pass.validation'

const router = Router()

/**
 * Gate Pass records the operation's own paperwork, so who may reach it is a
 * module decision — CLAUDE.md deliberately has no central permission matrix.
 * The three role sets live in gate-pass.constants.ts and are enforced here;
 * the sidebar and the route guard in the browser are courtesy, this is the
 * boundary that counts.
 *
 * Order is the same as everywhere else in the API. requireDb first, because
 * auth reads the profile from MongoDB; then auth, which verifies the Firebase
 * ID token and loads that profile; then requireRole, which reads `role` from
 * the profile rather than from the token, so a role change takes effect on the
 * very next request. requireRole already includes requireActiveAccount.
 */
router.use(requireDb, auth, requireRole(...(GATE_PASS_READ_ROLES as UserRole[])))

const canWrite = requireRole(...(GATE_PASS_WRITE_ROLES as UserRole[]))
const canReview = requireRole(...(GATE_PASS_REVIEW_ROLES as UserRole[]))

/**
 * Declared before `/:id`, or Express matches these as an id and the parameter
 * schema rejects them with an unhelpful 400.
 */
router.get('/stats', getStats)
router.get('/duplicates', validateRequest({ query: duplicateQuerySchema }), getDuplicates)
/**
 * Type-ahead for the entry form. A read like any other, so it sits behind the
 * same read roles and the same visibility rules as the records themselves.
 */
router.get('/suggestions', validateRequest({ query: suggestionQuerySchema }), getSuggestions)

/**
 * The spreadsheet. Its own budget, and a small one: an export reads every
 * matching record rather than a page of ten and then builds a workbook in
 * memory, so it is the most expensive read in the module by a wide margin.
 * Twelve in a quarter of an hour is more than a month-end reconciliation
 * needs, and far less than anything that would hold an M0 cluster down.
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

router.get(
  '/export',
  exportLimiter,
  validateRequest({ query: exportGatePassesQuerySchema }),
  getExport,
)

router.get('/', validateRequest({ query: listGatePassesQuerySchema }), getGatePasses)
router.post('/', canWrite, validateRequest({ body: createGatePassSchema }), postGatePass)

router.get('/:id', validateRequest({ params: gatePassIdParamSchema }), getOne)

router.patch(
  '/:id',
  canWrite,
  validateRequest({ params: gatePassIdParamSchema, body: updateGatePassSchema }),
  patchGatePass,
)

router.post(
  '/:id/submit',
  canWrite,
  validateRequest({ params: gatePassIdParamSchema, body: submitGatePassSchema }),
  postSubmit,
)

router.post(
  '/:id/review',
  canReview,
  validateRequest({ params: gatePassIdParamSchema, body: reviewGatePassSchema }),
  postReview,
)

/**
 * Tighter than the global API limit. An upload costs an image decode on a
 * small instance and a class-A write against the R2 free tier, so it gets its
 * own budget: generous for an operator working through a stack of challans,
 * useless for anyone burning quota. Higher than the profile photo's 20,
 * because scanning is the job here rather than an occasional adjustment.
 */
const documentUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many document uploads. Please try again in a few minutes.',
    errorSources: [{ path: 'document', message: 'Upload rate limit exceeded.' }],
  },
})

/**
 * The multipart parser runs after auth and after the role check, so an
 * unauthenticated or unauthorised upload is never even read off the wire.
 * The id is validated after parsing, because the body has to be consumed
 * before anything else can respond without resetting the connection.
 */
router.post(
  '/:id/document',
  canWrite,
  documentUploadLimiter,
  uploadGatePassScan,
  validateRequest({ params: gatePassIdParamSchema }),
  postDocument,
)

router.get('/:id/document', validateRequest({ params: gatePassIdParamSchema }), getDocument)

router.delete(
  '/:id',
  canWrite,
  validateRequest({ params: gatePassIdParamSchema }),
  deleteGatePass,
)

export const gatePassRoutes = router
