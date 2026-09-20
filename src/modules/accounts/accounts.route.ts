import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { uploadVoucherFile } from '../../middlewares/upload'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { ACCOUNTS_READ_ROLES, ACCOUNTS_WRITE_ROLES } from './accounts.constants'
import {
  deleteEntryVoucher,
  deleteWallet,
  getAccountsOverview,
  getEntryVoucherFile,
  getCash,
  getAdvances,
  getEntries,
  getEntryById,
  getExpenseNames,
  getFinalBillById,
  getFinalBills,
  getProfitLoss,
  getLabourReceivableById,
  getLabourReceivableOptions,
  getLabourReceivables,
  getReceivable,
  getSlot,
  getTripOptions,
  getUnits,
  getVendorBill,
  getVendorBills,
  getWallets,
  patchEntry,
  patchFinalBill,
  patchWallet,
  postEntry,
  postEntryVoucher,
  postFinalBill,
  postWallet,
  removeEntry,
  removeFinalBill,
} from './accounts.controller'
import {
  cashSummaryQuerySchema,
  createEntrySchema,
  expenseNamesQuerySchema,
  finalBillSchema,
  finalBillSlotQuerySchema,
  idParamSchema,
  listAdvancesQuerySchema,
  listEntriesQuerySchema,
  listFinalBillsQuerySchema,
  listLabourReceivablesQuerySchema,
  overviewQuerySchema,
  profitLossQuerySchema,
  tripOptionsQuerySchema,
  updateEntrySchema,
  updateFinalBillSchema,
  updateWalletSchema,
  vendorBillDetailQuerySchema,
  vendorBillsQuerySchema,
  vendorParamSchema,
  voucherBodySchema,
  walletSchema,
} from './accounts.validation'

/**
 * Accounts. Read by Admin, Manager and CEO; kept by Admin and Manager. Order
 * as everywhere else: requireDb, then auth, then requireRole, which reads the
 * role from the profile and includes the active-account gate.
 */
/**
 * Uploads carry a file, so they get their own ceiling on top of the API-wide
 * per-account limit — the same posture every other upload endpoint in the app
 * takes.
 */
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many uploads. Please try again in a few minutes.',
    errorSources: [{ path: 'file', message: 'Upload rate limit exceeded.' }],
  },
})

const router = Router()

router.use(requireDb, auth, requireRole(...(ACCOUNTS_READ_ROLES as UserRole[])))

const canWrite = requireRole(...(ACCOUNTS_WRITE_ROLES as UserRole[]))
const withId = validateRequest({ params: idParamSchema })

router.get('/overview', validateRequest({ query: overviewQuerySchema }), getAccountsOverview)
router.get('/cash', validateRequest({ query: cashSummaryQuerySchema }), getCash)
router.get('/reports/profit-loss', validateRequest({ query: profitLossQuerySchema }), getProfitLoss)

router.get('/wallets', getWallets)
router.post('/wallets', canWrite, validateRequest({ body: walletSchema }), postWallet)
router.patch('/wallets/:id', canWrite, validateRequest({ params: idParamSchema, body: updateWalletSchema }), patchWallet)
router.delete('/wallets/:id', canWrite, withId, deleteWallet)

router.get('/expense-names', validateRequest({ query: expenseNamesQuerySchema }), getExpenseNames)

router.get('/entries', validateRequest({ query: listEntriesQuerySchema }), getEntries)
router.post('/entries', canWrite, validateRequest({ body: createEntrySchema }), postEntry)
router.get('/entries/:id', withId, getEntryById)
router.patch('/entries/:id', canWrite, validateRequest({ params: idParamSchema, body: updateEntrySchema }), patchEntry)
router.delete('/entries/:id', canWrite, withId, removeEntry)

/**
 * The paper behind an entry. Reading it is a read of the books; attaching and
 * removing it are writes, so `CEO` may look at a voucher and may not file one.
 *
 * The `GET` is declared with the read roles the router already applies, and
 * the two writes carry `canWrite` like every other write here.
 */
router.get('/entries/:id/voucher', withId, getEntryVoucherFile)
router.post(
  '/entries/:id/voucher',
  canWrite,
  uploadLimiter,
  withId,
  uploadVoucherFile,
  validateRequest({ body: voucherBodySchema }),
  postEntryVoucher,
)
router.delete('/entries/:id/voucher', canWrite, withId, deleteEntryVoucher)

router.get('/advances', validateRequest({ query: listAdvancesQuerySchema }), getAdvances)

router.get('/vendor-bills', validateRequest({ query: vendorBillsQuerySchema }), getVendorBills)
router.get(
  '/vendor-bills/:vendorId',
  validateRequest({ params: vendorParamSchema, query: vendorBillDetailQuerySchema }),
  getVendorBill,
)
router.get('/trips', canWrite, validateRequest({ query: tripOptionsQuerySchema }), getTripOptions)

// Declared before `/final-bills/:id` so none of them is matched as an id.
router.get('/final-bills/slot', validateRequest({ query: finalBillSlotQuerySchema }), getSlot)
router.get('/final-bills/units', getUnits)
router.get('/final-bills/receivable', getReceivable)
router.get('/final-bills', validateRequest({ query: listFinalBillsQuerySchema }), getFinalBills)
router.post('/final-bills', canWrite, validateRequest({ body: finalBillSchema }), postFinalBill)
router.get('/final-bills/:id', withId, getFinalBillById)
router.patch(
  '/final-bills/:id',
  canWrite,
  validateRequest({ params: idParamSchema, body: updateFinalBillSchema }),
  patchFinalBill,
)
router.delete('/final-bills/:id', canWrite, withId, removeFinalBill)

/**
 * Walton labour bill receivables: what each month's CSDs were billed, and what
 * has arrived. Read-only — a payment is a Deposit like any other, recorded
 * through the entry endpoints, so there is nothing to write here.
 *
 * `/receivable` is declared before `/:id` so it is never matched as an id.
 */
router.get('/labour-bills/receivable', getLabourReceivableOptions)
router.get(
  '/labour-bills',
  validateRequest({ query: listLabourReceivablesQuerySchema }),
  getLabourReceivables,
)
router.get('/labour-bills/:id', withId, getLabourReceivableById)

export const accountsRoutes = router
