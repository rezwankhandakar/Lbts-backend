import { Types } from 'mongoose'
import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import {
  ACTION_META,
  ACTIVITY_ACTIONS,
  MAX_ACTIVITY_ACTORS,
  MAX_ACTIVITY_EXPORT_ROWS,
  actionMeta,
  actionsOfCategory,
  actionsOfModule,
  actionsOfSeverity,
} from './activity.constants'
import type {
  ActivityAction,
  ActivityCategory,
  ActivityModule,
  ActivitySeverity,
} from './activity.constants'
import { ActivityModel } from './activity.model'
import type { Activity } from './activity.model'
import { toActivityRecord } from './activity.serializer'
import type { ActivityRecord } from './activity.serializer'
import type {
  ActivityStatsQuery,
  ExportActivityQuery,
  ListActivityQuery,
} from './activity.validation'

/** User input reaches a regex, so metacharacters must lose their meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A day's worth of milliseconds, for the two ranges the overview reports. */
const DAY_MS = 24 * 60 * 60 * 1000
const TREND_DAYS = 14

type FilterQuery = ExportActivityQuery

/**
 * The actions a query is asking about.
 *
 * Module, category and severity are derived from the action rather than stored
 * beside it, so all three narrow the same way: each contributes a set of
 * actions, and the query is their **intersection**. `Vendor` + `delete` is the
 * four vendor-module deletions and nothing else, which is the honest reading
 * of two filters applied together.
 *
 * Returning an empty array is meaningful — it says the combination matches
 * nothing, and the caller turns that into an empty page rather than an
 * unfiltered one. That distinction is the whole reason this is a function
 * rather than four `if`s in `buildFilter`.
 */
function actionsFor(query: FilterQuery): ActivityAction[] | null {
  const sets: ActivityAction[][] = []

  if (query.module !== 'all') {
    sets.push(actionsOfModule(query.module as ActivityModule))
  }
  if (query.category !== 'all') {
    sets.push(actionsOfCategory(query.category as ActivityCategory))
  }
  if (query.severity !== 'all') {
    sets.push(actionsOfSeverity(query.severity as ActivitySeverity))
  }
  if (query.action !== 'all') {
    sets.push([query.action as ActivityAction])
  }

  if (sets.length === 0) {
    // Nothing narrows by action, so the index is left out of it entirely.
    return null
  }

  return sets.reduce((left, right) => left.filter((action) => right.includes(action)))
}

/**
 * Built as a plain object and cast once at the end.
 *
 * Mongoose's `QueryFilter` types each path as its own value *or* a condition
 * on it, which makes assembling one field at a time a fight with the compiler
 * for no safety gained — every value here is produced by this function from a
 * schema-checked query. One cast at the boundary is honest; `any` on the way
 * in would not be.
 */
function buildFilter(query: FilterQuery): QueryFilter<Activity> {
  const filter: Record<string, unknown> = {}

  const actions = actionsFor(query)
  if (actions !== null) {
    filter.action = { $in: actions }
  }

  if (query.entityType !== 'all') {
    filter.entityType = query.entityType
  }

  if (query.entityId) {
    filter.entityId = new Types.ObjectId(query.entityId)
  }

  if (query.actorId) {
    filter.actorId = new Types.ObjectId(query.actorId)
  }

  if (query.vendorId) {
    filter.scopeVendorId = new Types.ObjectId(query.vendorId)
  }

  if (query.from || query.to) {
    const range: Record<string, Date> = {}
    if (query.from) {
      range.$gte = query.from
    }
    if (query.to) {
      /**
       * Widened to the end of the day the client named. Somebody filtering
       * "to the 14th" means the whole of the 14th, and a bare instant would
       * silently drop everything after midnight — which on a journal is most
       * of the day's rows.
       */
      range.$lte = new Date(query.to.getTime() + DAY_MS - 1)
    }
    filter.createdAt = range
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    /**
     * Three fields, and they are the three a person actually searches a
     * journal by: what happened, what it happened to, and who did it. It is an
     * unindexed scan over whatever the other filters have already narrowed to
     * — see the Known gaps entry in CLAUDE.md.
     */
    filter.$or = [{ summary: pattern }, { entityLabel: pattern }, { actorName: pattern }]
  }

  return filter as QueryFilter<Activity>
}

export interface ActivityListTotals {
  total: number
}

export interface ActivityListResult {
  records: ActivityRecord[]
  totals: ActivityListTotals
}

