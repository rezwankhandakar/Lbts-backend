import { config } from '../../config/index'
import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { ChallanModel } from '../challan/challan.model'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import type { LocationType } from './location.constants'
import { geminiUsage } from './location.gemini'
import type { GeminiUsage } from './location.gemini'
import { LocationMasterModel, normalizedPair } from './location.model'
import type { LocationMaster, LocationMasterDocument } from './location.model'
import { invalidateMasterCache } from './location.resolver'
import { toLocationRecord } from './location.serializer'
import type { LocationRecord } from './location.serializer'
import type {
  CreateLocationInput,
  ListLocationsQuery,
  UpdateLocationInput,
} from './location.validation'

/**
 * Administering the master collection.
 *
 * Reference data, which makes its rules different from a records module's.
 * There is no lifecycle and no ownership — a district/thana pair belongs to
 * nobody — and the only interesting decisions are about identity and about
 * what happens to the challans pointing at a row somebody wants gone.
 *
 * Every write invalidates the resolver's in-memory copy, so a correction takes
 * effect on the next challan rather than in five minutes.
 */

/** User input reaches a regex, so metacharacters must lose their meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function resolveActorNames(
  records: { createdBy?: unknown; updatedBy?: unknown }[],
): Promise<Map<string, string>> {
  const ids = new Set<string>()

  for (const record of records) {
    if (record.createdBy) ids.add(String(record.createdBy))
    if (record.updatedBy) ids.add(String(record.updatedBy))
  }

  if (ids.size === 0) {
    return new Map()
  }

  const actors = await UserModel.find({ _id: { $in: [...ids] } }).select('name')
  return new Map(actors.map((actor) => [String(actor._id), actor.name]))
}

async function serialize(location: LocationMasterDocument): Promise<LocationRecord> {
  return toLocationRecord(location, await resolveActorNames([location]))
}

async function findLocation(id: string): Promise<LocationMasterDocument> {
  const location = await LocationMasterModel.findById(id)
  if (!location) {
    throw new AppError(404, 'That location is not in the master list.')
  }
  return location
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListLocationsResult {
  records: LocationRecord[]
  total: number
}

function buildListFilter(query: ListLocationsQuery): QueryFilter<LocationMaster> {
  const clauses: QueryFilter<LocationMaster>[] = []

  if (query.district) {
    clauses.push({ district: new RegExp(escapeRegex(query.district), 'i') })
  }
  if (query.locationType !== 'all') {
    clauses.push({ locationType: query.locationType })
  }
  if (query.active !== 'all') {
    clauses.push({ isActive: query.active === 'active' })
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({ $or: [{ district: pattern }, { thana: pattern }] })
  }

  return clauses.length > 0 ? { $and: clauses } : {}
}

export async function listLocations(query: ListLocationsQuery): Promise<ListLocationsResult> {
  const filter = buildListFilter(query)
  const skip = (query.page - 1) * query.limit

  const [records, total] = await Promise.all([
    LocationMasterModel.find(filter)
      // Alphabetical rather than newest-first: this is a reference list, and
      // somebody looking for Savar is looking for it under S.
      .sort({ district: 1, thana: 1 })
      .skip(skip)
      .limit(query.limit),
    LocationMasterModel.countDocuments(filter),
  ])

  const names = await resolveActorNames(records)

  return { records: records.map((record) => toLocationRecord(record, names)), total }
}

/**
 * Every district that has at least one active thana.
 *
 * The first half of the cascading selector. Distinct values off an indexed
 * field rather than a second collection: a few hundred rows make this cheap,
 * and a denormalised list of districts would be one more thing that could
 * disagree with the collection it came from.
 */
export async function listDistricts(): Promise<string[]> {
  const rows = await LocationMasterModel.aggregate<{ _id: string }>([
    { $match: { isActive: true } },
    { $group: { _id: '$district' } },
    { $sort: { _id: 1 } },
  ])

  return rows.map((row) => row._id).filter((value) => typeof value === 'string' && value.length > 0)
}

export interface ThanaOption {
  id: string
  thana: string
  locationType: LocationType
}

/**
 * The active thanas of one district, with the type each carries.
 *
 * The type comes back with the thana rather than in a third request, because
 * the two are one fact: choosing the thana is what decides the location type,
 * and a selector that had to ask again could show a stale one in between.
 */
export async function listThanas(district: string): Promise<ThanaOption[]> {
  const rows = await LocationMasterModel.find({
    isActive: true,
    normalizedDistrict: normalizedPair(district, '').normalizedDistrict,
  })
    .select('thana locationType')
    .sort({ thana: 1 })

  return rows.map((row) => ({
    id: String(row._id),
    thana: row.thana,
    locationType: row.locationType as LocationType,
  }))
}

export interface LocationStats {
  total: number
  active: number
  inactive: number
  districts: number
  byType: Record<LocationType, number>
  /**
   * How the assisted step has been behaving. Admin-only and diagnostic: it is
   * what turns "resolution stopped working" into a question with an answer.
   */
  gemini: GeminiUsage & { configured: boolean }
}

