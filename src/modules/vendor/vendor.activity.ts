import type { Types } from 'mongoose'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import { MAX_ACTIVITY_ENTRIES } from './vendor.constants'
import type { ActivityAction } from './vendor.constants'
import { VendorActivityModel } from './vendor-activity.model'
import { toActivityRecord } from './vendor.serializer'
import type { ActivityRecord } from './vendor.serializer'

/**
 * Writing and reading the vendor activity log.
 *
 * CLAUDE.md records that this system has no audit module — the user document
 * keeps provenance rather than a log — so this is deliberately the minimum
 * that gives the Vendor module its Activity tab without inventing a general
 * audit system for the whole application.
 */

export interface ActivityInput {
  vendorId: Types.ObjectId | string
  action: ActivityAction
  entityType: 'Vendor' | 'Vehicle' | 'Driver' | 'Assignment' | 'Document'
  entityId?: Types.ObjectId | string | null
  /** A copy, not a reference — the row still has to read after a deletion. */
  entityLabel?: string
  summary: string
  actor: UserDocument
}

/**
 * Appends one entry, and **never throws**.
 *
 * That is the whole contract. A failure to log must not fail the write it was
 * logging, because the write is the thing that mattered — a vehicle that was
 * added and not journalled is a gap in a list, and a vehicle that was refused
 * because the journal was down is an operator who cannot work. Nothing in this
 * module branches on an activity row, so the asymmetry is safe.
 */
export async function recordActivity(input: ActivityInput): Promise<void> {
  try {
    await VendorActivityModel.create({
      vendorId: input.vendorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityLabel: (input.entityLabel ?? '').slice(0, 160),
      summary: input.summary.slice(0, 300),
      actorId: input.actor._id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[vendor] activity entry not recorded: ${message}`)
  }
}

/**
 * The newest entries for one vendor.
 *
 * Actor names are resolved in a single indexed lookup rather than populated row
 * by row — the same treatment administration gives its list, and on M0 the
 * difference between one `$in` and twenty lookups is worth the plumbing.
 */
export async function listActivity(
  vendorId: string,
  limit: number,
): Promise<ActivityRecord[]> {
  const entries = await VendorActivityModel.find({ vendorId })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, MAX_ACTIVITY_ENTRIES))

  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.actorId) {
      ids.add(String(entry.actorId))
    }
  }

  const names =
    ids.size === 0
      ? new Map<string, string>()
      : new Map(
          (await UserModel.find({ _id: { $in: [...ids] } }).select('name')).map((actor) => [
            String(actor._id),
            actor.name,
          ]),
        )

  return entries.map((entry) => toActivityRecord(entry, names))
}

/** Removing a vendor takes its journal with it — nothing else ever reads it. */
export async function purgeActivity(vendorId: string): Promise<void> {
  try {
    await VendorActivityModel.deleteMany({ vendorId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[vendor] activity purge failed for ${vendorId}: ${message}`)
  }
}