export async function listActivity(query: ListActivityQuery): Promise<ActivityListResult> {
  const filter = buildFilter(query)
  const skip = (query.page - 1) * query.limit

  const [entries, total] = await Promise.all([
    ActivityModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(query.limit),
    ActivityModel.countDocuments(filter),
  ])

  return { records: entries.map(toActivityRecord), totals: { total } }
}

/**
 * The rows behind a download.
 *
 * Refused above the cap with the count rather than silently truncated —
 * nothing in a spreadsheet says its bottom is missing, which is the rule the
 * gate pass and Trip DO exports both follow.
 */
export async function exportActivityRows(query: ExportActivityQuery): Promise<ActivityRecord[]> {
  const filter = buildFilter(query)
  const total = await ActivityModel.countDocuments(filter)

  if (total > MAX_ACTIVITY_EXPORT_ROWS) {
    throw new AppError(
      400,
      `That is ${total.toLocaleString()} rows, and an export carries at most ${MAX_ACTIVITY_EXPORT_ROWS.toLocaleString()}. Narrow the date range or the module and try again.`,
    )
  }

  const entries = await ActivityModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_ACTIVITY_EXPORT_ROWS)

  return entries.map(toActivityRecord)
}

export interface ActivityBreakdown {
  key: string
  label: string
  count: number
}

export interface ActivityActor {
  id: string | null
  name: string
  role: string
  count: number
}

export interface ActivityStats {
  /** Everything matching the filters in force — a total answers the filters. */
  total: number
  today: number
  week: number
  critical: number
  /** Distinct people in the matching set, saturating at `MAX_ACTIVITY_ACTORS`. */
  actors: number
  byModule: ActivityBreakdown[]
  byCategory: ActivityBreakdown[]
  topActors: ActivityActor[]
  /**
   * The last fourteen days, oldest first, with quiet days as zero rows.
   *
   * Each `date` is the **instant** a bucket starts rather than a `YYYY-MM-DD`
   * string, because a bucket is anchored to the viewer's own midnight and only
   * the viewer can name the day that is. A date string formatted here would be
   * the server's UTC day, which for a Dhaka reader is the day before for six
   * hours out of every twenty-four.
   */
  trend: { date: string; count: number }[]
}

interface ActionRow {
  _id: string
  count: number
}

interface ActorRow {
  _id: Types.ObjectId | null
  name: string
  role: string
  count: number
}

/**
 * A trend bucket, keyed by **how many days after `trendStart`** a row fell
 * rather than by a formatted date.
 *
 * `$dateToString` would have to be told a timezone to be right, and the only
 * timezone that matters here is the viewer's — which reaches the server as one
 * instant (their midnight) and not as a zone name. Subtracting and dividing
 * needs neither, and lands every row in exactly the bucket the reader would
 * put it in.
 */
interface DayRow {
  _id: number
  count: number
}

/**
 * The overview, in one request.
 *
 * One aggregation with a `$facet` rather than five counts, for the reason the
 * vendor summary gives: on a sleeping Render instance five round trips are
 * five cold starts stacked behind each other.
 *
 * The three breakdowns all come out of the **same** action grouping. Because
 * module, category and severity are derived from the action, one
 * `$group: { _id: '$action' }` — at most sixty rows — answers "which modules",
 * "what kind of change" and "how many were critical" together, and they can
 * never disagree with each other or with the list.
 */
