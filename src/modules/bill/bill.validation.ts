import * as z from 'zod'
import { BILL_STATUSES, MAX_BILL_PAGE_SIZE, MAX_BILL_ROWS_PER_CHANGE } from './bill.constants'

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const billIdParamSchema = z.object({ id: objectId })

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

/** The unit as a gate pass writes it — letters, digits and the odd separator. */
const unit = z
  .string({ error: 'Enter the unit.' })
  .trim()
  .min(1, 'Enter the unit.')
  .max(24, 'A unit is at most 24 characters.')
  .regex(/[A-Za-z0-9]/, 'Enter the unit.')

const note = z.string().trim().max(400, 'Keep the note under 400 characters.')

/**
 * Opening a bill slot. There is no bill number, status or total in the body —
 * the number is allocated, the status starts `Draft`, and the totals are the
 * rows'.
 */
export const createBillSchema = z.object({
  month,
  year,
  unit,
  note: note.default(''),
})
export type CreateBillInput = z.infer<typeof createBillSchema>

export const updateBillSchema = z
  .object({ month: month.optional(), year: year.optional(), unit: unit.optional(), note: note.optional() })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'Nothing to change.')
export type UpdateBillInput = z.infer<typeof updateBillSchema>

/** An optional number in a query string, where an empty value means "any". */
const optionalNumber = <T extends z.ZodType<number>>(schema: T) =>
  z.preprocess((value) => (value === '' || value === undefined ? undefined : value), schema.optional())

export const listBillsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_BILL_PAGE_SIZE).default(12),
  search: z.string().trim().max(80).default(''),
  year: optionalNumber(z.coerce.number().int().min(2000).max(2100)),
  month: optionalNumber(z.coerce.number().int().min(1).max(12)),
  unit: z.string().trim().max(24).default(''),
  status: z.enum(['all', ...BILL_STATUSES]).default('all'),
})
export type ListBillsQuery = z.infer<typeof listBillsQuerySchema>

/** What somebody types to add rows: a Trip DO, or a gate pass number. Blank suggests the bill's month. */
export const billCandidatesQuerySchema = z.object({
  q: z.string().trim().max(60).default(''),
})
export type BillCandidatesQuery = z.infer<typeof billCandidatesQuerySchema>

const idList = (noun: string) =>
  z
    .array(objectId)
    .min(1, `Choose at least one ${noun}.`)
    .max(MAX_BILL_ROWS_PER_CHANGE, `Change at most ${MAX_BILL_ROWS_PER_CHANGE} ${noun}s at once.`)
    .refine((ids) => new Set(ids).size === ids.length, `A ${noun} is listed twice.`)

export const addBillLinesSchema = z.object({ rowIds: idList('row') })
export type AddBillLinesInput = z.infer<typeof addBillLinesSchema>

export const removeBillLinesSchema = z.object({ lineIds: idList('line') })
export type RemoveBillLinesInput = z.infer<typeof removeBillLinesSchema>
