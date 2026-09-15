import * as z from 'zod'
import { normalizeMobile } from '../challan/challan.constants'
import { createDriverSchema } from '../vendor/vendor.validation'
import {
  CARRYING_KINDS,
  MAX_CARRYING_AMOUNT,
  MAX_CARRYING_ENTRIES,
  MAX_COPY_MISSING_REASON,
  MAX_FLOOR,
  MAX_TRIP_CHALLANS,
  MAX_TRIP_CHARGE,
  TRIP_BILL_FILTERS,
  MAX_TRIP_LINES,
  MAX_TRIP_PAGE_SIZE,
  TRIP_STATUSES,
} from './delivery.constants'

/** Mongo ObjectId as it arrives in a URL or a body. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const idParamSchema = z.object({ id: objectId })

/**
 * A trip and one challan on it — what every completion endpoint is addressed
 * by.
 *
 * Two ids rather than one, because a challan split across two lorries is
 * completed twice: once for the two that went on Tuesday and once for the two
 * that went on Thursday. Naming only the challan would leave the server
 * guessing which delivery the signed copy belongs to, and guessing wrong would
 * file a receipt against the wrong lorry.
 */
export const tripChallanParamSchema = z.object({ id: objectId, challanId: objectId })
export type TripChallanParams = z.infer<typeof tripChallanParamSchema>

/**
 * A calendar day, parsed to UTC midnight rather than through `new Date(value)`
 * — the same treatment every day in this codebase gets, so a trip "on the
 * 11th" is the 11th for every viewer.
 */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), 'That is not a real date.')

