import * as z from 'zod'
import {
  CHALLAN_STATUSES,
  MAX_CHALLAN_PAGES,
  MAX_CHALLAN_ITEMS,
  MAX_CHALLAN_PAGE_SIZE,
  MAX_SOURCE_PAGES,
  normalizeMobile,
} from './challan.constants'

/** Mongo ObjectId as it arrives in a URL. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const challanIdParamSchema = z.object({ id: objectId })
export const batchIdParamSchema = z.object({ id: objectId })

/**
 * A submission arrives as multipart, because it carries the extracted challan
 * pages alongside the values. Every field is therefore a string on the way in,
 * including the numbers and the booleans — which is why the numeric fields
 * below coerce and the flag is parsed rather than trusted.
 */
function text(min: number, max: number, label: string) {
  return z
    .string()
    .trim()
    .min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
    .max(max, `${label} must be ${max} characters or fewer`)
}

function optionalText(max: number, label: string) {
  return z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .default('')
}

/**
 * A contact number, normalised on the way in.
 *
 * `+8801712345678`, `8801712345678` and `01712-345678` are one number written
 * three ways, and a record that cannot tell is a record nobody can search — so
 * the recognised forms are reduced to the eleven-digit local one. Anything
 * unrecognised is kept rather than refused: a depot landline is a legitimate
 * value on a challan, and guessing at it would be worse than storing it.
 */
function mobile(label: string) {
  return z
    .string()
    .trim()
    .transform(normalizeMobile)
    .refine(
      (value) => /^01\d{9}$/.test(value) || /^[\d+\-() ]{6,20}$/.test(value),
      `Enter a valid ${label.toLowerCase()}, for example 01712345678.`,
    )
}

/**
 * An array that may arrive as JSON text.
 *
 * A challan submission is multipart, because it carries the extracted pages,
 * and a multipart body has no notion of an array — every field is a string. So
 * the product rows travel as a JSON string and are unpacked here, before the
 * row schema below ever sees them. A PATCH sends real JSON and its array
 * arrives as an array, which is why both are accepted.
 */
const jsonArray = z.union([z.array(z.unknown()), z.string()]).transform((value, ctx) => {
  if (Array.isArray(value)) {
    return value
  }

  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // Falls through to the issue below: an unreadable field is a bad request,
    // not something to guess at.
  }

  ctx.addIssue({ code: 'custom', message: 'The product rows could not be read.' })
  return z.NEVER
})

/** One product row: what it is, which model, and how many. */
const challanItemSchema = z.object({
  productName: text(2, 200, 'Product'),
  model: text(1, 120, 'Model'),
  qty: z.coerce
    .number({ error: 'Quantity is required' })
    .int('Quantity must be a whole number')
    .min(1, 'Quantity must be at least 1')
    .max(100000, 'Quantity looks too large. Check the challan.'),
})

export type ChallanItemInput = z.infer<typeof challanItemSchema>

/**
 * The values transcribed off the challan, plus the two optional ones.
 *
 * Shared by submit and correct: the two differ entirely in what they do with
 * the result — one creates a record and a document, the other rewrites both —
 * and not at all in what a challan is allowed to say.
 *
 * There is deliberately no `slNumber`, no `challanNumber`, no `status` and no
 * `batchId` here, in exactly the way `syncUserSchema` has no `role`. Those are
 * the server's to decide, and a field absent from the schema is one a crafted
 * request body cannot set.
 */
const challanFields = {
  customerName: text(2, 200, 'Customer name'),
  deliveryAddress: text(3, 500, 'Delivery address'),
  thana: text(1, 120, 'Thana'),
  district: text(1, 120, 'District'),
  receiverMobile: mobile('Receiver mobile'),
  /** Optional: many challans carry only the receiver's number. */
  senderMobile: optionalText(40, 'Sender mobile'),
  /**
   * One free-text field rather than Gate Pass's discriminated zone/PO pair,
   * because a Walton challan prints it as a single "Zone/PO" cell. Splitting a
   * value nobody separated on paper would mean guessing which half is which.
   */
  zonePo: optionalText(120, 'Zone / PO'),
  /**
   * One row per product on the challan. A Walton challan routinely lists
   * several, so this is an array even when there is only one — the shape does
   * not change with the contents.
   *
   * A submission is multipart, and multipart has no arrays: the browser sends
   * this as a JSON string in one field, which is what `jsonArray` unpacks. The
   * alternative — `items[0][model]`-style keys — would put a parser nobody
   * asked for between the form and the schema.
   */
  items: jsonArray
    .pipe(
      z
        .array(challanItemSchema)
        .min(1, 'Add at least one product')
        .max(MAX_CHALLAN_ITEMS, `A challan can carry at most ${MAX_CHALLAN_ITEMS} products`),
    ),
}

