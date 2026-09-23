import { actionMeta } from './activity.constants'
import type {
  ActivityAction,
  ActivityCategory,
  ActivityEntityType,
  ActivityModule,
  ActivitySeverity,
} from './activity.constants'
import type { ActivityChange } from './activity.diff'
import type { ActivityDocument } from './activity.model'

/**
 * A journal row as the client reads it.
 *
 * `module`, `category` and `severity` are **derived here** rather than stored,
 * so reclassifying an action is a change to one map instead of a migration
 * over a year of rows. `actor` is read off the row's own copies rather than
 * resolved, which is what lets a deleted account keep its history and what
 * makes this the only list in the app that needs no actor lookup at all.
 */
export interface ActivityRecord {
  id: string
  action: ActivityAction
  module: ActivityModule
  category: ActivityCategory
  severity: ActivitySeverity
  /** A short verb phrase for the action, where the summary is too long. */
  actionLabel: string

  entityType: ActivityEntityType
  entityId: string | null
  entityLabel: string

  summary: string
  changes: ActivityChange[]

  actor: { id: string | null; name: string; role: string } | null
  vendorId: string | null
  createdAt: string
}

export function toActivityRecord(entry: ActivityDocument): ActivityRecord {
  const meta = actionMeta(entry.action)

  return {
    id: String(entry._id),
    action: entry.action as ActivityAction,
    module: meta.module,
    category: meta.category,
    severity: meta.severity,
    actionLabel: meta.label,

    entityType: entry.entityType as ActivityEntityType,
    entityId: entry.entityId ? String(entry.entityId) : null,
    entityLabel: entry.entityLabel,

    summary: entry.summary,
    /**
     * `?? null` rather than passed through: Mongoose types a defaulted path as
     * optional, and an absent `from` and a null one mean the same thing to a
     * reader — the value was not there. The distinction the diff actually
     * keeps is null against the empty string, and that survives this.
     */
    changes: entry.changes.map((change) => ({
      field: change.field,
      label: change.label,
      from: change.from ?? null,
      to: change.to ?? null,
    })),

    /**
     * Null only for a row nothing recorded an actor for — the legacy journal
     * allowed it, and a row written by a migration has no person behind it.
     * "System" is deliberately not invented here: the client decides how to
     * draw an absent actor, and a made-up name in a journal is the one thing
     * this collection must never contain.
     */
    actor:
      entry.actorId || entry.actorName
        ? {
            id: entry.actorId ? String(entry.actorId) : null,
            name: entry.actorName,
            role: entry.actorRole,
          }
        : null,

    vendorId: entry.scopeVendorId ? String(entry.scopeVendorId) : null,
    createdAt: entry.createdAt.toISOString(),
  }
}
