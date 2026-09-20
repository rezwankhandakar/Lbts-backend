import { Types } from 'mongoose'
import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { nextSequence } from '../../utils/counter'
import { assertTripHasNoAdvances } from '../accounts/accounts.guards'
import { MAX_CHALLAN_ITEMS } from '../challan/challan.constants'
import { ChallanModel } from '../challan/challan.model'
import type { ChallanDocument } from '../challan/challan.model'
import { applyDeliveryItems } from '../challan/challan.service'
import type { UserDocument } from '../user/user.model'
import { AssignmentModel } from '../vendor/assignment.model'
import { addDriverToVendor, applyDriverPhoto } from '../vendor/driver.service'
import { DriverModel } from '../vendor/driver.model'
import type { DriverDocument } from '../vendor/driver.model'
import { VehicleModel } from '../vendor/vehicle.model'
import type { VehicleDocument } from '../vendor/vehicle.model'
import { VendorModel } from '../vendor/vendor.model'
import type { VendorDocument } from '../vendor/vendor.model'
import { recordActivity } from '../vendor/vendor.activity'
import { vendorAcceptsAssignments } from '../vendor/vendor.constants'
import type { DriverStatus, VehicleStatus, VendorStatus } from '../vendor/vendor.constants'
import type { DriverDetail } from '../vendor/vendor.serializer'
import { escapeRegex, resolveActorNames } from '../vendor/vendor.lookups'
import { assertCanChangeTrip, assertCanPhotographDriver } from './delivery.access'
import {
  comparisonKey,
  findOverages,
  lineKey,
  rebuildChallanItems,
  sameItems,
} from './delivery.allocation'
import type { Overage, ReservedLine, SourceLine, TripLine } from './delivery.allocation'
import {
  driverTripBlocker,
  formatTripNumber,
  plateSearchKey,
  tripCounterKey,
  tripIsEditable,
  vehicleTripBlocker,
} from './delivery.constants'
import type { TripStatus } from './delivery.constants'
import { readChallanDispatchDetail, refreshChallanDispatch } from './delivery.dispatch'
import type { ChallanDispatchDetail } from './delivery.dispatch'
import { buildVehicleOptions, otherTripLinesFor, sourceLinesOf } from './delivery.lookups'
import { DeliveryModel } from './delivery.model'
import type { Delivery, DeliveryDocument } from './delivery.model'
import { toTripRecord } from './delivery.serializer'
import type { TripRecord, TripVehicleOption } from './delivery.serializer'
import type {
  CreateTripInput,
  ListTripsQuery,
  QuickDriverInput,
  TripChallanInput,
  TripLineInput,
  UpdateTripInput,
} from './delivery.validation'

/**
 * The Delivery module's writes and its lists.
 *
 * The shape of a confirmation, in order, and the order is the design:
 *
 * 1. a replayed confirmation finds the trip the first one made;
 * 2. the vehicle, its vendor and the trip's driver are loaded and proved able
 *    to run — here, not in the browser;
 * 3. every challan is re-read, and each product line's source is copied off
 *    the challan rather than taken from the request;
 * 4. what other trips already carry is added up, and anything the trip would
 *    take past the paper is asked about;
 * 5. only then is a number allocated and the record written.
 *
 * Nothing is allocated before the point a confirmation can still be refused,
 * so a refused one burns no trip number — the same rule Challan keeps.
 */

// --- Serialising ------------------------------------------------------------

async function serializeMany(
  trips: DeliveryDocument[],
  withChallans: boolean,
): Promise<TripRecord[]> {
  const names = await resolveActorNames(
    trips.flatMap((trip) => [
      trip.createdBy,
      trip.updatedBy,
      trip.billUpdatedBy,
      ...trip.challans.map((challan) => challan.completedBy),
    ]),
  )
  return trips.map((trip) => toTripRecord(trip, names, { withChallans }))
}

async function serialize(trip: DeliveryDocument): Promise<TripRecord> {
  const [only] = await serializeMany([trip], true)
  return only
}

async function findTripOr404(id: string): Promise<DeliveryDocument> {
  const trip = await DeliveryModel.findById(id)
  if (!trip) {
    throw new AppError(404, 'Trip not found.')
  }
  return trip
}

// --- Listing ---------------------------------------------------------------

