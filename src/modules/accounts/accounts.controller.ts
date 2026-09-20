import type { Request, Response } from 'express'
import { getObjectStream } from '../../config/r2'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import {
  createEntry,
  deleteEntry,
  getEntry,
  listAdvances,
  listEntries,
  listExpenseNames,
  updateEntry,
} from './entry.service'
import type { EntryKind } from './accounts.constants'
import {
  createFinalBill,
  deleteFinalBill,
  getFinalBill,
  getFinalBillSlot,
  listFinalBills,
  listKnownUnits,
  listReceivableFinalBills,
  updateFinalBill,
} from './final-bill.service'
import {
  getLabourReceivable,
  listLabourReceivables,
  listReceivableLabourCsds,
} from './labour-receivable.service'
import { getCashSummary } from './cash.service'
import { getOverview, profitAndLoss } from './report.service'
import type {
  CashSummaryQuery,
  CreateEntryInput,
  ExpenseNamesQuery,
  FinalBillInput,
  FinalBillSlotQuery,
  ListAdvancesQuery,
  ListEntriesQuery,
  ListFinalBillsQuery,
  ListLabourReceivablesQuery,
  OverviewQuery,
  ProfitLossQuery,
  TripOptionsQuery,
  UpdateEntryInput,
  UpdateFinalBillInput,
  UpdateWalletInput,
  VendorBillDetailQuery,
  VendorBillsQuery,
  VoucherBody,
  WalletInput,
} from './accounts.validation'
import { attachVoucher, clearVoucher, findVoucher } from './voucher.service'
import { getVendorBillDetail, listTripOptions, listVendorBills } from './vendor-bill.service'
import {
  createWallet,
  listWallets,
  removeWallet,
  updateWallet,
} from './wallet.service'

function actorFrom(req: Request): UserDocument {
  if (!req.user) {
    throw new AppError(403, 'Profile not found. Sync the account first.')
  }
  return req.user
}

function idFrom(req: Request): string {
  const params = req.validated?.params as { id?: string } | undefined
  if (!params?.id) {
    throw new AppError(400, 'Invalid id.')
  }
  return params.id
}

function bodyOf<T>(req: Request): T {
  return req.validated?.body as T
}

function queryOf<T>(req: Request): T {
  return req.validated?.query as T
}

function pageMeta(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
}

const KIND_NOUNS: Record<EntryKind, string> = {
  Deposit: 'Deposit',
  Transfer: 'Transfer',
  Expense: 'Expense',
  Advance: 'Advance',
  AdvanceReturn: 'Advance return',
  AdvanceAdjust: 'Advance adjustment',
  TripAdvance: 'Trip advance',
  VendorPayment: 'Vendor payment',
}

// --- Overview and reports -------------------------------------------------

export async function getAccountsOverview(req: Request, res: Response): Promise<void> {
  const { today } = queryOf<OverviewQuery>(req)
  sendResponse(res, { statusCode: 200, message: 'Accounts overview retrieved', data: await getOverview(today) })
}

export async function getProfitLoss(req: Request, res: Response): Promise<void> {
  const { from, to } = queryOf<ProfitLossQuery>(req)
  sendResponse(res, { statusCode: 200, message: 'Profit and loss retrieved', data: await profitAndLoss(from, to) })
}

export async function getCash(req: Request, res: Response): Promise<void> {
  const { from, to, group } = queryOf<CashSummaryQuery>(req)
  sendResponse(res, { statusCode: 200, message: 'Cash summary retrieved', data: await getCashSummary(from, to, group) })
}

// --- Wallets -----------------------------------------------

export async function getWallets(_req: Request, res: Response): Promise<void> {
  sendResponse(res, { statusCode: 200, message: 'Wallets retrieved', data: await listWallets() })
}

export async function postWallet(req: Request, res: Response): Promise<void> {
  const wallet = await createWallet(bodyOf<WalletInput>(req), actorFrom(req))
  sendResponse(res, { statusCode: 201, message: `${wallet.name} added`, data: wallet })
}