const pageNumber = (label: string) =>
  z.coerce
    .number({ error: `${label} is required` })
    .int(`${label} must be a whole number`)
    .min(1, `${label} starts at 1`)
    .max(MAX_SOURCE_PAGES, `${label} is beyond the largest source PDF this workspace handles`)

/**
 * Where in the source PDF this challan came from.
 *
 * `sourcePageCount` is the browser's report about a file this API never
 * receives, so it bounds the range rather than proving it. What the server
 * actually proves is stronger: the uploaded extract must carry exactly
 * `endPage - startPage + 1` pages, and no other challan in the batch may
 * already claim any of them.
 */
const sourceFields = {
  /**
   * Identifies the workspace session, so the second challan out of one PDF
   * joins the batch the first one created. Generated in the browser; scoped to
   * its owner server-side, so it can never attach a record to somebody else's
   * batch.
   */
  sessionKey: z
    .string()
    .trim()
    .min(8, 'Invalid workspace session.')
    .max(64, 'Invalid workspace session.')
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid workspace session.'),
  sourceFileName: text(1, 260, 'Source file name'),
  sourcePageCount: z.coerce
    .number({ error: 'The source page count is required' })
    .int()
    .min(1, 'The source PDF has no pages.')
    .max(MAX_SOURCE_PAGES, `This workspace handles source PDFs up to ${MAX_SOURCE_PAGES} pages.`),
  sourcePageStart: pageNumber('The first page'),
  sourcePageEnd: pageNumber('The last page'),
}

/** Multipart sends `true`/`false` as text; anything else is not a yes. */
const flag = z
  .union([z.boolean(), z.string()])
  .default(false)
  .transform((value) => value === true || value === 'true' || value === '1')

function checkPageRange(
  value: { sourcePageStart: number; sourcePageEnd: number; sourcePageCount: number },
  ctx: z.RefinementCtx,
): void {
  if (value.sourcePageEnd < value.sourcePageStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourcePageEnd'],
      message: 'The last page comes before the first page.',
    })
    return
  }

  if (value.sourcePageEnd > value.sourcePageCount) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourcePageEnd'],
      message: `The source PDF ends at page ${value.sourcePageCount}.`,
    })
  }

  const pages = value.sourcePageEnd - value.sourcePageStart + 1
  if (pages > MAX_CHALLAN_PAGES) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourcePageEnd'],
      message: `That is ${pages} pages for one challan. The limit is ${MAX_CHALLAN_PAGES}.`,
    })
  }
}

/**
 * Filing one challan.
 *
 * This is the only endpoint that creates anything permanent in the module, and
 * it does so in one call carrying everything at once — the values, where they
 * came from, and the extracted pages. There is no earlier call that reserved a
 * record, because there is no state before this point worth reserving.
 */
export const submitChallanSchema = z
  .object({
    ...challanFields,
    ...sourceFields,
    /**
     * The browser's idempotency key for this entry. Sent rather than derived,
     * because the server has nothing to derive it from: two identical challans
     * for a split delivery are legitimate, so the values cannot be the key.
     */
    submissionKey: z
      .string()
      .trim()
      .min(8, 'Invalid submission key.')
      .max(64, 'Invalid submission key.')
      .regex(/^[A-Za-z0-9_-]+$/, 'Invalid submission key.'),
    /** The operator answering the possible-duplicate question. */
    acknowledgeDuplicate: flag,
  })
  .superRefine(checkPageRange)

export type SubmitChallanInput = z.infer<typeof submitChallanSchema>

/**
 * Correcting a filed challan.
 *
 * The values only. Where it came from in a source PDF is a historical fact
 * about a file that no longer exists, so it is not editable — and the pages
 * themselves are already stored, so a correction never needs them resent.
 */
