import type { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { findByScan } from '../delivery/delivery.lookups'
import { TripDoLineModel } from '../trip-do/trip-do.model'
import type { TripDoLineDocument } from '../trip-do/trip-do.model'
import type { UserDocument } from '../user/user.model'
import { MAX_LABOUR_BILL_LINES, arrangeLabourLines } from './labour-bill.constants'
import { labourCopyHashOf, labourCopyOf } from './labour-bill.copy'
import { LabourBillLineModel, LabourBillModel } from './labour-bill.model'
import type { LabourBillLineDocument } from './labour-bill.model'
import { toLabourBillLineRecord } from './labour-bill.serializer'
import type { LabourBillLineRecord, LabourBillRecord, LabourScanResult } from './labour-bill.serializer'
import {
  assertLabourDraft,
  buildLabourBillDetail,
  findLabourBill,
  readLabourBillLines,
  refreshLabourBillTotals,
  resolveNames,
  serializeLabourBill,
} from './labour-bill.service'
import type { RemoveLabourBillLinesInput, UpdateLabourBillLineInput } from './labour-bill.validation'

/**
 * What a labour bill carries: one barcode read, the rows it produces, the cells
 * somebody types into them, and bringing a draft's copies back in step with the
 * Trip DO sheet.
 *
 * **Nothing here claims a sheet row.** The Excel Bill marks each row it charges
 * and refuses to share it, because two transport bills for one run would charge
 * the run twice. Labour is the other half of the same run — the office bills
 * Walton the rate card's carriage on one sheet and the handling on this one —
 * so a row appears on both and neither is wrong. What this module does enforce
 * is that a row appears on **one labour bill at most once**, which is the unique
 * index on `{ billId, tripDoLineId }`: scanning the same challan twice is an
 * ordinary thing to do with a stack of paper, and it must add nothing the second
 * time.
 */

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

/** The challan's models in the order the paper prints them. */
function compareRows(a: TripDoLineDocument, b: TripDoLineDocument): number {
  return a.position - b.position || a.rowSeq - b.rowSeq || a.splitIndex - b.splitIndex
}

/** How a row names itself in a message: the model, or the product when there is none. */
function labelOf(row: { productModel: string; productName: string }): string {
  return row.productModel || row.productName
}

/**
 * The sheet rows a challan contributes: its **order** rows, one per model, and a
 * second row wherever a line was split across two gate passes — which is
 * correct rather than a duplicate, because the two halves came out on different
 * Trip DOs and are handled on different days.
 *
 * Returns and re-sends are deliberately left out. They are the same pieces
 * moving again rather than a new model on the challan, and folding them in
 * would put a row on the bill that the office's own sheet does not have.
 */
async function orderRowsOf(challanId: Types.ObjectId): Promise<TripDoLineDocument[]> {
  const rows = await TripDoLineModel.find({ challanId, kind: 'Order' })
  return rows.sort(compareRows)
}

/** The placement of one row, from the cheapest possible read of the bill's order. */
async function placementOf(
  billId: Types.ObjectId,
  lineId: string,
): Promise<{ sl: number; slRowSpan: number }> {
  const order = await LabourBillLineModel.find({ billId }).select('challanId seq').sort({ seq: 1 })
  const arranged = arrangeLabourLines(
    order.map((line) => ({ id: String(line._id), challanId: String(line.challanId), seq: line.seq })),
  )
  const found = arranged.find((entry) => entry.id === lineId)
  return { sl: found?.sl ?? 0, slRowSpan: found?.slRowSpan ?? 0 }
}

// ---------------------------------------------------------------------------
// Scanning a challan in
// ---------------------------------------------------------------------------

/**
 * One barcode read.
 *
 * The lookup is Delivery's own `findByScan` rather than a second copy of it:
 * a challan's back page carries its challan number, a five-digit read is the SL
 * printed beside it, and a module that decided that for itself would eventually
 * decide it differently. What differs here is only the question being asked —
 * there, a scan means "put this on a lorry"; here it means "charge what it cost
 * to carry this in".
 *
 * Every model on the challan lands as its own row, with its Ven/Pulling/Labour
 * and Floor cells empty and waiting. A challan already on the sheet adds
 * nothing and says so, because working through a stack means scanning one twice.
 */
export async function scanChallanOntoLabourBill(
  billId: string,
  code: string,
  actor: UserDocument,
): Promise<LabourScanResult> {
  const bill = await findLabourBill(billId)
  assertLabourDraft(bill)

  const challan = await findByScan(code)
  if (!challan) {
    throw new AppError(404, `No challan carries ${code.trim().toUpperCase()}.`)
  }

  const rows = await orderRowsOf(challan._id)
  if (rows.length === 0) {
    throw new AppError(
      409,
      `${challan.challanNumber} has no product lines on the Trip DO sheet yet, so there is nothing to charge handling on.`,
    )
  }

  /**
   * **Every model comes on, whatever CSD it went out under.** The slot is a
   * month, and each row files itself into the section for its own gate pass's
   * CSD — so a challan that went out on two gate passes lands in two sections
   * off one scan, which is what the paper in the operator's hand actually is.
   *
   * A line whose Trip DO is not set yet has no CSD, and it comes on too: it
   * waits in the pending section, keeping whatever amounts are typed into it,
   * and moves into its CSD the moment somebody links the gate pass.
   */
  const existing = await LabourBillLineModel.find({
    billId: bill._id,
    tripDoLineId: { $in: rows.map((row) => row._id) },
  }).select('tripDoLineId')
  const already = new Set(existing.map((line) => String(line.tripDoLineId)))

  const fresh = rows.filter((row) => !already.has(String(row._id)))
  const skipped = rows.filter((row) => already.has(String(row._id))).map(labelOf)
  const withoutTripDo = fresh.filter((row) => !row.link).map(labelOf)
  const csds = [
    ...new Set(
      fresh
        .map((row) => row.link?.csd.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort()

  if (fresh.length > 0) {
    if (bill.lineCount + fresh.length > MAX_LABOUR_BILL_LINES) {
      throw new AppError(
        409,
        `${bill.billNumber} already carries ${bill.lineCount} rows. A labour bill holds at most ${MAX_LABOUR_BILL_LINES}; open one for the next month.`,
      )
    }

    const [last] = await LabourBillLineModel.find({ billId: bill._id }).sort({ seq: -1 }).limit(1).select('seq')
    let seq = (last?.seq ?? 0) + 1
    const now = new Date()

    try {
      await LabourBillLineModel.insertMany(
        fresh.map((row) => {
          const copy = labourCopyOf(row)
          return {
            billId: bill._id,
            tripDoLineId: row._id,
            seq: seq++,
            ...copy,
            // The Unit column carries a company name: the slot's, or the gate
            // pass's own unit when the slot names none. Either way it is the
            // row's from here on, and typing over it is expected.
            company: bill.company || copy.unit,
            copyHash: labourCopyHashOf(copy),
            addedAt: now,
            addedBy: actor._id,
          }
        }),
        // Unordered, so one row losing the unique index to a racing scan of the
        // same challan does not throw away the rest of the challan with it.
        { ordered: false },
      )
    } catch (error) {
      // A duplicate here is the race the index exists for, and its outcome is
      // exactly what was wanted: the row is on the bill once. Anything else is
      // a real failure and is left to the error handler.
      if (!isDuplicateKey(error)) {
        throw error
      }
    }

    await refreshLabourBillTotals(bill._id, actor)
  }

  const current = await findLabourBill(billId)

  return {
    billNumber: current.billNumber,
    challanId: String(challan._id),
    challanNumber: challan.challanNumber,
    challanSlNumber: challan.slNumber,
    customerName: challan.customerName ?? '',
    added: fresh.map(labelOf),
    skipped,
    csds,
    withoutTripDo,
    detail: await buildLabourBillDetail(current),
  }
}

// ---------------------------------------------------------------------------
// Typing into a row
// ---------------------------------------------------------------------------

/**
 * One cell, or all four at once.
 *
 * `null` is accepted and stored, because clearing a cell back to "not typed" is
 * a real correction: somebody who entered 600 against the wrong row has to be
 * able to take it off without leaving a zero that reads as "this needed no
 * help". `lineTotal` is what keeps the two apart everywhere else.
 */
export async function updateLabourBillLine(
  billId: string,
  lineId: string,
  input: UpdateLabourBillLineInput,
  actor: UserDocument,
): Promise<{ bill: LabourBillRecord; line: LabourBillLineRecord }> {
  const bill = await findLabourBill(billId)
  assertLabourDraft(bill)

  const line = await LabourBillLineModel.findOne({ _id: lineId, billId: bill._id })
  if (!line) {
    throw new AppError(404, 'That row is not on this labour bill.')
  }

  if (input.company !== undefined) line.company = input.company
  if (input.labourAmount !== undefined) line.labourAmount = input.labourAmount
  if (input.floorNo !== undefined) line.floorNo = input.floorNo
  if (input.floorAmount !== undefined) line.floorAmount = input.floorAmount
  line.updatedBy = actor._id
  await line.save()

  await refreshLabourBillTotals(bill._id, actor)

  const placement = await placementOf(bill._id, String(line._id))
  // Both actors, not just this one: the row may have been scanned in by
  // somebody else, and a map holding only the editor would report them as a
  // removed account.
  const names = await resolveNames([line.addedBy, line.updatedBy])

  // Read the sheet row again rather than reporting `none`: typing an amount
  // says nothing about whether the copy beside it is still current, and an
  // answer that quietly cleared the drift mark would take a row out of the
  // banner's count without anything having been refreshed.
  const row = await TripDoLineModel.findById(line.tripDoLineId)
  const drift = !row ? 'missing' : labourCopyHashOf(labourCopyOf(row)) !== line.copyHash ? 'changed' : 'none'

  return {
    // Re-read rather than reused: the totals above were written straight to the
    // collection, so the document in hand still holds the figures from before.
    bill: await serializeLabourBill(await findLabourBill(billId)),
    line: toLabourBillLineRecord(
      line,
      placement,
      drift,
      names,
    ),
  }
}

// ---------------------------------------------------------------------------
// Taking rows off
// ---------------------------------------------------------------------------

/**
 * Taking rows off a draft. Nothing is released, because nothing was claimed —
 * a row taken off a labour bill is a row nobody is charging handling on, and
 * the Trip DO sheet, the challan and the gate pass never knew it was here.
 */
export async function removeLabourBillLines(
  billId: string,
  input: RemoveLabourBillLinesInput,
  actor: UserDocument,
): Promise<{ billNumber: string; removed: number }> {
  const bill = await findLabourBill(billId)
  assertLabourDraft(bill)

  const result = await LabourBillLineModel.deleteMany({ billId: bill._id, _id: { $in: input.lineIds } })
  const removed = result.deletedCount ?? 0

  if (removed === 0) {
    throw new AppError(404, 'None of those rows is on this labour bill.')
  }

  await refreshLabourBillTotals(bill._id, actor)
  return { billNumber: bill.billNumber, removed }
}

// ---------------------------------------------------------------------------
// Bringing the copies back in step
// ---------------------------------------------------------------------------

/**
 * Re-copies the rows of **draft** labour bills that point at the given Trip DO
 * sheet rows, and rewrites the totals of the bills that changed.
 *
 * This is what makes a pending row move on its own. A row is scanned in with
 * whatever the sheet says at the time, and a challan is routinely scanned in
 * before anybody has matched its gate pass — so the row sits in the pending
 * section with no CSD. The moment somebody sets its Trip DO, the Trip DO module
 * calls this, the copy learns the CSD, and the row is drawn under that CSD's
 * section the next time the bill is opened. Nobody presses anything.
 *
 * Called from the Trip DO module the way `refreshBillingStatus` is, and with
 * the same posture: **it never throws.** A row one write behind is a section
 * that Refresh puts right; a link refused because a labour bill could not be
 * updated would be an operator unable to do the job in front of them.
 *
 * Finalized bills are left alone. Their figures are what somebody has been
 * asked to pay, and a gate pass corrected afterwards must not quietly move a
 * row between the sections of a sheet that has already gone out.
 */
export async function syncLabourBillCopies(tripDoLineIds: readonly (Types.ObjectId | string | null | undefined)[]): Promise<void> {
  try {
    const ids = [...new Set(tripDoLineIds.filter(Boolean).map(String))]
    if (ids.length === 0) {
      return
    }

    const lines = await LabourBillLineModel.find({ tripDoLineId: { $in: ids } })
    if (lines.length === 0) {
      return
    }

    const drafts = await LabourBillModel.find({
      _id: { $in: [...new Set(lines.map((line) => String(line.billId)))] },
      status: 'Draft',
    }).select('_id')
    const draftIds = new Set(drafts.map((bill) => String(bill._id)))

    const rows = await TripDoLineModel.find({ _id: { $in: ids } })
    const byId = new Map(rows.map((row) => [String(row._id), row]))
    const touched = new Set<string>()

    for (const line of lines) {
      if (!draftIds.has(String(line.billId))) {
        continue
      }
      const row = byId.get(String(line.tripDoLineId))
      if (!row) {
        continue
      }
      const copy = labourCopyOf(row)
      const hash = labourCopyHashOf(copy)
      if (hash === line.copyHash) {
        continue
      }
      line.set({ ...copy, copyHash: hash })
      // A row scanned in before its gate pass was matched has no company of its
      // own yet; the unit it has just learned is the best answer available.
      if (!line.company && copy.unit) {
        line.company = copy.unit
      }
      await line.save()
      touched.add(String(line.billId))
    }

    // The copies carry no money, so the totals cannot have moved — but the
    // challan count can, and `updatedAt` should say the sheet was touched.
    for (const billId of touched) {
      const bill = await LabourBillModel.findById(billId).select('_id')
      if (bill) {
        await refreshLabourBillTotals(bill._id)
      }
    }
  } catch (error) {
    console.error('[labour-bill] copy sync failed', error)
  }
}

/**
 * Re-reads every row's copy off the Trip DO sheet, and drops the rows whose
 * sheet row is gone.
 *
 * **The typed cells are never touched.** A challan whose address was corrected,
 * or whose Trip DO was matched an hour after it was scanned in, is the ordinary
 * reason to run this, and forgetting what four men were paid because a postcode
 * moved would make the button unusable.
 *
 * It also does not go looking for models the challan has gained since. Scanning
 * the challan again is what picks those up — it skips what is already here and
 * adds what is not — and that keeps this button to one promise: the sheet says
 * what the Trip DO sheet says.
 */
export async function refreshLabourBillLines(
  billId: string,
  actor: UserDocument,
): Promise<{ billNumber: string; updated: number; removed: number }> {
  const bill = await findLabourBill(billId)
  assertLabourDraft(bill)

  const { lines, rows, drift } = await readLabourBillLines(bill)
  const stale: LabourBillLineDocument[] = []
  const gone: string[] = []

  for (const line of lines) {
    const state = drift.get(String(line._id))
    if (state === 'missing') {
      gone.push(String(line._id))
    } else if (state === 'changed') {
      stale.push(line)
    }
  }

  for (const line of stale) {
    const row = rows.get(String(line.tripDoLineId))
    if (!row) {
      continue
    }
    const copy = labourCopyOf(row)
    line.set({ ...copy, copyHash: labourCopyHashOf(copy) })
    // A row scanned in before its gate pass was matched has no company of its
    // own yet; the unit it has just learned is the best answer available.
    if (!line.company && copy.unit) {
      line.company = copy.unit
    }
    line.updatedBy = actor._id
    await line.save()
  }

  if (gone.length > 0) {
    await LabourBillLineModel.deleteMany({ billId: bill._id, _id: { $in: gone } })
  }

  if (stale.length > 0 || gone.length > 0) {
    await refreshLabourBillTotals(bill._id, actor)
  }

  return { billNumber: bill.billNumber, updated: stale.length, removed: gone.length }
}
