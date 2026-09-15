import type { Types } from 'mongoose'
import { ChallanModel } from '../challan/challan.model'
import type { ChallanDocument } from '../challan/challan.model'
import { normalizeMobile } from '../challan/challan.constants'
import type { LocationType } from '../location/location.constants'
import { AssignmentModel } from '../vendor/assignment.model'
import { DriverModel } from '../vendor/driver.model'
import type { DriverDocument } from '../vendor/driver.model'
import { VehicleModel } from '../vendor/vehicle.model'
import type { VehicleDocument } from '../vendor/vehicle.model'
import { VendorModel } from '../vendor/vendor.model'
import type { VendorDocument } from '../vendor/vendor.model'
import { documentStatusFor, expiryPhrase } from '../vendor/vendor.constants'
import type {
  DriverStatus,
  VehicleOwnershipType,
  VehicleStatus,
  VendorStatus,
} from '../vendor/vendor.constants'
import { documentTalliesFor, escapeRegex, tallyFor } from '../vendor/vendor.lookups'
import { allocateLines, progressOf } from './delivery.allocation'
import type { ReservedLine, SourceLine, TripLine } from './delivery.allocation'
import {
  MAX_CHALLAN_CANDIDATES,
  MAX_UNAVAILABLE_REPORTED,
  MAX_VEHICLE_RESULTS,
  MIN_PLATE_QUERY_LENGTH,
  banglaDigits,
  comparePlates,
  driverTripBlocker,
  plateMatch,
  plateSearchKey,
  vehicleTripBlocker,
} from './delivery.constants'
import type { TripStatus } from './delivery.constants'
import { DeliveryModel } from './delivery.model'
import { heldLinesOf, toTripLines } from './delivery.serializer'
import type {
  CandidateTripRef,
  ChallanCandidate,
  TripDriverRef,
  TripVehicleOption,
  UnavailableVehicle,
  VehicleSearchResult,
} from './delivery.serializer'

/**
 * The reads the Delivery workspace is built on.
 *
 * Every one of them is shaped by the M0 rule the rest of the codebase follows:
 * a page of results resolves its references in one query per kind, never one
 * per row. A vehicle search for "1234" that returns eight lorries costs one
 * query for the vehicles, one for their vendors, one for their assigned
 * drivers, one for their papers and one for the trips they are already on —
 * five, whatever the count.
 */

type IdLike = Types.ObjectId | string

// --- Drivers ---------------------------------------------------------------

export function toTripDriverRef(driver: DriverDocument, now: Date = new Date()): TripDriverRef {
  return {
    id: String(driver._id),
    driverCode: driver.driverCode,
    name: driver.name,
    mobile: driver.mobile,
    photoUrl: driver.photoUrl ?? null,
    licenseNumber: driver.licenseNumber,
    licenseExpiry: driver.licenseExpiry ? driver.licenseExpiry.toISOString().slice(0, 10) : null,
    licenceStatus: driver.licenseExpiry ? documentStatusFor(driver.licenseExpiry, now) : null,
    licencePhrase: driver.licenseExpiry ? expiryPhrase(driver.licenseExpiry, now) : null,
    status: driver.status as DriverStatus,
    blocker: driverTripBlocker(driver.status as DriverStatus),
  }
}

/**
 * The driver the assignment collection puts on each vehicle — the trip's
 * *default*, which the operator may replace for this run without touching it.
 *
 * Returned whatever the driver's status: an assigned driver who is on leave
 * is exactly the case the workspace has to explain, not hide.
 */
export async function assignedDriversFor(
  vehicleIds: IdLike[],
): Promise<Map<string, DriverDocument>> {
  if (vehicleIds.length === 0) {
    return new Map()
  }

  const assignments = await AssignmentModel.find({
    vehicleId: { $in: vehicleIds },
    status: 'Active',
  }).select('vehicleId driverId')

  if (assignments.length === 0) {
    return new Map()
  }

  const drivers = await DriverModel.find({
    _id: { $in: assignments.map((assignment) => assignment.driverId) },
  })
  const byId = new Map(drivers.map((driver) => [String(driver._id), driver]))

  const result = new Map<string, DriverDocument>()
  for (const assignment of assignments) {
    const driver = byId.get(String(assignment.driverId))
    if (driver) {
      result.set(String(assignment.vehicleId), driver)
    }
  }
  return result
}

