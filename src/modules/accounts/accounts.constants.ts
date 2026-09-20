import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Accounts vocabulary. The frontend mirrors
 * this file at `LBTS-Frontend/src/features/accounts/types/index.ts`, which adds
 * display metadata and nothing else. Change one, change both.
 *
 * Accounts reads exactly one figure out of the rest of the system: a trip's
 * bill — the lorry's rent and the labour bill, entered on the trip. Everything
 * else here is typed into Accounts itself: money deposited, moved, spent and
 * advanced, and the final amount Walton agreed to pay for a unit's month after
 * its audit. Income is that final bill and nothing else, which is why profit
 * is only ever as complete as the final bills on record.
 */

// --- Wallets -------------------------------------------------------------------

/** Where money is held. A wallet's balance is derived from its entries, never stored. */
export const WALLET_KINDS = ['Cash', 'Bank', 'Mobile Banking'] as const
export type WalletKind = (typeof WALLET_KINDS)[number]

// --- Entries -------------------------------------------------------------------

/**
 * Every movement of money is one entry, and its kind decides which way it goes.
 *
 * - `Deposit` — money added: a Walton payment, the owner putting money in, a loan.
 * - `Transfer` — money moved between two wallets. Neither in nor out overall.
 * - `Expense` — any office expense.
 * - `Advance` — money handed to anybody against a later settlement.
 * - `AdvanceReturn` — part of an advance given back in cash.
 * - `AdvanceAdjust` — part of an advance spent and accepted as an expense; no cash moves.
 * - `TripAdvance` — money paid to a vendor against one trip's bill.
 * - `VendorPayment` — a vendor's monthly trip bill paid.
 */
export const ENTRY_KINDS = [
  'Deposit',
  'Transfer',
  'Expense',
  'Advance',
  'AdvanceReturn',
  'AdvanceAdjust',
  'TripAdvance',
  'VendorPayment',
] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]

export type EntryDirection = 'In' | 'Out' | 'Transfer' | 'None'

/** Which way an entry moves a wallet. `None` touches no wallet at all. */
export function entryDirection(kind: EntryKind): EntryDirection {
  switch (kind) {
    case 'Deposit':
    case 'AdvanceReturn':
      return 'In'
    case 'Transfer':
      return 'Transfer'
    case 'AdvanceAdjust':
      return 'None'
    default:
      return 'Out'
  }
}

export const MONEY_IN_KINDS: readonly EntryKind[] = ENTRY_KINDS.filter((kind) => entryDirection(kind) === 'In')
export const MONEY_OUT_KINDS: readonly EntryKind[] = ENTRY_KINDS.filter((kind) => entryDirection(kind) === 'Out')

/**
 * Money that comes back after going out. It raises a wallet's balance like any
 * money in, but in every in-and-out figure it **reduces money out** rather than
 * adding to money in: an advance of 3,000 with 500 returned is 2,500 out and
 * nothing in. Counting the return as money in would inflate both sides and make
 * the office look as if it had taken in cash it only got back.
 */
export const OUT_REDUCING_KINDS: readonly EntryKind[] = ['AdvanceReturn']

/** Money in that is new money — everything in, less what only comes back. */
export const CASH_IN_KINDS: readonly EntryKind[] = MONEY_IN_KINDS.filter((kind) => !OUT_REDUCING_KINDS.includes(kind))

export interface CashFlowParts {
  deposits: number
  transfersIn: number
  advanceReturns: number
  vendorPayments: number
  tripAdvances: number
  advances: number
  expenses: number
  transfersOut: number
}

export interface CashFlow {
  moneyIn: number
  /** Advances given less the cash returned against them. */
  advancesNet: number
  moneyOut: number
  net: number
}

/**
 * Money in, money out and the difference, with advance returns taken off the
 * advances rather than added to money in. The difference is the same either
 * way — only the split between the two sides changes.
 */
export function cashFlowOf(parts: CashFlowParts): CashFlow {
  const moneyIn = parts.deposits + parts.transfersIn
  const advancesNet = parts.advances - parts.advanceReturns
  const moneyOut = parts.vendorPayments + parts.tripAdvances + advancesNet + parts.expenses + parts.transfersOut
  return { moneyIn, advancesNet, moneyOut, net: moneyIn - moneyOut }
}

/**
 * **Every transaction in Accounts runs through cash.** Money is added into
 * cash, every expense, advance, trip advance and vendor payment leaves from
 * cash, an advance comes back into cash, and a transfer moves money between
 * two cash wallets and nowhere else.
 *
 * A bank or mobile wallet has exactly one use: receiving a **Walton payment** —
 * against a final bill, or against one CSD of a month's labour bill. Nothing is
 * spent from one and nothing is moved into or out of one.
 *
 * The two kinds of Walton payment are one rule rather than two, because they
 * are the same event: Walton settling a claim. Which claim it settles decides
 * what the payment is recorded against, not how it is allowed to arrive.
 */
