import type { QueryFilter, Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { refreshBillingStatus } from '../bill/bill.status'
import { canViewRecord } from '../gate-pass/gate-pass.access'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import { GatePassModel } from '../gate-pass/gate-pass.model'
import type { GatePass, GatePassDocument } from '../gate-pass/gate-pass.model'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import {
  LINKABLE_GATE_PASS_STATUSES,
  MAX_GATE_PASS_OPTIONS,
  MAX_TRIP_DO_EXPORT_ROWS,
  countsTowardGatePassQty,
  gatePassLineDeliveredQty,
  gatePassProductStatusFor,
} from './trip-do.constants'
import type { LinkedRowState, RowDeliveryStatus } from './trip-do.constants'
import {
  LINKED_LINE_KEY,
  allocatedByModel,
  linkCopyFor,
  rowLineKey,
} from './trip-do.links'
import { customerMatch, productLineMatch } from './trip-do.matching'
import type { MatchResult } from './trip-do.matching'
import { MAX_COLUMN_VALUES, columnFilterClause, columnValuesStages } from './trip-do.columns'
import type { ColumnValue, TripDoColumnId } from './trip-do.columns'
import { TripDoLineModel } from './trip-do.model'
import type { TripDoLine, TripDoLineDocument } from './trip-do.model'
import { toLinkedRow, toTripDoRow } from './trip-do.serializer'
import type {
  GatePassOption,
  GatePassProductLine,
  GatePassTripDoStatus,
  TripDoRowRecord,
} from './trip-do.serializer'
import type {
  BulkLinkInput,
  ColumnValuesQuery,
  LinkRowInput,
  ListTripDoQuery,
  SplitRowInput,
  TripDoFilterQuery,
} from './trip-do.validation'

/**
 * Everything the Trip DO module does to the database.
 *
 * Reading is the sheet, filtered and totalled server-side like every list here.
 * Writing is two operations and their undo: **dividing** a row's quantity
 * (split, merge) and **linking** a row to a gate pass line (link, unlink). The
 * rest of a row is a copy the sync owns, and nothing here writes it.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function startOfUtcDay(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
}

function endOfUtcDay(value: string): Date {
  return new Date(startOfUtcDay(value).getTime() + 86_400_000 - 1)
}

/** Newest challan first; within one, its lines in printed order. */
const SHEET_ORDER = { challanDate: -1, slNumber: -1, position: 1, rowSeq: 1, splitIndex: 1 } as const

async function findRow(id: string): Promise<TripDoLineDocument> {
  const row = await TripDoLineModel.findById(id)
  if (!row) {
    throw new AppError(404, 'That row is no longer on the sheet. Refresh and try again.')
  }
  return row
}

/**
 * A row on a bill is fixed on the sheet. Its quantity and its Trip DO are what
 * the bill charged for, so splitting, merging or relinking it would make the
 * bill describe a row that no longer exists. Taking it off the bill is the way
 * to change it.
 */
function refuseBilled(row: TripDoLineDocument, action: string): void {
  if (row.bill) {
    throw new AppError(
      409,
      `This row is on bill ${row.bill.billNumber}, so it cannot be ${action}. Take it off the bill first.`,
    )
  }
}

async function resolveNames(ids: (Types.ObjectId | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  if (unique.length === 0) {
    return new Map()
  }
  const users = await UserModel.find({ _id: { $in: unique } }).select('name')
  return new Map(users.map((user) => [String(user._id), user.name]))
}

/** How many rows each source is divided into, for one page of rows. */
async function partCountsFor(rows: TripDoLineDocument[]): Promise<Map<string, number>> {
  const keys = [...new Set(rows.map((row) => row.sourceKey))]
  if (keys.length === 0) {
    return new Map()
  }
  const counts = await TripDoLineModel.aggregate<{ _id: string; count: number }>([
    { $match: { sourceKey: { $in: keys } } },
    { $group: { _id: '$sourceKey', count: { $sum: 1 } } },
  ])
  return new Map(counts.map((entry) => [entry._id, entry.count]))
}

async function serializeRows(rows: TripDoLineDocument[]): Promise<TripDoRowRecord[]> {
  const [counts, names] = await Promise.all([
    partCountsFor(rows),
    resolveNames(rows.map((row) => row.link?.linkedBy)),
  ])
  return rows.map((row) => toTripDoRow(row, counts.get(row.sourceKey) ?? 1, names))
}

// ---------------------------------------------------------------------------
// Reading the sheet
// ---------------------------------------------------------------------------

function buildFilter(query: TripDoFilterQuery): QueryFilter<TripDoLine> {
  const clauses: QueryFilter<TripDoLine>[] = []

  if (query.kind !== 'all') {
    clauses.push({ kind: query.kind })
  }
  if (query.link === 'linked') {
    clauses.push({ link: { $ne: null } })
  } else if (query.link === 'unlinked') {
    clauses.push({ link: null })
  }
  if (query.from || query.to) {
    const range: { $gte?: Date; $lte?: Date } = {}
    if (query.from) range.$gte = startOfUtcDay(query.from)
    if (query.to) range.$lte = endOfUtcDay(query.to)
    clauses.push({ challanDate: range })
  }

  // The column dropdowns: every ticked value of every filtered column.
  for (const column of Object.keys(query.columns) as TripDoColumnId[]) {
    const clause = columnFilterClause(column, query.columns[column] ?? [])
    if (clause) {
      clauses.push(clause as QueryFilter<TripDoLine>)
    }
  }

  if (query.search) {
    /**
     * Whatever is in front of the operator: a challan number off a back page,
     * an SL read out over the phone, a Trip DO off a gate pass, a trip number,
     * a customer, a receiver's number, or the model on the box.
     */
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    const or: QueryFilter<TripDoLine>[] = [
      { challanNumber: pattern },
      { customerName: pattern },
      { deliveryAddress: pattern },
      { receiverMobile: pattern },
      { productName: pattern },
      { productModel: pattern },
      { tripNumbers: pattern },
      { 'link.tripDo': pattern },
      { 'link.gatePassNumber': pattern },
    ]
    const asNumber = Number.parseInt(query.search, 10)
    if (Number.isInteger(asNumber) && String(asNumber) === query.search) {
      or.push({ slNumber: asNumber })
    }
    clauses.push({ $or: or })
  }

  return clauses.length > 0 ? { $and: clauses } : {}
}

export interface TripDoTotals {
  total: number
  totalQty: number
  totalAmount: number
  linkedRows: number
  unlinkedRows: number
  linkedQty: number
  unlinkedQty: number
  returnRows: number
  resentRows: number
}

const EMPTY_TOTALS: TripDoTotals = {
  total: 0,
  totalQty: 0,
  totalAmount: 0,
  linkedRows: 0,
  unlinkedRows: 0,
  linkedQty: 0,
  unlinkedQty: 0,
  returnRows: 0,
  resentRows: 0,
}

/**
 * Every figure the toolbar shows, over every matching row rather than the page
 * — "a total answers the filters, not the page". One grouped pass.
 */
async function totalsFor(filter: QueryFilter<TripDoLine>): Promise<TripDoTotals> {
  const isLinked = { $ne: [{ $ifNull: ['$link', null] }, null] }

  const [row] = await TripDoLineModel.aggregate<TripDoTotals>([
    { $match: filter },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        totalQty: { $sum: '$qty' },
        // Order rows only: a return or re-send shows its pieces' share of the
        // line, which the order row already counts.
        totalAmount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$kind', 'Order'] },
                  { $isNumber: '$lineAmount' },
                  { $gt: ['$lineQty', 0] },
                ],
              },
              { $divide: [{ $multiply: ['$lineAmount', '$qty'] }, '$lineQty'] },
              0,
            ],
          },
        },
        linkedRows: { $sum: { $cond: [isLinked, 1, 0] } },
        unlinkedRows: { $sum: { $cond: [isLinked, 0, 1] } },
        linkedQty: { $sum: { $cond: [isLinked, '$qty', 0] } },
        unlinkedQty: { $sum: { $cond: [isLinked, 0, '$qty'] } },
        returnRows: { $sum: { $cond: [{ $eq: ['$kind', 'Return'] }, 1, 0] } },
        resentRows: { $sum: { $cond: [{ $eq: ['$kind', 'Resent'] }, 1, 0] } },
      },
    },
  ])

  if (!row) {
    return EMPTY_TOTALS
  }

  return {
    total: row.total,
    totalQty: row.totalQty,
    totalAmount: Math.round(row.totalAmount * 100) / 100,
    linkedRows: row.linkedRows,
    unlinkedRows: row.unlinkedRows,
    linkedQty: row.linkedQty,
    unlinkedQty: row.unlinkedQty,
    returnRows: row.returnRows,
    resentRows: row.resentRows,
  }
}