function buildFilter(query: ListTripsQuery): QueryFilter<Delivery> {
  const clauses: QueryFilter<Delivery>[] = []

  if (query.status !== 'all') {
    clauses.push({ status: query.status })
  }
  if (query.vendorId) {
    /**
     * An ObjectId rather than the string, because the same filter feeds the
     * totals aggregation below and a `$match` does no schema casting — the
     * lesson the Vendor summary learned. A `find` accepts either.
     */
    clauses.push({ vendorId: new Types.ObjectId(query.vendorId) })
  }
  if (query.from || query.to) {
    const range: { $gte?: Date; $lte?: Date } = {}
    if (query.from) range.$gte = new Date(`${query.from}T00:00:00.000Z`)
    if (query.to) range.$lte = new Date(`${query.to}T00:00:00.000Z`)
    clauses.push({ tripDate: range })
  }
  /**
   * The trip bill backlog. An equality with `null` matches both a bill set to
   * null and a trip written before the field existed, which is exactly "nobody
   * has entered it" — and never a zero, which somebody did enter.
   */
  if (query.bill === 'no-rent') {
    clauses.push({ tripRent: null })
  }
  if (query.bill === 'no-labour') {
    clauses.push({ labourBill: null })
  }

  if (query.search) {
    /**
     * Whatever somebody has in front of them: the trip number off a manifest,
     * the last digits of a plate, a driver or vendor, or any challan on the
     * trip — by number or by customer. The plate is matched on its key too,
     * so "ta 1234" finds DHAKA METRO-TA-11-1234.
     */
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    const or: QueryFilter<Delivery>[] = [
      { tripNumber: pattern },
      { 'vehicle.registrationNo': pattern },
      { 'vendor.name': pattern },
      { 'driver.name': pattern },
      { 'challans.challanNumber': pattern },
      { 'challans.customerName': pattern },
    ]
    const plateKey = plateSearchKey(query.search)
    if (plateKey.length >= 2) {
      or.push({ 'vehicle.registrationNoKey': new RegExp(escapeRegex(plateKey)) })
    }
    clauses.push({ $or: or })
  }

  return clauses.length > 0 ? { $and: clauses } : {}
}

export interface ListTripsResult {
  records: TripRecord[]
  total: number
  totalQty: number
  totalChallans: number
  /** Every trip rent on the matching trips, a blank counted as nothing. */
  totalRent: number
  /** Every labour bill on the matching trips, a blank counted as nothing. */
  totalLabour: number
  /** Matching trips with no rent entered yet. */
  blankRent: number
  /** Matching trips with no labour bill entered yet. */
  blankLabour: number
}

/** 1 when the field is null or absent, 0 otherwise — for counting blanks in a `$group`. */
function countBlank(field: string) {
  return { $sum: { $cond: [{ $eq: [{ $ifNull: [field, null] }, null] }, 1, 0] } }
}

/**
 * The trips list, with totals that answer the filters rather than the page —
 * the rule every list here follows. "How many pieces did Malek Transport carry
 * last month" is one filter and one number.
 */
export async function listTrips(query: ListTripsQuery): Promise<ListTripsResult> {
  const filter = buildFilter(query)
  const skip = (query.page - 1) * query.limit

  const [records, totals] = await Promise.all([
    DeliveryModel.find(filter).sort({ tripDate: -1, createdAt: -1 }).skip(skip).limit(query.limit),
    DeliveryModel.aggregate<{
      total: number
      totalQty: number
      totalChallans: number
      totalRent: number
      totalLabour: number
      blankRent: number
      blankLabour: number
    }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          totalQty: { $sum: '$totalQty' },
          totalChallans: { $sum: '$challanCount' },
          // `$sum` skips a null, so a bill nobody has entered adds nothing.
          totalRent: { $sum: '$tripRent' },
          totalLabour: { $sum: '$labourBill' },
          blankRent: countBlank('$tripRent'),
          blankLabour: countBlank('$labourBill'),
        },
      },
    ]),
  ])

  return {
    records: await serializeMany(records, false),
    total: totals[0]?.total ?? 0,
    totalQty: totals[0]?.totalQty ?? 0,
    totalChallans: totals[0]?.totalChallans ?? 0,
    totalRent: totals[0]?.totalRent ?? 0,
    totalLabour: totals[0]?.totalLabour ?? 0,
    blankRent: totals[0]?.blankRent ?? 0,
    blankLabour: totals[0]?.blankLabour ?? 0,
  }
}

/**
 * The dispatch state of one challan, for the challan's own page.
 *
 * It lives here rather than in Challan because every word of the answer is
 * about trips: which ones carried it, how much of each line went, and what they
 * corrected. Challan stores the summary it filters on and nothing more.
 */
export async function getChallanDispatch(challanId: string): Promise<ChallanDispatchDetail> {
  const challan = await ChallanModel.findById(challanId)

  if (!challan) {
    throw new AppError(404, 'Challan not found.')
  }

  return readChallanDispatchDetail(challan)
}

export async function getTrip(id: string): Promise<TripRecord> {
  return serialize(await findTripOr404(id))
}

