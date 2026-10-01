import mongoose from 'mongoose'
import {
  ACTIVE_ASSIGNMENT_INDEX,
  ACTIVE_ASSIGNMENT_INDEX_FILTER,
  ACTIVE_ASSIGNMENT_INDEX_KEY,
  AssignmentModel,
} from './assignment.model'

/** What `collection.indexes()` hands back, narrowed to the parts this reads. */
interface IndexInfo {
  name?: string
  unique?: boolean
  partialFilterExpression?: Record<string, unknown>
}

/**
 * Is the index already on the collection the one the model asks for?
 *
 * The filter is one equality on one field, so a shape comparison is enough and
 * a deep-equality helper would be more machinery than the question deserves.
 * Anything that is not exactly `{ status: 'Active' }` — absent, wider, or
 * naming a different field — counts as wrong and is rebuilt.
 */
function isPartialUnique(index: IndexInfo): boolean {
  if (index.unique !== true) return false

  const filter = index.partialFilterExpression
  if (!filter) return false

  const keys = Object.keys(filter)
  return keys.length === 1 && filter.status === ACTIVE_ASSIGNMENT_INDEX_FILTER.status
}

/**
 * Rebuilds the one index in this module that carries a business rule rather
 * than a lookup: **one active driver per vehicle**.
 *
 * It exists for the reason `syncNotificationIndexes` and `syncActivityIndexes`
 * exist — MongoDB will not change an existing index's options on its own, and
 * Mongoose will not insist. Here the trap was sharper than a stale TTL: the
 * `vehicleId` path once carried `index: true`, which produced a *plain*
 * `vehicleId_1`, and the partial unique index below wants that same name. So
 * whichever was built first won, the second was refused, and Mongoose reported
 * it as a warning about a "duplicate schema index" rather than as an error —
 * leaving the collection with an ordinary index where the module's only
 * database-level invariant was supposed to be.
 *
 * Removing `index: true` fixes new databases. It does nothing for one that has
 * already built the plain index, which is why this runs on boot: it reads what
 * is actually there, drops it when it is not the partial unique one, and builds
 * the right one in its place.
 *
 * Never throws, like every other boot migration here. A vendor module that
 * cannot tighten an index is a vendor module that still works; an API that
 * refuses to start because of one is not.
 */
export async function syncVendorIndexes(): Promise<void> {
  try {
    const collection = mongoose.connection.collection(AssignmentModel.collection.name)
    const indexes = (await collection.indexes()) as IndexInfo[]
    const existing = indexes.find((index) => index.name === ACTIVE_ASSIGNMENT_INDEX)

    if (existing && isPartialUnique(existing)) return

    if (existing) {
      await collection.dropIndex(ACTIVE_ASSIGNMENT_INDEX)
      console.warn(
        `[vendor] ${ACTIVE_ASSIGNMENT_INDEX} was not the partial unique index — rebuilding it`,
      )
    }

    await collection.createIndex(ACTIVE_ASSIGNMENT_INDEX_KEY, {
      name: ACTIVE_ASSIGNMENT_INDEX,
      unique: true,
      partialFilterExpression: ACTIVE_ASSIGNMENT_INDEX_FILTER,
    })

    console.log('[vendor] one active driver per vehicle is enforced by the database')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    /**
     * A duplicate key here is not a broken migration — it is the rule being
     * stated for the first time against data that already breaks it, which can
     * only have happened while the index was missing. It needs a person, so the
     * warning names the query that finds the offending vehicles rather than
     * leaving somebody to work out what "E11000" meant about a boot log.
     */
    if (message.includes('E11000')) {
      console.warn(
        '[vendor] cannot enforce one active driver per vehicle: a vehicle already has more than one Active assignment. ' +
          'Find them with: db.vehicledriverassignments.aggregate([{ $match: { status: "Active" } }, ' +
          '{ $group: { _id: "$vehicleId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]) ' +
          '— end the stale ones, then restart.',
      )
      return
    }

    console.warn(`[vendor] index sync skipped: ${message}`)
  }
}