export async function getLocationStats(): Promise<LocationStats> {
  const [byStatus, byType, districts] = await Promise.all([
    LocationMasterModel.aggregate<{ _id: boolean; count: number }>([
      { $group: { _id: '$isActive', count: { $sum: 1 } } },
    ]),
    LocationMasterModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$locationType', count: { $sum: 1 } } },
    ]),
    listDistricts(),
  ])

  const active = byStatus.find((row) => row._id === true)?.count ?? 0
  const inactive = byStatus.find((row) => row._id === false)?.count ?? 0
  const types = new Map(byType.map((row) => [row._id, row.count]))

  return {
    total: active + inactive,
    active,
    inactive,
    districts: districts.length,
    byType: {
      ISD: types.get('ISD') ?? 0,
      'OSD-Thana': types.get('OSD-Thana') ?? 0,
      'OSD-Metro': types.get('OSD-Metro') ?? 0,
    },
    // Whether it is set up at all is a fact about the environment; everything
    // else is a fact about how it has behaved since this instance started.
    gemini: { configured: config.gemini !== null, ...geminiUsage() },
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Refuses a pair the collection already holds.
 *
 * Compared on the normalised values, not the typed ones, or "Mirpur" and
 * "mirpur " would be two rows and every lookup would have to choose between
 * them — the exact ambiguity the resolver refuses to guess at. The unique
 * index enforces the same rule; this is here so the answer is a sentence
 * rather than a driver error.
 */
async function assertNotDuplicate(
  district: string,
  thana: string,
  excludeId?: string,
): Promise<void> {
  const keys = normalizedPair(district, thana)
  const filter: QueryFilter<LocationMaster> = { ...keys }
  if (excludeId) {
    filter._id = { $ne: excludeId }
  }

  const existing = await LocationMasterModel.findOne(filter).select('district thana isActive')

  if (existing) {
    throw new AppError(
      409,
      existing.isActive
        ? `${existing.district} / ${existing.thana} is already in the master list.`
        : `${existing.district} / ${existing.thana} is already in the master list, but deactivated. Reactivate it rather than adding it again.`,
    )
  }
}

export async function createLocation(
  input: CreateLocationInput,
  actor: UserDocument,
): Promise<LocationRecord> {
  await assertNotDuplicate(input.district, input.thana)

  const location = await LocationMasterModel.create({
    district: input.district,
    thana: input.thana,
    ...normalizedPair(input.district, input.thana),
    locationType: input.locationType,
    isActive: input.isActive,
    isSeeded: false,
    createdBy: actor._id,
    updatedBy: actor._id,
  })

  invalidateMasterCache()
  return serialize(location)
}

/**
 * Corrects a row.
 *
 * A changed district or thana rewrites the normalised keys with it — they are
 * derived from the typed values and can never be set independently, which is
 * what stops a row from matching something it does not say.
 *
 * Nothing is rewritten on the challans that already point here. That is
 * deliberate: those records hold a reference, and reading the current district,
 * thana and type through it is what makes fixing a misclassified pair fix
 * every challan in it at once.
 */
export async function updateLocation(
  id: string,
  input: UpdateLocationInput,
  actor: UserDocument,
): Promise<LocationRecord> {
  const location = await findLocation(id)

  const district = input.district ?? location.district
  const thana = input.thana ?? location.thana

  if (district !== location.district || thana !== location.thana) {
    await assertNotDuplicate(district, thana, id)
    location.district = district
    location.thana = thana
    const keys = normalizedPair(district, thana)
    location.normalizedDistrict = keys.normalizedDistrict
    location.normalizedThana = keys.normalizedThana
  }

  if (input.locationType) {
    location.locationType = input.locationType
  }
  if (input.isActive !== undefined) {
    location.isActive = input.isActive
  }

  location.updatedBy = actor._id
  await location.save()

  invalidateMasterCache()
  return serialize(location)
}

export interface LocationRemoval {
  id: string
  /** True when the row was deactivated instead, because challans reference it. */
  deactivated: boolean
  challanCount: number
}

/**
 * Removing a location, safely.
 *
 * A row nothing references is deleted outright — a thana added by mistake
 * should not have to be lived with. A row that challans point at is
 * **deactivated instead**, and the caller is told so plainly.
 *
 * That is not a compromise, it is the correct behaviour. Historical challans
 * read their district, thana and location type through this row; deleting it
 * would leave a year of records pointing at nothing, unable to say where they
 * went. Deactivating takes it out of every selector and out of every future
 * resolution while leaving what has already been filed intact and readable.
 */
export async function removeLocation(
  id: string,
  actor: UserDocument,
): Promise<LocationRemoval> {
  const location = await findLocation(id)

  const challanCount = await ChallanModel.countDocuments({
    'resolvedLocation.masterId': location._id,
  })

  if (challanCount > 0) {
    if (location.isActive) {
      location.isActive = false
      location.updatedBy = actor._id
      await location.save()
    }

    invalidateMasterCache()
    return { id: String(location._id), deactivated: true, challanCount }
  }

  await location.deleteOne()
  invalidateMasterCache()

  return { id: String(location._id), deactivated: false, challanCount: 0 }
}