function text(min: number, max: number, label: string) {
  return z
    .string()
    .trim()
    .min(min, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`)
}

/**
 * A receiver's number, normalised the way Challan normalises it — and loose in
 * the same way, because a depot landline is a legitimate thing to ring.
 */
const receiverMobile = z
  .string()
  .trim()
  .transform(normalizeMobile)
  .refine(
    (value) => /^01\d{9}$/.test(value) || /^[\d+\-() ]{6,20}$/.test(value),
    'Enter a valid receiver mobile, for example 01712345678.',
  )

// --- Lookups ---------------------------------------------------------------

export const vehicleSearchQuerySchema = z.object({
  q: z.string().trim().max(60).default(''),
})
export type VehicleSearchQuery = z.infer<typeof vehicleSearchQuerySchema>

/**
 * Challans for the cart: a free search, or a list of ids.
 *
 * `ids` is how an edit reloads the challans already on a trip with their live
 * allocation; `excludeTripId` is that trip, so its own quantities are not
 * counted as "already gone out on another trip".
 */
export const challanCandidatesQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  ids: z
    .string()
    .trim()
    .default('')
    .transform((value) => (value ? value.split(',').map((id) => id.trim()) : []))
    .pipe(z.array(objectId).max(MAX_TRIP_CHALLANS)),
  excludeTripId: objectId.optional(),
})
export type ChallanCandidatesQuery = z.infer<typeof challanCandidatesQuerySchema>

/**
 * One barcode read, exactly as the scanner typed it.
 *
 * A handheld scanner is a keyboard: it types the challan number off the back
 * page and presses Enter. What reaches here is that text — possibly with a
 * stray space, possibly in lower case on a machine with Caps Lock quirks — so
 * the service normalises it rather than this schema refusing it.
 */
export const challanScanQuerySchema = z.object({
  code: z.string().trim().min(1, 'Nothing was scanned.').max(80),
  excludeTripId: objectId.optional(),
})
export type ChallanScanQuery = z.infer<typeof challanScanQuerySchema>

// --- A trip ---------------------------------------------------------------

/**
 * One product line, as the cart sends it.
 *
 * `sourceIndex` says which challan line it draws on, or null for a line the
 * paper never listed. What that source line *said* is deliberately not a
 * field: the server reads it off the challan, so a crafted request cannot claim
 * a line ordered forty when the paper says four.
 */
const tripLineSchema = z.object({
  sourceIndex: z.number().int().min(0).nullable(),
  productName: text(1, 200, 'Product name'),
  model: text(1, 120, 'Model'),
  qty: z.coerce
    .number({ error: 'Quantity must be a number' })
    .int('Quantity must be a whole number')
    .min(1, 'Quantity must be at least 1')
    .max(100000, 'Quantity is too large'),
})
export type TripLineInput = z.infer<typeof tripLineSchema>

/**
 * One challan on the trip, with the operator's view of its delivery details.
 *
 * The challan number, SL number and resolved location are absent — they are
 * the challan's, and the server copies them. What *is* here is what the
 * operator may legitimately change for this run: who receives it, where, and
 * what is actually on the lorry.
 */
/**
 * Part of a challan line held back for a later trip.
 *
 * It names the **line**, never a product: the server reads what that line says
 * off the challan, so a request cannot reserve a product the paper does not
 * carry — which would be a way to add a line to somebody's challan by
 * pretending to hold it back.
 */
const reservedSchema = z.object({
  sourceIndex: z.number().int().min(0),
  qty: z.coerce
    .number({ error: 'Reserved quantity must be a number' })
    .int('Reserved quantity must be a whole number')
    .min(1, 'Reserve at least 1, or reserve nothing at all')
    .max(100000),
})
export type ReservedInput = z.infer<typeof reservedSchema>

const tripChallanSchema = z.object({
  challanId: objectId,
  customerName: text(1, 200, 'Customer name'),
  deliveryAddress: text(1, 500, 'Delivery address'),
  thana: z.string().trim().max(120).default(''),
  district: z.string().trim().max(120).default(''),
  receiverMobile,
  note: z.string().trim().max(400).default(''),
  lines: z
    .array(tripLineSchema)
    .min(1, 'Each challan needs at least one product line.')
    .max(MAX_TRIP_LINES, `A challan may carry at most ${MAX_TRIP_LINES} lines on a trip.`),
  /**
   * What this trip leaves for a later one. Everything *not* reserved and not
   * carried is a correction to the challan — see `rebuildChallanItems`.
   */
  reserved: z
    .array(reservedSchema)
    .max(MAX_TRIP_LINES)
    .default([])
    .refine(
      (entries) => new Set(entries.map((entry) => entry.sourceIndex)).size === entries.length,
      'The same product line is reserved twice.',
    ),
})
export type TripChallanInput = z.infer<typeof tripChallanSchema>

const tripFields = {
  vehicleId: objectId,
  /** The driver for this run — not necessarily the vehicle's assigned one. */
  driverId: objectId,
  tripDate: calendarDay,
  note: z.string().trim().max(600).default(''),
  challans: z
    .array(tripChallanSchema)
    .min(1, 'Add at least one challan to the trip.')
    .max(MAX_TRIP_CHALLANS, `A trip may carry at most ${MAX_TRIP_CHALLANS} challans.`)
    /**
     * One challan appears once per trip. Two cards for the same challan would
     * be the same paperwork counted twice; splitting belongs *across* trips,
     * and a second product line on the one card covers everything else.
     */
    .refine(
      (challans) => new Set(challans.map((challan) => challan.challanId)).size === challans.length,
      'The same challan is on this trip twice.',
    ),
  /**
   * The answer to the over-allocation question. A trip taking a challan line
   * past what the paper ordered is answered `409` with the lines concerned,
   * and this is how the operator says they meant it.
   */
  acknowledgeOverage: z.boolean().default(false),
}

/**
 * Confirming a trip.
 *
 * Absent on purpose: `tripNumber`, `vendorTripSerial`, `vendorId`, `status`
 * and every copied snapshot. The number is allocated by the server once every
 * check passes; the vendor is read off the vehicle, never from a body — the
 * same rule the Vendor module keeps — and the snapshots are what the database
 * said, not what a client claims it said.
 */
export const createTripSchema = z.object({
  ...tripFields,
  submissionKey: z
    .string()
    .trim()
    .min(8, 'Missing submission key.')
    .max(80),
})
export type CreateTripInput = z.infer<typeof createTripSchema>

export const updateTripSchema = z.object(tripFields)
export type UpdateTripInput = z.infer<typeof updateTripSchema>

// --- Completing a delivery -------------------------------------------------

/**
 * One product line that came back off the lorry.
 *
 * It names the **line**, never a product, for the same reason a reservation
 * does: the server reads what that line carried off the trip, so a request
 * cannot return a product the lorry never had — which would be a way to put
 * quantity back onto somebody's challan by pretending it had come back.
 */
const returnedSchema = z.object({
  lineIndex: z.number().int().min(0),
  qty: z.coerce
    .number({ error: 'Returned quantity must be a number' })
    .int('Returned quantity must be a whole number')
    .min(1, 'Return at least 1, or leave the line off altogether')
    .max(100000),
  reason: z.string().trim().max(300).default(''),
})
export type ReturnedInput = z.infer<typeof returnedSchema>

const carryingSchema = z.object({
  kind: z.enum(CARRYING_KINDS),
  description: z.string().trim().max(200).default(''),
  /**
   * Whole taka, and zero is allowed: the vendor's own helper carrying two
   * boxes up one floor is worth recording and is not worth a taka.
   */
  amount: z.coerce
    .number({ error: 'Amount must be a number' })
    .int('Amount must be a whole number of taka')
    .min(0, 'An amount cannot be negative')
    .max(MAX_CARRYING_AMOUNT, 'That amount is too large')
    .default(0),
})
export type CarryingInput = z.infer<typeof carryingSchema>

/**
 * What the operator records when a delivery comes back.
 *
 * A **whole-list replace**, exactly as the Challan module's skipped pages are,
 * and for the same reason: it is idempotent, and undoing a return is the same
 * call with that line left out. Sending `returned: []` puts a challan back to
 * having gone out in full.
 *
 * Absent on purpose: any completion flag. A delivery is completed by the
 * signed copy arriving at its own endpoint, never by a field in this body —
 * the evidence is the record, and a flag beside it would be a way to say a
 * delivery finished without one.
 */
export const completionSchema = z.object({
  returned: z
    .array(returnedSchema)
    .max(MAX_TRIP_LINES)
    .default([])
    .refine(
      (entries) => new Set(entries.map((entry) => entry.lineIndex)).size === entries.length,
      'The same product line is returned twice.',
    ),
  /**
   * `null` is "nobody said" and `0` is the ground floor, which is why this is
   * nullable rather than defaulted — a delivery to a shop front has no floor,
   * and saying so is not the same as leaving it blank.
   */
  floorNo: z.coerce
    .number({ error: 'Floor must be a number' })
    .int('Floor must be a whole number')
    .min(0, 'A floor cannot be negative')
    .max(MAX_FLOOR, 'That floor number is too large')
    .nullable()
    .default(null),
  carrying: z
    .array(carryingSchema)
    .max(MAX_CARRYING_ENTRIES, `Record at most ${MAX_CARRYING_ENTRIES} carrying charges.`)
    .default([]),
  deliveryNote: z.string().trim().max(600).default(''),
})
export type CompletionInput = z.infer<typeof completionSchema>

const tripCharge = (label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be whole taka`)
    .min(0, `${label} cannot be negative`)
    .max(MAX_TRIP_CHARGE, `${label} is too large`)
    .nullable()

/**
 * A trip's rent and labour bill. Both are sent every time — a whole replace,
 * like every other small edit in this module — and `null` clears one.
 */
export const tripBillSchema = z.object({
  tripRent: tripCharge('Trip rent'),
  labourBill: tripCharge('Labour bill'),
})
export type TripBillInput = z.infer<typeof tripBillSchema>

/**
 * Declaring the signed copy lost. The reason is optional — "the driver lost
 * it" is often all anybody knows — but it is kept, because a delivery closed
 * without its paper is the one somebody will ask about later.
 */
export const copyMissingSchema = z.object({
  reason: z.string().trim().max(MAX_COPY_MISSING_REASON).default(''),
})
export type CopyMissingInput = z.infer<typeof copyMissingSchema>

/**
 * The page count beside an uploaded signed copy.
 *
 * Multipart carries strings, so it is coerced; and it is optional because only
 * the scanner agent knows how many sheets it fed. A file chosen off a disk
 * reports nothing, and a page count nobody measured is worse than none.
 */
export const receivedCopyBodySchema = z.object({
  pageCount: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
})
export type ReceivedCopyBody = z.infer<typeof receivedCopyBodySchema>

/**
 * A barcode read on the deliveries page, asking "where is this challan?".
 *
 * The same shape as the cart's scan query and deliberately a different
 * endpoint: that one asks what is still to go so a challan can be put on a
 * lorry, and this one asks which lorry already took it so its receipt can be
 * filed. Answering both from one endpoint would mean a scan meaning different
 * things depending on which page was open.
 */
export const receiptScanQuerySchema = z.object({
  code: z.string().trim().min(1, 'Nothing was scanned.').max(80),
})
export type ReceiptScanQuery = z.infer<typeof receiptScanQuerySchema>

/** The viewer's own calendar day — see `getTripStats`. */
export const statsQuerySchema = z.object({
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default(() => new Date().toISOString().slice(0, 10)),
})
export type StatsQuery = z.infer<typeof statsQuerySchema>

export const listTripsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_TRIP_PAGE_SIZE).default(10),
    search: z.string().trim().max(120).default(''),
    status: z.enum(['all', ...TRIP_STATUSES]).default('all'),
    vendorId: objectId.optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Trips whose rent or labour bill nobody has entered yet — see `TRIP_BILL_FILTERS`. */
    bill: z.enum(TRIP_BILL_FILTERS).default('all'),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date cannot be after the end date.',
    path: ['to'],
  })
