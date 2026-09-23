import type { QueryFilter, Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { nextSequence } from '../../utils/counter'
import { recordActivity } from '../activity/activity.recorder'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import { TripDoLineModel } from '../trip-do/trip-do.model'
import type { TripDoLineDocument } from '../trip-do/trip-do.model'
import type { UserRole } from '../user/user.constants'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import {
  LABOUR_BILL_REVIEW_ROLES,
  formatLabourBillNumber,
  groupLabourLinesByCsd,
  labourBillPeriodLabel,
  labourGroupLabel,
} from './labour-bill.constants'
import { labourCopyHashOf, labourCopyOf } from './labour-bill.copy'
import { LabourBillLineModel, LabourBillModel } from './labour-bill.model'
import type { LabourBill, LabourBillDocument, LabourBillLineDocument } from './labour-bill.model'
import {
  labourGroupTotals,
  toLabourBillLineRecord,
  toLabourBillRecord,
} from './labour-bill.serializer'
import type {
  LabourBillDetail,
  LabourBillRecord,
  LabourLineDrift,
} from './labour-bill.serializer'
import type { CreateLabourBillInput, ListLabourBillsQuery, UpdateLabourBillInput } from './labour-bill.validation'

/**
 * A Walton Labour Bill as a record: opening a slot, reading one, correcting its
 * period, and moving it through its two states. What a bill *carries* — the
 * barcode scan, the rows, and the amounts typed into them — is
 * `labour-bill.lines.ts`.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function findLabourBill(id: string): Promise<LabourBillDocument> {
  const bill = await LabourBillModel.findById(id)
  if (!bill) {
    throw new AppError(404, 'Labour bill not found.')
  }
  return bill
}

/** A finalized bill is a figure somebody has been asked to pay; it changes only after a reviewer reopens it. */
export function assertLabourDraft(bill: LabourBillDocument): void {
  if (bill.status !== 'Draft') {
    throw new AppError(
      409,
      `${bill.billNumber} is finalized. An Admin or Manager has to reopen it before what it carries can change.`,
    )
  }
}

export function isLabourBillReviewer(actor: UserDocument): boolean {
  return LABOUR_BILL_REVIEW_ROLES.includes(actor.role as UserRole)
}

export async function resolveNames(
  ids: (Types.ObjectId | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  if (unique.length === 0) {
    return new Map()
  }
  const users = await UserModel.find({ _id: { $in: unique } }).select('name')
  return new Map(users.map((user) => [String(user._id), user.name]))
}

function actorIdsOf(bill: LabourBillDocument): (Types.ObjectId | null | undefined)[] {
  return [bill.createdBy, bill.updatedBy, bill.finalizedBy, bill.reopenedBy]
}

export async function serializeLabourBill(bill: LabourBillDocument): Promise<LabourBillRecord> {
  return toLabourBillRecord(bill, await resolveNames(actorIdsOf(bill)))
}

/**
 * The bill's totals, from its rows. Derived and rewritten after every change,
 * never incremented, so a failed write can never leave a total the rows do not
 * add up to for longer than the next change.
 *
 * A row nobody has priced adds nothing and is **counted** instead — the same
 * arrangement `unpricedLines` has on an Excel bill, and for the same reason: a
 * total that silently omits rows is a figure somebody would claim on.
 */
export async function refreshLabourBillTotals(
  billId: Types.ObjectId,
  actor?: UserDocument,
): Promise<void> {
  const [row] = await LabourBillLineModel.aggregate<{
    lineCount: number
    totalQty: number
    labourTotal: number
    floorTotal: number
    unpricedLines: number
    challanIds: unknown[]
  }>([
    { $match: { billId } },
    {
      $group: {
        _id: null,
        lineCount: { $sum: 1 },
        totalQty: { $sum: '$qty' },
        labourTotal: { $sum: { $ifNull: ['$labourAmount', 0] } },
        floorTotal: { $sum: { $ifNull: ['$floorAmount', 0] } },
        unpricedLines: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $ifNull: ['$labourAmount', null] }, null] },
                  { $eq: [{ $ifNull: ['$floorAmount', null] }, null] },
                ],
              },
              1,
              0,
            ],
          },
        },
        challanIds: { $addToSet: '$challanId' },
      },
    },
  ])

  const labourTotal = row?.labourTotal ?? 0
  const floorTotal = row?.floorTotal ?? 0

  await LabourBillModel.updateOne(
    { _id: billId },
    {
      $set: {
        lineCount: row?.lineCount ?? 0,
        challanCount: row?.challanIds.length ?? 0,
        totalQty: row?.totalQty ?? 0,
        labourTotal,
        floorTotal,
        totalAmount: labourTotal + floorTotal,
        unpricedLines: row?.unpricedLines ?? 0,
        ...(actor ? { updatedBy: actor._id } : {}),
      },
    },
  )
}

