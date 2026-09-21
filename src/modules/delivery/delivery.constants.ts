import type { UserRole } from '../user/user.constants'
import {
  driverAcceptsAssignment,
  registrationKey,
  vehicleAcceptsDriver,
  vendorAcceptsAssignments,
} from '../vendor/vendor.constants'
import type { DriverStatus, VehicleStatus, VendorStatus } from '../vendor/vendor.constants'

/**
 * The single source of truth for the Delivery vocabulary. The frontend mirrors
 * this file at `LBTS-Frontend/src/features/delivery/types/index.ts`, which adds
 * display metadata and nothing else. Change one, change both.
 *
 * A delivery is **one trip**: one vehicle, one driver, one vendor, and the
 * challans that went out on it. A challan too large for one lorry is not a
 * trip with two vehicles — it is the same challan on two trips, each carrying
 * part of it, which is what the allocation arithmetic in
 * `delivery.allocation.ts` keeps honest.
 */

// --- Lifecycle -------------------------------------------------------------

/**
 * Two states, and **neither is a button**.
 *
 * A trip used to step `Assigned → Dispatched → Delivered` by hand, and the
 * steps were a timeline nobody kept: an operator at a gate has a lorry to load,
 * not a status to maintain, so "Dispatched" meant "somebody remembered" and
 * `Delivered` was, in the old wording of this file, "only as true as the
 * operators are diligent". A status that is mostly a habit is worse than none,
 * because every filter built on it reports the habit.
 *
 * What actually ends a delivery is paper coming back: the receiver signs the
 * challan copy, it is scanned in through the agent, and *that* is the evidence.
 * So completion is recorded per challan, where it happens, and a trip's status
 * is arithmetic over its challans — `Completed` when every challan on it has
 * its signed copy in, `Open` until then. There is nothing to press and nothing
 * to forget.
 *
 * The same reasoning `ChallanBatch` follows in the Challan module, where
 * completion is pages accounted for rather than a button, and for the same
 * reason: a state somebody has to remember to set is a state that is wrong.
 *
 * Still no `Draft` — a trip under construction is a cart in a browser — and
 * still no `Cancelled`: a trip that is not going to happen is deleted while it
 * is open, which releases every challan quantity it held.
 */
export const TRIP_STATUSES = ['Open', 'Completed'] as const
export type TripStatus = (typeof TRIP_STATUSES)[number]

export const INITIAL_TRIP_STATUS: TripStatus = 'Open'

/**
 * A trip's status, from its challans. Written by a pre-save hook rather than
 * by any caller, exactly as `challanCount` and `totalQty` are — there are
 * several places a challan's completion can change, and a fourth would only
 * have to forget once.
 *
 * A trip with no challans is `Open`, not `Completed`: the schema refuses one
 * anyway, and calling an empty trip finished would be the same mistake
 * `chargeStatusFor` avoids when it calls a challan with no lines `Unpriced`.
 */
export function tripStatusFor(challans: readonly { completedAt?: Date | null }[]): TripStatus {
  if (challans.length === 0) {
    return INITIAL_TRIP_STATUS
  }
  return challans.every((challan) => Boolean(challan.completedAt)) ? 'Completed' : 'Open'
}

/**
 * What may still change about a trip.
 *
 * An `Open` trip is editable and deletable; a `Completed` one is not. The rule
 * is the same one the old `Assigned`-only check was reaching for and states it
 * more honestly: what closes a trip to editing is not somebody pressing a
 * button but every receiver on it having signed for their goods. Clearing one
 * challan's received copy reopens the trip, which is the correction path —
 * and it is a real correction, recorded, rather than a status stepped back.
 */
export function tripIsEditable(status: TripStatus): boolean {
  return status === 'Open'
}

// --- Completing a delivery -------------------------------------------------

/**
 * What a challan's delivery amounts to, derived and never stored as a field
 * anybody can set.
 *
 * `Complete` means one thing only: the signed copy is in. Not "the lorry left",
 * not "the operator thinks so" — the scan, which is the one artefact that
 * cannot be produced by forgetting.
 */
export const DELIVERY_OUTCOMES = ['Pending', 'Complete'] as const
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number]

/**
 * **Why** a delivery counts as complete. Three answers, in order of strength:
 *
 * - `SignedCopy` — the receiver's copy is on record. The evidence itself.
 * - `Returned` — every piece that went out came back. Nothing was delivered,
 *   so there is nobody who could have signed, and asking for a copy would
 *   leave the delivery open forever.
 * - `CopyMissing` — the operator has said the copy is lost. Paper goes
 *   missing off lorries, and a delivery nobody can ever close is worse than
 *   one closed on a stated reason; the reason is kept, and scanning the copy
 *   later replaces the declaration.
 */
