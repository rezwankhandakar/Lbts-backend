import type { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { BillModel } from '../bill/bill.model'
import { DeliveryModel } from '../delivery/delivery.model'
import {
  MAX_REPORT_MONTHS,
  marginOf,
  monthsBetween,
  outstandingOf,
  periodFromIndex,
  periodIndex,
  periodKey,
  periodLabel,
  periodRange,
  profitOf,
  totalCostOf,
} from './accounts.constants'
import type { Period } from './accounts.constants'
import { EntryModel, FinalBillModel } from './accounts.model'
import { serializeEntries } from './accounts.serializer'
import type { EntryRecord } from './accounts.serializer'
import { getCashSummary } from './cash.service'
import type { CashFigures } from './cash.service'
import type { WalletRecord } from './wallet.service'

/**
 * Profit and loss, and the overview page.
 *
 * **Income is the Walton final bill and nothing else.** The Excel bill is what
 * was asked for and the audit decides what is paid, so a month without its
 * final bill has no income yet rather than a guessed one — it is listed as
 * pending, with what its Excel bills asked for, and left out of profit.
 *
 * **Costs are accrued, not paid.** A trip's rent and labour bill count in the
 * month the trip ran, whether or not the vendor has been paid; an office
 * expense counts on its date; an advance counts only once it is accepted as an
 * expense. Paying a vendor moves money but is not a cost a second time.
 */

type PeriodLabelled = Period & { label: string }

function labelled(period: Period): PeriodLabelled {
  return { year: period.year, month: period.month, label: periodLabel(period) }
}

export interface ProfitLossMonth extends PeriodLabelled {
  income: number
  tripRent: number
  labourBill: number
  officeExpense: number
  totalCost: number
  profit: number
  margin: number | null
  tripCount: number
  blankBills: number
  finalBillCount: number
  /** Units with an Excel bill this month and no final bill yet. */
  pendingUnits: string[]
  pendingSubmitted: number
}

export interface ProfitLossReport {
  from: PeriodLabelled
  to: PeriodLabelled
  months: ProfitLossMonth[]
  summary: Omit<ProfitLossMonth, keyof PeriodLabelled | 'pendingUnits'> & { pendingSlots: number }
  incomeByUnit: { unit: string; finalAmount: number; submittedAmount: number; difference: number; months: number }[]
  /** Office expenses by the name they were recorded under, case ignored. */
  expenseByName: { name: string; amount: number; share: number }[]
  costByVendor: { vendorId: string; vendorCode: string; name: string; tripCount: number; tripRent: number; labourBill: number; total: number }[]
  pendingFinalBills: (PeriodLabelled & { unit: string; submittedAmount: number; excelBillCount: number })[]
}

function monthClause(months: Period[]): { $or: { year: number; month: number }[] } {
  return { $or: months.map((period) => ({ year: period.year, month: period.month })) }
}

export async function profitAndLoss(from: Period, to: Period): Promise<ProfitLossReport> {
  const months = monthsBetween(from, to)
  if (months.length === 0) {
    throw new AppError(400, 'The report has to end on or after the month it starts.')
  }
  if (months.length > MAX_REPORT_MONTHS) {
    throw new AppError(400, `A report can cover at most ${MAX_REPORT_MONTHS} months.`)
  }

  const start = periodRange(from).start
  const end = periodRange(to).end
  const byMonth = { year: { $year: '$tripDate' }, month: { $month: '$tripDate' } }

  const [finalBills, excelBills, tripMonths, vendorCosts, expenseRows] = await Promise.all([
    FinalBillModel.find(monthClause(months)).select('year month unit unitKey finalAmount').lean(),
    BillModel.find(monthClause(months)).select('year month unit unitKey totalAmount').lean(),
    DeliveryModel.aggregate<{
      _id: Period
      tripCount: number
      tripRent: number
      labourBill: number
      blankBills: number
    }>([
      { $match: { tripDate: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: byMonth,
          tripCount: { $sum: 1 },
          tripRent: { $sum: { $ifNull: ['$tripRent', 0] } },
          labourBill: { $sum: { $ifNull: ['$labourBill', 0] } },
          blankBills: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: [{ $ifNull: ['$tripRent', null] }, null] },
                    { $eq: [{ $ifNull: ['$labourBill', null] }, null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    DeliveryModel.aggregate<{
      _id: Types.ObjectId
      vendor: { vendorCode: string; name: string }
      tripCount: number
      tripRent: number
      labourBill: number
    }>([
      { $match: { tripDate: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: '$vendorId',
          vendor: { $first: '$vendor' },
          tripCount: { $sum: 1 },
          tripRent: { $sum: { $ifNull: ['$tripRent', 0] } },
          labourBill: { $sum: { $ifNull: ['$labourBill', 0] } },
        },
      },
    ]),
    EntryModel.aggregate<{ _id: { year: number; month: number; key: string }; name: string; amount: number }>([
      { $match: { kind: { $in: ['Expense', 'AdvanceAdjust'] }, date: { $gte: start, $lt: end } } },
      // Oldest first, so a name reads in the spelling it was first recorded in.
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: { year: { $year: '$date' }, month: { $month: '$date' }, key: { $toLower: '$expenseName' } },
          name: { $first: '$expenseName' },
          amount: { $sum: '$amount' },
        },
      },
    ]),
  ])

  const finalBySlot = new Set(finalBills.map((bill) => `${bill.year}-${bill.month}-${bill.unitKey}`))
  const tripsBy = new Map(tripMonths.map((row) => [periodKey(row._id), row]))

  const monthRows: ProfitLossMonth[] = months.map((period) => {
    const key = periodKey(period)
    const trips = tripsBy.get(key)
    const finals = finalBills.filter((bill) => bill.year === period.year && bill.month === period.month)
    const pending = excelBills.filter(
      (bill) =>
        bill.year === period.year && bill.month === period.month && !finalBySlot.has(`${bill.year}-${bill.month}-${bill.unitKey}`),
    )
    const figures = {
      income: finals.reduce((total, bill) => total + bill.finalAmount, 0),
      tripRent: trips?.tripRent ?? 0,
      labourBill: trips?.labourBill ?? 0,
      officeExpense: expenseRows
        .filter((row) => row._id.year === period.year && row._id.month === period.month)
        .reduce((total, row) => total + row.amount, 0),
    }
    return {
      ...labelled(period),
      ...figures,
      totalCost: totalCostOf(figures),
      profit: profitOf(figures),
      margin: marginOf(figures),
      tripCount: trips?.tripCount ?? 0,
      blankBills: trips?.blankBills ?? 0,
      finalBillCount: finals.length,
      pendingUnits: [...new Set(pending.map((bill) => bill.unit))],
      pendingSubmitted: Math.round(pending.reduce((total, bill) => total + bill.totalAmount, 0)),
    }
  })

  const add = (pick: (row: ProfitLossMonth) => number) => monthRows.reduce((total, row) => total + pick(row), 0)
  const summaryFigures = {
    income: add((row) => row.income),
    tripRent: add((row) => row.tripRent),
    labourBill: add((row) => row.labourBill),
    officeExpense: add((row) => row.officeExpense),
  }

  // Income by unit, with what the Excel bills for the same unit-months asked for.
  const units = new Map<string, { unit: string; finalAmount: number; submittedAmount: number; months: number }>()
  for (const bill of finalBills) {
    const row = units.get(bill.unitKey) ?? { unit: bill.unit, finalAmount: 0, submittedAmount: 0, months: 0 }
    row.finalAmount += bill.finalAmount
    row.months += 1
    row.submittedAmount += excelBills
      .filter((excel) => excel.year === bill.year && excel.month === bill.month && excel.unitKey === bill.unitKey)
      .reduce((total, excel) => total + excel.totalAmount, 0)
    units.set(bill.unitKey, row)
  }

  const expenseNames = new Map<string, { name: string; amount: number }>()
  for (const row of expenseRows) {
    const current = expenseNames.get(row._id.key) ?? { name: row.name || 'Unnamed expense', amount: 0 }
    current.amount += row.amount
    expenseNames.set(row._id.key, current)
  }

  const pendingSlots = new Map<string, PeriodLabelled & { unit: string; submittedAmount: number; excelBillCount: number }>()
  for (const bill of excelBills) {
    const key = `${bill.year}-${bill.month}-${bill.unitKey}`
    if (finalBySlot.has(key)) continue
    const row = pendingSlots.get(key) ?? {
      ...labelled(bill),
      unit: bill.unit,
      submittedAmount: 0,
      excelBillCount: 0,
    }
    row.submittedAmount += bill.totalAmount
    row.excelBillCount += 1
    pendingSlots.set(key, row)
  }

  return {
    from: labelled(from),
    to: labelled(to),
    months: monthRows,
    summary: {
      ...summaryFigures,
      totalCost: totalCostOf(summaryFigures),
      profit: profitOf(summaryFigures),
      margin: marginOf(summaryFigures),
      tripCount: add((row) => row.tripCount),
      blankBills: add((row) => row.blankBills),
      finalBillCount: add((row) => row.finalBillCount),
      pendingSubmitted: add((row) => row.pendingSubmitted),
      pendingSlots: pendingSlots.size,
    },
    incomeByUnit: [...units.values()]
      .map((row) => ({
        ...row,
        submittedAmount: Math.round(row.submittedAmount),
        difference: Math.round(row.finalAmount - row.submittedAmount),
      }))
      .sort((a, b) => b.finalAmount - a.finalAmount),
    expenseByName: [...expenseNames.values()]
      .map(({ name, amount }) => ({
        name,
        amount,
        share: summaryFigures.officeExpense > 0 ? Math.round((amount / summaryFigures.officeExpense) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.amount - a.amount),
    costByVendor: vendorCosts
      .map((row) => ({
        vendorId: String(row._id),
        vendorCode: row.vendor?.vendorCode ?? '—',
        name: row.vendor?.name ?? 'Removed vendor',
        tripCount: row.tripCount,
        tripRent: row.tripRent,
        labourBill: row.labourBill,
        total: row.tripRent + row.labourBill,
      }))
      .sort((a, b) => b.total - a.total),
    pendingFinalBills: [...pendingSlots.values()]
      .map((row) => ({ ...row, submittedAmount: Math.round(row.submittedAmount) }))
      .sort((a, b) => periodIndex(b) - periodIndex(a) || a.unit.localeCompare(b.unit)),
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface AccountsOverview {
  today: string
  period: PeriodLabelled
  /**
   * Cash alone — the wallets that pay vendors, advances and expenses. Bank and
   * mobile wallets are not added in; they are on the Cash Book and Settings.
   */
  cash: {
    wallets: WalletRecord[]
    balance: number
    allTime: CashFigures
    thisMonth: CashFigures
  }
  vendorDue: { total: number; vendors: number; blankBills: number }
  advances: { outstanding: number; count: number }
  receivable: { outstanding: number; count: number }
  profitLoss: ProfitLossMonth
  trend: ProfitLossMonth[]
  pendingFinalBills: number
  recentEntries: EntryRecord[]
}

/**
 * Everything the Accounts landing page shows, in one request — several calls
 * against a sleeping Render instance would be several cold starts stacked.
 */
export async function getOverview(today: string): Promise<AccountsOverview> {
  const current: Period = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }
  const trendFrom = periodFromIndex(periodIndex(current) - 5)

  const [cash, vendorDue, advances, receivable, report, recent] = await Promise.all([
    getCashSummary(current, current, 'month'),
    vendorDueTotals(),
    EntryModel.aggregate<{ outstanding: number; count: number }>([
      { $match: { kind: 'Advance', settlementStatus: { $in: ['Open', 'Partial'] } } },
      {
        $group: {
          _id: null,
          outstanding: { $sum: { $max: [0, { $subtract: ['$amount', '$settledAmount'] }] } },
          count: { $sum: 1 },
        },
      },
    ]),
    FinalBillModel.find({ paymentStatus: { $in: ['Open', 'Partial'] } }).select('finalAmount receivedAmount').lean(),
    profitAndLoss(trendFrom, current),
    EntryModel.find({}).sort({ date: -1, createdAt: -1 }).limit(8),
  ])

  return {
    today,
    period: labelled(current),
    cash: {
      wallets: cash.wallets.filter((wallet) => wallet.isActive || wallet.balance !== 0),
      balance: cash.balance,
      allTime: cash.allTime,
      thisMonth: cash.range.totals,
    },
    vendorDue,
    advances: { outstanding: advances[0]?.outstanding ?? 0, count: advances[0]?.count ?? 0 },
    receivable: {
      outstanding: receivable.reduce((total, bill) => total + outstandingOf(bill.finalAmount, bill.receivedAmount ?? 0), 0),
      count: receivable.length,
    },
    profitLoss: report.months[report.months.length - 1],
    trend: report.months,
    pendingFinalBills: report.pendingFinalBills.length,
    recentEntries: await serializeEntries(recent),
  }
}

/**
 * What is owed to vendors across every month: per vendor, the bills entered
 * less advances less payments, counting only vendors still owed something.
 */
async function vendorDueTotals(): Promise<{ total: number; vendors: number; blankBills: number }> {
  const [trips, settlements] = await Promise.all([
    DeliveryModel.aggregate<{ _id: Types.ObjectId; bill: number; blankBills: number }>([
      {
        $group: {
          _id: '$vendorId',
          bill: { $sum: { $add: [{ $ifNull: ['$tripRent', 0] }, { $ifNull: ['$labourBill', 0] }] } },
          blankBills: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: [{ $ifNull: ['$tripRent', null] }, null] },
                    { $eq: [{ $ifNull: ['$labourBill', null] }, null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    EntryModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { kind: { $in: ['TripAdvance', 'VendorPayment'] } } },
      { $group: { _id: '$vendorId', amount: { $sum: '$amount' } } },
    ]),
  ])

  const settled = new Map(settlements.map((row) => [String(row._id), row.amount]))
  let total = 0
  let vendors = 0
  for (const row of trips) {
    const due = row.bill - (settled.get(String(row._id)) ?? 0)
    if (due > 0) {
      total += due
      vendors += 1
    }
  }

  return { total, vendors, blankBills: trips.reduce((sum, row) => sum + row.blankBills, 0) }
}
