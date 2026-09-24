import type { QueryFilter } from 'mongoose'
import { getObjectStream } from '../../config/r2'
import type { ObjectStream } from '../../config/r2'
import { AppError } from '../../utils/app-error'
import { changeSummary, changesBetween, dayValue } from '../activity/activity.diff'
import type { FieldSpec } from '../activity/activity.diff'
import { recordActivity } from '../activity/activity.recorder'
import { refreshBillingStatus } from '../bill/bill.status'
import { GATE_PASS_REVIEW_AUDIENCE } from '../notification/notification.constants'
import { notify } from '../notification/notification.recorder'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import {
  assertGatePassEditKeepsLinks,
  assertGatePassNotLinked,
  DELIVERED_SHARE,
  deliveryByGatePassLine,
  LINKED_LINE_KEY,
  refreshGatePassLinkCopies,
} from '../trip-do/trip-do.links'
import type { GatePassLineDelivery } from '../trip-do/trip-do.links'
import { TripDoLineModel } from '../trip-do/trip-do.model'
import { assertCanDelete, assertCanEdit, assertCanView, visibilityFilter } from './gate-pass.access'
import {
  canTransitionGatePass,
  comparisonKey,
  needsReverificationAfterEdit,
} from './gate-pass.constants'
import type { GatePassStatus } from './gate-pass.constants'
import { allocateGatePassId } from './gate-pass.counter'
import { GatePassModel } from './gate-pass.model'
import type { GatePass, GatePassDocument } from './gate-pass.model'
import { toDuplicateCandidate, toGatePassRecord } from './gate-pass.serializer'
import type { DuplicateCandidate, GatePassRecord } from './gate-pass.serializer'
import { discardGatePassDocument, uploadGatePassDocument } from './gate-pass.storage'
import type { UploadDocumentInput } from './gate-pass.storage'
import { compareColumnValues, toColumnValuesResult } from '../../utils/column-filters'
import type { ColumnValue, ColumnValuesResult } from '../../utils/column-filters'
import {
  gatePassColumnValue,
  gatePassColumnValuesStages,
  hasDeliveryFilter,
  lineConditions,
  lineMatchesColumns,
  recordFilterClauses,
} from './gate-pass.columns'
import type {
  CreateGatePassInput,
  DuplicateQuery,
  GatePassColumnValuesQuery,
  GatePassFilterQuery,
  ListGatePassesQuery,
  ReviewGatePassInput,
  SubmitGatePassInput,
  SuggestionField,
  SuggestionQuery,
  UpdateGatePassInput,
} from './gate-pass.validation'

/**
 * A gate pass as the records sheet draws it: the record, and beside each of
 * its product lines what the challans linked to that line on the Trip DO sheet
 * say about delivery. `lineDelivery[i]` belongs to `items[i]`.
 */
export type GatePassListRecord = GatePassRecord & { lineDelivery: GatePassLineDelivery[] }

export interface ListGatePassesResult {
  records: GatePassListRecord[]
  total: number
  /** Pieces on the matching gate passes that challans say were delivered, and the rest. */
  deliveredQty: number
  notDeliveredQty: number
  /**
   * Every quantity on every matching record, not just the page on screen.
   * The whole point of the figure is that it answers "how much did these
   * filters just describe", which a page of ten could never say.
   */
  totalQty: number
}

export interface GatePassStats {
  total: number
  draft: number
  submitted: number
  verified: number
  rejected: number
  /** Gate passes whose trip date is today, whatever their status. */
  today: number
}

/** User input reaches a regex, so metacharacters must lose their meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Start of the UTC day, which is how tripDate is stored. */
function startOfUtcDay(value: string | Date): Date {
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : value
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  )
}

function endOfUtcDay(value: string): Date {
  const start = startOfUtcDay(value)
  return new Date(start.getTime() + 86_400_000 - 1)
}

/**
 * Resolves every actor referenced on this page of results in a single indexed
 * lookup, rather than populating row by row. Returns id -> display name.
 * Same treatment the administration module gives its list.
 */
async function resolveActorNames(records: GatePassDocument[]): Promise<Map<string, string>> {
  const ids = new Set<string>()

  for (const record of records) {
    ids.add(String(record.createdBy))
    if (record.updatedBy) {
      ids.add(String(record.updatedBy))
    }
    if (record.statusChangedBy) {
      ids.add(String(record.statusChangedBy))
    }
  }

  if (ids.size === 0) {
    return new Map()
  }

  const actors = await UserModel.find({ _id: { $in: [...ids] } }).select('name')
  return new Map(actors.map((actor) => [String(actor._id), actor.name]))
}

async function serialize(record: GatePassDocument): Promise<GatePassRecord> {
  const names = await resolveActorNames([record])
  return toGatePassRecord(record, names)
}

