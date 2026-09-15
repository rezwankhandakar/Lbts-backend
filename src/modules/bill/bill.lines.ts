import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import { TripDoLineModel } from '../trip-do/trip-do.model'
import type { TripDoLine, TripDoLineDocument } from '../trip-do/trip-do.model'
import type { UserDocument } from '../user/user.model'
import {
  MAX_BILL_LINES,
  MAX_CANDIDATE_GROUPS,
  MAX_CANDIDATE_ROWS,
  billPeriodRange,
} from './bill.constants'
import { BillLineModel } from './bill.model'
import { toCandidateRow } from './bill.serializer'
import type { BillCandidateGroup, BillCandidates } from './bill.serializer'
import { snapshotHashOf, snapshotOf } from './bill.snapshot'
import {
  assertDraft,
  escapeRegex,
  findBill,
  readBillLines,
  refreshBillTotals,
} from './bill.service'
import { refreshBillingStatus } from './bill.status'
import type { AddBillLinesInput, RemoveBillLinesInput } from './bill.validation'

/**
 * What a bill carries: finding Trip DO sheet rows, adding them, taking them
 * off, and bringing a draft's copies back in step with the sheet.
 *
 * **A row is claimed on the sheet before a line is written.** The claim is a
 * conditional `updateMany` on `bill: null`, so two bills racing for one row
 * cannot both win it, and the unique index on a line's `tripDoLineId` is the
 * floor under that. A claim whose line then fails to write is released, so the
 * worst a failure leaves is a row to add again — never a row marked billed on a
 * bill that does not show it.
 */

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

/** The sheet's order within one bill addition: by trip date, Trip DO, then the challan's printed order. */
function compareForBill(a: TripDoLineDocument, b: TripDoLineDocument): number {
  return (
    (a.link?.tripDate.getTime() ?? 0) - (b.link?.tripDate.getTime() ?? 0) ||
    a.tripDoKey.localeCompare(b.tripDoKey) ||
    a.challanDate.getTime() - b.challanDate.getTime() ||
    a.slNumber - b.slNumber ||
    a.position - b.position ||
    a.rowSeq - b.rowSeq ||
    a.splitIndex - b.splitIndex
  )
}

/**
 * Trip DO sheet rows a bill could take, grouped by Trip DO.
 *
 * Typed, it answers a Trip DO prefix or a gate pass number — whatever the
 * paper in front of the operator carries — whether or not the rows are billed,
 * so "already on LBTS-BILL-…" is something they are told rather than a Trip DO
 * that silently fails to appear. Blank, it suggests the bill's own unit and
 * month with nothing billed yet: the list a month-end bill is made from.
 */
export async function listBillCandidates(billId: string, q: string): Promise<BillCandidates> {
  const bill = await findBill(billId)
  const linked: QueryFilter<TripDoLine> = { link: { $ne: null } }
  let filter: QueryFilter<TripDoLine>

  if (q) {
    const key = comparisonKey(q)
    const or: QueryFilter<TripDoLine>[] = [{ 'link.gatePassNumber': new RegExp(escapeRegex(q), 'i') }]
    if (key) {
      or.push({ tripDoKey: new RegExp(`^${escapeRegex(key)}`) })
    }
    filter = { $and: [linked, { $or: or }] }
  } else {
    const { start, end } = billPeriodRange(bill.month, bill.year)
    filter = {
      $and: [linked, { bill: null }, { 'link.unit': bill.unit }, { 'link.tripDate': { $gte: start, $lt: end } }],
    }
  }

  const rows = await TripDoLineModel.find(filter)
    .sort({ 'link.tripDate': q ? -1 : 1, tripDoKey: 1, challanDate: 1, slNumber: 1, position: 1, rowSeq: 1, splitIndex: 1 })
    .limit(MAX_CANDIDATE_ROWS + 1)

  let truncated = rows.length > MAX_CANDIDATE_ROWS
  const groups = new Map<string, BillCandidateGroup>()

  for (const row of rows.slice(0, MAX_CANDIDATE_ROWS)) {
    const link = row.link
    if (!link) {
      continue
    }

    const key = row.tripDoKey || comparisonKey(link.tripDo)
    let group = groups.get(key)
    if (!group) {
      if (groups.size >= MAX_CANDIDATE_GROUPS) {
        truncated = true
        continue
      }
      group = {
        tripDo: link.tripDo,
        tripDoKey: key,
        tripDate: link.tripDate.toISOString().slice(0, 10),
        gatePassNumbers: [],
        csd: link.csd,
        unit: link.unit,
        unitMatches: true,
        qty: 0,
        amount: 0,
        rows: [],
        addableRowIds: [],
        onThisBill: 0,
        otherBills: [],
      }
      groups.set(key, group)
    }

    const record = toCandidateRow(row)
    const unitMatches = comparisonKey(link.unit) === bill.unitKey
    group.rows.push(record)
    group.qty += record.qty
    group.amount = roundMoney(group.amount + (record.amount ?? 0))
    group.unitMatches = group.unitMatches && unitMatches
    if (!group.gatePassNumbers.includes(link.gatePassNumber)) {
      group.gatePassNumbers.push(link.gatePassNumber)
    }

    if (!row.bill) {
      if (unitMatches) group.addableRowIds.push(record.id)
    } else if (String(row.bill.billId) === String(bill._id)) {
      group.onThisBill += 1
    } else if (!group.otherBills.includes(row.bill.billNumber)) {
      group.otherBills.push(row.bill.billNumber)
    }
  }

  return { mode: q ? 'search' : 'month', groups: [...groups.values()], truncated }
}

