import type { Types } from 'mongoose'
import type { PipelineStage } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { plateSearchKey } from '../delivery/delivery.constants'
import type { TripStatus } from '../delivery/delivery.constants'
import { DeliveryModel } from '../delivery/delivery.model'
import { escapeRegex } from '../vendor/vendor.lookups'
import { VendorModel } from '../vendor/vendor.model'
import {
  MAX_TRIP_OPTIONS,
  periodIndex,
  periodKey,
  periodLabel,
  periodRange,
  tripBillOf,
  vendorBillStatusFor,
  vendorDueOf,
} from './accounts.constants'
import type { Period, VendorBillFigures, VendorBillStatus } from './accounts.constants'
import { EntryModel } from './accounts.model'
import { serializeEntries, toDay } from './accounts.serializer'
import type { EntryRecord } from './accounts.serializer'
import type { VendorBillsQuery } from './accounts.validation'

/**
 * A vendor's trip bills by month: what the trips cost, what was advanced
 * against them, and what has been paid.
 *
 * Nothing here is stored. The bills live on the trips, the advances and
 * payments are entries, and every figure is added up when it is asked for —
 * so a trip bill corrected on the trip's page is what the next read says,
 * with no copy anywhere to go stale.
 *
 * A trip belongs to the month of its trip date, and so does every advance
 * paid against it, whenever the advance itself was paid. A payment names its
 * month outright.
 */

export interface VendorRef {
  id: string
  vendorCode: string
  name: string
  photoUrl: string | null
  status: string
}

export interface VendorMonthFigures extends VendorBillFigures {
  tripCount: number
  tripRent: number
  labourBill: number
  /** Trips whose rent or labour bill has not been entered yet. */
  blankBills: number
  due: number
  status: VendorBillStatus
}

export interface VendorBillRow extends VendorMonthFigures {
  vendor: VendorRef
  paymentCount: number
  lastPaymentDate: string | null
}

export interface VendorBillList {
  period: { year: number; month: number; label: string }
  rows: VendorBillRow[]
  totals: {
    vendors: number
    tripCount: number
    totalBill: number
    advance: number
    paid: number
    /** What is still owed, over vendors that are owed something. */
    due: number
    /** Paid beyond the bills entered, over vendors that are. */
    overpaid: number
    blankBills: number
  }
}

const BLANK_BILL = {
  $cond: [
    {
      $or: [
        { $eq: [{ $ifNull: ['$tripRent', null] }, null] },
        { $eq: [{ $ifNull: ['$labourBill', null] }, null] },
      ],
    },
    1,
    0,
  ],
}

interface TripGroup {
  _id: Types.ObjectId
  vendor: { vendorCode: string; name: string } | null
  tripIds: Types.ObjectId[]
  tripCount: number
  tripRent: number
  labourBill: number
  blankBills: number
}

function figuresOf(parts: {
  tripCount: number
  tripRent: number
  labourBill: number
  blankBills: number
  advance: number
  paid: number
}): VendorMonthFigures {
  const figures = { totalBill: parts.tripRent + parts.labourBill, advance: parts.advance, paid: parts.paid }
  return {
    ...parts,
    ...figures,
    due: vendorDueOf(figures),
    status: vendorBillStatusFor(figures),
  }
}

function tripGroupStages(match: Record<string, unknown>): PipelineStage[] {
  return [
    { $match: match },
    {
      $group: {
        _id: '$vendorId',
        vendor: { $first: '$vendor' },
        tripIds: { $push: '$_id' },
        tripCount: { $sum: 1 },
        tripRent: { $sum: { $ifNull: ['$tripRent', 0] } },
        labourBill: { $sum: { $ifNull: ['$labourBill', 0] } },
        blankBills: { $sum: BLANK_BILL },
      },
    },
  ]
}

