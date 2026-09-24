import { Types } from 'mongoose'
import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { mutedCategoriesOf } from './notification.audience'
import {
  MUTABLE_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  PANEL_NOTIFICATION_LIMIT,
  eventsOfCategory,
  eventsOfModule,
  eventsOfPriority,
  notificationEventMeta,
} from './notification.constants'
import type {
  NotificationCategory,
  NotificationEvent,
  NotificationModule,
  NotificationPriority,
} from './notification.constants'
import { NotificationModel } from './notification.model'
import type { Notification } from './notification.model'
import { NotificationPreferenceModel } from './notification-preference.model'
import { toNotificationRecord } from './notification.serializer'
import type { NotificationRecord } from './notification.serializer'
import type {
  ListNotificationsQuery,
  MarkAllReadInput,
  UpdatePreferencesInput,
} from './notification.validation'

/**
 * Reading and clearing one person's messages.
 *
 * **Every function here takes the authenticated `UserDocument` and none takes
 * an id.** That is the Profile module's arrangement, and it is the whole of
 * this module's access control: ownership is enforced by the shape of the
 * service rather than by a check inside it, so there is no path — not even a
 * mistaken one — by which a request could reach somebody else's inbox.
 *
 * Nothing here writes a *message*. Rows are appended by services through
 * `notify`; what a request may change is the read state of a row addressed to
 * it, and whether it wants to hear about a category at all.
 */

/** User input reaches a regex, so metacharacters must lose their meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type FilterQuery = Pick<
  ListNotificationsQuery,
  'state' | 'module' | 'category' | 'priority' | 'event' | 'search'
>

/**
 * The events a query is asking about.
 *
 * Module, category and priority are derived from the event rather than stored
 * beside it, so all three narrow the same way: each contributes a set of
 * events, and the query is their **intersection**. `Vendor` + `urgent` is the
 * one expired-document event and nothing else, which is the honest reading of
 * two filters applied together.
 *
 * Returning an empty array is meaningful — it says the combination matches
 * nothing, and the caller turns that into an empty page rather than an
 * unfiltered one. That distinction is why this is a function rather than four
 * `if`s inside `buildFilter`. It is the arrangement `actionsFor` has in the
 * journal, and the two are deliberately alike.
 */
function eventsFor(query: FilterQuery): NotificationEvent[] | null {
  const sets: NotificationEvent[][] = []

  if (query.module !== 'all') {
    sets.push(eventsOfModule(query.module as NotificationModule))
  }
  if (query.category !== 'all') {
    sets.push(eventsOfCategory(query.category as NotificationCategory))
  }
  if (query.priority !== 'all') {
    sets.push(eventsOfPriority(query.priority as NotificationPriority))
  }
  if (query.event !== 'all') {
    sets.push([query.event as NotificationEvent])
  }

  if (sets.length === 0) {
    // Nothing narrows by event, so the index is left out of it entirely.
    return null
  }

  return sets.reduce((left, right) => left.filter((event) => right.includes(event)))
}

/**
 * Built as a plain object and cast once at the end — the arrangement
 * `buildFilter` has in the journal, and for the stated reason: Mongoose types
 * each path as its own value *or* a condition on it, which makes assembling one
 * field at a time a fight with the compiler for no safety gained. Every value
 * here is produced by this function from a schema-checked query.
 */
function buildFilter(recipientId: Types.ObjectId, query: FilterQuery): QueryFilter<Notification> {
  const filter: Record<string, unknown> = { recipientId }

  if (query.state === 'unread') {
    filter.readAt = null
  } else if (query.state === 'read') {
    filter.readAt = { $ne: null }
  }

  const events = eventsFor(query)
  if (events !== null) {
    filter.event = { $in: events }
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    /**
     * Three fields, and they are the three somebody searches a message list
     * by: what it says, what it says underneath, and what record it was about.
     * An unindexed scan over whatever the other filters have narrowed to —
     * which on one person's ninety days of messages is a small set by
     * construction, unlike the journal, where the same pattern is a stated gap.
     */
    filter.$or = [{ title: pattern }, { body: pattern }, { entityLabel: pattern }]
  }

  return filter as QueryFilter<Notification>
}

export interface NotificationListResult {
  records: NotificationRecord[]
  total: number
  /** Unread across the whole inbox, not within the filter — see below. */
  unread: number
}