export async function listTripDoRows(
  query: ListTripDoQuery,
): Promise<{ records: TripDoRowRecord[]; totals: TripDoTotals }> {
  const filter = buildFilter(query)

  const [rows, totals] = await Promise.all([
    TripDoLineModel.find(filter)
      .sort(SHEET_ORDER)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    totalsFor(filter),
  ])

  return { records: await serializeRows(rows), totals }
}

/**
 * Every matching row, for the spreadsheet. Refused above the cap with the
 * count rather than truncated — nothing in a spreadsheet says its bottom is
 * missing.
 */
export async function exportTripDoRows(query: TripDoFilterQuery): Promise<TripDoRowRecord[]> {
  const filter = buildFilter(query)
  const count = await TripDoLineModel.countDocuments(filter)

  if (count > MAX_TRIP_DO_EXPORT_ROWS) {
    throw new AppError(
      422,
      `These filters match ${count} rows, more than the ${MAX_TRIP_DO_EXPORT_ROWS} one export can carry. Narrow the dates and try again.`,
    )
  }

  const rows = await TripDoLineModel.find(filter).sort(SHEET_ORDER)
  return serializeRows(rows)
}

// ---------------------------------------------------------------------------
// Choosing a Trip DO
// ---------------------------------------------------------------------------

export interface ColumnValuesResult {
  values: { value: ColumnValue; count: number }[]
  /** More distinct values exist than one dropdown lists. */
  truncated: boolean
}