/**
 * One barcode read off a **printed manifest**: which trip is this sheet?
 *
 * The third scan question in this module, and deliberately its own endpoint
 * for the same reason the other two are: `challan-candidates/scan` means "put
 * this on a lorry", `receipts/scan` means "this came back signed", and this
 * one means "open this trip". A scan meaning different things depending on
 * which page was open is exactly the sort of thing somebody discovers at a
 * gate.
 *
 * The manifest carries the trip number in its **stored** form, which is unique
 * across the collection and indexed, so this is one exact indexed read and
 * never a search. The code is normalised rather than refused — a scanner on a
 * machine with Caps Lock quirks types the same number in the wrong case.
 */
export async function findTripByScan(code: string): Promise<TripRecord> {
  const tripNumber = code.trim().toUpperCase().replace(/\s+/g, '')
  const trip = await DeliveryModel.findOne({ tripNumber })

  if (!trip) {
    throw new AppError(404, `No trip carries the barcode ${tripNumber}.`)
  }

  return serialize(trip)
}

export interface TripStats {
  total: number
  /** Trips with a challan still waiting for its signed copy. */
  open: number
  /** Trips whose every challan has been signed for. */
  completed: number
  today: number
  todayQty: number
}

/**
 * Counts for the page header and the dashboard. "Today" is the viewer's day,
 * sent by the browser, because a trip date is a calendar day and the server's
 * UTC midnight is six hours out of step with the operation's.
 */
