import { Types } from 'mongoose'
import { DeliveryModel } from '../delivery/delivery.model'
import {
  monthsBetween,
  periodLabel,
  periodRange,
  tripBillOf,
  vendorBillStatusFor,
  vendorDueOf,
} from './accounts.constants'
import type { Period, VendorBillStatus } from './accounts.constants'
import { EntryModel } from './accounts.model'
import { toDay } from './accounts.serializer'

/**
 * A vendor's money as its own Trips tab shows it — which a Vendor account reads.
 *
 * Two different questions, kept apart on purpose. A **trip** carries a bill and
 * the advances paid against it, because both name the trip. **Paid** and
 * **due** belong to the month: a `VendorPayment` names a month and never a
 * trip, so they are answered for the month and nowhere else — the same
 * figures, by the same rule, as the Vendor Bills page in Accounts.
 */

/** One advance, as a vendor may see it — no wallet, reference or note. */
export interface TripMoneyEntry {
  entryNumber: string
  date: string
  amount: number
}

export interface VendorMonthlyBill {
  /** "September 2026", "August – September 2026", or "All months". */
  label: string
  tripCount: number
  /** Trips in the months whose rent or labour bill is not entered yet. */
  blankBills: number
  totalBill: number
  advance: number
  paid: number
  /** May be negative: advances and payments beyond the bills entered. */
  due: number
  status: VendorBillStatus
}

function periodOfDay(day: string): Period {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) }
}

/** Trip advances per trip, for a page of trips. */
export async function tripAdvancesFor(tripIds: readonly string[]): Promise<Map<string, number>> {
  if (tripIds.length === 0) {
    return new Map()
  }
  // Aggregation `$match` does no casting, so every id goes in as an ObjectId.
  const rows = await EntryModel.aggregate<{ _id: Types.ObjectId; advance: number }>([
    { $match: { kind: 'TripAdvance', tripId: { $in: tripIds.map((id) => new Types.ObjectId(id)) } } },
    { $group: { _id: '$tripId', advance: { $sum: '$amount' } } },
  ])
  return new Map(rows.map((row) => [String(row._id), row.advance]))
}

/** The advances paid against one trip. */
export async function tripAdvanceEntries(tripId: string): Promise<TripMoneyEntry[]> {
  const entries = await EntryModel.find({ kind: 'TripAdvance', tripId })
    .select('entryNumber date amount')
    .sort({ date: 1, createdAt: 1 })
    .lean()
  return entries.map((entry) => ({ entryNumber: entry.entryNumber, date: toDay(entry.date), amount: entry.amount }))
}

/**
 * The vendor's bill for the whole months a date range touches — or for every
 * month when there is no range. Whole months, because paid and due only mean
 * something for a whole month: a payment for September covers all of
 * September's trips, not the ones between two days somebody typed.
 *
 * Trips by trip date, advances against those trips whenever they were paid,
 * payments by the month they name — exactly `vendorMonthFigures`, over a span.
 */
export async function vendorMonthlyBill(vendorId: string, from?: string, to?: string): Promise<VendorMonthlyBill> {
  const vendorObjectId = new Types.ObjectId(vendorId)
  const tripMatch: Record<string, unknown> = { vendorId: vendorObjectId }
  const paymentMatch: Record<string, unknown> = { kind: 'VendorPayment', vendorId: vendorObjectId }
  let label = 'All months'

  if (from || to) {
    // An open end reaches as far as the other: "from September" alone is September onwards to now.
    const today = new Date().toISOString().slice(0, 10)
    const first = periodOfDay(from ?? to ?? today)
    const last = periodOfDay(to ?? today)
    const months = monthsBetween(first, last)

    tripMatch.tripDate = { $gte: periodRange(first).start, $lt: periodRange(last).end }
    paymentMatch.$or = months.map((period) => ({ 'period.year': period.year, 'period.month': period.month }))
    label =
      months.length <= 1
        ? periodLabel(first)
        : first.year === last.year
          ? `${periodLabel(first).split(' ')[0]} – ${periodLabel(last)}`
          : `${periodLabel(first)} – ${periodLabel(last)}`
  }

  const [trips, payments] = await Promise.all([
    DeliveryModel.find(tripMatch).select('_id tripRent labourBill').lean(),
    EntryModel.aggregate<{ paid: number }>([
      { $match: paymentMatch },
      { $group: { _id: null, paid: { $sum: '$amount' } } },
    ]),
  ])

  const advances = await tripAdvancesFor(trips.map((trip) => String(trip._id)))

  const figures = {
    totalBill: trips.reduce((sum, trip) => sum + tripBillOf(trip.tripRent, trip.labourBill), 0),
    advance: [...advances.values()].reduce((sum, value) => sum + value, 0),
    paid: payments[0]?.paid ?? 0,
  }

  return {
    label,
    tripCount: trips.length,
    blankBills: trips.filter((trip) => trip.tripRent == null || trip.labourBill == null).length,
    ...figures,
    due: vendorDueOf(figures),
    status: vendorBillStatusFor(figures),
  }
}