/**
 * The distinct values in one column, with how many rows hold each, under every
 * filter in use except that column's own — so the dropdown still offers what
 * was unticked, the way a spreadsheet's does.
 */
export async function listColumnValues(query: ColumnValuesQuery): Promise<ColumnValuesResult> {
  const { column, ...rest } = query
  const columns = { ...rest.columns }
  delete columns[column]

  const rows = await TripDoLineModel.aggregate<{ _id: ColumnValue; count: number }>([
    { $match: buildFilter({ ...rest, columns }) },
    ...columnValuesStages(column),
  ])

  return {
    values: rows.slice(0, MAX_COLUMN_VALUES).map((row) => ({ value: row._id, count: row.count })),
    truncated: rows.length > MAX_COLUMN_VALUES,
  }
}

async function findLinkableGatePass(id: string): Promise<GatePassDocument> {
  const gatePass = await GatePassModel.findById(id)

  if (!gatePass) {
    throw new AppError(404, 'That gate pass no longer exists.')
  }
  if (!(LINKABLE_GATE_PASS_STATUSES as readonly string[]).includes(gatePass.status)) {
    throw new AppError(
      409,
      `${gatePass.gatePassId} is ${gatePass.status}. Only a submitted or verified gate pass can be set as a Trip DO.`,
    )
  }
  return gatePass
}

/** One product line on a gate pass; two lines of one model add up. */
interface GatePassLine {
  modelKey: string
  productName: string
  model: string
  qty: number
}

function linesOf(gatePass: Pick<GatePassDocument, 'items'>): GatePassLine[] {
  const lines = new Map<string, GatePassLine>()
  for (const item of gatePass.items) {
    const existing = lines.get(item.productModelKey)
    if (existing) {
      existing.qty += item.qty
    } else {
      lines.set(item.productModelKey, {
        modelKey: item.productModelKey,
        productName: item.productName,
        model: item.productModel,
        qty: item.qty,
      })
    }
  }
  return [...lines.values()]
}

/**
 * Which line on a gate pass a row links to.
 *
 * The line the picker offered when it says; otherwise the line with the row's
 * own model, or the one close line when there is exactly one. Two close lines
 * is a question rather than a guess — `TWG80-Q60` against a gate pass carrying
 * two washing machines is not something arithmetic should decide.
 */
function resolveLine(
  gatePass: GatePassDocument,
  row: TripDoLineDocument,
  lineKey: string | undefined,
): GatePassLine {
  const lines = linesOf(gatePass)
  const label = `${gatePass.gatePassId} (Trip DO ${gatePass.tripDo})`
  const product = row.productModel || row.productName

  if (lineKey) {
    const line = lines.find((candidate) => candidate.modelKey === lineKey)
    if (!line) {
      throw new AppError(409, `${label} no longer carries that product. Refresh and choose again.`)
    }
    return line
  }

  const exact = lines.find((line) => line.modelKey && line.modelKey === row.productModelKey)
  if (exact) {
    return exact
  }

  const rowProduct = { productName: row.productName, model: row.productModel }
  const close = lines.filter((line) => productLineMatch(rowProduct, line).level !== 'different')
  if (close.length === 1) {
    return close[0]
  }

  throw new AppError(
    409,
    close.length === 0
      ? `${label} does not carry ${product} or anything close to it.`
      : `${label} carries more than one product close to ${product}. Choose the line in the Trip DO picker.`,
  )
}

