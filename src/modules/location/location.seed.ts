import { LOCATION_SEED } from './location.data'
import type { LocationType } from './location.constants'
import { LocationMasterModel } from './location.model'
import { normalizeLocationName } from './location.normalize'
import { invalidateMasterCache } from './location.resolver'

/**
 * Puts the supplied master list into the collection, once.
 *
 * Runs on the first successful database connection, beside the other
 * migrations. It exists because the resolver matches against the collection
 * and a collection with nothing in it matches nothing — a first deploy would
 * otherwise classify every challan as Pending until somebody had typed six
 * hundred thanas into a form.
 *
 * Two properties make it safe to run on every boot:
 *
 * **It only ever inserts.** A pair already in the collection is left exactly
 * as it is, including its location type and its active flag. So an Admin who
 * corrects a row, or deactivates one, is not overruled by the next deploy —
 * which is the whole reason the collection is the source of truth and this
 * file is only a seed.
 *
 * **It never throws.** A migration that takes the API down on boot is worse
 * than the reference data it was trying to install.
 */
export async function seedLocationMaster(): Promise<void> {
  try {
    const wanted = flattenSeed()

    const existing = await LocationMasterModel.find({})
      .select('normalizedDistrict normalizedThana')
      .lean()

    const present = new Set(
      existing.map((row) => row.normalizedDistrict + '|' + row.normalizedThana),
    )

    const missing = wanted.filter((row) => !present.has(row.key))

    if (missing.length === 0) {
      return
    }

    console.log(`[location] seeding ${missing.length} master location(s)`)

    /**
     * `ordered: false` so one unexpected duplicate — two instances booting at
     * the same moment, most likely — does not abandon the rest of the batch.
     * The unique index is what makes that collision harmless.
     */
    await LocationMasterModel.collection.insertMany(
      missing.map((row) => ({
        district: row.district,
        thana: row.thana,
        normalizedDistrict: row.normalizedDistrict,
        normalizedThana: row.normalizedThana,
        locationType: row.locationType,
        isActive: true,
        isSeeded: true,
        createdBy: null,
        updatedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      { ordered: false },
    )

    invalidateMasterCache()
    console.log(`[location] seeded ${missing.length} master location(s)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A duplicate-key error here is the expected shape of "two instances
    // seeded at once" and costs nothing; anything else is reported and
    // otherwise ignored, because location data is not worth a failed boot.
    console.error('[location] seeding failed: ' + message)
  }
}

interface FlatSeedRow {
  key: string
  district: string
  thana: string
  normalizedDistrict: string
  normalizedThana: string
  locationType: LocationType
}

/**
 * The seed groups as one row per pair, with duplicates dropped.
 *
 * The source list has a handful — Paba appears both among Rajshahi's upazilas
 * and among the metropolitan thanas, with the same classification. The first
 * occurrence wins and a genuine disagreement is reported rather than silently
 * resolved, because two different types for one pair is a mistake in the
 * reference list that somebody should look at.
 */
function flattenSeed(): FlatSeedRow[] {
  const rows = new Map<string, FlatSeedRow>()

  for (const group of LOCATION_SEED) {
    const normalizedDistrict = normalizeLocationName(group.district)

    for (const thana of group.thanas) {
      const normalizedThana = normalizeLocationName(thana)
      const key = normalizedDistrict + '|' + normalizedThana
      const existing = rows.get(key)

      if (existing) {
        if (existing.locationType !== group.locationType) {
          console.warn(
            `[location] seed lists ${group.district} / ${thana} as both ` +
              `${existing.locationType} and ${group.locationType}; keeping ${existing.locationType}`,
          )
        }
        continue
      }

      rows.set(key, {
        key,
        district: group.district,
        thana,
        normalizedDistrict,
        normalizedThana,
        locationType: group.locationType,
      })
    }
  }

  return [...rows.values()]
}
