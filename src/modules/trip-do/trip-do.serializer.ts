import type { Types } from 'mongoose'
import type { LocationType } from '../location/location.constants'
import type { Rate } from '../product-rate/product-rate.constants'
import { rowAmountFor } from './trip-do.constants'
import type {
  GatePassProductStatus,
  RowDeliveryStatus,
  TripDoRowKind,
} from './trip-do.constants'
import type { MatchLevel } from './trip-do.matching'
import type { TripDoLineDocument } from './trip-do.model'

export interface ActorRef {
  id: string
  name: string
}

/** The gate pass a row is linked to, as a client sees it. */
export interface TripDoLinkRef {
  gatePassId: string
  gatePassNumber: string
  tripDo: string
  /** YYYY-MM-DD. A trip date is a calendar day. */
  tripDate: string
  csd: string
  unit: string
  /** The gate pass line's model, which may be written differently from the row's. */
  model: string
  linkedAt: string
  linkedBy: ActorRef | null
}

/**
 * One row of the sheet, in the column order the office keeps it.
 *
 * `model` here and `productModel` in MongoDB, the arrangement every product
 * line in this codebase has. `amount` is the row's share of its line — see
 * `rowAmountFor`, for a return or re-send too — and null for a line nothing priced.
 */
export interface TripDoRowRecord {
  id: string
  challanId: string
  challanNumber: string
  slNumber: number
  /** When the challan was filed. */
  date: string
  kind: TripDoRowKind
  tripNumbers: string[]
  deliveryStatus: RowDeliveryStatus

  customerName: string
  deliveryAddress: string
  district: string
  thana: string
  locationType: LocationType | null
  receiverMobile: string
  zonePo: string | null

  productName: string
  model: string
  qty: number
  /** The whole line's quantity, so "3 of 5" can be said. A return or re-send carries its order line's. */
  lineQty: number
  rate: Rate | null
  amount: number | null
  capacity: string

  link: TripDoLinkRef | null
  /** The bill this row is on, or null. A billed row is fixed on the sheet. */
  bill: TripDoBillRef | null
  /** How many rows this row's line is divided into, itself included. */
  partCount: number
  splitIndex: number
}

export interface TripDoBillRef {
  billId: string
  billNumber: string
}

/** A stored rate copy — the row's, or a bill line's, which keeps the same shape. */
export interface StoredRateCopy {
  kind: string
  unitAmount?: number | null
  firstQty?: number | null
  firstAmount?: number | null
  restAmount?: number | null
}

export function toRate(stored: StoredRateCopy | null | undefined): Rate | null {
  if (!stored) {
    return null
  }
  if (stored.kind === 'flat' && typeof stored.unitAmount === 'number') {
    return { kind: 'flat', amount: stored.unitAmount }
  }
  if (
    stored.kind === 'tiered' &&
    typeof stored.firstQty === 'number' &&
    typeof stored.firstAmount === 'number' &&
    typeof stored.restAmount === 'number'
  ) {
    return {
      kind: 'tiered',
      firstQty: stored.firstQty,
      firstAmount: stored.firstAmount,
      restAmount: stored.restAmount,
    }
  }
  return null
}

export function actorFrom(
  id: Types.ObjectId | null | undefined,
  names: Map<string, string>,
): ActorRef | null {
  if (!id) {
    return null
  }
  const key = String(id)
  return { id: key, name: names.get(key) ?? 'Removed account' }
}

export function toTripDoRow(
  row: TripDoLineDocument,
  partCount: number,
  names: Map<string, string>,
): TripDoRowRecord {
  const link = row.link

  return {
    id: String(row._id),
    challanId: String(row.challanId),
    challanNumber: row.challanNumber,
    slNumber: row.slNumber,
    date: row.challanDate.toISOString(),
    kind: row.kind as TripDoRowKind,
    tripNumbers: [...row.tripNumbers],
    deliveryStatus: row.deliveryStatus as RowDeliveryStatus,

    customerName: row.customerName,
    deliveryAddress: row.deliveryAddress,
    district: row.district,
    thana: row.thana,
    locationType: (row.locationType as LocationType | null) ?? null,
    receiverMobile: row.receiverMobile,
    zonePo: row.zonePo ?? null,

    productName: row.productName,
    model: row.productModel,
    qty: row.qty,
    lineQty: row.lineQty,
    rate: toRate(row.rate),
    amount: rowAmountFor(row.lineAmount, row.lineQty, row.qty),
    capacity: row.capacity,

    link: link
      ? {
          gatePassId: String(link.gatePassId),
          gatePassNumber: link.gatePassNumber,
          tripDo: link.tripDo,
          tripDate: link.tripDate.toISOString().slice(0, 10),
          csd: link.csd,
          unit: link.unit,
          model: link.model || row.productModel,
          linkedAt: link.linkedAt.toISOString(),
          linkedBy: actorFrom(link.linkedBy, names),
        }
      : null,
    bill: row.bill ? { billId: String(row.bill.billId), billNumber: row.bill.billNumber } : null,
    partCount,
    splitIndex: row.splitIndex,
  }
}

/**
 * One gate pass line the Trip DO picker offers for one row. A gate pass
 * carrying two lines close to the row's model is two options.
 */
export interface GatePassOption {
  /** The gate pass. */
  id: string
  /** The line on it, by model key — sent back when linking. */
  lineKey: string
  /** Unique across the list: gate pass and line. */
  optionKey: string
  gatePassNumber: string
  tripDo: string
  tripDate: string
  csd: string
  unit: string
  customerName: string
  vehicleNo: string
  status: string
  productName: string
  model: string
  qty: number
  /** Linked by other order rows. */
  allocatedQty: number
  /**
   * What this row may still link. For a return or re-sent row that is the whole
   * line, because those pieces do not use the line up — see
   * `countsTowardGatePassQty`.
   */
  remainingQty: number
  /** Whether linking this row uses up the line's quantity. */
  countsTowardQty: boolean
  modelMatch: MatchLevel
  customerMatch: MatchLevel
  /** The row is already linked to this line. */
  isCurrent: boolean
  /** A return or re-sent row: the Trip DO its order row already has. */
  isOrderTripDo: boolean
}

/** A challan row linked to a gate pass, as the gate pass page lists it. */
export interface GatePassLinkedRow {
  id: string
  challanId: string
  challanNumber: string
  slNumber: number
  customerName: string
  district: string
  thana: string
  kind: TripDoRowKind
  qty: number
  deliveryStatus: RowDeliveryStatus
  tripNumbers: string[]
}

export interface GatePassProductLine {
  productName: string
  model: string
  qty: number
  linkedQty: number
  /** Order rows' first delivery, less linked returns, plus linked re-sends. */
  deliveredQty: number
  remainingQty: number
  status: GatePassProductStatus
  rows: GatePassLinkedRow[]
}

/** What the challans say about one gate pass, product by product. */
export interface GatePassTripDoStatus {
  gatePassId: string
  gatePassNumber: string
  tripDo: string
  status: GatePassProductStatus
  totalQty: number
  linkedQty: number
  lines: GatePassProductLine[]
}

export function toLinkedRow(row: TripDoLineDocument): GatePassLinkedRow {
  return {
    id: String(row._id),
    challanId: String(row.challanId),
    challanNumber: row.challanNumber,
    slNumber: row.slNumber,
    customerName: row.customerName,
    district: row.district,
    thana: row.thana,
    kind: row.kind as TripDoRowKind,
    qty: row.qty,
    deliveryStatus: row.deliveryStatus as RowDeliveryStatus,
    tripNumbers: [...row.tripNumbers],
  }
}