export const COMPLETION_METHODS = ['SignedCopy', 'Returned', 'CopyMissing'] as const
export type CompletionMethod = (typeof COMPLETION_METHODS)[number]

export const MAX_COPY_MISSING_REASON = 300

/**
 * How a trip challan is complete, or null while it is still waiting.
 *
 * Derived from what is on record and never stored, so it cannot disagree with
 * the copy, the returns or the declaration beside it. The pre-save hook writes
 * `completedAt` from this.
 */
export function completionMethodFor(input: {
  hasCopy: boolean
  copyMissing: boolean
  /** Pieces the lorry took of this challan. */
  carried: number
  /** Pieces of it that came back. */
  returned: number
}): CompletionMethod | null {
  if (input.hasCopy) {
    return 'SignedCopy'
  }
  if (input.carried > 0 && input.returned >= input.carried) {
    return 'Returned'
  }
  if (input.copyMissing) {
    return 'CopyMissing'
  }
  return null
}

/**
 * What was used to get the goods from the lorry to the receiver's door.
 *
 * Two kinds, because that is what is hired at a gate: another vehicle for the
 * last stretch — a rickshaw van, a CNG — or people to carry it up. Each entry
 * carries what it cost, and an entry costing nothing is perfectly ordinary:
 * the vendor's own helper carrying a box up one floor is worth recording and
 * is not worth a taka.
 */
export const CARRYING_KINDS = ['Vehicle', 'Labour'] as const
export type CarryingKind = (typeof CARRYING_KINDS)[number]

/** Enough for a difficult delivery; a ceiling on a body nobody should send. */
export const MAX_CARRYING_ENTRIES = 12

/**
 * A floor number, not a storey count. Zero is the ground floor, which is why
 * the field is optional rather than defaulted — "0" and "nobody said" are
 * different answers, and a delivery to a shop front has no floor at all.
 */
export const MAX_FLOOR = 200

/** One carrying charge. Taka, whole numbers — nobody hires half a labourer. */
export const MAX_CARRYING_AMOUNT = 1_000_000

/**
 * The ceiling on a trip's rent or its labour bill, in whole taka — a body
 * nobody should send rather than a business limit. A typo adding two zeros is
 * what the Bangla words beside the field exist to catch; this is the floor
 * under that.
 */
export const MAX_TRIP_CHARGE = 10_000_000

/**
 * The trip bill backlog, as a list filter: every trip, those with no rent
 * entered, those with no labour bill entered. A blank is `null` (or a trip
 * written before the fields existed), never zero — a trip that genuinely cost
 * nothing has been billed.
 */
export const TRIP_BILL_FILTERS = ['all', 'no-rent', 'no-labour'] as const
export type TripBillFilter = (typeof TRIP_BILL_FILTERS)[number]

export function carryingTotalOf(entries: readonly { amount: number }[]): number {
  return entries.reduce((sum, entry) => sum + entry.amount, 0)
}

/**
 * The signed challan copy that comes back from the receiver.
 *
 * The same two limits and the same reasoning as a gate pass scan: a photograph
 * of a signed sheet is an image, a multi-page scan off the feeder is a PDF, and
 * neither is ever resized down past readability — somebody has to be able to
 * read a signature and a date off it.
 */
export const RECEIVED_COPY_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
export type ReceivedCopyMimeType = (typeof RECEIVED_COPY_MIME_TYPES)[number]

export const MAX_RECEIVED_COPY_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_RECEIVED_COPY_PDF_BYTES = 25 * 1024 * 1024

export function maxReceivedCopyBytesFor(mimeType: string): number {
  return mimeType === 'application/pdf'
    ? MAX_RECEIVED_COPY_PDF_BYTES
    : MAX_RECEIVED_COPY_IMAGE_BYTES
}

// --- What a delivery says about a challan ----------------------------------

/**
 * How much of a challan has gone out — a field on the **challan**, owned here.
 *
 * The vocabulary lives in this module for the reason `LOCATION_STATUSES` lives
 * in the Location module and not in Challan: it is a statement about trips, and
 * a challan simply carries the answer. Challan stores it rather than deriving
 * it, exactly as it stores `locationStatus` and `chargeStatus`, because it is
 * what the records list filters and counts on and working it out in a query
 * would mean an unindexed pass on every page.
 *
 * `Delivered` means every trip carrying it has its **signed copy** in — the
 * receiver's own challan copy, scanned back through the agent. Nothing else
 * sets it, and in particular no operator marks it by hand, which is what makes
 * it a fact rather than a habit. A challan whose goods arrived and whose copy
 * nobody has scanned rests at `Dispatched`: everything left the gate, and the
 * paperwork has not come back.
 *
 * `dispatched` here is what the trips **net** delivered. Goods that went out
 * and came back are not dispatched — they are on a shelf at the depot, and the
 * challan is waiting for another lorry exactly as it was before.
 */