export type ListTripsQuery = z.infer<typeof listTripsQuerySchema>

/**
 * A vendor's own trips, as the vendor's Trips tab asks for them.
 *
 * Narrower than the trips list on purpose: the search reaches the trip number,
 * the plate and the driver — never a challan or a customer, because a Vendor
 * account may call this and a customer name is not theirs to search by. The
 * vendor itself is the path parameter, checked against the caller's scope.
 */
export const vendorTripsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_TRIP_PAGE_SIZE).default(10),
    search: z.string().trim().max(120).default(''),
    status: z.enum(['all', ...TRIP_STATUSES]).default('all'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** The same trip bill backlog the deliveries list filters by. */
    bill: z.enum(TRIP_BILL_FILTERS).default('all'),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date cannot be after the end date.',
    path: ['to'],
  })
export type VendorTripsQuery = z.infer<typeof vendorTripsQuerySchema>

/**
 * Adding a driver from inside a trip.
 *
 * The driver fields are the Vendor module's own schema, reused rather than
 * restated, so the two forms can never disagree about what a driver needs.
 * Two differences, both deliberate. The vendor is named by **the vehicle** —
 * the driver works for whoever runs the lorry they were added for, and a body
 * cannot say otherwise. And there is no `status`: a driver added to drive this
 * trip is `Active`, because any other state would produce a driver the trip
 * could not then select.
 */
export const quickDriverSchema = createDriverSchema.safeExtend({
  vehicleId: objectId,
  status: z.undefined().optional(),
})
export type QuickDriverInput = z.infer<typeof quickDriverSchema>