export interface LabourBillLinesState {
  lines: LabourBillLineDocument[]
  rows: Map<string, TripDoLineDocument>
  drift: Map<string, LabourLineDrift>
}

/**
 * Every row of a bill, and whether the sheet row behind each still says what it
 * copied. One read for the rows and one for the sheet, however long the bill.
 */
export async function readLabourBillLines(bill: LabourBillDocument): Promise<LabourBillLinesState> {
  const lines = await LabourBillLineModel.find({ billId: bill._id }).sort({ seq: 1 })
  const found = await TripDoLineModel.find({ _id: { $in: lines.map((line) => line.tripDoLineId) } })
  const rows = new Map(found.map((row) => [String(row._id), row]))
  const drift = new Map<string, LabourLineDrift>()

  for (const line of lines) {
    const row = rows.get(String(line.tripDoLineId))
    let state: LabourLineDrift = 'none'
    if (!row) {
      state = 'missing'
    } else if (labourCopyHashOf(labourCopyOf(row)) !== line.copyHash) {
      state = 'changed'
    }
    drift.set(String(line._id), state)
  }

  return { lines, rows, drift }
}

/**
 * The whole sheet, as every read of one bill returns it: the month split into
 * one section per CSD, each with its own SL series and its own total, and the
 * rows still waiting for a Trip DO in a pending section at the foot.
 */
export async function buildLabourBillDetail(bill: LabourBillDocument): Promise<LabourBillDetail> {
  const { lines, drift } = await readLabourBillLines(bill)
  const names = await resolveNames([
    ...actorIdsOf(bill),
    ...lines.map((line) => line.addedBy),
    ...lines.map((line) => line.updatedBy),
  ])

  const groups = groupLabourLinesByCsd(
    lines.map((line) => ({
      line,
      challanId: String(line.challanId),
      seq: line.seq,
      csd: line.csd,
    })),
  ).map((group) => {
    const records = group.lines.map((entry) =>
      toLabourBillLineRecord(entry.line, entry, drift.get(String(entry.line._id)) ?? 'none', names),
    )
    return {
      csd: group.csd,
      key: group.key,
      label: group.label,
      isPending: group.isPending,
      totals: labourGroupTotals(records),
      lines: records,
    }
  })

  const states = [...drift.values()]

  return {
    bill: toLabourBillRecord(bill, names),
    groups,
    drift: {
      changed: states.filter((state) => state === 'changed').length,
      missing: states.filter((state) => state === 'missing').length,
    },
    pendingLines: groups.find((group) => group.isPending)?.totals.rows ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface LabourBillTotals {
  total: number
  totalQty: number
  labourTotal: number
  floorTotal: number
  totalAmount: number
  unpricedLines: number
  draftBills: number
  finalizedBills: number
}

export async function listLabourBills(
  query: ListLabourBillsQuery,
): Promise<{ records: LabourBillRecord[]; totals: LabourBillTotals }> {
  const clauses: QueryFilter<LabourBill>[] = []

  if (query.status !== 'all') clauses.push({ status: query.status })
  if (query.year) clauses.push({ year: query.year })
  if (query.month) clauses.push({ month: query.month })
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({
      $or: [{ billNumber: pattern }, { company: pattern }, { note: pattern }],
    })
  }

  const filter: QueryFilter<LabourBill> = clauses.length > 0 ? { $and: clauses } : {}

  const [bills, [totals]] = await Promise.all([
    LabourBillModel.find(filter)
      .sort({ year: -1, month: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    LabourBillModel.aggregate<LabourBillTotals>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          totalQty: { $sum: '$totalQty' },
          labourTotal: { $sum: '$labourTotal' },
          floorTotal: { $sum: '$floorTotal' },
          totalAmount: { $sum: '$totalAmount' },
          unpricedLines: { $sum: '$unpricedLines' },
          draftBills: { $sum: { $cond: [{ $eq: ['$status', 'Draft'] }, 1, 0] } },
          finalizedBills: { $sum: { $cond: [{ $eq: ['$status', 'Finalized'] }, 1, 0] } },
        },
      },
    ]),
  ])

  const names = await resolveNames(bills.flatMap(actorIdsOf))

  return {
    records: bills.map((bill) => toLabourBillRecord(bill, names)),
    totals: {
      total: totals?.total ?? 0,
      totalQty: totals?.totalQty ?? 0,
      labourTotal: totals?.labourTotal ?? 0,
      floorTotal: totals?.floorTotal ?? 0,
      totalAmount: totals?.totalAmount ?? 0,
      unpricedLines: totals?.unpricedLines ?? 0,
      draftBills: totals?.draftBills ?? 0,
      finalizedBills: totals?.finalizedBills ?? 0,
    },
  }
}

