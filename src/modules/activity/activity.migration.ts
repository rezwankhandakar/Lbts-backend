import mongoose from 'mongoose'
import { UserModel } from '../user/user.model'
import { VendorActivityModel } from '../vendor/vendor-activity.model'
import { ACTIVITY_RETENTION_DAYS } from './activity.constants'
import { ActivityModel } from './activity.model'

/**
 * Bringing the journal that already existed into the one that presents it.
 *
 * CLAUDE.md described `VendorActivity` as "the minimum audit integration, not
 * an audit system", kept and written to precisely so that "that module
 * inherits a complete history" when it arrived. This is that inheritance.
 *
 * Everything here **never throws**. A migration that takes the API down on
 * boot is worse than the history it was moving, which is the posture
 * `seedLocationMaster` and `purgeLegacyDeliveries` both take.
 */

const BATCH_SIZE = 500
const TTL_INDEX = 'activity_ttl'
const DUPLICATE_KEY = 11000

/**
 * Whether a failed batch failed *only* because rows were already folded.
 *
 * That is the expected outcome of every boot after the first, and it has two
 * shapes depending on the driver's mood: a bare `code: 11000`, or a bulk write
 * error carrying a `writeErrors` array. Matching one and not the other would
 * turn an ordinary second boot into an aborted fold, so both are read — and
 * anything with a non-duplicate error among them is still raised, because a
 * validation failure in the middle of a migration is a real thing to know.
 */
function isDuplicateKeyOnly(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const { code, writeErrors } = error as {
    code?: number
    writeErrors?: { err?: { code?: number }; code?: number }[]
  }

  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    return writeErrors.every((entry) => (entry.err?.code ?? entry.code) === DUPLICATE_KEY)
  }

  return code === DUPLICATE_KEY
}

/**
 * Folds every legacy vendor activity row into the central journal.
 *
 * **Idempotent by construction**: each new row reuses the legacy row's own
 * `_id`, so a second run is a batch of duplicate-key errors and nothing else.
 * That is why `ordered: false` is right — one already-folded row must not stop
 * the rest of the batch, and there is no state to keep beyond the ids
 * themselves. No marker collection, no high-water mark, nothing to get wrong.
 *
 * The legacy collection is **left in place**. It is the only copy of these
 * rows that predates this module, it is small, and dropping a year of audit
 * history to save a few hundred kilobytes is not a trade a migration gets to
 * make on its own.
 */
export async function foldLegacyVendorActivity(): Promise<void> {
  try {
    const legacyCount = await VendorActivityModel.estimatedDocumentCount()
    if (legacyCount === 0) {
      return
    }

    let folded = 0
    let skip = 0

    for (;;) {
      const batch = await VendorActivityModel.find({})
        .sort({ _id: 1 })
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean()

      if (batch.length === 0) {
        break
      }

      /**
       * The legacy row stored only an actor id, because it resolved names at
       * read time. The central journal keeps the name and role as copies, so
       * they are resolved once here — in one indexed `$in` per batch, the same
       * treatment `resolveActorNames` gives the administration list.
       *
       * The role is necessarily *today's* role rather than the one held at the
       * time: the legacy row never recorded it, and inventing one would be
       * worse than carrying the only one that is actually known. Rows written
       * from here on record it at the moment of the action.
       */
      const actorIds = [...new Set(batch.filter((row) => row.actorId).map((row) => String(row.actorId)))]
      const actors = new Map(
        (
          await UserModel.find({ _id: { $in: actorIds } }).select('name role')
        ).map((actor) => [String(actor._id), { name: actor.name, role: actor.role }]),
      )

      const documents = batch.map((row) => {
        const actor = row.actorId ? actors.get(String(row.actorId)) : undefined
        return {
          _id: row._id,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId ?? null,
          entityLabel: row.entityLabel ?? '',
          summary: row.summary,
          changes: [],
          actorId: row.actorId ?? null,
          actorName: actor?.name ?? '',
          actorRole: actor?.role ?? '',
          scopeVendorId: row.vendorId ?? null,
          createdAt: row.createdAt,
        }
      })

      try {
        const inserted = await ActivityModel.insertMany(documents, {
          ordered: false,
          /**
           * The legacy `createdAt` is the whole value of the row, so Mongoose
           * is told to leave timestamps alone rather than trusted to notice
           * one is already set. A fold that re-dated a year of history to the
           * morning of the deploy would be worse than no fold at all.
           */
          timestamps: false,
        })
        folded += inserted.length
      } catch (error) {
        if (!isDuplicateKeyOnly(error)) {
          throw error
        }
      }

      skip += batch.length
    }

    if (folded > 0) {
      console.log(`[activity] folded ${folded} legacy vendor activity rows into the journal`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[activity] legacy fold skipped: ${message}`)
  }
}

/**
 * Keeps the TTL index saying what `ACTIVITY_RETENTION_DAYS` says.
 *
 * MongoDB will not change an existing TTL index's expiry when the schema asks
 * for a different one — it silently keeps the old value — so editing that
 * constant would otherwise do nothing at all on a database that already has
 * the index. The same trap `syncDeliveryIndexes` exists for, and the same
 * answer: read what is there, and rebuild it when it disagrees.
 *
 * Retention of 0 means "keep everything", and drops the index.
 */
export async function syncActivityIndexes(): Promise<void> {
  try {
    const collection = mongoose.connection.collection(ActivityModel.collection.name)
    const indexes = (await collection.indexes()) as {
      name?: string
      expireAfterSeconds?: number
    }[]

    const existing = indexes.find((index) => index.name === TTL_INDEX)
    const wanted = ACTIVITY_RETENTION_DAYS > 0 ? ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 : null

    if (wanted === null) {
      if (existing) {
        await collection.dropIndex(TTL_INDEX)
        console.log('[activity] retention is off — TTL index dropped')
      }
      return
    }

    if (!existing) {
      // Mongoose's own index build will create it; nothing to correct.
      return
    }

    if (existing.expireAfterSeconds !== wanted) {
      await collection.dropIndex(TTL_INDEX)
      await collection.createIndex({ createdAt: 1 }, { name: TTL_INDEX, expireAfterSeconds: wanted })
      console.log(`[activity] TTL index rebuilt at ${ACTIVITY_RETENTION_DAYS} days`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[activity] index sync skipped: ${message}`)
  }
}