/**
 * Everything the database can answer: visibility, the toolbar, the gate
 * pass-level column filters, and the line filters on one line together. The
 * delivery status column is the one thing it cannot — see `buildListFilter`.
 */
function baseListFilter(query: GatePassFilterQuery, viewer: UserDocument): QueryFilter<GatePass> {
  const clauses: QueryFilter<GatePass>[] = []

  const visibility = visibilityFilter(viewer)
  if (visibility) {
    clauses.push(visibility)
  }

  for (const clause of recordFilterClauses(query.columns)) {
    clauses.push(clause as QueryFilter<GatePass>)
  }

  const line = lineConditions(query.columns)
  if (line) {
    // One line must meet every line filter at once.
    clauses.push({ items: { $elemMatch: line } } as QueryFilter<GatePass>)
  }

  if (query.bill === 'unbilled') {
    clauses.push({ billStatus: { $nin: ['Partial', 'Billed'] } })
  } else if (query.bill !== 'all') {
    clauses.push({ billStatus: query.bill === 'partial' ? 'Partial' : 'Billed' })
  }
  if (query.referenceType !== 'all') {
    clauses.push({ referenceType: query.referenceType })
  }

  if (query.reference) {
    // Matches whichever of the two the record actually carries, so the
    // operator does not have to know which field a value was filed under.
    const pattern = new RegExp(escapeRegex(query.reference), 'i')
    clauses.push({ $or: [{ zone: pattern }, { po: pattern }] })
  }

  if (query.createdBy) {
    clauses.push({ createdBy: query.createdBy })
  }

  if (query.from || query.to) {
    const range: { $gte?: Date; $lte?: Date } = {}
    if (query.from) {
      range.$gte = startOfUtcDay(query.from)
    }
    if (query.to) {
      range.$lte = endOfUtcDay(query.to)
    }
    clauses.push({ tripDate: range })
  }

  if (query.search) {
    /**
     * Six fields, because an operator searches with whatever is in front of
     * them: the number off the printed pass, the customer who called, or the
     * vehicle that just arrived. Anchored nowhere, so a partial vehicle number
     * still finds it.
     */
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({
      $or: [
        { gatePassId: pattern },
        { tripDo: pattern },
        { customerName: pattern },
        { vehicleNo: pattern },
        { 'items.productModel': pattern },
        { 'items.productName': pattern },
      ],
    })
  }

  return clauses.length > 0 ? { $and: clauses } : {}
}

/**
 * Gate passes one delivery-status question may read. Delivery status lives on
 * the Trip DO links rather than on the gate pass, so it is worked out per line
 * in memory — and past this many the operator is asked to narrow the dates or
 * another column first, rather than handed an answer about some of them.
 */
const MAX_DELIVERY_SCAN = 5000

interface LineCandidate {
  record: GatePassDocument
  lines: { item: GatePassDocument['items'][number]; status: string }[]
}

async function loadLineCandidates(filter: QueryFilter<GatePass>): Promise<LineCandidate[]> {
  const records = await GatePassModel.find(filter)
    .select('tripDo tripDate csd unit vehicleNo customerName status items')
    .limit(MAX_DELIVERY_SCAN + 1)

  if (records.length > MAX_DELIVERY_SCAN) {
    throw new AppError(
      400,
      `Delivery status is worked out gate pass by gate pass, and these filters match more than ${MAX_DELIVERY_SCAN}. Narrow the dates or another column first.`,
    )
  }

  const delivery = await deliveryByGatePassLine(records.map((record) => record._id))
  return records.map((record) => {
    const lines = delivery.get(String(record._id))
    return {
      record,
      lines: record.items.map((item) => ({
        item,
        status: lines?.get(item.productModelKey)?.status ?? 'Unlinked',
      })),
    }
  })
}

/**
 * The records list filter. Without a delivery status tick it is the database
 * filter alone; with one, it is narrowed to the gate passes one of whose lines
 * meets every line filter *and* reads a ticked delivery status.
 */
async function buildListFilter(
  query: GatePassFilterQuery,
  viewer: UserDocument,
): Promise<QueryFilter<GatePass>> {
  const base = baseListFilter(query, viewer)
  if (!hasDeliveryFilter(query.columns)) {
    return base
  }

  const ids = (await loadLineCandidates(base))
    .filter(({ lines }) => lines.some((line) => lineMatchesColumns(line.item, line.status, query.columns)))
    .map(({ record }) => record._id)

  return { $and: [base, { _id: { $in: ids } }] }
}

/**
 * The distinct values in one column, counted in sheet rows, under every filter
 * in use except that column's own — so the dropdown still offers what was
 * unticked, the way a spreadsheet's does.
 */