/**
 * What each CSD section of one or more labour bills comes to, without opening
 * the sheets.
 *
 * The Accounts module reads this to know what a CSD is owed, and it is read
 * rather than stored for the reason a rate is copied and a location is not: the
 * amount claimed **is** whatever the sheet says now, so a second copy of it
 * could only ever come to disagree. A month's sheet is a few hundred rows and
 * the grouping is one aggregation per read.
 *
 * The CSD is folded on `comparisonKey` in memory rather than in the pipeline,
 * because that normalisation is a function this codebase owns and not something
 * to reimplement as a `$replaceAll` chain.
 */
export interface LabourCsdSummary {
  csd: string
  key: string
  label: string
  isPending: boolean
  rows: number
  challans: number
  qty: number
  labourTotal: number
  floorTotal: number
  totalAmount: number
  unpricedLines: number
}

export async function labourCsdSummaries(
  billIds: readonly Types.ObjectId[],
): Promise<Map<string, LabourCsdSummary[]>> {
  const byBill = new Map<string, LabourCsdSummary[]>()
  if (billIds.length === 0) {
    return byBill
  }

  const rows = await LabourBillLineModel.aggregate<{
    _id: { billId: Types.ObjectId; csd: string }
    rows: number
    qty: number
    labourTotal: number
    floorTotal: number
    unpricedLines: number
    challanIds: Types.ObjectId[]
  }>([
    { $match: { billId: { $in: [...billIds] } } },
    {
      $group: {
        _id: { billId: '$billId', csd: { $ifNull: ['$csd', ''] } },
        rows: { $sum: 1 },
        qty: { $sum: '$qty' },
        labourTotal: { $sum: { $ifNull: ['$labourAmount', 0] } },
        floorTotal: { $sum: { $ifNull: ['$floorAmount', 0] } },
        unpricedLines: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $ifNull: ['$labourAmount', null] }, null] },
                  { $eq: [{ $ifNull: ['$floorAmount', null] }, null] },
                ],
              },
              1,
              0,
            ],
          },
        },
        challanIds: { $addToSet: '$challanId' },
      },
    },
  ])

  for (const row of rows) {
    const billKey = String(row._id.billId)
    const csd = String(row._id.csd ?? '').trim()
    const key = comparisonKey(csd)

    const sections = byBill.get(billKey) ?? []
    const existing = sections.find((section) => section.key === key)
    const challans = row.challanIds.length

    if (existing) {
      existing.rows += row.rows
      existing.qty += row.qty
      existing.labourTotal += row.labourTotal
      existing.floorTotal += row.floorTotal
      existing.totalAmount = existing.labourTotal + existing.floorTotal
      existing.unpricedLines += row.unpricedLines
      // Two spellings of one CSD: the challan sets may overlap, so this can
      // over-count. It is a card's subtitle, never a figure anybody is charged.
      existing.challans += challans
    } else {
      sections.push({
        csd,
        key,
        label: labourGroupLabel(csd),
        isPending: key === '',
        rows: row.rows,
        challans,
        qty: row.qty,
        labourTotal: row.labourTotal,
        floorTotal: row.floorTotal,
        totalAmount: row.labourTotal + row.floorTotal,
        unpricedLines: row.unpricedLines,
      })
    }
    byBill.set(billKey, sections)
  }

  // The sheet's own order: by CSD, pending last.
  for (const sections of byBill.values()) {
    sections.sort((a, b) => {
      if (a.key === '' || b.key === '') {
        return a.key === '' ? 1 : -1
      }
      return a.key.localeCompare(b.key)
    })
  }

  return byBill
}