/** How many recent filed gate passes are read to find close matches with nothing typed. */
const RECENT_GATE_PASS_SCAN = 150

const GATE_PASS_OPTION_FIELDS = 'gatePassId tripDo tripDate csd unit customerName vehicleNo status items'

function rankOf(match: MatchResult): number {
  return match.level === 'exact' ? 1 : match.score
}

/**
 * The gate pass lines one row could be linked to.
 *
 * **The two papers never have to agree to the letter.** A gate pass and a
 * challan are typed by different people, so a line is offered when its model
 * is the row's own *or close to it*, and with nothing typed a line is also
 * offered when the customer is close and the product is the same kind. Each
 * offer says how well the model and the customer match, so a close one is read
 * before it is pressed. Typed, a Trip DO, gate pass number or plate finds the
 * gate pass whatever its lines say — somebody holding the gate pass knows.
 *
 * For a return or re-sent row, the Trip DO its order row already has is offered
 * first, and it is never shown as full: those pieces do not use a line up.
 */
export async function listGatePassOptions(rowId: string, q: string): Promise<GatePassOption[]> {
  const row = await findRow(rowId)
  const countsTowardQty = countsTowardGatePassQty(row.kind)
  const filed: QueryFilter<GatePass> = { status: { $in: [...LINKABLE_GATE_PASS_STATUSES] } }

  const orderLinks = countsTowardQty
    ? []
    : await TripDoLineModel.find({
        challanId: row.challanId,
        kind: 'Order',
        productModelKey: row.productModelKey,
        link: { $ne: null },
      }).select('link productModelKey')
  const orderLineKeys = new Set(
    orderLinks.map((order) => `${String(order.link?.gatePassId)}|${rowLineKey(order)}`),
  )
  const pinnedIds = [
    ...orderLinks.map((order) => order.link?.gatePassId),
    row.link?.gatePassId,
  ].filter((id): id is Types.ObjectId => Boolean(id))

  const newestFirst = { tripDate: -1, createdAt: -1 } as const
  const found: GatePassDocument[][] = []

  if (q) {
    const key = comparisonKey(q)
    const or: QueryFilter<GatePass>[] = [
      { gatePassId: new RegExp(escapeRegex(q), 'i') },
      { vehicleNo: new RegExp(escapeRegex(q), 'i') },
    ]
    if (key) {
      or.push({ tripDoKey: new RegExp(`^${escapeRegex(key)}`) })
    }
    found.push(
      await GatePassModel.find({ $and: [filed, { $or: or }] })
        .select(GATE_PASS_OPTION_FIELDS)
        .sort(newestFirst)
        .limit(MAX_GATE_PASS_OPTIONS * 2),
    )
  } else {
    found.push(
      ...(await Promise.all([
        pinnedIds.length > 0
          ? GatePassModel.find({ $and: [filed, { _id: { $in: pinnedIds } }] }).select(GATE_PASS_OPTION_FIELDS)
          : Promise.resolve([]),
        row.productModelKey
          ? GatePassModel.find({ $and: [filed, { 'items.productModelKey': row.productModelKey }] })
              .select(GATE_PASS_OPTION_FIELDS)
              .sort(newestFirst)
              .limit(40)
          : Promise.resolve([]),
        GatePassModel.find(filed).select(GATE_PASS_OPTION_FIELDS).sort(newestFirst).limit(RECENT_GATE_PASS_SCAN),
      ])),
    )
  }

  const gatePasses = new Map<string, GatePassDocument>()
  for (const gatePass of found.flat()) {
    gatePasses.set(String(gatePass._id), gatePasses.get(String(gatePass._id)) ?? gatePass)
  }
  if (gatePasses.size === 0) {
    return []
  }

  const allocations = await TripDoLineModel.aggregate<{
    _id: { gatePassId: Types.ObjectId; lineKey: string }
    qty: number
  }>([
    {
      $match: {
        'link.gatePassId': { $in: [...gatePasses.values()].map((gatePass) => gatePass._id) },
        kind: 'Order',
        _id: { $ne: row._id },
      },
    },
    { $group: { _id: { gatePassId: '$link.gatePassId', lineKey: LINKED_LINE_KEY }, qty: { $sum: '$qty' } } },
  ])
  const allocated = new Map(
    allocations.map((entry) => [`${String(entry._id.gatePassId)}|${entry._id.lineKey}`, entry.qty]),
  )

  const rowProduct = { productName: row.productName, model: row.productModel }
  const currentKey = row.link ? `${String(row.link.gatePassId)}|${rowLineKey(row)}` : null
  const typedKey = comparisonKey(q)
  const ranked: { option: GatePassOption; rank: number }[] = []

  for (const gatePass of gatePasses.values()) {
    const id = String(gatePass._id)
    const customer = customerMatch(row.customerName, gatePass.customerName)
    const lines = linesOf(gatePass).map((line) => ({ line, match: productLineMatch(rowProduct, line) }))
    const anyClose = lines.some(({ match }) => match.level !== 'different')

    for (const { line, match } of lines) {
      const optionKey = `${id}|${line.modelKey}`
      const isCurrent = optionKey === currentKey
      const isOrderTripDo = orderLineKeys.has(optionKey)
      const sameCustomer = customer.level !== 'different'
      const sameKindOfProduct =
        customerMatch(row.productName, line.productName).level !== 'different'

      const offered =
        isCurrent ||
        isOrderTripDo ||
        match.level !== 'different' ||
        (q ? !anyClose : sameCustomer && sameKindOfProduct)
      if (!offered) {
        continue
      }

      const taken = allocated.get(optionKey) ?? 0
      ranked.push({
        rank: rankOf(match) * 2 + rankOf(customer),
        option: {
          id,
          lineKey: line.modelKey,
          optionKey,
          gatePassNumber: gatePass.gatePassId,
          tripDo: gatePass.tripDo,
          tripDate: gatePass.tripDate.toISOString().slice(0, 10),
          csd: gatePass.csd,
          unit: gatePass.unit,
          customerName: gatePass.customerName,
          vehicleNo: gatePass.vehicleNo,
          status: gatePass.status,
          productName: line.productName,
          model: line.model,
          qty: line.qty,
          allocatedQty: taken,
          remainingQty: countsTowardQty ? Math.max(0, line.qty - taken) : line.qty,
          countsTowardQty,
          modelMatch: match.level,
          customerMatch: customer.level,
          isCurrent,
          isOrderTripDo,
        },
      })
    }
  }

  return ranked
    .filter(({ option }) => q || option.remainingQty > 0 || option.isCurrent || option.isOrderTripDo)
    .sort((a, b) => {
      // An exact Trip DO first, then the one already linked, then the order
      // row's own, then what has room, then the closest match. Otherwise newest
      // first, which is the order the gate passes were read in.
      const exact =
        Number(comparisonKey(b.option.tripDo) === typedKey) -
        Number(comparisonKey(a.option.tripDo) === typedKey)
      if (typedKey && exact !== 0) return exact
      if (a.option.isCurrent !== b.option.isCurrent) return a.option.isCurrent ? -1 : 1
      if (a.option.isOrderTripDo !== b.option.isOrderTripDo) return a.option.isOrderTripDo ? -1 : 1
      const room = Number(b.option.remainingQty > 0) - Number(a.option.remainingQty > 0)
      if (room !== 0) return room
      return b.rank - a.rank
    })
    .slice(0, MAX_GATE_PASS_OPTIONS)
    .map(({ option }) => option)
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

async function nextSplitIndex(sourceKey: string): Promise<number> {
  const last = await TripDoLineModel.findOne({ sourceKey }).sort({ splitIndex: -1 }).select('splitIndex')
  return (last?.splitIndex ?? 0) + 1
}

/** A new part of the same source: every copied field, its own quantity and link. */
function partOf(
  row: TripDoLineDocument,
  qty: number,
  splitIndex: number,
  link: TripDoLineDocument['link'] | null,
) {
  return {
    challanId: row.challanId,
    sourceKey: row.sourceKey,
    splitIndex,
    kind: row.kind,
    position: row.position,
    rowSeq: row.rowSeq,
    tripId: row.tripId,
    challanNumber: row.challanNumber,
    slNumber: row.slNumber,
    challanDate: row.challanDate,
    customerName: row.customerName,
    deliveryAddress: row.deliveryAddress,
    district: row.district,
    thana: row.thana,
    locationType: row.locationType,
    receiverMobile: row.receiverMobile,
    zonePo: row.zonePo,
    productName: row.productName,
    productModel: row.productModel,
    productModelKey: row.productModelKey,
    capacity: row.capacity,
    rate: row.rate,
    lineQty: row.lineQty,
    lineAmount: row.lineAmount,
    firstDeliveredQty: row.firstDeliveredQty ?? null,
    tripNumbers: [...row.tripNumbers],
    deliveryStatus: row.deliveryStatus,
    qty,
    link: link ?? null,
    tripDoKey: link ? comparisonKey(link.tripDo) : '',
    copyHash: row.copyHash,
  }
}

export interface TripDoLinkResult {
  gatePassNumber: string
  tripDo: string
  csd: string
  unit: string
  /** Pieces linked. */
  qty: number
  /** Pieces left on a row of their own because the link took less than the row. */
  remainderQty: number
  rows: number
}

function refuseOverAllocation(
  gatePass: GatePassDocument,
  model: string,
  capacity: number,
  allocated: number,
): never {
  const remaining = Math.max(0, capacity - allocated)
  throw new AppError(
    409,
    remaining === 0
      ? `Every ${model} on ${gatePass.gatePassId} (Trip DO ${gatePass.tripDo}) is already linked — ${allocated} of ${capacity}.`
      : `${gatePass.gatePassId} (Trip DO ${gatePass.tripDo}) has only ${remaining} ${model} left to link, of ${capacity}. Link ${remaining} and leave the rest for another Trip DO.`,
  )
}

/** A return or re-send may sit on a line that carries at least that many. */
function refuseOversizedReturn(
  gatePass: GatePassDocument,
  row: TripDoLineDocument,
  line: GatePassLine,
  qty: number,
): never {
  throw new AppError(
    409,
    `${gatePass.gatePassId} (Trip DO ${gatePass.tripDo}) carries ${line.qty} ${line.model}, so a ` +
      `${row.kind === 'Return' ? 'return' : 're-send'} of ${qty} cannot sit on it.`,
  )
}

/**
 * Sets a Trip DO on one row, splitting it when the link takes less than the row.
 *
 * The gate pass has to be filed and has to carry the row's product — the same
 * model, or one close to it (`resolveLine`). An order row also needs that many
 * pieces not already linked elsewhere — five on the gate pass can be three on
 * one challan and two on another, never three and three. A return or re-sent
 * row does not use the line up, so it may take the Trip DO its order row
 * already filled. The rest of
 * a split row keeps whatever Trip DO the row had before, so moving part of a
 * row from one gate pass to another never silently unlinks the part left
 * behind.
 */
export async function linkRow(
  rowId: string,
  input: LinkRowInput,
  actor: UserDocument,
): Promise<TripDoLinkResult> {
  const row = await findRow(rowId)
  refuseBilled(row, 'given another Trip DO')
  const gatePass = await findLinkableGatePass(input.gatePassId)
  const qty = input.qty ?? row.qty

  if (qty > row.qty) {
    throw new AppError(400, `This row carries ${row.qty}, so it cannot link ${qty}.`)
  }

  const line = resolveLine(gatePass, row, input.lineKey)

  if (countsTowardGatePassQty(row.kind)) {
    const allocated = (await allocatedByModel(gatePass._id, [row._id])).get(line.modelKey) ?? 0
    if (allocated + qty > line.qty) {
      refuseOverAllocation(gatePass, line.model, line.qty, allocated)
    }
  } else if (qty > line.qty) {
    refuseOversizedReturn(gatePass, row, line, qty)
  }

  const previous = row.link ?? null
  const remainderQty = row.qty - qty
  const link = linkCopyFor(gatePass, line, actor)

  if (remainderQty > 0) {
    await TripDoLineModel.create(
      partOf(row, remainderQty, await nextSplitIndex(row.sourceKey), previous),
    )
  }

  row.qty = qty
  row.set('link', link)
  row.tripDoKey = comparisonKey(gatePass.tripDo)
  await row.save()
  // A new unbilled row on a billed gate pass makes it partly billed again.
  await refreshBillingStatus({ gatePassIds: [gatePass._id, previous?.gatePassId] })

  return {
    gatePassNumber: gatePass.gatePassId,
    tripDo: gatePass.tripDo,
    csd: gatePass.csd,
    unit: gatePass.unit,
    qty,
    remainderQty,
    rows: 1,
  }
}

/**
 * Sets one Trip DO on many rows at once — a gate pass of five refrigerators
 * spread over three challans, chosen by ticking the three rows.
 *
 * All or nothing. Every row is linked whole, every row's product has to be on
 * the gate pass (or close to a line on it), and the order pieces added up have
 * to fit; a partial bulk link would leave the operator working out which of
 * twelve ticked rows actually changed. Returns and re-sends ride along without
 * using the line up, as they do one at a time.
 */
export async function bulkLinkRows(
  input: BulkLinkInput,
  actor: UserDocument,
): Promise<TripDoLinkResult> {
  const rows = await TripDoLineModel.find({ _id: { $in: input.rowIds } })
  if (rows.length !== input.rowIds.length) {
    throw new AppError(404, 'Some of those rows are no longer on the sheet. Refresh and try again.')
  }
  for (const row of rows) {
    refuseBilled(row, 'given another Trip DO')
  }

  const gatePass = await findLinkableGatePass(input.gatePassId)
  const allocated = await allocatedByModel(
    gatePass._id,
    rows.map((row) => row._id),
  )

  const lineFor = new Map<string, GatePassLine>()
  const wanted = new Map<string, { qty: number; line: GatePassLine }>()
  for (const row of rows) {
    const line = resolveLine(gatePass, row, input.lineKey)
    lineFor.set(String(row._id), line)

    if (!countsTowardGatePassQty(row.kind)) {
      if (row.qty > line.qty) {
        refuseOversizedReturn(gatePass, row, line, row.qty)
      }
      continue
    }
    const entry = wanted.get(line.modelKey) ?? { qty: 0, line }
    entry.qty += row.qty
    wanted.set(line.modelKey, entry)
  }

  for (const [key, entry] of wanted) {
    const taken = allocated.get(key) ?? 0
    if (taken + entry.qty > entry.line.qty) {
      refuseOverAllocation(gatePass, entry.line.model, entry.line.qty, taken)
    }
  }

  await TripDoLineModel.bulkWrite(
    rows.map((row) => {
      const line = lineFor.get(String(row._id)) as GatePassLine
      return {
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: { link: linkCopyFor(gatePass, line, actor), tripDoKey: comparisonKey(gatePass.tripDo) },
          },
        },
      }
    }),
  )
  await refreshBillingStatus({
    gatePassIds: [gatePass._id, ...rows.map((row) => row.link?.gatePassId)],
  })

  return {
    gatePassNumber: gatePass.gatePassId,
    tripDo: gatePass.tripDo,
    csd: gatePass.csd,
    unit: gatePass.unit,
    qty: rows.reduce((sum, row) => sum + row.qty, 0),
    remainderQty: 0,
    rows: rows.length,
  }
}

