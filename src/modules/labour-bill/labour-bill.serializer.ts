import { actorFrom } from '../trip-do/trip-do.serializer'
import type { ActorRef } from '../trip-do/trip-do.serializer'
import { labourBillPeriodLabel, lineTotal } from './labour-bill.constants'
import type { LabourBillStatus } from './labour-bill.constants'
import type { LabourBillDocument, LabourBillLineDocument } from './labour-bill.model'

export interface LabourBillRecord {
  id: string
  billNumber: string
  month: number
  year: number
  /** "September 2026" — the whole of what the slot is. */
  periodLabel: string
  /** The company a newly scanned row's Unit column is seeded with; may be blank. */
  company: string
  note: string
  status: LabourBillStatus
  lineCount: number
  challanCount: number
  totalQty: number
  labourTotal: number
  floorTotal: number
  totalAmount: number
  /** Rows with neither amount typed. */
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

export function toLabourBillRecord(
  bill: LabourBillDocument,
  names: Map<string, string>,
): LabourBillRecord {
  return {
    id: String(bill._id),
    billNumber: bill.billNumber,
    month: bill.month,
    year: bill.year,
    periodLabel: labourBillPeriodLabel(bill.month, bill.year),
    company: bill.company ?? '',
    note: bill.note ?? '',
    status: bill.status as LabourBillStatus,
    lineCount: bill.lineCount,
    challanCount: bill.challanCount,
    totalQty: bill.totalQty,
    labourTotal: bill.labourTotal,
    floorTotal: bill.floorTotal,
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
 * Whether the Trip DO sheet row behind a labour bill row still says what the
 * row copied. `missing` is a row that is gone — its challan corrected away or
 * deleted — and `changed` is one the sheet has since rewritten.
 */
export type LabourLineDrift = 'none' | 'changed' | 'missing'

/** One row of the sheet, in the office's column order, with its SL and merge span. */
export interface LabourBillLineRecord {
  id: string
  tripDoLineId: string
  challanId: string
  gatePassId: string | null
  sl: number
  slRowSpan: number

  challanNumber: string
  challanSlNumber: number
  challanDate: string
  customerName: string
  deliveryAddress: string
  district: string
  thana: string
  receiverMobile: string
  productName: string
  /** `model` on the wire and `productModel` in MongoDB, the arrangement every product line here has. */
  model: string
  qty: number
  tripDo: string
  /** YYYY-MM-DD, or null while the sheet row carries no Trip DO. */
  tripDate: string | null
  /** The CSD this row files itself under; blank while its Trip DO is unset. */
  csd: string
  gatePassNumber: string
  /** The gate pass's unit, which seeds the company and is shown as the fallback. */
  unit: string

  /** The Unit column on this sheet: a company name, typed or seeded. */
  company: string
  labourAmount: number | null
  floorNo: number | null
  floorAmount: number | null
  /** Labour plus floor, or null while neither has been typed. */
  total: number | null

  drift: LabourLineDrift
  addedAt: string
  addedBy: ActorRef | null
  updatedAt: string
  updatedBy: ActorRef | null
}

export function toLabourBillLineRecord(
  line: LabourBillLineDocument,
  placement: { sl: number; slRowSpan: number },
  drift: LabourLineDrift,
  names: Map<string, string>,
): LabourBillLineRecord {
  return {
    id: String(line._id),
    tripDoLineId: String(line.tripDoLineId),
    challanId: String(line.challanId),
    gatePassId: line.gatePassId ? String(line.gatePassId) : null,
    sl: placement.sl,
    slRowSpan: placement.slRowSpan,

    challanNumber: line.challanNumber,
    challanSlNumber: line.challanSlNumber,
    challanDate: line.challanDate.toISOString(),
    customerName: line.customerName,
    deliveryAddress: line.deliveryAddress,
    district: line.district,
    thana: line.thana,
    receiverMobile: line.receiverMobile,
    productName: line.productName,
    model: line.productModel,
    qty: line.qty,
    tripDo: line.tripDo,
    tripDate: line.tripDate ? line.tripDate.toISOString().slice(0, 10) : null,
    csd: line.csd,
    gatePassNumber: line.gatePassNumber,
    unit: line.unit,

    company: line.company || line.unit,
    labourAmount: line.labourAmount ?? null,
    floorNo: line.floorNo ?? null,
    floorAmount: line.floorAmount ?? null,
    total: lineTotal(line.labourAmount, line.floorAmount),

    drift,
    addedAt: line.addedAt.toISOString(),
    addedBy: actorFrom(line.addedBy, names),
    updatedAt: line.updatedAt.toISOString(),
    updatedBy: actorFrom(line.updatedBy, names),
  }
}

/** What one CSD's section of the month comes to — the figures its own bill carries. */
export interface LabourGroupTotals {
  rows: number
  challans: number
  qty: number
  labourTotal: number
  floorTotal: number
  totalAmount: number
  /** Rows with neither amount typed, which add nothing to the section's total. */
  unpricedLines: number
}

/**
 * One CSD's worth of the month: its own SL series, its own total, and its own
 * worksheet in the export. The pending section is the same shape, holding the
 * rows nothing has matched to a gate pass yet.
 */
export interface LabourCsdGroupRecord {
  csd: string
  key: string
  /** The CSD, or "Trip DO pending". */
  label: string
  isPending: boolean
  totals: LabourGroupTotals
  lines: LabourBillLineRecord[]
}

export interface LabourBillDetail {
  bill: LabourBillRecord
  /** The month split by CSD, in CSD order with pending last. */
  groups: LabourCsdGroupRecord[]
  /** Rows whose sheet row has changed, and rows whose sheet row is gone. */
  drift: { changed: number; missing: number }
  /** Rows still waiting for a Trip DO, so they belong to no CSD yet. */
  pendingLines: number
}

export function labourGroupTotals(lines: readonly LabourBillLineRecord[]): LabourGroupTotals {
  const labourTotal = lines.reduce((sum, line) => sum + (line.labourAmount ?? 0), 0)
  const floorTotal = lines.reduce((sum, line) => sum + (line.floorAmount ?? 0), 0)

  return {
    rows: lines.length,
    challans: new Set(lines.map((line) => line.challanId)).size,
    qty: lines.reduce((sum, line) => sum + line.qty, 0),
    labourTotal,
    floorTotal,
    totalAmount: labourTotal + floorTotal,
    unpricedLines: lines.filter((line) => line.total === null).length,
  }
}

/** What one barcode read did to the bill. */
export interface LabourScanResult {
  billNumber: string
  challanId: string
  challanNumber: string
  challanSlNumber: number
  customerName: string
  /** Models added by this scan, in the order they landed. */
  added: string[]
  /** Models this challan carries that were already on the bill. */
  skipped: string[]
  /** The CSDs this scan filed rows under, so the toast can say where they went. */
  csds: string[]
  /** Models with no Trip DO yet, which land in the pending section and wait there. */
  withoutTripDo: string[]
  detail: LabourBillDetail
}
