import type { Types } from 'mongoose'
import { recordActivity as appendActivity } from '../activity/activity.recorder'
import type { UserDocument } from '../user/user.model'
import type { ActivityAction, ActivityEntityType } from './vendor.constants'

/**
 * The vendor module's way into the application's journal.
 *
 * This file used to own a collection, and then — briefly — both halves of a
 * journal: the write that fed the central Activity module and a read that
 * served an Activity tab on the vendor workspace. The tab is gone, because the
 * business asked for it off: a vendor page is for the fleet, the drivers, the
 * documents and the trips, and "what was done to this vendor" is a question the
 * Activity Logs module answers for every module at once rather than one the
 * vendor page should answer a second time.
 *
 * So what is left is a **write seam and nothing else**. Every vendor and trip
 * event is still journalled, exactly as before — removing a tab is not a reason
 * to stop recording what happened, and `/activity` is where those rows are read,
 * filtered by this module like any other.
 *
 * It stays a seam rather than becoming twenty-six imports of the central
 * recorder, for two reasons. Every call site in this module and in Delivery
 * passes a `vendorId`, which is this module's scope and nobody else's; and
 * keeping one door means the vendor actions cannot start being written without
 * it. `recordActivity` still never throws.
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
