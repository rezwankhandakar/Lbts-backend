import { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import { GatePassModel } from '../gate-pass/gate-pass.model'
import type { GatePassDocument } from '../gate-pass/gate-pass.model'
import { syncLabourBillCopies } from '../labour-bill/labour-bill.lines'
import type { UserDocument } from '../user/user.model'
import {
  gatePassLineDeliveredQty,
  gatePassLinePieces,
  gatePassProductStatusFor,
  lineHeldQty,
  rowsCarryingReturns,
} from './trip-do.constants'
import type {
  GatePassProductStatus,
  LineHistoryRow,
  LineUseRow,
  LinkedRowState,
} from './trip-do.constants'
import { TripDoLineModel } from './trip-do.model'
import type { TripDoLineDocument } from './trip-do.model'

/**
 * The half of the Trip DO module the Gate Pass module calls.
 *
 * A gate pass is editable in every status and deletable by its author, so
 * without these two refusals a correction there could quietly make the sheet
 * untrue: five pieces linked against a line somebody has just corrected to
 * three, or rows pointing at a gate pass that no longer exists. Neither
 * function here asks *who* — Gate Pass has already decided that — only whether
 * the change leaves the links honest.
 */

type IdLike = Types.ObjectId | string

function toObjectId(id: IdLike): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id
}

/**
 * The gate pass line a linked row points at, as an aggregation expression:
 * `link.modelKey`, or the row's own model key for a row linked before the line
 * was stored. `rowLineKey` is the same rule over a loaded document.
 */
export const LINKED_LINE_KEY = {
  $cond: [
    { $gt: [{ $strLenCP: { $ifNull: ['$link.modelKey', ''] } }, 0] },
    '$link.modelKey',
    '$productModelKey',
  ],
} as const

export function rowLineKey(row: {
  productModelKey: string
  link?: { modelKey?: string | null } | null
}): string {
  return row.link?.modelKey || row.productModelKey
}

/** A row on a gate pass line, as the line's room reads it (`lineHeldQty`). */
export interface PlacedRow extends LineUseRow {
  id: string
  challanId: string
  /** The gate pass line it is on — `rowLineKey`. */
  lineKey: string
}

/** Every row linked to one gate pass, placed on its line. */
export async function placedRowsOn(gatePassId: IdLike): Promise<PlacedRow[]> {
  const rows = await TripDoLineModel.find({ 'link.gatePassId': toObjectId(gatePassId) }).select(
    'challanId kind qty link productModelKey',
  )
  return rows.map((row) => ({
    id: String(row._id),
    challanId: String(row.challanId),
    kind: row.kind,
    qty: row.qty,
    lineKey: rowLineKey(row),
  }))
}

/** `placedRowsOn`, one line's worth. */
export function rowsOnLine(rows: readonly PlacedRow[], lineKey: string): PlacedRow[] {
  return rows.filter((row) => row.lineKey === lineKey)
}

/** A linked row as `rowsCarryingReturns` reads it. */
export function historyRowOf(
  row: Pick<TripDoLineDocument, '_id' | 'challanId' | 'kind' | 'qty' | 'link'>,
): LineHistoryRow {
  return {
    id: String(row._id),
    challanId: String(row.challanId),
    kind: row.kind,
    qty: row.qty,
    linkedAt: row.link?.linkedAt ? row.link.linkedAt.getTime() : 0,
  }
}

/**
 * For a page of rows, how many of each order row's pieces another challan
 * sent back (`rowsCarryingReturns`) — the rows the sheet tags **Re-sent**.
 *
 * Which row carries them depends on everything on the line, not just what is
 * on the page, so the lines are read whole. Only a gate pass with a return
 * linked to it can have any, which is what the first query asks — on most
 * pages that is the only one.
 */
