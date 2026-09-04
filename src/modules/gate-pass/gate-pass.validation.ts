import * as z from 'zod'
import {
  GATE_PASS_REFERENCE_TYPES,
  GATE_PASS_STATUSES,
  MAX_GATE_PASS_ITEMS,
} from './gate-pass.constants'

/** Mongo ObjectId as it arrives in a URL. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid gate pass id.')

export const gatePassIdParamSchema = z.object({
  id: objectId,
})

/**
 * A trip date is a calendar day, not an instant: the challan says 01-SEP-2026
 * and nothing on it is a time of day. Storing it at UTC midnight is what keeps
 * "same day" comparisons — duplicate detection, the date-range filter — from
 * depending on the timezone of whoever happened to type it.
 *
 * A full ISO timestamp is accepted because any client library will happily
 * send one; only the date part is ever kept.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}/

const tripDate = z
  .string()
  .trim()
  .regex(DATE_ONLY, 'Enter a valid date.')
  .transform((value) => new Date(`${value.slice(0, 10)}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), 'Enter a valid date.')
  .refine((date) => {
    const year = date.getUTCFullYear()
    return year >= 2000 && year <= 2100
  }, 'That date is outside the range this system records.')

/**
 * Identifiers copied off a printed challan. Deliberately permissive about
 * punctuation and deliberately strict about length: "DHAKA METRO-NA-15-1469"
 * and "3667398-5090414" are both real values, and neither may be rewritten on
 * the way in. Normalisation for comparison happens separately, into its own
 * stored key, so what the operator typed is what the record shows.
 */
