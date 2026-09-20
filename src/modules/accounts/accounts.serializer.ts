import type { Types } from 'mongoose'
import { resolveActorNames } from '../vendor/vendor.lookups'
import { LabourBillModel } from '../labour-bill/labour-bill.model'
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

/**
 * The paper behind an entry, as a list renders it.
 *
 * `url` is an API path rather than a bucket URL: the object is private, so the
 * browser cannot put it in a `src` and fetches it through axios — the only
 * thing that attaches the Firebase token — exactly as it does a gate pass scan,
 * a vendor document and a signed challan copy.
 */
export interface VoucherRecord {
  url: string
  mimeType: string
  size: number
  originalName: string
  pageCount: number | null
  uploadedAt: string
  uploadedBy: ActorRef | null
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
  /** A Walton payment against one CSD of a month's labour bill. */
  labourBill: { id: string; csd: string; label: string } | null
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
  /** The voucher or invoice behind this entry, or null while none is on record. */
  voucher: VoucherRecord | null
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
  /** A labour bill's period, by id: "September 2026". */
  labourBills: Map<string, string>
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
    labourBill: entry.labourBillId
      ? {
          id: String(entry.labourBillId),
          csd: entry.labourCsd ?? '',
          // The CSD is the entry's own copy, so a receipt reads even after the
          // sheet has moved; the month comes from the bill it points at.
          label: [entry.labourCsd, context.labourBills.get(String(entry.labourBillId))]
            .filter(Boolean)
            .join(' · '),
        }
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
    voucher: entry.voucher
      ? {
          // The bucket never serves this. See `VoucherRecord`.
          url: `/accounts/entries/${String(entry._id)}/voucher`,
          mimeType: entry.voucher.mimeType,
          size: entry.voucher.size,
          originalName: entry.voucher.originalName ?? '',
          pageCount: entry.voucher.pageCount ?? null,
          uploadedAt: entry.voucher.uploadedAt.toISOString(),
          uploadedBy: actorOf(entry.voucher.uploadedBy, context.names),
        }
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
  const labourIds = new Set<string>()
  for (const entry of entries) {
    if (entry.walletId) walletIds.add(String(entry.walletId))
    if (entry.toWalletId) walletIds.add(String(entry.toWalletId))
    if (entry.finalBillId) billIds.add(String(entry.finalBillId))
    if (entry.labourBillId) labourIds.add(String(entry.labourBillId))
  }

  const [wallets, bills, labourBills, names] = await Promise.all([
    walletIds.size > 0 ? WalletModel.find({ _id: { $in: [...walletIds] } }) : Promise.resolve([]),
    billIds.size > 0 ? FinalBillModel.find({ _id: { $in: [...billIds] } }).select('unit year month') : Promise.resolve([]),
    labourIds.size > 0
      ? LabourBillModel.find({ _id: { $in: [...labourIds] } }).select('year month')
      : Promise.resolve([]),
    resolveActorNames(
      entries.flatMap((entry) => [entry.createdBy, entry.updatedBy, entry.voucher?.uploadedBy ?? null]),
    ),
  ])

  const context: EntryContext = {
    wallets: new Map(wallets.map((wallet) => [String(wallet._id), wallet])),
    finalBills: new Map(bills.map((bill) => [String(bill._id), finalBillLabel(bill)])),
    labourBills: new Map(
      labourBills.map((bill) => [String(bill._id), periodLabel({ year: bill.year, month: bill.month })]),
    ),
    names,
  }

  return entries.map((entry) => toEntryRecord(entry, context))
}

export async function serializeEntry(entry: EntryDocument): Promise<EntryRecord> {
  const [record] = await serializeEntries([entry])
  return record
}

export { actorOf }
