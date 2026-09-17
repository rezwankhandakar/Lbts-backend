import { Types } from 'mongoose'
import type { PipelineStage } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { CASH_ENTRY_FILTER, MONEY_IN_KINDS, OUT_REDUCING_KINDS } from './accounts.constants'
import type { WalletKind } from './accounts.constants'
import { EntryModel, WalletModel } from './accounts.model'
import type { WalletDocument } from './accounts.model'
import { toDay } from './accounts.serializer'
import type { UpdateWalletInput, WalletInput } from './accounts.validation'

/** Lower-cased and space-collapsed: the form two names are compared in. */
export function nameKeyOf(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface WalletFigures {
  balance: number
  moneyIn: number
  moneyOut: number
  entryCount: number
  lastEntryDate: string | null
}

const EMPTY_FIGURES: WalletFigures = { balance: 0, moneyIn: 0, moneyOut: 0, entryCount: 0, lastEntryDate: null }

/**
 * Every wallet's balance, from the entries alone.
 *
 * Each entry is split into the legs it moves: its own wallet, signed by which
 * way the kind goes, and — for a transfer — the destination wallet, positive.
 * An advance accepted as an expense has no wallet and so no legs. One pass
 * over the collection answers every wallet at once.
 */
export async function walletFigures(match: Record<string, unknown> = {}): Promise<Map<string, WalletFigures>> {
  const pipeline: PipelineStage[] = [
    { $match: { ...match, $or: [{ walletId: { $ne: null } }, { toWalletId: { $ne: null } }] } },
    {
      $project: {
        date: 1,
        legs: [
          {
            wallet: '$walletId',
            amount: {
              $cond: [{ $in: ['$kind', [...MONEY_IN_KINDS]] }, '$amount', { $multiply: ['$amount', -1] }],
            },
            returned: { $in: ['$kind', [...OUT_REDUCING_KINDS]] },
          },
          { wallet: '$toWalletId', amount: '$amount', returned: false },
        ],
      },
    },
    { $unwind: '$legs' },
    { $match: { 'legs.wallet': { $ne: null } } },
    {
      $group: {
        _id: '$legs.wallet',
        balance: { $sum: '$legs.amount' },
        // A return raises the balance but is taken off money out, not added to money in.
        moneyIn: { $sum: { $cond: [{ $and: [{ $gt: ['$legs.amount', 0] }, { $not: ['$legs.returned'] }] }, '$legs.amount', 0] } },
        moneyOut: {
          $sum: {
            $cond: [
              { $lt: ['$legs.amount', 0] },
              { $multiply: ['$legs.amount', -1] },
              { $cond: ['$legs.returned', { $multiply: ['$legs.amount', -1] }, 0] },
            ],
          },
        },
        entryCount: { $sum: 1 },
        lastEntryDate: { $max: '$date' },
      },
    },
  ]

  const rows = await EntryModel.aggregate<{
    _id: Types.ObjectId
    balance: number
    moneyIn: number
    moneyOut: number
    entryCount: number
    lastEntryDate: Date | null
  }>(pipeline)

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        balance: row.balance,
        moneyIn: row.moneyIn,
        moneyOut: row.moneyOut,
        entryCount: row.entryCount,
        lastEntryDate: row.lastEntryDate ? toDay(row.lastEntryDate) : null,
      },
    ]),
  )
}

