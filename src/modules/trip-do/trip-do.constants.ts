import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Trip DO vocabulary. The frontend mirrors
 * this file at `LBTS-Frontend/src/features/trip-do/types/index.ts`, which adds
 * display metadata and nothing else. Change one, change both.
 *
 * The Trip DO sheet is **one row per challan product line** — the spreadsheet
 * the office used to keep by hand — plus a row for every piece that came back
 * off a lorry and every piece a later lorry took out again. A Trip DO is set on
 * a row, which ties those pieces to one product line on one gate pass.
 */

// --- Rows ------------------------------------------------------------------

/**
 * What a row is a part of.
 *
 * - `Order` — a product line as the challan orders it.
 * - `Return` — pieces of that product that went out on a trip and came back.
 * - `Resent` — pieces that had come back and a later trip took out again.
 *
 * Return and re-sent rows are not corrections of the order row: the challan
 * still orders what came back, so the order row keeps its quantity and these
 * rows sit beneath it as the history of what physically moved.
 */
export const TRIP_DO_ROW_KINDS = ['Order', 'Return', 'Resent'] as const
export type TripDoRowKind = (typeof TRIP_DO_ROW_KINDS)[number]

/**
 * Where a row's goods are.
 *
 * An order row reads its challan's dispatch status — the Delivery module's
 * vocabulary, unchanged — except that a `Pending` challan whose goods came
 * back reads `Returned`, the same word the Challan list puts on its badge. A
 * return row is `Returned` by definition, and a re-sent row is `Dispatched`
 * until that trip's signed copy is in and `Delivered` after.
 */
export const ROW_DELIVERY_STATUSES = [
  'Pending',
  'Partial',
  'Dispatched',
  'Delivered',
  'Returned',
] as const
export type RowDeliveryStatus = (typeof ROW_DELIVERY_STATUSES)[number]

export function orderRowStatusFor(challan: {
  dispatchStatus: string
  returnedQty?: number | null
  resentQty?: number | null
}): RowDeliveryStatus {
  const atDepot = (challan.returnedQty ?? 0) - (challan.resentQty ?? 0)

  if (challan.dispatchStatus === 'Pending' && atDepot > 0) {
    return 'Returned'
  }

  return (ROW_DELIVERY_STATUSES as readonly string[]).includes(challan.dispatchStatus)
    ? (challan.dispatchStatus as RowDeliveryStatus)
    : 'Pending'
}

/**
 * Whether a row's pieces use up a gate pass line's quantity.
 *
 * Only an order row does. A return is pieces the order row already carries
 * coming back, and a re-send is those same pieces going out again — linking
 * either to the Trip DO the order row has says which gate pass they belong to,
 * not that the gate pass let out more. Counting them would refuse the one Trip
 * DO they honestly have, because the order row had already filled it.
 */
export function countsTowardGatePassQty(kind: string): boolean {
  return kind === 'Order'
}

// --- Gate pass side ----------------------------------------------------------

/**
 * Only a gate pass that has been filed can be linked. A `Draft` is private to
 * its author and may still change completely; a `Rejected` one has been sent
 * back as wrong. Linking a challan to either would be pointing at something
 * nobody has agreed is true.
 */
export const LINKABLE_GATE_PASS_STATUSES = ['Submitted', 'Verified'] as const

/**
 * One gate pass product line, as the challans linked to it say it went.
 *
 * `Unlinked` when no row points at it. A linked return that nothing linked has
 * carried out again is `Returned` — those pieces are on the depot shelf, not
 * with a customer. A linked re-send whose goods are not all signed for yet is
 * `Resent`. Otherwise the *least advanced* of the linked rows decides, because
 * a gate pass line is only as delivered as its slowest piece: every row
 * delivered is `Delivered`, every row at least out of the gate is
 * `Dispatched`, anything out at all is `Partial`.
 */
export const GATE_PASS_PRODUCT_STATUSES = [
  'Unlinked',
  'Pending',
  'Returned',
  'Resent',
  'Partial',
  'Dispatched',
  'Delivered',
] as const
export type GatePassProductStatus = (typeof GATE_PASS_PRODUCT_STATUSES)[number]

/** A row linked to a gate pass line, reduced to what the line's figures read. */
export interface LinkedRowState {
  kind: string
  deliveryStatus: string
  qty: number
  /** The whole challan line's quantity. Order rows only. */
  lineQty?: number | null
  /** See `firstDeliveredQty` on the row. Absent on a row the sync has not rewritten yet. */
  firstDeliveredQty?: number | null
}

function qtyOfKind(rows: readonly LinkedRowState[], kind: string): number {
  return rows.reduce((sum, row) => (row.kind === kind ? sum + row.qty : sum), 0)
}