// --- Vehicles --------------------------------------------------------------

async function openTripsFor(
  vehicleIds: IdLike[],
): Promise<Map<string, { id: string; tripNumber: string; status: TripStatus }[]>> {
  const trips =
    vehicleIds.length === 0
      ? []
      : await DeliveryModel.find({
          vehicleId: { $in: vehicleIds },
          /**
           * "Already out" is now "not finished": a trip is open until every
           * challan on it has been signed for. A completed trip's lorry is
           * back, whatever anybody remembered to press.
           */
          status: 'Open',
        })
          .select('vehicleId tripNumber status')
          .sort({ tripDate: -1 })

  const result = new Map<string, { id: string; tripNumber: string; status: TripStatus }[]>()
  for (const trip of trips) {
    const key = String(trip.vehicleId)
    const list = result.get(key) ?? []
    list.push({ id: String(trip._id), tripNumber: trip.tripNumber, status: trip.status as TripStatus })
    result.set(key, list)
  }
  return result
}

/**
 * Everything a trip auto-fills from, for a set of vehicles.
 *
 * `blocker` is attached to each so the caller decides what to do with an
 * ineligible one — the search drops it into the "unavailable" list, the edit
 * page shows it with a warning.
 */
export async function buildVehicleOptions(
  vehicles: VehicleDocument[],
  queryKey: string,
): Promise<TripVehicleOption[]> {
  if (vehicles.length === 0) {
    return []
  }

  const ids = vehicles.map((vehicle) => vehicle._id)

  const [vendors, drivers, tallies, openTrips] = await Promise.all([
    VendorModel.find({ _id: { $in: vehicles.map((vehicle) => vehicle.vendorId) } }).select(
      'vendorCode name mobile status',
    ),
    assignedDriversFor(ids),
    documentTalliesFor('Vehicle', ids),
    openTripsFor(ids),
  ])

  const vendorsById = new Map<string, VendorDocument>(
    vendors.map((vendor) => [String(vendor._id), vendor]),
  )

  return vehicles.flatMap((vehicle) => {
    const vendor = vendorsById.get(String(vehicle.vendorId))
    if (!vendor) {
      // A vehicle whose vendor is gone is not a vehicle anybody can dispatch.
      return []
    }

    const driver = drivers.get(String(vehicle._id))
    const tally = tallyFor(tallies, vehicle._id)
    const key = plateSearchKey(vehicle.registrationNo)

    return [
      {
        vehicle: {
          id: String(vehicle._id),
          vehicleCode: vehicle.vehicleCode,
          registrationNo: vehicle.registrationNo,
          brand: vehicle.brand,
          model: vehicle.vehicleModel,
          photoUrl: vehicle.photoUrl ?? null,
          ownershipType: vehicle.ownershipType as VehicleOwnershipType,
          status: vehicle.status as VehicleStatus,
          documents: {
            total: tally.total,
            expiringSoon: tally.expiringSoon,
            expired: tally.expired,
          },
        },
        vendor: {
          id: String(vendor._id),
          vendorCode: vendor.vendorCode,
          name: vendor.name,
          mobile: vendor.mobile,
          status: vendor.status as VendorStatus,
        },
        currentDriver: driver ? toTripDriverRef(driver) : null,
        openTrips: openTrips.get(String(vehicle._id)) ?? [],
        match: plateMatch(key, queryKey) ?? 'contains',
        blocker: vehicleTripBlocker(vehicle.status as VehicleStatus, vendor.status as VendorStatus),
      },
    ]
  })
}

/** How many candidates each plate query may read before ranking. */
const PLATE_CANDIDATE_LIMIT = 40

/**
 * The plate search behind the vehicle box.
 *
 * Two indexed reads on `registrationNoKey`, tail first — `…1234$` is the
 * question an operator reading the back of a lorry is asking, so those
 * candidates are gathered before the plates that merely contain the digits. A
 * suffix regex cannot seek in an index the way a prefix can, but it scans the
 * index keys rather than the documents, which for a fleet of hundreds or low
 * thousands is nothing. Past that, a stored reversed key turns the tail into a
 * prefix; see Known gaps.
 *
 * Bangla is handled in both directions: `১২৩৪` typed becomes `1234` before it
 * is keyed, and `1234` typed also looks for `১২৩৪` in a plate painted in Bangla,
 * whose key would otherwise carry no digits at all.
 *
 * **Eligibility is decided here, not in the browser.** Ineligible vehicles are
 * never offered as results. They are reported separately, with the reason, so
 * a lorry that does not appear is explained rather than mysterious — "DHAKA
 * METRO-TA-11-1234 is Under Maintenance" is an answer, an empty list is not.
 */