function identifier(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`)
}

/** One product row: what it is, which model, and how many. */
const gatePassItemSchema = z.object({
  productName: z
    .string()
    .trim()
    .min(2, 'Product name must be at least 2 characters')
    .max(160, 'Product name must be 160 characters or fewer'),
  model: identifier(80, 'Model'),
  qty: z.coerce
    .number({ error: 'Quantity is required' })
    .int('Quantity must be a whole number')
    .min(1, 'Quantity must be at least 1')
    .max(100000, 'Quantity looks too large. Check the challan.'),
})

export type GatePassItemInput = z.infer<typeof gatePassItemSchema>

/**
 * Everything a gate pass records about a trip. Shared by create and update:
 * the two differ in what they do with the result, not in what they accept.
 *
 * `status` is absent by construction, exactly as `role` is absent from the
 * user schemas. A gate pass moves through its lifecycle by way of the submit
 * and review endpoints, which check GATE_PASS_TRANSITIONS — never by a client
 * writing a status into a body.
 */
const gatePassFields = {
  tripDo: identifier(60, 'Trip DO'),
  tripDate,
  csd: identifier(24, 'CSD').transform((value) => value.toUpperCase()),
  unit: identifier(24, 'Unit').transform((value) => value.toUpperCase()),
  customerName: z
    .string()
    .trim()
    .min(2, 'Customer name must be at least 2 characters')
    .max(160, 'Customer name must be 160 characters or fewer'),
  vehicleNo: identifier(60, 'Vehicle number').refine(
    (value) => value.length >= 3,
    'Vehicle number must be at least 3 characters',
  ),
  /**
   * One line per product on the vehicle. A challan routinely carries several,
   * so this is an array even when there is only one — the shape does not
   * change with the contents.
   */
  items: z
    .array(gatePassItemSchema)
    .min(1, 'Add at least one product')
    .max(MAX_GATE_PASS_ITEMS, `A gate pass can carry at most ${MAX_GATE_PASS_ITEMS} products`),

  /**
   * The reference is one of two things or neither, never an ambiguous blend.
   * The value is validated against the type below, so a body claiming
   * `referenceType: "Zone"` while carrying only a `po` is rejected rather than
   * silently half-stored.
   */
  referenceType: z.enum(GATE_PASS_REFERENCE_TYPES).default('None'),
  zone: z.string().trim().max(60, 'Zone must be 60 characters or fewer').default(''),
  po: z.string().trim().max(60, 'PO must be 60 characters or fewer').default(''),
}

/**
 * Cross-field rule for the reference pair. Kept as a check on the object
 * rather than inside a field, because it is a statement about two fields at
 * once — and it reports against the field the operator would go and fix.
 */
function checkReference(
  value: { referenceType: string; zone: string; po: string },
  ctx: z.RefinementCtx,
): void {
  if (value.referenceType === 'Zone' && value.zone.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['zone'], message: 'Enter the zone.' })
  }

  if (value.referenceType === 'PO' && value.po.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['po'], message: 'Enter the PO number.' })
  }
}

export const createGatePassSchema = z.object(gatePassFields).superRefine(checkReference)
export const updateGatePassSchema = z.object(gatePassFields).superRefine(checkReference)

export type CreateGatePassInput = z.infer<typeof createGatePassSchema>
export type UpdateGatePassInput = z.infer<typeof updateGatePassSchema>

/**
 * Submitting is a claim that the record is real and complete, so the server
 * checks for a possible duplicate before accepting it. `acknowledgeDuplicate`
 * is the operator answering "yes, I have looked at the existing record and
 * this is a different trip" — the client cannot skip the check, only answer it.
 */
export const submitGatePassSchema = z.object({
  acknowledgeDuplicate: z.boolean().default(false),
})

export type SubmitGatePassInput = z.infer<typeof submitGatePassSchema>

/**
 * The reviewer's decision. One endpoint serves all three outcomes because each
 * is a move to a target status; which moves are legal is decided by
 * GATE_PASS_TRANSITIONS, not by the client.
 */
export const reviewGatePassSchema = z
  .object({
    status: z.enum(['Verified', 'Rejected', 'Cancelled']),
    note: z.string().trim().max(400, 'Note must be 400 characters or fewer').default(''),
  })
  .superRefine((value, ctx) => {
    // A rejection the operator cannot act on is worse than no rejection: they
    // resubmit the same record and it is refused again.
    if (value.status === 'Rejected' && value.note.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'Say what needs correcting.' })
    }
  })

export type ReviewGatePassInput = z.infer<typeof reviewGatePassSchema>

/**
 * The records list is server-filtered and server-paginated: M0 has no headroom
 * for shipping the collection to the browser and filtering it there. `limit`
 * is capped so a crafted query cannot ask for everything.
 */
export const listGatePassesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(120).default(''),
    status: z.enum(['all', ...GATE_PASS_STATUSES]).default('all'),
    csd: z.string().trim().max(24).default(''),
    unit: z.string().trim().max(24).default(''),
    product: z.string().trim().max(160).default(''),
    referenceType: z.enum(['all', ...GATE_PASS_REFERENCE_TYPES]).default('all'),
    /** Matches whichever of zone or po the record actually carries. */
    reference: z.string().trim().max(60).default(''),
    /** An operator's own records; any other id is an Admin or Manager view. */
    createdBy: z.union([objectId, z.literal('')]).default(''),
    from: z.string().trim().regex(DATE_ONLY, 'Invalid start date.').or(z.literal('')).default(''),
    to: z.string().trim().regex(DATE_ONLY, 'Invalid end date.').or(z.literal('')).default(''),
  })
  .refine(
    // ISO dates compare correctly as strings, which is what makes this a
    // one-line check rather than two Date allocations.
    (value) => !value.from || !value.to || value.from <= value.to,
    { path: ['to'], message: 'The end date is before the start date.' },
  )

export type ListGatePassesQuery = z.infer<typeof listGatePassesQuerySchema>

/**
 * The duplicate probe the New Gate Pass workspace runs before it submits. It
 * takes the candidate values rather than a record id, because at that point
 * there may be nothing saved yet.
 */
export const duplicateQuerySchema = z.object({
  tripDo: z.string().trim().max(60).default(''),
  tripDate: z.string().trim().regex(DATE_ONLY, 'Invalid date.').or(z.literal('')).default(''),
  vehicleNo: z.string().trim().max(60).default(''),
  model: z.string().trim().max(80).default(''),
  /** The record being edited, which must never match itself. */
  excludeId: z.union([objectId, z.literal('')]).default(''),
})

export type DuplicateQuery = z.infer<typeof duplicateQuerySchema>

/**
 * Fields the entry form can offer type-ahead for.
 *
 * A closed set on purpose: this endpoint reads distinct values straight out of
 * the collection, so an open field name would let a caller enumerate any
 * column it liked.
 */
export const SUGGESTION_FIELDS = ['customerName', 'vehicleNo', 'productName', 'model'] as const
export type SuggestionField = (typeof SUGGESTION_FIELDS)[number]

export const suggestionQuerySchema = z.object({
  field: z.enum(SUGGESTION_FIELDS),
  /**
   * What has been typed so far. Two characters minimum — a one-letter prefix
   * matches most of the collection and is no help to anyone.
   */
  q: z.string().trim().min(2, 'Type at least two characters').max(120),
})

export type SuggestionQuery = z.infer<typeof suggestionQuerySchema>
