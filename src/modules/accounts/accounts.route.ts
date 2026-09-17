import { Router } from 'express'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import type { UserRole } from '../user/user.constants'
import { ACCOUNTS_READ_ROLES, ACCOUNTS_WRITE_ROLES } from './accounts.constants'
import {
  deleteWallet,
  getAccountsOverview,
  getCash,
  getAdvances,
  getEntries,
  getEntryById,
  getExpenseNames,
  getFinalBillById,
  getFinalBills,
  getProfitLoss,
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
  overviewQuerySchema,
  profitLossQuerySchema,
  tripOptionsQuerySchema,
  updateEntrySchema,
  updateFinalBillSchema,
  updateWalletSchema,
  vendorBillDetailQuerySchema,
  vendorBillsQuerySchema,
  vendorParamSchema,
  walletSchema,
} from './accounts.validation'

/**
 * Accounts. Read by Admin, Manager and CEO; kept by Admin and Manager. Order
 * as everywhere else: requireDb, then auth, then requireRole, which reads the
 * role from the profile and includes the active-account gate.
 */
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

export const accountsRoutes = router