export async function getTripStats(today: string): Promise<TripStats> {
  const day = new Date(`${today}T00:00:00.000Z`)

  const [byStatus, todays] = await Promise.all([
    DeliveryModel.aggregate<{ _id: TripStatus; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    DeliveryModel.aggregate<{ count: number; qty: number }>([
      { $match: { tripDate: day } },
      { $group: { _id: null, count: { $sum: 1 }, qty: { $sum: '$totalQty' } } },
    ]),
  ])

  const count = (status: TripStatus) => byStatus.find((row) => row._id === status)?.count ?? 0

  return {
    total: byStatus.reduce((sum, row) => sum + row.count, 0),
    open: count('Open'),
    completed: count('Completed'),
    today: todays[0]?.count ?? 0,
    todayQty: todays[0]?.qty ?? 0,
  }
}

// --- Vehicle context -------------------------------------------------------

/**
 * One vehicle with everything a trip fills from — for a workspace reopening a
 * trip, which knows the vehicle by id rather than by a search. Returned even
 * when the vehicle has since become ineligible, with the reason, because the
 * trip on it still exists and somebody has to be told.
 */
export async function getVehicleOption(id: string): Promise<TripVehicleOption> {
  const vehicle = await VehicleModel.findById(id)
  if (!vehicle) {
    throw new AppError(404, 'Vehicle not found.')
  }

  const [option] = await buildVehicleOptions([vehicle], plateSearchKey(vehicle.registrationNo))
  if (!option) {
    throw new AppError(404, 'This vehicle no longer has a vendor on record.')
  }
  return option
}

// --- Parties ---------------------------------------------------------------

interface TripParties {
  vehicle: VehicleDocument
  vendor: VendorDocument
  driver: DriverDocument
  assigned: DriverDocument | null
}

/**
 * The vehicle, its vendor and the trip's driver — loaded and proved able to
 * run, whatever the browser showed.
 *
 * The vendor is **read off the vehicle**, never taken from a request, which is
 * the Vendor module's own rule. And the driver has to work for that vendor: a
 * lorry run by Malek Transport is not driven by Karim Transport's driver, and
 * saying so here is what makes it a property of the system rather than a
 * filter in a dropdown.
 */
async function resolveParties(vehicleId: string, driverId: string): Promise<TripParties> {
  const vehicle = await VehicleModel.findById(vehicleId)
  if (!vehicle) {
    throw new AppError(404, 'That vehicle is no longer on record.')
  }

  const [vendor, driver, assignment] = await Promise.all([
    VendorModel.findById(vehicle.vendorId),
    DriverModel.findById(driverId),
    AssignmentModel.findOne({ vehicleId: vehicle._id, status: 'Active' }).select('driverId'),
  ])

  if (!vendor) {
    throw new AppError(404, 'The vendor running this vehicle is no longer on record.')
  }

  const vehicleBlocker = vehicleTripBlocker(
    vehicle.status as VehicleStatus,
    vendor.status as VendorStatus,
  )
  if (vehicleBlocker) {
    throw new AppError(409, `${vehicle.registrationNo} cannot take a trip. ${vehicleBlocker}`)
  }

  if (!driver) {
    throw new AppError(404, 'That driver is no longer on record.')
  }
  if (String(driver.vendorId) !== String(vehicle.vendorId)) {
    throw new AppError(
      409,
      `${driver.name} drives for another vendor. A trip's driver must work for ${vendor.name}, which runs this vehicle.`,
    )
  }

  const driverBlocker = driverTripBlocker(driver.status as DriverStatus)
  if (driverBlocker) {
    throw new AppError(409, `${driver.name} cannot drive this trip. ${driverBlocker}`)
  }

  const assigned =
    assignment === null
      ? null
      : String(assignment.driverId) === String(driver._id)
        ? driver
        : await DriverModel.findById(assignment.driverId)

  return { vehicle, vendor, driver, assigned }
}

function vehicleCopy(vehicle: VehicleDocument) {
  return {
    vehicleCode: vehicle.vehicleCode,
    registrationNo: vehicle.registrationNo,
    registrationNoKey: plateSearchKey(vehicle.registrationNo),
    brand: vehicle.brand,
    vehicleModel: vehicle.vehicleModel,
    ownershipType: vehicle.ownershipType,
  }
}

function driverCopy(driver: DriverDocument) {
  return {
    driverCode: driver.driverCode,
    name: driver.name,
    mobile: driver.mobile,
    licenseNumber: driver.licenseNumber,
    licenseExpiry: driver.licenseExpiry ?? null,
  }
}

function assignedCopy(assigned: DriverDocument | null) {
  return assigned
    ? { driverId: assigned._id, driverCode: assigned.driverCode, name: assigned.name }
    : null
}

// --- Challans --------------------------------------------------------------

type StoredChallan = DeliveryDocument['challans'][number]

/**
 * The source a trip already copied for one challan line — the only record left
 * of it once the challan itself has been deleted.
 */
function storedSource(kept: StoredChallan | null, index: number): SourceLine | null {
  const stored = kept?.lines.find((line) => line.sourceIndex === index)?.source
  return stored
    ? { productName: stored.productName, model: stored.productModel, qty: stored.qty }
    : null
}

/**
 * The source this trip already recorded for a line it already carried —
 * matched on the line it draws on *and* the product it carries, so a
 * substitution keeps the model it replaced rather than picking up its own.
 */
function priorSource(kept: StoredChallan | null, line: TripLineInput): SourceLine | null {
  const stored = kept?.lines.find(
    (candidate) =>
      candidate.sourceIndex === line.sourceIndex &&
      lineKey({ productName: candidate.productName, model: candidate.productModel }) ===
        lineKey({ productName: line.productName, model: line.model }),
  )?.source

  return stored
    ? { productName: stored.productName, model: stored.productModel, qty: stored.qty }
    : null
}

interface BuiltChallan {
  /** The document to store. */
  value: Record<string, unknown>
  /** The live challan, when it still exists — what allocation is measured against. */
  challan: ChallanDocument | null
  challanNumber: string
  lines: TripLine[]
  /** What this trip holds back for a later one, read off the challan's own lines. */
  reserved: ReservedLine[]
  /**
   * What this trip has already recorded as returned, carried over from what is
   * stored. A return holds a line open exactly as a reservation does, so it has
   * to reach `planCorrections` — otherwise the second save of a trip would
   * correct away goods that are sitting on a shelf at the depot.
   */
  returned: ReservedLine[]
}

/**
 * Turns the cart's challans into what the trip stores.
 *
 * Every challan is re-read. Its number, serial and resolved location come off
 * the record, and every product line that claims a source has that source
 * **copied off the challan** — a request can say which line it draws on, never
 * what that line ordered. A challan that has since been deleted may stay on a
 * trip it was already on, carried by the copy the trip took; it may not be
 * added to one.
 */
async function buildChallans(
  inputs: TripChallanInput[],
  existing: DeliveryDocument | null,
): Promise<BuiltChallan[]> {
  const docs = await ChallanModel.find({ _id: { $in: inputs.map((input) => input.challanId) } })
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]))
  const prior = new Map<string, StoredChallan>(
    (existing?.challans ?? []).map((challan) => [String(challan.challanId), challan]),
  )

  return inputs.map((input, position) => {
    const challan = byId.get(input.challanId) ?? null
    const kept = prior.get(input.challanId) ?? null

    if (!challan && !kept) {
      throw new AppError(404, `Challan ${position + 1} on this trip is no longer on record.`)
    }

    const label = challan?.challanNumber ?? kept?.challanNumber ?? ''
    const sources = challan ? sourceLinesOf(challan) : null

    const lines: TripLine[] = input.lines.map((line) => {
      if (line.sourceIndex === null) {
        return { ...line, source: null }
      }

      /**
       * A line this trip already carried keeps the source it was first given,
       * and that matters now that a correction rewrites the challan: re-reading
       * would turn "3 of 4" into "3 of 3" the moment the challan was corrected
       * to 3, and the manifest would stop saying what this trip did. Only a
       * line new to the trip takes its source from the paper as it stands.
       */
      const source =
        priorSource(kept, line) ??
        (sources ? sources[line.sourceIndex] : storedSource(kept, line.sourceIndex))

      if (!source) {
        throw new AppError(
          400,
          `A line on ${label} refers to product row ${line.sourceIndex + 1}, which the challan does not have.`,
        )
      }

      return { ...line, source }
    })

    /**
     * A reservation names a line, and what that line *is* comes off the
     * challan — so a request cannot hold back a product the paper does not
     * carry. A reservation against a line that no longer exists is dropped
     * rather than refused: the challan has moved on, and there is nothing left
     * to hold.
     */
    const reserved: ReservedLine[] = input.reserved.flatMap((entry) => {
      const source = sources?.[entry.sourceIndex] ?? storedSource(kept, entry.sourceIndex)
      return source
        ? [
            {
              productName: source.productName,
              model: source.model,
              qty: entry.qty,
              /**
               * This trip, whatever its id turns out to be. Holds are grouped
               * by trip so two trips' reservations cannot stack — see
               * `rebuildChallanItems` — and the trip being saved is excluded
               * from the others, so a literal cannot collide with a real id.
               */
              tripKey: 'this-trip',
            },
          ]
        : []
    })

    /**
     * What a delivery already recorded survives an edit to the manifest.
     *
     * A trip stays editable while any challan on it is still waiting for its
     * signed copy, so an edit can perfectly well land on a trip where one of
     * three challans has already been delivered and signed for. Rebuilding the
     * challan entry from the request alone would silently drop that challan's
     * return, its floor, its carrying charges and its receipt — and the trip
     * would quietly reopen. So the delivery half is carried across from what
     * is stored, and only the manifest half is rebuilt.
     *
     * Returns are the one part that cannot simply be copied: they name a
     * product this trip carried, and an edit may have removed that product or
     * cut it below what came back. So each is kept only while the trip still
     * carries its product, and clamped to what it now carries.
     */
    const carriedQty = new Map<string, number>()
    for (const line of lines) {
      const key = lineKey(line)
      carriedQty.set(key, (carriedQty.get(key) ?? 0) + line.qty)
    }

    const returned = (kept?.returned ?? []).flatMap((entry) => {
      const available = carriedQty.get(
        lineKey({ productName: entry.productName, model: entry.productModel }),
      )
      if (!available) {
        return []
      }
      return [
        {
          productName: entry.productName,
          productModel: entry.productModel,
          productModelKey: entry.productModelKey,
          qty: Math.min(entry.qty, available),
          reason: entry.reason,
        },
      ]
    })

    const original = challan
      ? {
          customerName: challan.customerName,
          deliveryAddress: challan.deliveryAddress,
          thana: challan.thana,
          district: challan.district,
          receiverMobile: challan.receiverMobile,
        }
      : kept?.original

    const location = challan
      ? challan.resolvedLocation
        ? {
            district: challan.resolvedLocation.district,
            thana: challan.resolvedLocation.thana,
            locationType: challan.resolvedLocation.locationType,
          }
        : null
      : (kept?.location ?? null)

    return {
      challan,
      challanNumber: label,
      lines,
      reserved,
      returned: returned.map((line) => ({
        productName: line.productName,
        model: line.productModel,
        qty: line.qty,
        tripKey: 'this-trip',
      })),
      value: {
        challanId: challan?._id ?? kept?.challanId,
        challanNumber: label,
        slNumber: challan?.slNumber ?? kept?.slNumber,
        customerName: input.customerName,
        deliveryAddress: input.deliveryAddress,
        thana: input.thana,
        district: input.district,
        receiverMobile: input.receiverMobile,
        original,
        location,
        note: input.note,
        lines: lines.map((line) => ({
          sourceIndex: line.sourceIndex,
          source: line.source
            ? {
                productName: line.source.productName,
                productModel: line.source.model,
                qty: line.source.qty,
              }
            : null,
          productName: line.productName,
          productModel: line.model,
          productModelKey: comparisonKey(line.model),
          qty: line.qty,
        })),
        reserved: reserved.map((line) => ({
          productName: line.productName,
          productModel: line.model,
          productModelKey: comparisonKey(line.model),
          qty: line.qty,
        })),

        // The delivery half — see the note above `returned`.
        returned,
        floorNo: kept?.floorNo ?? null,
        carrying: (kept?.carrying ?? []).map((entry) => ({
          kind: entry.kind,
          description: entry.description,
          amount: entry.amount,
        })),
        deliveryNote: kept?.deliveryNote ?? '',
        receivedCopy: kept?.receivedCopy ?? null,
        copyMissing: kept?.copyMissing ?? false,
        copyMissingReason: kept?.copyMissingReason ?? '',
        completedAt: kept?.completedAt ?? null,
        completedBy: kept?.completedBy ?? null,
      },
    }
  })
}