export async function returnedPiecesOnRows(
  rows: readonly TripDoLineDocument[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  const linkedIds = [
    ...new Set(
      rows
        .filter((row) => row.kind === 'Order' && row.link)
        .map((row) => String(row.link?.gatePassId)),
    ),
  ]
  if (linkedIds.length === 0) {
    return result
  }

  const withReturns = await TripDoLineModel.distinct('link.gatePassId', {
    'link.gatePassId': { $in: linkedIds.map(toObjectId) },
    kind: 'Return',
  })
  if (withReturns.length === 0) {
    return result
  }

  const [gatePasses, linked] = await Promise.all([
    GatePassModel.find({ _id: { $in: withReturns } }).select('items'),
    TripDoLineModel.find({ 'link.gatePassId': { $in: withReturns } }).select(
      'challanId kind qty link productModelKey',
    ),
  ])
  const carried = new Map(gatePasses.map((gatePass) => [String(gatePass._id), gatePassQtyByModel(gatePass)]))

  const lines = new Map<string, { gatePassId: string; lineKey: string; rows: LineHistoryRow[] }>()
  for (const row of linked) {
    const gatePassId = String(row.link?.gatePassId)
    const lineKey = rowLineKey(row)
    const key = `${gatePassId}|${lineKey}`
    const line = lines.get(key) ?? { gatePassId, lineKey, rows: [] }
    line.rows.push(historyRowOf(row))
    lines.set(key, line)
  }

  for (const line of lines.values()) {
    const qty = carried.get(line.gatePassId)?.get(line.lineKey) ?? Number.POSITIVE_INFINITY
    for (const [id, pieces] of rowsCarryingReturns(line.rows, qty)) {
      result.set(id, pieces)
    }
  }
  return result
}

/**
 * The row-share functions in `trip-do.constants.ts` as aggregation
 * expressions, for the list-wide figures that cannot load every row. Change
 * one, change both.
 */
const FIRST_DELIVERED = {
  $ifNull: [
    '$firstDeliveredQty',
    { $cond: [{ $eq: ['$deliveryStatus', 'Delivered'] }, { $ifNull: ['$lineQty', 0] }, 0] },
  ],
}

const FIRST_DISPATCHED = {
  $ifNull: [
    '$firstDispatchedQty',
    {
      $max: [
        FIRST_DELIVERED,
        { $cond: [{ $eq: ['$deliveryStatus', 'Dispatched'] }, { $ifNull: ['$lineQty', 0] }, 0] },
      ],
    },
  ],
}

/** An order row's share of `first` pieces of its whole challan line. */
function orderShare(first: unknown) {
  return {
    case: { $gt: [{ $ifNull: ['$lineQty', 0] }, 0] },
    then: {
      $divide: [{ $multiply: ['$qty', { $min: [first, '$lineQty'] }] }, '$lineQty'],
    },
  }
}

/** `rowDeliveredShare`. */
export const DELIVERED_SHARE = {
  $switch: {
    branches: [
      { case: { $eq: ['$kind', 'Return'] }, then: { $multiply: ['$qty', -1] } },
      {
        case: { $eq: ['$kind', 'Resent'] },
        then: { $cond: [{ $eq: ['$deliveryStatus', 'Delivered'] }, '$qty', 0] },
      },
      orderShare(FIRST_DELIVERED),
    ],
    default: 0,
  },
}

/** `rowDispatchedShare`. */
export const DISPATCHED_SHARE = {
  $switch: {
    branches: [
      { case: { $eq: ['$kind', 'Return'] }, then: { $multiply: ['$qty', -1] } },
      { case: { $eq: ['$kind', 'Resent'] }, then: '$qty' },
      orderShare(FIRST_DISPATCHED),
    ],
    default: 0,
  },
}

/** `rowReturnedShare`. */
export const RETURNED_SHARE = {
  $switch: {
    branches: [
      { case: { $eq: ['$kind', 'Return'] }, then: '$qty' },
      { case: { $eq: ['$kind', 'Resent'] }, then: { $multiply: ['$qty', -1] } },
    ],
    default: 0,
  },
}

/**
 * `gatePassLinePieces` as an expression: `{ delivered, sent, returned }` for a
 * line of `qty` pieces whose linked rows' shares add up to `sums`.
 */
export function linePiecesExpression(
  qty: unknown,
  sums: { delivered: unknown; dispatched: unknown; returned: unknown },
) {
  const within = (total: unknown, ceiling: unknown) => ({
    $max: [0, { $min: [ceiling, { $round: [total, 0] }] }],
  })

  return {
    $let: {
      vars: { out: within(sums.dispatched, qty) },
      in: {
        $let: {
          vars: { delivered: { $min: ['$$out', within(sums.delivered, qty)] } },
          in: {
            delivered: '$$delivered',
            sent: { $subtract: ['$$out', '$$delivered'] },
            returned: within(sums.returned, { $subtract: [qty, '$$out'] }),
          },
        },
      },
    },
  }
}

/** What the challans linked to one gate pass line say about it. */
export interface GatePassLineDelivery {
  /** Pieces linked to challan order rows. */
  linkedQty: number
  /**
   * Delivered pieces: order rows' first delivery, less linked returns, plus
   * linked re-sends — `gatePassLineDeliveredQty`. Not capped at the line; the
   * caller knows what the line carries.
   */
  deliveredQty: number
  /** Pieces out of the gate whose signed copy is not back — `gatePassLinePieces`. */
  sentQty: number
  /** Pieces back at the depot and not out again — `gatePassLinePieces`. */
  returnedQty: number
  status: GatePassProductStatus
}

/**
 * Delivery by gate pass and model key, for a page of gate passes — one
 * grouped read over the link index, whatever the page holds. The gate passes
 * come with their items, because whether a returned piece is still on the
 * shelf depends on what the line carries (`gatePassProductStatusFor`).
 */
export async function deliveryByGatePassLine(
  gatePasses: Pick<GatePassDocument, '_id' | 'items'>[],
): Promise<Map<string, Map<string, GatePassLineDelivery>>> {
  const result = new Map<string, Map<string, GatePassLineDelivery>>()
  if (gatePasses.length === 0) {
    return result
  }
  const carried = new Map(gatePasses.map((gatePass) => [String(gatePass._id), gatePassQtyByModel(gatePass)]))

  const rows = await TripDoLineModel.aggregate<{
    _id: { gatePassId: Types.ObjectId; modelKey: string }
    linkedQty: number
    rows: (LinkedRowState & { challanId: Types.ObjectId })[]
  }>([
    { $match: { 'link.gatePassId': { $in: gatePasses.map((gatePass) => toObjectId(gatePass._id)) } } },
    {
      $group: {
        _id: { gatePassId: '$link.gatePassId', modelKey: LINKED_LINE_KEY },
        // Whether anything is on a challan yet: order pieces, returns aside.
        linkedQty: { $sum: { $cond: [{ $eq: ['$kind', 'Order'] }, '$qty', 0] } },
        rows: {
          $push: {
            challanId: '$challanId',
            kind: '$kind',
            deliveryStatus: '$deliveryStatus',
            qty: '$qty',
            lineQty: '$lineQty',
            firstDeliveredQty: '$firstDeliveredQty',
            firstDispatchedQty: '$firstDispatchedQty',
          },
        },
      },
    },
  ])

  for (const row of rows) {
    const key = String(row._id.gatePassId)
    const lines = result.get(key) ?? new Map<string, GatePassLineDelivery>()
    const states = row.rows.map((state) => ({ ...state, challanId: String(state.challanId) }))
    const lineQty = carried.get(key)?.get(row._id.modelKey) ?? Number.POSITIVE_INFINITY
    const pieces = gatePassLinePieces(lineQty, states)
    lines.set(row._id.modelKey, {
      linkedQty: row.linkedQty,
      deliveredQty: gatePassLineDeliveredQty(Number.POSITIVE_INFINITY, states),
      sentQty: pieces.sent,
      returnedQty: pieces.returned,
      status: gatePassProductStatusFor(states, lineQty),
    })
    result.set(key, lines)
  }

  return result
}

/** What a gate pass carries, by model key. Two lines of one model add up. */
export function gatePassQtyByModel(
  gatePass: Pick<GatePassDocument, 'items'>,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const item of gatePass.items) {
    result.set(item.productModelKey, (result.get(item.productModelKey) ?? 0) + item.qty)
  }
  return result
}

