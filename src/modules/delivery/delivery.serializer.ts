import type { Types } from 'mongoose'
import type { LocationType } from '../location/location.constants'
import type {
  DocumentStatus,
  DriverStatus,
  VehicleOwnershipType,
  VehicleStatus,
  VendorStatus,
} from '../vendor/vendor.constants'
import { classifyLine, countChanges, lineKey, netQty } from './delivery.allocation'
import type { LineAllocation, LineChange, ReservedLine, TripLine } from './delivery.allocation'
import { carryingTotalOf, completionMethodFor } from './delivery.constants'
import type { CarryingKind, CompletionMethod, DeliveryOutcome } from './delivery.constants'
import type { PlateMatch, TripStatus } from './delivery.constants'
import type { DeliveryDocument } from './delivery.model'

/**
 * What the Delivery module looks like on the wire.
 *
 * The same two rules as every serializer in this codebase: comparison keys are
 * never sent — they are a matching mechanism, not information — and derived
 * values are computed here rather than stored, so what a line "changed" can
 * never disagree with the two quantities beside it.
 */

export interface ActorRef {
  id: string
  name: string
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

/** A calendar day, as `YYYY-MM-DD`. */
function toDay(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

function actorFrom(
  id: Types.ObjectId | null | undefined,
  names: Map<string, string>,
): ActorRef | null {
  if (!id) {
    return null
  }
  const key = String(id)
  return { id: key, name: names.get(key) ?? 'Removed account' }
}

// --- Vehicle search --------------------------------------------------------

/** A driver as a trip needs them: who, how to reach them, and whether they may drive. */
export interface TripDriverRef {
  id: string
  driverCode: string
  name: string
  mobile: string
  photoUrl: string | null
  licenseNumber: string
  licenseExpiry: string | null
  licenceStatus: DocumentStatus | null
  licencePhrase: string | null
  status: DriverStatus
  /** Null when this driver may take a trip; otherwise the reason in a sentence. */
  blocker: string | null
}

export interface TripVendorRef {
  id: string
  vendorCode: string
  name: string
  mobile: string
  status: VendorStatus
}

export interface TripVehicleRef {
  id: string
  vehicleCode: string
  registrationNo: string
  brand: string
  model: string
  photoUrl: string | null
  ownershipType: VehicleOwnershipType
  status: VehicleStatus
  /** Compliance of the vehicle's own papers — a warning, never a block. */
  documents: { total: number; expiringSoon: number; expired: number }
}

/**
 * One vehicle as the Delivery search offers it: the vehicle, the vendor that
 * runs it and the driver the assignment collection says is on it — everything
 * the trip auto-fills from, in one row, so selecting it costs no second
 * request.
 */
export interface TripVehicleOption {
  vehicle: TripVehicleRef
  vendor: TripVendorRef
  /** The assigned driver, resolved from the assignment collection. May be unable to drive. */
  currentDriver: TripDriverRef | null
  /** Trips on this vehicle not yet delivered — so a lorry already out is visible. */
  openTrips: { id: string; tripNumber: string; status: TripStatus }[]
  match: PlateMatch
  /**
   * Why this vehicle may not take a new trip, or null. Always null on a search
   * result — ineligible vehicles are reported apart — and set when a trip being
   * edited sits on a vehicle that has since gone to the workshop.
   */
  blocker: string | null
}

/** A vehicle the search matched and cannot offer, with the reason. */
export interface UnavailableVehicle {
  id: string
  registrationNo: string
  vendorName: string
  reason: string
}

export interface VehicleSearchResult {
  results: TripVehicleOption[]
  unavailable: UnavailableVehicle[]
  unavailableCount: number
}

// --- Cart candidates -------------------------------------------------------

export interface CandidateTripRef {
  id: string
  tripNumber: string
  status: TripStatus
  registrationNo: string
}

/**
 * One challan as the cart sees it: what the paper says, where it stands, and
 * which trips already carry some of it.
 */
export interface ChallanCandidate {
  id: string
  challanNumber: string
  slNumber: number
  customerName: string
  deliveryAddress: string
  thana: string
  district: string
  location: { district: string; thana: string; locationType: LocationType } | null
  receiverMobile: string
  submittedAt: string
  /** Every line, with how much of it other trips have already taken. */
  lines: LineAllocation[]
  ordered: number
  dispatched: number
  remaining: number
  trips: CandidateTripRef[]
}

// --- Trips -----------------------------------------------------------------

export interface TripLineRecord {
  sourceIndex: number | null
  /** What the challan line said when this trip took it. */
  source: { productName: string; model: string; qty: number } | null
  productName: string
  model: string
  qty: number
  change: LineChange
}

export interface TripPartyFields {
  customerName: string
  deliveryAddress: string
  thana: string
  district: string
  receiverMobile: string
}

/** One product line that came back off the lorry. */
export interface ReturnedLineRecord {
  productName: string
  model: string
  qty: number
  reason: string
}

/** Something hired for the last few metres, and what it cost. */
export interface CarryingChargeRecord {
  kind: CarryingKind
  description: string
  amount: number
}

/** The receiver's signed copy, as the client sees it. */
export interface ReceivedCopyRecord {
  /** The authenticated API path the browser fetches through axios, never an `src`. */
  url: string
  mimeType: string
  size: number
  originalName: string
  pageCount: number | null
  uploadedAt: string
}

export interface TripChallanRecord extends TripPartyFields {
  challanId: string
  challanNumber: string
  slNumber: number
  /** What the challan printed, so the manifest can mark what was changed. */
  original: TripPartyFields
  /** The delivery fields whose trip value differs from the challan's. */
  edited: (keyof TripPartyFields)[]
  location: { district: string; thana: string; locationType: LocationType } | null
  note: string
  lines: TripLineRecord[]
  /** What this trip left on the challan for a later one — a split, not a cut. */
  reserved: { productName: string; model: string; qty: number }[]
  /** What went out and came back. Released for another trip, never cut. */
  returned: ReturnedLineRecord[]
  returnedQty: number
  /** What actually stayed with the receiver: `totalQty` less what came back. */
  deliveredQty: number
  floorNo: number | null
  carrying: CarryingChargeRecord[]
  carryingTotal: number
  deliveryNote: string
  receivedCopy: ReceivedCopyRecord | null
  /** Derived from the signed copy, never stored as a field anybody can set. */
  outcome: DeliveryOutcome
  /** Why it is complete — see `completionMethodFor`. Null while it is pending. */
  completionMethod: CompletionMethod | null
  copyMissing: boolean
  copyMissingReason: string
  completedAt: string | null
  completedBy: ActorRef | null
  totalQty: number
  changedLines: number
}

export interface TripRecord {
  id: string
  tripNumber: string
  vendorTripSerial: number
  status: TripStatus
  tripDate: string

  vendor: { id: string; vendorCode: string; name: string; mobile: string }
  vehicle: {
    id: string
    vehicleCode: string
    registrationNo: string
    brand: string
    model: string
    ownershipType: VehicleOwnershipType
  }
  driver: {
    id: string
    driverCode: string
    name: string
    mobile: string
    licenseNumber: string
    licenseExpiry: string | null
  }
  /** The vehicle's assigned driver when the trip was confirmed. */
  assignedDriver: { id: string; driverCode: string; name: string } | null
  /** True when this trip's driver is not the vehicle's assigned one. */
  driverIsOverride: boolean

  note: string
  challanCount: number
  totalQty: number
  /** Lines anywhere on the trip that differ from their challan. */
  changedLines: number
  /** Enough to recognise a trip in a list without opening it. */
  challanPreview: { challanNumber: string; customerName: string }[]
  /** Present on a single record; absent from a list page. */
  challans?: TripChallanRecord[]

  /** Derived from the challans: set when the last signed copy came in. */
  completedAt: string | null
  /** Challans on the trip whose signed copy is in. */
  completedChallans: number
  /** Pieces that went out and came back, across the whole trip. */
  returnedQty: number
  /** What the trip actually left with its receivers. */
  deliveredQty: number
  /** Every carrying charge on the trip, added up. */
  carryingTotal: number
  /** The lorry's rent, whole taka. Null until somebody enters it. */
  tripRent: number | null
  /** The loading and unloading bill, whole taka. Null until entered. */
  labourBill: number | null
  /** Rent plus labour, counting a blank as nothing. */
  billTotal: number
  billUpdatedAt: string | null
  billUpdatedBy: ActorRef | null
  createdBy: ActorRef | null
  updatedBy: ActorRef | null
  createdAt: string
  updatedAt: string
}

type StoredChallan = DeliveryDocument['challans'][number]
type StoredLine = StoredChallan['lines'][number]

/** A stored line as the allocation arithmetic reads it. */
export function toTripLine(line: StoredLine, returned = 0): TripLine {
  return {
    sourceIndex: line.sourceIndex ?? null,
    source: line.source
      ? { productName: line.source.productName, model: line.source.productModel, qty: line.source.qty }
      : null,
    productName: line.productName,
    model: line.productModel,
    qty: line.qty,
    returned,
  }
}

/**
 * Every line of one trip challan, with what came back attached to the line it
 * came back off.
 *
 * A return is stored as a product and a quantity rather than as a position,
 * for the reason every identity in this module is a product: lines move when a
 * challan is corrected, and an index would point at whatever slid into their
 * place. So the two are joined here by `lineKey`, once, and every caller that
 * needs allocation reads through this rather than through `toTripLine`.
 */
export function toTripLines(challan: StoredChallan): TripLine[] {
  const returned = new Map<string, number>()
  for (const entry of challan.returned ?? []) {
    const key = lineKey({ productName: entry.productName, model: entry.productModel })
    returned.set(key, (returned.get(key) ?? 0) + entry.qty)
  }

  return (challan.lines ?? []).map((line) =>
    toTripLine(line, returned.get(lineKey({ productName: line.productName, model: line.productModel })) ?? 0),
  )
}

/**
 * What a trip challan is holding against the challan's own lines — a split's
 * reservation and a return alike, tagged with the trip so two trips' holds
 * cannot stack. See `rebuildChallanItems`.
 */
export function heldLinesOf(challan: StoredChallan, tripKey: string): ReservedLine[] {
  return [
    ...(challan.reserved ?? []).map((line) => ({
      productName: line.productName,
      model: line.productModel,
      qty: line.qty,
      tripKey,
    })),
    ...(challan.returned ?? []).map((line) => ({
      productName: line.productName,
      model: line.productModel,
      qty: line.qty,
      tripKey,
    })),
  ]
}

const PARTY_FIELDS: (keyof TripPartyFields)[] = [
  'customerName',
  'deliveryAddress',
  'thana',
  'district',
  'receiverMobile',
]

function toTripChallan(
  challan: StoredChallan,
  tripId: string,
  names: Map<string, string>,
): TripChallanRecord {
  const reserved = (challan.reserved ?? []).map((line) => ({
    productName: line.productName,
    model: line.productModel,
    qty: line.qty,
  }))

  /**
   * A reservation is held against the challan's own line, so it is matched on
   * what that line *was* — which is what tells "two now, two on the next lorry"
   * apart from "only two existed", the one distinction a reader of this
   * manifest cannot work out for themselves.
   */
  const heldBack = (line: TripLine): number =>
    reserved.find((entry) => lineKey(entry) === lineKey(line.source ?? line))?.qty ?? 0

  const lines = toTripLines(challan).map((tripLine) => ({
    ...tripLine,
    change: classifyLine(tripLine, heldBack(tripLine)),
  }))

  const current: TripPartyFields = {
    customerName: challan.customerName,
    deliveryAddress: challan.deliveryAddress,
    thana: challan.thana,
    district: challan.district,
    receiverMobile: challan.receiverMobile,
  }

  /**
   * `original` is required by the schema, so every trip this module writes has
   * one. The fallback is for a document that predates it — the collection was
   * used once by an earlier delivery design, and one such record made this
   * endpoint answer 500 for a whole page of trips. `purgeLegacyDeliveries`
   * clears those on boot; this makes sure a single odd record degrades to
   * "nothing was changed for this trip" instead of taking the list down.
   */
  const source = challan.original ?? current
  const original: TripPartyFields = {
    customerName: source.customerName ?? '',
    deliveryAddress: source.deliveryAddress ?? '',
    thana: source.thana ?? '',
    district: source.district ?? '',
    receiverMobile: source.receiverMobile ?? '',
  }

  return {
    challanId: String(challan.challanId),
    challanNumber: challan.challanNumber,
    slNumber: challan.slNumber,
    ...current,
    original,
    edited: PARTY_FIELDS.filter((field) => current[field].trim() !== original[field].trim()),
    location: challan.location
      ? {
          district: challan.location.district,
          thana: challan.location.thana,
          locationType: challan.location.locationType as LocationType,
        }
      : null,
    note: challan.note,
    lines,
    reserved,
    returned: (challan.returned ?? []).map((line) => ({
      productName: line.productName,
      model: line.productModel,
      qty: line.qty,
      reason: line.reason ?? '',
    })),
    returnedQty: (challan.returned ?? []).reduce((sum, line) => sum + line.qty, 0),
    deliveredQty: lines.reduce((sum, line) => sum + netQty(line), 0),
    floorNo: challan.floorNo ?? null,
    carrying: (challan.carrying ?? []).map((entry) => ({
      kind: entry.kind as CarryingKind,
      description: entry.description,
      amount: entry.amount,
    })),
    carryingTotal: challan.carryingTotal ?? carryingTotalOf(challan.carrying ?? []),
    deliveryNote: challan.deliveryNote ?? '',
    /**
     * The path the browser fetches through axios, never a URL the bucket
     * serves: a signed challan carries the customer's address and a signature,
     * so the object is private and the API is the only read path.
     */
    receivedCopy: challan.receivedCopy
      ? {
          url: `/deliveries/${tripId}/challans/${String(challan.challanId)}/received-copy`,
          mimeType: challan.receivedCopy.mimeType,
          size: challan.receivedCopy.size,
          originalName: challan.receivedCopy.originalName ?? '',
          pageCount: challan.receivedCopy.pageCount ?? null,
          uploadedAt: challan.receivedCopy.uploadedAt.toISOString(),
        }
      : null,
    outcome: challan.completedAt ? 'Complete' : 'Pending',
    completionMethod: completionMethodFor({
      hasCopy: Boolean(challan.receivedCopy),
      copyMissing: Boolean(challan.copyMissing),
      carried: lines.reduce((sum, line) => sum + line.qty, 0),
      returned: (challan.returned ?? []).reduce((sum, line) => sum + line.qty, 0),
    }),
    copyMissing: Boolean(challan.copyMissing),
    copyMissingReason: challan.copyMissingReason ?? '',
    completedAt: toIso(challan.completedAt),
    completedBy: actorFrom(challan.completedBy, names),
    totalQty: lines.reduce((sum, line) => sum + line.qty, 0),
    changedLines: countChanges(lines),
  }
}

export function toTripRecord(
  trip: DeliveryDocument,
  names: Map<string, string>,
  { withChallans }: { withChallans: boolean },
): TripRecord {
  const challans = trip.challans.map((challan) =>
    toTripChallan(challan, String(trip._id), names),
  )

  return {
    id: String(trip._id),
    tripNumber: trip.tripNumber,
    vendorTripSerial: trip.vendorTripSerial,
    status: trip.status as TripStatus,
    tripDate: toDay(trip.tripDate) ?? '',

    vendor: {
      id: String(trip.vendorId),
      vendorCode: trip.vendor.vendorCode,
      name: trip.vendor.name,
      mobile: trip.vendor.mobile,
    },
    vehicle: {
      id: String(trip.vehicleId),
      vehicleCode: trip.vehicle.vehicleCode,
      registrationNo: trip.vehicle.registrationNo,
      brand: trip.vehicle.brand,
      model: trip.vehicle.vehicleModel,
      ownershipType: trip.vehicle.ownershipType as VehicleOwnershipType,
    },
    driver: {
      id: String(trip.driverId),
      driverCode: trip.driver.driverCode,
      name: trip.driver.name,
      mobile: trip.driver.mobile,
      licenseNumber: trip.driver.licenseNumber,
      licenseExpiry: toDay(trip.driver.licenseExpiry),
    },
    assignedDriver: trip.assignedDriver
      ? {
          id: String(trip.assignedDriver.driverId),
          driverCode: trip.assignedDriver.driverCode,
          name: trip.assignedDriver.name,
        }
      : null,
    driverIsOverride:
      trip.assignedDriver !== null &&
      trip.assignedDriver !== undefined &&
      String(trip.assignedDriver.driverId) !== String(trip.driverId),

    note: trip.note,
    challanCount: trip.challanCount,
    totalQty: trip.totalQty,
    changedLines: challans.reduce((sum, challan) => sum + challan.changedLines, 0),
    challanPreview: challans.map((challan) => ({
      challanNumber: challan.challanNumber,
      customerName: challan.customerName,
    })),
    ...(withChallans ? { challans } : {}),

    completedAt: toIso(trip.completedAt),
    completedChallans: challans.filter((challan) => challan.outcome === 'Complete').length,
    returnedQty: challans.reduce((sum, challan) => sum + challan.returnedQty, 0),
    deliveredQty: challans.reduce((sum, challan) => sum + challan.deliveredQty, 0),
    carryingTotal: challans.reduce((sum, challan) => sum + challan.carryingTotal, 0),
    tripRent: trip.tripRent ?? null,
    labourBill: trip.labourBill ?? null,
    billTotal: (trip.tripRent ?? 0) + (trip.labourBill ?? 0),
    billUpdatedAt: toIso(trip.billUpdatedAt),
    billUpdatedBy: actorFrom(trip.billUpdatedBy, names),
    createdBy: actorFrom(trip.createdBy, names),
    updatedBy: actorFrom(trip.updatedBy, names),
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  }
}