/** Lines past what a challan ordered, named by challan. */
export interface TripOverage extends Overage {
  challanId: string
  challanNumber: string
}

/**
 * Raised when a trip would take a challan line past what the paper ordered,
 * and the operator has not said they meant it.
 *
 * A refusal carrying what it refused, in the shape `DuplicateGatePassError` and
 * `ActiveAssignmentError` use: it is a question rather than a fault, and the
 * workspace needs the lines to ask it.
 */
export class TripOverageError extends Error {
  public readonly statusCode = 409
  public readonly overages: TripOverage[]

  constructor(overages: TripOverage[]) {
    super(
      overages.length === 1
        ? `This trip would send more ${overages[0].productName} on ${overages[0].challanNumber} than the challan orders.`
        : `This trip would send more than the challan orders on ${overages.length} lines.`,
    )
    this.name = 'TripOverageError'
    this.overages = overages
  }
}

/** A challan whose lines this trip changes, and what they become. */
interface ChallanCorrection {
  challan: ChallanDocument
  items: SourceLine[]
}

/**
 * What confirming this trip does to the challans on it — worked out **before**
 * anything is written, so a trip that would leave a challan impossible is
 * refused rather than half-applied.
 *
 * Two things come out of one pass over each challan: whether the trip sends
 * more than the paper orders (a question, asked once), and what the paper
 * should say afterwards (`rebuildChallanItems`, over every trip carrying it
 * and everything reserved, so the answer is the same whichever trip is being
 * saved).
 */
