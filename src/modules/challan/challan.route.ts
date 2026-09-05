import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { uploadChallanPages } from '../../middlewares/upload'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { CHALLAN_READ_ROLES, CHALLAN_WRITE_ROLES } from './challan.constants'
import {
  deleteChallan,
  getBatchDownload,
  getBatchOne,
  getBatches,
  getChallans,
  getDocument,
  getDuplicates,
  getOne,
  getPageRange,
  getStats,
  getSuggestions,
  patchBatchSkippedPages,
  patchChallan,
  postChallan,
} from './challan.controller'
import {
  batchIdParamSchema,
  challanIdParamSchema,
  duplicateQuerySchema,
  listBatchesQuerySchema,
  listChallansQuerySchema,
  pageRangeQuerySchema,
  skippedPagesSchema,
  submitChallanSchema,
  suggestionQuerySchema,
  updateChallanSchema,
} from './challan.validation'

/**
 * Challan records the paperwork that arrives from the corporate office, so who
 * may reach it is a module decision — CLAUDE.md deliberately has no central
 * permission matrix. The two role sets live in challan.constants.ts and are
 * enforced here; the sidebar and the route guard in the browser are courtesy,
 * this is the boundary that counts.
 *
 * Order is the same as everywhere else in the API. requireDb first, because
 * auth reads the profile from MongoDB; then auth, which verifies the Firebase
 * ID token and loads that profile; then requireRole, which reads `role` from
 * the profile rather than from the token, so a role change takes effect on the
 * very next request. requireRole already includes requireActiveAccount.
 */
const challanRouter = Router()

challanRouter.use(requireDb, auth, requireRole(...(CHALLAN_READ_ROLES as UserRole[])))

const canWrite = requireRole(...(CHALLAN_WRITE_ROLES as UserRole[]))

/**
 * Declared before `/:id`, or Express matches these as an id and the parameter
 * schema rejects them with an unhelpful 400.
 */
challanRouter.get('/stats', getStats)
challanRouter.get('/suggestions', validateRequest({ query: suggestionQuerySchema }), getSuggestions)
challanRouter.get('/duplicates', validateRequest({ query: duplicateQuerySchema }), getDuplicates)
challanRouter.get('/page-range', validateRequest({ query: pageRangeQuerySchema }), getPageRange)

challanRouter.get('/', validateRequest({ query: listChallansQuerySchema }), getChallans)

/**
 * Filing a challan.
 *
 * Its own budget, and a generous one: this is the job. An operator working
 * through a WhatsApp PDF of twenty challans submits twenty times in half an
 * hour, and each submission builds a PDF and writes an object to R2 — real
 * work on a small instance, which is why it is not left on the global limit.
 *
 * The multipart parser runs after auth and after the role check, so an
 * unauthenticated or unauthorised submission is never even read off the wire.
 * Validation runs after the parser, because the values arrive in the same
 * multipart body as the pages and there is nothing to validate until it has
 * been consumed.
 */
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many submissions. Please try again in a few minutes.',
    errorSources: [{ path: 'submission', message: 'Submission rate limit exceeded.' }],
  },
})

challanRouter.post(
  '/',
  canWrite,
  submitLimiter,
  uploadChallanPages,
  validateRequest({ body: submitChallanSchema }),
  postChallan,
)

challanRouter.get('/:id', validateRequest({ params: challanIdParamSchema }), getOne)

challanRouter.patch(
  '/:id',
  canWrite,
  validateRequest({ params: challanIdParamSchema, body: updateChallanSchema }),
  patchChallan,
)

challanRouter.delete(
  '/:id',
  canWrite,
  validateRequest({ params: challanIdParamSchema }),
  deleteChallan,
)

challanRouter.get('/:id/document', validateRequest({ params: challanIdParamSchema }), getDocument)

export const challanRoutes = challanRouter

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

const batchRouter = Router()

batchRouter.use(requireDb, auth, requireRole(...(CHALLAN_READ_ROLES as UserRole[])))

/**
 * Assembling a completed batch is the most expensive read in the module by a
 * wide margin: every challan's document is pulled out of R2 and merged in
 * memory, because pdf-lib parses a cross-reference table at the end of each
 * file and cannot stream one. Twelve in a quarter of an hour is more than a
 * day's filing needs and far less than anything that would hold an M0 cluster
 * and a 512 MB instance down.
 */
const batchDownloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many batch downloads. Please try again in a few minutes.',
    errorSources: [{ path: 'batch', message: 'Batch download rate limit exceeded.' }],
  },
})

batchRouter.get('/', validateRequest({ query: listBatchesQuerySchema }), getBatches)
batchRouter.get('/:id', validateRequest({ params: batchIdParamSchema }), getBatchOne)

/**
 * Marking pages of the source PDF as not being challans. A write, so it takes
 * the write roles; ownership of the batch is checked in the service, because a
 * statement about a file only one person ever had is theirs to make.
 */
batchRouter.patch(
  '/:id/skipped-pages',
  requireRole(...(CHALLAN_WRITE_ROLES as UserRole[])),
  validateRequest({ params: batchIdParamSchema, body: skippedPagesSchema }),
  patchBatchSkippedPages,
)
batchRouter.get(
  '/:id/download',
  batchDownloadLimiter,
  validateRequest({ params: batchIdParamSchema }),
  getBatchDownload,
)

export const challanBatchRoutes = batchRouter
