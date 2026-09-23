import type { Types } from 'mongoose'
import { recordActivity as appendActivity } from '../activity/activity.recorder'
import { listVendorActivity } from '../activity/activity.service'
import type { ActivityRecord } from '../activity/activity.serializer'
import type { UserDocument } from '../user/user.model'
import { MAX_ACTIVITY_ENTRIES } from './vendor.constants'
import type { ActivityAction, ActivityEntityType } from './vendor.constants'

/**
 * The vendor module's way into the application's journal.
 *
 * This file used to own a collection. CLAUDE.md described it as "the minimum
 * audit integration, not an audit system" — one append-only collection scoped
 * to a vendor, written by this module and read by its own endpoint — and said
 * outright that it was kept "so that module inherits a complete history" when
 * an Activity module arrived. It has, and this is the inheritance: the rows
 * live in the central journal now, the legacy ones folded in under their own
 * ids by `activity.migration.ts`, and what is left here is a **seam**.
 *
 * It stays a seam rather than becoming twenty-six imports of the central
 * recorder, for two reasons. Every call site in this module and in Delivery
 * passes a `vendorId`, which is this module's scope and nobody else's; and
 * keeping one door means the vendor actions cannot start being written without
 * it. Nothing else changed — the twenty-six callers are untouched, and
 * `recordActivity` still never throws.
 */

export interface ActivityInput {
  vendorId: Types.ObjectId | string
  action: ActivityAction
  entityType: ActivityEntityType
  entityId?: Types.ObjectId | string | null
  /** A copy, not a reference — the row still has to read after a deletion. */
  entityLabel?: string
  summary: string
  actor: UserDocument
}

/**
 * Appends one entry, and **never throws** — the contract the central recorder
 * carries, restated here because every caller in this module depends on it.
 */
export async function recordActivity(input: ActivityInput): Promise<void> {
  await appendActivity({
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    entityLabel: input.entityLabel ?? '',
    summary: input.summary,
    vendorId: input.vendorId,
    actor: input.actor,
  })
}

/**
 * The newest entries for one vendor.
 *
 * No actor lookup any more: the journal stores each actor's name and role as
 * copies, so a page of rows costs one query rather than two — and a row
 * written by somebody whose account has since been deleted still says who did
 * it, which the old `$in` over the user collection could not.
 */
export async function listActivity(vendorId: string, limit: number): Promise<ActivityRecord[]> {
  return listVendorActivity(vendorId, Math.min(limit, MAX_ACTIVITY_ENTRIES))
}