/** The line on a gate pass a row is linked to. */
export interface GatePassLineRef {
  modelKey: string
  model: string
}

/**
 * The Trip DO a row stores: a reference to the gate pass, the line on it, and
 * what identifies it.
 */
export function linkCopyFor(
  gatePass: GatePassDocument,
  line: GatePassLineRef,
  actor: UserDocument | null,
) {
  return {
    gatePassId: gatePass._id,
    gatePassNumber: gatePass.gatePassId,
    tripDo: gatePass.tripDo,
    tripDate: gatePass.tripDate,
    csd: gatePass.csd,
    unit: gatePass.unit,
    modelKey: line.modelKey,
    model: line.model,
    linkedAt: new Date(),
    linkedBy: actor?._id ?? null,
  }
}

/**
 * Refuses a gate pass correction that would leave more pieces linked to a
 * model than the gate pass now carries — including removing the line.
 *
 * A refusal rather than an automatic unlink, because which of the challans
 * should lose its Trip DO is not something arithmetic can decide. The message
 * says how many are linked, so the person correcting knows what to undo first.
 */
export async function assertGatePassEditKeepsLinks(
  gatePassId: IdLike,
  items: { model: string; qty: number }[],
): Promise<void> {
  const linked = await TripDoLineModel.find({ 'link.gatePassId': toObjectId(gatePassId) }).select(
    'challanId kind qty link productModel productModelKey',
  )
  if (linked.length === 0) {
    return
  }

  const lines = new Map<string, { model: string; rows: LineUseRow[]; largestReturn: number }>()
  for (const row of linked) {
    const key = rowLineKey(row)
    const line = lines.get(key) ?? { model: row.link?.model || row.productModel, rows: [], largestReturn: 0 }
    line.rows.push({ challanId: String(row.challanId), kind: row.kind, qty: row.qty })
    if (row.kind === 'Return') {
      line.largestReturn = Math.max(line.largestReturn, row.qty)
    }
    lines.set(key, line)
  }

  const carried = new Map<string, number>()
  for (const item of items) {
    const key = comparisonKey(item.model)
    carried.set(key, (carried.get(key) ?? 0) + item.qty)
  }

  // Per line: what the challans are holding of it, and the largest single
  // return — a return gives pieces back, but it still has to fit the line.
  for (const [key, line] of lines) {
    const qty = carried.get(key) ?? 0
    const needed = Math.max(lineHeldQty(line.rows), line.largestReturn)
    if (needed > qty) {
      throw new AppError(
        409,
        `${needed} ${line.model || key} ${needed === 1 ? 'piece is' : 'pieces are'} ` +
          `linked to challans on the Trip DO sheet, so this gate pass cannot carry ${qty}. ` +
          'Remove the Trip DO from those rows first.',
      )
    }
  }
}

