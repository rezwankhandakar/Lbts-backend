import type { QueryFilter, UpdateQuery } from 'mongoose'
import { UserModel } from './user.model'
import type { User } from './user.model'
import { USER_ROLES, USER_STATUSES } from './user.constants'
import type { UserRole, UserStatus } from './user.constants'

/**
 * Mongoose 9's strict query types only admit values the enum currently allows,
 * which is exactly what this file cannot use — it exists to find the values the
 * enum no longer allows. The cast is confined to this one helper.
 */
function matching(field: 'role' | 'status', value: string): QueryFilter<User> {
  return { [field]: value } as QueryFilter<User>
}

/**
 * Values the schema held before the role set was fixed at five and the account
 * lifecycle grew past active/blocked.
 *
 * A document carrying one of these cannot be saved by the app at all: Mongoose
 * validates the whole document on save, so an administrator changing a legacy
 * user's role would be refused because of the *status* field they never
 * touched. It also skews the overview counts, which group by status, and it
 * matches no status filter. So this is not cosmetic — it is what makes the
 * existing records usable.
 *
 * `admin` keeps its privileges as `Admin`; `user` becomes the least-privileged
 * role, which is what a new account gets today. `active` stays usable and
 * `blocked` becomes `Suspended`, the state that means the same thing now.
 */
const LEGACY_ROLES: Record<string, UserRole> = {
  user: 'Vendor',
  admin: 'Admin',
}

const LEGACY_STATUSES: Record<string, UserStatus> = {
  active: 'Active',
  blocked: 'Suspended',
}

/**
 * The Cloudinary public id, from before profile photos moved to Cloudflare R2.
 *
 * It is dropped rather than renamed to `photoKey`. A Cloudinary id means
 * nothing to an object store, so carrying it over would claim the profile owns
 * an R2 object that was never written, and a later "remove photo" would issue a
 * delete for a key that does not exist. `photoUrl` is deliberately left alone:
 * an avatar already hosted on Cloudinary keeps rendering until its owner
 * replaces it, and the replacement lands in R2 like any other upload.
 */
const LEGACY_PHOTO_FIELD = 'photoPublicId'

/**
 * Runs once, on the first successful connection. Idempotent by construction:
 * after the first pass the queries match nothing, so a reconnect costs two
 * empty updates. Never throws — a failure here must not take down a process
 * that is otherwise healthy.
 */
export async function normalizeLegacyUserRecords(): Promise<void> {
  try {
    let changed = 0

    for (const [legacy, replacement] of Object.entries(LEGACY_ROLES)) {
      const result = await UserModel.updateMany(matching('role', legacy), {
        $set: { role: replacement },
      })
      changed += result.modifiedCount
    }

    for (const [legacy, replacement] of Object.entries(LEGACY_STATUSES)) {
      const result = await UserModel.updateMany(matching('status', legacy), {
        $set: { status: replacement },
      })
      changed += result.modifiedCount
    }

    if (changed > 0) {
      console.log(`[db] normalized ${changed} legacy role/status value(s)`)
    }

    const photos = await UserModel.updateMany(
      { [LEGACY_PHOTO_FIELD]: { $exists: true } } as QueryFilter<User>,
      { $unset: { [LEGACY_PHOTO_FIELD]: '' } } as UpdateQuery<User>,
    )

    if (photos.modifiedCount > 0) {
      console.log(`[db] dropped ${photos.modifiedCount} legacy Cloudinary photo reference(s)`)
    }

    /**
     * Anything still outside the enums has to be fixed by hand. Say so at
     * startup rather than letting it surface later as an opaque
     * "Validation failed" on an unrelated administrative action.
     */
    const stranded = await UserModel.countDocuments({
      $or: [{ role: { $nin: [...USER_ROLES] } }, { status: { $nin: [...USER_STATUSES] } }],
    })

    if (stranded > 0) {
      console.warn(
        `[db] ${stranded} user document(s) hold a role or status outside the current enums. ` +
          'They cannot be edited until corrected in MongoDB.',
      )
    }
  } catch (error) {
    console.error('[db] legacy user normalization failed', error)
  }
}