export async function listGatePassColumnValues(
  query: GatePassColumnValuesQuery,
  viewer: UserDocument,
): Promise<ColumnValuesResult> {
  const { column, ...rest } = query
  const columns = { ...rest.columns }
  delete columns[column]
  const others = { ...rest, columns }

  if (column !== 'delivery' && !hasDeliveryFilter(columns)) {
    const rows = await GatePassModel.aggregate<{ _id: ColumnValue; count: number }>([
      { $match: baseListFilter(others, viewer) },
      ...gatePassColumnValuesStages(column, columns),
    ])
    return toColumnValuesResult(rows)
  }

  const counts = new Map<string, { value: ColumnValue; count: number }>()
  for (const { record, lines } of await loadLineCandidates(baseListFilter(others, viewer))) {
    for (const line of lines) {
      if (!lineMatchesColumns(line.item, line.status, columns)) continue
      const value = gatePassColumnValue(column, record, line.item, line.status)
      const key = JSON.stringify(value)
      const entry = counts.get(key) ?? { value, count: 0 }
      entry.count += 1
      counts.set(key, entry)
    }
  }

  const sorted = [...counts.values()].sort((a, b) => compareColumnValues(a.value, b.value))
  return toColumnValuesResult(sorted.map((entry) => ({ _id: entry.value, count: entry.count })))
}

interface GatePassTotals {
  total: number
  totalQty: number
}

/**
 * How many records match a filter, and how much they carry between them.
 *
 * One grouped pass rather than a count plus a second aggregation: both figures
 * are read off the same matching set, and the list is already paying for a
 * round trip of its own on a cluster that charges for every one. The inner
 * `$sum` adds the quantities inside a single record's items array; the outer
 * one adds those subtotals across the records.
 */
async function totalsFor(filter: QueryFilter<GatePass>): Promise<GatePassTotals> {
  const [row] = await GatePassModel.aggregate<GatePassTotals>([
    { $match: filter },
    { $group: { _id: null, total: { $sum: 1 }, totalQty: { $sum: { $sum: '$items.qty' } } } },
    { $project: { _id: 0, total: 1, totalQty: 1 } },
  ])

  // An empty result set groups to no rows at all, which is zero of both.
  return row ?? { total: 0, totalQty: 0 }
}

/**
 * Delivered pieces over every matching gate pass — the figure behind the
 * Delivered / Not delivered cards, so it answers the filters like `totalQty`.
 *
 * Lines are grouped by model before the lookup, so a gate pass carrying one
 * model on two lines cannot count the same delivered pieces twice, and each
 * model's delivered figure is capped at what the gate pass carries.
 */
async function deliveredQtyFor(filter: QueryFilter<GatePass>): Promise<number> {
  const [row] = await GatePassModel.aggregate<{ deliveredQty: number }>([
    { $match: filter },
    { $unwind: '$items' },
    {
      $group: {
        _id: { gatePassId: '$_id', modelKey: '$items.productModelKey' },
        qty: { $sum: '$items.qty' },
      },
    },
    {
      $lookup: {
        from: TripDoLineModel.collection.name,
        let: { gatePassId: '$_id.gatePassId', modelKey: '$_id.modelKey' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$link.gatePassId', '$$gatePassId'] },
                  { $eq: [LINKED_LINE_KEY, '$$modelKey'] },
                ],
              },
            },
          },
          // Order rows' first delivery, less linked returns, plus linked re-sends.
          { $group: { _id: null, qty: { $sum: DELIVERED_SHARE } } },
        ],
        as: 'delivered',
      },
    },
    {
      $group: {
        _id: null,
        deliveredQty: {
          $sum: {
            $min: [
              '$qty',
              { $max: [0, { $round: [{ $ifNull: [{ $first: '$delivered.qty' }, 0] }, 0] }] },
            ],
          },
        },
      },
    },
  ])

  return row?.deliveredQty ?? 0
}

export async function listGatePasses(
  query: ListGatePassesQuery,
  viewer: UserDocument,
): Promise<ListGatePassesResult> {
  const filter = await buildListFilter(query, viewer)
  const skip = (query.page - 1) * query.limit

  const [records, totals, deliveredQty] = await Promise.all([
    GatePassModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    totalsFor(filter),
    deliveredQtyFor(filter),
  ])

  const [names, delivery] = await Promise.all([
    resolveActorNames(records),
    deliveryByGatePassLine(records.map((record) => record._id)),
  ])

  return {
    records: records.map((record) => {
      const lines = delivery.get(String(record._id))
      return {
        ...toGatePassRecord(record, names),
        lineDelivery: record.items.map(
          (item) =>
            lines?.get(item.productModelKey) ?? {
              linkedQty: 0,
              deliveredQty: 0,
              status: 'Unlinked' as const,
            },
        ),
      }
    }),
    total: totals.total,
    totalQty: totals.totalQty,
    deliveredQty,
    notDeliveredQty: Math.max(0, totals.totalQty - deliveredQty),
  }
}

