import * as z from 'zod'
import {
  ASSIGNMENT_STATUSES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  DRIVER_STATUSES,
  MAX_VENDOR_PAGE_SIZE,
  VEHICLE_OWNERSHIP_TYPES,
  VEHICLE_STATUSES,
  VENDOR_STATUSES,
} from './vendor.constants'

/** Mongo ObjectId as it arrives in a URL or a body. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const idParamSchema = z.object({ id: objectId })
export type IdParam = z.infer<typeof idParamSchema>

/**
 * A calendar day, as `YYYY-MM-DD`.
 *
 * Parsed to UTC midnight rather than through `new Date(value)`, which reads a
 * bare date as UTC but a date-with-time in local terms — and a licence that
 * expires "on the 20th" must be the 20th for every viewer. The same treatment
 * a challan's trip date gets.
 */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), 'That is not a real date.')

/**
 * The same, but where clearing the value is a legitimate thing to send.
 *
 * An empty string counts as null, because half of these arrive as multipart
 * form fields beside a file and a form that leaves a date blank sends `""`
 * rather than omitting the field. Treating that as "not set" is what stops an
 * optional expiry date being a 400.
 */
const nullableCalendarDay = z.preprocess(
  (value) => (value === '' ? null : value),
  z.union([calendarDay, z.null()]),
)

/**
 * A Bangladeshi mobile number, checked loosely on purpose.
 *
 * Eleven digits starting `01`, or the same number written with a country code
 * or separators — `normalizeMobile` reduces all of those to one stored form.
 * Anything else is refused, because a mobile number is what a dispatcher rings
 * and a directory full of half-typed numbers is a directory nobody trusts.
 */
const mobile = z
  .string()
  .trim()
  .min(1, 'Mobile number is required')
  .max(32)
  .refine(
    (value) => /^(?:\+?88)?0?1\d{9}$/.test(value.replace(/[\s-]/g, '')),
    'Enter an 11-digit mobile number, for example 01712345678.',
  )

// --- Vendor ----------------------------------------------------------------

/**
 * A vendor, as somebody creates one.
 *
 * `vendorCode`, `nameKey` and `mobileKey` are deliberately absent. The first is
 * allocated by the server from an atomic counter, and the other two are derived
 * from what was typed — a client that could set a comparison key could make a
 * record match something it does not say, which is the one way this collection
 * could lie about who a vendor is.
 *
 * `status` is present but optional, and it is the only lifecycle field any
 * request in this module may carry: an Admin recording a vendor who is already
 * working should not have to create it and then immediately approve it. Every
 * *later* change goes through the status endpoint, where the transition table
 * is checked.
 */
const vendorFields = {
  name: z
    .string()
    .trim()
    .min(2, 'Vendor name must be at least 2 characters')
    .max(160, 'Vendor name must be 160 characters or fewer'),
  mobile,
  address: z.string().trim().max(400, 'Address must be 400 characters or fewer'),
}

/**
 * Defaults live on the create schema and never on the shared fields, which is
 * the same arrangement `location.validation.ts` documents.
 *
 * A default survives `.partial()`, so a defaulted field would be filled in on
 * every update — an empty PATCH would arrive carrying `address: ''` and look
 * like a request to clear the address, and the "nothing to change" refusal
 * below would never fire because the body would never be empty.
 */
export const createVendorSchema = z.object({
  ...vendorFields,
  address: vendorFields.address.default(''),
  status: z.enum(VENDOR_STATUSES).optional(),
})
export type CreateVendorInput = z.infer<typeof createVendorSchema>

/**
 * Correcting one. Every field optional — a mistyped mobile number and a moved
 * office are independent reasons to edit — and a body that changes nothing is
 * refused rather than treated as a silent success.
 *
 * `status` is absent here. Moving a vendor between lifecycle states is a
 * decision with consequences (it stops new assignments), so it has an endpoint
 * of its own where the transition is checked and the reason is recorded, rather
 * than riding along with a change of address.
 */
export const updateVendorSchema = z
  .object(vendorFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change.' })
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>

/**
 * One endpoint serves every lifecycle action — approve, deactivate, suspend,
 * reinstate — because each is a move to a target status. Which moves are legal
 * is decided by `VENDOR_STATUS_TRANSITIONS`, not by the client.
 */
export const vendorStatusSchema = z.object({
  status: z.enum(VENDOR_STATUSES),
  note: z.string().trim().max(400).optional(),
})
export type VendorStatusInput = z.infer<typeof vendorStatusSchema>

/**
 * What narrows the vendor list.
 *
 * `compliance` is a filter over derived data rather than a stored column, which
 * is why it is a three-way enum rather than a count: "show me the vendors with
 * something expired" is the question somebody sits down to answer, and "show
 * me the vendors with between two and four alerts" is not a question anybody
 * has.
 */
export const listVendorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_VENDOR_PAGE_SIZE).default(10),
  search: z.string().trim().max(160).default(''),
  status: z.enum(['all', ...VENDOR_STATUSES]).default('all'),
  compliance: z.enum(['all', 'expired', 'expiring', 'clear']).default('all'),
  sort: z.enum(['name', 'recent', 'vehicles', 'drivers']).default('name'),
})
export type ListVendorsQuery = z.infer<typeof listVendorsQuerySchema>

