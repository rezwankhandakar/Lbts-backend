import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { TRIP_DO_ROW_KINDS } from '../trip-do/trip-do.constants'
import { rateCopySchema } from '../trip-do/trip-do.model'
import { BILL_STATUSES } from './bill.constants'

/**
 * A bill: a billing month, a unit, and the Trip DO sheet rows it charges for.
 *
 * The totals are stored, derived from the lines by `refreshBillTotals` after
 * every change and never incremented, so the list of bills can show and sum
 * them without opening every bill.
 */
const billSchema = new Schema(
  {
    /** LBTS-BILL-2026-0007 — see `formatBillNumber`. */
    billNumber: { type: String, required: true, unique: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    /** The unit as the gate passes write it: WFR, WAC. */
    unit: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
    /** `comparisonKey` of the unit, so W.F.R and WFR are one unit. */
    unitKey: { type: String, required: true },
    note: { type: String, default: '', trim: true, maxlength: 400 },

    status: { type: String, enum: BILL_STATUSES, default: 'Draft' },

    lineCount: { type: Number, default: 0, min: 0 },
    tripDoCount: { type: Number, default: 0, min: 0 },
    challanCount: { type: Number, default: 0, min: 0 },
    totalQty: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0 },
    /** Rows nothing priced — the Amount column's blanks, which the total leaves out. */
    unpricedLines: { type: Number, default: 0, min: 0 },

    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/** The list: newest billing period first, filtered by period, unit and status. */
billSchema.index({ year: -1, month: -1, createdAt: -1 })
billSchema.index({ unitKey: 1, year: -1, month: -1 })
billSchema.index({ status: 1, year: -1, month: -1 })

export type Bill = InferSchemaType<typeof billSchema>
export const BillModel = model('Bill', billSchema)
export type BillDocument = InstanceType<typeof BillModel>

/**
 * One row of a bill: a reference to the Trip DO sheet row plus a **copy** of
 * every column the bill prints.
 *
 * A copy, because a bill is a statement of what was charged when it was made,
 * and the sheet row it came from keeps moving — a challan corrected, a gate
 * pass's CSD fixed. `snapshotHash` is what lets the bill notice: a line whose
 * row no longer hashes the same is flagged, and refreshing a draft bill copies
 * the row again. A finalized bill is never rewritten.
 */
const billLineSchema = new Schema(
  {
    billId: { type: Schema.Types.ObjectId, ref: 'Bill', required: true },
    tripDoLineId: { type: Schema.Types.ObjectId, ref: 'TripDoLine', required: true },
    /** The order the row was added, unique within the bill — see `arrangeBillLines`. */
    seq: { type: Number, required: true },

    challanId: { type: Schema.Types.ObjectId, ref: 'Challan', required: true },
    gatePassId: { type: Schema.Types.ObjectId, ref: 'GatePass', default: null },
    kind: { type: String, enum: TRIP_DO_ROW_KINDS, required: true },

    challanNumber: { type: String, required: true },
    challanSlNumber: { type: Number, required: true },
    challanDate: { type: Date, required: true },
    customerName: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    district: { type: String, default: '' },
    thana: { type: String, default: '' },
    locationType: { type: String, default: null },
    receiverMobile: { type: String, default: '' },

    productName: { type: String, required: true },
    productModel: { type: String, default: '' },
    capacity: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    rate: { type: rateCopySchema, default: null },
    /** The row's share of its line's charge — `rowAmountFor` — or null when nothing priced it. */
    amount: { type: Number, default: null },

    tripDo: { type: String, required: true },
    tripDoKey: { type: String, required: true },
    tripDate: { type: Date, required: true },
    gatePassNumber: { type: String, default: '' },
    csd: { type: String, default: '' },
    unit: { type: String, default: '' },
    tripNumbers: { type: [String], default: [] },

    snapshotHash: { type: String, required: true },
    addedAt: { type: Date, required: true },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { versionKey: false },
)

billLineSchema.index({ billId: 1, seq: 1 })
/** A sheet row is on one bill at most. The claim on the row is checked first; this is the floor. */
billLineSchema.index({ tripDoLineId: 1 }, { unique: true })

export type BillLine = InferSchemaType<typeof billLineSchema>
export const BillLineModel = model('BillLine', billLineSchema)
export type BillLineDocument = InstanceType<typeof BillLineModel>
