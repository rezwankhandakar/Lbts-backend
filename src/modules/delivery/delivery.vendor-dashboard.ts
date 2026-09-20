import { Types } from 'mongoose'
import { DeliveryModel } from './delivery.model'

/**
 * A vendor's own dashboard, on the trip side.
 *
 * `delivery.vendor-trips.ts` answers "show me the trips"; this answers "how is
 * the month going" — which is the question a vendor account lands on rather
 * than one it navigates to. Same module, same collection, and the same rule
 * about what may be read: the pipelines below name every field they touch, and
 * a customer, a delivery address and a receiver's number are not among them.
 * Nothing here loads a challan's delivery details at all, so there is nothing
 * to leak.
 *
 * The caller proves scope before this runs — `getVendorDashboard` in the Vendor
 * controller takes the vendor id off the signed-in profile and never off a
 * request. This file takes a vendor id it is told is allowed.
 *
 * **Everything here is counted. Nothing is estimated, projected or smoothed.**
 * A month with no trips is a zero rather than a gap, and a bill nobody has
 * entered counts as nothing rather than as a guess — the same posture the Trips
 * tab takes when it prints "Not entered" instead of ৳0.
 */

/** A calendar month, the shape the series is bucketed into. */
export interface TripMonth {
  year: number
  /** 1–12. */
  month: number
}

export interface VendorMonthPoint extends TripMonth {
  trips: number
  qty: number
  /** Rent plus labour over the month's trips, a blank counting as nothing. */
  bill: number
}

/**
 * The `count` calendar months ending with the one `today` falls in, oldest
 * first.
 *
 * Accounts has this arithmetic as `periodIndex` / `periodFromIndex`, and it is
 * deliberately not imported: Delivery does not depend on Accounts, and this
 * file would be the first thing to make it. The coupling is not worth six lines
 * — and unlike `registrationKey`, which has to agree with Gate Pass byte for
 * byte or a join stops working, nothing joins on these. They are buckets for
 * one chart.
 *
 * The index runs in months since year zero, so a window crossing a year
 * boundary needs no special case.
 */
export function dashboardMonths(today: string, count: number): TripMonth[] {
  const last = Number(today.slice(0, 4)) * 12 + (Number(today.slice(5, 7)) - 1)
  const months: TripMonth[] = []

  for (let index = last - (count - 1); index <= last; index += 1) {
    months.push({ year: Math.floor(index / 12), month: (index % 12) + 1 })
  }

  return months
}

/** The UTC instant a month starts — every day in this system is a UTC calendar day. */
function startOf(period: TripMonth): Date {
  return new Date(Date.UTC(period.year, period.month - 1, 1))
}

/** What one month's trips came to, as the aggregation reports it. */
export interface MonthRow extends TripMonth {
  trips: number
  qty: number
  bill: number
  returnedQty: number
  openTrips: number
}

/**
 * The series with every month present, whether or not anything ran in it.
 *
 * A month the aggregation returned nothing for is a **zero row, never a gap**.
 * Dropping it would slide every column in the chart one place along and
 * silently re-label the rest — a vendor reading a quiet July as a busy August
 * is exactly the kind of wrong nothing on the page would ever say out loud.
 */
export function fillMonthSeries(
  months: readonly TripMonth[],
  rows: readonly MonthRow[],
): VendorMonthPoint[] {
  const found = new Map(rows.map((row) => [`${row.year}-${row.month}`, row]))

  return months.map((period) => {
    const row = found.get(`${period.year}-${period.month}`)
    return {
      ...period,
      trips: row?.trips ?? 0,
      qty: row?.qty ?? 0,
      bill: row?.bill ?? 0,
    }
  })
}

/**
 * Pieces delivered out of pieces carried, 0–100, rounded.
 *
 * Zero out of zero is 0 rather than 100: a vendor who has run nothing this
 * month has not delivered everything, and a full bar over an empty month would
 * be the one figure on the page congratulating somebody for nothing.
 */
export function deliveryRate(delivered: number, carried: number): number {
  return carried <= 0 ? 0 : Math.round((delivered / carried) * 100)
}

// --- The queries -----------------------------------------------------------

/**
 * Every piece that came back off a trip, summed out of the challans' own return
 * lines — the same figure `listVendorTrips` reduces in memory, written as an
 * expression because this one is summed across a month rather than per row.
 */
const RETURNED_QTY = {
  $sum: {
    $map: {
      input: { $ifNull: ['$challans', []] },
      as: 'challan',
      in: { $sum: { $ifNull: ['$$challan.returned.qty', []] } },
    },
  },
}

/** Challans on the trip whose delivery is complete — a stamp, not a status. */
const COMPLETED_CHALLANS = {
  $size: {
    $filter: {
      input: { $ifNull: ['$challans', []] },
      as: 'challan',
      cond: { $ne: [{ $ifNull: ['$$challan.completedAt', null] }, null] },
    },
  },
}