/** Company names already written on a sheet, for the slot form's type-ahead. */
export async function listLabourBillCompanies(): Promise<string[]> {
  const [fromBills, fromLines] = await Promise.all([
    LabourBillModel.distinct('company'),
    LabourBillLineModel.distinct('company'),
  ])
  const names = new Set(
    [...fromBills, ...fromLines].map((value) => String(value).trim()).filter(Boolean),
  )
  return [...names].sort()
}

export async function getLabourBillDetail(id: string): Promise<LabourBillDetail> {
  return buildLabourBillDetail(await findLabourBill(id))
}

// ---------------------------------------------------------------------------
// Writing the record
// ---------------------------------------------------------------------------

export async function createLabourBill(
  input: CreateLabourBillInput,
  actor: UserDocument,
): Promise<LabourBillRecord> {
  const sequence = await nextSequence(`labour-bill:${input.year}`)

  const bill = await LabourBillModel.create({
    billNumber: formatLabourBillNumber(input.year, sequence),
    month: input.month,
    year: input.year,
    company: input.company,
    note: input.note,
    createdBy: actor._id,
  })

  await recordActivity({
    action: 'labour-bill.created',
    entityType: 'LabourBill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} opened for ${labourBillPeriodLabel(bill.month, bill.year)}`,
    actor,
  })

  return serializeLabourBill(bill)
}

/**
 * Correcting a draft's period, its company default or its note. The bill number
 * keeps the year it was given: a number is never reissued.
 *
 * There is no CSD to correct: a row's CSD is a fact about its gate pass, so the
 * sheet reads it rather than being told it, and the sections rearrange
 * themselves when it changes.
 *
 * Changing the company changes what the **next** scanned row is seeded with and
 * nothing already on the sheet, for the reason a rate is copied onto a challan:
 * a row's company is what somebody wrote on that row, and a slot-level default
 * reaching back through it would silently rewrite rows nobody looked at.
 */
export async function updateLabourBill(
  id: string,
  input: UpdateLabourBillInput,
  actor: UserDocument,
): Promise<LabourBillRecord> {
  const bill = await findLabourBill(id)
  assertLabourDraft(bill)

  if (input.month !== undefined) bill.month = input.month
  if (input.year !== undefined) bill.year = input.year
  if (input.company !== undefined) bill.company = input.company
  if (input.note !== undefined) bill.note = input.note

  bill.updatedBy = actor._id
  await bill.save()
  return serializeLabourBill(bill)
}

/**
 * Deleting a draft. Nothing is released, because nothing was claimed — this
 * module marks no Trip DO row, so a deleted labour bill leaves the sheet, the
 * challans and the gate passes exactly as they were. The person who opened it
 * deletes it, and so do Admin and Manager.
 */
