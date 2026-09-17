import type { Types } from 'mongoose'
import { resolveActorNames } from '../vendor/vendor.lookups'
import { entryDirection, outstandingOf, periodLabel } from './accounts.constants'
import type {
  DepositSource,
  EntryDirection,
  EntryKind,
  SettlementStatus,
  WalletKind,
} from './accounts.constants'
import { FinalBillModel, WalletModel } from './accounts.model'
import type { EntryDocument, FinalBillDocument, WalletDocument } from './accounts.model'

export interface ActorRef {
  id: string
  name: string
}

export interface WalletRef {
  id: string
  name: string
  kind: WalletKind
}

export interface EntryRecord {
  id: string
  entryNumber: string
  kind: EntryKind
  direction: EntryDirection
  /** `YYYY-MM-DD`. */
  date: string
  amount: number
  wallet: WalletRef | null
  toWallet: WalletRef | null
  party: string
  partyPhone: string
  reference: string
  note: string
  source: DepositSource | null
  finalBill: { id: string; label: string } | null
  /** What an expense, or an advance accepted as one, was for. Empty for every other kind. */
  expenseName: string
  purpose: string
  /** An advance: how much of it has been returned or accepted as an expense. */
  settledAmount: number
  outstanding: number
  settlementStatus: SettlementStatus | null
  advance: { id: string; entryNumber: string } | null
  vendor: { id: string; vendorCode: string; name: string } | null
  trip: { id: string; tripNumber: string; tripDate: string; registrationNo: string; driverName: string } | null
  period: { year: number; month: number; label: string } | null
  createdBy: ActorRef | null
  createdAt: string
  updatedBy: ActorRef | null
  updatedAt: string
}

function actorOf(id: Types.ObjectId | null | undefined, names: Map<string, string>): ActorRef | null {
  if (!id) {
    return null
  }
  const key = String(id)
  return { id: key, name: names.get(key) ?? 'Removed account' }
}

export function toDay(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function toWalletRef(wallet: WalletDocument | undefined): WalletRef | null {
  return wallet ? { id: String(wallet._id), name: wallet.name, kind: wallet.kind as WalletKind } : null
}

export function finalBillLabel(bill: Pick<FinalBillDocument, 'unit' | 'year' | 'month'>): string {
  return `${bill.unit} · ${periodLabel({ year: bill.year, month: bill.month })}`
}

interface EntryContext {
  wallets: Map<string, WalletDocument>
  finalBills: Map<string, string>
  names: Map<string, string>
}

export function toEntryRecord(entry: EntryDocument, context: EntryContext): EntryRecord {
  const kind = entry.kind as EntryKind
  const wallet = (id: Types.ObjectId | null | undefined) =>
    id ? toWalletRef(context.wallets.get(String(id))) ?? { id: String(id), name: 'Removed wallet', kind: 'Cash' } : null

  return {
    id: String(entry._id),
    entryNumber: entry.entryNumber,
    kind,
    direction: entryDirection(kind),
    date: toDay(entry.date),
    amount: entry.amount,
    wallet: wallet(entry.walletId),
    toWallet: wallet(entry.toWalletId),
    party: entry.party ?? '',
    partyPhone: entry.partyPhone ?? '',
    reference: entry.reference ?? '',
    note: entry.note ?? '',
    source: (entry.source as DepositSource | null) ?? null,
    finalBill: entry.finalBillId
      ? { id: String(entry.finalBillId), label: context.finalBills.get(String(entry.finalBillId)) ?? 'Removed bill' }
      : null,
    expenseName: entry.expenseName ?? '',
    purpose: entry.purpose ?? '',
    settledAmount: entry.settledAmount ?? 0,
    outstanding: kind === 'Advance' ? outstandingOf(entry.amount, entry.settledAmount ?? 0) : 0,
    settlementStatus: (entry.settlementStatus as SettlementStatus | null) ?? null,
    advance: entry.advanceId ? { id: String(entry.advanceId), entryNumber: entry.advanceNumber ?? '' } : null,
    vendor:
      entry.vendorId && entry.vendor
        ? { id: String(entry.vendorId), vendorCode: entry.vendor.vendorCode, name: entry.vendor.name }
        : null,
    trip:
      entry.tripId && entry.trip
        ? {
            id: String(entry.tripId),
            tripNumber: entry.trip.tripNumber,
            tripDate: toDay(entry.trip.tripDate),
            registrationNo: entry.trip.registrationNo ?? '',
            driverName: entry.trip.driverName ?? '',
          }
        : null,
    period: entry.period
      ? { year: entry.period.year, month: entry.period.month, label: periodLabel(entry.period) }
      : null,
    createdBy: actorOf(entry.createdBy, context.names),
    createdAt: entry.createdAt.toISOString(),
    updatedBy: actorOf(entry.updatedBy, context.names),
    updatedAt: entry.updatedAt.toISOString(),
  }
}

/**
 * Entries as records, with everything they reference resolved in three reads
 * however many there are: the wallets, the final bills and the people.
 */
export async function serializeEntries(entries: EntryDocument[]): Promise<EntryRecord[]> {
  if (entries.length === 0) {
    return []
  }

  const walletIds = new Set<string>()
  const billIds = new Set<string>()
  for (const entry of entries) {
    if (entry.walletId) walletIds.add(String(entry.walletId))
    if (entry.toWalletId) walletIds.add(String(entry.toWalletId))
    if (entry.finalBillId) billIds.add(String(entry.finalBillId))
  }

  const [wallets, bills, names] = await Promise.all([
    walletIds.size > 0 ? WalletModel.find({ _id: { $in: [...walletIds] } }) : Promise.resolve([]),
    billIds.size > 0 ? FinalBillModel.find({ _id: { $in: [...billIds] } }).select('unit year month') : Promise.resolve([]),
    resolveActorNames(entries.flatMap((entry) => [entry.createdBy, entry.updatedBy])),
  ])

  const context: EntryContext = {
    wallets: new Map(wallets.map((wallet) => [String(wallet._id), wallet])),
    finalBills: new Map(bills.map((bill) => [String(bill._id), finalBillLabel(bill)])),
    names,
  }

  return entries.map((entry) => toEntryRecord(entry, context))
}

export async function serializeEntry(entry: EntryDocument): Promise<EntryRecord> {
  const [record] = await serializeEntries([entry])
  return record
}

export { actorOf }
