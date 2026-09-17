import { Types } from 'mongoose'
import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { completionMethodFor, plateSearchKey } from './delivery.constants'
import type { CompletionMethod, TripStatus } from './delivery.constants'
import { DeliveryModel } from './delivery.model'
import type { Delivery } from './delivery.model'
import type { VendorTripsQuery } from './delivery.validation'

/**
 * One vendor's trips, in a shape a Vendor account may be shown.
 *
 * Trips belong to the Delivery module, and `Vendor` is outside that module for
 * a reason that still holds: a trip carries every challan on it, and every
 * challan carries a customer's name, address and phone number. So this is not
 * the trip record with some fields hidden — it is a **different, smaller
 * record** built from a projection that never reads the challans' delivery
 * details off the collection at all. What cannot be selected cannot leak.
 *
 * What a vendor does get is what describes *their* work: which trip, which day,
 * which of their lorries and drivers, how many challans and pieces, how far the
 * paperwork has come back, and what the trip was billed.
 *
 * The caller proves scope before this runs — see `getVendorTrips` in the Vendor
 * controller, which is where `vendorScopeOf` lives. This file takes a vendor id
 * it is told is allowed, and only ever filters by it.
 */

export interface VendorTripRecord {
  id: string
  tripNumber: string
  /** A calendar day, `YYYY-MM-DD`. */
  tripDate: string
  status: TripStatus
  registrationNo: string
  driverName: string
  challanCount: number
  /** Challans on the trip whose delivery is complete. */
  completedChallans: number
  totalQty: number
  returnedQty: number
  deliveredQty: number
  tripRent: number | null
  labourBill: number | null
}

export interface VendorTripList {
  records: VendorTripRecord[]
  total: number
  totalQty: number
  totalRent: number
  totalLabour: number
  /** Matching trips with no rent entered yet. */
  blankRent: number
  /** Matching trips with no labour bill entered yet. */
  blankLabour: number
}

/** 1 when the field is null or absent, for counting blanks in a `$group`. */
function countBlank(field: string) {
  return { $sum: { $cond: [{ $eq: [{ $ifNull: [field, null] }, null] }, 1, 0] } }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Everything the list reads, and nothing else. Customer, address, receiver,
 * lines and the signed copy are deliberately absent — only the completion stamp
 * and the returned quantities are read off each challan, to count progress.
 */
const PROJECTION =
  'tripNumber tripDate status vehicle.registrationNo driver.name challanCount totalQty ' +
  'tripRent labourBill challans.completedAt challans.returned.qty'

/** The filter the list, its totals and its matching trip refs all share. */
function vendorTripFilter(vendorId: string, query: VendorTripsQuery): QueryFilter<Delivery> {
  /**
   * An ObjectId rather than the string, because the same filter feeds the
   * totals aggregation and a `$match` does no schema casting.
   */
  const clauses: QueryFilter<Delivery>[] = [{ vendorId: new Types.ObjectId(vendorId) }]

  if (query.status !== 'all') {
    clauses.push({ status: query.status })
  }
  if (query.from || query.to) {
    const range: { $gte?: Date; $lte?: Date } = {}
    if (query.from) range.$gte = new Date(`${query.from}T00:00:00.000Z`)
    if (query.to) range.$lte = new Date(`${query.to}T00:00:00.000Z`)
    clauses.push({ tripDate: range })
  }
  // An equality with null matches a blank and a trip older than the field — never a zero.
  if (query.bill === 'no-rent') {
    clauses.push({ tripRent: null })
  }
  if (query.bill === 'no-labour') {
    clauses.push({ labourBill: null })
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    const or: QueryFilter<Delivery>[] = [
      { tripNumber: pattern },
      { 'vehicle.registrationNo': pattern },
      { 'driver.name': pattern },
    ]
    const plateKey = plateSearchKey(query.search)
    if (plateKey.length >= 2) {
      or.push({ 'vehicle.registrationNoKey': new RegExp(escapeRegex(plateKey)) })
    }
    clauses.push({ $or: or })
  }

  return { $and: clauses }
}

export async function listVendorTrips(
  vendorId: string,
  query: VendorTripsQuery,
): Promise<VendorTripList> {
  const filter = vendorTripFilter(vendorId, query)
  const skip = (query.page - 1) * query.limit

  const [trips, totals] = await Promise.all([
    DeliveryModel.find(filter)
      .select(PROJECTION)
      .sort({ tripDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .lean(),
    DeliveryModel.aggregate<{
      total: number
      totalQty: number
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
          totalRent: { $sum: '$tripRent' },
          totalLabour: { $sum: '$labourBill' },
          blankRent: countBlank('$tripRent'),
          blankLabour: countBlank('$labourBill'),
        },
      },
    ]),
  ])

  return {
    records: trips.map((trip) => {
      const challans = trip.challans ?? []
      const returnedQty = challans.reduce(
        (sum, challan) =>
          sum + (challan.returned ?? []).reduce((inner, line) => inner + line.qty, 0),
        0,
      )

      return {
        id: String(trip._id),
        tripNumber: trip.tripNumber,
        tripDate: trip.tripDate.toISOString().slice(0, 10),
        status: trip.status as TripStatus,
        registrationNo: trip.vehicle.registrationNo,
        driverName: trip.driver.name,
        challanCount: trip.challanCount ?? challans.length,
        completedChallans: challans.filter((challan) => Boolean(challan.completedAt)).length,
        totalQty: trip.totalQty ?? 0,
        returnedQty,
        deliveredQty: (trip.totalQty ?? 0) - returnedQty,
        tripRent: trip.tripRent ?? null,
        labourBill: trip.labourBill ?? null,
      }
    }),
    total: totals[0]?.total ?? 0,
    totalQty: totals[0]?.totalQty ?? 0,
    totalRent: totals[0]?.totalRent ?? 0,
    totalLabour: totals[0]?.totalLabour ?? 0,
    blankRent: totals[0]?.blankRent ?? 0,
    blankLabour: totals[0]?.blankLabour ?? 0,
  }
}

