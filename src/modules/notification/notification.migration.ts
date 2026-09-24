import mongoose from 'mongoose'
import { UserModel } from '../user/user.model'
import { NOTIFICATION_RETENTION_DAYS } from './notification.constants'
import { NotificationModel } from './notification.model'

/**
 * Boot-time upkeep for the notification collection. **Never throws** — a
 * migration that takes the API down is worse than whatever it was correcting,
 * the posture every seeder and migration in this codebase takes.
 */

const TTL_INDEX = 'notification_ttl'

/**
 * Keeps the TTL index saying what `NOTIFICATION_RETENTION_DAYS` says.
 *
 * MongoDB will not change an existing TTL index's expiry when the schema asks
 * for a different one — it silently keeps the old value — so editing that
 * constant would otherwise do nothing at all on a database that already has the
 * index. The same trap `syncActivityIndexes` and `syncDeliveryIndexes` exist
 * for, and the same answer: read what is there, and rebuild it when it
 * disagrees.
 *
 * Retention of 0 means "keep everything", and drops the index.
 */
export async function syncNotificationIndexes(): Promise<void> {
  try {
    const collection = mongoose.connection.collection(NotificationModel.collection.name)
    const indexes = (await collection.indexes()) as {
      name?: string
      expireAfterSeconds?: number
    }[]

    const existing = indexes.find((index) => index.name === TTL_INDEX)
    const wanted =
      NOTIFICATION_RETENTION_DAYS > 0 ? NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 : null

    if (wanted === null) {
      if (existing) {
        await collection.dropIndex(TTL_INDEX)
        console.log('[notification] retention is off — TTL index dropped')
      }
      return
    }

    if (!existing) {
      // Mongoose's own index build will create it; nothing to correct.
      return
    }

    if (existing.expireAfterSeconds !== wanted) {
      await collection.dropIndex(TTL_INDEX)
      await collection.createIndex(
        { createdAt: 1 },
        { name: TTL_INDEX, expireAfterSeconds: wanted },
      )
      console.log(`[notification] TTL index rebuilt at ${NOTIFICATION_RETENTION_DAYS} days`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[notification] index sync skipped: ${message}`)
  }
}

/**
 * Deletes messages addressed to accounts that no longer exist.
 *
 * Deleting a user removes the Firebase identity and the profile — CLAUDE.md is
 * explicit about that order — and nothing has ever looked at this collection on
 * the way past. The rows are unreachable the moment the account is gone (every
 * query in the module is scoped to a live caller), so this is housekeeping
 * rather than a correctness fix: on a 512 MB shared cluster, the one collection
 * that writes a row *per person* should not keep rows for people.
 *
 * Bounded and idempotent. It reads the ids it is about to keep rather than the
 * ones to drop, because there are always fewer accounts than notifications.
 */
export async function purgeOrphanedNotifications(): Promise<void> {
  try {
    const recipients = await NotificationModel.distinct('recipientId')
    if (recipients.length === 0) {
      return
    }

    const live = await UserModel.find({ _id: { $in: recipients } })
      .select('_id')
      .lean()

    const liveIds = new Set(live.map((user) => String(user._id)))
    const orphaned = recipients.filter((id) => !liveIds.has(String(id)))

    if (orphaned.length === 0) {
      return
    }

    const result = await NotificationModel.deleteMany({ recipientId: { $in: orphaned } })

    if ((result.deletedCount ?? 0) > 0) {
      console.log(
        `[notification] removed ${result.deletedCount} messages for ${orphaned.length} deleted accounts`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[notification] orphan purge skipped: ${message}`)
  }
}
