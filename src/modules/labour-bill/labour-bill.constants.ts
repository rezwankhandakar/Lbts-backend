import { comparisonKey } from '../gate-pass/gate-pass.constants'
import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Walton Labour Bill vocabulary. The
 * frontend mirrors this file at
 * `LBTS-Frontend/src/features/labour-bill/types/index.ts`, which adds display
 * metadata and nothing else. Change one, change both.
 *
 * A labour bill is the sheet the office charges Walton the *handling* on: what
 * it cost to get each model off the lorry and up to the receiver's floor. It is
 * opened as a slot — a month — and filled by **scanning the challans**, one row
 * per model.
 *
 * It is deliberately not a second Excel Bill. The Excel Bill charges the rate
 * card's transport rate, is built by searching the Trip DO sheet, and **claims**
 * every row it carries so no two bills can charge the same run. This one charges
 * figures nothing can derive — a van hire, four men pulling, three flights of
 * stairs — which is why every amount on it is typed, and why it claims nothing:
 * a run is charged transport by one sheet and labour by the other, and both are
 * true at once. See `labour-bill.lines.ts`.
 */

// --- Lifecycle -----------------------------------------------------------------

/**
 * `Draft` while rows are being scanned in and their amounts typed; `Finalized`
 * once it has been checked and sent. A finalized labour bill cannot change —
 * the figures on it are figures somebody has been asked to pay — and reopening
 * it is a deliberate move by a reviewer, recorded on the bill.
 */
export const LABOUR_BILL_STATUSES = ['Draft', 'Finalized'] as const
export type LabourBillStatus = (typeof LABOUR_BILL_STATUSES)[number]

// --- The money on a row ----------------------------------------------------------

/**
 * A row's Total column: the Ven/Pulling/Labour cell plus the Floor cell.
 *
 * **Null when neither has been typed**, and that is the point rather than a
 * convenience. A blank row and a row charged nothing are different statements —
 * one is work nobody has priced yet, the other is a delivery that needed no
 * help — and a Total reading zero for both would hide the first inside the
 * second. Typing `0` is how somebody says "nothing"; leaving it empty says
 * nothing at all, and the bill counts those and refuses to be finalized.
 */
export function lineTotal(
  labourAmount: number | null | undefined,
  floorAmount: number | null | undefined,
): number | null {
  if (labourAmount == null && floorAmount == null) {
    return null
  }
  return (labourAmount ?? 0) + (floorAmount ?? 0)
}

/** True for a row nobody has priced yet — neither cell typed. */
export function isUnpricedLabourLine(line: {
  labourAmount: number | null | undefined
  floorAmount: number | null | undefined
}): boolean {
  return line.labourAmount == null && line.floorAmount == null
}

// --- The sheet -------------------------------------------------------------------

/**
 * What the section holding rows that have no CSD yet is called.
 *
 * A row gets its CSD from the gate pass its Trip DO sheet row is linked to, and
 * a challan is routinely scanned in before anybody has matched it — so "no CSD"
 * means "not matched yet", never "charged to nobody". Naming it after the
 * missing Trip DO rather than after the missing CSD is deliberate: the Trip DO
 * is the thing somebody has to go and set.
 */
export const PENDING_CSD_LABEL = 'Trip DO pending'

export interface ArrangeableLabourLine {
  /** The challan the row belongs to. One challan is one SL. */
  challanId: string
  /** The order the row was added to the bill, unique within it. */
  seq: number
}

export type ArrangedLabourLine<T> = T & {
  /** 1 for the first challan scanned onto the bill, 2 for the next, and so on. */
  sl: number
  /** Rows the SL cell spans on the challan's first row; 0 on the rest of it. */
  slRowSpan: number
}

/**
 * The sheet's row order and its SL numbers.
 *
 * **One challan is one SL**, however many models it carries, and the SL cell is
 * merged down them — the office's own layout, and the same rule the Excel Bill
 * applies to a Trip DO. The fill unit here is a barcode, so the thing an SL
 * counts is the sheet of paper somebody scanned.
 *
 * Challans are ordered by when the first of their rows was scanned in, and rows
 * within one challan by when each was added, so a model picked up by a later
 * refresh lands under its own challan rather than at the foot of the sheet with
 * a second SL.
 */
export function arrangeLabourLines<T extends ArrangeableLabourLine>(
  lines: readonly T[],
): ArrangedLabourLine<T>[] {
  const firstSeq = new Map<string, number>()
  const sizes = new Map<string, number>()

  for (const line of lines) {
    firstSeq.set(
      line.challanId,
      Math.min(firstSeq.get(line.challanId) ?? Number.POSITIVE_INFINITY, line.seq),
    )
    sizes.set(line.challanId, (sizes.get(line.challanId) ?? 0) + 1)
  }

  const sorted = [...lines].sort(
    (a, b) =>
      (firstSeq.get(a.challanId) ?? 0) - (firstSeq.get(b.challanId) ?? 0) ||
      a.challanId.localeCompare(b.challanId) ||
      a.seq - b.seq,
  )

  let sl = 0
  let current: string | null = null

  return sorted.map((line) => {
    if (line.challanId !== current) {
      sl += 1
      current = line.challanId
      return { ...line, sl, slRowSpan: sizes.get(line.challanId) ?? 1 }
    }
    return { ...line, sl, slRowSpan: 0 }
  })
}