export async function searchVehicles(query: string): Promise<VehicleSearchResult> {
  const raw = query.trim()
  const key = plateSearchKey(raw)
  const hasBangla = /[ঀ-৿]/.test(raw)

  if (key.length < MIN_PLATE_QUERY_LENGTH && !hasBangla) {
    return { results: [], unavailable: [], unavailableCount: 0 }
  }

  const clauses: Record<string, RegExp>[] = []
  if (key.length >= MIN_PLATE_QUERY_LENGTH) {
    clauses.push({ registrationNoKey: new RegExp(escapeRegex(key)) })
  }
  if (/^\d+$/.test(key)) {
    clauses.push({ registrationNo: new RegExp(escapeRegex(banglaDigits(key))) })
  }
  if (hasBangla) {
    clauses.push({ registrationNo: new RegExp(escapeRegex(raw), 'i') })
  }

  const tail =
    key.length >= MIN_PLATE_QUERY_LENGTH
      ? await VehicleModel.find({ registrationNoKey: new RegExp(`${escapeRegex(key)}$`) }).limit(
          PLATE_CANDIDATE_LIMIT,
        )
      : []
  const rest = await VehicleModel.find({
    $or: clauses,
    _id: { $nin: tail.map((vehicle) => vehicle._id) },
  }).limit(PLATE_CANDIDATE_LIMIT)

  const options = await buildVehicleOptions([...tail, ...rest], key)

  const sorted = options.sort((a, b) =>
    comparePlates(
      { key: plateSearchKey(a.vehicle.registrationNo), label: a.vehicle.registrationNo },
      { key: plateSearchKey(b.vehicle.registrationNo), label: b.vehicle.registrationNo },
      key,
    ),
  )

  const eligible = sorted.filter((option) => option.blocker === null)
  const blocked = sorted.filter((option) => option.blocker !== null)

  const unavailable: UnavailableVehicle[] = blocked
    .slice(0, MAX_UNAVAILABLE_REPORTED)
    .map((option) => ({
      id: option.vehicle.id,
      registrationNo: option.vehicle.registrationNo,
      vendorName: option.vendor.name,
      reason: option.blocker ?? '',
    }))

  return {
    results: eligible.slice(0, MAX_VEHICLE_RESULTS),
    unavailable,
    unavailableCount: blocked.length,
  }
}

// --- Challan candidates ----------------------------------------------------

export function sourceLinesOf(challan: ChallanDocument): SourceLine[] {
  return challan.items.map((item) => ({
    productName: item.productName,
    model: item.productModel,
    qty: item.qty,
  }))
}

export interface OtherTripLines {
  lines: TripLine[]
  /** What those trips deliberately left for a later one. */
  reserved: ReservedLine[]
  trips: CandidateTripRef[]
}

/**
 * Every line other trips carry against each of these challans, and which
 * trips they are.
 *
 * One multikey read on `challans.challanId`. Every status counts — a delivered
 * refrigerator is exactly as gone as one on a lorry — and there is no cancelled
 * state to leave out, because a trip that did not happen was deleted.
 */
export async function otherTripLinesFor(
  challanIds: IdLike[],
  excludeTripId?: string | null,
): Promise<Map<string, OtherTripLines>> {
  const result = new Map<string, OtherTripLines>()

  if (challanIds.length === 0) {
    return result
  }

  const trips = await DeliveryModel.find({
    'challans.challanId': { $in: challanIds },
    ...(excludeTripId ? { _id: { $ne: excludeTripId } } : {}),
  }).select('tripNumber status vehicle challans')

  const wanted = new Set(challanIds.map(String))

  for (const trip of trips) {
    for (const challan of trip.challans) {
      const key = String(challan.challanId)
      if (!wanted.has(key)) {
        continue
      }

      const entry = result.get(key) ?? { lines: [], reserved: [], trips: [] }
      /**
       * Through `toTripLines` rather than line by line, so what came back off
       * this trip is attached to the line it came back off. Allocation reads
       * the net: goods that went out and returned are on a shelf at the depot,
       * and the challan is waiting for another lorry exactly as before.
       */
      entry.lines.push(...toTripLines(challan))
      entry.reserved.push(...heldLinesOf(challan, String(trip._id)))
      entry.trips.push({
        id: String(trip._id),
        tripNumber: trip.tripNumber,
        status: trip.status as TripStatus,
        registrationNo: trip.vehicle.registrationNo,
      })
      result.set(key, entry)
    }
  }

  return result
}

