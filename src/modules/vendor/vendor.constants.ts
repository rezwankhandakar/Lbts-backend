import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Vendor vocabulary — the vendor itself,
 * its vehicles, its drivers, the assignments between them and the compliance
 * documents behind all three.
 *
 * The frontend mirrors this file at
 * `LBTS-Frontend/src/features/vendor/types/index.ts`, which adds display
 * metadata and nothing else. Change one, change both.
 */

// --- Vendor ----------------------------------------------------------------

/**
 * Lifecycle of one vendor.
 *
 * `Pending` is a vendor that has been recorded but not yet cleared to work —
 * the same posture a new user account takes. `Active` is the only state that
 * may receive new operational assignments; `Inactive` and `Suspended` are both
 * stops, kept apart because they mean different things to the business (one
 * has stopped trading with us, the other has been stopped by us).
 *
 * There is deliberately no `Deleted` state. A vendor that should not exist is
 * removed outright when nothing references it, and deactivated when something
 * does — see `removeVendor`. A status nothing can leave is a value every list,
 * count and selector then has to remember to exclude.
 */
export const VENDOR_STATUSES = ['Pending', 'Active', 'Inactive', 'Suspended'] as const
export type VendorStatus = (typeof VENDOR_STATUSES)[number]

export const DEFAULT_VENDOR_STATUS: VendorStatus = 'Pending'

/**
 * Legal moves, enforced server-side. A stale client menu cannot force an
 * illegal one, exactly as with the account lifecycle.
 *
 * Every stop can be reversed, because a vendor suspended over a document that
 * has since been renewed has to be able to come back without being recreated —
 * and recreating one would orphan every vehicle, driver and assignment under
 * it.
 */
export const VENDOR_STATUS_TRANSITIONS: Record<VendorStatus, readonly VendorStatus[]> = {
  Pending: ['Active', 'Inactive', 'Suspended'],
  Active: ['Inactive', 'Suspended'],
  Inactive: ['Active', 'Suspended'],
  Suspended: ['Active', 'Inactive'],
}

export function canTransitionVendor(from: VendorStatus, to: VendorStatus): boolean {
  // Indexed defensively: a document written before this set existed holds a
  // value with no entry here, and must fail closed rather than throw.
  return (VENDOR_STATUS_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Whether a vendor may take on new work.
 *
 * The one question the rest of the module asks about a vendor status, so it is
 * asked in one place. An `Inactive` or `Suspended` vendor keeps every record it
 * already has — history is never destroyed by a status — but nothing new is
 * assigned under it.
 */
export function vendorAcceptsAssignments(status: VendorStatus): boolean {
  return status === 'Active'
}

// --- Vehicle ---------------------------------------------------------------

/** Who owns the vehicle the vendor is running. */
export const VEHICLE_OWNERSHIP_TYPES = ['Vendor Owned', 'Rented'] as const
export type VehicleOwnershipType = (typeof VEHICLE_OWNERSHIP_TYPES)[number]

/**
 * Lifecycle of one vehicle.
 *
 * `Under Maintenance` and `Expired` are operational states rather than
 * administrative ones — the first is a vehicle in the workshop, the second is
 * one whose papers have run out. Both stop it taking a new driver, and neither
 * hides it from a list: a vehicle nobody can see is a vehicle nobody fixes.
 */
export const VEHICLE_STATUSES = [
  'Active',
  'Inactive',
  'Under Maintenance',
  'Suspended',
  'Expired',
] as const
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number]

export const DEFAULT_VEHICLE_STATUS: VehicleStatus = 'Active'

/**
 * Whether a vehicle may be given a new active driver.
 *
 * Only `Active`. Putting a driver on a vehicle that is in the workshop, out of
 * service or out of papers records an assignment the operation cannot honour,
 * and the assignment history is what a dispute is settled from.
 */
export function vehicleAcceptsDriver(status: VehicleStatus): boolean {
  return status === 'Active'
}

// --- Driver ----------------------------------------------------------------

/**
 * Lifecycle of one driver.
 *
 * `On Leave` is its own state rather than a flavour of `Inactive`, because the
 * two are answered differently: a driver on leave comes back next week and
 * their history is worth keeping in front of a dispatcher, an inactive one has
 * left.
 */
export const DRIVER_STATUSES = ['Active', 'Inactive', 'Suspended', 'On Leave'] as const
export type DriverStatus = (typeof DRIVER_STATUSES)[number]

export const DEFAULT_DRIVER_STATUS: DriverStatus = 'Active'

/** Whether a driver may be given a new active assignment. Only `Active`. */
export function driverAcceptsAssignment(status: DriverStatus): boolean {
  return status === 'Active'
}

// --- Assignment ------------------------------------------------------------

/**
 * The state of one vehicle-driver assignment, and there are exactly two.
 *
 * `Active` is the assignment in force now; `Ended` is history. There is
 * deliberately no `Cancelled` — the Gate Pass module carried one and it was
 * removed for the reason that applies here too: a record parked in a third
 * state is one every list, count and overlap probe has to remember to exclude.
 * An assignment recorded by mistake is deleted; one that ran and finished is
 * `Ended` and stays forever.
 */
export const ASSIGNMENT_STATUSES = ['Active', 'Ended'] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]

