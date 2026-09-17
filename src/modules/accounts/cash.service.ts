import type { PipelineStage, Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { MAX_CASH_SUMMARY_MONTHS, cashFlowOf, monthsBetween, periodKey, periodLabel, periodRange } from './accounts.constants'
import type { EntryKind, Period } from './accounts.constants'
import { EntryModel, WalletModel } from './accounts.model'
import { listWallets } from './wallet.service'
import type { WalletRecord } from './wallet.service'

/**
 * Cash, on its own: the cash wallets' balance, and every taka that has gone
 * into and out of them — all time, and month by month or year by year over a
 * range.
 *
 * Every transaction runs through cash (see `requiresCashWallet`): money is
 * added into it, and every expense, advance and vendor payment leaves from it.
 * A bank or mobile wallet only ever receives a Walton payment, so it never
 * appears here. A transfer between two cash wallets moves nothing and is left
 * out of both sides; the transfer buckets hold only transfers written before
 * bank and mobile wallets were closed to them.
 */

export interface CashFigures {
  /** Money deposited straight into cash. */
  deposits: number
  /** Money moved into cash from a bank or mobile wallet. */
  transfersIn: number
  /** Cash handed back against an advance. Taken off `advances`, never added to money in. */
  advanceReturns: number
  moneyIn: number
  vendorPayments: number
  tripAdvances: number
  /** Advances given. */
  advances: number
  /** Advances given less the cash returned against them — the advance figure in money out. */
  advancesNet: number
  expenses: number
  /** Money moved out of cash into a bank or mobile wallet. */
  transfersOut: number
  moneyOut: number
  /** In less out. */
  net: number
}

export type CashGroup = 'month' | 'year'

export interface CashSummaryRow extends CashFigures {
  key: string
  label: string
  year: number
  /** Null on a yearly row. */
  month: number | null
}

export interface CashSummary {
  wallets: WalletRecord[]
  balance: number
  allTime: CashFigures
  range: {
    from: Period & { label: string }
    to: Period & { label: string }
    group: CashGroup
    rows: CashSummaryRow[]
    totals: CashFigures
  }
}

/** The bucket each leg of an entry falls into, from the cash wallet's side. */
const BUCKET_BY_KIND: Partial<Record<EntryKind, keyof CashFigures>> = {
  Deposit: 'deposits',
  AdvanceReturn: 'advanceReturns',
  VendorPayment: 'vendorPayments',
  TripAdvance: 'tripAdvances',
  Advance: 'advances',
  Expense: 'expenses',
}


function emptyFigures(): CashFigures {
  return {
    deposits: 0,
    transfersIn: 0,
    advanceReturns: 0,
    moneyIn: 0,
    vendorPayments: 0,
    tripAdvances: 0,
    advances: 0,
    advancesNet: 0,
    expenses: 0,
    transfersOut: 0,
    moneyOut: 0,
    net: 0,
  }
}

/** Money in, money out and net, with advance returns taken off money out — see `cashFlowOf`. */
function finish(figures: CashFigures): CashFigures {
  Object.assign(figures, cashFlowOf(figures))
  return figures
}

interface LegRow {
  _id: { year: number; month: number; bucket: keyof CashFigures }
  amount: number
}

/**
 * Every leg that touches a cash wallet, summed by month and bucket. One entry
 * gives at most two legs — its own wallet, and a transfer's destination — and
 * a leg whose other side is also cash is dropped, because moving money between
 * two cash boxes neither brings cash in nor sends it out.
 */
async function cashLegs(cashIds: Types.ObjectId[], date?: { $gte: Date; $lt: Date }): Promise<LegRow[]> {
  if (cashIds.length === 0) {
    return []
  }

  const pipeline: PipelineStage[] = [
    {
      $match: {
        $or: [{ walletId: { $in: cashIds } }, { toWalletId: { $in: cashIds } }],
        ...(date ? { date } : {}),
      },
    },
    {
      $project: {
        date: 1,
        legs: [
          {
            wallet: '$walletId',
            other: '$toWalletId',
            bucket: {
              $switch: {
                branches: [
                  ...Object.entries(BUCKET_BY_KIND).map(([kind, bucket]) => ({ case: { $eq: ['$kind', kind] }, then: bucket })),
                  { case: { $eq: ['$kind', 'Transfer'] }, then: 'transfersOut' },
                ],
                default: null,
              },
            },
            amount: '$amount',
          },
          { wallet: '$toWalletId', other: '$walletId', bucket: 'transfersIn', amount: '$amount' },
        ],
      },
    },
    { $unwind: '$legs' },
    {
      $match: {
        'legs.wallet': { $in: cashIds },
        'legs.other': { $nin: cashIds },
        'legs.bucket': { $ne: null },
      },
    },
    {
      $group: {
        _id: { year: { $year: '$date' }, month: { $month: '$date' }, bucket: '$legs.bucket' },
        amount: { $sum: '$legs.amount' },
      },
    },
  ]

  return EntryModel.aggregate<LegRow>(pipeline)
}

function addLeg(figures: CashFigures, row: LegRow): void {
  figures[row._id.bucket] += row.amount
}

export async function getCashSummary(from: Period, to: Period, group: CashGroup): Promise<CashSummary> {
  const months = monthsBetween(from, to)
  if (months.length === 0) {
    throw new AppError(400, 'The range has to end on or after the month it starts.')
  }
  if (months.length > MAX_CASH_SUMMARY_MONTHS) {
    throw new AppError(400, `A cash summary can cover at most ${MAX_CASH_SUMMARY_MONTHS / 12} years.`)
  }

  const cashWallets = await WalletModel.find({ kind: 'Cash' }).select('_id')
  const cashIds = cashWallets.map((wallet) => wallet._id)
  const range = { $gte: periodRange(from).start, $lt: periodRange(to).end }

  const [wallets, allLegs, rangeLegs] = await Promise.all([
    listWallets(),
    cashLegs(cashIds),
    cashLegs(cashIds, range),
  ])

  const allTime = emptyFigures()
  allLegs.forEach((row) => addLeg(allTime, row))
  finish(allTime)

  const rows = new Map<string, CashSummaryRow>()
  for (const period of months) {
    const key = group === 'year' ? String(period.year) : periodKey(period)
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        label: group === 'year' ? String(period.year) : periodLabel(period),
        year: period.year,
        month: group === 'year' ? null : period.month,
        ...emptyFigures(),
      })
    }
  }

  const totals = emptyFigures()
  for (const leg of rangeLegs) {
    const key = group === 'year' ? String(leg._id.year) : periodKey(leg._id)
    const row = rows.get(key)
    if (row) addLeg(row, leg)
    addLeg(totals, leg)
  }
  rows.forEach((row) => finish(row))
  finish(totals)

  const cash = wallets.filter((wallet) => wallet.kind === 'Cash')

  return {
    wallets: cash,
    balance: cash.reduce((total, wallet) => total + wallet.balance, 0),
    allTime,
    range: {
      from: { ...from, label: periodLabel(from) },
      to: { ...to, label: periodLabel(to) },
      group,
      rows: [...rows.values()].reverse(),
      totals,
    },
  }
}