function toVendorRef(
  id: string,
  found: Map<string, { vendorCode: string; name: string; photoUrl?: string | null; status: string }>,
  fallback: { vendorCode: string; name: string } | null,
): VendorRef {
  const vendor = found.get(id)
  return {
    id,
    vendorCode: vendor?.vendorCode ?? fallback?.vendorCode ?? '—',
    name: vendor?.name ?? fallback?.name ?? 'Removed vendor',
    photoUrl: vendor?.photoUrl ?? null,
    status: vendor?.status ?? 'Inactive',
  }
}

// ---------------------------------------------------------------------------
// Every vendor, one month
// ---------------------------------------------------------------------------

export async function listVendorBills(query: VendorBillsQuery): Promise<VendorBillList> {
  const period: Period = { year: query.year, month: query.month }
  const { start, end } = periodRange(period)

  const tripGroups = await DeliveryModel.aggregate<TripGroup>(tripGroupStages({ tripDate: { $gte: start, $lt: end } }))
  const tripIds = tripGroups.flatMap((group) => group.tripIds)

  const [advances, payments] = await Promise.all([
    tripIds.length > 0
      ? EntryModel.aggregate<{ _id: Types.ObjectId; advance: number }>([
          { $match: { kind: 'TripAdvance', tripId: { $in: tripIds } } },
          { $group: { _id: '$vendorId', advance: { $sum: '$amount' } } },
        ])
      : Promise.resolve([]),
    EntryModel.aggregate<{
      _id: Types.ObjectId
      paid: number
      paymentCount: number
      lastPaymentDate: Date
      vendor: { vendorCode: string; name: string } | null
    }>([
      { $match: { kind: 'VendorPayment', 'period.year': period.year, 'period.month': period.month } },
      {
        $group: {
          _id: '$vendorId',
          paid: { $sum: '$amount' },
          paymentCount: { $sum: 1 },
          lastPaymentDate: { $max: '$date' },
          vendor: { $first: '$vendor' },
        },
      },
    ]),
  ])

  const vendorIds = new Set<string>([
    ...tripGroups.map((group) => String(group._id)),
    ...payments.map((payment) => String(payment._id)),
  ])
  const vendors = await VendorModel.find({ _id: { $in: [...vendorIds] } }).select('vendorCode name photoUrl status')
  const found = new Map(vendors.map((vendor) => [String(vendor._id), vendor]))

  const tripsBy = new Map(tripGroups.map((group) => [String(group._id), group]))
  const advanceBy = new Map(advances.map((row) => [String(row._id), row.advance]))
  const paymentBy = new Map(payments.map((row) => [String(row._id), row]))

  let rows: VendorBillRow[] = [...vendorIds].map((id) => {
    const trips = tripsBy.get(id)
    const payment = paymentBy.get(id)
    return {
      vendor: toVendorRef(id, found, trips?.vendor ?? payment?.vendor ?? null),
      ...figuresOf({
        tripCount: trips?.tripCount ?? 0,
        tripRent: trips?.tripRent ?? 0,
        labourBill: trips?.labourBill ?? 0,
        blankBills: trips?.blankBills ?? 0,
        advance: advanceBy.get(id) ?? 0,
        paid: payment?.paid ?? 0,
      }),
      paymentCount: payment?.paymentCount ?? 0,
      lastPaymentDate: payment ? toDay(payment.lastPaymentDate) : null,
    }
  })

  const totals = {
    vendors: rows.length,
    tripCount: sum(rows, (row) => row.tripCount),
    totalBill: sum(rows, (row) => row.totalBill),
    advance: sum(rows, (row) => row.advance),
    paid: sum(rows, (row) => row.paid),
    due: sum(rows, (row) => Math.max(0, row.due)),
    overpaid: sum(rows, (row) => Math.max(0, -row.due)),
    blankBills: sum(rows, (row) => row.blankBills),
  }

  if (query.status === 'due') {
    rows = rows.filter((row) => row.due > 0)
  } else if (query.status !== 'all') {
    rows = rows.filter((row) => row.status === query.status)
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    rows = rows.filter((row) => pattern.test(row.vendor.name) || pattern.test(row.vendor.vendorCode))
  }

  rows.sort((a, b) => b.due - a.due || a.vendor.name.localeCompare(b.vendor.name))

  return { period: { ...period, label: periodLabel(period) }, rows, totals }
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0)
}