export async function patchWallet(req: Request, res: Response): Promise<void> {
  const wallet = await updateWallet(idFrom(req), bodyOf<UpdateWalletInput>(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${wallet.name} updated`, data: wallet })
}

export async function deleteWallet(req: Request, res: Response): Promise<void> {
  const result = await removeWallet(idFrom(req), actorFrom(req))
  sendResponse(res, {
    statusCode: 200,
    message: result.outcome === 'deleted' ? 'Wallet deleted' : 'Wallet closed — its history is kept',
    data: result,
  })
}

// --- Entries --------------------------------------------------------------

export async function getEntries(req: Request, res: Response): Promise<void> {
  const query = queryOf<ListEntriesQuery>(req)
  const { records, totals } = await listEntries(query)
  sendResponse(res, {
    statusCode: 200,
    message: 'Entries retrieved',
    data: { records, totals },
    meta: pageMeta(query.page, query.limit, totals.total),
  })
}

export async function getEntryById(req: Request, res: Response): Promise<void> {
  sendResponse(res, { statusCode: 200, message: 'Entry retrieved', data: await getEntry(idFrom(req)) })
}

export async function postEntry(req: Request, res: Response): Promise<void> {
  const input = bodyOf<CreateEntryInput>(req)
  const { entry, replayed } = await createEntry(input, actorFrom(req))
  sendResponse(res, {
    statusCode: replayed ? 200 : 201,
    message: `${KIND_NOUNS[entry.kind]} ${entry.entryNumber} ${replayed ? 'was already saved' : 'saved'}`,
    data: entry,
  })
}

export async function patchEntry(req: Request, res: Response): Promise<void> {
  const entry = await updateEntry(idFrom(req), bodyOf<UpdateEntryInput>(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${entry.entryNumber} updated`, data: entry })
}

export async function removeEntry(req: Request, res: Response): Promise<void> {
  const result = await deleteEntry(idFrom(req))
  sendResponse(res, { statusCode: 200, message: `${result.entryNumber} deleted`, data: result })
}

/**
 * The voucher or invoice behind an entry, arriving off a disk or off the
 * scanner on this desk.
 *
 * A separate call from the one that wrote the entry, because the object key
 * contains the entry id — the ordering a gate pass's three calls and a
 * vehicle's photo both have.
 */
export async function postEntryVoucher(req: Request, res: Response): Promise<void> {
  const file = req.file
  if (!file) {
    throw new AppError(400, 'Choose or scan the voucher to upload.')
  }

  const body = (req.validated?.body ?? { pageCount: null }) as VoucherBody

  const entry = await attachVoucher(idFrom(req), file, body.pageCount ?? null, actorFrom(req))
  sendResponse(res, {
    statusCode: 200,
    message: `Voucher attached to ${entry.entryNumber}`,
    data: entry,
  })
}

export async function deleteEntryVoucher(req: Request, res: Response): Promise<void> {
  const entry = await clearVoucher(idFrom(req))
  sendResponse(res, {
    statusCode: 200,
    message: `Voucher removed from ${entry.entryNumber}`,
    data: entry,
  })
}

/**
 * Streams the voucher.
 *
 * The bucket never serves this object — a voucher carries a supplier's name, an
 * amount and often a signature — so the route re-checks authentication and role
 * and pipes the bytes itself, exactly as a gate pass scan, a vendor document
 * and a signed challan copy do.
 */
export async function getEntryVoucherFile(req: Request, res: Response): Promise<void> {
  const ref = await findVoucher(idFrom(req))
  const object = await getObjectStream(ref.key)

  res.setHeader('Content-Type', object.contentType ?? ref.mimeType)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Disposition', `inline; filename="${ref.originalName.replace(/"/g, '')}"`)
  if (object.contentLength !== undefined) {
    res.setHeader('Content-Length', String(object.contentLength))
  }

  object.body.on('error', () => res.destroy())
  object.body.pipe(res)
}

export async function getExpenseNames(req: Request, res: Response): Promise<void> {
  const { q } = queryOf<ExpenseNamesQuery>(req)
  sendResponse(res, { statusCode: 200, message: 'Expense names retrieved', data: await listExpenseNames(q) })
}