/** One wallet's balance before a day — a cash book's opening figure. */
export async function walletBalanceBefore(walletId: string, day: Date): Promise<number> {
  const id = new Types.ObjectId(walletId)
  const figures = await walletFigures({ date: { $lt: day }, $and: [{ $or: [{ walletId: id }, { toWalletId: id }] }] })
  return figures.get(walletId)?.balance ?? 0
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export interface WalletRecord extends WalletFigures {
  id: string
  name: string
  kind: WalletKind
  accountNumber: string
  note: string
  isActive: boolean
  createdAt: string
}

function toWalletRecord(wallet: WalletDocument, figures: WalletFigures | undefined): WalletRecord {
  return {
    id: String(wallet._id),
    name: wallet.name,
    kind: wallet.kind as WalletKind,
    accountNumber: wallet.accountNumber ?? '',
    note: wallet.note ?? '',
    isActive: wallet.isActive,
    createdAt: wallet.createdAt.toISOString(),
    ...(figures ?? EMPTY_FIGURES),
  }
}

export async function listWallets(): Promise<WalletRecord[]> {
  const [wallets, figures] = await Promise.all([WalletModel.find({}).sort({ isActive: -1, createdAt: 1 }), walletFigures()])
  return wallets.map((wallet) => toWalletRecord(wallet, figures.get(String(wallet._id))))
}

async function walletRecordOf(wallet: WalletDocument): Promise<WalletRecord> {
  const id = wallet._id
  const figures = await walletFigures({ $and: [{ $or: [{ walletId: id }, { toWalletId: id }] }] })
  return toWalletRecord(wallet, figures.get(String(id)))
}

export async function findWallet(id: string): Promise<WalletDocument> {
  const wallet = await WalletModel.findById(id)
  if (!wallet) {
    throw new AppError(404, 'Wallet not found.')
  }
  return wallet
}

/** Money can only be recorded against a wallet still in use. */
export async function findActiveWallet(id: string): Promise<WalletDocument> {
  const wallet = await findWallet(id)
  if (!wallet.isActive) {
    throw new AppError(409, `${wallet.name} is closed. Reopen it, or choose another wallet.`)
  }
  return wallet
}

export async function createWallet(input: WalletInput, actor: UserDocument): Promise<WalletRecord> {
  try {
    const wallet = await WalletModel.create({
      ...input,
      nameKey: nameKeyOf(input.name),
      createdBy: actor._id,
    })
    return toWalletRecord(wallet, undefined)
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, `A wallet named "${input.name}" already exists.`)
    }
    throw error
  }
}

export async function updateWallet(id: string, input: UpdateWalletInput, actor: UserDocument): Promise<WalletRecord> {
  const wallet = await findWallet(id)
  if (input.name !== undefined) {
    wallet.name = input.name
    wallet.nameKey = nameKeyOf(input.name)
  }
  if (input.kind !== undefined && input.kind !== wallet.kind) {
    // A cash wallet with any transaction but a Walton payment cannot stop being
    // cash: every one of those is cash only, and would then be a bank's.
    const cashHistory =
      wallet.kind === 'Cash' &&
      (await EntryModel.exists({ $or: [{ walletId: wallet._id, ...CASH_ENTRY_FILTER }, { toWalletId: wallet._id }] }))
    if (cashHistory) {
      throw new AppError(
        409,
        `${wallet.name} holds cash transactions, which are cash only, so it has to stay a cash wallet.`,
      )
    }
    wallet.kind = input.kind
  }
  if (input.accountNumber !== undefined) wallet.accountNumber = input.accountNumber
  if (input.note !== undefined) wallet.note = input.note
  if (input.isActive !== undefined) wallet.isActive = input.isActive
  wallet.updatedBy = actor._id

  try {
    await wallet.save()
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, `A wallet named "${wallet.name}" already exists.`)
    }
    throw error
  }
  return walletRecordOf(wallet)
}

/**
 * A wallet nothing was ever recorded against is deleted. One with history is
 * closed instead — deleting it would leave entries pointing at nothing and a
 * cash book that no longer adds up.
 */
export async function removeWallet(id: string, actor: UserDocument): Promise<{ id: string; outcome: 'deleted' | 'closed' }> {
  const wallet = await findWallet(id)
  const used = await EntryModel.exists({ $or: [{ walletId: wallet._id }, { toWalletId: wallet._id }] })

  if (!used) {
    await wallet.deleteOne()
    return { id, outcome: 'deleted' }
  }

  wallet.isActive = false
  wallet.updatedBy = actor._id
  await wallet.save()
  return { id, outcome: 'closed' }
}
