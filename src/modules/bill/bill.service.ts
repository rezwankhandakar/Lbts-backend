import type { QueryFilter, Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { nextSequence } from '../../utils/counter'
import { recordActivity } from '../activity/activity.recorder'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import { MONEY_AUDIENCE_ROLES } from '../notification/notification.constants'
import { notify } from '../notification/notification.recorder'
import { GatePassModel } from '../gate-pass/gate-pass.model'
import { TripDoLineModel } from '../trip-do/trip-do.model'
import type { TripDoLineDocument } from '../trip-do/trip-do.model'
import type { UserRole } from '../user/user.constants'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import {
  BILL_REVIEW_ROLES,
  arrangeBillLines,
  billPeriodLabel,
  formatBillNumber,
} from './bill.constants'
import { BillLineModel, BillModel } from './bill.model'
import type { Bill, BillDocument, BillLineDocument } from './bill.model'
import { toBillLineRecord, toBillRecord } from './bill.serializer'
import type { BillDetail, BillLineRecord, BillRecord, LineDrift } from './bill.serializer'
import { snapshotHashOf, snapshotOf } from './bill.snapshot'
import { refreshBillingStatus } from './bill.status'
import type { CreateBillInput, ListBillsQuery, UpdateBillInput } from './bill.validation'

/**
 * A bill as a record: opening one, reading one, correcting its period, and
 * moving it through its two states. What a bill *carries* — searching the Trip
 * DO sheet, adding and removing rows — is `bill.lines.ts`.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function findBill(id: string): Promise<BillDocument> {
  const bill = await BillModel.findById(id)
  if (!bill) {
    throw new AppError(404, 'Bill not found.')
  }
  return bill
}

/** A finalized bill is a figure somebody has been asked to pay; it changes only after a reviewer reopens it. */
export function assertDraft(bill: BillDocument): void {
  if (bill.status !== 'Draft') {
    throw new AppError(
      409,
      `${bill.billNumber} is finalized. An Admin or Manager has to reopen it before what it carries can change.`,
    )
  }
}

export function isBillReviewer(actor: UserDocument): boolean {
  return BILL_REVIEW_ROLES.includes(actor.role as UserRole)
}

async function resolveNames(ids: (Types.ObjectId | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  if (unique.length === 0) {
    return new Map()
  }
  const users = await UserModel.find({ _id: { $in: unique } }).select('name')
  return new Map(users.map((user) => [String(user._id), user.name]))
}

function actorIdsOf(bill: BillDocument): (Types.ObjectId | null | undefined)[] {
  return [bill.createdBy, bill.updatedBy, bill.finalizedBy, bill.reopenedBy]
}

export async function serializeBill(bill: BillDocument): Promise<BillRecord> {
  return toBillRecord(bill, await resolveNames(actorIdsOf(bill)))
}

/**
 * The bill's totals, from its lines. Derived and rewritten after every change,
 * never incremented, so a failed write can never leave a total the lines do not
 * add up to for longer than the next change.
 */
export async function refreshBillTotals(billId: Types.ObjectId, actor?: UserDocument): Promise<void> {
  const [row] = await BillLineModel.aggregate<{
    lineCount: number
    totalQty: number
    totalAmount: number
    unpricedLines: number
    tripDoKeys: string[]
    challanIds: unknown[]
  }>([
    { $match: { billId } },
    {
      $group: {
        _id: null,
        lineCount: { $sum: 1 },
        totalQty: { $sum: '$qty' },
        totalAmount: { $sum: { $ifNull: ['$amount', 0] } },
        unpricedLines: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$amount', null] }, null] }, 1, 0] } },
        tripDoKeys: { $addToSet: '$tripDoKey' },
        challanIds: { $addToSet: '$challanId' },
      },
    },
  ])

  await BillModel.updateOne(
    { _id: billId },
    {
      $set: {
        lineCount: row?.lineCount ?? 0,
        totalQty: row?.totalQty ?? 0,
        totalAmount: Math.round((row?.totalAmount ?? 0) * 100) / 100,
        unpricedLines: row?.unpricedLines ?? 0,
        tripDoCount: row?.tripDoKeys.length ?? 0,
        challanCount: row?.challanIds.length ?? 0,
        ...(actor ? { updatedBy: actor._id } : {}),
      },
    },
  )
}

export interface BillLinesState {
  lines: BillLineDocument[]
  rows: Map<string, TripDoLineDocument>
  drift: Map<string, LineDrift>
}

/**
 * Every line of a bill, and whether the sheet row behind each still says what
 * the line copied. One read for the lines and one for the rows, however long
 * the bill.
 */
export async function readBillLines(bill: BillDocument): Promise<BillLinesState> {
  const lines = await BillLineModel.find({ billId: bill._id }).sort({ seq: 1 })
  const found = await TripDoLineModel.find({ _id: { $in: lines.map((line) => line.tripDoLineId) } })
  const rows = new Map(found.map((row) => [String(row._id), row]))
  const drift = new Map<string, LineDrift>()

  for (const line of lines) {
    const row = rows.get(String(line.tripDoLineId))
    let state: LineDrift = 'none'
    if (!row || !row.link || String(row.bill?.billId) !== String(bill._id)) {
      state = 'missing'
    } else if (snapshotHashOf(snapshotOf(row)) !== line.snapshotHash) {
      state = 'changed'
    }
    drift.set(String(line._id), state)
  }

  return { lines, rows, drift }
}

function countDrift(drift: Map<string, LineDrift>): { changed: number; missing: number } {
  const states = [...drift.values()]
  return {
    changed: states.filter((state) => state === 'changed').length,
    missing: states.filter((state) => state === 'missing').length,
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface BillTotals {
  total: number
  totalQty: number
  totalAmount: number
  draftBills: number
  finalizedBills: number
}

export async function listBills(
  query: ListBillsQuery,
): Promise<{ records: BillRecord[]; totals: BillTotals }> {
  const clauses: QueryFilter<Bill>[] = []

  if (query.status !== 'all') clauses.push({ status: query.status })
  if (query.year) clauses.push({ year: query.year })
  if (query.month) clauses.push({ month: query.month })
  if (query.unit) clauses.push({ unitKey: comparisonKey(query.unit) })
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({ $or: [{ billNumber: pattern }, { unit: pattern }, { note: pattern }] })
  }

  const filter: QueryFilter<Bill> = clauses.length > 0 ? { $and: clauses } : {}

  const [bills, [totals]] = await Promise.all([
    BillModel.find(filter)
      .sort({ year: -1, month: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    BillModel.aggregate<BillTotals>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          totalQty: { $sum: '$totalQty' },
          totalAmount: { $sum: '$totalAmount' },
          draftBills: { $sum: { $cond: [{ $eq: ['$status', 'Draft'] }, 1, 0] } },
          finalizedBills: { $sum: { $cond: [{ $eq: ['$status', 'Finalized'] }, 1, 0] } },
        },
      },
    ]),
  ])

  const names = await resolveNames(bills.flatMap(actorIdsOf))

  return {
    records: bills.map((bill) => toBillRecord(bill, names)),
    totals: {
      total: totals?.total ?? 0,
      totalQty: totals?.totalQty ?? 0,
      totalAmount: Math.round((totals?.totalAmount ?? 0) * 100) / 100,
      draftBills: totals?.draftBills ?? 0,
      finalizedBills: totals?.finalizedBills ?? 0,
    },
  }
}

/** Units the operation writes on its gate passes, for the bill slot's type-ahead. */
export async function listBillUnits(): Promise<string[]> {
  const [fromGatePasses, fromBills] = await Promise.all([
    GatePassModel.distinct('unit'),
    BillModel.distinct('unit'),
  ])
  const units = new Set([...fromGatePasses, ...fromBills].map((unit) => String(unit).trim()).filter(Boolean))
  return [...units].sort()
}

export function arrangeLines(
  lines: BillLineDocument[],
  drift: Map<string, LineDrift>,
  names: Map<string, string>,
): BillLineRecord[] {
  return arrangeBillLines(lines.map((line) => ({ line, tripDoKey: line.tripDoKey, seq: line.seq }))).map(
    (entry) => toBillLineRecord(entry.line, entry, drift.get(String(entry.line._id)) ?? 'none', names),
  )
}

export async function getBillDetail(id: string): Promise<BillDetail> {
  const bill = await findBill(id)
  const { lines, drift } = await readBillLines(bill)
  const names = await resolveNames([...actorIdsOf(bill), ...lines.map((line) => line.addedBy)])

  return {
    bill: toBillRecord(bill, names),
    lines: arrangeLines(lines, drift, names),
    drift: countDrift(drift),
  }
}

// ---------------------------------------------------------------------------
// Writing the record
// ---------------------------------------------------------------------------

export async function createBill(input: CreateBillInput, actor: UserDocument): Promise<BillRecord> {
  const unit = input.unit.trim().toUpperCase()
  const sequence = await nextSequence(`bill:${input.year}`)

  const bill = await BillModel.create({
    billNumber: formatBillNumber(input.year, sequence),
    month: input.month,
    year: input.year,
    unit,
    unitKey: comparisonKey(unit),
    note: input.note,
    createdBy: actor._id,
  })

  await recordActivity({
    action: 'bill.created',
    entityType: 'Bill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} opened for unit ${bill.unit}, ${billPeriodLabel(bill.month, bill.year)}`,
    actor,
  })

  return serializeBill(bill)
}

/**
 * Correcting a draft's period, unit or note. The unit is what every row on the
 * bill was checked against, so it can change only while the bill carries none.
 * The bill number keeps the year it was given: a number is never reissued.
 */
export async function updateBill(
  id: string,
  input: UpdateBillInput,
  actor: UserDocument,
): Promise<BillRecord> {
  const bill = await findBill(id)
  assertDraft(bill)

  if (input.unit !== undefined) {
    const unit = input.unit.trim().toUpperCase()
    if (comparisonKey(unit) !== bill.unitKey && bill.lineCount > 0) {
      throw new AppError(
        409,
        `${bill.billNumber} already carries ${bill.unit} rows. Take them off before changing its unit.`,
      )
    }
    bill.unit = unit
    bill.unitKey = comparisonKey(unit)
  }
  if (input.month !== undefined) bill.month = input.month
  if (input.year !== undefined) bill.year = input.year
  if (input.note !== undefined) bill.note = input.note

  bill.updatedBy = actor._id
  await bill.save()
  return serializeBill(bill)
}

/**
 * Deleting a draft releases every row it held back to the Trip DO sheet. A
 * finalized bill is reopened first — deleting a bill that was sent is not
 * something one press should do. The person who opened it deletes it, and so
 * do Admin and Manager.
 */
export async function deleteBill(
  id: string,
  actor: UserDocument,
): Promise<{ id: string; billNumber: string; released: number }> {
  const bill = await findBill(id)
  assertDraft(bill)

  if (!isBillReviewer(actor) && String(bill.createdBy) !== String(actor._id)) {
    throw new AppError(403, 'Only the person who opened this bill, or an Admin or Manager, can delete it.')
  }

  const lines = await BillLineModel.find({ billId: bill._id }).select('challanId gatePassId')

  await TripDoLineModel.updateMany({ 'bill.billId': bill._id }, { $set: { bill: null } })
  await BillLineModel.deleteMany({ billId: bill._id })
  await bill.deleteOne()
  await refreshBillingStatus({
    challanIds: lines.map((line) => line.challanId),
    gatePassIds: lines.map((line) => line.gatePassId),
  })

  /**
   * How many sheet rows it let go is the part worth recording. Deleting a bill
   * releases its claim on every Trip DO row it carried, which is what makes
   * those rows billable again — so a row reappearing on somebody else's bill a
   * week later has this as its explanation.
   */
  await recordActivity({
    action: 'bill.deleted',
    entityType: 'Bill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} (unit ${bill.unit}, ${billPeriodLabel(bill.month, bill.year)}) deleted — ${
      lines.length
    } sheet ${lines.length === 1 ? 'row is' : 'rows are'} billable again`,
    actor,
  })

  return { id: String(bill._id), billNumber: bill.billNumber, released: lines.length }
}

/**
 * Signing a bill off. Refused while it is empty, and refused while any row has
 * moved on the Trip DO sheet since it was added — a bill finalized over a stale
 * copy would charge what the sheet no longer says, and nothing afterwards would
 * notice.
 */
export async function finalizeBill(id: string, actor: UserDocument): Promise<BillRecord> {
  const bill = await findBill(id)

  if (bill.status === 'Finalized') {
    throw new AppError(409, `${bill.billNumber} is already finalized.`)
  }
  if (bill.lineCount === 0) {
    throw new AppError(409, 'An empty bill cannot be finalized. Add its Trip DOs first.')
  }

  const { drift } = await readBillLines(bill)
  const moved = [...drift.values()].filter((state) => state !== 'none').length
  if (moved > 0) {
    throw new AppError(
      409,
      `${moved} ${moved === 1 ? 'row has' : 'rows have'} changed on the Trip DO sheet since ${
        moved === 1 ? 'it was' : 'they were'
      } added. Refresh the bill so it charges what the sheet says, then finalize it.`,
    )
  }

  bill.status = 'Finalized'
  bill.finalizedAt = new Date()
  bill.finalizedBy = actor._id
  bill.updatedBy = actor._id
  await bill.save()

  /**
   * The totals go into the row. A finalized bill can be reopened, changed and
   * finalized again, and the record only ever holds the latest figure — so
   * "what was unit WFR charged for August when we sent it" is a question only
   * a journal can answer once somebody has reopened it.
   */
  await recordActivity({
    action: 'bill.finalized',
    entityType: 'Bill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} finalized — ${bill.lineCount} rows, ${bill.totalQty} pcs, ৳${bill.totalAmount.toLocaleString('en-BD')}`,
    changes: [
      { field: 'status', label: 'Status', from: 'Draft', to: 'Finalized' },
      { field: 'totalAmount', label: 'Total', from: null, to: String(bill.totalAmount) },
    ],
    actor,
  })

  /**
   * And the roles who read the books are told what was signed off.
   *
   * `MONEY_AUDIENCE_ROLES` is Accounts' own read audience rather than this
   * module's, deliberately: the message carries an amount, and announcing a
   * figure to somebody who may not read figures would be a leak by
   * announcement. It also happens to be who needs it — a finalized Excel bill
   * is what Walton is asked to audit, and the final bill Accounts is waiting for
   * is the answer to this one.
   */
  await notify({
    event: 'bill.finalized',
    audience: { kind: 'roles', roles: MONEY_AUDIENCE_ROLES },
    title: `${bill.billNumber} finalized — ৳${bill.totalAmount.toLocaleString('en-BD')}`,
    body: `Unit ${bill.unit}, ${billPeriodLabel(bill.month, bill.year)} · ${bill.lineCount} ${
      bill.lineCount === 1 ? 'row' : 'rows'
    }, ${bill.totalQty} pcs. Record Walton's audited figure against it when it comes back.`,
    entityType: 'Bill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    actor,
  })

  return serializeBill(bill)
}

export async function reopenBill(id: string, actor: UserDocument): Promise<BillRecord> {
  const bill = await findBill(id)

  if (bill.status !== 'Finalized') {
    throw new AppError(409, `${bill.billNumber} is not finalized, so there is nothing to reopen.`)
  }

  bill.status = 'Draft'
  bill.reopenedAt = new Date()
  bill.reopenedBy = actor._id
  bill.updatedBy = actor._id
  await bill.save()

  await recordActivity({
    action: 'bill.reopened',
    entityType: 'Bill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} reopened — it was finalized at ৳${bill.totalAmount.toLocaleString('en-BD')}`,
    changes: [{ field: 'status', label: 'Status', from: 'Finalized', to: 'Draft' }],
    actor,
  })

  return serializeBill(bill)
}