export const DISPATCH_STATUSES = ['Pending', 'Partial', 'Dispatched', 'Delivered'] as const
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number]

export const INITIAL_DISPATCH_STATUS: DispatchStatus = 'Pending'

/**
 * What a challan's trips add up to.
 *
 * `ordered` is the challan as it stands — which, after a correction, already
 * *is* what went plus what a split holds back, so "everything has gone" and
 * "the challan is satisfied" are the same question.
 *
 * A challan on no trip is `Pending` however its quantities look, because a
 * challan nothing carries has not been dispatched by anybody; and a challan
 * with something still to go stays `Partial` even when every trip so far has
 * been delivered, because the part that is waiting has not.
 */
export function dispatchStatusFor(input: {
  ordered: number
  dispatched: number
  trips: number
  /** Every trip carrying it has this challan's signed copy on record. */
  everyTripCompleted: boolean
}): DispatchStatus {
  if (input.trips === 0 || input.dispatched === 0) {
    return INITIAL_DISPATCH_STATUS
  }
  if (input.dispatched < input.ordered) {
    return 'Partial'
  }
  return input.everyTripCompleted ? 'Delivered' : 'Dispatched'
}

/**
 * What came back off the lorries, and how much of that has gone out again.
 *
 * `trips` in the order they ran, each with what it net-delivered and what came
 * back off it. A returned piece goes onto the shelf at the depot, and a later
 * trip is taken to load from that shelf first — so a lorry carrying the rest of
 * a split *and* two returned pieces counts two as re-sent, never its whole
 * load, and nothing counts as re-sent that was not returned first. A trip never
 * re-sends what came back off itself.
 *
 * Derived and stored beside `dispatchStatus` rather than replacing any of it:
 * a challan returned in full is still `Pending`, because it is still waiting
 * for a lorry — this is what lets a list say *why*.
 */
export function returnFlowFor(trips: { delivered: number; returned: number }[]): {
  returnedQty: number
  resentQty: number
} {
  let returnedQty = 0
  let resentQty = 0
  let atDepot = 0

  for (const trip of trips) {
    // What the lorry *carried*, not what it left behind: a re-sent load that
    // came back again was still re-sent, and counting it as nothing would put
    // the same pieces on the shelf twice.
    const resent = Math.min(trip.delivered + trip.returned, atDepot)
    resentQty += resent
    atDepot -= resent
    returnedQty += trip.returned
    atDepot += trip.returned
  }

  return { returnedQty, resentQty }
}

// --- Eligibility -----------------------------------------------------------

/**
 * Why a vehicle may not take a new trip, or null when it may.
 *
 * Asked on the server at every create and update — the vehicle search hiding a
 * lorry is courtesy, this is the rule. It reuses the Vendor module's own gates
 * rather than restating them: a vehicle that may not be given a new driver is
 * not one that should be given a new load either, and the two can never drift
 * if they are the same function.
 */
export function vehicleTripBlocker(
  vehicleStatus: VehicleStatus,
  vendorStatus: VendorStatus,
): string | null {
  if (!vehicleAcceptsDriver(vehicleStatus)) {
    return `The vehicle is ${vehicleStatus}.`
  }
  if (!vendorAcceptsAssignments(vendorStatus)) {
    return `Its vendor is ${vendorStatus}.`
  }
  return null
}

/** Why a driver may not drive a new trip, or null when they may. */
export function driverTripBlocker(driverStatus: DriverStatus): string | null {
  return driverAcceptsAssignment(driverStatus) ? null : `The driver is ${driverStatus}.`
}

// --- Permissions -----------------------------------------------------------

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do.
 *
 * The same shape as Challan, and for the same reason: a trip carries every
 * challan on it — customer names, delivery addresses, receivers' phone numbers
 * — so `Vendor` appears in neither set, even though a trip is assigned to a
 * vendor. Every other role appears in both, `CEO` included: the four staff
 * roles run trips together, and the business asked for one rule per module
 * rather than a different rule per person.
 *
 * Writing includes adding a driver from inside a trip. That is wider than the
 * Vendor module's own fleet tab was — deliberately: a driver the master does
 * not know is the ordinary thing an operator meets at the gate, and sending
 * them away to ask a manager stops a lorry. The write is still only ever an
 * *addition*, under a working vendor, with every rule the fleet tab applies.
 */
export const DELIVERY_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const DELIVERY_WRITE_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']

