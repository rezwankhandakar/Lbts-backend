import * as z from 'zod'
import {
  MAX_BULK_LINK_ROWS,
  MAX_SPLIT_PARTS,
  MAX_TRIP_DO_PAGE_SIZE,
} from './trip-do.constants'
import { columnFiltersParam } from '../../utils/column-filters'
import { TRIP_DO_COLUMN_IDS } from './trip-do.columns'

/** Mongo ObjectId as it arrives in a URL or a body. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const tripDoRowIdParamSchema = z.object({ id: objectId })
export const gatePassIdParamSchema = z.object({ id: objectId })

const calendarDay = z
  .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')])
  .default('')

/** The column dropdowns' ticked values — see `columnFiltersParam`. */
const columnFilters = columnFiltersParam(TRIP_DO_COLUMN_IDS)

/**
 * What narrows the sheet. One object used by both the list and the export, so
 * a downloaded file can never describe a set of rows nobody was looking at —
 * the arrangement `gatePassFilterFields` has.
 */
export const tripDoFilterFields = {
  search: z.string().trim().max(160).default(''),
  kind: z.enum(['all', 'Order', 'Return', 'Resent']).default('all'),
  link: z.enum(['all', 'linked', 'unlinked']).default('all'),
  from: calendarDay,
  to: calendarDay,
  columns: columnFilters,
}

export const exportTripDoQuerySchema = z.object(tripDoFilterFields)
export type TripDoFilterQuery = z.infer<typeof exportTripDoQuerySchema>

export const listTripDoQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_TRIP_DO_PAGE_SIZE).default(50),
  ...tripDoFilterFields,
})
export type ListTripDoQuery = z.infer<typeof listTripDoQuerySchema>

/**
 * The values one column's dropdown offers, under every other filter in use —
 * the column's own ticks aside, or unticking one would make it vanish.
 */
export const columnValuesQuerySchema = z.object({
  column: z.enum(TRIP_DO_COLUMN_IDS),
  ...tripDoFilterFields,
})
export type ColumnValuesQuery = z.infer<typeof columnValuesQuerySchema>

/** What somebody types into the Trip DO picker: a DO, a gate pass number or a plate. */
export const gatePassOptionsQuerySchema = z.object({
  q: z.string().trim().max(60).default(''),
})
export type GatePassOptionsQuery = z.infer<typeof gatePassOptionsQuerySchema>

const pieces = z.coerce
  .number({ error: 'Enter a quantity.' })
  .int('That has to be a whole number of pieces.')
  .min(1, 'A part needs at least one piece.')
  .max(100_000, 'That quantity looks too large.')

/**
 * Setting a Trip DO on one row.
 *
 * `qty` is optional and is the split: linking three of a row of five links the
 * three and leaves the other two as a row of their own. Absent, the whole row
 * is linked. There is no CSD, unit or Trip DO text in the body — every one of
 * those is read off the gate pass the id points at, the rule `locationId` on a
 * challan follows.
 */
/**
 * Which line on the gate pass, by its model key, as the picker offered it.
 * Optional: absent, the server takes the line whose model is the row's own, or
 * the one close line when there is exactly one.
 */
const lineKey = z.string().trim().max(160).optional()

export const linkRowSchema = z.object({
  gatePassId: objectId,
  lineKey,
  qty: pieces.optional(),
})
export type LinkRowInput = z.infer<typeof linkRowSchema>

export const bulkLinkSchema = z.object({
  gatePassId: objectId,
  lineKey,
  rowIds: z
    .array(objectId)
    .min(1, 'Choose at least one row.')
    .max(MAX_BULK_LINK_ROWS, `Link at most ${MAX_BULK_LINK_ROWS} rows at once.`)
    .refine((ids) => new Set(ids).size === ids.length, 'A row is listed twice.'),
})
export type BulkLinkInput = z.infer<typeof bulkLinkSchema>

/** Dividing a row into parts. They must add up to the row; the service checks. */
export const splitRowSchema = z.object({
  parts: z
    .array(pieces)
    .min(2, 'A split needs at least two parts.')
    .max(MAX_SPLIT_PARTS, `Split into at most ${MAX_SPLIT_PARTS} parts.`),
})
export type SplitRowInput = z.infer<typeof splitRowSchema>