/**
 * How many records one download may carry. Records, not rows: a gate pass
 * carrying three products is three rows in the sheet.
 *
 * An export is the one read in this module that is not paged, so it is also
 * the one that could ask an M0 cluster and a 512 MB instance for a year of
 * records at once. Past this the request is refused with the count and a note
 * to narrow the filters — a silently truncated spreadsheet is worse than no
 * spreadsheet, because nothing on the page says the bottom of it is missing.
 */
export const MAX_EXPORT_RECORDS = 5000

export interface GatePassExport {
  records: GatePassRecord[]
  /** The same figure the filtered list shows, so the two cannot disagree. */
  totalQty: number
}

/**
 * Every record matching the current filters, for the spreadsheet.
 *
 * The same `buildListFilter` and the same visibility rules as the list, so a
 * download can never contain a row its owner could not have opened — an
 * export that quietly widened the query would be the easiest way in the app
 * to read somebody else's draft.
 *
 * Ordered by trip date rather than by when the record was typed: a
 * spreadsheet covering a month is read chronologically, and any other order
 * is one click away once it is open.
 */
export async function exportGatePasses(
  query: GatePassFilterQuery,
  viewer: UserDocument,
): Promise<GatePassExport> {
  const filter = await buildListFilter(query, viewer)
  const totals = await totalsFor(filter)

  if (totals.total === 0) {
    throw new AppError(404, 'No gate passes match these filters, so there is nothing to export.')
  }

  if (totals.total > MAX_EXPORT_RECORDS) {
    throw new AppError(
      400,
      `That is ${totals.total} gate passes. Narrow the filters to ${MAX_EXPORT_RECORDS} or fewer and export again.`,
    )
  }

  const records = await GatePassModel.find(filter).sort({ tripDate: 1, gatePassId: 1 })
  const names = await resolveActorNames(records)

  return {
    records: records.map((record) => toGatePassRecord(record, names)),
    totalQty: totals.totalQty,
  }
}

/**
 * One grouped aggregation rather than five counts — the summary is the first
 * thing the records page renders, and M0 pays for every round trip.
 *
 * Scoped to what the viewer may see, so an OpEx's totals match their list
 * instead of counting drafts they cannot open.
 */
