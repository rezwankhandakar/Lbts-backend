import { Types } from 'mongoose'
import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { nextSequence } from '../../utils/counter'
import { changeSummary, changesBetween, takaValue } from '../activity/activity.diff'
import type { FieldSpec } from '../activity/activity.diff'
import { recordActivity } from '../activity/activity.recorder'
import { DeliveryModel } from '../delivery/delivery.model'
import type { UserDocument } from '../user/user.model'
import { escapeRegex } from '../vendor/vendor.lookups'
import { VendorModel } from '../vendor/vendor.model'
import {
  ENTRY_KINDS,
  CASH_IN_KINDS,
  MONEY_OUT_KINDS,
  OUT_REDUCING_KINDS,
  entryCounterKey,
  formatEntryNumber,
  outstandingOf,
  periodLabel,
  requiresCashWallet,
} from './accounts.constants'
import type { EntryKind } from './accounts.constants'
import { EntryModel, FinalBillModel } from './accounts.model'
import { deleteVoucher } from './accounts.storage'
import type { Entry, EntryDocument } from './accounts.model'
import { finalBillLabel, serializeEntries, serializeEntry } from './accounts.serializer'
import { findLabourCsdSection } from './labour-receivable.service'
import type { EntryRecord } from './accounts.serializer'
import {
  receivedAgainstFinalBill,
  receivedAgainstLabourCsd,
  refreshAdvanceSettlement,
  refreshFinalBillReceipts,
  settledAgainstAdvance,
} from './accounts.settlement'
import type {
  CreateEntryInput,
  EntryInput,
  ListAdvancesQuery,
  ListEntriesQuery,
  UpdateEntryInput,
} from './accounts.validation'
import { vendorMonthFigures } from './vendor-bill.service'
import { findActiveWallet, findWallet, walletBalanceBefore } from './wallet.service'

function taka(value: number): string {
  return `৳${value.toLocaleString('en-IN')}`
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

function sameId(a: Types.ObjectId | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && String(a) === b)
}

/**
 * The refusal for a bank or mobile wallet anywhere but a Walton payment. It
 * names what those wallets are for, because "not a cash wallet" alone does not
 * say where the money should have gone.
 */
function notCash(kind: EntryKind, walletName: string): AppError {
  const what =
    kind === 'Deposit'
      ? 'Money is added into cash only'
      : kind === 'Transfer'
        ? 'Money moves between cash wallets only'
        : `${describeKind(kind)[0].toUpperCase()}${describeKind(kind).slice(1)} is cash only`
  return new AppError(
    409,
    `${what}, and ${walletName} is not a cash wallet. Bank and mobile wallets receive Walton bill payments and nothing else.`,
  )
}

export async function findEntry(id: string): Promise<EntryDocument> {
  const entry = await EntryModel.findById(id)
  if (!entry) {
    throw new AppError(404, 'Entry not found.')
  }
  return entry
}

// ---------------------------------------------------------------------------
// Turning a request into fields
// ---------------------------------------------------------------------------

/**
 * Every field a kind writes, resolved and checked, with everything a request
 * does not name set back to empty. `existing` is the entry being corrected, so
 * a wallet closed since it was written does not refuse an
 * unrelated correction, and its own amount is not counted against itself.
 */
