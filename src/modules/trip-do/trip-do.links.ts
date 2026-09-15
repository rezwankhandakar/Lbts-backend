import { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import type { GatePassDocument } from '../gate-pass/gate-pass.model'
import type { UserDocument } from '../user/user.model'
import { gatePassLineDeliveredQty, gatePassProductStatusFor } from './trip-do.constants'
import type { GatePassProductStatus, LinkedRowState } from './trip-do.constants'
import { TripDoLineModel } from './trip-do.model'

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

/**
 * Pieces linked to one gate pass, by line — order rows only, because a return
 * or re-send is pieces an order row already counts (`countsTowardGatePassQty`).
 *
 * An aggregation `$match` does no schema casting, so the id is cast here — the
 * mistake the Vendor summary made once, reporting every fleet as empty.
 */
export async function allocatedByModel(
  gatePassId: IdLike,
  excludeRowIds: IdLike[] = [],
): Promise<Map<string, number>> {
  const rows = await TripDoLineModel.aggregate<{ _id: string; qty: number }>([
    {
      $match: {
        'link.gatePassId': toObjectId(gatePassId),
        kind: 'Order',
        ...(excludeRowIds.length > 0 ? { _id: { $nin: excludeRowIds.map(toObjectId) } } : {}),
      },
    },
    { $group: { _id: LINKED_LINE_KEY, qty: { $sum: '$qty' } } },
  ])

  return new Map(rows.map((row) => [row._id, row.qty]))
}

/**
 * `rowDeliveredShare` as an aggregation expression, for the list-wide figure
 * that cannot load every row. Change one, change both.
 */
export const DELIVERED_SHARE = {
  $switch: {
    branches: [
      { case: { $eq: ['$kind', 'Return'] }, then: { $multiply: ['$qty', -1] } },
      { case: { $eq: ['$kind', 'Resent'] }, then: '$qty' },
      {
        case: { $gt: [{ $ifNull: ['$lineQty', 0] }, 0] },
        then: {
          $divide: [
            {
              $multiply: [
                '$qty',
                {
                  $min: [
                    {
                      $ifNull: [
                        '$firstDeliveredQty',
                        { $cond: [{ $eq: ['$deliveryStatus', 'Delivered'] }, '$lineQty', 0] },
                      ],
                    },
                    '$lineQty',
                  ],
                },
              ],
            },
            '$lineQty',
          ],
        },
      },
    ],
    default: 0,
  },
} as const

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
  status: GatePassProductStatus
}

/**
 * Delivery by gate pass and model key, for a page of gate passes — one
 * grouped read over the link index, whatever the page holds.
 */
export async function deliveryByGatePassLine(
  gatePassIds: IdLike[],
): Promise<Map<string, Map<string, GatePassLineDelivery>>> {
  const result = new Map<string, Map<string, GatePassLineDelivery>>()
  if (gatePassIds.length === 0) {
    return result
  }

  const rows = await TripDoLineModel.aggregate<{
    _id: { gatePassId: Types.ObjectId; modelKey: string }
    linkedQty: number
    rows: LinkedRowState[]
  }>([
    { $match: { 'link.gatePassId': { $in: gatePassIds.map(toObjectId) } } },
    {
      $group: {
        _id: { gatePassId: '$link.gatePassId', modelKey: LINKED_LINE_KEY },
        // Returns and re-sends are pieces an order row already counts.
        linkedQty: { $sum: { $cond: [{ $eq: ['$kind', 'Order'] }, '$qty', 0] } },
        rows: {
          $push: {
            kind: '$kind',
            deliveryStatus: '$deliveryStatus',
            qty: '$qty',
            lineQty: '$lineQty',
            firstDeliveredQty: '$firstDeliveredQty',
          },
        },
      },
    },
  ])

  for (const row of rows) {
    const key = String(row._id.gatePassId)
    const lines = result.get(key) ?? new Map<string, GatePassLineDelivery>()
    lines.set(row._id.modelKey, {
      linkedQty: row.linkedQty,
      deliveredQty: gatePassLineDeliveredQty(Number.POSITIVE_INFINITY, row.rows),
      status: gatePassProductStatusFor(row.rows),
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
  // Per line: the order pieces added up, and the largest single return or
  // re-send — those do not add to the order, but each must still fit the line.
  const linked = await TripDoLineModel.aggregate<{
    _id: string
    orderQty: number
    otherQty: number
    model: string
  }>([
    { $match: { 'link.gatePassId': toObjectId(gatePassId) } },
    {
      $group: {
        _id: LINKED_LINE_KEY,
        orderQty: { $sum: { $cond: [{ $eq: ['$kind', 'Order'] }, '$qty', 0] } },
        otherQty: { $max: { $cond: [{ $eq: ['$kind', 'Order'] }, 0, '$qty'] } },
        model: { $first: { $ifNull: ['$link.model', '$productModel'] } },
      },
    },
  ])
  if (linked.length === 0) {
    return
  }

  const carried = new Map<string, number>()
  for (const item of items) {
    const key = comparisonKey(item.model)
    carried.set(key, (carried.get(key) ?? 0) + item.qty)
  }

  for (const line of linked) {
    const qty = carried.get(line._id) ?? 0
    const needed = Math.max(line.orderQty, line.otherQty)
    if (needed > qty) {
      throw new AppError(
        409,
        `${needed} ${line.model || line._id} ${needed === 1 ? 'piece is' : 'pieces are'} ` +
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[trip-do] linked rows not refreshed for ${gatePass.gatePassId}: ${message}`)
  }
}
