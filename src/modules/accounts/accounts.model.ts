import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import {
  DEPOSIT_SOURCES,
  ENTRY_KINDS,
  MAX_ACCOUNT_AMOUNT,
  SETTLEMENT_STATUSES,
  WALLET_KINDS,
} from './accounts.constants'

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

/**
 * Where money is held — the cash box, a bank account, a bKash number.
 *
 * There is no balance field. A balance is what the entries add up to, and a
 * stored one would be a second answer to that question that a failed write
 * could make disagree with the first.
 */
const walletSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /** Lower-cased and space-collapsed, so "Cash in Hand" cannot be added twice. */
    nameKey: { type: String, required: true, unique: true },
    kind: { type: String, enum: WALLET_KINDS, required: true },
    accountNumber: { type: String, default: '', trim: true, maxlength: 60 },
    note: { type: String, default: '', trim: true, maxlength: 300 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

export type Wallet = InferSchemaType<typeof walletSchema>
export const WalletModel = model('AccountsWallet', walletSchema)
export type WalletDocument = InstanceType<typeof WalletModel>

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const vendorCopySchema = new Schema(
  {
    vendorCode: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false },
)

/**
 * The trip an advance was paid against, as it read at the time. The id is how
 * the advance is found from the trip; the copy is what the entry says even if
 * the trip is later corrected.
 */
const tripCopySchema = new Schema(
  {
    tripNumber: { type: String, required: true },
    tripDate: { type: Date, required: true },
    registrationNo: { type: String, default: '' },
    driverName: { type: String, default: '' },
  },
  { _id: false },
)

const periodSchema = new Schema(
  {
    year: { type: Number, required: true, min: 2000, max: 2100 },
    month: { type: Number, required: true, min: 1, max: 12 },
  },
  { _id: false },
)

/**
 * One movement of money. One collection rather than one per kind, because the
 * questions asked of it — a wallet's balance, a day's cash book, a month's
 * spending — cross every kind, and a union of eight collections in front of
 * each would be eight queries where one index answers.
 *
 * Which fields a kind carries is decided by `accounts.validation.ts` and the
 * entry service; the schema holds them all as optional.
 */
const entrySchema = new Schema(
  {
    /** `EXP-2026-00042` — see `formatEntryNumber`. */
    entryNumber: { type: String, required: true, unique: true },
    kind: { type: String, enum: ENTRY_KINDS, required: true },
    /** A calendar day at UTC midnight, like every day in this system. */
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 1, max: MAX_ACCOUNT_AMOUNT },

    /** The wallet money left or arrived in. Null only for an advance accepted as an expense. */
    walletId: { type: Schema.Types.ObjectId, ref: 'AccountsWallet', default: null },
    /** A transfer's destination. */
    toWalletId: { type: Schema.Types.ObjectId, ref: 'AccountsWallet', default: null },

    /** Who money went to or came from, in the words of whoever typed it. */
    party: { type: String, default: '', trim: true, maxlength: 120 },
    partyPhone: { type: String, default: '', trim: true, maxlength: 32 },
    /** A cheque, voucher or transaction number. */
    reference: { type: String, default: '', trim: true, maxlength: 80 },
    note: { type: String, default: '', trim: true, maxlength: 500 },

    // Deposit
    source: { type: String, enum: [...DEPOSIT_SOURCES, null], default: null },
    finalBillId: { type: Schema.Types.ObjectId, ref: 'WaltonFinalBill', default: null },

    /**
     * What an expense was for, typed by whoever recorded it — there is no list
     * of categories to choose from. An advance accepted as an expense carries
     * one too. Reports group on it ignoring case.
     */
    expenseName: { type: String, default: '', trim: true, maxlength: 80 },

    // Advance: what it was for, and how much of it has been accounted for
    purpose: { type: String, default: '', trim: true, maxlength: 200 },
    /** Returns and adjustments against this advance. Derived by `refreshAdvanceSettlement`. */
    settledAmount: { type: Number, default: 0, min: 0 },
    settlementStatus: { type: String, enum: [...SETTLEMENT_STATUSES, null], default: null },

    // Return or adjustment: the advance it settles
    advanceId: { type: Schema.Types.ObjectId, ref: 'AccountsEntry', default: null },
    advanceNumber: { type: String, default: '' },

    // Trip advance and vendor payment
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', default: null },
    vendor: { type: vendorCopySchema, default: null },
    tripId: { type: Schema.Types.ObjectId, ref: 'Delivery', default: null },
    trip: { type: tripCopySchema, default: null },
    period: { type: periodSchema, default: null },

    /**
     * The browser's key for this entry, made when the form opened. A second
     * press of Save — or a retry after a cold-start timeout — finds the entry
     * the first one made instead of paying a vendor twice.
     */
    submissionKey: { type: String, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/** The ledger and the cash book: newest first, optionally by kind. */
entrySchema.index({ date: -1, createdAt: -1 })
entrySchema.index({ kind: 1, date: -1 })
/** A wallet's balance and its statement, from both sides of a transfer. */
entrySchema.index({ walletId: 1, date: -1 })
entrySchema.index({ toWalletId: 1, date: -1 })
/** A vendor's advances and payments. */
entrySchema.index({ vendorId: 1, kind: 1 })
entrySchema.index({ tripId: 1 })
entrySchema.index({ kind: 1, 'period.year': 1, 'period.month': 1 })
/** Settlements of one advance, payments of one final bill. */
entrySchema.index({ advanceId: 1 })
entrySchema.index({ finalBillId: 1 })
/** Open advances. */
entrySchema.index({ kind: 1, settlementStatus: 1, date: -1 })
entrySchema.index({ kind: 1, expenseName: 1, date: -1 })
/** A replayed save is found here rather than written again. */
entrySchema.index(
  { createdBy: 1, submissionKey: 1 },
  { unique: true, partialFilterExpression: { submissionKey: { $type: 'string' } } },
)

export type Entry = InferSchemaType<typeof entrySchema>
export const EntryModel = model('AccountsEntry', entrySchema)
export type EntryDocument = InstanceType<typeof EntryModel>

// ---------------------------------------------------------------------------
// Walton final bills
// ---------------------------------------------------------------------------

/**
 * What Walton agreed to pay for a unit's month, after its audit.
 *
 * The Excel bill is what the office asked for; this is what the audit left.
 * They differ — a row disallowed, a rate corrected — which is why this is typed
 * rather than copied, and why the Excel bills for the same unit and month are
 * read beside it so the difference is on screen. This figure, and only this
 * figure, is income in the profit and loss.
 */
const finalBillSchema = new Schema(
  {
    year: { type: Number, required: true, min: 2000, max: 2100 },
    month: { type: Number, required: true, min: 1, max: 12 },
    unit: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
    /** `comparisonKey` of the unit — the Bill module's own — so W.F.R and WFR are one unit. */
    unitKey: { type: String, required: true },

    finalAmount: { type: Number, required: true, min: 0, max: MAX_ACCOUNT_AMOUNT },
    /** Walton's own reference for the approved bill. */
    referenceNo: { type: String, default: '', trim: true, maxlength: 80 },
    /** The day the final figure arrived. */
    receivedOn: { type: Date, default: null },
    note: { type: String, default: '', trim: true, maxlength: 500 },

    /** Deposits recorded against this bill. Derived by `refreshFinalBillReceipts`. */
    receivedAmount: { type: Number, default: 0, min: 0 },
    paymentStatus: { type: String, enum: SETTLEMENT_STATUSES, default: 'Open' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/** One final figure per unit per month. Two would make "what was this month's income" a question with two answers. */
finalBillSchema.index({ year: 1, month: 1, unitKey: 1 }, { unique: true })
finalBillSchema.index({ year: -1, month: -1 })
finalBillSchema.index({ paymentStatus: 1, year: -1, month: -1 })

export type FinalBill = InferSchemaType<typeof finalBillSchema>
export const FinalBillModel = model('WaltonFinalBill', finalBillSchema)
export type FinalBillDocument = InstanceType<typeof FinalBillModel>
