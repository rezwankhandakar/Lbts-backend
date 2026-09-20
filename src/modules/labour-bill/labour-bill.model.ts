import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { LABOUR_BILL_STATUSES } from './labour-bill.constants'

/**
 * A Walton Labour Bill: a billing month, and the challan product lines whose
 * handling it charges for.
 *
 * **A month is the whole of the slot.** The office bills each CSD separately,
 * but the CSD is a fact about a row's gate pass rather than something to ask an
 * operator to restate — so the sheet splits itself into one section, one SL
 * series and one worksheet per CSD (`groupLabourLinesByCsd`), and a challan that
 * went out on two gate passes files its lines into two sections off a single
 * scan. Nothing about the CSD is stored here; it is read off each row's copy.
 *
 * The totals are stored, derived from the lines by `refreshLabourBillTotals`
 * after every change and never incremented, so the list can show and sum them
 * without opening every bill — the arrangement `Bill` already uses.
 */
const labourBillSchema = new Schema(
  {
    /** LBTS-WLB-2026-0007 — see `formatLabourBillNumber`. */
    billNumber: { type: String, required: true, unique: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    /**
     * What goes in the sheet's company column on a row scanned in from now on.
     * A default rather than the value: the column is the row's, because a month
     * of challans is routinely several Walton units, and a row keeps whatever
     * was typed into it. Blank falls back to the gate pass's own unit.
     */
    company: { type: String, default: '', trim: true, maxlength: 60 },
    note: { type: String, default: '', trim: true, maxlength: 400 },

    status: { type: String, enum: LABOUR_BILL_STATUSES, default: 'Draft' },

    lineCount: { type: Number, default: 0, min: 0 },
    challanCount: { type: Number, default: 0, min: 0 },
    totalQty: { type: Number, default: 0, min: 0 },
    /** The Ven/Pulling/Labour column, the Floor column, and the two together. */
    labourTotal: { type: Number, default: 0 },
    floorTotal: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    /** Rows with neither amount typed — what the bill is still waiting for. */
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

/** The list: newest billing period first, filtered by period and status. */
labourBillSchema.index({ year: -1, month: -1, createdAt: -1 })
labourBillSchema.index({ status: 1, year: -1, month: -1 })

export type LabourBill = InferSchemaType<typeof labourBillSchema>
export const LabourBillModel = model('WaltonLabourBill', labourBillSchema)
export type LabourBillDocument = InstanceType<typeof LabourBillModel>

/**
 * One row of a labour bill: a reference to the Trip DO sheet row it was scanned
 * off, a **copy** of every column the sheet prints from it, and the three cells
 * somebody types.
 *
 * The copy is what makes the sheet readable without joining a challan and a
 * gate pass to every page, and `copyHash` is what lets the bill notice the copy
 * has gone stale — a challan corrected, a Trip DO linked after the row was
 * scanned. Refreshing a draft copies again **without touching the typed cells**:
 * an address being fixed is no reason to forget what four men were paid.
 *
 * Nothing here claims the sheet row. A run charged transport by an Excel Bill
 * and handling by this one is charged both, which is the whole point of the
 * module — so `TripDoLine.bill` is untouched and the two are counted apart.
 */
const labourBillLineSchema = new Schema(
  {
    billId: { type: Schema.Types.ObjectId, ref: 'WaltonLabourBill', required: true },
    tripDoLineId: { type: Schema.Types.ObjectId, ref: 'TripDoLine', required: true },
    /** The order the row was scanned in, unique within the bill — see `arrangeLabourLines`. */
    seq: { type: Number, required: true },

    challanId: { type: Schema.Types.ObjectId, ref: 'Challan', required: true },
    gatePassId: { type: Schema.Types.ObjectId, ref: 'GatePass', default: null },

    // --- Copied from the Trip DO sheet row -----------------------------------
    challanNumber: { type: String, required: true },
    challanSlNumber: { type: Number, required: true },
    challanDate: { type: Date, required: true },
    customerName: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    district: { type: String, default: '' },
    thana: { type: String, default: '' },
    receiverMobile: { type: String, default: '' },
    productName: { type: String, required: true },
    /** `productModel`, not `model` — `model` collides with `Document.model()`. */
    productModel: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    /** Blank until the sheet row is linked to a gate pass line. */
    tripDo: { type: String, default: '' },
    tripDate: { type: Date, default: null },
    csd: { type: String, default: '' },
    /** The gate pass's own unit, kept so a refreshed row can still seed the company. */
    unit: { type: String, default: '' },
    gatePassNumber: { type: String, default: '' },

    // --- The sheet's own, never rewritten by a refresh ------------------------
    /** The Unit column on this sheet, which carries a company name. */
    company: { type: String, default: '', trim: true, maxlength: 60 },
    /** The Ven/Pulling/Labour cell. Null is "not typed", which is not zero. */
    labourAmount: { type: Number, default: null },
    /** The Floor column's two cells: which floor, and what it cost. */
    floorNo: { type: Number, default: null },
    floorAmount: { type: Number, default: null },

    /** A digest of the copied fields, so a stale row can be told from a current one. */
    copyHash: { type: String, required: true },
    addedAt: { type: Date, required: true },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

labourBillLineSchema.index({ billId: 1, seq: 1 })
/** A sheet row lands on one labour bill at most once. Scanning the same challan twice adds nothing. */
labourBillLineSchema.index({ billId: 1, tripDoLineId: 1 }, { unique: true })
/** "Which labour bills is this challan on?" — the scan's own duplicate answer. */
labourBillLineSchema.index({ tripDoLineId: 1 })

export type LabourBillLine = InferSchemaType<typeof labourBillLineSchema>
export const LabourBillLineModel = model('WaltonLabourBillLine', labourBillLineSchema)
export type LabourBillLineDocument = InstanceType<typeof LabourBillLineModel>
