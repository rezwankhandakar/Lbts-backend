import type { PipelineStage } from 'mongoose'
import {
  MATCH_NOTHING,
  MAX_COLUMN_VALUES,
  anyOf,
  dayClauses,
  dayExpression,
  distinctValueStages,
  isBlankValue,
  valuesInClause,
} from '../../utils/column-filters'
import type { Clause, ColumnValue } from '../../utils/column-filters'

export { MAX_COLUMN_VALUES }
export type { ColumnValue }

/**
 * The Trip DO sheet's column filters. `utils/column-filters.ts` owns what a
 * blank is and how ticks travel; this file owns what each column of this sheet
 * is, in both directions — which distinct values it holds
 * (`columnValuesStages`) and which rows a set of ticks keeps
 * (`columnFilterClause`).
 *
 * The frontend mirrors the ids at `features/trip-do/types/index.ts`. Change
 * one, change both.
 */

export const TRIP_DO_COLUMN_IDS = [
  'sl',
  'date',
  'trip',
  'status',
  'customer',
  'address',
  'district',
  'thana',
  'location',
  'receiver',
  'zone',
  'product',
  'model',
  'qty',
  'rate',
  'amount',
  'capacity',
  'csd',
  'unit',
  'bill',
  'tripDo',
] as const
export type TripDoColumnId = (typeof TRIP_DO_COLUMN_IDS)[number]

export type ColumnFilters = Partial<Record<TripDoColumnId, ColumnValue[]>>

/** Columns that are one stored field, filtered by an ordinary indexed query. */
const PATHS: Partial<Record<TripDoColumnId, string>> = {
  sl: 'slNumber',
  status: 'deliveryStatus',
  customer: 'customerName',
  address: 'deliveryAddress',
  district: 'district',
  thana: 'thana',
  location: 'locationType',
  receiver: 'receiverMobile',
  zone: 'zonePo',
  product: 'productName',
  model: 'productModel',
  qty: 'qty',
  capacity: 'capacity',
  csd: 'link.csd',
  unit: 'link.unit',
  /** The bill number; a blank is a row on no bill. */
  bill: 'bill.billNumber',
  tripDo: 'link.tripDo',
}

/** The row's share of its line, as `rowAmountFor` works it; null when nothing priced it. */
const AMOUNT = {
  $cond: [
    { $and: [{ $isNumber: '$lineAmount' }, { $gt: ['$lineQty', 0] }] },
    { $round: [{ $divide: [{ $multiply: ['$lineAmount', '$qty'] }, '$lineQty'] }, 2] },
    null,
  ],
}

/**
 * A rate as one comparable value: `flat:1100`, or `tiered:5:60:24` for "the
 * first five at 60, then 24". `parseRateKey` reads it back.
 */
const RATE_KEY = {
  $switch: {
    branches: [
      {
        case: { $eq: ['$rate.kind', 'flat'] },
        then: { $concat: ['flat:', { $toString: '$rate.unitAmount' }] },
      },
      {
        case: { $eq: ['$rate.kind', 'tiered'] },
        then: {
          $concat: [
            'tiered:',
            { $toString: '$rate.firstQty' },
            ':',
            { $toString: '$rate.firstAmount' },
            ':',
            { $toString: '$rate.restAmount' },
          ],
        },
      },
    ],
    default: null,
  },
}

export function parseRateKey(key: string): Clause | null {
  const [kind, ...rest] = key.split(':')
  const numbers = rest.map(Number)
  if (!numbers.every((value) => Number.isFinite(value))) {
    return null
  }
  if (kind === 'flat' && numbers.length === 1) {
    return { 'rate.kind': 'flat', 'rate.unitAmount': numbers[0] }
  }
  if (kind === 'tiered' && numbers.length === 3) {
    return {
      'rate.kind': 'tiered',
      'rate.firstQty': numbers[0],
      'rate.firstAmount': numbers[1],
      'rate.restAmount': numbers[2],
    }
  }
  return null
}

/**
 * The rows a column's ticked values keep, or null for no filter at all. An
 * empty list is no filter: a dropdown with nothing ticked is never applied.
 */
export function columnFilterClause(column: TripDoColumnId, values: readonly ColumnValue[]): Clause | null {
  if (values.length === 0) {
    return null
  }

  const path = PATHS[column]
  if (path) {
    return valuesInClause(path, values)
  }

  const blank = values.some(isBlankValue)
  const real = values.filter((value) => !isBlankValue(value))
  const clauses: Clause[] = []

  switch (column) {
    case 'trip':
      if (real.length > 0) clauses.push({ tripNumbers: { $in: real } })
      if (blank) clauses.push({ tripNumbers: { $size: 0 } })
      break
    case 'date':
      clauses.push(...dayClauses('challanDate', real))
      break
    case 'rate':
      for (const value of real) {
        const clause = parseRateKey(String(value))
        if (clause) clauses.push(clause)
      }
      if (blank) clauses.push({ rate: null })
      break
    case 'amount': {
      const amounts = real.map(Number).filter((value) => Number.isFinite(value))
      clauses.push({ $expr: { $in: [AMOUNT, blank ? [...amounts, null] : amounts] } })
      break
    }
  }

  return clauses.length > 0 ? anyOf(clauses) : MATCH_NOTHING
}

/** After a `$match`: one group per distinct value of the column, blanks as null, sorted. */
export function columnValuesStages(column: TripDoColumnId): PipelineStage[] {
  const path = PATHS[column]
  const value = path
    ? `$${path}`
    : column === 'trip'
      ? '$tripNumbers'
      : column === 'date'
        ? dayExpression('challanDate')
        : column === 'rate'
          ? RATE_KEY
          : AMOUNT

  return [
    ...((column === 'trip'
      ? [{ $unwind: { path: '$tripNumbers', preserveNullAndEmptyArrays: true } }]
      : []) as PipelineStage[]),
    ...distinctValueStages(value),
  ]
}