export const updateChallanSchema = z.object(challanFields)

export type UpdateChallanInput = z.infer<typeof updateChallanSchema>

/**
 * What narrows the challan list. Shared by the paged list and any read that
 * has to describe the same set, so the two cannot drift.
 */
const challanFilterFields = {
  search: z.string().trim().max(160).default(''),
  status: z.enum(['all', ...CHALLAN_STATUSES]).default('all'),
  district: z.string().trim().max(120).default(''),
  customer: z.string().trim().max(200).default(''),
  product: z.string().trim().max(200).default(''),
  model: z.string().trim().max(120).default(''),
  zonePo: z.string().trim().max(120).default(''),
  batchId: z.union([objectId, z.literal('')]).default(''),
  createdBy: z.union([objectId, z.literal('')]).default(''),
  from: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'Invalid start date.')
    .or(z.literal(''))
    .default(''),
  to: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'Invalid end date.')
    .or(z.literal(''))
    .default(''),
}

/** ISO dates compare correctly as strings, so this is one check, not two Dates. */
function checkDateOrder(value: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date is before the start date.' })
  }
}

/**
 * Server-filtered and server-paged, like every other list in this API: on the
 * M0 free tier, shipping the collection to the browser to filter it there is
 * the one query that would take the cluster down.
 */
export const listChallansQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_CHALLAN_PAGE_SIZE).default(10),
    ...challanFilterFields,
  })
  .superRefine(checkDateOrder)

export type ListChallansQuery = z.infer<typeof listChallansQuerySchema>

export const listBatchesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_CHALLAN_PAGE_SIZE).default(10),
  status: z.enum(['all', 'Processing', 'Completed']).default('all'),
  search: z.string().trim().max(260).default(''),
})

export type ListBatchesQuery = z.infer<typeof listBatchesQuerySchema>

/**
 * The duplicate probe the workspace runs before it submits. It takes candidate
 * values rather than a record id, because at that point there is nothing
 * saved to point at.
 */
export const duplicateQuerySchema = z.object({
  sessionKey: z.string().trim().max(64).default(''),
  customerName: z.string().trim().max(200).default(''),
  receiverMobile: z.string().trim().max(40).default(''),
  model: z.string().trim().max(120).default(''),
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
export const CHALLAN_SUGGESTION_FIELDS = [
  'customerName',
  'thana',
  'district',
  'product',
  'model',
  'zonePo',
] as const
export type ChallanSuggestionField = (typeof CHALLAN_SUGGESTION_FIELDS)[number]

export const suggestionQuerySchema = z.object({
  field: z.enum(CHALLAN_SUGGESTION_FIELDS),
  /** Two characters minimum — a one-letter prefix matches most of a column. */
  q: z.string().trim().min(2, 'Type at least two characters').max(160),
})

export type ChallanSuggestionQuery = z.infer<typeof suggestionQuerySchema>

/**
 * Which pages of a source PDF are not challans.
 *
 * The whole list, every time: replacing rather than adding makes the call
 * idempotent, and makes undo the same request with one page removed. An empty
 * array is a legitimate body — it means nothing in this file is blank after
 * all.
 */
export const skippedPagesSchema = z.object({
  pages: z
    .array(z.coerce.number().int().min(1).max(MAX_SOURCE_PAGES))
    .max(MAX_SOURCE_PAGES, 'That is more pages than a source PDF can have.'),
})

export type SkippedPagesInput = z.infer<typeof skippedPagesSchema>

/**
 * Asking the server to check a page range before anything is submitted.
 *
 * The workspace can check overlaps inside its own session on its own, but not
 * against a challan somebody filed from the same PDF an hour ago — only the
 * collection knows that.
 */
export const pageRangeQuerySchema = z
  .object({
    sessionKey: sourceFields.sessionKey,
    sourcePageCount: sourceFields.sourcePageCount,
    sourcePageStart: sourceFields.sourcePageStart,
    sourcePageEnd: sourceFields.sourcePageEnd,
  })
  .superRefine(checkPageRange)

export type PageRangeQuery = z.infer<typeof pageRangeQuerySchema>