// ---------------------------------------------------------------------------
// One trip
// ---------------------------------------------------------------------------

export interface VendorTripLine {
  productName: string
  model: string
  qty: number
  returnedQty: number
}

/**
 * One challan on the trip, as a vendor may see it: which challan, which
 * district and thana, what went and what came back. Never the customer, the
 * delivery address or the receiver's number.
 */
export interface VendorTripChallan {
  challanNumber: string
  slNumber: number
  district: string
  thana: string
  locationType: string | null
  qty: number
  returnedQty: number
  completionMethod: CompletionMethod | null
  lines: VendorTripLine[]
}

export interface VendorTripDetail {
  id: string
  tripNumber: string
  tripDate: Date
  status: TripStatus
  registrationNo: string
  driverName: string
  driverMobile: string
  challanCount: number
  completedChallans: number
  totalQty: number
  returnedQty: number
  deliveredQty: number
  tripRent: number | null
  labourBill: number | null
  challans: VendorTripChallan[]
}

/**
 * The same rule as the list: a projection that names every field it reads, so
 * a customer's details are never loaded off the collection at all.
 */
const DETAIL_PROJECTION =
  'tripNumber tripDate status vehicle.registrationNo driver.name driver.mobile challanCount totalQty ' +
  'tripRent labourBill challans.challanNumber challans.slNumber challans.district challans.thana ' +
  'challans.location challans.lines.productName challans.lines.productModel challans.lines.productModelKey ' +
  'challans.lines.qty challans.returned.productName challans.returned.productModelKey challans.returned.qty ' +
  'challans.receivedCopy.uploadedAt challans.copyMissing'

/** One trip of this vendor's, or 404 — including for a trip that belongs to another vendor. */
export async function getVendorTripDetail(vendorId: string, tripId: string): Promise<VendorTripDetail> {
  const trip = await DeliveryModel.findOne({ _id: tripId, vendorId }).select(DETAIL_PROJECTION).lean()
  if (!trip) {
    throw new AppError(404, 'Trip not found.')
  }

  const challans = (trip.challans ?? []).map((challan): VendorTripChallan => {
    const returned = challan.returned ?? []
    const lineKey = (name: string, modelKey: string) => `${name.trim().toLowerCase()}|${modelKey}`
    const returnedBy = new Map<string, number>()
    for (const line of returned) {
      const key = lineKey(line.productName, line.productModelKey)
      returnedBy.set(key, (returnedBy.get(key) ?? 0) + line.qty)
    }

    const lines = (challan.lines ?? []).map((line) => ({
      productName: line.productName,
      model: line.productModel,
      qty: line.qty,
      returnedQty: returnedBy.get(lineKey(line.productName, line.productModelKey)) ?? 0,
    }))
    const qty = lines.reduce((sum, line) => sum + line.qty, 0)
    const returnedQty = returned.reduce((sum, line) => sum + line.qty, 0)

    return {
      challanNumber: challan.challanNumber,
      slNumber: challan.slNumber,
      // The trip's own copy first, the resolved location under it — the manifest's rule.
      district: challan.district || challan.location?.district || '',
      thana: challan.thana || challan.location?.thana || '',
      locationType: challan.location?.locationType ?? null,
      qty,
      returnedQty,
      completionMethod: completionMethodFor({
        hasCopy: Boolean(challan.receivedCopy),
        copyMissing: Boolean(challan.copyMissing),
        carried: qty,
        returned: returnedQty,
      }),
      lines,
    }
  })

  const returnedQty = challans.reduce((sum, challan) => sum + challan.returnedQty, 0)
  const totalQty = trip.totalQty ?? 0

  return {
    id: String(trip._id),
    tripNumber: trip.tripNumber,
    tripDate: trip.tripDate,
    status: trip.status as TripStatus,
    registrationNo: trip.vehicle.registrationNo,
    driverName: trip.driver.name,
    driverMobile: trip.driver.mobile ?? '',
    challanCount: trip.challanCount ?? challans.length,
    completedChallans: challans.filter((challan) => challan.completionMethod !== null).length,
    totalQty,
    returnedQty,
    deliveredQty: totalQty - returnedQty,
    tripRent: trip.tripRent ?? null,
    labourBill: trip.labourBill ?? null,
    challans,
  }
}