// ---------------------------------------------------------------------------
// One vendor
// ---------------------------------------------------------------------------

/** Where one challan on a trip went, as the manifest reads it: the trip's own copy first, the resolved location under it. */
export interface VendorBillChallan {
  challanNumber: string
  slNumber: number
  district: string
  thana: string
}

export interface VendorBillTrip {
  id: string
  tripNumber: string
  tripDate: string
  status: TripStatus
  registrationNo: string
  driverName: string
  challanCount: number
  totalQty: number
  challans: VendorBillChallan[]
  tripRent: number | null
  labourBill: number | null
  bill: number
  advance: number
  /** The bill less its advances — what this trip still asks of the monthly payment. */
  net: number
}

export interface VendorMonthHistory extends VendorMonthFigures {
  year: number
  month: number
  label: string
}

export interface VendorBillDetail {
  vendor: VendorRef & { mobile: string }
  period: { year: number; month: number; label: string }
  figures: VendorMonthFigures
  trips: VendorBillTrip[]
  advances: EntryRecord[]
  payments: EntryRecord[]
  /** Every month with a trip or a payment, newest first. */
  history: VendorMonthHistory[]
  allTime: VendorMonthFigures
}

export async function getVendorBillDetail(vendorId: string, period: Period): Promise<VendorBillDetail> {
  const vendor = await VendorModel.findById(vendorId).select('vendorCode name photoUrl status mobile')
  if (!vendor) {
    throw new AppError(404, 'Vendor not found.')
  }

  const { start, end } = periodRange(period)
  const trips = await DeliveryModel.find({ vendorId: vendor._id, tripDate: { $gte: start, $lt: end } })
    .select(
      'tripNumber tripDate status vehicle.registrationNo driver.name challanCount totalQty tripRent labourBill ' +
        'challans.challanNumber challans.slNumber challans.district challans.thana challans.location',
    )
    .sort({ tripDate: 1, vendorTripSerial: 1 })

  const [advanceEntries, paymentEntries, history] = await Promise.all([
    EntryModel.find({ kind: 'TripAdvance', tripId: { $in: trips.map((trip) => trip._id) } }).sort({ date: 1, createdAt: 1 }),
    EntryModel.find({
      kind: 'VendorPayment',
      vendorId: vendor._id,
      'period.year': period.year,
      'period.month': period.month,
    }).sort({ date: 1, createdAt: 1 }),
    vendorHistory(vendor._id),
  ])

  const advanceByTrip = new Map<string, number>()
  for (const entry of advanceEntries) {
    const key = String(entry.tripId)
    advanceByTrip.set(key, (advanceByTrip.get(key) ?? 0) + entry.amount)
  }

  const tripRows: VendorBillTrip[] = trips.map((trip) => {
    const bill = tripBillOf(trip.tripRent, trip.labourBill)
    const advance = advanceByTrip.get(String(trip._id)) ?? 0
    return {
      id: String(trip._id),
      tripNumber: trip.tripNumber,
      tripDate: toDay(trip.tripDate),
      status: trip.status as TripStatus,
      registrationNo: trip.vehicle?.registrationNo ?? '',
      driverName: trip.driver?.name ?? '',
      challanCount: trip.challanCount,
      totalQty: trip.totalQty,
      challans: (trip.challans ?? []).map((challan) => ({
        challanNumber: challan.challanNumber,
        slNumber: challan.slNumber,
        district: challan.district || challan.location?.district || '',
        thana: challan.thana || challan.location?.thana || '',
      })),
      tripRent: trip.tripRent ?? null,
      labourBill: trip.labourBill ?? null,
      bill,
      advance,
      net: bill - advance,
    }
  })

  const [advances, payments] = await Promise.all([serializeEntries(advanceEntries), serializeEntries(paymentEntries)])

  const figures = figuresOf({
    tripCount: tripRows.length,
    tripRent: sum(tripRows, (trip) => trip.tripRent ?? 0),
    labourBill: sum(tripRows, (trip) => trip.labourBill ?? 0),
    blankBills: tripRows.filter((trip) => trip.tripRent === null || trip.labourBill === null).length,
    advance: sum(tripRows, (trip) => trip.advance),
    paid: sum(payments, (payment) => payment.amount),
  })

  const allTime = figuresOf({
    tripCount: sum(history, (month) => month.tripCount),
    tripRent: sum(history, (month) => month.tripRent),
    labourBill: sum(history, (month) => month.labourBill),
    blankBills: sum(history, (month) => month.blankBills),
    advance: sum(history, (month) => month.advance),
    paid: sum(history, (month) => month.paid),
  })

  return {
    vendor: {
      id: String(vendor._id),
      vendorCode: vendor.vendorCode,
      name: vendor.name,
      photoUrl: vendor.photoUrl ?? null,
      status: vendor.status,
      mobile: vendor.mobile ?? '',
    },
    period: { ...period, label: periodLabel(period) },
    figures,
    trips: tripRows,
    advances,
    payments,
    history,
    allTime,
  }
}