// --- Splitting the month by CSD ----------------------------------------------------

export interface GroupableLabourLine extends ArrangeableLabourLine {
  /** The CSD the row's gate pass carries, blank while its Trip DO is unset. */
  csd: string
}

export interface LabourCsdGroup<T> {
  /** The CSD as the gate passes write it; blank is the pending section. */
  csd: string
  /** `comparisonKey` of it, so `CSD-01` and `csd 01` are one section. */
  key: string
  /** What the section is called: the CSD, or "Trip DO pending". */
  label: string
  /** True for the section holding rows nothing has matched yet. */
  isPending: boolean
  lines: ArrangedLabourLine<T>[]
}

/**
 * **The bill splits itself by CSD.** Nobody chooses one: a slot is a month, a
 * challan is scanned in whole, and each of its rows files itself under whatever
 * CSD the gate pass behind it carries. One CSD is one section, one SL series and
 * one worksheet in the export — the separate bills the office sends — while the
 * month above them stays a single thing to scan into.
 *
 * That is the whole reason the CSD is not a field on the slot. A row's CSD is a
 * fact about its gate pass, and a fact is not something to ask an operator to
 * restate; asking would also make a challan that went out on two gate passes
 * into two scans against two slots, which is not how the paper arrives.
 *
 * **A row with no Trip DO has no CSD, and waits rather than being refused.**
 * Matching a gate pass happens on its own schedule, so those rows sit in a
 * pending section at the foot, keeping the amounts already typed into them, and
 * move into their CSD the moment the Trip DO is set — see `syncLabourBillCopies`.
 *
 * Sections are ordered by CSD so the sheet reads the same every time it is
 * opened, with pending always last; within a section the challans keep the
 * order they were scanned in and the SL restarts at 1.
 */
export function groupLabourLinesByCsd<T extends GroupableLabourLine>(
  lines: readonly T[],
): LabourCsdGroup<T>[] {
  const buckets = new Map<string, { csd: string; lines: T[] }>()

  for (const line of lines) {
    const csd = line.csd.trim()
    // The same normalisation every transcribed identifier gets, so `CSD-01` and
    // `csd 01` are one section rather than two that look identical on screen.
    const key = comparisonKey(csd)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { csd, lines: [] }
      buckets.set(key, bucket)
    }
    bucket.lines.push(line)
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => {
      // Pending last, whatever it sorts as: it is the section somebody has work
      // left in, and it belongs at the foot rather than at the top of the file.
      if (a === '' || b === '') {
        return a === '' ? 1 : -1
      }
      return a.localeCompare(b)
    })
    .map(([key, bucket]) => ({
      csd: bucket.csd,
      key,
      label: labourGroupLabel(bucket.csd),
      isPending: key === '',
      lines: arrangeLabourLines(bucket.lines),
    }))
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
export function labourBillPeriodLabel(month: number, year: number): string {
  return `${MONTH_NAMES[month - 1] ?? 'Month'} ${year}`
}

/** What a CSD section is called on screen and on its own worksheet. */
export function labourGroupLabel(csd: string): string {
  return csd || PENDING_CSD_LABEL
}

/**
 * `LBTS-WLB-2026-0007`: the seventh Walton Labour Bill for a period in 2026.
 * Scoped by the bill's own year rather than the day it was opened, because a
 * December sheet put together on the second of January is still a 2026 bill.
 */
export function formatLabourBillNumber(year: number, sequence: number): string {
  return `LBTS-WLB-${year}-${String(sequence).padStart(4, '0')}`
}

/** `LBTS-WLB-2026-0007` read as `WLB-0007` where the year is already on screen. */
export function shortLabourBillNumber(billNumber: string): string {
  const match = /^LBTS-WLB-\d{4}-(\d+)$/.exec(billNumber)
  return match ? `WLB-${match[1]}` : billNumber
}

// --- Limits -----------------------------------------------------------------------

/** Rows one labour bill may carry; a month of scanned challans is far below it. */
export const MAX_LABOUR_BILL_LINES = 3000

/** Rows one remove may name. */
export const MAX_LABOUR_BILL_ROWS_PER_CHANGE = 500

/** The largest amount a cell accepts, so a mis-keyed row is caught at the boundary. */
export const MAX_LABOUR_AMOUNT = 10_000_000

/** Floors a building in this operation plausibly has. */
export const MAX_FLOOR_NUMBER = 200

export const MAX_LABOUR_BILL_PAGE_SIZE = 50

// --- Permissions -----------------------------------------------------------------

/**
 * Module-level permissions, as CLAUDE.md asks each module to configure.
 *
 * Every row carries a customer's address and a receiver's number, so `Vendor`
 * is in no set — the Trip DO sheet's audience, for the sheet's reason. Scanning
 * challans in and typing what the handling cost is everybody who works that
 * sheet, Operation Executive included, because they are the people holding the
 * paper. **Finalizing and reopening** is `Admin` and `Manager`: it is the
 * sign-off on money being claimed, and the one step a bill cannot quietly take
 * back.
 */
export const LABOUR_BILL_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const LABOUR_BILL_WRITE_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'OpEx']
export const LABOUR_BILL_REVIEW_ROLES: readonly UserRole[] = ['Admin', 'Manager']
