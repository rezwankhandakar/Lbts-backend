import type { LocationType } from '../location/location.constants'
import type { Rate } from '../product-rate/product-rate.constants'
import { rowAmountFor } from '../trip-do/trip-do.constants'
import type { RowDeliveryStatus, TripDoRowKind } from '../trip-do/trip-do.constants'
import type { TripDoLineDocument } from '../trip-do/trip-do.model'
import { actorFrom, toRate } from '../trip-do/trip-do.serializer'
import type { ActorRef, TripDoBillRef } from '../trip-do/trip-do.serializer'
import { REMARKS_BY_KIND, billPeriodLabel } from './bill.constants'
import type { BillStatus } from './bill.constants'
import type { BillDocument, BillLineDocument } from './bill.model'

export interface BillRecord {
  id: string
  billNumber: string
  month: number
  year: number
  /** "September 2026". */
  periodLabel: string
  unit: string
  note: string
  status: BillStatus
  lineCount: number
  tripDoCount: number
  challanCount: number
  totalQty: number
  totalAmount: number
  unpricedLines: number
  finalizedAt: string | null
  finalizedBy: ActorRef | null
  reopenedAt: string | null
  reopenedBy: ActorRef | null
  createdBy: ActorRef | null
  createdAt: string
  updatedBy: ActorRef | null
  updatedAt: string
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function toBillRecord(bill: BillDocument, names: Map<string, string>): BillRecord {
  return {
    id: String(bill._id),
    billNumber: bill.billNumber,
    month: bill.month,
    year: bill.year,
    periodLabel: billPeriodLabel(bill.month, bill.year),
    unit: bill.unit,
    note: bill.note ?? '',
    status: bill.status as BillStatus,
    lineCount: bill.lineCount,
    tripDoCount: bill.tripDoCount,
    challanCount: bill.challanCount,
    totalQty: bill.totalQty,
    totalAmount: bill.totalAmount,
    unpricedLines: bill.unpricedLines,
    finalizedAt: toIso(bill.finalizedAt),
    finalizedBy: actorFrom(bill.finalizedBy, names),
    reopenedAt: toIso(bill.reopenedAt),
    reopenedBy: actorFrom(bill.reopenedBy, names),
    createdBy: actorFrom(bill.createdBy, names),
    createdAt: bill.createdAt.toISOString(),
    updatedBy: actorFrom(bill.updatedBy, names),
    updatedAt: bill.updatedAt.toISOString(),
  }
}

/**
 * Whether the Trip DO sheet row behind a line still says what the line copied.
 * `missing` is a row that is gone — its challan corrected away — or no longer
 * points at this bill.
 */
export type LineDrift = 'none' | 'changed' | 'missing'

/** One row of a bill, in the bill's order, with its SL and how far its SL cell spans. */
export interface BillLineRecord {
  id: string
  tripDoLineId: string
  challanId: string
  gatePassId: string | null
  sl: number
  slRowSpan: number
  kind: TripDoRowKind
  /** Blank, "Return" or "Re-Sent" — the Remarks column. */
  remarks: string
  challanNumber: string
  challanSlNumber: number
  challanDate: string
  customerName: string
  deliveryAddress: string
  district: string
  thana: string
  locationType: LocationType | null
  receiverMobile: string
  productName: string
  model: string
  capacity: string
  qty: number
  rate: Rate | null
  amount: number | null
  tripDo: string
  /** YYYY-MM-DD. */
  tripDate: string
  gatePassNumber: string
  csd: string
  unit: string
  tripNumbers: string[]
  drift: LineDrift
  addedAt: string
  addedBy: ActorRef | null
}

export function toBillLineRecord(
  line: BillLineDocument,
  placement: { sl: number; slRowSpan: number },
  drift: LineDrift,
  names: Map<string, string>,
): BillLineRecord {
  return {
    id: String(line._id),
    tripDoLineId: String(line.tripDoLineId),
    challanId: String(line.challanId),
    gatePassId: line.gatePassId ? String(line.gatePassId) : null,
    sl: placement.sl,
    slRowSpan: placement.slRowSpan,
    kind: line.kind as TripDoRowKind,
    remarks: REMARKS_BY_KIND[line.kind] ?? '',
    challanNumber: line.challanNumber,
    challanSlNumber: line.challanSlNumber,
    challanDate: line.challanDate.toISOString(),
    customerName: line.customerName,
    deliveryAddress: line.deliveryAddress,
    district: line.district,
    thana: line.thana,
    locationType: (line.locationType as LocationType | null) ?? null,
    receiverMobile: line.receiverMobile,
    productName: line.productName,
    model: line.productModel,
    capacity: line.capacity,
    qty: line.qty,
    rate: toRate(line.rate),
    amount: line.amount ?? null,
    tripDo: line.tripDo,
    tripDate: line.tripDate.toISOString().slice(0, 10),
    gatePassNumber: line.gatePassNumber,
    csd: line.csd,
    unit: line.unit,
    tripNumbers: [...line.tripNumbers],
    drift,
    addedAt: line.addedAt.toISOString(),
    addedBy: actorFrom(line.addedBy, names),
  }
}

export interface BillDetail {
  bill: BillRecord
  lines: BillLineRecord[]
  /** Lines whose sheet row has changed, and lines whose row is gone. */
  drift: { changed: number; missing: number }
}

// --- Adding by Trip DO ---------------------------------------------------------

export interface BillCandidateRow {
  id: string
  kind: TripDoRowKind
  challanId: string
  challanNumber: string
  challanSlNumber: number
  customerName: string
  district: string
  thana: string
  locationType: LocationType | null
  productName: string
  model: string
  qty: number
  amount: number | null
  deliveryStatus: RowDeliveryStatus
  bill: TripDoBillRef | null
}

/** One Trip DO, and every sheet row that carries it. */
export interface BillCandidateGroup {
  tripDo: string
  tripDoKey: string
  tripDate: string
  gatePassNumbers: string[]
  csd: string
  unit: string
  /** The Trip DO's unit is the bill's. A row of another unit cannot be added. */
  unitMatches: boolean
  qty: number
  amount: number
  rows: BillCandidateRow[]
  /** Rows that can be added to this bill now. */
  addableRowIds: string[]
  /** Rows already on this bill. */
  onThisBill: number
  /** Other bills holding some of its rows. */
  otherBills: string[]
}

export interface BillCandidates {
  /** `search` answers what was typed; `month` suggests the bill's own unit and month. */
  mode: 'search' | 'month'
  groups: BillCandidateGroup[]
  /** More rows matched than one answer carries. */
  truncated: boolean
}

export function toCandidateRow(row: TripDoLineDocument): BillCandidateRow {
  return {
    id: String(row._id),
    kind: row.kind as TripDoRowKind,
    challanId: String(row.challanId),
    challanNumber: row.challanNumber,
    challanSlNumber: row.slNumber,
    customerName: row.customerName,
    district: row.district,
    thana: row.thana,
    locationType: (row.locationType as LocationType | null) ?? null,
    productName: row.productName,
    model: row.productModel,
    qty: row.qty,
    amount: rowAmountFor(row.lineAmount, row.lineQty, row.qty),
    deliveryStatus: row.deliveryStatus as RowDeliveryStatus,
    bill: row.bill ? { billId: String(row.bill.billId), billNumber: row.bill.billNumber } : null,
  }
}