export async function getGatePassStats(viewer: UserDocument): Promise<GatePassStats> {
  const visibility = visibilityFilter(viewer)
  const base: QueryFilter<GatePass> = visibility ?? {}

  const today = startOfUtcDay(new Date())
  const tomorrow = new Date(today.getTime() + 86_400_000)

  const [rows, todayCount] = await Promise.all([
    GatePassModel.aggregate<{ _id: string; count: number }>([
      { $match: base },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    GatePassModel.countDocuments({
      ...base,
      tripDate: { $gte: today, $lt: tomorrow },
    }),
  ])

  const counts = new Map(rows.map((row) => [row._id, row.count]))
  const read = (status: GatePassStatus): number => counts.get(status) ?? 0

  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    draft: read('Draft'),
    submitted: read('Submitted'),
    verified: read('Verified'),
    rejected: read('Rejected'),
    today: todayCount,
  }
}

async function findRecord(id: string): Promise<GatePassDocument> {
  const record = await GatePassModel.findById(id)
  if (!record) {
    throw new AppError(404, 'Gate pass not found.')
  }
  return record
}

export async function getGatePass(id: string, viewer: UserDocument): Promise<GatePassRecord> {
  const record = await findRecord(id)
  assertCanView(record, viewer)
  return serialize(record)
}

/**
 * Writes the validated trip details onto a record. Shared by create and
 * update, so the two cannot drift on how a reference or a comparison key is
 * derived.
 *
 * The comparison keys are written here and nowhere else: they are the only
 * normalised copies of what the operator typed, and the displayed fields keep
 * exactly what was entered.
 */
function applyFields(
  record: GatePassDocument,
  input: CreateGatePassInput | UpdateGatePassInput,
): void {
  record.tripDo = input.tripDo
  record.tripDoKey = comparisonKey(input.tripDo)
  record.tripDate = input.tripDate
  record.csd = input.csd
  record.unit = input.unit

  record.customerName = input.customerName
  record.vehicleNo = input.vehicleNo
  record.vehicleNoKey = comparisonKey(input.vehicleNo)

  /**
   * Exactly one of the two, or neither. Clearing the other side is what stops
   * a record that used to be filed under a zone from keeping a stale zone
   * after it is refiled against a PO.
   */
  record.referenceType = input.referenceType
  record.zone = input.referenceType === 'Zone' ? input.zone : null
  record.po = input.referenceType === 'PO' ? input.po : null

  /**
   * Replaced wholesale rather than merged. A product row has no identity of
   * its own — removing the second of three and editing the third is
   * indistinguishable from rewriting all three, so the client sends the list
   * it wants and this is what it becomes.
   */
  /**
   * Written through `set` rather than assigned. `record.items` is a Mongoose
   * DocumentArray, not a plain array, so assigning one would mean casting away
   * its type; `set` is the API that takes the plain rows and casts them into
   * subdocuments itself.
   */
  record.set(
    'items',
    input.items.map((item) => ({
      productName: item.productName,
      productModel: item.model,
      productModelKey: comparisonKey(item.model),
      qty: item.qty,
    })),
  )
}

/**
 * A gate pass flattened to the values a journal row would quote.
 *
 * The goods are one string rather than a field per line, because lines have no
 * identity of their own here — they are replaced wholesale on every update, so
 * "line 2 changed" would be a sentence about a position rather than about a
 * product. The whole load rendered once says what actually differs.
 */
function gatePassSnapshot(record: GatePassDocument) {
  return {
    tripDo: record.tripDo,
    tripDate: dayValue(record.tripDate),
    csd: record.csd,
    unit: record.unit,
    customerName: record.customerName,
    vehicleNo: record.vehicleNo,
    reference: record.zone ?? record.po ?? null,
    items: record.items
      .map((item) => `${item.productName} ${item.productModel} × ${item.qty}`)
      .join('; '),
  }
}

type GatePassSnapshot = ReturnType<typeof gatePassSnapshot>

const GATE_PASS_FIELDS: FieldSpec<GatePassSnapshot>[] = [
  { field: 'tripDo', label: 'Trip DO' },
  { field: 'tripDate', label: 'Trip date' },
  { field: 'customerName', label: 'Customer' },
  { field: 'vehicleNo', label: 'Vehicle' },
  { field: 'csd', label: 'CSD' },
  { field: 'unit', label: 'Unit' },
  { field: 'reference', label: 'Zone / PO' },
  { field: 'items', label: 'Goods' },
]

/** "GP-2026-000123 · DHAKA METRO-NA-15-1469 · Walton" — a row's own sentence. */
function gatePassPhrase(record: GatePassDocument): string {
  return `${record.gatePassId} · ${record.tripDo} · ${record.customerName}`
}

export async function createGatePass(
  input: CreateGatePassInput,
  actor: UserDocument,
): Promise<GatePassRecord> {
  const record = new GatePassModel({
    gatePassId: await allocateGatePassId(),
    createdBy: actor._id,
  })

  applyFields(record, input)
  await record.save()

  await recordActivity({
    action: 'gate-pass.created',
    entityType: 'GatePass',
    entityId: record._id,
    entityLabel: record.gatePassId,
    summary: `${gatePassPhrase(record)} filed as a draft`,
    actor,
  })

  return serialize(record)
}

/**
 * Sends a record back to be checked again, when a correction has invalidated
 * the verdict already on it.
 *
 * A verification says "these values match this scan". Change either side and
 * that sentence is about content nobody read, so the record returns to
 * Submitted and a reviewer sees it again. Everything still open — a draft, a
 * rejection being corrected, something already awaiting review — carries no
 * verdict to invalidate and is left exactly where it is.
 *
 * The mover is the person doing the correcting, which is what makes the
 * provenance on the record honest: statusChangedBy is who caused the move.
 */
function returnForReverification(record: GatePassDocument, actor: UserDocument): void {
  if (!needsReverificationAfterEdit(record.status as GatePassStatus)) {
    return
  }

  record.status = 'Submitted'
  record.statusChangedAt = new Date()
  record.statusChangedBy = actor._id
  record.statusNote = null
}

export async function updateGatePass(
  id: string,
  input: UpdateGatePassInput,
  actor: UserDocument,
): Promise<GatePassRecord> {
  const record = await findRecord(id)
  assertCanEdit(record, actor)
  /**
   * A correction may not leave more pieces linked to a model on the Trip DO
   * sheet than the gate pass now carries. Refused rather than unlinked,
   * because which challan should lose its Trip DO is not arithmetic.
   */
  await assertGatePassEditKeepsLinks(record._id, input.items)

  const before = gatePassSnapshot(record)
  const statusBefore = record.status as GatePassStatus

  applyFields(record, input)
  returnForReverification(record, actor)
  record.updatedBy = actor._id
  await record.save()
  // Linked rows show this gate pass's Trip DO, CSD and unit.
  await refreshGatePassLinkCopies(record)
  // A corrected quantity moves how much of it the bills cover.
  await refreshBillingStatus({ gatePassIds: [record._id] })

  const changes = changesBetween(before, gatePassSnapshot(record), GATE_PASS_FIELDS)

  /**
   * A correction that sent the record back for re-verification says so in the
   * summary, because that is the consequence somebody reading the journal
   * later actually cares about: a reviewer's verdict was withdrawn, and the
   * record only says who caused it.
   */
  await recordActivity({
    action: 'gate-pass.updated',
    entityType: 'GatePass',
    entityId: record._id,
    entityLabel: record.gatePassId,
    summary:
      statusBefore !== record.status
        ? `${record.gatePassId} corrected — ${changeSummary(changes)}; sent back from ${statusBefore} for re-verification`
        : `${record.gatePassId} corrected — ${changeSummary(changes)}`,
    changes,
    actor,
  })

  return serialize(record)
}

/**
 * Possible duplicates for a candidate gate pass: another record with the same
 * Trip DO.
 *
 * The same DO recorded twice is almost always a mistake, so it is the one
 * thing asked about. There used to be a second probe — the same vehicle
 * carrying the same model on the same day — and it was removed: one lorry
 * routinely takes the same model out on several Trip DOs in a day, so it asked
 * on ordinary gate passes and taught operators to dismiss the dialog unread,
 * which is how the one real duplicate gets through.
 *
 * Nothing here is a unique index. The business has not confirmed a Trip DO is
 * globally unique, and a constraint built on that assumption would eventually
 * refuse a real gate pass at the gate.
 */
export async function findDuplicates(
  query: DuplicateQuery,
  viewer: UserDocument,
): Promise<DuplicateCandidate[]> {
  const tripDoKey = comparisonKey(query.tripDo)

  if (!tripDoKey) {
    return []
  }

  // Every stored record counts, in any status. A gate pass that turned out to
  // be a mistake is deleted rather than withdrawn, so anything still in the
  // collection is something the operator should be asked about.
  const filter: QueryFilter<GatePass> = {
    $and: [{ tripDoKey }],
  }

  if (query.excludeId) {
    filter.$and?.push({ _id: { $ne: query.excludeId } })
  }

  const visibility = visibilityFilter(viewer)
  if (visibility) {
    filter.$and?.push(visibility)
  }

  // Five is a decision aid; a longer list is a research task nobody performs
  // with a truck waiting at the gate.
  const matches = await GatePassModel.find(filter).sort({ createdAt: -1 }).limit(5)

  return matches.map((match) => toDuplicateCandidate(match, 'tripDo'))
}

/** Where each suggestible field actually lives in a document. */
const SUGGESTION_PATHS: Record<SuggestionField, string> = {
  customerName: 'customerName',
  vehicleNo: 'vehicleNo',
  productName: 'items.productName',
  model: 'items.productModel',
}

/**
 * Values already on record for one field, for the entry form's type-ahead.
 *
 * The same customers, vehicles and models come back week after week, so
 * offering what has been filed before is both faster to type and — more to the
 * point — the thing that stops the same customer being recorded three ways.
 *
 * Anchored at the start of the value on purpose. A prefix is what an index can
 * answer, and it is what somebody typing expects; a contains-match would find
 * more and cost a collection scan on every keystroke. Ordered by how often
 * each value has been used, so the common one is first.
 *
 * Scoped to what the viewer may see, so a colleague's unfinished draft cannot
 * leak a customer name through the suggestion list.
 */
export async function suggestValues(
  query: SuggestionQuery,
  viewer: UserDocument,
): Promise<string[]> {
  const path = SUGGESTION_PATHS[query.field]
  const prefix = new RegExp(`^${escapeRegex(query.q)}`, 'i')

  const visibility = visibilityFilter(viewer)
  const match: QueryFilter<GatePass> = visibility
    ? { $and: [visibility, { [path]: prefix }] }
    : { [path]: prefix }

  const rows = await GatePassModel.aggregate<{ _id: string; count: number }>([
    { $match: match },
    // Product fields live inside an array, so the rows have to be opened out
    // before they can be grouped — and re-filtered, or a record matching on
    // one line would offer every other line it carries too.
    ...(path.startsWith('items.')
      ? [{ $unwind: '$items' }, { $match: { [path]: prefix } }]
      : []),
    { $group: { _id: `$${path}`, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: SUGGESTION_LIMIT },
  ])

  return rows.map((row) => row._id).filter((value) => typeof value === 'string' && value.length > 0)
}

/** Enough to be useful, few enough to read without scrolling. */
const SUGGESTION_LIMIT = 8

export class DuplicateGatePassError extends AppError {
  public readonly duplicates: DuplicateCandidate[]

  constructor(duplicates: DuplicateCandidate[]) {
    super(409, 'A gate pass with these details may already exist.')
    this.duplicates = duplicates
  }
}

/**
 * Moves a record out of Draft, or back out of Rejected after a correction.
 *
 * Three things are enforced here rather than by the client. The transition has
 * to be legal; a submitted gate pass has to carry its scanned document,
 * because the document is the point of the record; and a possible duplicate
 * has to have been looked at. `acknowledgeDuplicate` is the operator's answer
 * to that question, not a way around it — the check runs either way.
 */
export async function submitGatePass(
  id: string,
  input: SubmitGatePassInput,
  actor: UserDocument,
): Promise<GatePassRecord> {
  const record = await findRecord(id)
  assertCanEdit(record, actor)

  const current = record.status as GatePassStatus

  if (!canTransitionGatePass(current, 'Submitted')) {
    throw new AppError(409, `A ${current} gate pass cannot be submitted.`)
  }

  if (!record.document) {
    throw new AppError(409, 'Scan the gate pass document before submitting.')
  }

  if (!input.acknowledgeDuplicate) {
    const duplicates = await findDuplicates(
      { tripDo: record.tripDo, excludeId: String(record._id) },
      actor,
    )

    if (duplicates.length > 0) {
      throw new DuplicateGatePassError(duplicates)
    }
  }

  record.status = 'Submitted'
  // Set once, on the first submission. A resubmission after a rejection is the
  // same gate pass being corrected, not a new one.
  record.submittedAt = record.submittedAt ?? new Date()
  record.statusChangedAt = new Date()
  record.statusChangedBy = actor._id
  record.statusNote = null
  record.updatedBy = actor._id
  await record.save()

  await recordActivity({
    action: 'gate-pass.submitted',
    entityType: 'GatePass',
    entityId: record._id,
    entityLabel: record.gatePassId,
    summary: `${gatePassPhrase(record)} submitted for review${
      input.acknowledgeDuplicate ? ' — a possible duplicate Trip DO was acknowledged' : ''
    }`,
    changes: [{ field: 'status', label: 'Status', from: current, to: 'Submitted' }],
    actor,
  })

  /**
   * And whoever reviews is told there is something to review.
   *
   * The review audience rather than the write audience, because this message is
   * a request for a verdict and every one of those roles can give one. The
   * submitter is excluded by `notify`, which in a one-person office means
   * nothing is written at all — correct, and the reason the exclusion lives in
   * the seam rather than at each call site.
   */
  await notify({
    event: 'gate-pass.submitted',
    audience: { kind: 'roles', roles: GATE_PASS_REVIEW_AUDIENCE },
    title: `${record.gatePassId} is waiting to be verified`,
    body: `${record.customerName} · Trip DO ${record.tripDo} · ${record.vehicleNo}. Check the values against the scan.`,
    entityType: 'GatePass',
    entityId: record._id,
    entityLabel: record.gatePassId,
    actor,
  })

  return serialize(record)
}

/**
 * The reviewer's decision: verified against the physical document, or rejected
 * back for correction.
 *
 * A note survives only while it is still the reason for the current state — a
 * rejection keeps its note so the operator can act on it, and a verification
 * clears it so a corrected record does not carry an old complaint forever.
 */
export async function reviewGatePass(
  id: string,
  input: ReviewGatePassInput,
  actor: UserDocument,
): Promise<GatePassRecord> {
  const record = await findRecord(id)

  const current = record.status as GatePassStatus

  if (!canTransitionGatePass(current, input.status)) {
    throw new AppError(409, `A ${current} gate pass cannot be moved to ${input.status}.`)
  }

  record.status = input.status
  record.statusChangedAt = new Date()
  record.statusChangedBy = actor._id
  record.statusNote = input.status === 'Verified' ? null : input.note || null
  record.updatedBy = actor._id
  await record.save()

  /**
   * Two actions rather than one, because verifying and sending back are the
   * two halves of review and a reader filtering for one never wants the other.
   * The note goes in the row: the record clears it on the next verification,
   * and the reason a gate pass was sent back in August is exactly what nobody
   * can reconstruct afterwards.
   */
  await recordActivity({
    action: input.status === 'Verified' ? 'gate-pass.verified' : 'gate-pass.rejected',
    entityType: 'GatePass',
    entityId: record._id,
    entityLabel: record.gatePassId,
    summary:
      input.status === 'Verified'
        ? `${gatePassPhrase(record)} verified against its scan`
        : `${gatePassPhrase(record)} sent back${record.statusNote ? ` — ${record.statusNote}` : ''}`,
    changes: [
      { field: 'status', label: 'Status', from: current, to: input.status },
      ...(record.statusNote
        ? [{ field: 'statusNote', label: 'Reason', from: null, to: record.statusNote }]
        : []),
    ],
    actor,
  })

  /**
   * And the verdict goes back to whoever filed it.
   *
   * Addressed to the **author** rather than to a role, and it is the one place
   * in this module where authorship still decides anything: CLAUDE.md records
   * that the per-record ownership scope came off every write here, so anybody
   * may correct anybody's gate pass — but "your gate pass was sent back, and
   * here is why" is a sentence with exactly one recipient, and broadcasting it
   * to four roles would make the one person who has to act on it the least
   * likely to notice.
   *
   * A sent-back gate pass carries the reviewer's note, and this is the only
   * place it is put in front of the person who has to fix it — the record clears
   * it on the next verification.
   */
  await notify({
    event: input.status === 'Verified' ? 'gate-pass.verified' : 'gate-pass.rejected',
    audience: { kind: 'user', userId: record.createdBy },
    title:
      input.status === 'Verified'
        ? `${record.gatePassId} was verified`
        : `${record.gatePassId} was sent back`,
    body:
      input.status === 'Verified'
        ? `${record.customerName} · Trip DO ${record.tripDo}. The values match the scan.`
        : `${record.customerName} · Trip DO ${record.tripDo}.` +
          (record.statusNote ? ` ${record.statusNote}` : ' Correct it and submit it again.'),
    entityType: 'GatePass',
    entityId: record._id,
    entityLabel: record.gatePassId,
    actor,
  })

  return serialize(record)
}

export interface AttachDocumentInput {
  buffer: Buffer
  mimeType: string
  originalName: string
  pageCount: number | null
}

/**
 * Replaces the scanned document on a gate pass.
 *
 * The order is the whole point, and it is the same order profile photos use:
 * the new object is uploaded first, the reference is written second, and only
 * then is the previous object deleted. At no point does a gate pass point at a
 * document that no longer exists — the worst outcome of a failure here is an
 * orphaned object in the bucket, which is visible to nobody.
 *
 * Deliberately not wrapped in a transaction. R2 is not part of one, and
 * holding a MongoDB transaction open across a 25 MB upload would pin a
 * connection on an M0 cluster for the length of somebody's broadband.
 */
export async function setGatePassDocument(
  id: string,
  input: AttachDocumentInput,
  actor: UserDocument,
): Promise<GatePassRecord> {
  const record = await findRecord(id)
  assertCanEdit(record, actor)

  const previousKey = record.document?.key ?? null

  const upload: UploadDocumentInput = {
    gatePassId: record.gatePassId,
    tripDate: record.tripDate,
    buffer: input.buffer,
    mimeType: input.mimeType,
    originalName: input.originalName,
    pageCount: input.pageCount,
  }

  const stored = await uploadGatePassDocument(upload)

  record.document = stored
  // The scan is the other half of what a reviewer checked, so replacing it
  // costs the same as rewriting the values.
  returnForReverification(record, actor)
  record.updatedBy = actor._id

  try {
    await record.save()
  } catch (error) {
    // The upload succeeded but the reference never landed, so the new object
    // is already unreachable. Clean it up rather than leave it behind.
    await discardGatePassDocument(stored.key)
    throw error
  }

  await discardGatePassDocument(previousKey)

  return serialize(record)
}

export interface DocumentDownload extends ObjectStream {
  mimeType: string
  /** What the browser should call the file if the viewer saves it. */
  filename: string
}

/**
 * Streams the scanned document back.
 *
 * This is the only read path for a gate pass document. The bucket is never the
 * source: the object is stored privately and served from here, so a customer
 * address on a challan is behind the same authentication and the same role
 * check as the record it belongs to.
 */
export async function readGatePassDocument(
  id: string,
  viewer: UserDocument,
): Promise<DocumentDownload> {
  const record = await findRecord(id)
  assertCanView(record, viewer)

  if (!record.document) {
    throw new AppError(404, 'This gate pass has no scanned document.')
  }

  const object = await getObjectStream(record.document.key)
  const extension = record.document.mimeType === 'application/pdf' ? 'pdf' : 'jpg'

  return {
    ...object,
    mimeType: record.document.mimeType,
    // Named after the gate pass rather than after whatever the operator's
    // scanner called it, so a folder of downloads sorts usefully.
    filename: `${record.gatePassId}.${
      record.document.originalName.split('.').pop()?.toLowerCase() ?? extension
    }`,
  }
}

/**
 * Removes a gate pass entirely — the record and its scanned document, in any
 * status. This is the module's only way to withdraw something; access.ts
 * decides whose records the actor may remove.
 *
 * The document goes after the record, for the same reason it does everywhere
 * else in this codebase: an orphaned object is cheaper than a live reference
 * to a deleted one.
 */
export async function removeGatePass(id: string, actor: UserDocument): Promise<{ id: string }> {
  const record = await findRecord(id)
  assertCanDelete(record, actor)
  // Challan rows on the Trip DO sheet would be left pointing at nothing.
  await assertGatePassNotLinked(record._id)

  const key = record.document?.key ?? null
  const snapshot = gatePassSnapshot(record)
  const phrase = gatePassPhrase(record)
  const status = record.status

  await record.deleteOne()
  await discardGatePassDocument(key)

  /**
   * Withdrawing a gate pass is a delete rather than a status — the `Cancelled`
   * state was removed precisely so a record that should not exist does not sit
   * in every list being scrolled past. The cost of that decision is that
   * nothing was left saying a gate pass had ever existed. This is the row that
   * pays it, and it carries the whole record because there is nothing left to
   * look up.
   */
  await recordActivity({
    action: 'gate-pass.deleted',
    entityType: 'GatePass',
    entityId: record._id,
    entityLabel: record.gatePassId,
    summary: `${phrase} deleted while ${status}`,
    changes: changesBetween(snapshot, {}, GATE_PASS_FIELDS),
    actor,
  })

  return { id: String(record._id) }
}
