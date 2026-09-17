import * as z from 'zod'
import {
  DEPOSIT_SOURCES,
  MAX_ACCOUNT_AMOUNT,
  MAX_ACCOUNTS_PAGE_SIZE,
  SETTLEMENT_STATUSES,
  VENDOR_BILL_STATUSES,
  WALLET_KINDS,
} from './accounts.constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const idParamSchema = z.object({ id: objectId })
export type IdParam = z.infer<typeof idParamSchema>

/**
 * A calendar day, parsed to UTC midnight rather than through `new Date(value)`
 * — the treatment every day in this codebase gets.
 */
const calendarDay = z
  .string({ error: 'Choose a date.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), 'That is not a real date.')

const optionalDay = z.preprocess(
  (value) => (value === '' || value === undefined || value === null ? undefined : value),
  calendarDay.optional(),
)

const amount = z.coerce
  .number({ error: 'Enter an amount.' })
  .int('Enter the amount in whole taka.')
  .min(1, 'The amount must be at least ৳1.')
  .max(MAX_ACCOUNT_AMOUNT, 'That amount is too large.')

const month = z.coerce.number({ error: 'Choose a month.' }).int().min(1, 'Choose a month.').max(12, 'Choose a month.')
const year = z.coerce
  .number({ error: 'Choose a year.' })
  .int()
  .min(2020, 'That year is too early.')
  .max(2100, 'That year is too far ahead.')

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`).default('')

/** Optional in a query string, where an empty value means "any". */
const optionalId = z.preprocess((value) => (value === '' ? undefined : value), objectId.optional())

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export const walletSchema = z.object({
  name: z.string().trim().min(1, 'Name the wallet.').max(80, 'A wallet name is at most 80 characters.'),
  kind: z.enum(WALLET_KINDS, { error: 'Choose what kind of wallet this is.' }),
  accountNumber: text(60),
  note: text(300),
})
export type WalletInput = z.infer<typeof walletSchema>

export const updateWalletSchema = walletSchema.partial().extend({ isActive: z.boolean().optional() })
export type UpdateWalletInput = z.infer<typeof updateWalletSchema>


// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * What every entry carries. There is no entry number, no settled amount, no
 * vendor or trip copy in any body — those are allocated
 * or read off the record an id points at, so a request cannot describe a
 * vendor or a trip other than the one it names.
 */
const common = {
  date: calendarDay,
  amount,
  reference: text(80),
  note: text(500),
}

const wallet = objectId.describe('walletId')

/** What an expense was for, typed freely. Runs of spaces collapse, so "Office  rent" and "Office rent" are one name. */
const expenseName = z
  .string({ error: 'Write what the expense was for.' })
  .trim()
  .min(1, 'Write what the expense was for.')
  .max(80, 'Keep the expense name under 80 characters.')
  .transform((value) => value.replace(/\s+/g, ' '))

const depositShape = z.object({
  kind: z.literal('Deposit'),
  ...common,
  walletId: wallet,
  /**
   * A deposit is money added into cash; where it came from is not asked. The
   * source is written by the service — a Walton payment when it names a final
   * bill, otherwise a plain deposit — and is accepted here only so an older
   * client that still sends one is not refused.
   */
  source: z.enum(DEPOSIT_SOURCES).optional(),
  party: text(120),
  finalBillId: objectId.nullable().default(null),
})

const transferShape = z.object({
  kind: z.literal('Transfer'),
  ...common,
  walletId: wallet,
  toWalletId: objectId,
})

const expenseShape = z.object({
  kind: z.literal('Expense'),
  ...common,
  walletId: wallet,
  expenseName,
  party: text(120),
})

const advanceShape = z.object({
  kind: z.literal('Advance'),
  ...common,
  walletId: wallet,
  party: z.string().trim().min(1, 'Say who the advance was given to.').max(120),
  partyPhone: text(32),
  purpose: text(200),
})

const advanceReturnShape = z.object({
  kind: z.literal('AdvanceReturn'),
  ...common,
  walletId: wallet,
  advanceId: objectId,
})

const advanceAdjustShape = z.object({
  kind: z.literal('AdvanceAdjust'),
  ...common,
  advanceId: objectId,
  expenseName,
})

const tripAdvanceShape = z.object({
  kind: z.literal('TripAdvance'),
  ...common,
  walletId: wallet,
  tripId: objectId,
  party: text(120),
})

const vendorPaymentShape = z.object({
  kind: z.literal('VendorPayment'),
  ...common,
  walletId: wallet,
  vendorId: objectId,
  year,
  month,
  party: text(120),
})

const entryShapes = [
  depositShape,
  transferShape,
  expenseShape,
  advanceShape,
  advanceReturnShape,
  advanceAdjustShape,
  tripAdvanceShape,
  vendorPaymentShape,
] as const

function refineTransfer(value: { kind: string; walletId?: string; toWalletId?: string }, ctx: z.RefinementCtx) {
  if (value.kind === 'Transfer' && value.walletId === value.toWalletId) {
    ctx.addIssue({ code: 'custom', path: ['toWalletId'], message: 'Choose a different wallet to move the money to.' })
  }
}

export const createEntrySchema = z
  .discriminatedUnion('kind', entryShapes)
  .and(z.object({ submissionKey: z.string().trim().min(8).max(80) }))
  .superRefine(refineTransfer)
export type CreateEntryInput = z.infer<typeof createEntrySchema>

/** A correction carries the whole entry again. Its kind must be the kind it already is. */
export const updateEntrySchema = z.discriminatedUnion('kind', entryShapes).superRefine(refineTransfer)
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>
export type EntryInput = z.infer<(typeof entryShapes)[number]>

const page = z.coerce.number().int().min(1).default(1)
const limit = (fallback: number) => z.coerce.number().int().min(1).max(MAX_ACCOUNTS_PAGE_SIZE).default(fallback)

export const listEntriesQuerySchema = z.object({
  page,
  limit: limit(20),
  /** A kind, or `in` / `out` for every kind that moves money that way. */
  kind: z
    .enum([
      'all',
      'in',
      'out',
      'Deposit',
      'Transfer',
      'Expense',
      'Advance',
      'AdvanceReturn',
      'AdvanceAdjust',
      'TripAdvance',
      'VendorPayment',
    ])
    .default('all'),
  walletId: optionalId,
  vendorId: optionalId,
  /** One expense name, matched ignoring case. */
  expenseName: z.string().trim().max(80).default(''),
  from: optionalDay,
  to: optionalDay,
  search: z.string().trim().max(80).default(''),
})
export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>

export const listAdvancesQuerySchema = z.object({
  page,
  limit: limit(12),
  status: z.enum(['all', 'outstanding', ...SETTLEMENT_STATUSES]).default('outstanding'),
  search: z.string().trim().max(80).default(''),
})
export type ListAdvancesQuery = z.infer<typeof listAdvancesQuerySchema>

// ---------------------------------------------------------------------------
// Vendor trip bills
// ---------------------------------------------------------------------------

export const vendorBillsQuerySchema = z.object({
  year,
  month,
  status: z.enum(['all', 'due', ...VENDOR_BILL_STATUSES]).default('all'),
  search: z.string().trim().max(80).default(''),
})
export type VendorBillsQuery = z.infer<typeof vendorBillsQuerySchema>

export const vendorParamSchema = z.object({ vendorId: objectId })
export const vendorBillDetailQuerySchema = z.object({ year, month })
export type VendorBillDetailQuery = z.infer<typeof vendorBillDetailQuerySchema>

export const expenseNamesQuerySchema = z.object({ q: z.string().trim().max(80).default('') })
export type ExpenseNamesQuery = z.infer<typeof expenseNamesQuerySchema>

export const tripOptionsQuerySchema = z.object({ q: z.string().trim().max(40).default('') })
export type TripOptionsQuery = z.infer<typeof tripOptionsQuerySchema>

// ---------------------------------------------------------------------------
// Walton final bills
// ---------------------------------------------------------------------------

const unit = z
  .string({ error: 'Enter the unit.' })
  .trim()
  .min(1, 'Enter the unit.')
  .max(24, 'A unit is at most 24 characters.')
  .regex(/[A-Za-z0-9]/, 'Enter the unit.')

export const finalBillSchema = z.object({
  year,
  month,
  unit,
  finalAmount: z.coerce
    .number({ error: 'Enter the final bill amount.' })
    .int('Enter the amount in whole taka.')
    .min(0, 'The amount cannot be negative.')
    .max(MAX_ACCOUNT_AMOUNT, 'That amount is too large.'),
  referenceNo: text(80),
  receivedOn: calendarDay.nullable().default(null),
  note: text(500),
})
export type FinalBillInput = z.infer<typeof finalBillSchema>

export const updateFinalBillSchema = finalBillSchema
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'Nothing to change.')
export type UpdateFinalBillInput = z.infer<typeof updateFinalBillSchema>

export const listFinalBillsQuerySchema = z.object({
  page,
  limit: limit(24),
  year: z.preprocess((value) => (value === '' ? undefined : value), year.optional()),
  unit: z.string().trim().max(24).default(''),
  status: z.enum(['all', ...SETTLEMENT_STATUSES]).default('all'),
})
export type ListFinalBillsQuery = z.infer<typeof listFinalBillsQuerySchema>

export const finalBillSlotQuerySchema = z.object({ year, month, unit })
export type FinalBillSlotQuery = z.infer<typeof finalBillSlotQuerySchema>

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const periodString = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month in YYYY-MM form.')
  .transform((value) => ({ year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)) }))

export const profitLossQuerySchema = z.object({ from: periodString, to: periodString })
export type ProfitLossQuery = z.infer<typeof profitLossQuerySchema>

export const cashSummaryQuerySchema = z.object({
  from: periodString,
  to: periodString,
  group: z.enum(['month', 'year']).default('month'),
})
export type CashSummaryQuery = z.infer<typeof cashSummaryQuerySchema>

/** The viewer's own calendar day, because "this month" in Dhaka is not UTC's for six hours of it. */
export const overviewQuerySchema = z.object({
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default(() => new Date().toISOString().slice(0, 10)),
})
export type OverviewQuery = z.infer<typeof overviewQuerySchema>