/**
 * Every month one vendor has a trip or a payment in, with its figures. Three
 * grouped reads on indexed vendor fields, however many months there are.
 */
async function vendorHistory(vendorId: Types.ObjectId): Promise<VendorMonthHistory[]> {
  const byMonth = {
    year: { $year: '$tripDate' },
    month: { $month: '$tripDate' },
  }

  const [tripMonths, advanceMonths, paymentMonths] = await Promise.all([
    DeliveryModel.aggregate<{
      _id: { year: number; month: number }
      tripCount: number
      tripRent: number
      labourBill: number
      blankBills: number
    }>([
      { $match: { vendorId } },
      {
        $group: {
          _id: byMonth,
          tripCount: { $sum: 1 },
          tripRent: { $sum: { $ifNull: ['$tripRent', 0] } },
          labourBill: { $sum: { $ifNull: ['$labourBill', 0] } },
          blankBills: { $sum: BLANK_BILL },
        },
      },
    ]),
    // An advance counts in its trip's month, read off the live trip rather than the copy.
    EntryModel.aggregate<{ _id: { year: number; month: number }; advance: number }>([
      { $match: { kind: 'TripAdvance', vendorId } },
      { $lookup: { from: DeliveryModel.collection.name, localField: 'tripId', foreignField: '_id', as: 'liveTrip' } },
      { $unwind: '$liveTrip' },
      {
        $group: {
          _id: { year: { $year: '$liveTrip.tripDate' }, month: { $month: '$liveTrip.tripDate' } },
          advance: { $sum: '$amount' },
        },
      },
    ]),
    EntryModel.aggregate<{ _id: { year: number; month: number }; paid: number }>([
      { $match: { kind: 'VendorPayment', vendorId } },
      { $group: { _id: { year: '$period.year', month: '$period.month' }, paid: { $sum: '$amount' } } },
    ]),
  ])

  const months = new Map<string, Period>()
  const note = (period: Period) => months.set(periodKey(period), { year: period.year, month: period.month })
  tripMonths.forEach((row) => note(row._id))
  paymentMonths.forEach((row) => note(row._id))
  advanceMonths.forEach((row) => note(row._id))

  const tripsBy = new Map(tripMonths.map((row) => [periodKey(row._id), row]))
  const advanceBy = new Map(advanceMonths.map((row) => [periodKey(row._id), row.advance]))
  const paidBy = new Map(paymentMonths.map((row) => [periodKey(row._id), row.paid]))

  return [...months.values()]
    .sort((a, b) => periodIndex(b) - periodIndex(a))
    .map((period) => {
      const key = periodKey(period)
      const trips = tripsBy.get(key)
      return {
        ...period,
        label: periodLabel(period),
        ...figuresOf({
          tripCount: trips?.tripCount ?? 0,
          tripRent: trips?.tripRent ?? 0,
          labourBill: trips?.labourBill ?? 0,
          blankBills: trips?.blankBills ?? 0,
          advance: advanceBy.get(key) ?? 0,
          paid: paidBy.get(key) ?? 0,
        }),
      }
    })
}