/** Refuses deleting a gate pass that challan rows still point at. */
export async function assertGatePassNotLinked(gatePassId: IdLike): Promise<void> {
  const count = await TripDoLineModel.countDocuments({ 'link.gatePassId': toObjectId(gatePassId) })

  if (count > 0) {
    throw new AppError(
      409,
      `${count} challan ${count === 1 ? 'row is' : 'rows are'} linked to this gate pass on the ` +
        'Trip DO sheet. Remove the Trip DO from them before deleting it.',
    )
  }
}

/**
 * Rewrites what linked rows say about a gate pass after it was corrected.
 *
 * Never throws: the gate pass is saved, and a sheet showing yesterday's CSD
 * for a moment is not a reason to report the correction as failed.
 */
export async function refreshGatePassLinkCopies(gatePass: GatePassDocument): Promise<void> {
  try {
    const models = new Map<string, string>()
    for (const item of gatePass.items) {
      if (!models.has(item.productModelKey)) {
        models.set(item.productModelKey, item.productModel)
      }
    }

    await TripDoLineModel.bulkWrite([
      {
        updateMany: {
          filter: { 'link.gatePassId': gatePass._id },
          update: {
            $set: {
              'link.gatePassNumber': gatePass.gatePassId,
              'link.tripDo': gatePass.tripDo,
              'link.tripDate': gatePass.tripDate,
              'link.csd': gatePass.csd,
              'link.unit': gatePass.unit,
              tripDoKey: comparisonKey(gatePass.tripDo),
            },
          },
        },
      },
      // The line's model as the gate pass now spells it.
      ...[...models].map(([modelKey, model]) => ({
        updateMany: {
          filter: { 'link.gatePassId': gatePass._id, 'link.modelKey': modelKey },
          update: { $set: { 'link.model': model } },
        },
      })),
    ])

    // A corrected CSD moves every labour bill row behind these rows into a
    // different section, so their copies are re-read here rather than waiting
    // for somebody to press Refresh.
    const touched = await TripDoLineModel.find({ 'link.gatePassId': gatePass._id }).select('_id')
    await syncLabourBillCopies(touched.map((row) => row._id))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[trip-do] linked rows not refreshed for ${gatePass.gatePassId}: ${message}`)
  }
}