async function resolveFields(input: EntryInput, existing: EntryDocument | null): Promise<Partial<Entry>> {
  const fields: Record<string, unknown> = {
    kind: input.kind,
    date: input.date,
    amount: input.amount,
    reference: input.reference,
    note: input.note,
    walletId: null,
    toWalletId: null,
    party: '',
    partyPhone: '',
    source: null,
    finalBillId: null,
    labourBillId: null,
    labourCsdKey: '',
    labourCsd: '',
    expenseName: '',
    purpose: '',
    advanceId: null,
    advanceNumber: '',
    vendorId: null,
    vendor: null,
    tripId: null,
    trip: null,
    period: null,
  }

  const walletFor = async (id: string) =>
    sameId(existing?.walletId, id) || sameId(existing?.toWalletId, id) ? findWallet(id) : findActiveWallet(id)

  if ('walletId' in input) {
    const wallet = await walletFor(input.walletId)
    const againstWaltonBill =
      input.kind === 'Deposit' && Boolean(input.finalBillId || input.labourBillId)
    if (requiresCashWallet(input.kind, againstWaltonBill) && wallet.kind !== 'Cash') {
      throw notCash(input.kind, wallet.name)
    }
    fields.walletId = wallet._id
  }

  switch (input.kind) {
    case 'Deposit': {
      // Added into cash as a plain deposit; one recorded against a Walton bill
      // — the final bill, or one CSD of a month's labour bill — is a payment.
      fields.source = input.finalBillId || input.labourBillId ? 'Walton Bill' : 'Other'
      fields.party = input.party

      if (input.labourBillId) {
        const { bill, section } = await findLabourCsdSection(input.labourBillId, input.labourCsd)
        const received = await receivedAgainstLabourCsd(bill._id, section.key, existing?._id)
        const left = outstandingOf(section.totalAmount, received)
        if (input.amount > left) {
          throw new AppError(
            409,
            `${section.label} on ${bill.billNumber} has ${taka(left)} left to receive, so ${taka(input.amount)} cannot be recorded against it.`,
          )
        }
        fields.labourBillId = bill._id
        fields.labourCsdKey = section.key
        fields.labourCsd = section.csd
      }

      if (input.finalBillId) {
        const bill = await FinalBillModel.findById(input.finalBillId)
        if (!bill) {
          throw new AppError(404, 'That final bill no longer exists.')
        }
        const received = await receivedAgainstFinalBill(bill._id, existing?._id)
        const left = outstandingOf(bill.finalAmount, received)
        if (input.amount > left) {
          throw new AppError(
            409,
            `${finalBillLabel(bill)} has ${taka(left)} left to receive, so ${taka(input.amount)} cannot be recorded against it.`,
          )
        }
        fields.finalBillId = bill._id
      }
      break
    }

    case 'Transfer': {
      const destination = await walletFor(input.toWalletId)
      if (destination.kind !== 'Cash') {
        throw notCash('Transfer', destination.name)
      }
      fields.toWalletId = destination._id
      break
    }

    case 'Expense': {
      fields.expenseName = input.expenseName
      fields.party = input.party
      break
    }

    case 'Advance': {
      fields.party = input.party
      fields.partyPhone = input.partyPhone
      fields.purpose = input.purpose
      if (existing && input.amount < (existing.settledAmount ?? 0)) {
        throw new AppError(
          409,
          `${taka(existing.settledAmount ?? 0)} of this advance is already settled, so it cannot be less than that.`,
        )
      }
      break
    }

    case 'AdvanceReturn':
    case 'AdvanceAdjust': {
      const advance = await EntryModel.findById(input.advanceId)
      if (!advance || advance.kind !== 'Advance') {
        throw new AppError(404, 'That advance no longer exists.')
      }
      const settled = await settledAgainstAdvance(advance._id, existing?._id)
      const left = outstandingOf(advance.amount, settled)
      if (input.amount > left) {
        throw new AppError(
          409,
          `${advance.entryNumber} to ${advance.party} has ${taka(left)} outstanding, so ${taka(input.amount)} cannot be settled against it.`,
        )
      }
      fields.advanceId = advance._id
      fields.advanceNumber = advance.entryNumber
      fields.party = advance.party
      if (input.kind === 'AdvanceAdjust') {
        fields.expenseName = input.expenseName
      }
      break
    }

    case 'TripAdvance': {
      const trip = await DeliveryModel.findById(input.tripId).select('tripNumber tripDate vendorId vendor vehicle driver')
      if (!trip) {
        throw new AppError(404, 'That trip no longer exists.')
      }
      fields.tripId = trip._id
      fields.trip = {
        tripNumber: trip.tripNumber,
        tripDate: trip.tripDate,
        registrationNo: trip.vehicle?.registrationNo ?? '',
        driverName: trip.driver?.name ?? '',
      }
      fields.vendorId = trip.vendorId
      fields.vendor = { vendorCode: trip.vendor.vendorCode, name: trip.vendor.name }
      fields.party = input.party
      break
    }

    case 'VendorPayment': {
      const vendor = await VendorModel.findById(input.vendorId).select('vendorCode name')
      if (!vendor) {
        throw new AppError(404, 'That vendor no longer exists.')
      }
      const period = { year: input.year, month: input.month }
      const figures = await vendorMonthFigures(vendor._id, period, existing?._id)
      const due = Math.max(0, figures.due)
      if (input.amount > due) {
        throw new AppError(
          409,
          due === 0
            ? `Nothing is due to ${vendor.name} for ${periodLabel(period)}. Enter the trip bills first, or record an advance against a trip.`
            : `${taka(due)} is due to ${vendor.name} for ${periodLabel(period)}, so ${taka(input.amount)} cannot be paid.`,
        )
      }
      fields.vendorId = vendor._id
      fields.vendor = { vendorCode: vendor.vendorCode, name: vendor.name }
      fields.period = period
      fields.party = input.party
      break
    }
  }

  return fields as Partial<Entry>
}