export async function deleteLabourBill(
  id: string,
  actor: UserDocument,
): Promise<{ id: string; billNumber: string; removed: number }> {
  const bill = await findLabourBill(id)
  assertLabourDraft(bill)

  if (!isLabourBillReviewer(actor) && String(bill.createdBy) !== String(actor._id)) {
    throw new AppError(
      403,
      'Only the person who opened this labour bill, or an Admin or Manager, can delete it.',
    )
  }

  const removed = await LabourBillLineModel.deleteMany({ billId: bill._id })
  await bill.deleteOne()

  /**
   * No claim is released, unlike the Excel bill — this module claims nothing
   * from the sheet, because a run is charged carriage by one bill and handling
   * by the other. What goes is the typed figures, which exist nowhere else:
   * what four men were paid to carry a fridge up three flights was typed into
   * these rows and into nothing.
   */
  await recordActivity({
    action: 'labour-bill.deleted',
    entityType: 'LabourBill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} (${labourBillPeriodLabel(bill.month, bill.year)}) deleted — ${
      removed.deletedCount ?? 0
    } typed rows, ৳${bill.totalAmount.toLocaleString('en-BD')}`,
    actor,
  })

  return { id: String(bill._id), billNumber: bill.billNumber, removed: removed.deletedCount ?? 0 }
}

/**
 * Signing a bill off.
 *
 * Three refusals, and each is a thing nobody would notice afterwards. Empty,
 * because a bill claiming nothing is not a bill. **Rows nobody has priced**,
 * because their Total is blank and the bill's own total quietly leaves them
 * out — typing `0` is how somebody says a delivery needed no help, and a blank
 * says only that the question has not been answered. And rows the Trip DO sheet
 * has moved under, because a bill finalized over a stale copy charges an
 * address or a quantity the sheet no longer says.
 */
export async function finalizeLabourBill(id: string, actor: UserDocument): Promise<LabourBillRecord> {
  const bill = await findLabourBill(id)

  if (bill.status === 'Finalized') {
    throw new AppError(409, `${bill.billNumber} is already finalized.`)
  }
  if (bill.lineCount === 0) {
    throw new AppError(409, 'An empty labour bill cannot be finalized. Scan its challans in first.')
  }
  if (bill.unpricedLines > 0) {
    const count = bill.unpricedLines
    throw new AppError(
      409,
      `${count} ${count === 1 ? 'row has' : 'rows have'} no Ven/Pulling/Labour and no Floor amount. Enter what each cost — 0 where a delivery needed no help — then finalize.`,
    )
  }

  const { lines, drift } = await readLabourBillLines(bill)

  /**
   * A row with no CSD is on no CSD's bill, so it would be invoiced to nobody —
   * the one gap a finished month must not have. The fix is not here, it is on
   * the Trip DO sheet, so the refusal names it.
   */
  const pending = lines.filter((line) => !line.csd.trim()).length
  if (pending > 0) {
    throw new AppError(
      409,
      `${pending} ${pending === 1 ? 'row is' : 'rows are'} still waiting for a Trip DO, so ${pending === 1 ? 'it belongs' : 'they belong'} to no CSD yet and would be charged to nobody. Set ${pending === 1 ? 'its' : 'their'} Trip DO on the sheet, or take ${pending === 1 ? 'it' : 'them'} off, then finalize.`,
    )
  }

  const moved = [...drift.values()].filter((state) => state !== 'none').length
  if (moved > 0) {
    throw new AppError(
      409,
      `${moved} ${moved === 1 ? 'row has' : 'rows have'} changed on the Trip DO sheet since ${
        moved === 1 ? 'it was' : 'they were'
      } scanned in. Refresh the bill so it reads what the sheet says, then finalize it.`,
    )
  }

  bill.status = 'Finalized'
  bill.finalizedAt = new Date()
  bill.finalizedBy = actor._id
  bill.updatedBy = actor._id
  await bill.save()

  /**
   * The figure goes in for the reason the Excel bill's does — and with one
   * more: this bill is a **receivable**. Accounts reads what each CSD is owed
   * live off these rows, so what the month claimed when it was signed off is
   * a figure the sheet itself will not preserve once anybody reopens it.
   */
  await recordActivity({
    action: 'labour-bill.finalized',
    entityType: 'LabourBill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} finalized — ${bill.lineCount} rows, ৳${bill.totalAmount.toLocaleString('en-BD')}`,
    changes: [
      { field: 'status', label: 'Status', from: 'Draft', to: 'Finalized' },
      { field: 'totalAmount', label: 'Total', from: null, to: String(bill.totalAmount) },
    ],
    actor,
  })

  return serializeLabourBill(bill)
}

export async function reopenLabourBill(id: string, actor: UserDocument): Promise<LabourBillRecord> {
  const bill = await findLabourBill(id)

  if (bill.status !== 'Finalized') {
    throw new AppError(409, `${bill.billNumber} is not finalized, so there is nothing to reopen.`)
  }

  bill.status = 'Draft'
  bill.reopenedAt = new Date()
  bill.reopenedBy = actor._id
  bill.updatedBy = actor._id
  await bill.save()

  await recordActivity({
    action: 'labour-bill.reopened',
    entityType: 'LabourBill',
    entityId: bill._id,
    entityLabel: bill.billNumber,
    summary: `${bill.billNumber} reopened — it was finalized at ৳${bill.totalAmount.toLocaleString('en-BD')}`,
    changes: [{ field: 'status', label: 'Status', from: 'Finalized', to: 'Draft' }],
    actor,
  })

  return serializeLabourBill(bill)
}
