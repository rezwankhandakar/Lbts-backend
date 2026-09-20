import type { QueryFilter, Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import type { LabourBillStatus } from '../labour-bill/labour-bill.constants'
import { LabourBillModel } from '../labour-bill/labour-bill.model'
import type { LabourBill, LabourBillDocument } from '../labour-bill/labour-bill.model'
import { labourCsdSummaries } from '../labour-bill/labour-bill.service'
import type { LabourCsdSummary } from '../labour-bill/labour-bill.service'
import { outstandingOf, periodLabel, settlementStatusFor } from './accounts.constants'
import type { SettlementStatus } from './accounts.constants'
import { EntryModel } from './accounts.model'
import { serializeEntries } from './accounts.serializer'
import type { EntryRecord } from './accounts.serializer'
import { receiptsByLabourCsd } from './accounts.settlement'
import type { ListLabourReceivablesQuery } from './accounts.validation'

/**
 * What Walton owes on the **labour** side, and what has arrived.
 *
 * The Walton final bill records a figure somebody types, because an audit
 * changes it. This does not: a labour bill's CSD section is already a figure
 * the office worked out row by row, so **what is owed is read off the sheet
 * and never copied** — the arrangement the Location master has with a challan,
 * and the opposite of the one a rate has. There is no receivable collection to
 * keep in step, no backfill and nothing that can come to disagree with the
 * sheet; a payment is a `Deposit` carrying the bill and the CSD, and everything
 * else on this page is arithmetic over those two reads.
 *
 * It is two levels because the office works it that way: a **month** is what
 * arrives as one claim, and a **CSD** is what is paid separately inside it.
 */

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One CSD of one month: what it came to, what has arrived, and what is left. */
export interface LabourCsdReceivable {
  csd: string
  key: string
  label: string
  /** True for the section holding rows whose Trip DO is not set yet. */
  isPending: boolean
  rows: number
  challans: number
  qty: number
  labourTotal: number
  floorTotal: number
  billedAmount: number
  receivedAmount: number
  outstanding: number
  paymentStatus: SettlementStatus
  /** Rows with no amount typed, which the billed figure leaves out. */
  unpricedLines: number
  /**
   * Whether a payment may be recorded against this section. False for the
   * pending one: those rows belong to no CSD yet, so there is nobody to bill.
   */
  canReceive: boolean
}

/** One month's labour bill as a receivable: the whole claim, and its CSDs underneath. */
export interface LabourReceivableRecord {
  id: string
  billNumber: string
  year: number
  month: number
  periodLabel: string
  company: string
  status: LabourBillStatus
  /**
   * What the month's **CSD sections** come to — what Walton has actually been
   * billed. The pending section is not in it: nobody can pay for rows that
   * belong to no CSD, and counting them would leave a fully-paid month unable
   * to read Settled.
   */
  billedAmount: number
  receivedAmount: number
  outstanding: number
  paymentStatus: SettlementStatus
  /** CSD sections a payment can be recorded against. */
  csdCount: number
  /** Rows waiting for a Trip DO, so their charge belongs to no CSD yet. */
  pendingAmount: number
  unpricedLines: number
  csds: LabourCsdReceivable[]
}

export interface LabourReceivableTotals {
  total: number
  billedAmount: number
  receivedAmount: number
  outstanding: number
}

function toCsdReceivable(section: LabourCsdSummary, received: number): LabourCsdReceivable {
  return {
    csd: section.csd,
    key: section.key,
    label: section.label,
    isPending: section.isPending,
    rows: section.rows,
    challans: section.challans,
    qty: section.qty,
    labourTotal: section.labourTotal,
    floorTotal: section.floorTotal,
    billedAmount: section.totalAmount,
    receivedAmount: received,
    outstanding: outstandingOf(section.totalAmount, received),
    paymentStatus: settlementStatusFor(section.totalAmount, received),
    unpricedLines: section.unpricedLines,
    canReceive: !section.isPending,
  }
}

/**
 * Bills as receivables: one aggregation for what every CSD section comes to,
 * one for what has arrived against each, however many months are asked for.
 */
async function serializeReceivables(
  bills: LabourBillDocument[],
): Promise<LabourReceivableRecord[]> {
  if (bills.length === 0) {
    return []
  }

  const ids = bills.map((bill) => bill._id)
  const [sections, receipts] = await Promise.all([labourCsdSummaries(ids), receiptsByLabourCsd(ids)])

  return bills.map((bill) => {
    const billKey = String(bill._id)
    const csds = (sections.get(billKey) ?? []).map((section) =>
      toCsdReceivable(section, receipts.get(`${billKey}|${section.key}`) ?? 0),
    )

    const payable = csds.filter((csd) => csd.canReceive)
    const billedAmount = payable.reduce((sum, csd) => sum + csd.billedAmount, 0)
    const receivedAmount = payable.reduce((sum, csd) => sum + csd.receivedAmount, 0)

    return {
      id: billKey,
      billNumber: bill.billNumber,
      year: bill.year,
      month: bill.month,
      periodLabel: periodLabel({ year: bill.year, month: bill.month }),
      company: bill.company ?? '',
      status: bill.status as LabourBillStatus,
      billedAmount,
      receivedAmount,
      outstanding: outstandingOf(billedAmount, receivedAmount),
      paymentStatus: settlementStatusFor(billedAmount, receivedAmount),
      csdCount: payable.length,
      pendingAmount: csds.find((csd) => csd.isPending)?.billedAmount ?? 0,
      unpricedLines: csds.reduce((sum, csd) => sum + csd.unpricedLines, 0),
      csds,
    }
  })
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every month's labour claim, newest first.
 *
 * Filtered and paged **in memory**, unlike every other list in Accounts, and
 * for a reason rather than out of laziness: what a month is owed is derived
 * from its sheet, so a payment status is not a field MongoDB could sort or
 * filter on. A labour bill is one per month, so a year is a dozen rows and the
 * whole set is cheaper to read than the aggregation that would avoid it. The
 * cap is what keeps that true.
 */
const MAX_RECEIVABLE_MONTHS = 240

export async function listLabourReceivables(
  query: ListLabourReceivablesQuery,
): Promise<{
  records: LabourReceivableRecord[]
  totals: LabourReceivableTotals
  totalPages: number
}> {
  const clauses: QueryFilter<LabourBill>[] = []
  if (query.year) clauses.push({ year: query.year })
  const filter: QueryFilter<LabourBill> = clauses.length > 0 ? { $and: clauses } : {}

  const bills = await LabourBillModel.find(filter)
    .sort({ year: -1, month: -1 })
    .limit(MAX_RECEIVABLE_MONTHS)

  const all = await serializeReceivables(bills)
  const matching =
    query.status === 'all' ? all : all.filter((record) => record.paymentStatus === query.status)

  const totals: LabourReceivableTotals = {
    total: matching.length,
    billedAmount: matching.reduce((sum, record) => sum + record.billedAmount, 0),
    receivedAmount: matching.reduce((sum, record) => sum + record.receivedAmount, 0),
    outstanding: matching.reduce((sum, record) => sum + record.outstanding, 0),
  }

  const start = (query.page - 1) * query.limit
  return {
    records: matching.slice(start, start + query.limit),
    totals,
    totalPages: Math.max(1, Math.ceil(matching.length / query.limit)),
  }
}

async function findLabourBillOr404(id: string): Promise<LabourBillDocument> {
  const bill = await LabourBillModel.findById(id)
  if (!bill) {
    throw new AppError(404, 'Labour bill not found.')
  }
  return bill
}

/** One month: its CSD cards, and every payment received against any of them. */
export async function getLabourReceivable(
  id: string,
): Promise<{ month: LabourReceivableRecord; receipts: EntryRecord[] }> {
  const bill = await findLabourBillOr404(id)
  const [[month], entries] = await Promise.all([
    serializeReceivables([bill]),
    EntryModel.find({ labourBillId: bill._id, kind: 'Deposit' }).sort({ date: 1, createdAt: 1 }),
  ])

  return { month, receipts: await serializeEntries(entries) }
}

/**
 * The CSD sections still waiting on money, for a deposit to be recorded
 * against. The newest months first, because that is where an unpaid claim is.
 */
export interface LabourReceivableOption {
  billId: string
  billNumber: string
  periodLabel: string
  csd: string
  key: string
  billedAmount: number
  receivedAmount: number
  outstanding: number
}

export async function listReceivableLabourCsds(): Promise<LabourReceivableOption[]> {
  const bills = await LabourBillModel.find().sort({ year: -1, month: -1 }).limit(24)
  const months = await serializeReceivables(bills)

  return months.flatMap((month) =>
    month.csds
      .filter((csd) => csd.canReceive && csd.outstanding > 0)
      .map((csd) => ({
        billId: month.id,
        billNumber: month.billNumber,
        periodLabel: month.periodLabel,
        csd: csd.csd,
        key: csd.key,
        billedAmount: csd.billedAmount,
        receivedAmount: csd.receivedAmount,
        outstanding: csd.outstanding,
      })),
  )
}

/**
 * The bill and the CSD section a payment names, or a refusal saying which half
 * is wrong.
 *
 * The section is read off the sheet rather than trusted from the request, for
 * the reason `locationId` is the only location field a challan request may
 * carry: a client that could state what a CSD is owed could state any figure,
 * and the amount check below would then be checking the request against itself.
 */
export async function findLabourCsdSection(
  billId: string,
  csd: string,
): Promise<{ bill: LabourBillDocument; section: LabourCsdSummary }> {
  const bill = await findLabourBillOr404(billId)
  const key = comparisonKey(csd)

  const sections = (await labourCsdSummaries([bill._id as Types.ObjectId])).get(String(bill._id)) ?? []
  const section = sections.find((candidate) => candidate.key === key)

  if (!section) {
    throw new AppError(
      404,
      `${bill.billNumber} has no ${csd.trim().toUpperCase() || 'matching'} rows, so there is nothing to receive against.`,
    )
  }
  if (section.isPending) {
    throw new AppError(
      409,
      `Those rows are still waiting for a Trip DO, so they belong to no CSD and nobody has been billed for them. Set their Trip DO on the sheet first.`,
    )
  }

  return { bill, section }
}