async function planCorrections(
  built: BuiltChallan[],
  acknowledged: boolean,
  excludeTripId: Types.ObjectId | null,
): Promise<ChallanCorrection[]> {
  const live = built.filter((entry) => entry.challan !== null)
  const others = await otherTripLinesFor(
    live.map((entry) => (entry.challan as ChallanDocument)._id),
    excludeTripId ? String(excludeTripId) : null,
  )

  const overages: TripOverage[] = []
  const corrections: ChallanCorrection[] = []

  for (const entry of live) {
    const challan = entry.challan as ChallanDocument
    const other = others.get(String(challan._id)) ?? { lines: [], reserved: [], trips: [] }
    const current = sourceLinesOf(challan)

    overages.push(
      ...findOverages(current, other.lines, entry.lines).map((overage) => ({
        ...overage,
        challanId: String(challan._id),
        challanNumber: challan.challanNumber,
      })),
    )

    /**
     * What this trip is holding: its reservations, plus anything it has
     * already recorded as returned. Both keep a line from being cut away
     * underneath them, and a return that vanished here would let the second
     * save of a trip correct away goods that are sitting on a shelf.
     */
    const held = [...other.reserved, ...entry.reserved, ...entry.returned]

    const next = rebuildChallanItems(current, [...other.lines, ...entry.lines], held)

    if (sameItems(current, next)) {
      continue
    }

    if (next.length === 0) {
      throw new AppError(
        409,
        `This trip would leave ${challan.challanNumber} with no products at all. ` +
          'Split the challan instead of emptying it, or take it off the trip.',
      )
    }

    if (next.length > MAX_CHALLAN_ITEMS) {
      throw new AppError(
        409,
        `${challan.challanNumber} would end up with ${next.length} product lines, and a challan may carry ${MAX_CHALLAN_ITEMS}.`,
      )
    }

    corrections.push({ challan, items: next })
  }

  if (overages.length > 0 && !acknowledged) {
    throw new TripOverageError(overages)
  }

  return corrections
}

/**
 * Writes the corrections onto the challans, **after** the trip is saved.
 *
 * That order is the deliberate one. The trip is the record of what physically
 * happened and is the more important of the two; a challan corrected for a
 * trip that then failed to save would be a change nobody could explain, while
 * a trip saved whose challan correction failed is a challan still saying what
 * it said before — visible, and put right by saving the trip again.
 *
 * So a failure here is reported and never thrown: the operator's trip is
 * filed, and the manifest already records what actually went.
 */
async function applyCorrections(
  corrections: ChallanCorrection[],
  actor: UserDocument,
): Promise<void> {
  for (const correction of corrections) {
    try {
      await applyDeliveryItems(correction.challan, correction.items, actor)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `[delivery] ${correction.challan.challanNumber} was not corrected to match the trip: ${message}`,
      )
    }
  }
}

/**
 * Which fields a duplicate-key error was actually about — empty for anything
 * that is not one.
 *
 * *Which* matters, and a collection this module did not start from empty is
 * why. A clash on `submissionKey` is a confirmation arriving twice and the
 * first one's trip is the honest answer; a clash on the number means the
 * counter has fallen behind what is already stored, which another number
 * fixes; a clash on anything else is a real fault and must be reported as one
 * rather than dressed up as "already created".
 */
function duplicateKeyPaths(error: unknown): string[] {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) {
    return []
  }

  const keys = error as { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> }
  return Object.keys(keys.keyPattern ?? keys.keyValue ?? {})
}

function tripSentence(trip: DeliveryDocument): string {
  return `${trip.vehicle.registrationNo}, driver ${trip.driver.name}, ${trip.challanCount} challan${
    trip.challanCount === 1 ? '' : 's'
  } (${trip.totalQty} pcs)`
}

