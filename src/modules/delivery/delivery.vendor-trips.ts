import { Types } from 'mongoose'
import type { QueryFilter } from 'mongoose'
import { plateSearchKey } from './delivery.constants'
import type { TripStatus } from './delivery.constants'
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

export async function listVendorTrips(
  vendorId: string,
  query: VendorTripsQuery,
): Promise<VendorTripList> {
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

  const filter: QueryFilter<Delivery> = { $and: clauses }
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
