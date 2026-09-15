import type { PipelineStage } from 'mongoose'
import {
  MATCH_NOTHING,
  anyOf,
  dayClauses,
  dayExpression,
  distinctValueStages,
  isBlankValue,
  sameColumnValue,
  valuesInClause,
} from '../../utils/column-filters'
import type { Clause, ColumnValue } from '../../utils/column-filters'

/**
 * The gate pass records sheet's column filters. `utils/column-filters.ts` owns
 * what a blank is and how ticks travel; this file owns what each column of
 * this sheet is.
 *
 * **The sheet is one row per product line, and the filters respect that.**
 * Trip DO, date, CSD, unit, vehicle, customer and status belong to the gate
 * pass; product, model, quantity and delivery status belong to one line. A
 * gate pass is kept when a *single* line satisfies every line filter at once —
 * "Refrigerator" and "4" means a line of four refrigerators, not a gate pass
 * with some refrigerator and some line of four — and the sheet then draws only
 * the lines that do.
 *
 * Delivery status is not stored on a gate pass; it is read off the Trip DO
 * links (`deliveryByGatePassLine`), so filtering by it is worked out in memory
 * over a capped set rather than by the database. `lineMatchesColumns` is that
 * predicate, and `lineConditions` is the same rule for the database-answerable
 * part.
 *
 * The frontend mirrors the ids at `features/gate-pass/types/index.ts`.
 */

export const GATE_PASS_COLUMN_IDS = [
  'tripDo',
  'tripDate',
  'delivery',
  'csd',
  'unit',
  'vehicle',
  'customer',
  'product',
  'model',
  'qty',
  'status',
] as const
export type GatePassColumnId = (typeof GATE_PASS_COLUMN_IDS)[number]

export type GatePassColumnFilters = Partial<Record<GatePassColumnId, ColumnValue[]>>

/** Columns that are one field on the gate pass itself. */
const RECORD_FIELDS = {
  tripDo: 'tripDo',
  csd: 'csd',
  unit: 'unit',
  vehicle: 'vehicleNo',
  customer: 'customerName',
  status: 'status',
} as const
type RecordColumn = keyof typeof RECORD_FIELDS

/** Columns that are one field on a product line. */
const LINE_FIELDS = { product: 'productName', model: 'productModel', qty: 'qty' } as const
type LineColumn = keyof typeof LINE_FIELDS

export function isRecordColumn(column: GatePassColumnId): column is RecordColumn {
  return column in RECORD_FIELDS
}

function isLineColumn(column: GatePassColumnId): column is LineColumn {
  return column in LINE_FIELDS
}

/** The gate pass-level filters, as query clauses to `$and` with the rest. */
export function recordFilterClauses(columns: GatePassColumnFilters): Clause[] {
  const clauses: Clause[] = []

  for (const [column, field] of Object.entries(RECORD_FIELDS) as [RecordColumn, string][]) {
    const clause = valuesInClause(field, columns[column] ?? [])
    if (clause) clauses.push(clause)
  }

  const days = columns.tripDate ?? []
  if (days.length > 0) {
    const ranges = dayClauses('tripDate', days)
    clauses.push(ranges.length > 0 ? anyOf(ranges) : MATCH_NOTHING)
  }

  return clauses
}

/**
 * The database-answerable line filters, as the conditions one line must meet —
 * for `$elemMatch` on `items`, or prefixed with `items.` after an `$unwind`.
 * Null when no line column is filtered.
 */
export function lineConditions(columns: GatePassColumnFilters, prefix = ''): Clause | null {
  const conditions: Clause = {}

  for (const [column, field] of Object.entries(LINE_FIELDS) as [LineColumn, string][]) {
    const values = columns[column] ?? []
    if (values.length === 0) continue
    const real = values.filter((value) => !isBlankValue(value))
    conditions[`${prefix}${field}`] = {
      $in: real.length < values.length ? [...real, null, ''] : real,
    }
  }

  return Object.keys(conditions).length > 0 ? conditions : null
}

export function hasDeliveryFilter(columns: GatePassColumnFilters): boolean {
  return (columns.delivery?.length ?? 0) > 0
}

export interface GatePassLineState {
  productName: string
  productModel: string
  qty: number
}

export interface GatePassRecordState {
  tripDo: string
  tripDate: Date
  csd: string
  unit: string
  vehicleNo: string
  customerName: string
  status: string
}

/** Whether one line meets every line filter — delivery status included. */
export function lineMatchesColumns(
  line: GatePassLineState,
  deliveryStatus: string,
  columns: GatePassColumnFilters,
): boolean {
  const checks: [GatePassColumnId, ColumnValue][] = [
    ['product', line.productName],
    ['model', line.productModel],
    ['qty', line.qty],
    ['delivery', deliveryStatus],
  ]

  return checks.every(([column, value]) => {
    const ticked = columns[column]
    return !ticked || ticked.length === 0 || ticked.some((entry) => sameColumnValue(entry, value))
  })
}

function orBlank(value: string | null | undefined): ColumnValue {
  return value ? value : null
}

/** What one row of the sheet — a gate pass and one of its lines — shows in a column. */
export function gatePassColumnValue(
  column: GatePassColumnId,
  record: GatePassRecordState,
  line: GatePassLineState,
  deliveryStatus: string,
): ColumnValue {
  if (column === 'tripDate') return record.tripDate.toISOString().slice(0, 10)
  if (column === 'delivery') return deliveryStatus
  if (column === 'qty') return line.qty
  if (isLineColumn(column)) return orBlank(line[LINE_FIELDS[column]])
  return orBlank(record[RECORD_FIELDS[column]])
}

/**
 * After the gate pass `$match`: one group per distinct value, counted in sheet
 * rows — lines — and over only the lines the other line filters keep. Not for
 * the delivery column, which the database cannot see.
 */
export function gatePassColumnValuesStages(
  column: GatePassColumnId,
  columns: GatePassColumnFilters,
): PipelineStage[] {
  const conditions = lineConditions(columns, 'items.')
  const value =
    column === 'tripDate'
      ? dayExpression('tripDate')
      : isRecordColumn(column)
        ? `$${RECORD_FIELDS[column]}`
        : `$items.${LINE_FIELDS[column as LineColumn]}`

  return [
    { $unwind: '$items' },
    ...((conditions ? [{ $match: conditions }] : []) as PipelineStage[]),
    ...distinctValueStages(value),
  ]
}
