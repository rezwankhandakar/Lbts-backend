import type { PipelineStage } from 'mongoose'
import * as z from 'zod'

/**
 * The server half of a spreadsheet-style column filter: a dropdown of every
 * value in a column, `(Blanks)` among them, with tick boxes.
 *
 * Shared by every sheet that has one — the Trip DO sheet and the gate pass
 * records — because "what counts as blank", "how ticked values travel" and
 * "how a column's values are listed" must mean the same thing on both. What a
 * column *is* stays in each module's own `*.columns.ts`.
 */

/** A ticked value. `null` is `(Blanks)`: null, empty and missing alike. */
export type ColumnValue = string | number | null

export type Clause = Record<string, unknown>

/** Distinct values one dropdown lists before it says the list is cut short. */
export const MAX_COLUMN_VALUES = 1000

/** Matches no document: every ticked value was unreadable, and "everything" would be a lie. */
export const MATCH_NOTHING: Clause = { _id: { $exists: false } }

export interface ColumnValuesResult {
  values: { value: ColumnValue; count: number }[]
  /** More distinct values exist than one dropdown lists. */
  truncated: boolean
}

export function isBlankValue(value: ColumnValue): boolean {
  return value === null || value === ''
}

export function sameColumnValue(a: ColumnValue, b: ColumnValue): boolean {
  return (isBlankValue(a) && isBlankValue(b)) || a === b
}

export function anyOf(clauses: Clause[]): Clause {
  return clauses.length === 1 ? clauses[0] : { $or: clauses }
}

/**
 * Ticked values of one stored field, or null for no filter. `$in: [null]` also
 * matches a missing field, which is what a blank usually is.
 */
export function valuesInClause(path: string, values: readonly ColumnValue[]): Clause | null {
  if (values.length === 0) {
    return null
  }
  const real = values.filter((value) => !isBlankValue(value))
  const clauses: Clause[] = []
  if (real.length > 0) clauses.push({ [path]: { $in: real } })
  if (real.length < values.length) clauses.push({ [path]: { $in: [null, ''] } })
  return anyOf(clauses)
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Ticked `YYYY-MM-DD` days as whole UTC days on a date field. Unreadable ones are skipped. */
export function dayClauses(path: string, values: readonly ColumnValue[]): Clause[] {
  const clauses: Clause[] = []
  for (const value of values) {
    if (typeof value === 'string' && DAY_PATTERN.test(value)) {
      const start = new Date(`${value}T00:00:00.000Z`)
      clauses.push({ [path]: { $gte: start, $lt: new Date(start.getTime() + 86_400_000) } })
    }
  }
  return clauses
}

/** A column's `$day` value, as `dayClauses` reads one. */
export function dayExpression(path: string) {
  return { $dateToString: { format: '%Y-%m-%d', date: `$${path}` } }
}

/** After a `$match`: one group per distinct value, blanks as null, sorted, capped. */
export function distinctValueStages(value: unknown): PipelineStage[] {
  return [
    {
      $group: {
        _id: { $cond: [{ $in: [{ $ifNull: [value, null] }, [null, '']] }, null, value] },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: MAX_COLUMN_VALUES + 1 },
  ] as PipelineStage[]
}

export function toColumnValuesResult(rows: { _id: ColumnValue; count: number }[]): ColumnValuesResult {
  return {
    values: rows.slice(0, MAX_COLUMN_VALUES).map((row) => ({ value: row._id, count: row.count })),
    truncated: rows.length > MAX_COLUMN_VALUES,
  }
}

/** Blanks first, then numbers in order, then text — the order `$sort` gives. */
export function compareColumnValues(a: ColumnValue, b: ColumnValue): number {
  if (isBlankValue(a) || isBlankValue(b)) {
    return Number(!isBlankValue(a)) - Number(!isBlankValue(b))
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  return String(a).localeCompare(String(b))
}

/**
 * Ticked values by column, as one JSON query parameter:
 * `{"customer":["Arif",null],"qty":[4]}`. JSON rather than repeated parameters,
 * because a ticked value is a string, a number or a blank, and a query string
 * can only say "string".
 */
export function columnFiltersParam<const T extends readonly [string, ...string[]]>(ids: T) {
  return z
    .string()
    .max(40_000, 'Too many column filters at once.')
    .default('{}')
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Column filters are not valid JSON.' })
        return z.NEVER
      }
    })
    .pipe(
      z.partialRecord(
        z.enum(ids),
        z.array(z.union([z.string().max(300), z.number(), z.null()])).max(MAX_COLUMN_VALUES),
      ),
    )
}