export async function getAdvances(req: Request, res: Response): Promise<void> {
  const query = queryOf<ListAdvancesQuery>(req)
  const { records, totals } = await listAdvances(query)
  sendResponse(res, {
    statusCode: 200,
    message: 'Advances retrieved',
    data: { records, totals },
    meta: pageMeta(query.page, query.limit, totals.total),
  })
}

// --- Vendor trip bills ----------------------------------------------------

export async function getVendorBills(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor trip bills retrieved',
    data: await listVendorBills(queryOf<VendorBillsQuery>(req)),
  })
}

export async function getVendorBill(req: Request, res: Response): Promise<void> {
  const params = req.validated?.params as { vendorId: string }
  const query = queryOf<VendorBillDetailQuery>(req)
  sendResponse(res, {
    statusCode: 200,
    message: 'Vendor trip bill retrieved',
    data: await getVendorBillDetail(params.vendorId, { year: query.year, month: query.month }),
  })
}

export async function getTripOptions(req: Request, res: Response): Promise<void> {
  const { q } = queryOf<TripOptionsQuery>(req)
  sendResponse(res, { statusCode: 200, message: 'Trips retrieved', data: await listTripOptions(q) })
}

// --- Walton final bills ---------------------------------------------------

export async function getFinalBills(req: Request, res: Response): Promise<void> {
  const query = queryOf<ListFinalBillsQuery>(req)
  const { records, totals } = await listFinalBills(query)
  sendResponse(res, {
    statusCode: 200,
    message: 'Final bills retrieved',
    data: { records, totals },
    meta: pageMeta(query.page, query.limit, totals.total),
  })
}

export async function getFinalBillById(req: Request, res: Response): Promise<void> {
  sendResponse(res, { statusCode: 200, message: 'Final bill retrieved', data: await getFinalBill(idFrom(req)) })
}

export async function getSlot(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Billing slot retrieved',
    data: await getFinalBillSlot(queryOf<FinalBillSlotQuery>(req)),
  })
}

export async function getUnits(_req: Request, res: Response): Promise<void> {
  sendResponse(res, { statusCode: 200, message: 'Units retrieved', data: await listKnownUnits() })
}

export async function getReceivable(_req: Request, res: Response): Promise<void> {
  sendResponse(res, { statusCode: 200, message: 'Receivable final bills retrieved', data: await listReceivableFinalBills() })
}

export async function postFinalBill(req: Request, res: Response): Promise<void> {
  const bill = await createFinalBill(bodyOf<FinalBillInput>(req), actorFrom(req))
  sendResponse(res, { statusCode: 201, message: `Final bill for ${bill.unit} · ${bill.periodLabel} saved`, data: bill })
}

export async function patchFinalBill(req: Request, res: Response): Promise<void> {
  const bill = await updateFinalBill(idFrom(req), bodyOf<UpdateFinalBillInput>(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `Final bill for ${bill.unit} · ${bill.periodLabel} updated`, data: bill })
}

export async function removeFinalBill(req: Request, res: Response): Promise<void> {
  const result = await deleteFinalBill(idFrom(req))
  sendResponse(res, { statusCode: 200, message: `Final bill for ${result.label} deleted`, data: result })
}


// ---------------------------------------------------------------------------
// Walton labour bill receivables
// ---------------------------------------------------------------------------

export async function getLabourReceivables(req: Request, res: Response): Promise<void> {
  const query = queryOf<ListLabourReceivablesQuery>(req)
  const { records, totals, totalPages } = await listLabourReceivables(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Labour bill receivables retrieved',
    data: { records, totals },
    // Paged in memory, so the page count comes back with the answer rather
    // than from a separate count.
    meta: { page: query.page, limit: query.limit, total: totals.total, totalPages },
  })
}

export async function getLabourReceivableById(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Labour bill receivable retrieved',
    data: await getLabourReceivable(idFrom(req)),
  })
}

export async function getLabourReceivableOptions(_req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Receivable labour bill CSDs retrieved',
    data: await listReceivableLabourCsds(),
  })
}