// --- Vehicle ---------------------------------------------------------------

/**
 * A vehicle, as somebody adds one to a vendor's fleet.
 *
 * `vendorId` is deliberately **not** a field. The vendor comes from the URL —
 * `POST /vendors/:id/vehicles` — and is checked against the caller's scope
 * before anything is written. A vendor id in a body would be a second place the
 * owner could come from, and the whole security model of this module is that
 * there is exactly one.
 *
 * Brand and model are optional because plenty of fleets record a plate and
 * nothing else, and refusing the record until somebody guesses a model is how
 * a vehicle ends up not being recorded at all.
 */
const vehicleFields = {
  registrationNo: z
    .string()
    .trim()
    .min(4, 'Registration number must be at least 4 characters')
    .max(60, 'Registration number must be 60 characters or fewer'),
  brand: z.string().trim().max(80),
  model: z.string().trim().max(80),
  ownershipType: z.enum(VEHICLE_OWNERSHIP_TYPES, { error: 'Choose how the vehicle is owned.' }),
}

/** Defaults on the create schema only — see the note on `createVendorSchema`. */
export const createVehicleSchema = z.object({
  ...vehicleFields,
  brand: vehicleFields.brand.default(''),
  model: vehicleFields.model.default(''),
  status: z.enum(VEHICLE_STATUSES).optional(),
})
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>

/**
 * Correcting a vehicle.
 *
 * The vendor is absent here for a second reason on top of the first: moving a
 * vehicle between vendors would strand its assignment history on the far side
 * of a relationship that no longer exists. A transfer is a controlled business
 * operation — retire the record on one side, create it on the other — not a
 * field on an edit form.
 */
export const updateVehicleSchema = z
  .object(vehicleFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change.' })
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>

export const vehicleStatusSchema = z.object({
  status: z.enum(VEHICLE_STATUSES),
  note: z.string().trim().max(400).optional(),
})
export type VehicleStatusInput = z.infer<typeof vehicleStatusSchema>

export const listVehiclesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_VENDOR_PAGE_SIZE).default(10),
  search: z.string().trim().max(120).default(''),
  status: z.enum(['all', ...VEHICLE_STATUSES]).default('all'),
  ownershipType: z.enum(['all', ...VEHICLE_OWNERSHIP_TYPES]).default('all'),
  brand: z.string().trim().max(80).default(''),
})
export type ListVehiclesQuery = z.infer<typeof listVehiclesQuerySchema>

// --- Driver ----------------------------------------------------------------

/**
 * A driver, as somebody adds one to a vendor.
 *
 * `vendorId` is absent for the same reason it is absent from a vehicle: the
 * owner comes from the URL and is scope-checked, and a second source would be a
 * way around that check.
 *
 * The NID is optional. It is required to *prove* who was driving and the form
 * asks for it plainly, but a driver recorded today whose card is in a drawer at
 * home is still a driver the dispatcher has to be able to assign — and a
 * required field there means somebody types nine zeroes.
 */
const driverFields = {
  name: z
    .string()
    .trim()
    .min(2, 'Driver name must be at least 2 characters')
    .max(160, 'Driver name must be 160 characters or fewer'),
  mobile,
  nidNumber: z.string().trim().max(40, 'NID must be 40 characters or fewer'),
  address: z.string().trim().max(400),
  licenseNumber: z.string().trim().max(60, 'Licence number must be 60 characters or fewer'),
  licenseExpiry: nullableCalendarDay,
}

/** Defaults on the create schema only — see the note on `createVendorSchema`. */
export const createDriverSchema = z
  .object({
    ...driverFields,
    nidNumber: driverFields.nidNumber.default(''),
    address: driverFields.address.default(''),
    licenseNumber: driverFields.licenseNumber.default(''),
    licenseExpiry: driverFields.licenseExpiry.default(null),
    status: z.enum(DRIVER_STATUSES).optional(),
  })
  /**
   * A licence expiry without a licence number is a deadline attached to
   * nothing — it would raise a compliance alert nobody could act on, because
   * there is no document to go and renew.
   */
  .refine((value) => !value.licenseExpiry || value.licenseNumber.length > 0, {
    message: 'Add the licence number the expiry date belongs to.',
    path: ['licenseNumber'],
  })
export type CreateDriverInput = z.infer<typeof createDriverSchema>

export const updateDriverSchema = z
  .object(driverFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change.' })
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>

export const driverStatusSchema = z.object({
  status: z.enum(DRIVER_STATUSES),
  note: z.string().trim().max(400).optional(),
})
export type DriverStatusInput = z.infer<typeof driverStatusSchema>

export const listDriversQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_VENDOR_PAGE_SIZE).default(10),
  search: z.string().trim().max(120).default(''),
  status: z.enum(['all', ...DRIVER_STATUSES]).default('all'),
  licence: z.enum(['all', 'expired', 'expiring']).default('all'),
})
export type ListDriversQuery = z.infer<typeof listDriversQuerySchema>