// --- Writes ----------------------------------------------------------------

export interface CreateTripResult {
  record: TripRecord
  /** True when this was a replay of a confirmation that had already succeeded. */
  replayed: boolean
}

export async function createTrip(
  input: CreateTripInput,
  actor: UserDocument,
): Promise<CreateTripResult> {
  const existing = await DeliveryModel.findOne({
    createdBy: actor._id,
    submissionKey: input.submissionKey,
  })
  if (existing) {
    return { record: await serialize(existing), replayed: true }
  }

  const parties = await resolveParties(input.vehicleId, input.driverId)
  const built = await buildChallans(input.challans, null)
  const corrections = await planCorrections(built, input.acknowledgeOverage, null)

  const body = {
    vendorId: parties.vendor._id,
    vehicleId: parties.vehicle._id,
    driverId: parties.driver._id,
    vendor: {
      vendorCode: parties.vendor.vendorCode,
      name: parties.vendor.name,
      mobile: parties.vendor.mobile,
    },
    vehicle: vehicleCopy(parties.vehicle),
    driver: driverCopy(parties.driver),
    assignedDriver: assignedCopy(parties.assigned),
    tripDate: input.tripDate,
    note: input.note,
    challans: built.map((entry) => entry.value),
    submissionKey: input.submissionKey,
    createdBy: actor._id,
  }

  /**
   * Past the last refusal, so only now is a number spent — and at most twice.
   *
   * A second attempt is for one situation: the vendor's counter sitting behind
   * a number the collection already holds, which is what a restored dump or a
   * cleared counter leaves. Allocating again steps over it. A burnt number
   * costs nothing; a vendor whose every confirmation failed forever would cost
   * a great deal.
   */
  let trip: DeliveryDocument | null = null

  for (let attempt = 0; attempt < 2 && trip === null; attempt += 1) {
    const serial = await nextSequence(tripCounterKey(String(parties.vendor._id)))
    const candidate = new DeliveryModel({
      ...body,
      tripNumber: formatTripNumber(parties.vendor.vendorCode, serial),
      vendorTripSerial: serial,
    })

    try {
      await candidate.save()
      trip = candidate
    } catch (error) {
      const clashed = duplicateKeyPaths(error)

      // Two presses racing past the replay check: the index lets exactly one
      // through, and the loser answers with the winner's trip.
      if (clashed.includes('submissionKey')) {
        const winner = await DeliveryModel.findOne({
          createdBy: actor._id,
          submissionKey: input.submissionKey,
        })
        if (winner) {
          return { record: await serialize(winner), replayed: true }
        }
      }

      const numbering = clashed.includes('tripNumber') || clashed.includes('vendorTripSerial')
      if (!numbering || attempt === 1) {
        throw error
      }
    }
  }

  if (trip === null) {
    throw new AppError(
      500,
      `Could not allocate a trip number for ${parties.vendor.name}. Try again in a moment.`,
    )
  }

  // The paper is brought in line with what went, now that the trip exists,
  // and every challan on it learns that it has left the gate.
  await applyCorrections(corrections, actor)
  await refreshChallanDispatch(trip.challans.map((challan) => challan.challanId))

  await recordActivity({
    vendorId: parties.vendor._id,
    action: 'trip.created',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary: `Trip ${trip.tripNumber} assigned: ${tripSentence(trip)}`,
    actor,
  })

  return { record: await serialize(trip), replayed: false }
}

/**
 * Correcting a trip that has not left the gate.
 *
 * The vehicle may change, within the same vendor: the number in front of this
 * trip is that vendor's serial, and moving it to another vendor would make the
 * number a lie. A trip that should belong to somebody else is deleted and
 * confirmed again under them. The vehicle and driver are only re-proved when
 * they change — a trip whose lorry went to the workshop after it was confirmed
 * can still have a note corrected, and the workspace says why it cannot be
 * saved against a *new* vehicle in that state.
 *
 * Every challan that still exists is re-read, so re-saving a trip re-confirms
 * it against the current paper.
 */