/**
 * Takes the Trip DO off a row, and folds it back into any other unlinked part
 * of the same line — a piece without a Trip DO is a piece without a Trip DO,
 * and two rows saying so is noise on a sheet somebody reads by eye.
 */
export async function unlinkRow(rowId: string): Promise<{ qty: number }> {
  const row = await findRow(rowId)
  if (!row.link) {
    return { qty: row.qty }
  }
  refuseBilled(row, 'left without a Trip DO')
  const gatePassId = row.link.gatePassId

  const siblings = await TripDoLineModel.find({
    sourceKey: row.sourceKey,
    link: null,
    _id: { $ne: row._id },
  })

  row.set('link', null)
  row.tripDoKey = ''
  row.qty += siblings.reduce((sum, sibling) => sum + sibling.qty, 0)
  row.splitIndex = Math.min(row.splitIndex, ...siblings.map((sibling) => sibling.splitIndex))
  await row.save()

  if (siblings.length > 0) {
    await TripDoLineModel.deleteMany({ _id: { $in: siblings.map((sibling) => sibling._id) } })
  }
  await refreshBillingStatus({ gatePassIds: [gatePassId] })

  return { qty: row.qty }
}

// ---------------------------------------------------------------------------
// Dividing
// ---------------------------------------------------------------------------

