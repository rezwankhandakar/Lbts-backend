import { notificationEventMeta } from './notification.constants'
import type {
  NotificationCategory,
  NotificationEntityType,
  NotificationEvent,
  NotificationModule,
  NotificationPriority,
} from './notification.constants'
import type { NotificationDocument } from './notification.model'

/**
 * A message as the client reads it.
 *
 * `module`, `category` and `priority` are **derived here** rather than stored,
 * so reclassifying an event is a change to one map instead of a migration over
 * a collection. `actor` is read off the row's own copies rather than resolved,
 * which is what lets a deleted account keep its sentence and what makes this,
 * like the journal, a list that needs no second lookup to render.
 *
 * There is deliberately **no `link`**. Where a record lives is a fact about the
 * client's router, so the path is derived in the browser from `entityType` and
 * `entityId` — the arrangement `recordPath` has in the activity feature. A URL
 * stored in June is a URL that silently breaks when a route is renamed in
 * September, in every row at once.
 */
export interface NotificationRecord {
  id: string
  event: NotificationEvent
  module: NotificationModule
  category: NotificationCategory
  priority: NotificationPriority
  /** A short noun phrase for the event, drawn as the row's kicker. */
  eventLabel: string

  title: string
  body: string

  entityType: NotificationEntityType | null
  entityId: string | null
  entityLabel: string

  actor: { id: string | null; name: string; role: string } | null

  /** Null is unread. The client draws the distinction; it never invents it. */
  readAt: string | null
  createdAt: string
}

export function toNotificationRecord(entry: NotificationDocument): NotificationRecord {
  const meta = notificationEventMeta(entry.event)

  return {
    id: String(entry._id),
    event: entry.event as NotificationEvent,
    module: meta.module,
    category: meta.category,
    priority: meta.priority,
    eventLabel: meta.label,

    title: entry.title,
    body: entry.body ?? '',

    entityType: (entry.entityType as NotificationEntityType | null) ?? null,
    entityId: entry.entityId ? String(entry.entityId) : null,
    entityLabel: entry.entityLabel ?? '',

    /**
     * Null for a message nobody caused — the compliance sweep's rows. "System"
     * is deliberately not invented here: the client decides how to draw an
     * absent actor, and a made-up name beside a message somebody acts on is
     * the one thing this collection must not contain.
     */
    actor:
      entry.actorId || entry.actorName
        ? {
            id: entry.actorId ? String(entry.actorId) : null,
            name: entry.actorName ?? '',
            role: entry.actorRole ?? '',
          }
        : null,

    readAt: entry.readAt ? entry.readAt.toISOString() : null,
    createdAt: entry.createdAt.toISOString(),
  }
}