export async function buildCandidates(
  challans: ChallanDocument[],
  excludeTripId?: string | null,
): Promise<ChallanCandidate[]> {
  const others = await otherTripLinesFor(
    challans.map((challan) => challan._id),
    excludeTripId,
  )

  return challans.map((challan) => {
    const other = others.get(String(challan._id)) ?? { lines: [], reserved: [], trips: [] }
    const lines = allocateLines(sourceLinesOf(challan), other.lines)
    const progress = progressOf(lines)

    return {
      id: String(challan._id),
      challanNumber: challan.challanNumber,
      slNumber: challan.slNumber,
      customerName: challan.customerName,
      deliveryAddress: challan.deliveryAddress,
      thana: challan.thana,
      district: challan.district,
      location: challan.resolvedLocation
        ? {
            district: challan.resolvedLocation.district,
            thana: challan.resolvedLocation.thana,
            locationType: challan.resolvedLocation.locationType as LocationType,
          }
        : null,
      receiverMobile: challan.receiverMobile,
      submittedAt: challan.submittedAt.toISOString(),
      lines,
      ordered: progress.ordered,
      dispatched: progress.dispatched,
      remaining: progress.remaining,
      trips: other.trips,
    }
  })
}

/**
 * The cart's search box: whatever identifier the operator has in front of
 * them. The challan number off a back page, the SL somebody read out, a
 * customer's name, or the receiver's phone number — the same set the Challan
 * list searches, narrowed to what identifies a delivery rather than a product.
 */
export async function searchChallans(query: string): Promise<ChallanDocument[]> {
  const pattern = new RegExp(escapeRegex(query), 'i')
  const or: Record<string, unknown>[] = [
    { challanNumber: pattern },
    { customerName: pattern },
    { zonePo: pattern },
  ]

  const digits = query.replace(/\D/g, '')
  if (digits.length >= 4) {
    const mobile = normalizeMobile(query)
    or.push({ receiverMobile: new RegExp(escapeRegex(/^01\d{9}$/.test(mobile) ? mobile : digits)) })
  }

  const asNumber = Number.parseInt(query, 10)
  if (/^\d+$/.test(query.trim()) && Number.isInteger(asNumber)) {
    or.push({ slNumber: asNumber })
  }

  // Newest first on the indexed `createdAt` — the same instant as `submittedAt`
  // for a challan, which is written at creation.
  return ChallanModel.find({ $or: or })
    .sort({ createdAt: -1 })
    .limit(MAX_CHALLAN_CANDIDATES)
}

/**
 * The challans already on a trip, in the order it carries them — how an edit
 * reloads its cart with live allocation. An id that no longer exists is simply
 * absent; the trip's own copy is what the workspace falls back to.
 */
export async function findChallansByIds(ids: string[]): Promise<ChallanDocument[]> {
  if (ids.length === 0) {
    return []
  }

  const found = await ChallanModel.find({ _id: { $in: ids } })
  const byId = new Map(found.map((challan) => [String(challan._id), challan]))

  return ids.flatMap((id) => {
    const challan = byId.get(id)
    return challan ? [challan] : []
  })
}

/**
 * One barcode read.
 *
 * The back page's barcode encodes the challan number and nothing else — one
 * value, so a scanner and a person reading the page cannot disagree. So this
 * is an exact lookup on the unique index, with case and stray whitespace set
 * aside; a five-digit read is tried as the SL number printed beside it, which
 * is what somebody keying it by hand off a torn barcode would type.
 */
export async function findByScan(code: string): Promise<ChallanDocument | null> {
  const cleaned = code.trim().toUpperCase().replace(/\s+/g, '')

  const byNumber = await ChallanModel.findOne({ challanNumber: cleaned })
  if (byNumber) {
    return byNumber
  }

  if (/^\d+$/.test(cleaned)) {
    return ChallanModel.findOne({ slNumber: Number.parseInt(cleaned, 10) })
  }

  return null
}