export function requiresCashWallet(kind: EntryKind, againstWaltonBill: boolean): boolean {
  return !(kind === 'Deposit' && againstWaltonBill)
}

/**
 * A MongoDB filter for every entry that could only have been made with a cash
 * wallet — everything except a Walton payment — so a wallet holding any of them
 * cannot be turned into a bank or mobile wallet.
 */
export const CASH_ENTRY_FILTER = {
  $nor: [
    { kind: 'Deposit' as EntryKind, finalBillId: { $ne: null } },
    { kind: 'Deposit' as EntryKind, labourBillId: { $ne: null } },
  ],
}

/** Kinds that name a wallet, and the one that names a second. */
export function entryUsesWallet(kind: EntryKind): boolean {
  return entryDirection(kind) !== 'None'
}

export const ENTRY_PREFIXES: Record<EntryKind, string> = {
  Deposit: 'DEP',
  Transfer: 'TRF',
  Expense: 'EXP',
  Advance: 'ADV',
  AdvanceReturn: 'ARN',
  AdvanceAdjust: 'AAJ',
  TripAdvance: 'TAD',
  VendorPayment: 'VPY',
}

/**
 * `EXP-2026-00042`: the forty-second expense dated in 2026. Scoped by the
 * entry's own date rather than the day it was typed, as a bill number is.
 */
export function formatEntryNumber(kind: EntryKind, year: number, sequence: number): string {
  return `${ENTRY_PREFIXES[kind]}-${year}-${String(sequence).padStart(5, '0')}`
}

export function entryCounterKey(kind: EntryKind, year: number): string {
  return `accounts:${ENTRY_PREFIXES[kind]}:${year}`
}

/** Where deposited money came from. */
export const DEPOSIT_SOURCES = ['Walton Bill', 'Owner Investment', 'Loan', 'Other'] as const
export type DepositSource = (typeof DEPOSIT_SOURCES)[number]

// --- Settlement ----------------------------------------------------------------

/**
 * How much of an advance, or of a Walton final bill, has been accounted for.
 * Derived from the amounts and stored only so a list can filter on it.
 */
export const SETTLEMENT_STATUSES = ['Open', 'Partial', 'Settled'] as const
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number]

export function settlementStatusFor(amount: number, settled: number): SettlementStatus {
  if (settled <= 0) {
    return 'Open'
  }
  return settled >= amount ? 'Settled' : 'Partial'
}

/** What is left of an amount, never below zero. */
export function outstandingOf(amount: number, settled: number): number {
  return Math.max(0, roundTaka(amount - settled))
}

// --- Vendor trip bills ---------------------------------------------------------

/**
 * Where a vendor's month stands.
 *
 * - `No Bill` — no trip in the month has a bill entered and nothing was paid.
 * - `Unpaid` / `Partial` / `Paid` — what it sounds like, after advances.
 * - `Overpaid` — advances and payments exceed the bills entered. Ordinary
 *   while a bill is still to be entered after an advance; worth a look after.
 */
export const VENDOR_BILL_STATUSES = ['No Bill', 'Unpaid', 'Partial', 'Paid', 'Overpaid'] as const
export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number]

export interface VendorBillFigures {
  /** Trip rent plus labour bill over the month's trips. */
  totalBill: number
  /** Trip advances against those trips. */
  advance: number
  /** Monthly payments for the month. */
  paid: number
}

/** What is still owed for the month: the bills, less advances, less payments. May be negative. */
export function vendorDueOf(figures: VendorBillFigures): number {
  return roundTaka(figures.totalBill - figures.advance - figures.paid)
}

export function vendorBillStatusFor(figures: VendorBillFigures): VendorBillStatus {
  const settled = figures.advance + figures.paid
  const due = vendorDueOf(figures)

  if (figures.totalBill <= 0 && settled <= 0) {
    return 'No Bill'
  }
  if (due < 0) {
    return 'Overpaid'
  }
  if (due === 0) {
    return 'Paid'
  }
  return settled > 0 ? 'Partial' : 'Unpaid'
}

/** A trip's own bill: rent plus labour, with a blank counting as nothing. */
export function tripBillOf(tripRent: number | null | undefined, labourBill: number | null | undefined): number {
  return (tripRent ?? 0) + (labourBill ?? 0)
}

// --- Periods -------------------------------------------------------------------

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export interface Period {
  year: number
  month: number
}

/** "September 2026". */
export function periodLabel(period: Period): string {
  return `${MONTH_NAMES[period.month - 1] ?? 'Month'} ${period.year}`
}