/**
 * One vendor's month, for checking a payment against it. `exceptEntryId`
 * leaves out the payment being corrected, so its own amount is not counted
 * as already paid.
 */
export async function vendorMonthFigures(
  vendorId: Types.ObjectId,
  period: Period,
  exceptEntryId?: Types.ObjectId,
): Promise<VendorMonthFigures> {
  const { start, end } = periodRange(period)
  const [group] = await DeliveryModel.aggregate<TripGroup>(
    tripGroupStages({ vendorId, tripDate: { $gte: start, $lt: end } }),
  )

  const [advance, paid] = await Promise.all([
    group
      ? EntryModel.aggregate<{ total: number }>([
          { $match: { kind: 'TripAdvance', tripId: { $in: group.tripIds } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ])
      : Promise.resolve([]),
    EntryModel.aggregate<{ total: number }>([
      {
        $match: {
          kind: 'VendorPayment',
          vendorId,
          'period.year': period.year,
          'period.month': period.month,
          ...(exceptEntryId ? { _id: { $ne: exceptEntryId } } : {}),
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ])

  return figuresOf({
    tripCount: group?.tripCount ?? 0,
    tripRent: group?.tripRent ?? 0,
    labourBill: group?.labourBill ?? 0,
    blankBills: group?.blankBills ?? 0,
    advance: advance[0]?.total ?? 0,
    paid: paid[0]?.total ?? 0,
  })
}

// ---------------------------------------------------------------------------
// Choosing a trip to advance against
// ---------------------------------------------------------------------------

export interface TripOption {
  id: string
  tripNumber: string
  tripDate: string
  status: TripStatus
  vendor: { id: string; vendorCode: string; name: string }
  registrationNo: string
  driverName: string
  tripRent: number | null
  labourBill: number | null
  bill: number
  advance: number
}

/**
 * Trips an advance could be paid against: the newest ones, or those whose
 * trip number, plate or vendor matches what was typed. The plate is matched
 * the way the delivery search matches it, so the last four digits read off a
 * lorry are enough.
 */
export async function listTripOptions(q: string): Promise<TripOption[]> {
  const filter: Record<string, unknown> = {}

  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i')
    const plate = plateSearchKey(q)
    filter.$or = [
      { tripNumber: pattern },
      { 'vendor.name': pattern },
      { 'driver.name': pattern },
      ...(plate ? [{ 'vehicle.registrationNoKey': new RegExp(escapeRegex(plate)) }] : []),
    ]
  }

  const trips = await DeliveryModel.find(filter)
    .select('tripNumber tripDate status vendorId vendor vehicle.registrationNo driver.name tripRent labourBill')
    .sort({ tripDate: -1, createdAt: -1 })
    .limit(MAX_TRIP_OPTIONS)

  const advances = await EntryModel.aggregate<{ _id: Types.ObjectId; total: number }>([
    { $match: { kind: 'TripAdvance', tripId: { $in: trips.map((trip) => trip._id) } } },
    { $group: { _id: '$tripId', total: { $sum: '$amount' } } },
  ])
  const advanceBy = new Map(advances.map((row) => [String(row._id), row.total]))

  return trips.map((trip) => ({
    id: String(trip._id),
    tripNumber: trip.tripNumber,
    tripDate: toDay(trip.tripDate),
    status: trip.status as TripStatus,
    vendor: { id: String(trip.vendorId), vendorCode: trip.vendor.vendorCode, name: trip.vendor.name },
    registrationNo: trip.vehicle?.registrationNo ?? '',
    driverName: trip.driver?.name ?? '',
    tripRent: trip.tripRent ?? null,
    labourBill: trip.labourBill ?? null,
    bill: tripBillOf(trip.tripRent, trip.labourBill),
    advance: advanceBy.get(String(trip._id)) ?? 0,
  }))
}