/** Whatever an entry settles, refreshed after it is written, moved or removed. */
async function refreshLinks(...entries: (Pick<EntryDocument, 'advanceId' | 'finalBillId'> | null)[]): Promise<void> {
  const advances = new Set<string>()
  const bills = new Set<string>()
  for (const entry of entries) {
    if (entry?.advanceId) advances.add(String(entry.advanceId))
    if (entry?.finalBillId) bills.add(String(entry.finalBillId))
  }
  await Promise.all([
    ...[...advances].map((id) => refreshAdvanceSettlement(id)),
    ...[...bills].map((id) => refreshFinalBillReceipts(id)),
  ])
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * An entry flattened to the values a journal row would quote.
 *
 * Built off the serialized record rather than the document, so a wallet, a
 * vendor and a trip arrive as the names somebody would have read on screen
 * rather than as ids — the rule `activity.diff.ts` is built around. A cash
 * book correction recorded as `walletId 66f1… → 66f2…` answers nothing.
 */
function entrySnapshot(record: EntryRecord) {
  return {
    date: record.date,
    amount: record.amount,
    wallet: record.wallet?.name ?? null,
    toWallet: record.toWallet?.name ?? null,
    party: record.party,
    reference: record.reference,
    note: record.note,
    expenseName: record.expenseName,
    purpose: record.purpose,
    vendor: record.vendor?.name ?? null,
    trip: record.trip?.tripNumber ?? null,
    period: record.period?.label ?? null,
    source: record.source,
    finalBill: record.finalBill?.label ?? null,
    labourBill: record.labourBill?.label ?? null,
    advance: record.advance?.entryNumber ?? null,
  }
}

type EntrySnapshot = ReturnType<typeof entrySnapshot>

const ENTRY_FIELDS: FieldSpec<EntrySnapshot>[] = [
  { field: 'amount', label: 'Amount', format: takaValue },
  { field: 'date', label: 'Date' },
  { field: 'wallet', label: 'Wallet' },
  { field: 'toWallet', label: 'To wallet' },
  { field: 'expenseName', label: 'Expense' },
  { field: 'party', label: 'Party' },
  { field: 'vendor', label: 'Vendor' },
  { field: 'trip', label: 'Trip' },
  { field: 'period', label: 'Month' },
  { field: 'source', label: 'Source' },
  { field: 'finalBill', label: 'Final bill' },
  { field: 'labourBill', label: 'Labour bill' },
  { field: 'advance', label: 'Advance' },
  { field: 'reference', label: 'Reference' },
  { field: 'purpose', label: 'Purpose' },
  { field: 'note', label: 'Note' },
]

/** "৳50,000 vendor payment · Malek Transport · Aug 2026" — a row's own sentence. */
function entryPhrase(record: EntryRecord): string {
  const parts = [
    `${takaValue(record.amount) ?? record.amount} ${describeKind(record.kind)}`,
    record.vendor?.name ?? record.party ?? '',
    record.expenseName,
    record.period?.label ?? '',
    record.wallet?.name ?? '',
  ].filter((part) => part.length > 0)

  return parts.join(' · ')
}

export async function createEntry(
  input: CreateEntryInput,
  actor: UserDocument,
): Promise<{ entry: EntryRecord; replayed: boolean }> {
  const replay = await EntryModel.findOne({ createdBy: actor._id, submissionKey: input.submissionKey })
  if (replay) {
    return { entry: await serializeEntry(replay), replayed: true }
  }

  // An advance is settled by cash coming back and nothing else. Adjustments
  // recorded before that stay on the books, count toward their advance, and
  // can still be corrected or deleted — but no new one is made.
  if (input.kind === 'AdvanceAdjust') {
    throw new AppError(409, 'An advance is settled only by returning cash. Record the cash returned against it instead.')
  }

  const fields = await resolveFields(input, null)
  const year = input.date.getUTCFullYear()
  const sequence = await nextSequence(entryCounterKey(input.kind, year))

  let entry: EntryDocument
  try {
    entry = await EntryModel.create({
      ...fields,
      entryNumber: formatEntryNumber(input.kind, year, sequence),
      settledAmount: 0,
      settlementStatus: input.kind === 'Advance' ? 'Open' : null,
      submissionKey: input.submissionKey,
      createdBy: actor._id,
    })
  } catch (error) {
    if (isDuplicateKey(error)) {
      const raced = await EntryModel.findOne({ createdBy: actor._id, submissionKey: input.submissionKey })
      if (raced) {
        return { entry: await serializeEntry(raced), replayed: true }
      }
    }
    throw error
  }

  await refreshLinks(entry)
  const record = await serializeEntry(entry)

  /**
   * Written only on a genuine insert. A replay — a double press, a retry after
   * a cold-start timeout — returns above without reaching here, which is the
   * same rule the idempotency claim itself follows: the journal must say a
   * vendor was paid once, because they were.
   */
  await recordActivity({
    action: 'accounts.entry-created',
    entityType: 'AccountsEntry',
    entityId: entry._id,
    entityLabel: record.entryNumber,
    summary: `${record.entryNumber} — ${entryPhrase(record)}`,
    changes: changesBetween({}, entrySnapshot(record), ENTRY_FIELDS),
    vendorId: entry.vendorId ?? null,
    actor,
  })

  return { entry: record, replayed: false }
}

/**
 * Correcting an entry rewrites it whole. The number stays, and the kind cannot
 * change — a payment that should have been an expense is deleted and entered
 * again, because the two answer different questions and share no fields.
 */
export async function updateEntry(id: string, input: UpdateEntryInput, actor: UserDocument): Promise<EntryRecord> {
  const entry = await findEntry(id)
  if (entry.kind !== input.kind) {
    throw new AppError(409, `${entry.entryNumber} is ${describeKind(entry.kind as EntryKind)}; its kind cannot change.`)
  }

  const before = { advanceId: entry.advanceId, finalBillId: entry.finalBillId }
  /**
   * What the entry said, read before it is rewritten.
   *
   * This is the row the whole module most needs. CLAUDE.md records that
   * Accounts entries are "corrected and deleted in place, not reversed" and
   * that "there is no history of what an entry said before" — which on a cash
   * book is the difference between one that reconciles and one that cannot be
   * checked at all. This is that history, and it costs one serialization on a
   * path that is already a write.
   */
  const snapshotBefore = entrySnapshot(await serializeEntry(entry))
  const fields = await resolveFields(input, entry)

  entry.set({ ...fields, updatedBy: actor._id })
  await entry.save()

  await refreshLinks(before, entry)
  if (entry.kind === 'Advance') {
    await refreshAdvanceSettlement(entry._id)
  }

  const record = await serializeEntry(await findEntry(id))
  const changes = changesBetween(snapshotBefore, entrySnapshot(record), ENTRY_FIELDS)

  await recordActivity({
    action: 'accounts.entry-updated',
    entityType: 'AccountsEntry',
    entityId: entry._id,
    entityLabel: record.entryNumber,
    summary: `${record.entryNumber} corrected — ${changeSummary(changes)}`,
    changes,
    vendorId: entry.vendorId ?? null,
    actor,
  })

  return record
}

/**
 * An entry is removed outright; the books are what the remaining entries say.
 * The one refusal is an advance with settlements recorded against it — those
 * would be returns of money nobody was ever given.
 *
 * Its voucher goes with it, and in that order: the record first, then the
 * object, so the worst outcome of a failure is an orphan in the bucket rather
 * than a file nothing points at being kept because the delete was refused.
 */
export async function deleteEntry(
  id: string,
  actor: UserDocument,
): Promise<{ id: string; entryNumber: string }> {
  const entry = await findEntry(id)

  if (entry.kind === 'Advance' && (await EntryModel.exists({ advanceId: entry._id }))) {
    throw new AppError(
      409,
      `${entry.entryNumber} has returns or adjustments recorded against it. Delete those first.`,
    )
  }

  const voucherKey = entry.voucher?.key ?? null
  /**
   * Read while the record still exists, because after this it is the only
   * account of what was deleted — and "money left the books and nothing says
   * what it was" is the worst thing a cash book can contain.
   */
  const record = await serializeEntry(entry)
  const snapshot = entrySnapshot(record)
  const phrase = entryPhrase(record)

  await entry.deleteOne()
  await refreshLinks(entry)

  if (voucherKey) {
    await deleteVoucher(voucherKey)
  }

  await recordActivity({
    action: 'accounts.entry-deleted',
    entityType: 'AccountsEntry',
    entityId: entry._id,
    entityLabel: entry.entryNumber,
    summary: `${entry.entryNumber} deleted — ${phrase}`,
    changes: changesBetween(snapshot, {}, ENTRY_FIELDS),
    vendorId: entry.vendorId ?? null,
    actor,
  })

  return { id, entryNumber: entry.entryNumber }
}

export function describeKind(kind: EntryKind): string {
  const words: Record<EntryKind, string> = {
    Deposit: 'a deposit',
    Transfer: 'a transfer',
    Expense: 'an expense',
    Advance: 'an advance',
    AdvanceReturn: 'an advance return',
    AdvanceAdjust: 'an advance adjustment',
    TripAdvance: 'a trip advance',
    VendorPayment: 'a vendor payment',
  }
  return words[kind]
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getEntry(id: string): Promise<{ entry: EntryRecord; settlements: EntryRecord[] }> {
  const entry = await findEntry(id)
  const settlements =
    entry.kind === 'Advance' ? await EntryModel.find({ advanceId: entry._id }).sort({ date: 1, createdAt: 1 }) : []
  const [record, settled] = await Promise.all([serializeEntry(entry), serializeEntries(settlements)])
  return { entry: record, settlements: settled }
}

export interface EntryListTotals {
  total: number
  moneyIn: number
  moneyOut: number
  /** Present when the list is one wallet's whole statement over a range. */
  openingBalance: number | null
  closingBalance: number | null
}

export async function listEntries(query: ListEntriesQuery): Promise<{ records: EntryRecord[]; totals: EntryListTotals }> {
  const clauses: QueryFilter<Entry>[] = []
  const walletId = query.walletId ? new Types.ObjectId(query.walletId) : null

  // An advance return belongs with money out, which it reduces — see `OUT_REDUCING_KINDS`.
  if (query.kind === 'in') {
    clauses.push(walletId ? { $or: [{ kind: { $in: [...CASH_IN_KINDS] } }, { toWalletId: walletId }] } : { kind: { $in: [...CASH_IN_KINDS] } })
  } else if (query.kind === 'out') {
    clauses.push(
      walletId
        ? { walletId, kind: { $in: [...MONEY_OUT_KINDS, ...OUT_REDUCING_KINDS, 'Transfer'] } }
        : { kind: { $in: [...MONEY_OUT_KINDS, ...OUT_REDUCING_KINDS] } },
    )
  } else if ((ENTRY_KINDS as readonly string[]).includes(query.kind)) {
    clauses.push({ kind: query.kind as EntryKind })
  }

  if (walletId) clauses.push({ $or: [{ walletId }, { toWalletId: walletId }] })
  if (query.vendorId) clauses.push({ vendorId: new Types.ObjectId(query.vendorId) })
  if (query.expenseName) clauses.push({ expenseName: new RegExp(`^${escapeRegex(query.expenseName)}$`, 'i') })
  if (query.from || query.to) {
    clauses.push({
      date: {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      },
    })
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({
      $or: [
        { entryNumber: pattern },
        { party: pattern },
        { reference: pattern },
        { note: pattern },
        { purpose: pattern },
        { expenseName: pattern },
        { 'vendor.name': pattern },
        { 'trip.tripNumber': pattern },
      ],
    })
  }

  const filter: QueryFilter<Entry> = clauses.length > 0 ? { $and: clauses } : {}

  /**
   * In and out are relative to the wallet when there is one — a transfer is
   * money out of one wallet and into another — and a transfer is neither when
   * the list spans every wallet, because it moves nothing out of the office.
   */
  const inExpr = walletId
    ? { $or: [{ $and: [{ $eq: ['$walletId', walletId] }, { $in: ['$kind', [...CASH_IN_KINDS]] }] }, { $eq: ['$toWalletId', walletId] }] }
    : { $in: ['$kind', [...CASH_IN_KINDS]] }
  const outExpr = walletId
    ? { $and: [{ $eq: ['$walletId', walletId] }, { $in: ['$kind', [...MONEY_OUT_KINDS, 'Transfer']] }] }
    : { $in: ['$kind', [...MONEY_OUT_KINDS]] }
  /** A return brought back into this wallet — or into any, across every wallet — takes its amount off money out. */
  const returnExpr = walletId
    ? { $and: [{ $eq: ['$walletId', walletId] }, { $in: ['$kind', [...OUT_REDUCING_KINDS]] }] }
    : { $in: ['$kind', [...OUT_REDUCING_KINDS]] }

  const [entries, [sums]] = await Promise.all([
    EntryModel.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    EntryModel.aggregate<{ total: number; moneyIn: number; moneyOut: number }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          moneyIn: { $sum: { $cond: [inExpr, '$amount', 0] } },
          moneyOut: { $sum: { $cond: [outExpr, '$amount', { $cond: [returnExpr, { $multiply: ['$amount', -1] }, 0] }] } },
        },
      },
    ]),
  ])

  const statement = walletId && query.kind === 'all' && !query.search && !query.vendorId && !query.expenseName
  const openingBalance = statement && query.walletId ? (query.from ? await walletBalanceBefore(query.walletId, query.from) : 0) : null
  const moneyIn = sums?.moneyIn ?? 0
  const moneyOut = sums?.moneyOut ?? 0

  return {
    records: await serializeEntries(entries),
    totals: {
      total: sums?.total ?? 0,
      moneyIn,
      moneyOut,
      openingBalance,
      closingBalance: openingBalance === null ? null : openingBalance + moneyIn - moneyOut,
    },
  }
}