/** `2026-09` — sortable, and the form a query string carries. */
export function periodKey(period: Period): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`
}

/** A count of months since year zero, so two periods compare and subtract as numbers. */
export function periodIndex(period: Period): number {
  return period.year * 12 + (period.month - 1)
}

export function periodFromIndex(index: number): Period {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

/** The first instant of the month and of the month after it, in UTC — every day here is a UTC calendar day. */
export function periodRange(period: Period): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(period.year, period.month - 1, 1)),
    end: new Date(Date.UTC(period.year, period.month, 1)),
  }
}

/** Every month from `from` to `to` inclusive, oldest first. Empty when they run backwards. */
export function monthsBetween(from: Period, to: Period): Period[] {
  const months: Period[] = []
  for (let index = periodIndex(from); index <= periodIndex(to); index += 1) {
    months.push(periodFromIndex(index))
  }
  return months
}

/**
 * The Bangladesh fiscal year a month belongs to, July to June: September 2026
 * is in July 2026 – June 2027.
 */
export function fiscalYearOf(period: Period): { from: Period; to: Period } {
  const startYear = period.month >= 7 ? period.year : period.year - 1
  return { from: { year: startYear, month: 7 }, to: { year: startYear + 1, month: 6 } }
}

// --- Profit and loss -----------------------------------------------------------

export interface ProfitFigures {
  /** Walton final bills. */
  income: number
  tripRent: number
  labourBill: number
  /** Office expenses, and advances accepted as expenses. */
  officeExpense: number
}

export function totalCostOf(figures: ProfitFigures): number {
  return roundTaka(figures.tripRent + figures.labourBill + figures.officeExpense)
}

export function profitOf(figures: ProfitFigures): number {
  return roundTaka(figures.income - totalCostOf(figures))
}

/** Profit as a share of income, to one decimal place; null when there is no income to divide by. */
export function marginOf(figures: ProfitFigures): number | null {
  if (figures.income <= 0) {
    return null
  }
  return Math.round((profitOf(figures) / figures.income) * 1000) / 10
}

// --- Money ---------------------------------------------------------------------

/** Accounts works in whole taka, like the trip bill it reads. */
export function roundTaka(value: number): number {
  return Math.round(value)
}

/** One entry's ceiling: a hundred crore, far beyond anything real and short of float trouble. */
export const MAX_ACCOUNT_AMOUNT = 1_000_000_000

export const MAX_ACCOUNTS_PAGE_SIZE = 50

/** Trips the advance picker answers with. */
export const MAX_TRIP_OPTIONS = 15

/** Months one profit and loss report may span. */
export const MAX_REPORT_MONTHS = 36

/** Months a cash summary may span — ten years, so it can be read year by year. */
export const MAX_CASH_SUMMARY_MONTHS = 120

// --- Vouchers ------------------------------------------------------------------

/**
 * The paper behind an entry: a fuel bill, a repair invoice, a receipt signed
 * for an advance, a supplier's cash memo.
 *
 * One file per entry, never a queue — a two-sheet invoice is one PDF, which is
 * the same contract a vendor compliance document and a signed challan copy
 * have, and the reason all three share `DocumentScanPanel` on the client.
 *
 * It is attached to the **entry**, not to an expense. Entries are one
 * collection of eight kinds, and the voucher behind a vendor payment is the
 * same piece of paper as the invoice behind an expense — a rule admitting only
 * one kind would be one nobody asked for, and a second collection to hold the
 * others.
 *
 * The two limits and their reasoning are the gate pass scan's: a photograph of
 * a cash memo is an image, a multi-sheet invoice off the feeder is a PDF, and
 * neither is resized past the point where an amount can be read off it.
 */
export const VOUCHER_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
export type VoucherMimeType = (typeof VOUCHER_MIME_TYPES)[number]

export const MAX_VOUCHER_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_VOUCHER_PDF_BYTES = 25 * 1024 * 1024

export function maxVoucherBytesFor(mimeType: string): number {
  return mimeType === 'application/pdf' ? MAX_VOUCHER_PDF_BYTES : MAX_VOUCHER_IMAGE_BYTES
}

// --- Permissions ---------------------------------------------------------------

/**
 * Module-level permissions, as CLAUDE.md asks each module to configure.
 *
 * Accounts is the office's money, so it is narrower than any operating module.
 * `CEO` reads everything — the profit and loss exists for them — and writes
 * nothing. `Admin` and `Manager` keep the books. `OpEx` is out: an Operation
 * Executive enters a trip's bill on the trip, which is what Accounts reads,
 * and has no need to see the office's balances. `Vendor` is in no set.
 */
export const ACCOUNTS_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO']
export const ACCOUNTS_WRITE_ROLES: readonly UserRole[] = ['Admin', 'Manager']