export async function getActivityStats(query: ActivityStatsQuery): Promise<ActivityStats> {
  const filter = buildFilter(query)

  /**
   * The viewer's own midnight, sent as an instant. A journal row is a moment
   * rather than a calendar day, so "today" has to be anchored to the reader's
   * day — the server's UTC midnight is six hours out of step with Dhaka's.
   */
  const dayStart = query.today ?? startOfLocalDay(new Date())
  const weekStart = new Date(dayStart.getTime() - 6 * DAY_MS)
  const trendStart = new Date(dayStart.getTime() - (TREND_DAYS - 1) * DAY_MS)

  const [facets] = await ActivityModel.aggregate<{
    actions: ActionRow[]
    actors: ActorRow[]
    today: { count: number }[]
    week: { count: number }[]
    trend: DayRow[]
  }>([
    { $match: filter },
    {
      $facet: {
        actions: [{ $group: { _id: '$action', count: { $sum: 1 } } }],
        actors: [
          {
            $group: {
              _id: '$actorId',
              name: { $first: '$actorName' },
              role: { $first: '$actorRole' },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: MAX_ACTIVITY_ACTORS },
        ],
        today: [{ $match: { createdAt: { $gte: dayStart } } }, { $count: 'count' }],
        week: [{ $match: { createdAt: { $gte: weekStart } } }, { $count: 'count' }],
        trend: [
          { $match: { createdAt: { $gte: trendStart } } },
          {
            $group: {
              _id: {
                $floor: {
                  $divide: [{ $subtract: ['$createdAt', trendStart] }, DAY_MS],
                },
              },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ])

  const actions = facets?.actions ?? []
  const actors = facets?.actors ?? []

  const moduleCounts = new Map<string, number>()
  const categoryCounts = new Map<string, number>()
  let total = 0
  let critical = 0

  for (const row of actions) {
    const meta = actionMeta(row._id)
    total += row.count
    moduleCounts.set(meta.module, (moduleCounts.get(meta.module) ?? 0) + row.count)
    categoryCounts.set(meta.category, (categoryCounts.get(meta.category) ?? 0) + row.count)
    if (meta.severity === 'critical') {
      critical += row.count
    }
  }

  return {
    total,
    today: facets?.today[0]?.count ?? 0,
    week: facets?.week[0]?.count ?? 0,
    critical,
    actors: actors.length,
    byModule: [...moduleCounts.entries()]
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((left, right) => right.count - left.count),
    byCategory: [...categoryCounts.entries()]
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((left, right) => right.count - left.count),
    topActors: actors.map((actor) => ({
      id: actor._id ? String(actor._id) : null,
      name: actor.name,
      role: actor.role,
      count: actor.count,
    })),
    trend: fillTrend(facets?.trend ?? [], trendStart),
  }
}

/** Local midnight for a given instant — the fallback when no `today` is sent. */
function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

/**
 * The trend, with quiet days drawn as zero rather than left out.
 *
 * The same rule `fillMonthSeries` follows on the vendor dashboard: dropping an
 * empty day slides every column along and silently re-labels the rest, so a
 * fortnight with three quiet days would read as a fortnight that was eleven
 * days long.
 */
function fillTrend(rows: DayRow[], start: Date): { date: string; count: number }[] {
  const counts = new Map(rows.map((row) => [row._id, row.count]))
  const series: { date: string; count: number }[] = []

  for (let offset = 0; offset < TREND_DAYS; offset += 1) {
    series.push({
      date: new Date(start.getTime() + offset * DAY_MS).toISOString(),
      count: counts.get(offset) ?? 0,
    })
  }

  return series
}

/**
 * The people the actor filter offers.
 *
 * Read off the journal itself rather than out of the user collection, which is
 * the only honest source: an account deleted last month still has a trail, and
 * offering only current accounts would hide exactly the rows somebody is most
 * likely looking for. The name and role come back as the row's own copies, so
 * a deleted actor is named as they were.
 */
export async function listActivityActors(): Promise<ActivityActor[]> {
  const rows = await ActivityModel.aggregate<ActorRow>([
    { $match: { actorId: { $ne: null } } },
    {
      $group: {
        _id: '$actorId',
        name: { $last: '$actorName' },
        role: { $last: '$actorRole' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: MAX_ACTIVITY_ACTORS },
  ])

  return rows.map((row) => ({
    id: row._id ? String(row._id) : null,
    name: row.name,
    role: row.role,
    count: row.count,
  }))
}

/**
 * One vendor's journal, newest first.
 *
 * The read `GET /vendors/:id/activity` has always served, now answered from
 * the central collection. It stays in this module rather than in Vendor
 * because the collection is one journal, and a second reader of it would be a
 * second place to get "what does a row mean" wrong.
 */
export async function listVendorActivity(
  vendorId: string,
  limit: number,
): Promise<ActivityRecord[]> {
  const entries = await ActivityModel.find({ scopeVendorId: new Types.ObjectId(vendorId) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)

  return entries.map(toActivityRecord)
}

/**
 * Every action the journal recognises, with what each one means.
 *
 * Served rather than mirrored blind, so the client's action filter offers the
 * vocabulary this deployment actually writes. The client still mirrors the
 * modules and categories — those name UI colours and icons — but the sixty
 * action strings behind them are data, and data is better fetched than
 * hand-copied.
 */
export function describeActivityVocabulary(): {
  action: string
  label: string
  module: string
  category: string
  severity: string
}[] {
  return ACTIVITY_ACTIONS.map((action) => ({
    action,
    label: ACTION_META[action].label,
    module: ACTION_META[action].module,
    category: ACTION_META[action].category,
    severity: ACTION_META[action].severity,
  }))
}
