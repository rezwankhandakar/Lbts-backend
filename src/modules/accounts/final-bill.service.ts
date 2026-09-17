import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { BillStatus } from '../bill/bill.constants'
import { BillModel } from '../bill/bill.model'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import type { UserDocument } from '../user/user.model'
import { resolveActorNames } from '../vendor/vendor.lookups'
import { outstandingOf, periodLabel } from './accounts.constants'
import type { Period, SettlementStatus } from './accounts.constants'
import { EntryModel, FinalBillModel } from './accounts.model'
import type { FinalBill, FinalBillDocument } from './accounts.model'
import { actorOf, finalBillLabel, serializeEntries, toDay } from './accounts.serializer'
import type { ActorRef, EntryRecord } from './accounts.serializer'
import { refreshFinalBillReceipts } from './accounts.settlement'
import type {
  FinalBillInput,
  FinalBillSlotQuery,
  ListFinalBillsQuery,
  UpdateFinalBillInput,
} from './accounts.validation'

/**
 * Walton's final bills: the figure a unit's month was actually approved at.
 *
 * The Excel bills for the same unit and month are read beside it — never
 * copied — so the difference the audit made is always the difference between
 * what the Bill module holds now and what was typed here.
 */

export interface ExcelBillRef {
  id: string
  billNumber: string
  status: BillStatus
  totalAmount: number
}

export interface FinalBillRecord {
  id: string
  year: number
  month: number
  periodLabel: string
  unit: string
  finalAmount: number
  referenceNo: string
  receivedOn: string | null
  note: string
  receivedAmount: number
  outstanding: number
  paymentStatus: SettlementStatus
  /** Excel bills for the same unit and month, and what they asked for. */
  excelBills: ExcelBillRef[]
  submittedAmount: number
  /** Final less submitted: negative when the audit cut the bill. */
  difference: number
  createdBy: ActorRef | null
  createdAt: string
  updatedBy: ActorRef | null
  updatedAt: string
}

function slotKey(slot: { year: number; month: number; unitKey: string }): string {
  return `${slot.year}-${slot.month}-${slot.unitKey}`
}

/** Excel bills for a set of unit-months, in one read. */
async function excelBillsFor(slots: { year: number; month: number; unitKey: string }[]): Promise<Map<string, ExcelBillRef[]>> {
  if (slots.length === 0) {
    return new Map()
  }
  const bills = await BillModel.find({
    $or: slots.map((slot) => ({ year: slot.year, month: slot.month, unitKey: slot.unitKey })),
  })
    .select('billNumber status totalAmount year month unitKey')
    .sort({ createdAt: 1 })

  const bySlot = new Map<string, ExcelBillRef[]>()
  for (const bill of bills) {
    const key = slotKey(bill)
    const list = bySlot.get(key) ?? []
    list.push({
      id: String(bill._id),
      billNumber: bill.billNumber,
      status: bill.status as BillStatus,
      totalAmount: bill.totalAmount,
    })
    bySlot.set(key, list)
  }
  return bySlot
}

async function serializeFinalBills(bills: FinalBillDocument[]): Promise<FinalBillRecord[]> {
  const [excel, names] = await Promise.all([
    excelBillsFor(bills),
    resolveActorNames(bills.flatMap((bill) => [bill.createdBy, bill.updatedBy])),
  ])

  return bills.map((bill) => {
    const excelBills = excel.get(slotKey(bill)) ?? []
    const submittedAmount = excelBills.reduce((total, row) => total + row.totalAmount, 0)
    return {
      id: String(bill._id),
      year: bill.year,
      month: bill.month,
      periodLabel: periodLabel(bill),
      unit: bill.unit,
      finalAmount: bill.finalAmount,
      referenceNo: bill.referenceNo ?? '',
      receivedOn: bill.receivedOn ? toDay(bill.receivedOn) : null,
      note: bill.note ?? '',
      receivedAmount: bill.receivedAmount ?? 0,
      outstanding: outstandingOf(bill.finalAmount, bill.receivedAmount ?? 0),
      paymentStatus: bill.paymentStatus as SettlementStatus,
      excelBills,
      submittedAmount: Math.round(submittedAmount),
      difference: Math.round(bill.finalAmount - submittedAmount),
      createdBy: actorOf(bill.createdBy, names),
      createdAt: bill.createdAt.toISOString(),
      updatedBy: actorOf(bill.updatedBy, names),
      updatedAt: bill.updatedAt.toISOString(),
    }
  })
}

async function serializeFinalBill(bill: FinalBillDocument): Promise<FinalBillRecord> {
  const [record] = await serializeFinalBills([bill])
  return record
}