/**
 * One page of one person's messages.
 *
 * The unread figure travels with the list and is deliberately **not** scoped to
 * the filters, which is the one place this module departs from "a total answers
 * the filters, not the page". It is the badge's figure: it says how much is
 * waiting *anywhere*, and somebody who has filtered to Vendor compliance still
 * needs the header to say that four other things arrived. `total` is the
 * filtered count, so the list's own paging stays honest.
 */
export async function listNotifications(
  actor: UserDocument,
  query: ListNotificationsQuery,
): Promise<NotificationListResult> {
  const recipientId = actor._id as Types.ObjectId
  const filter = buildFilter(recipientId, query)

  const [rows, total, unread] = await Promise.all([
    NotificationModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    NotificationModel.countDocuments(filter),
    NotificationModel.countDocuments({ recipientId, readAt: null }),
  ])

  return { records: rows.map(toNotificationRecord), total, unread }
}

export interface NotificationSummary {
  unread: number
  /** Unread per category, so the panel can say *what* is waiting. */
  byCategory: Record<NotificationCategory, number>
  /** Unread at each priority — what the badge's colour is decided from. */
  byPriority: Record<NotificationPriority, number>
  /** The newest message, read or not, so a client can tell "nothing new" apart. */
  latestAt: string | null
  /** A short list for the header panel, newest first. */
  recent: NotificationRecord[]
}

/**
 * Everything the header needs, in one request.
 *
 * One call rather than four, for the reason the vendor summary gives: on a
 * sleeping Render instance four round trips are four cold starts stacked behind
 * each other, and this is the request that runs on **every page load** and then
 * on a timer. It is the most-called endpoint in the application, so it is
 * written as one aggregation over one partial index plus one small find.
 *
 * **There is no push, and that is a deliberate free-tier decision rather than a
 * shortcut.** A websocket needs a process that stays up; Render's free tier
 * spins this one down after fifteen minutes of inactivity, and a socket that
 * silently dies with the instance is worse than no socket, because the badge
 * would confidently read zero. So the client polls this — cheaply, on a visible
 * tab only — and the panel is honest about being a poll by refetching when
 * somebody opens it.
 */
export async function getNotificationSummary(
  actor: UserDocument,
): Promise<NotificationSummary> {
  const recipientId = actor._id as Types.ObjectId

  const [groups, latest, recent] = await Promise.all([
    /**
     * Grouped by event, and the category and priority breakdowns are folded
     * out of the *same* grouping in memory — so "how many unread" and "how many
     * unread compliance" can never disagree with each other, which is exactly
     * how a badge and the panel under it come to tell different stories.
     */
    NotificationModel.aggregate<{ _id: string; count: number }>([
      { $match: { recipientId, readAt: null } },
      { $group: { _id: '$event', count: { $sum: 1 } } },
    ]),
    NotificationModel.findOne({ recipientId }).sort({ createdAt: -1 }).select('createdAt').lean(),
    NotificationModel.find({ recipientId }).sort({ createdAt: -1 }).limit(PANEL_NOTIFICATION_LIMIT),
  ])

  const byCategory = Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, 0]),
  ) as Record<NotificationCategory, number>

  const byPriority: Record<NotificationPriority, number> = {
    info: 0,
    attention: 0,
    urgent: 0,
  }

  let unread = 0

  for (const group of groups) {
    const meta = notificationEventMeta(group._id)
    unread += group.count
    byCategory[meta.category] += group.count
    byPriority[meta.priority] += group.count
  }

  return {
    unread,
    byCategory,
    byPriority,
    latestAt: latest?.createdAt ? new Date(latest.createdAt).toISOString() : null,
    recent: recent.map(toNotificationRecord),
  }
}

/**
 * Marking one message read, or putting it back unread.
 *
 * Scoped by `recipientId` **in the query itself** rather than by loading the
 * row and checking it. A `findOne` followed by a comparison is one forgotten
 * `if` away from letting anybody mark anybody's message read; a filter that
 * names the owner cannot be forgotten, and the 404 it produces for somebody
 * else's id is also the right answer — a message not addressed to you does not
 * exist as far as you are concerned.
 */
export async function setNotificationRead(
  actor: UserDocument,
  id: string,
  read: boolean,
): Promise<NotificationRecord> {
  const updated = await NotificationModel.findOneAndUpdate(
    { _id: new Types.ObjectId(id), recipientId: actor._id },
    { $set: { readAt: read ? new Date() : null } },
    { new: true },
  )

  if (!updated) {
    throw new AppError(404, 'That notification does not exist.')
  }

  return toNotificationRecord(updated)
}