export interface AdvanceListTotals {
  total: number
  totalAmount: number
  settledAmount: number
  outstanding: number
  openCount: number
}

export async function listAdvances(
  query: ListAdvancesQuery,
): Promise<{ records: EntryRecord[]; totals: AdvanceListTotals }> {
  const clauses: QueryFilter<Entry>[] = [{ kind: 'Advance' }]
  if (query.status === 'outstanding') {
    clauses.push({ settlementStatus: { $in: ['Open', 'Partial'] } })
  } else if (query.status !== 'all') {
    clauses.push({ settlementStatus: query.status })
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({ $or: [{ entryNumber: pattern }, { party: pattern }, { purpose: pattern }, { partyPhone: pattern }] })
  }
  const filter: QueryFilter<Entry> = { $and: clauses }

  const [entries, [sums]] = await Promise.all([
    EntryModel.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    EntryModel.aggregate<AdvanceListTotals>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          settledAmount: { $sum: '$settledAmount' },
          outstanding: { $sum: { $max: [0, { $subtract: ['$amount', '$settledAmount'] }] } },
          openCount: { $sum: { $cond: [{ $in: ['$settlementStatus', ['Open', 'Partial']] }, 1, 0] } },
        },
      },
    ]),
  ])

  return {
    records: await serializeEntries(entries),
    totals: sums ?? { total: 0, totalAmount: 0, settledAmount: 0, outstanding: 0, openCount: 0 },
  }
}

/**
 * Expense names already used, most used first, for the type-ahead on the
 * expense form. A suggestion is what stops one cost being recorded as
 * "Office rent", "office rent" and "Rent" — three names no report adds up.
 * Grouped ignoring case; a prefix of what was typed when anything was.
 */
export async function listExpenseNames(q: string): Promise<string[]> {
  const rows = await EntryModel.aggregate<{ name: string }>([
    {
      $match: {
        kind: { $in: ['Expense', 'AdvanceAdjust'] },
        // A real string only: an entry written before names were typed has none,
        // and a null in this list is a suggestion nobody can render.
        expenseName: q ? new RegExp(`^${escapeRegex(q)}`, 'i') : { $type: 'string', $ne: '' },
      },
    },
    // Oldest first, so a name is offered in the spelling it was first recorded in.
    { $sort: { createdAt: 1 } },
    { $group: { _id: { $toLower: '$expenseName' }, name: { $first: '$expenseName' }, uses: { $sum: 1 } } },
    { $sort: { uses: -1, _id: 1 } },
    { $limit: 50 },
    { $project: { _id: 0, name: 1 } },
  ])
  return rows.map((row) => row.name).filter((name): name is string => typeof name === 'string' && name.trim() !== '')
}