// --- Documents -------------------------------------------------------------

/** The papers a vehicle has to carry. */
export const VEHICLE_DOCUMENT_TYPES = [
  'Registration Certificate',
  'Fitness Certificate',
  'Tax Token',
  'Route Permit',
  'Insurance',
] as const
export type VehicleDocumentType = (typeof VEHICLE_DOCUMENT_TYPES)[number]

/** The papers a driver has to carry. */
export const DRIVER_DOCUMENT_TYPES = ['Driving License', 'NID'] as const
export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number]

export const DOCUMENT_TYPES = [...VEHICLE_DOCUMENT_TYPES, ...DRIVER_DOCUMENT_TYPES] as const
export type VendorDocumentType = (typeof DOCUMENT_TYPES)[number]

/** What a document belongs to. Both live in one collection — see the model. */
export const DOCUMENT_OWNER_TYPES = ['Vehicle', 'Driver'] as const
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number]

export function documentTypesFor(owner: DocumentOwnerType): readonly VendorDocumentType[] {
  return owner === 'Vehicle' ? VEHICLE_DOCUMENT_TYPES : DRIVER_DOCUMENT_TYPES
}

export function isDocumentTypeFor(owner: DocumentOwnerType, type: string): boolean {
  return (documentTypesFor(owner) as readonly string[]).includes(type)
}

/**
 * The one document type that is also a field on the record it belongs to.
 *
 * A driver carries `licenseNumber` and `licenseExpiry` so a table can render a
 * licence without joining the document collection on every row. That copy is
 * kept in step with this document type in one place — see `syncDriverLicence`
 * — so the two can never disagree, and compliance is therefore counted from
 * the documents alone rather than from both.
 */
export const DRIVER_LICENCE_DOCUMENT: DriverDocumentType = 'Driving License'

/**
 * Whether a document is valid, about to lapse, or lapsed.
 *
 * Derived from the expiry date and never stored, because a stored status is
 * wrong the morning after it was written and nothing would be there to notice.
 * The one cost is that "expiring soon" is a date-range query rather than an
 * equality one, which is why `expiryDate` is indexed.
 */
export const DOCUMENT_STATUSES = ['Valid', 'Expiring Soon', 'Expired'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * How far ahead "expiring soon" reaches.
 *
 * One number, here, rather than a literal in each query and each badge. Thirty
 * days is roughly the lead time a fitness certificate or a tax token needs to
 * be renewed without the vehicle standing idle.
 */
export const DOCUMENT_EXPIRY_SOON_DAYS = 30

const DAY_MS = 86_400_000

/** Start of the UTC day. Expiry dates are calendar days, stored at UTC midnight. */
export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0),
  )
}

/**
 * Whole days from today to an expiry date. Negative once it has passed, zero on
 * the day itself.
 *
 * Both sides are reduced to UTC midnight first, so the answer is a count of
 * calendar days rather than of elapsed hours — "expires in 12 days" must not
 * become 11 because somebody opened the page in the evening.
 */
export function daysUntilExpiry(expiryDate: Date, now: Date = new Date()): number {
  return Math.round((startOfUtcDay(expiryDate).getTime() - startOfUtcDay(now).getTime()) / DAY_MS)
}

/**
 * The status a document's dates imply.
 *
 * A document with no expiry date is `Valid`: an NID does not lapse, and
 * inventing a deadline for one would put a permanent false alarm on a vendor's
 * compliance panel. Nothing anywhere lets a person type one of these three
 * values — a status somebody could contradict the dates with is worse than no
 * status at all.
 */
export function documentStatusFor(
  expiryDate: Date | null | undefined,
  now: Date = new Date(),
): DocumentStatus {
  if (!expiryDate) {
    return 'Valid'
  }

  const days = daysUntilExpiry(expiryDate, now)

  if (days < 0) {
    return 'Expired'
  }
  return days <= DOCUMENT_EXPIRY_SOON_DAYS ? 'Expiring Soon' : 'Valid'
}