export interface AddBillLinesResult {
  billNumber: string
  added: number
  /** Rows named that were already on this bill. */
  skipped: number
  tripDoCount: number
}

/**
 * Adds Trip DO sheet rows to a draft bill. All or nothing on the checks: every
 * row must still be on the sheet, carry a Trip DO, be of the bill's unit and be
 * on no other bill — a partial add would leave the operator working out which
 * of forty ticked rows actually landed.
 */
export async function addBillLines(
  billId: string,
  input: AddBillLinesInput,
  actor: UserDocument,
): Promise<AddBillLinesResult> {
  const bill = await findBill(billId)
  assertDraft(bill)

  const rows = await TripDoLineModel.find({ _id: { $in: input.rowIds } })
  if (rows.length !== input.rowIds.length) {
    throw new AppError(404, 'Some of those rows are no longer on the Trip DO sheet. Search again and retry.')
  }

  for (const row of rows) {
    const label = `${row.challanNumber} · ${row.productModel || row.productName}`
    if (!row.link) {
      throw new AppError(409, `${label} has no Trip DO yet. Set it on the Trip DO sheet first.`)
    }
    if (comparisonKey(row.link.unit) !== bill.unitKey) {
      throw new AppError(
        409,
        `Trip DO ${row.link.tripDo} is unit ${row.link.unit || '(blank)'}, and ${bill.billNumber} is a ${bill.unit} bill.`,
      )
    }
    if (row.bill && String(row.bill.billId) !== String(bill._id)) {
      throw new AppError(409, `Trip DO ${row.link.tripDo} · ${label} is already on ${row.bill.billNumber}.`)
    }
  }

  const fresh = rows.filter((row) => !row.bill)
  if (fresh.length === 0) {
    return { billNumber: bill.billNumber, added: 0, skipped: rows.length, tripDoCount: bill.tripDoCount }
  }
  if (bill.lineCount + fresh.length > MAX_BILL_LINES) {
    throw new AppError(
      422,
      `A bill carries at most ${MAX_BILL_LINES} rows, and this one already has ${bill.lineCount}. Open a second bill for the rest.`,
    )
  }

  const now = new Date()
  const ids = fresh.map((row) => row._id)
  await TripDoLineModel.updateMany(
    { _id: { $in: ids }, bill: null, link: { $ne: null } },
    { $set: { bill: { billId: bill._id, billNumber: bill.billNumber, billedAt: now, billedBy: actor._id } } },
  )
  const claimed = (await TripDoLineModel.find({ _id: { $in: ids }, 'bill.billId': bill._id })).sort(compareForBill)

  const last = await BillLineModel.findOne({ billId: bill._id }).sort({ seq: -1 }).select('seq')
  let seq = last?.seq ?? 0
  const documents = claimed.map((row) => {
    const snapshot = snapshotOf(row)
    seq += 1
    return {
      billId: bill._id,
      tripDoLineId: row._id,
      seq,
      ...snapshot,
      snapshotHash: snapshotHashOf(snapshot),
      addedAt: now,
      addedBy: actor._id,
    }
  })

  try {
    await BillLineModel.insertMany(documents, { ordered: false })
  } catch {
    const written = await BillLineModel.find({ billId: bill._id, tripDoLineId: { $in: ids } }).select('tripDoLineId')
    const kept = new Set(written.map((line) => String(line.tripDoLineId)))
    const orphaned = claimed.filter((row) => !kept.has(String(row._id))).map((row) => row._id)
    if (orphaned.length > 0) {
      await TripDoLineModel.updateMany({ _id: { $in: orphaned }, 'bill.billId': bill._id }, { $set: { bill: null } })
    }
    await refreshBillTotals(bill._id, actor)
    throw new AppError(409, 'Some of those rows were billed somewhere else at the same moment. Search again and retry.')
  }

  await refreshBillTotals(bill._id, actor)
  await refreshBillingStatus({
    challanIds: claimed.map((row) => row.challanId),
    gatePassIds: claimed.map((row) => row.link?.gatePassId),
  })

  return {
    billNumber: bill.billNumber,
    added: documents.length,
    skipped: rows.length - documents.length,
    tripDoCount: new Set(claimed.map((row) => row.tripDoKey)).size,
  }
}

