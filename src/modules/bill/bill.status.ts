import { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { ChallanModel } from '../challan/challan.model'
import { GatePassModel } from '../gate-pass/gate-pass.model'
import { TripDoLineModel } from '../trip-do/trip-do.model'
import { challanBillingStatusFor, gatePassBillingStatusFor } from './bill.constants'
import type { BillingStatus } from './bill.constants'

/**
 * Keeps `billStatus` and `billNumbers` on challans and gate passes in step with
 * which of their Trip DO sheet rows are on a bill.
 *
 * Stored on the records for the reason `dispatchStatus` is — "which challans
 * have not been billed" is a question somebody sits down to answer, and working
 * it out by opening the sheet for every row of every page is the unindexed work
 * M0 cannot afford. Derived from the rows and rewritten, never incremented, and
 * it **never throws**: a status one write behind is a filter reading slightly
 * stale, not a reason to refuse the bill that was actually made.
 */

type IdLike = Types.ObjectId | string

const CHUNK = 200

/** A row is billed when its `bill` is set. */
const IS_BILLED = { $ne: [{ $ifNull: ['$bill', null] }, null] }

function toObjectIds(ids: readonly (IdLike | null | undefined)[]): Types.ObjectId[] {
  const unique = new Set(ids.filter(Boolean).map(String))
  return [...unique].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id))
}

function billNumbersOf(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
}

/** Only a record whose status or bill numbers actually differ is written. */
function changedFilter(id: Types.ObjectId, status: BillingStatus, billNumbers: string[]) {
  return {
    _id: id,
    $or: [{ billStatus: { $ne: status } }, { billNumbers: { $ne: billNumbers } }] as [
      { billStatus: { $ne: BillingStatus } },
      { billNumbers: { $ne: string[] } },
    ],
  }
}

async function refreshChallans(ids: Types.ObjectId[]): Promise<void> {
  const groups = await TripDoLineModel.aggregate<{
    _id: Types.ObjectId
    rows: number
    billedRows: number
    billNumbers: (string | null)[]
  }>([
    { $match: { challanId: { $in: ids } } },
    {
      $group: {
        _id: '$challanId',
        rows: { $sum: 1 },
        billedRows: { $sum: { $cond: [IS_BILLED, 1, 0] } },
        billNumbers: { $addToSet: '$bill.billNumber' },
      },
    },
  ])
  const byId = new Map(groups.map((group) => [String(group._id), group]))

  const writes = ids.map((id) => {
    const group = byId.get(String(id))
    const status = challanBillingStatusFor(group?.rows ?? 0, group?.billedRows ?? 0)
    const billNumbers = billNumbersOf(group?.billNumbers ?? [])
    return {
      updateOne: {
        filter: changedFilter(id, status, billNumbers),
        update: { $set: { billStatus: status, billNumbers } },
      },
    }
  })

  if (writes.length > 0) {
    await ChallanModel.bulkWrite(writes, { ordered: false })
  }
}

async function refreshGatePasses(ids: Types.ObjectId[]): Promise<void> {
  const [groups, gatePasses] = await Promise.all([
    TripDoLineModel.aggregate<{
      _id: Types.ObjectId
      billedRows: number
      unbilledRows: number
      billedOrderQty: number
      billNumbers: (string | null)[]
    }>([
      { $match: { 'link.gatePassId': { $in: ids } } },
      {
        $group: {
          _id: '$link.gatePassId',
          billedRows: { $sum: { $cond: [IS_BILLED, 1, 0] } },
          unbilledRows: { $sum: { $cond: [IS_BILLED, 0, 1] } },
          billedOrderQty: {
            $sum: { $cond: [{ $and: [IS_BILLED, { $eq: ['$kind', 'Order'] }] }, '$qty', 0] },
          },
          billNumbers: { $addToSet: '$bill.billNumber' },
        },
      },
    ]),
    GatePassModel.find({ _id: { $in: ids } }).select('items.qty'),
  ])
  const byId = new Map(groups.map((group) => [String(group._id), group]))

  const writes = gatePasses.map((gatePass) => {
    const group = byId.get(String(gatePass._id))
    const status = gatePassBillingStatusFor({
      totalQty: gatePass.items.reduce((sum, item) => sum + item.qty, 0),
      billedOrderQty: group?.billedOrderQty ?? 0,
      billedRows: group?.billedRows ?? 0,
      unbilledRows: group?.unbilledRows ?? 0,
    })
    const billNumbers = billNumbersOf(group?.billNumbers ?? [])
    return {
      updateOne: {
        filter: changedFilter(gatePass._id, status, billNumbers),
        update: { $set: { billStatus: status, billNumbers } },
      },
    }
  })

  if (writes.length > 0) {
    await GatePassModel.bulkWrite(writes, { ordered: false })
  }
}

export async function refreshBillingStatus(targets: {
  challanIds?: readonly (IdLike | null | undefined)[]
  gatePassIds?: readonly (IdLike | null | undefined)[]
}): Promise<void> {
  const challanIds = toObjectIds(targets.challanIds ?? [])
  const gatePassIds = toObjectIds(targets.gatePassIds ?? [])

  try {
    for (let start = 0; start < challanIds.length; start += CHUNK) {
      await refreshChallans(challanIds.slice(start, start + CHUNK))
    }
    for (let start = 0; start < gatePassIds.length; start += CHUNK) {
      await refreshGatePasses(gatePassIds.slice(start, start + CHUNK))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[bill] billing status not refreshed: ${message}`)
  }
}

/**
 * Refuses deleting a challan any of whose rows is on a bill. The bill keeps its
 * own copy and would still print, but the row behind it would be gone and the
 * charge would have no paperwork left — the same reason a challan on a trip
 * cannot be deleted.
 */
export async function assertChallanNotBilled(challanId: IdLike): Promise<void> {
  const row = await TripDoLineModel.findOne({ challanId, bill: { $ne: null } }).select('bill')

  if (row?.bill) {
    throw new AppError(
      409,
      `This challan is on bill ${row.bill.billNumber}. Take its rows off that bill before deleting it.`,
    )
  }
}

/**
 * Gives every challan and gate pass a billing status, and recomputes the ones
 * any bill touches. Run on boot after the Trip DO sheet is built. Idempotent,
 * and it never throws.
 */
export async function backfillBillingStatus(): Promise<void> {
  try {
    const unset = { billStatus: { $exists: false } }
    const initial = { $set: { billStatus: 'Unbilled' as BillingStatus, billNumbers: [] as string[] } }
    await Promise.all([ChallanModel.updateMany(unset, initial), GatePassModel.updateMany(unset, initial)])

    const notUnbilled = { billStatus: { $in: ['Partial', 'Billed'] as BillingStatus[] } }
    const [billedChallans, billedGatePasses, markedChallans, markedGatePasses] = await Promise.all([
      TripDoLineModel.distinct('challanId', { bill: { $ne: null } }),
      TripDoLineModel.distinct('link.gatePassId', { bill: { $ne: null } }),
      ChallanModel.distinct('_id', notUnbilled),
      GatePassModel.distinct('_id', notUnbilled),
    ])

    await refreshBillingStatus({
      challanIds: [...billedChallans, ...markedChallans] as IdLike[],
      gatePassIds: [...billedGatePasses, ...markedGatePasses] as IdLike[],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[bill] billing status backfill skipped: ${message}`)
  }
}