async function findFinalBill(id: string): Promise<FinalBillDocument> {
  const bill = await FinalBillModel.findById(id)
  if (!bill) {
    throw new AppError(404, 'Final bill not found.')
  }
  return bill
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

function slotTaken(period: Period, unit: string): AppError {
  return new AppError(
    409,
    `A final bill for ${unit} in ${periodLabel(period)} is already on record. Open it and correct the amount instead.`,
  )
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface FinalBillTotals {
  total: number
  finalAmount: number
  receivedAmount: number
  outstanding: number
  submittedAmount: number
}

export async function listFinalBills(
  query: ListFinalBillsQuery,
): Promise<{ records: FinalBillRecord[]; totals: FinalBillTotals }> {
  const clauses: QueryFilter<FinalBill>[] = []
  if (query.year) clauses.push({ year: query.year })
  if (query.unit) clauses.push({ unitKey: comparisonKey(query.unit) })
  if (query.status !== 'all') clauses.push({ paymentStatus: query.status })
  const filter: QueryFilter<FinalBill> = clauses.length > 0 ? { $and: clauses } : {}

  const [bills, [sums], allSlots] = await Promise.all([
    FinalBillModel.find(filter)
      .sort({ year: -1, month: -1, unit: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FinalBillModel.aggregate<Omit<FinalBillTotals, 'submittedAmount'>>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          finalAmount: { $sum: '$finalAmount' },
          receivedAmount: { $sum: '$receivedAmount' },
          outstanding: { $sum: { $max: [0, { $subtract: ['$finalAmount', '$receivedAmount'] }] } },
        },
      },
    ]),
    FinalBillModel.find(filter).select('year month unitKey').lean(),
  ])

  const excel = await excelBillsFor(allSlots)
  const submittedAmount = [...excel.values()].flat().reduce((total, bill) => total + bill.totalAmount, 0)

  return {
    records: await serializeFinalBills(bills),
    totals: {
      total: sums?.total ?? 0,
      finalAmount: sums?.finalAmount ?? 0,
      receivedAmount: sums?.receivedAmount ?? 0,
      outstanding: sums?.outstanding ?? 0,
      submittedAmount: Math.round(submittedAmount),
    },
  }
}

export async function getFinalBill(id: string): Promise<{ bill: FinalBillRecord; receipts: EntryRecord[] }> {
  const bill = await findFinalBill(id)
  const receipts = await EntryModel.find({ finalBillId: bill._id, kind: 'Deposit' }).sort({ date: 1, createdAt: 1 })
  const [record, entries] = await Promise.all([serializeFinalBill(bill), serializeEntries(receipts)])
  return { bill: record, receipts: entries }
}

/** What the form shows while a unit and month are chosen: the Excel bills, and a final bill already there. */
export async function getFinalBillSlot(
  query: FinalBillSlotQuery,
): Promise<{ excelBills: ExcelBillRef[]; submittedAmount: number; existing: FinalBillRecord | null }> {
  const unitKey = comparisonKey(query.unit)
  const slot = { year: query.year, month: query.month, unitKey }
  const [excel, existing] = await Promise.all([excelBillsFor([slot]), FinalBillModel.findOne(slot)])
  const excelBills = excel.get(slotKey(slot)) ?? []

  return {
    excelBills,
    submittedAmount: Math.round(excelBills.reduce((total, bill) => total + bill.totalAmount, 0)),
    existing: existing ? await serializeFinalBill(existing) : null,
  }
}

/** Units any final bill or Excel bill has named, for the unit picker. */
export async function listKnownUnits(): Promise<string[]> {
  const [finalUnits, excelUnits] = await Promise.all([FinalBillModel.distinct('unit'), BillModel.distinct('unit')])
  return [...new Set([...finalUnits, ...excelUnits].map((unit) => String(unit).toUpperCase()))].sort()
}

/** Every final bill still waiting on money, for a deposit to be recorded against. */
export async function listReceivableFinalBills(): Promise<FinalBillRecord[]> {
  const bills = await FinalBillModel.find({ paymentStatus: { $in: ['Open', 'Partial'] } })
    .sort({ year: -1, month: -1, unit: 1 })
    .limit(60)
  return serializeFinalBills(bills)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function createFinalBill(input: FinalBillInput, actor: UserDocument): Promise<FinalBillRecord> {
  const unit = input.unit.toUpperCase()
  try {
    const bill = await FinalBillModel.create({
      ...input,
      unit,
      unitKey: comparisonKey(unit),
      receivedAmount: 0,
      paymentStatus: 'Open',
      createdBy: actor._id,
    })
    return serializeFinalBill(bill)
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw slotTaken(input, unit)
    }
    throw error
  }
}

export async function updateFinalBill(
  id: string,
  input: UpdateFinalBillInput,
  actor: UserDocument,
): Promise<FinalBillRecord> {
  const bill = await findFinalBill(id)

  if (input.finalAmount !== undefined && input.finalAmount < (bill.receivedAmount ?? 0)) {
    throw new AppError(
      409,
      `৳${(bill.receivedAmount ?? 0).toLocaleString('en-IN')} has already been received against ${finalBillLabel(bill)}, so the final amount cannot be less than that.`,
    )
  }

  if (input.year !== undefined) bill.year = input.year
  if (input.month !== undefined) bill.month = input.month
  if (input.unit !== undefined) {
    bill.unit = input.unit.toUpperCase()
    bill.unitKey = comparisonKey(bill.unit)
  }
  if (input.finalAmount !== undefined) bill.finalAmount = input.finalAmount
  if (input.referenceNo !== undefined) bill.referenceNo = input.referenceNo
  if (input.receivedOn !== undefined) bill.receivedOn = input.receivedOn
  if (input.note !== undefined) bill.note = input.note
  bill.updatedBy = actor._id

  try {
    await bill.save()
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw slotTaken(bill, bill.unit)
    }
    throw error
  }

  await refreshFinalBillReceipts(bill._id)
  return serializeFinalBill(await findFinalBill(id))
}

/** A final bill with money recorded against it cannot go: those deposits would be payments for nothing. */
export async function deleteFinalBill(id: string): Promise<{ id: string; label: string }> {
  const bill = await findFinalBill(id)
  if (await EntryModel.exists({ finalBillId: bill._id })) {
    throw new AppError(
      409,
      `Payments are recorded against ${finalBillLabel(bill)}. Delete those deposits, or record them without the bill, first.`,
    )
  }
  await bill.deleteOne()
  return { id, label: finalBillLabel(bill) }
}