/**
 * Roles that may change or remove a trip somebody else created — which is now
 * every role that may write at all.
 *
 * It stays a set of its own rather than folding into `DELIVERY_WRITE_ROLES`,
 * because it answers a different question: the first says who may work this
 * module, this says whether their work is scoped to their own trips. The
 * business asked for the scope to come off; narrowing it again is this line.
 */
export const DELIVERY_MANAGE_ANY_ROLES: readonly UserRole[] = [
  'Admin',
  'Manager',
  'CEO',
  'OpEx',
]

export function canManageAnyTrip(role: UserRole): boolean {
  return DELIVERY_MANAGE_ANY_ROLES.includes(role)
}

// --- Numbering -------------------------------------------------------------

/**
 * A trip's number is its vendor's own running serial: `V-0007-TRIP-0012` is
 * the twelfth trip Malek Transport ever ran for us.
 *
 * Per vendor rather than global, because that is how the business counts trips
 * — a vendor's bill is "trips 1 to 40 this month", and a global serial would
 * turn that into forty numbers with gaps nobody could explain. The vendor code
 * in front is what keeps it globally unique without a second identifier, and it
 * can never go stale because a trip's vendor never changes (see
 * `updateTrip`). Allocated from the shared atomic counter only once every check
 * has passed, so a refused confirmation burns nothing.
 */
export function tripCounterKey(vendorId: string): string {
  return `delivery-trip:${vendorId}`
}

export function formatTripNumber(vendorCode: string, serial: number): string {
  return `${vendorCode}-TRIP-${String(serial).padStart(4, '0')}`
}

// --- Searching a plate -----------------------------------------------------

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯'

/**
 * Bangla digits as ASCII ones.
 *
 * A plate painted `ঢাকা মেট্রো-ট ১১-১২৩৪` and an operator typing `১২৩৪` into the
 * search are both asking about 1234, and `registrationKey` — which the whole
 * fleet is indexed under — strips anything that is not A–Z or 0–9. Converting
 * first is what stops a Bangla keyboard from finding nothing.
 */
export function asciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
}

/** The reverse: ASCII digits as Bangla ones, to find a plate painted in Bangla. */
export function banglaDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => BANGLA_DIGITS[Number(digit)])
}

/**
 * The key a plate search is run on: the same normalisation the vehicle's
 * `registrationNoKey` is stored under, after Bangla digits are made ASCII. So
 * `1234`, `ta 1234`, `TA-1234` and `১২৩৪` are all one question.
 */
export function plateSearchKey(value: string): string {
  return registrationKey(asciiDigits(value))
}

/**
 * How well a plate answers a search, for ordering the results.
 *
 * `tail` is the case the whole search is designed around — an operator reads
 * the last digits off the back of a lorry — so a plate that *ends* with what
 * was typed outranks one that merely contains it. Null when it does not match.
 */
export type PlateMatch = 'exact' | 'tail' | 'contains'

export function plateMatch(plateKey: string, queryKey: string): PlateMatch | null {
  if (!queryKey || !plateKey.includes(queryKey)) {
    return null
  }
  if (plateKey === queryKey) {
    return 'exact'
  }
  return plateKey.endsWith(queryKey) ? 'tail' : 'contains'
}

const MATCH_ORDER: Record<PlateMatch, number> = { exact: 0, tail: 1, contains: 2 }

/** Orders two plates for one query: better match first, then alphabetical. */
export function comparePlates(
  a: { key: string; label: string },
  b: { key: string; label: string },
  queryKey: string,
): number {
  const left = plateMatch(a.key, queryKey)
  const right = plateMatch(b.key, queryKey)
  const byMatch =
    (left ? MATCH_ORDER[left] : 9) - (right ? MATCH_ORDER[right] : 9)

  return byMatch !== 0 ? byMatch : a.label.localeCompare(b.label)
}

// --- Limits ----------------------------------------------------------------

/** Below this a plate search is one character matching half the fleet. */
export const MIN_PLATE_QUERY_LENGTH = 2

/** Vehicles one search returns. A list longer than this is a query to refine. */
export const MAX_VEHICLE_RESULTS = 12

/** Unavailable matches reported beside the results, so a missing lorry is explained. */
export const MAX_UNAVAILABLE_REPORTED = 5

/** Challans one cart search returns. */
export const MAX_CHALLAN_CANDIDATES = 10

/** Challans one trip may carry — a sanity bound on a request body. */
export const MAX_TRIP_CHALLANS = 100

/**
 * Lines one challan may carry on a trip. Higher than a challan's own ceiling,
 * because a trip may substitute a model or add one the paper did not list.
 */
export const MAX_TRIP_LINES = 40

export const MAX_TRIP_PAGE_SIZE = 50