/**
 * Divides one row into parts. Every part keeps the row's Trip DO, so a split
 * never changes what is linked to a gate pass — it only makes a part that can
 * then be linked somewhere else.
 */
export async function splitRow(rowId: string, input: SplitRowInput): Promise<{ parts: number }> {
  const row = await findRow(rowId)
  refuseBilled(row, 'split')
  const sum = input.parts.reduce((total, part) => total + part, 0)

  if (sum !== row.qty) {
    throw new AppError(
      400,
      `The parts add up to ${sum}, and this row carries ${row.qty}. They have to match.`,
    )
  }

  const start = await nextSplitIndex(row.sourceKey)
  const link = row.link ?? null

  await TripDoLineModel.insertMany(
    input.parts.slice(1).map((part, index) => partOf(row, part, start + index, link)),
  )

  row.qty = input.parts[0]
  await row.save()

  return { parts: input.parts.length }
}

/**
 * Undoes a split: every part of the same line with the same Trip DO — or with
 * none — folds back into this row. Parts linked elsewhere are left alone, since
 * merging them would change what a gate pass has linked to it.
 */
export async function mergeRow(rowId: string): Promise<{ merged: number; qty: number }> {
  const row = await findRow(rowId)
  refuseBilled(row, 'merged')

  const siblings = await TripDoLineModel.find({
    sourceKey: row.sourceKey,
    _id: { $ne: row._id },
    // A billed part stays where the bill put it.
    bill: null,
    ...(row.link ? { 'link.gatePassId': row.link.gatePassId } : { link: null }),
  })

  if (siblings.length === 0) {
    return { merged: 0, qty: row.qty }
  }

  row.qty += siblings.reduce((sum, sibling) => sum + sibling.qty, 0)
  row.splitIndex = Math.min(row.splitIndex, ...siblings.map((sibling) => sibling.splitIndex))
  await row.save()
  await TripDoLineModel.deleteMany({ _id: { $in: siblings.map((sibling) => sibling._id) } })

  return { merged: siblings.length, qty: row.qty }
}