export interface VendorTripFigures {
  /** The viewer's own calendar day, echoed back so the client can label it. */
  today: string
  todayTrips: number
  todayQty: number
  month: {
    trips: number
    qty: number
    delivered: number
    returned: number
    openTrips: number
    completedTrips: number
    /** Pieces delivered out of pieces carried, 0–100. */
    deliveryRate: number
  }
  /**
   * Trips still waiting for a signed copy, **whatever month they ran in** — a
   * copy outstanding since July is precisely the one worth chasing, and a
   * backlog that reset on the first of the month would hide it.
   */
  backlog: {
    trips: number
    /** Challans on those trips with no copy in yet. */
    awaitingCopies: number
    /** The day the oldest of them ran, or null when there are none. */
    oldest: string | null
  }
  lifetime: {
    trips: number
    /** The day this vendor's first trip ran, or null before there is one. */
    since: string | null
  }
  months: VendorMonthPoint[]
}

/** A `YYYY-MM-DD` day out of a stored date, or null. */
function toDay(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

/**
 * The trip half of one vendor's dashboard, in three reads.
 *
 * The series is deliberately the source of the month's own figures rather than
 * a fourth query beside it: the headline and the last column of the chart are
 * then the same arithmetic over the same rows, and cannot come to disagree
 * about what September was.
 */
export async function getVendorTripFigures(
  vendorId: string,
  today: string,
  monthCount: number,
): Promise<VendorTripFigures> {
  // An ObjectId rather than the string: an aggregation `$match` does no schema
  // casting, and a string here reports a vendor who has never run a trip.
  const vendor = new Types.ObjectId(vendorId)
  const day = new Date(`${today}T00:00:00.000Z`)
  const months = dashboardMonths(today, monthCount)
  const current = months[months.length - 1]

  const [rows, backlog, lifetime] = await Promise.all([
    DeliveryModel.aggregate<MonthRow & { todayTrips: number; todayQty: number }>([
      { $match: { vendorId: vendor, tripDate: { $gte: startOf(months[0]) } } },
      {
        $project: {
          year: { $year: '$tripDate' },
          month: { $month: '$tripDate' },
          isToday: { $eq: ['$tripDate', day] },
          status: 1,
          qty: { $ifNull: ['$totalQty', 0] },
          bill: { $add: [{ $ifNull: ['$tripRent', 0] }, { $ifNull: ['$labourBill', 0] }] },
          returnedQty: RETURNED_QTY,
        },
      },
      {
        $group: {
          _id: { year: '$year', month: '$month' },
          year: { $first: '$year' },
          month: { $first: '$month' },
          trips: { $sum: 1 },
          qty: { $sum: '$qty' },
          bill: { $sum: '$bill' },
          returnedQty: { $sum: '$returnedQty' },
          openTrips: { $sum: { $cond: [{ $eq: ['$status', 'Open'] }, 1, 0] } },
          todayTrips: { $sum: { $cond: ['$isToday', 1, 0] } },
          todayQty: { $sum: { $cond: ['$isToday', '$qty', 0] } },
        },
      },
    ]),
    DeliveryModel.aggregate<{ trips: number; awaitingCopies: number; oldest: Date | null }>([
      { $match: { vendorId: vendor, status: 'Open' } },
      {
        $project: {
          tripDate: 1,
          // Clamped, because a stored count disagreeing with a stamped challan
          // should cost a zero rather than a negative backlog.
          outstanding: {
            $max: [0, { $subtract: [{ $ifNull: ['$challanCount', 0] }, COMPLETED_CHALLANS] }],
          },
        },
      },
      {
        $group: {
          _id: null,
          trips: { $sum: 1 },
          awaitingCopies: { $sum: '$outstanding' },
          oldest: { $min: '$tripDate' },
        },
      },
    ]),
    DeliveryModel.aggregate<{ trips: number; since: Date | null }>([
      { $match: { vendorId: vendor } },
      { $group: { _id: null, trips: { $sum: 1 }, since: { $min: '$tripDate' } } },
    ]),
  ])

  const thisMonth = rows.find((row) => row.year === current.year && row.month === current.month)
  const qty = thisMonth?.qty ?? 0
  const returned = thisMonth?.returnedQty ?? 0
  const delivered = qty - returned
  const trips = thisMonth?.trips ?? 0
  const openTrips = thisMonth?.openTrips ?? 0

  return {
    today,
    todayTrips: thisMonth?.todayTrips ?? 0,
    todayQty: thisMonth?.todayQty ?? 0,
    month: {
      trips,
      qty,
      delivered,
      returned,
      openTrips,
      completedTrips: trips - openTrips,
      deliveryRate: deliveryRate(delivered, qty),
    },
    backlog: {
      trips: backlog[0]?.trips ?? 0,
      awaitingCopies: backlog[0]?.awaitingCopies ?? 0,
      oldest: toDay(backlog[0]?.oldest),
    },
    lifetime: {
      trips: lifetime[0]?.trips ?? 0,
      since: toDay(lifetime[0]?.since),
    },
    months: fillMonthSeries(months, rows),
  }
}