export function gatePassProductStatusFor(rows: readonly LinkedRowState[]): GatePassProductStatus {
  if (rows.length === 0) {
    return 'Unlinked'
  }

  if (qtyOfKind(rows, 'Return') > qtyOfKind(rows, 'Resent')) {
    return 'Returned'
  }

  const moving = rows.filter((row) => row.kind !== 'Return').map((row) => row.deliveryStatus)
  if (moving.length === 0) {
    return 'Returned'
  }
  const everyDelivered = moving.every((status) => status === 'Delivered')

  if (qtyOfKind(rows, 'Resent') > 0 && !everyDelivered) {
    return 'Resent'
  }
  if (everyDelivered) {
    return 'Delivered'
  }
  if (moving.every((status) => status === 'Dispatched' || status === 'Delivered')) {
    return 'Dispatched'
  }
  if (moving.some((status) => status !== 'Pending' && status !== 'Returned')) {
    return 'Partial'
  }
  if (moving.some((status) => status === 'Returned')) {
    return 'Returned'
  }
  return 'Pending'
}

/**
 * What one linked row adds to its gate pass line's delivered pieces.
 *
 * - An **order** row adds its share of the pieces that went out the first time
 *   on trips whose signed copy is in — returns included, because they did go
 *   out on this gate pass.
 * - A **return** takes its pieces back off: they came back to the depot, so the
 *   gate pass's Not Delivered figure shows them.
 * - A **re-send** adds its pieces again: they have left the depot a second time.
 *
 * A row written before `firstDeliveredQty` existed counts whole when it reads
 * Delivered, which is what the figure meant until then.
 */
export function rowDeliveredShare(row: LinkedRowState): number {
  if (row.kind === 'Return') {
    return -row.qty
  }
  if (row.kind === 'Resent') {
    return row.qty
  }
  const lineQty = row.lineQty ?? 0
  if (lineQty <= 0) {
    return 0
  }
  const first =
    typeof row.firstDeliveredQty === 'number'
      ? row.firstDeliveredQty
      : row.deliveryStatus === 'Delivered'
        ? lineQty
        : 0
  return (row.qty * Math.min(first, lineQty)) / lineQty
}

/** Delivered pieces on a gate pass line: never below nothing, never above what it carries. */
export function gatePassLineDeliveredQty(
  lineQty: number,
  rows: readonly LinkedRowState[],
): number {
  const total = rows.reduce((sum, row) => sum + rowDeliveredShare(row), 0)
  return Math.max(0, Math.min(lineQty, Math.round(total)))
}

// --- Money -------------------------------------------------------------------

/**
 * What one row is charged: its share of the product line's charge.
 *
 * A challan line is priced once, for its whole quantity — tiered rates spend
 * their allowance across the challan, so a piece has no price of its own. A
 * row carrying three of five pieces therefore carries three fifths of the
 * line. A return or re-sent row is worked out against its order line the same
 * way, so it shows what those pieces are worth — but the sheet's total counts
 * order rows only, because counting the charge again for goods that moved
 * twice would double what the challan is worth.
 */
export function rowAmountFor(
  lineAmount: number | null | undefined,
  lineQty: number | null | undefined,
  qty: number,
): number | null {
  if (typeof lineAmount !== 'number' || !lineQty || lineQty <= 0) {
    return null
  }
  return Math.round(((lineAmount * qty) / lineQty) * 100) / 100
}

// --- Limits -------------------------------------------------------------------

/** A row split into more parts than this is somebody holding a key down. */
export const MAX_SPLIT_PARTS = 20

/** Rows one bulk link may touch — a gate pass rarely covers more challans. */
export const MAX_BULK_LINK_ROWS = 200

/** A sheet page. Wider than other lists: this one is scanned, not read. */
export const MAX_TRIP_DO_PAGE_SIZE = 100

/** Rows one export may carry before it is refused with the count. */
export const MAX_TRIP_DO_EXPORT_ROWS = 10_000

/** Gate passes the Trip DO picker offers at once. */
export const MAX_GATE_PASS_OPTIONS = 12

// --- Permissions -------------------------------------------------------------

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do.
 *
 * The sheet is challans and gate passes side by side, so it takes the audience
 * both of those share: `Vendor` is in neither set, because every row carries a
 * customer's address and phone number. `CEO` reads the sheet and changes
 * nothing on it.
 *
 * Linking is deliberately **not** scoped to the challan's author, the way the
 * print mark is not. Setting a Trip DO says which gate pass some goods came out
 * on — a matter of matching paperwork, done by whoever is holding both — and
 * changes nothing the challan says about the delivery itself.
 */
export const TRIP_DO_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const TRIP_DO_WRITE_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'OpEx']
