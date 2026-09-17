import { Types } from 'mongoose'
import { settlementStatusFor } from './accounts.constants'
import { EntryModel, FinalBillModel } from './accounts.model'

type IdLike = Types.ObjectId | string | null | undefined

async function sumAmount(match: Record<string, unknown>): Promise<number> {
  const [row] = await EntryModel.aggregate<{ total: number }>([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ])
  return row?.total ?? 0
}

/**
 * How much of an advance has been accounted for — returned in cash or accepted
 * as an expense — written onto the advance. Derived from the settlements every
 * time rather than incremented, so a failed write is put right by the next one.
 */
export async function refreshAdvanceSettlement(advanceId: IdLike): Promise<void> {
  if (!advanceId) {
    return
  }
  const advance = await EntryModel.findById(advanceId).select('kind amount')
  if (!advance || advance.kind !== 'Advance') {
    return
  }
  const settled = await sumAmount({ advanceId: advance._id, kind: { $in: ['AdvanceReturn', 'AdvanceAdjust'] } })

  await EntryModel.updateOne(
    { _id: advance._id },
    { $set: { settledAmount: settled, settlementStatus: settlementStatusFor(advance.amount, settled) } },
  )
}

/** How much of a Walton final bill has arrived, written onto the bill — derived, like an advance's. */
export async function refreshFinalBillReceipts(finalBillId: IdLike): Promise<void> {
  if (!finalBillId) {
    return
  }
  const bill = await FinalBillModel.findById(finalBillId).select('finalAmount')
  if (!bill) {
    return
  }
  const received = await sumAmount({ finalBillId: bill._id, kind: 'Deposit' })

  await FinalBillModel.updateOne(
    { _id: bill._id },
    { $set: { receivedAmount: received, paymentStatus: settlementStatusFor(bill.finalAmount, received) } },
  )
}

/**
 * Aggregation does no schema casting, unlike a `find`, so every id that goes
 * into a `$match` is made an ObjectId first — a string matches nothing.
 */
function oid(id: Types.ObjectId | string): Types.ObjectId {
  return new Types.ObjectId(String(id))
}

/** Everything settled against one advance, or received against one final bill, other than one entry. */
export function settledAgainstAdvance(advanceId: Types.ObjectId | string, exceptEntryId?: IdLike): Promise<number> {
  return sumAmount({
    advanceId: oid(advanceId),
    kind: { $in: ['AdvanceReturn', 'AdvanceAdjust'] },
    ...(exceptEntryId ? { _id: { $ne: oid(exceptEntryId) } } : {}),
  })
}

export function receivedAgainstFinalBill(
  finalBillId: Types.ObjectId | string,
  exceptEntryId?: IdLike,
): Promise<number> {
  return sumAmount({
    finalBillId: oid(finalBillId),
    kind: 'Deposit',
    ...(exceptEntryId ? { _id: { $ne: oid(exceptEntryId) } } : {}),
  })
}