/** Takes lines off a draft bill and releases their rows back to the sheet. */
export async function removeBillLines(
  billId: string,
  input: RemoveBillLinesInput,
  actor: UserDocument,
): Promise<{ billNumber: string; removed: number }> {
  const bill = await findBill(billId)
  assertDraft(bill)

  const lines = await BillLineModel.find({ _id: { $in: input.lineIds }, billId: bill._id })
  if (lines.length === 0) {
    throw new AppError(404, 'Those rows are no longer on this bill.')
  }

  await BillLineModel.deleteMany({ _id: { $in: lines.map((line) => line._id) } })
  await TripDoLineModel.updateMany(
    { _id: { $in: lines.map((line) => line.tripDoLineId) }, 'bill.billId': bill._id },
    { $set: { bill: null } },
  )
  await refreshBillTotals(bill._id, actor)
  await refreshBillingStatus({
    challanIds: lines.map((line) => line.challanId),
    gatePassIds: lines.map((line) => line.gatePassId),
  })

  return { billNumber: bill.billNumber, removed: lines.length }
}

/**
 * Brings a draft's copies back in step with the Trip DO sheet: a line whose row
 * changed is copied again, and a line whose row is gone — its challan corrected
 * away — is taken off. A finalized bill is never refreshed; it says what was
 * charged when it was signed.
 */
export async function refreshBillLines(
  billId: string,
  actor: UserDocument,
): Promise<{ billNumber: string; updated: number; removed: number }> {
  const bill = await findBill(billId)
  assertDraft(bill)

  const { lines, rows, drift } = await readBillLines(bill)
  const missing = lines.filter((line) => drift.get(String(line._id)) === 'missing')
  const changed = lines.filter((line) => drift.get(String(line._id)) === 'changed')

  if (missing.length > 0) {
    await BillLineModel.deleteMany({ _id: { $in: missing.map((line) => line._id) } })
    await TripDoLineModel.updateMany(
      { _id: { $in: missing.map((line) => line.tripDoLineId) }, 'bill.billId': bill._id },
      { $set: { bill: null } },
    )
  }

  const gatePassIds = [...missing, ...changed].map((line) => line.gatePassId)
  const writes = changed.flatMap((line) => {
    const row = rows.get(String(line.tripDoLineId))
    if (!row) {
      return []
    }
    const snapshot = snapshotOf(row)
    gatePassIds.push(snapshot.gatePassId)
    return [
      {
        updateOne: {
          filter: { _id: line._id },
          update: { $set: { ...snapshot, snapshotHash: snapshotHashOf(snapshot) } },
        },
      },
    ]
  })
  if (writes.length > 0) {
    await BillLineModel.bulkWrite(writes)
  }

  await refreshBillTotals(bill._id, actor)
  await refreshBillingStatus({
    challanIds: [...missing, ...changed].map((line) => line.challanId),
    gatePassIds,
  })

  return { billNumber: bill.billNumber, updated: writes.length, removed: missing.length }
}