export async function updateTrip(
  id: string,
  input: UpdateTripInput,
  actor: UserDocument,
): Promise<TripRecord> {
  const trip = await findTripOr404(id)
  assertCanChangeTrip(trip, actor)

  if (!tripIsEditable(trip.status as TripStatus)) {
    throw new AppError(
      409,
      `A ${trip.status} trip has left the gate and its manifest is fixed. Move it back to Assigned to correct it.`,
    )
  }

  const partiesChanged =
    String(trip.vehicleId) !== input.vehicleId || String(trip.driverId) !== input.driverId

  if (partiesChanged) {
    const parties = await resolveParties(input.vehicleId, input.driverId)

    if (String(parties.vendor._id) !== String(trip.vendorId)) {
      throw new AppError(
        409,
        `${trip.tripNumber} is ${trip.vendor.name}'s trip. Choose one of their vehicles, or delete this trip and confirm a new one under ${parties.vendor.name}.`,
      )
    }

    trip.vehicleId = parties.vehicle._id
    trip.driverId = parties.driver._id
    trip.set('vehicle', vehicleCopy(parties.vehicle))
    trip.set('driver', driverCopy(parties.driver))
    trip.set('assignedDriver', assignedCopy(parties.assigned))
  }

  const built = await buildChallans(input.challans, trip)
  const corrections = await planCorrections(built, input.acknowledgeOverage, trip._id)

  /**
   * Taken before the write: a challan dropped from the trip has to be told it
   * is waiting again, and after the save there is nothing left to say it was
   * ever on this one.
   */
  const touched = trip.challans.map((challan) => String(challan.challanId))

  trip.set(
    'challans',
    built.map((entry) => entry.value),
  )
  trip.tripDate = input.tripDate
  trip.note = input.note
  trip.updatedBy = actor._id
  await trip.save()

  await applyCorrections(corrections, actor)
  await refreshChallanDispatch([
    ...touched,
    ...trip.challans.map((challan) => String(challan.challanId)),
  ])

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.updated',
    entityType: 'Trip',
    entityId: trip._id,
    entityLabel: trip.tripNumber,
    summary: `Trip ${trip.tripNumber} corrected: ${tripSentence(trip)}`,
    actor,
  })

  return serialize(trip)
}

/**
 * Removing a trip that is not going to happen.
 *
 * Only while it is `Open`: once every challan on it has been signed for, the
 * trip happened and the signatures say so. Deleting it releases every challan
 * quantity it held, which is the point — those challans are then free for the
 * trip that will actually carry them. The number is not reused; a gap in a
 * vendor's serial costs nothing, a reused one would put two trips on one line
 * of a bill.
 */
export async function removeTrip(id: string, actor: UserDocument): Promise<{ id: string }> {
  const trip = await findTripOr404(id)
  assertCanChangeTrip(trip, actor)

  if (!tripIsEditable(trip.status as TripStatus)) {
    throw new AppError(
      409,
      `Every challan on ${trip.tripNumber} has been signed for, so the trip happened and cannot be deleted. ` +
        'Remove a signed copy first if one was filed against the wrong trip.',
    )
  }

  await assertTripHasNoAdvances(trip._id, trip.tripNumber)

  const carried = trip.challans.map((challan) => String(challan.challanId))
  await trip.deleteOne()

  /**
   * The quantities it held are free again — though the corrections it made are
   * not undone, because those were statements about what physically existed
   * rather than about this trip.
   */
  await refreshChallanDispatch(carried)

  await recordActivity({
    vendorId: trip.vendorId,
    action: 'trip.deleted',
    entityType: 'Trip',
    entityId: null,
    entityLabel: trip.tripNumber,
    summary: `Trip ${trip.tripNumber} deleted before it was signed for: ${tripSentence(trip)}`,
    actor,
  })

  return { id: String(trip._id) }
}

// --- Drivers from a trip ---------------------------------------------------

/**
 * Adding a driver without leaving the trip.
 *
 * The vendor is the vehicle's — the body names a vehicle and nothing else — and
 * it has to be working, because a driver added under a suspended vendor is one
 * this trip could not then use. Everything else is the Vendor module's own
 * `addDriverToVendor`, so the driver is exactly the record the fleet tab would
 * have made: code, licence document, duplicate checks and activity entry.
 */
export async function createDriverForTrip(
  input: QuickDriverInput,
  actor: UserDocument,
): Promise<DriverDetail> {
  const vehicle = await VehicleModel.findById(input.vehicleId)
  if (!vehicle) {
    throw new AppError(404, 'That vehicle is no longer on record.')
  }

  const vendor = await VendorModel.findById(vehicle.vendorId)
  if (!vendor) {
    throw new AppError(404, 'The vendor running this vehicle is no longer on record.')
  }
  if (!vendorAcceptsAssignments(vendor.status as VendorStatus)) {
    throw new AppError(
      409,
      `${vendor.name} is ${vendor.status}. A driver added under it now could not drive this trip.`,
    )
  }

  return addDriverToVendor(
    vendor,
    {
      name: input.name,
      mobile: input.mobile,
      nidNumber: input.nidNumber,
      address: input.address,
      licenseNumber: input.licenseNumber,
      licenseExpiry: input.licenseExpiry,
      status: 'Active',
    },
    actor,
  )
}

export async function setTripDriverPhoto(
  driverId: string,
  buffer: Buffer,
  actor: UserDocument,
): Promise<DriverDetail> {
  const driver = await DriverModel.findById(driverId)
  if (!driver) {
    throw new AppError(404, 'Driver not found.')
  }
  assertCanPhotographDriver(driver, actor)
  return applyDriverPhoto(driver, buffer, actor)
}
