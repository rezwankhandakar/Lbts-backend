import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { RATE_KINDS } from '../product-rate/product-rate.constants'
import { ROW_DELIVERY_STATUSES, TRIP_DO_ROW_KINDS } from './trip-do.constants'

/**
 * One row of the Trip DO sheet.
 *
 * Most of a row is a **copy**: the challan's customer and address, the product
 * line, its rate, the trips that carried it and where the goods are. The copy
 * is rewritten by `syncTripDoLedger` whenever the challan or a trip changes,
 * and it exists so the sheet can be filtered, sorted, paged and totalled as
 * one indexed collection — joining every challan and every trip to every page
 * is the unindexed work M0 cannot afford.
 *
 * Two things on a row are its own and are never rewritten by the sync: `qty`,
 * as far as a split divides a line between rows, and `link`, the Trip DO.
 */

/**
 * The rate the challan line was charged at, as the challan stored it. Exported
 * because a bill line keeps the same copy of it.
 */
export const rateCopySchema = new Schema(
  {
    kind: { type: String, enum: RATE_KINDS, required: true },
    unitAmount: { type: Number, default: null },
    firstQty: { type: Number, default: null },
    firstAmount: { type: Number, default: null },
    restAmount: { type: Number, default: null },
  },
  { _id: false },
)

/**
 * The Trip DO: a reference to the gate pass plus a copy of what identifies it.
 *
 * The copy is what the sheet shows and filters by. Unlike the challan copy it
 * is **not** frozen at link time — a gate pass is editable in every status, and
 * a CSD transcribed wrongly there was wrong here too — so correcting the gate
 * pass rewrites it (`refreshGatePassLinkCopies`).
 */
const linkSchema = new Schema(
  {
    gatePassId: { type: Schema.Types.ObjectId, ref: 'GatePass', required: true },
    /** GP-2026-000123. */
    gatePassNumber: { type: String, required: true },
    tripDo: { type: String, required: true },
    tripDate: { type: Date, required: true },
    csd: { type: String, default: '' },
    unit: { type: String, default: '' },
    /**
     * The gate pass line this row is linked to, by its model key, and that
     * line's model as the gate pass writes it. Not the row's own model: the two
     * papers are typed apart, and a challan's `WFE-2H2-GDEN-XX` is routinely
     * linked to a gate pass line of `WFE-2H2-GDEN`. Blank on a row linked
     * before this was stored, which means the row's own model key.
     */
    modelKey: { type: String, default: '' },
    model: { type: String, default: '' },
    linkedAt: { type: Date, required: true },
    linkedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
)

/**
 * The bill this row is on. Written by the Bill module and by nothing else, and
 * one bill at most — the unique index on a bill line's `tripDoLineId` is the
 * floor under that. A billed row is fixed on the sheet: it cannot be split,
 * merged or linked elsewhere until it is taken off the bill.
 */
const billRefSchema = new Schema(
  {
    billId: { type: Schema.Types.ObjectId, ref: 'Bill', required: true },
    billNumber: { type: String, required: true },
    billedAt: { type: Date, required: true },
    billedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
)

const tripDoLineSchema = new Schema(
  {
    challanId: { type: Schema.Types.ObjectId, ref: 'Challan', required: true, index: true },
    /** What this row is a part of — see `ledgerSourcesFor`. */
    sourceKey: { type: String, required: true, index: true },
    /** Which part of that source this is; zero for a row nobody split. */
    splitIndex: { type: Number, default: 0, min: 0 },

    kind: { type: String, enum: TRIP_DO_ROW_KINDS, required: true },
    position: { type: Number, default: 0 },
    rowSeq: { type: Number, default: 0 },
    tripId: { type: Schema.Types.ObjectId, ref: 'Delivery', default: null },

    // --- Copied from the challan --------------------------------------------
    challanNumber: { type: String, required: true },
    slNumber: { type: Number, required: true },
    /** When the challan was filed — the Date column. */
    challanDate: { type: Date, required: true },
    customerName: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    /** The resolved district and thana where there is one, else as typed. */
    district: { type: String, default: '' },
    thana: { type: String, default: '' },
    /** `ISD`, `OSD-Metro` or `OSD-Thana`; null while the challan's location is Pending. */
    locationType: { type: String, default: null },
    receiverMobile: { type: String, default: '' },
    zonePo: { type: String, default: null },

    productName: { type: String, required: true },
    productModel: { type: String, default: '' },
    productModelKey: { type: String, default: '', index: true },
    capacity: { type: String, default: '' },
    rate: { type: rateCopySchema, default: null },
    /**
     * The whole line's quantity and charge, so a row's share can be worked out.
     * A return or re-send carries its order line's, so it has an amount too.
     */
    lineQty: { type: Number, default: 0 },
    lineAmount: { type: Number, default: null },
    /**
     * Order rows: pieces of the whole line that went out the first time on
     * trips whose delivery is complete — see `LedgerSource`. What a gate pass
     * counts as delivered starts here (`rowDeliveredShare`). Null until the
     * sync has written it.
     */
    firstDeliveredQty: { type: Number, default: null },

    // --- Copied from the trips ---------------------------------------------
    tripNumbers: { type: [String], default: [] },
    deliveryStatus: { type: String, enum: ROW_DELIVERY_STATUSES, default: 'Pending' },

    // --- The sheet's own -----------------------------------------------------
    qty: { type: Number, required: true, min: 1 },
    link: { type: linkSchema, default: null },
    /** `comparisonKey` of the linked Trip DO, blank when there is none. */
    tripDoKey: { type: String, default: '' },
    /** See `billRefSchema`. Null while the row is on no bill. */
    bill: { type: billRefSchema, default: null },

    /** A digest of the copied fields, so a sync writes only what changed. */
    copyHash: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
)

/**
 * The sheet's order and its default page: newest challan first, and within a
 * challan its lines in printed order with each line's returns and re-sends
 * beneath it.
 */
tripDoLineSchema.index({ challanDate: -1, slNumber: -1, position: 1, rowSeq: 1, splitIndex: 1 })
/** "Which rows point at this gate pass?" — the gate pass panel and every allocation. */
tripDoLineSchema.index({ 'link.gatePassId': 1, productModelKey: 1 })
/** The two backlogs somebody sits down to clear. */
tripDoLineSchema.index({ tripDoKey: 1, challanDate: -1 })
tripDoLineSchema.index({ deliveryStatus: 1, challanDate: -1 })
tripDoLineSchema.index({ kind: 1, challanDate: -1 })
/** "Which rows are on this bill?" — releasing them, and the billing status. */
tripDoLineSchema.index({ 'bill.billId': 1 })
/** A bill's suggestions: one unit's Trip DOs in one month. */
tripDoLineSchema.index({ 'link.unit': 1, 'link.tripDate': -1 })

export type TripDoLine = InferSchemaType<typeof tripDoLineSchema>

export const TripDoLineModel = model('TripDoLine', tripDoLineSchema)

export type TripDoLineDocument = InstanceType<typeof TripDoLineModel>