/**
 * Marking everything read, up to what the reader has actually seen.
 *
 * `before` is what makes the button safe on a list somebody is looking at: a
 * message that arrived between the page rendering and the press would otherwise
 * be marked read unseen, which is the one way a notification system can lose
 * something. The client sends the newest timestamp it has drawn; without it,
 * this clears the lot, which is what the panel's own "mark all read" means.
 */
export async function markAllNotificationsRead(
  actor: UserDocument,
  input: MarkAllReadInput,
): Promise<{ updated: number }> {
  const filter: Record<string, unknown> = { recipientId: actor._id, readAt: null }

  if (input.before) {
    filter.createdAt = { $lte: input.before }
  }

  const result = await NotificationModel.updateMany(filter, { $set: { readAt: new Date() } })

  return { updated: result.modifiedCount }
}

/**
 * Dismissing one message.
 *
 * A real delete rather than an archive flag, and this is the line between the
 * two collections. The journal may never be deleted, because it is the audit
 * record; a notification is a *message to one person*, everything it announced
 * is already in the journal, and a message somebody has dealt with and cannot
 * clear is a message that teaches them to ignore the next one.
 */
export async function dismissNotification(
  actor: UserDocument,
  id: string,
): Promise<{ id: string }> {
  const removed = await NotificationModel.findOneAndDelete({
    _id: new Types.ObjectId(id),
    recipientId: actor._id,
  })

  if (!removed) {
    throw new AppError(404, 'That notification does not exist.')
  }

  return { id: String(removed._id) }
}

/**
 * Clearing what has been read.
 *
 * Only the read ones, deliberately: "clear all" on an inbox with unread
 * messages in it is a button that throws away the thing somebody came to the
 * page for. Unread rows are dismissed one at a time, where the decision is
 * visible.
 */
export async function clearReadNotifications(
  actor: UserDocument,
): Promise<{ removed: number }> {
  const result = await NotificationModel.deleteMany({
    recipientId: actor._id,
    readAt: { $ne: null },
  })

  return { removed: result.deletedCount ?? 0 }
}

export interface NotificationPreferences {
  mutedCategories: NotificationCategory[]
  /** What may be muted at all, so the form is built from the server's answer. */
  mutable: NotificationCategory[]
}

export async function getNotificationPreferences(
  actor: UserDocument,
): Promise<NotificationPreferences> {
  return {
    mutedCategories: await mutedCategoriesOf(actor._id as Types.ObjectId),
    mutable: [...MUTABLE_CATEGORIES],
  }
}

/**
 * Replacing the muted list wholesale.
 *
 * A whole-list replace rather than a toggle per category — the shape
 * `PATCH /challan-batches/:id/skipped-pages` takes, and for the same reason: it
 * is idempotent, and undoing is the same call with one value removed. An upsert,
 * because the absence of a document *is* the default and there is nothing to
 * create until somebody has an opinion.
 */
export async function updateNotificationPreferences(
  actor: UserDocument,
  input: UpdatePreferencesInput,
): Promise<NotificationPreferences> {
  const muted = [...new Set(input.mutedCategories)].filter((category) =>
    (MUTABLE_CATEGORIES as readonly string[]).includes(category),
  )

  await NotificationPreferenceModel.findOneAndUpdate(
    { userId: actor._id },
    { $set: { mutedCategories: muted } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  return {
    mutedCategories: muted as NotificationCategory[],
    mutable: [...MUTABLE_CATEGORIES],
  }
}

/**
 * The filter dropdown's contents: every event this deployment can announce,
 * with its label and its derived meta.
 *
 * Served rather than mirrored, for the reason `GET /activity/filters` serves
 * the action list: a hand-copied vocabulary is one chance per value to drift,
 * and the one thing a filter must not do is quietly match nothing.
 */
export function describeNotificationVocabulary(): {
  event: NotificationEvent
  label: string
  module: NotificationModule
  category: NotificationCategory
  priority: NotificationPriority
}[] {
  return NOTIFICATION_EVENTS.map((event) => {
    const meta = notificationEventMeta(event)
    return {
      event,
      label: meta.label,
      module: meta.module,
      category: meta.category,
      priority: meta.priority,
    }
  })
}