/** Puts a document ceiling in words: "Expires in 12 days". */
export function expiryPhrase(expiryDate: Date | null | undefined, now: Date = new Date()): string {
  if (!expiryDate) {
    return 'No expiry recorded'
  }

  const days = daysUntilExpiry(expiryDate, now)

  if (days < 0) {
    const past = Math.abs(days)
    return past === 1 ? 'Expired yesterday' : `Expired ${past} days ago`
  }
  if (days === 0) {
    return 'Expires today'
  }
  return days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`
}

/** Formats a document attachment may arrive in. The same set as a gate pass scan. */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number]

/**
 * Two limits, for the same reason Gate Pass has two: a photographed
 * certificate is well under 10 MB, a multi-page scanned permit legitimately is
 * not. The multipart parser is capped at the higher one and
 * `vendor.storage.ts` applies the real limit once the type is known.
 */
export const MAX_DOCUMENT_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_PDF_BYTES = 25 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_PDF_BYTES

export function maxDocumentBytesFor(mimeType: string): number {
  return mimeType === 'application/pdf' ? MAX_DOCUMENT_PDF_BYTES : MAX_DOCUMENT_IMAGE_BYTES
}

// --- Activity --------------------------------------------------------------

/**
 * What the activity log records.
 *
 * A closed set, because the log is read as a sentence per row and a free-text
 * action would drift into six spellings of "vehicle updated". The system has
 * no general audit module — CLAUDE.md says so — so this is deliberately the
 * minimum: one append-only collection scoped to a vendor, written by this
 * module and read by nothing else.
 */
export const ACTIVITY_ACTIONS = [
  'vendor.created',
  'vendor.updated',
  'vendor.status',
  'vendor.photo',
  'vehicle.created',
  'vehicle.updated',
  'vehicle.status',
  'vehicle.deleted',
  'driver.created',
  'driver.updated',
  'driver.status',
  'driver.deleted',
  'assignment.created',
  'assignment.ended',
  'assignment.deleted',
  'document.created',
  'document.updated',
  'document.deleted',
] as const
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number]

// --- Permissions -----------------------------------------------------------

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do: a role says who someone is to the business, not what
 * they may do inside a module. There is deliberately no central matrix.
 *
 * Reading covers every vendor, its fleet, its drivers, its assignments and its
 * documents. Writing covers all of it too — this is fleet master data, and
 * splitting "may add a vehicle" from "may add a driver" would be a distinction
 * the business does not make.
 *
 * `OpEx` reads and does not write, which is the posture it already has on the
 * other two reference collections, Location and Product Rate: an Operation
 * Executive needs to know which vehicle sits under which vendor to file a gate
 * pass, and changing the fleet is not their job. `CEO` reads everything and
 * writes nothing, as everywhere else.
 *
 * `Vendor` is the one role in the system that appears in a read set and is
 * *scoped* — see `vendor.access.ts`. It reads its own vendor and nothing else,
 * and it writes nothing at all.
 */
export const VENDOR_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx', 'Vendor']
export const VENDOR_MANAGE_ROLES: readonly UserRole[] = ['Admin', 'Manager']

/**
 * The role whose access is scoped to one vendor. Everything else in this
 * module keys off this rather than off the string, so the rule is stated once.
 */
export const VENDOR_SCOPED_ROLE: UserRole = 'Vendor'

export function canManageVendors(role: UserRole): boolean {
  return VENDOR_MANAGE_ROLES.includes(role)
}

export function canReadVendors(role: UserRole): boolean {
  return VENDOR_READ_ROLES.includes(role)
}

// --- Comparison keys -------------------------------------------------------

/**
 * The comparison key for a registration number.
 *
 * Byte-identical to `comparisonKey` in `gate-pass.constants.ts`, and that is
 * the point rather than a coincidence: a gate pass stores `vehicleNoKey` under
 * exactly this normalisation, so `DHAKA METRO-TA-11-1234` typed on a challan
 * and the same plate recorded on a vehicle here reduce to the same string. A
 * join between a gate pass and the vehicle that carried it is therefore one
 * indexed lookup whenever the business asks for one, rather than a migration.
 *
 * It is copied rather than imported deliberately: Gate Pass is a finished,
 * working module, and reaching into its constants from a new one would couple
 * two things that only agree about a string format. The agreement is pinned by
 * a test instead.
 */
export function registrationKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * The comparison key for a name somebody typed.
 *
 * Bangla-aware, like the Challan one: a vendor or a driver may legitimately be
 * recorded in Bangla, and a key that stripped it would reduce two different
 * names to the same empty string — which is how a duplicate check comes to
 * refuse every second Bangla name.
 */
export function nameKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9ঀ-৿]/g, '')
}

/**
 * A Bangladeshi mobile number reduced to the eleven digits that identify it.
 *
 * The same normalisation the Challan module applies, and for the same reason:
 * `+8801712345678`, `8801712345678` and `01712-345678` are one number written
 * three ways, and a directory that cannot tell is a directory nobody can
 * search. Anything not recognisably one of those forms keeps what was typed,
 * with its whitespace collapsed — guessing at an unusual number is worse than
 * storing what was on the paper.
 */
export function normalizeMobile(value: string): string {
  const digits = value.replace(/\D/g, '')

  if (/^01\d{9}$/.test(digits)) {
    return digits
  }
  if (/^8801\d{9}$/.test(digits)) {
    return digits.slice(2)
  }

  return value.trim().replace(/\s+/g, ' ')
}

// --- Limits ----------------------------------------------------------------

/** Rows one list page may return. */
export const MAX_VENDOR_PAGE_SIZE = 50

/** How many activity entries one read returns. */
export const MAX_ACTIVITY_ENTRIES = 50

/**
 * How many alerts the summary endpoint will report.
 *
 * A compliance panel is a to-do list, and a to-do list of two hundred rows is
 * one nobody starts. Past this the panel says how many more there are, and the
 * documents tab — filtered to expired, then to expiring — is where the rest is
 * worked through.
 */
export const MAX_SUMMARY_ALERTS = 8
