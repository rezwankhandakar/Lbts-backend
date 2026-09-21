import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Bill vocabulary. The frontend mirrors this
 * file at `LBTS-Frontend/src/features/bill/types/index.ts`, which adds display
 * metadata and nothing else. Change one, change both.
 *
 * A bill is the spreadsheet the office sends a unit at the end of a month: one
 * row per Trip DO sheet row, with every row of one Trip DO sharing a single SL.
 * It is built by searching the Trip DO sheet and adding what was carried, and
 * every row it carries is marked billed on the Trip DO sheet, and through it on
 * the challan and the gate pass the row belongs to.
 */

// --- Lifecycle -----------------------------------------------------------------

/**
 * `Draft` while rows are still being added and removed; `Finalized` once it has
 * been checked and sent. A finalized bill cannot change what it carries — the
 * figure on it is a figure somebody has been asked to pay — and reopening it is
 * a deliberate move by a reviewer, recorded on the bill.
 */
export const BILL_STATUSES = ['Draft', 'Finalized'] as const
export type BillStatus = (typeof BILL_STATUSES)[number]

// --- Billing status on a challan and a gate pass ---------------------------------

/**
 * Whether what a challan or a gate pass carried has been billed.
 *
 * `Partial` is its own state for the reason `chargeStatus` has one: a record
 * that looks billed and has one return nobody put on a bill is exactly the row
 * a month-end reconciliation is looking for.
 */
export const BILLING_STATUSES = ['Unbilled', 'Partial', 'Billed'] as const
export type BillingStatus = (typeof BILLING_STATUSES)[number]

/**
 * A challan is billed when every one of its Trip DO sheet rows is on a bill —
 * order rows, returns and re-sends alike, because each is a run somebody is
 * charged for. A challan none of whose rows is billed is `Unbilled`, including
 * one with no rows at all.
 */
export function challanBillingStatusFor(rows: number, billedRows: number): BillingStatus {
  if (billedRows <= 0) {
    return 'Unbilled'
  }
  return billedRows >= rows ? 'Billed' : 'Partial'
}

export interface GatePassBillingState {
  /** Every piece the gate pass carries. */
  totalQty: number
  /** Pieces on billed order rows linked to it. */
  billedOrderQty: number
  /** Linked rows of any kind that are on a bill, and that are not. */
  billedRows: number
  unbilledRows: number
}

/**
 * A gate pass is billed when every piece it carried is on a billed order row
 * and nothing linked to it is waiting — a gate pass of five with three billed
 * is `Partial`, however the three were split.
 */
export function gatePassBillingStatusFor(state: GatePassBillingState): BillingStatus {
  if (state.billedRows <= 0) {
    return 'Unbilled'
  }
  if (state.unbilledRows === 0 && state.billedOrderQty >= state.totalQty) {
    return 'Billed'
  }
  return 'Partial'
}

// --- The sheet -------------------------------------------------------------------

/** The Remarks column: blank for an order row. */
export const REMARKS_BY_KIND: Record<string, string> = {
  Order: '',
  Return: 'Return',
  Resent: 'Re-Sent',
}

export interface ArrangeableLine {
  /** `comparisonKey` of the row's Trip DO. */
  tripDoKey: string
  /** The order the row was added to the bill, unique within it. */
  seq: number
}

export type ArrangedLine<T> = T & {
  /** 1 for the first Trip DO on the bill, 2 for the next, and so on. */
  sl: number
  /** Rows the SL cell spans on the group's first row; 0 on the rest of the group. */
  slRowSpan: number
}

/**
 * The bill's row order and its SL numbers.
 *
 * **One Trip DO is one SL**, however many rows it carries, and the SL cell is
 * merged across them — the office's own layout. Trip DOs are ordered by when
 * their first row was added, and rows within one by when each was added, so a
 * return added a week later lands beneath the rows of its own Trip DO rather
 * than at the bottom of the sheet with a second SL.
 */
export function arrangeBillLines<T extends ArrangeableLine>(lines: readonly T[]): ArrangedLine<T>[] {
  const firstSeq = new Map<string, number>()
  const sizes = new Map<string, number>()

  for (const line of lines) {
    firstSeq.set(line.tripDoKey, Math.min(firstSeq.get(line.tripDoKey) ?? Number.POSITIVE_INFINITY, line.seq))
    sizes.set(line.tripDoKey, (sizes.get(line.tripDoKey) ?? 0) + 1)
  }

  const sorted = [...lines].sort(
    (a, b) =>
      (firstSeq.get(a.tripDoKey) ?? 0) - (firstSeq.get(b.tripDoKey) ?? 0) ||
      a.tripDoKey.localeCompare(b.tripDoKey) ||
      a.seq - b.seq,
  )

  let sl = 0
  let current: string | null = null

  return sorted.map((line) => {
    if (line.tripDoKey !== current) {
      sl += 1
      current = line.tripDoKey
      return { ...line, sl, slRowSpan: sizes.get(line.tripDoKey) ?? 1 }
    }
    return { ...line, sl, slRowSpan: 0 }
  })
}

// --- Numbering and periods --------------------------------------------------------

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** "September 2026". */
export function billPeriodLabel(month: number, year: number): string {
  return `${MONTH_NAMES[month - 1] ?? 'Month'} ${year}`
}

/**
 * `LBTS-BILL-2026-0007`: the seventh bill for a period in 2026. Scoped by the
 * bill's own year rather than the day it was made, because a December bill put
 * together on the second of January is still a 2026 bill.
 */
export function formatBillNumber(year: number, sequence: number): string {
  return `LBTS-BILL-${year}-${String(sequence).padStart(4, '0')}`
}

/** The first instant of the billing month and of the month after it, in UTC — a trip date is a UTC calendar day. */
export function billPeriodRange(month: number, year: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) }
}

// --- Limits -----------------------------------------------------------------------

/** Rows one bill may carry; a month of one unit is far below it. */
export const MAX_BILL_LINES = 3000

/** Rows one add or remove may name. */
export const MAX_BILL_ROWS_PER_CHANGE = 500

/** Trip DO sheet rows the search reads, and Trip DO cards it answers with. */
export const MAX_CANDIDATE_ROWS = 400
export const MAX_CANDIDATE_GROUPS = 30

export const MAX_BILL_PAGE_SIZE = 50

// --- Permissions -----------------------------------------------------------------

/**
 * Module-level permissions, as CLAUDE.md asks each module to configure.
 *
 * A bill is Trip DO sheet rows, so it has the sheet's audience: `Vendor` is in
 * no set, because every row carries a customer's address.
 *
 * And it takes the sheet's split too. The whole office reads a bill; **only
 * `Admin` prepares one** — creating it, adding and removing rows, refreshing
 * it — and only `Admin` finalizes or reopens it. A bill claims Trip DO rows
 * so no two bills can charge the same run, which is exactly the decision the
 * sheet itself is now Admin-only for; a preparer who could not set a Trip DO
 * but could bill one would be half a permission.
 */
export const BILL_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const BILL_WRITE_ROLES: readonly UserRole[] = ['Admin']
export const BILL_REVIEW_ROLES: readonly UserRole[] = ['Admin']
