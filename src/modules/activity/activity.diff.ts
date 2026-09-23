import { MAX_ACTIVITY_CHANGES } from './activity.constants'

/**
 * What changed, as arithmetic.
 *
 * Import-free apart from one constant, and pure, so it is tested as decisions
 * rather than through a database — the treatment `page-ranges.ts` gets in
 * Challan and `assignment.rules.ts` in Vendor.
 *
 * The central decision is that a change is recorded as **two rendered
 * strings** rather than as two raw values. A journal row has to still read in
 * two years, and a raw value is only readable beside the schema that produced
 * it: `{ status: 2 }` means nothing once an enum has been reordered, and an
 * ObjectId means nothing at all to a person. So a value is reduced to the text
 * somebody would have seen on screen, once, at the moment it changed — which
 * is the same reason `entityLabel` and the actor's name are copies.
 *
 * It follows that this is lossy on purpose. Nothing replays a change from a
 * row; the journal says what happened, and the record says what is true now.
 */

export interface ActivityChange {
  /** The stored path, kept so a row can be searched by field. */
  field: string
  /** What that path is called on screen. */
  label: string
  /** Rendered, not raw. Null means the value was absent rather than empty. */
  from: string | null
  to: string | null
}

/** One field a caller wants watched, and how to read it. */
export interface FieldSpec<T> {
  field: Extract<keyof T, string>
  label: string
  /** Overrides the default rendering — money, a date, a joined list. */
  format?: (value: unknown) => string | null
}

const EMPTY = ''

/**
 * A value as a person would have read it.
 *
 * `null` and `undefined` both come back as null — "absent" — while an empty
 * string comes back as an empty string. Those are genuinely different: a
 * cleared note and a note that was never written read the same on screen and
 * do not mean the same thing in a journal.
 */
export function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }

  if (Array.isArray(value)) {
    const parts = value.map((item) => renderValue(item) ?? EMPTY).filter((part) => part !== EMPTY)
    return parts.length > 0 ? parts.join(', ') : EMPTY
  }

  /**
   * An id, or anything else carrying its own string form. Mongoose hands back
   * `ObjectId` instances and `Decimal128`s, and both answer `toString()` with
   * the thing a person would recognise.
   */
  if (typeof value === 'object') {
    const asString = String(value)
    return asString === '[object Object]' ? null : asString
  }

  return null
}

function sameValue(from: string | null, to: string | null): boolean {
  return from === to
}

/**
 * The fields that actually moved between two snapshots.
 *
 * A field the caller did not name is never inspected, which is what keeps a
 * row about the change somebody made rather than about everything Mongoose
 * touched — `updatedAt` moves on every save and says nothing.
 *
 * Capped at `MAX_ACTIVITY_CHANGES`: a row is a sentence with a few clauses,
 * and one carrying forty fields is a diff nobody reads stored forever. The
 * overflow is reported by `changeSummary` rather than silently dropped.
 */
export function changesBetween<T extends object>(
  before: Partial<T>,
  after: Partial<T>,
  specs: readonly FieldSpec<T>[],
): ActivityChange[] {
  const changes: ActivityChange[] = []

  for (const spec of specs) {
    const render = spec.format ?? renderValue
    const from = render((before as Record<string, unknown>)[spec.field])
    const to = render((after as Record<string, unknown>)[spec.field])

    if (sameValue(from, to)) {
      continue
    }

    changes.push({ field: spec.field, label: spec.label, from, to })

    if (changes.length >= MAX_ACTIVITY_CHANGES) {
      break
    }
  }

  return changes
}

/** One change, written out. Used where a summary has room for the detail. */
export function describeChange(change: ActivityChange): string {
  const from = change.from === null || change.from === EMPTY ? 'blank' : change.from
  const to = change.to === null || change.to === EMPTY ? 'blank' : change.to
  return `${change.label} ${from} → ${to}`
}

/**
 * The list of changed fields as a phrase, for a summary line.
 *
 * Names up to three and counts the rest, because "Customer name, vehicle
 * number and 4 more" is read at a glance and a list of seven is not.
 */
export function changeSummary(changes: readonly ActivityChange[]): string {
  if (changes.length === 0) {
    return 'no field changes'
  }

  const named = changes.slice(0, 3).map((change) => change.label.toLowerCase())
  const rest = changes.length - named.length

  if (rest > 0) {
    return `${named.join(', ')} and ${rest} more`
  }

  if (named.length === 1) {
    return named[0] as string
  }

  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1] as string}`
}

/**
 * Money, rendered for a journal row.
 *
 * Whole taka everywhere in this system, and a figure without its sign is a
 * number somebody has to guess the units of two years later.
 */
export function takaValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const amount = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(amount) ? `৳${amount.toLocaleString('en-BD')}` : null
}

/**
 * A calendar day, rendered as `YYYY-MM-DD`.
 *
 * A trip date and an expiry are days rather than instants — the rule
 * `tripDate` follows in Gate Pass — so rendering one as a full ISO timestamp
 * would put a time on a fact that never had one, and would shift the day for
 * a reader west of Greenwich.
 */
export function dayValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}