// --- Assignment ------------------------------------------------------------

/**
 * Putting a driver on a vehicle.
 *
 * `vendorId` is absent again — it comes from the URL — and the service proves
 * that the vehicle and the driver both already belong to it before writing
 * anything. That is what makes "a driver from Vendor A cannot be assigned to
 * Vendor B's vehicle" a property of the system rather than a warning in a form.
 *
 * `replaceActive` is the only unusual field, and it exists because silently
 * changing who is driving a vehicle is exactly what this module must not do. A
 * request that would displace a live assignment and does not carry it is
 * refused with the assignment it would have closed, so the client can say
 * "Rahim will become the active driver; the assignment with Karim will be
 * closed" and ask again. It is a confirmation, not a permission.
 */
export const createAssignmentSchema = z.object({
  vehicleId: objectId,
  driverId: objectId,
  assignedFrom: calendarDay,
  assignedUntil: nullableCalendarDay.default(null),
  replaceActive: z.coerce.boolean().default(false),
  note: z.string().trim().max(400).optional(),
})
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>

/**
 * Closing one.
 *
 * The end date is optional and defaults to today in the service, because the
 * ordinary case is "he came off the vehicle this morning" and making somebody
 * type today's date is friction with a typo in it.
 */
export const endAssignmentSchema = z.object({
  assignedUntil: calendarDay.optional(),
  note: z.string().trim().max(400).optional(),
})
export type EndAssignmentInput = z.infer<typeof endAssignmentSchema>

export const listAssignmentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_VENDOR_PAGE_SIZE).default(10),
  status: z.enum(['all', ...ASSIGNMENT_STATUSES]).default('all'),
  vehicleId: z.union([objectId, z.literal('')]).default(''),
  driverId: z.union([objectId, z.literal('')]).default(''),
  from: calendarDay.optional(),
  to: calendarDay.optional(),
})
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>

// --- Documents -------------------------------------------------------------

/**
 * A compliance document.
 *
 * `ownerType` and `ownerId` say what it belongs to; the service reads the
 * vendor off that owner rather than accepting one, so a document can never be
 * filed against a vendor its subject does not belong to. `documentType` is
 * checked against the owner's own set — an NID on a lorry is refused rather
 * than stored as a curiosity.
 *
 * There is no `status` field, and there could not be: whether a document is
 * valid, expiring or expired is arithmetic over `expiryDate`, and a status
 * somebody could type would be a way to contradict the date beside it.
 *
 * The values arrive as multipart form fields alongside the file, so everything
 * here is coerced from a string.
 */
export const createDocumentSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES, { error: 'Choose a document type.' }),
    documentNumber: z.string().trim().max(80).default(''),
    issueDate: nullableCalendarDay.default(null),
    expiryDate: nullableCalendarDay.default(null),
    note: z.string().trim().max(400).optional(),
  })
  .refine(
    (value) =>
      !value.issueDate ||
      !value.expiryDate ||
      value.expiryDate.getTime() >= value.issueDate.getTime(),
    { message: 'The expiry date cannot be before the issue date.', path: ['expiryDate'] },
  )
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>

/**
 * Renewing or correcting one.
 *
 * Renewal is an edit rather than a second row: a vehicle has one fitness
 * certificate at a time, the renewed one replaces the old, and two rows would
 * make "is this vehicle's fitness valid" a question with two answers.
 * `documentType` is absent because changing it would turn a tax token into a
 * route permit, which is a different document and belongs to a different row.
 *
 * There is no "nothing to change" refusal here, unlike every other update
 * schema in this file, and the reason is the attachment: replacing only the
 * scan is a real change and it arrives as a file rather than as a field, so an
 * empty body is a legitimate request.
 */
export const updateDocumentSchema = z
  .object({
    documentNumber: z.string().trim().max(80),
    issueDate: nullableCalendarDay,
    expiryDate: nullableCalendarDay,
    note: z.string().trim().max(400),
  })
  .partial()
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>

export const listDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_VENDOR_PAGE_SIZE).default(10),
  ownerType: z.enum(['all', 'Vehicle', 'Driver']).default('all'),
  ownerId: z.union([objectId, z.literal('')]).default(''),
  documentType: z.enum(['all', ...DOCUMENT_TYPES]).default('all'),
  status: z.enum(['all', ...DOCUMENT_STATUSES]).default('all'),
  search: z.string().trim().max(120).default(''),
})
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>

// --- Shared ----------------------------------------------------------------

/** The activity feed, which is only ever "the newest N for this vendor". */
export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type ActivityQuery = z.infer<typeof activityQuerySchema>

/** The vendor selector on a form: id, code and name, and nothing heavier. */
export const vendorOptionsQuerySchema = z.object({
  search: z.string().trim().max(120).default(''),
  /** Only the vendors that may take new work, for an assignment form. */
  operational: z.coerce.boolean().default(false),
})
export type VendorOptionsQuery = z.infer<typeof vendorOptionsQuerySchema>