// ---------------------------------------------------------------------------
// The gate pass side
// ---------------------------------------------------------------------------

/**
 * What the challans linked to one gate pass say about it, product line by
 * product line — how much of each line is linked, to which challans, and where
 * those goods are now.
 */
export async function getGatePassTripDoStatus(
  gatePassId: string,
  viewer: UserDocument,
): Promise<GatePassTripDoStatus> {
  const gatePass = await GatePassModel.findById(gatePassId)

  if (!gatePass || !canViewRecord(gatePass, viewer)) {
    throw new AppError(404, 'Gate pass not found.')
  }

  const rows = await TripDoLineModel.find({ 'link.gatePassId': gatePass._id }).sort(SHEET_ORDER)
  const lines = new Map<string, GatePassProductLine>()
  const statesByLine = new Map<string, LinkedRowState[]>()
  const stateOf = (row: TripDoLineDocument): LinkedRowState => ({
    kind: row.kind,
    deliveryStatus: row.deliveryStatus as RowDeliveryStatus,
    qty: row.qty,
    lineQty: row.lineQty,
    firstDeliveredQty: row.firstDeliveredQty ?? null,
  })

  for (const item of gatePass.items) {
    const existing = lines.get(item.productModelKey)
    if (existing) {
      existing.qty += item.qty
      continue
    }
    lines.set(item.productModelKey, {
      productName: item.productName,
      model: item.productModel,
      qty: 0 + item.qty,
      linkedQty: 0,
      deliveredQty: 0,
      remainingQty: 0,
      status: 'Unlinked',
      rows: [],
    })
  }

  for (const row of rows) {
    // A row is filed under the line it was linked to, which may be spelled
    // differently from its own model. A row whose line the gate pass no longer
    // names is still shown rather than hidden: the edit guard should have
    // prevented it, and hiding it would be the one way nobody ever finds out.
    const key = rowLineKey(row)
    const line = lines.get(key) ?? {
      productName: row.productName,
      model: row.link?.model || row.productModel,
      qty: 0,
      linkedQty: 0,
      deliveredQty: 0,
      remainingQty: 0,
      status: 'Unlinked' as const,
      rows: [],
    }
    // Returns and re-sends are listed, and are pieces an order row already counts.
    if (countsTowardGatePassQty(row.kind)) {
      line.linkedQty += row.qty
    }
    line.rows.push(toLinkedRow(row))
    lines.set(key, line)
    statesByLine.set(key, [...(statesByLine.get(key) ?? []), stateOf(row)])
  }

  const result = [...lines.entries()].map(([key, line]) => {
    const states = statesByLine.get(key) ?? []
    return {
      ...line,
      deliveredQty: gatePassLineDeliveredQty(line.qty, states),
      remainingQty: Math.max(0, line.qty - line.linkedQty),
      status: gatePassProductStatusFor(states),
    }
  })

  return {
    gatePassId: String(gatePass._id),
    gatePassNumber: gatePass.gatePassId,
    tripDo: gatePass.tripDo,
    status: gatePassProductStatusFor(rows.map(stateOf)),
    totalQty: result.reduce((sum, line) => sum + line.qty, 0),
    linkedQty: result.reduce((sum, line) => sum + line.linkedQty, 0),
    lines: result,
  }
}
