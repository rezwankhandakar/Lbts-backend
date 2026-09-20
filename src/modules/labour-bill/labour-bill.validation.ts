import * as z from 'zod'
import {
  LABOUR_BILL_STATUSES,
  MAX_FLOOR_NUMBER,
  MAX_LABOUR_AMOUNT,
  MAX_LABOUR_BILL_PAGE_SIZE,
  MAX_LABOUR_BILL_ROWS_PER_CHANGE,
} from './labour-bill.constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const labourBillIdParamSchema = z.object({ id: objectId })
export const labourBillLineParamSchema = z.object({ id: objectId, lineId: objectId })

const month = z.coerce
  .number({ error: 'Choose a month.' })
  .int()
  .min(1, 'Choose a month.')
  .max(12, 'Choose a month.')

const year = z.coerce
  .number({ error: 'Choose a year.' })
  .int()
  .min(2020, 'That year is too early for a bill.')
  .max(2100, 'That year is too far ahead.')

/** The company the sheet's Unit column names. Free text: it is a name, not a code. */
const company = z.string().trim().max(60, 'Keep the company name under 60 characters.')

const note = z.string().trim().max(400, 'Keep the note under 400 characters.')

/**
 * Opening a slot. There is no bill number, status or total in the body — the
 * number is allocated, the status starts `Draft`, and every total is the rows'.
 */
export const createLabourBillSchema = z.object({
  month,
  year,
  company: company.default(''),
  note: note.default(''),
})
export type CreateLabourBillInput = z.infer<typeof createLabourBillSchema>

export const updateLabourBillSchema = z
  .object({
    month: month.optional(),
    year: year.optional(),
    company: company.optional(),
    note: note.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'Nothing to change.')
export type UpdateLabourBillInput = z.infer<typeof updateLabourBillSchema>

/** An optional number in a query string, where an empty value means "any". */
const optionalNumber = <T extends z.ZodType<number>>(schema: T) =>
  z.preprocess((value) => (value === '' || value === undefined ? undefined : value), schema.optional())

export const listLabourBillsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LABOUR_BILL_PAGE_SIZE).default(12),
  search: z.string().trim().max(80).default(''),
  year: optionalNumber(z.coerce.number().int().min(2000).max(2100)),
  month: optionalNumber(z.coerce.number().int().min(1).max(12)),
  status: z.enum(['all', ...LABOUR_BILL_STATUSES]).default('all'),
})
export type ListLabourBillsQuery = z.infer<typeof listLabourBillsQuerySchema>

/**
 * One barcode read, or the same number typed off a creased label. A challan
 * number or a bare SL, exactly as `findChallanByScan` reads it.
 */
export const scanLabourBillSchema = z.object({
  code: z
    .string({ error: 'Scan a challan, or type its number.' })
    .trim()
    .min(3, 'That is too short to be a challan number.')
    .max(40, 'That is too long to be a challan number.'),
})
export type ScanLabourBillInput = z.infer<typeof scanLabourBillSchema>

const idList = (noun: string) =>
  z
    .array(objectId)
    .min(1, `Choose at least one ${noun}.`)
    .max(MAX_LABOUR_BILL_ROWS_PER_CHANGE, `Change at most ${MAX_LABOUR_BILL_ROWS_PER_CHANGE} ${noun}s at once.`)
    .refine((ids) => new Set(ids).size === ids.length, `A ${noun} is listed twice.`)

export const removeLabourBillLinesSchema = z.object({ lineIds: idList('row') })
export type RemoveLabourBillLinesInput = z.infer<typeof removeLabourBillLinesSchema>

/**
 * An amount cell. `null` clears it back to "not typed", which is a different
 * statement from `0` — see `lineTotal` — so the schema keeps both and the two
 * are never collapsed.
 */
const amountCell = z
  .number({ error: 'Enter an amount in taka.' })
  .int('Amounts are whole taka.')
  .min(0, 'An amount cannot be negative.')
  .max(MAX_LABOUR_AMOUNT, 'That amount looks mistyped.')
  .nullable()

const floorCell = z
  .number({ error: 'Enter a floor number.' })
  .int('A floor is a whole number.')
  .min(0, 'The ground floor is 0.')
  .max(MAX_FLOOR_NUMBER, 'That floor number looks mistyped.')
  .nullable()

/**
 * Typing into a row. Only the three cells and the company: nothing here can
 * rewrite what was copied off the Trip DO sheet, for the reason a challan's
 * location cannot be typed — a copy that a request could edit would be a copy
 * nothing could trust.
 */
export const updateLabourBillLineSchema = z
  .object({
    company: company.optional(),
    labourAmount: amountCell.optional(),
    floorNo: floorCell.optional(),
    floorAmount: amountCell.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'Nothing to change.')
export type UpdateLabourBillLineInput = z.infer<typeof updateLabourBillLineSchema>

/**
 * Which signed copies to assemble: the whole bill, or one CSD section of it.
 *
 * The value is a section **key** — `comparisonKey` of the CSD, and the empty
 * string for the pending section — because that is what the sheet groups by,
 * and a raw CSD would leave the server guessing which spelling was meant. It
 * is deliberately allowed to be empty: a section of rows whose Trip DO is
 * unset still has paper behind it.
 */
export const signedCopiesQuerySchema = z.object({
  csd: z
    .string()
    .max(40, 'That is not a CSD section.')
    .regex(/^[A-Z0-9]*$/, 'That is not a CSD section.')
    .optional(),
})
export type SignedCopiesQuery = z.infer<typeof signedCopiesQuerySchema>
