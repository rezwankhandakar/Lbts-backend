import type { QueryFilter, Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import { AssignmentModel } from './assignment.model'
import { DriverModel } from './driver.model'
import { VehicleModel } from './vehicle.model'
import { VendorDocumentModel } from './vendor-document.model'
import { VendorModel } from './vendor.model'
import type { Vendor, VendorDocument } from './vendor.model'
import {
  assertCanCreateVendor,
  assertCanManageVendor,
  assertCanReadVendor,
  vendorFilterFor,
} from './vendor.access'
import { recordActivity, purgeActivity } from './vendor.activity'
import { allocateVendorCode } from './vendor.counter'
import {
  canTransitionVendor,
  nameKey,
  normalizeMobile,
} from './vendor.constants'
import type { VendorStatus } from './vendor.constants'
import {
  escapeRegex,
  expiryWindow,
  findVendorOr404,
  resolveActorNames,
} from './vendor.lookups'
import { toVendorOption, toVendorRecord } from './vendor.serializer'
import type { VendorCounts, VendorOption, VendorRecord } from './vendor.serializer'
import { discardVendorObject, uploadVendorPhoto } from './vendor.storage'
import type {
  CreateVendorInput,
  ListVendorsQuery,
  UpdateVendorInput,
  VendorOptionsQuery,
  VendorStatusInput,
} from './vendor.validation'

/**
 * The vendor itself: the record every vehicle, driver, assignment and document
 * in this module hangs off.
 *
 * Every function here takes the authenticated MongoDB profile and asserts scope
 * before it reads or writes. A vendor id arriving in a URL is a subject to be
 * checked, never authority — which is what makes
 * `GET /vendors/<somebody-elses-id>` a 404 for a Vendor account rather than a
 * leak.
 */

export interface ListVendorsResult {
  records: VendorRecord[]
  total: number
}

// --- Counts ----------------------------------------------------------------

/**
 * Fleet and compliance counts for a page of vendors.
 *
 * Four aggregations for the whole page rather than four per row, which is the
 * difference between a list and an outage on M0. The alternative — storing
 * these on the vendor and keeping them in step — was rejected for the reason
 * the vehicle carries no `currentDriverId`: a denormalised count is a second
 * source of truth, and this one would have to be updated from eight different
 * writes across four services.
 */
async function countsFor(vendorIds: Types.ObjectId[]): Promise<Map<string, VendorCounts>> {
  const empty: VendorCounts = {
    vehicles: 0,
    activeVehicles: 0,
    drivers: 0,
    activeDrivers: 0,
    expiredDocuments: 0,
    expiringDocuments: 0,
  }

  const result = new Map<string, VendorCounts>()
  for (const id of vendorIds) {
    result.set(String(id), { ...empty })
  }

  if (vendorIds.length === 0) {
    return result
  }

  const { today, soon } = expiryWindow()

  const [vehicles, drivers, documents] = await Promise.all([
    VehicleModel.aggregate<{ _id: Types.ObjectId; total: number; active: number }>([
      { $match: { vendorId: { $in: vendorIds } } },
      {
        $group: {
          _id: '$vendorId',
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
        },
      },
    ]),
    DriverModel.aggregate<{ _id: Types.ObjectId; total: number; active: number }>([
      { $match: { vendorId: { $in: vendorIds } } },
      {
        $group: {
          _id: '$vendorId',
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
        },
      },
    ]),
    VendorDocumentModel.aggregate<{
      _id: Types.ObjectId
      expired: number
      expiring: number
    }>([
      { $match: { vendorId: { $in: vendorIds }, expiryDate: { $ne: null } } },
      {
        $group: {
          _id: '$vendorId',
          expired: { $sum: { $cond: [{ $lt: ['$expiryDate', today] }, 1, 0] } },
          expiring: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$expiryDate', today] }, { $lte: ['$expiryDate', soon] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ])

  for (const row of vehicles) {
    const counts = result.get(String(row._id))
    if (counts) {
      counts.vehicles = row.total
      counts.activeVehicles = row.active
    }
  }

  for (const row of drivers) {
    const counts = result.get(String(row._id))
    if (counts) {
      counts.drivers = row.total
      counts.activeDrivers = row.active
    }
  }

  for (const row of documents) {
    const counts = result.get(String(row._id))
    if (counts) {
      counts.expiredDocuments = row.expired
      counts.expiringDocuments = row.expiring
    }
  }

  return result
}

// --- Listing ---------------------------------------------------------------

async function buildListFilter(
  query: ListVendorsQuery,
  viewer: UserDocument,
): Promise<QueryFilter<Vendor>> {
  const clauses: QueryFilter<Vendor>[] = []

  /**
   * The scope clause, first and always. A Vendor account's list is one row —
   * their own — and this is what makes that true of the count and the paging
   * as well as of the rows, rather than merely appearing true.
   */
  const scope = vendorFilterFor(viewer)
  if (scope) {
    clauses.push({ _id: scope.vendorId })
  }

  if (query.status !== 'all') {
    clauses.push({ status: query.status })
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    // Code, name and number: the three things somebody has in hand when they
    // are looking for a vendor. The number is matched on its normalised form
    // too, so 01712-345678 finds a vendor stored as 01712345678.
    clauses.push({
      $or: [
        { vendorCode: pattern },
        { name: pattern },
        { mobile: pattern },
        { mobileKey: new RegExp(escapeRegex(normalizeMobile(query.search)), 'i') },
      ],
    })
  }

  /**
   * The compliance filter is over derived data, so it is resolved to a set of
   * vendor ids first rather than expressed as a clause on this collection.
   *
   * That is a real cost — one extra distinct query — and it is why the filter
   * offers three coarse answers rather than a numeric range: "which vendors
   * have something expired" is the question somebody sits down to answer, and
   * it is worth one query. "Which have between two and four alerts" is not a
   * question anybody has, and would be worth none.
   */
  if (query.compliance !== 'all') {
    const { today, soon } = expiryWindow()

    const expiredMatch = { expiryDate: { $ne: null, $lt: today } }
    const expiringMatch = { expiryDate: { $ne: null, $gte: today, $lte: soon } }

    if (query.compliance === 'expired') {
      clauses.push({ _id: { $in: await VendorDocumentModel.distinct('vendorId', expiredMatch) } })
    } else if (query.compliance === 'expiring') {
      clauses.push({ _id: { $in: await VendorDocumentModel.distinct('vendorId', expiringMatch) } })
    } else {
      // "Clear" is neither, so it needs both sets — a vendor with one expired
      // certificate and nothing expiring is not clear.
      const [expired, expiring] = await Promise.all([
        VendorDocumentModel.distinct('vendorId', expiredMatch),
        VendorDocumentModel.distinct('vendorId', expiringMatch),
      ])
      clauses.push({ _id: { $nin: [...expired, ...expiring] } })
    }
  }

  return clauses.length > 0 ? { $and: clauses } : {}
}

/**
 * How the list is ordered.
 *
 * By name by default, because a vendor directory is read the way a phone book
 * is — somebody looking for Malek Transport looks under M, not at whichever end
 * of a creation date it landed on. `vehicles` and `drivers` sort by the counts,
 * which are not stored, so those two are applied in memory over the page after
 * the counts have been fetched. That is honest at this scale: a fleet
 * operation has tens of vendors, not tens of thousands, and paging is still
 * server-side.
 */
const SORTS: Record<string, Record<string, 1 | -1>> = {
  name: { name: 1 },
  recent: { createdAt: -1 },
  vehicles: { name: 1 },
  drivers: { name: 1 },
}

export async function listVendors(
  query: ListVendorsQuery,
  viewer: UserDocument,
): Promise<ListVendorsResult> {
  const filter = await buildListFilter(query, viewer)
  const skip = (query.page - 1) * query.limit

  const [records, total] = await Promise.all([
    VendorModel.find(filter).sort(SORTS[query.sort] ?? SORTS.name).skip(skip).limit(query.limit),
    VendorModel.countDocuments(filter),
  ])

  const ids = records.map((record) => record._id)
  const [counts, names] = await Promise.all([
    countsFor(ids),
    resolveActorNames(
      records.flatMap((record) => [record.createdBy, record.updatedBy, record.statusChangedBy]),
    ),
  ])

  const serialized = records.map((record) =>
    toVendorRecord(record, names, counts.get(String(record._id))),
  )

  if (query.sort === 'vehicles' || query.sort === 'drivers') {
    const key = query.sort === 'vehicles' ? 'vehicles' : 'drivers'
    serialized.sort((a, b) => (b.counts?.[key] ?? 0) - (a.counts?.[key] ?? 0))
  }

  return { records: serialized, total }
}

/**
 * Vendors for a selector.
 *
 * Deliberately narrower than a list record: an assignment form is choosing a
 * vendor, and six counts per row at that moment are three aggregations nobody
 * reads. `operational` narrows it to the vendors that may actually take new
 * work, so a form cannot offer a suspended vendor the API would then refuse.
 */
export async function listVendorOptions(
  query: VendorOptionsQuery,
  viewer: UserDocument,
): Promise<VendorOption[]> {
  const clauses: QueryFilter<Vendor>[] = []

  const scope = vendorFilterFor(viewer)
  if (scope) {
    clauses.push({ _id: scope.vendorId })
  }

  if (query.operational) {
    clauses.push({ status: 'Active' })
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({ $or: [{ name: pattern }, { vendorCode: pattern }] })
  }

  const vendors = await VendorModel.find(clauses.length > 0 ? { $and: clauses } : {})
    .sort({ name: 1 })
    .limit(100)

  return vendors.map(toVendorOption)
}

async function serialize(vendor: VendorDocument): Promise<VendorRecord> {
  const names = await resolveActorNames([
    vendor.createdBy,
    vendor.updatedBy,
    vendor.statusChangedBy,
  ])
  return toVendorRecord(vendor, names)
}

export async function getVendor(id: string, viewer: UserDocument): Promise<VendorRecord> {
  const vendor = await findVendorOr404(id)
  // Both outcomes answer 404 with the same message, so a Vendor account cannot
  // tell "does not exist" from "not yours".
  assertCanReadVendor(String(vendor._id), viewer)
  return serialize(vendor)
}

// --- Writing ---------------------------------------------------------------

/**
 * A vendor is identified by its name, so two rows for one name is a duplicate
 * record rather than two companies — and a dispatcher assigning a trip would
 * have no way to tell which of the two to use. Refused on the normalised name
 * rather than the typed one, with a unique index under the check.
 */
async function assertNameFree(key: string, exceptId?: string): Promise<void> {
  const clash = await VendorModel.findOne({
    nameKey: key,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select('vendorCode name')

  if (clash) {
    throw new AppError(
      409,
      `${clash.name} is already recorded as ${clash.vendorCode}. Open that vendor instead of adding a second one.`,
    )
  }
}

export async function createVendor(
  input: CreateVendorInput,
  actor: UserDocument,
): Promise<VendorRecord> {
  assertCanCreateVendor(actor)

  const key = nameKey(input.name)
  if (!key) {
    throw new AppError(400, 'That vendor name has no letters or digits in it.')
  }
  await assertNameFree(key)

  const vendor = await VendorModel.create({
    vendorCode: await allocateVendorCode(),
    name: input.name,
    nameKey: key,
    mobile: input.mobile,
    mobileKey: normalizeMobile(input.mobile),
    address: input.address,
    status: input.status ?? undefined,
    createdBy: actor._id,
  })

  await recordActivity({
    vendorId: vendor._id,
    action: 'vendor.created',
    entityType: 'Vendor',
    entityId: vendor._id,
    entityLabel: vendor.name,
    summary: `Vendor ${vendor.vendorCode} created as ${vendor.status}`,
    actor,
  })

  return serialize(vendor)
}

export async function updateVendor(
  id: string,
  input: UpdateVendorInput,
  actor: UserDocument,
): Promise<VendorRecord> {
  const vendor = await findVendorOr404(id)
  assertCanManageVendor(String(vendor._id), actor)

  if (input.name !== undefined) {
    const key = nameKey(input.name)
    if (!key) {
      throw new AppError(400, 'That vendor name has no letters or digits in it.')
    }
    await assertNameFree(key, String(vendor._id))
    vendor.name = input.name
    vendor.nameKey = key
  }

  if (input.mobile !== undefined) {
    vendor.mobile = input.mobile
    vendor.mobileKey = normalizeMobile(input.mobile)
  }

  if (input.address !== undefined) {
    vendor.address = input.address
  }

  vendor.updatedBy = actor._id
  await vendor.save()

  await recordActivity({
    vendorId: vendor._id,
    action: 'vendor.updated',
    entityType: 'Vendor',
    entityId: vendor._id,
    entityLabel: vendor.name,
    summary: `Vendor details updated (${Object.keys(input).join(', ')})`,
    actor,
  })

  return serialize(vendor)
}

/**
 * Moving a vendor between lifecycle states.
 *
 * Its own endpoint rather than a field on the edit form, because it has a
 * consequence a change of address does not: an `Inactive` or `Suspended` vendor
 * stops receiving new assignments. Nothing it already has is touched — history
 * is never destroyed by a status — and every stop is reversible, so a vendor
 * suspended over a lapsed certificate comes back when it is renewed rather than
 * being recreated, which would orphan its whole fleet.
 */
export async function changeVendorStatus(
  id: string,
  input: VendorStatusInput,
  actor: UserDocument,
): Promise<VendorRecord> {
  const vendor = await findVendorOr404(id)
  assertCanManageVendor(String(vendor._id), actor)

  const current = vendor.status as VendorStatus

  if (current === input.status) {
    throw new AppError(409, `This vendor is already ${input.status}.`)
  }

  if (!canTransitionVendor(current, input.status)) {
    throw new AppError(409, `A ${current} vendor cannot be moved to ${input.status}.`)
  }

  vendor.status = input.status
  vendor.statusChangedAt = new Date()
  vendor.statusChangedBy = actor._id
  // A note explains a suspension; clearing it on reinstatement stops a stale
  // reason from following a working vendor around.
  vendor.statusNote = input.status === 'Active' ? null : (input.note ?? null)
  vendor.updatedBy = actor._id
  await vendor.save()

  await recordActivity({
    vendorId: vendor._id,
    action: 'vendor.status',
    entityType: 'Vendor',
    entityId: vendor._id,
    entityLabel: vendor.name,
    summary: `Vendor moved from ${current} to ${input.status}`,
    actor,
  })

  return serialize(vendor)
}

// --- Photo -----------------------------------------------------------------

/**
 * Replacing the vendor photo.
 *
 * The order is the whole point, and it is the order every module in this
 * codebase uses: upload the new object, write the reference, *then* delete the
 * old one. At no point does the record point at an image that no longer exists
 * — the worst outcome of a failure is an orphaned file.
 */
export async function setVendorPhoto(
  id: string,
  buffer: Buffer,
  actor: UserDocument,
): Promise<VendorRecord> {
  const vendor = await findVendorOr404(id)
  assertCanManageVendor(String(vendor._id), actor)

  const previousKey = vendor.photoKey
  const uploaded = await uploadVendorPhoto(buffer, 'vendors')

  vendor.photoUrl = uploaded.url
  vendor.photoKey = uploaded.key
  vendor.updatedBy = actor._id

  try {
    await vendor.save()
  } catch (error) {
    // The upload succeeded but the reference never landed, so the new object is
    // already unreachable. Clean it up rather than leave it behind.
    await discardVendorObject(uploaded.key)
    throw error
  }

  await discardVendorObject(previousKey)

  await recordActivity({
    vendorId: vendor._id,
    action: 'vendor.photo',
    entityType: 'Vendor',
    entityId: vendor._id,
    entityLabel: vendor.name,
    summary: 'Vendor photo updated',
    actor,
  })

  return serialize(vendor)
}

/**
 * Clearing it. The reference goes first here, for the mirror-image reason:
 * deleting the object first would leave the record pointing at a dead URL if
 * the write then failed, which every viewer would see.
 */
export async function clearVendorPhoto(
  id: string,
  actor: UserDocument,
): Promise<VendorRecord> {
  const vendor = await findVendorOr404(id)
  assertCanManageVendor(String(vendor._id), actor)

  if (!vendor.photoUrl && !vendor.photoKey) {
    throw new AppError(409, 'There is no vendor photo to remove.')
  }

  const previousKey = vendor.photoKey
  vendor.photoUrl = null
  vendor.photoKey = null
  vendor.updatedBy = actor._id
  await vendor.save()

  await discardVendorObject(previousKey)

  await recordActivity({
    vendorId: vendor._id,
    action: 'vendor.photo',
    entityType: 'Vendor',
    entityId: vendor._id,
    entityLabel: vendor.name,
    summary: 'Vendor photo removed',
    actor,
  })

  return serialize(vendor)
}

// --- Removal ---------------------------------------------------------------

export interface VendorRemoval {
  id: string
  /** True when it was deactivated instead, because records still reference it. */
  deactivated: boolean
  vehicles: number
  drivers: number
  assignments: number
  linkedUsers: number
}

/**
 * Removing a vendor.
 *
 * A deletion when nothing references it, and a **deactivation** when something
 * does — the same rule the Location master follows, and for a stronger reason
 * here. Deleting a vendor with a year of assignments behind it would leave that
 * history pointing at nothing and unable to say who was driving; deleting one
 * with a linked user account would leave somebody able to sign in with a role
 * that names a vendor that no longer exists.
 *
 * Either way it stops being offered for new work, because `Inactive` is not an
 * operational status. The caller is told which of the two happened rather than
 * being allowed to assume a deletion.
 */
export async function removeVendor(
  id: string,
  actor: UserDocument,
): Promise<VendorRemoval> {
  const vendor = await findVendorOr404(id)
  assertCanManageVendor(String(vendor._id), actor)

  const [vehicles, drivers, assignments, linkedUsers] = await Promise.all([
    VehicleModel.countDocuments({ vendorId: vendor._id }),
    DriverModel.countDocuments({ vendorId: vendor._id }),
    AssignmentModel.countDocuments({ vendorId: vendor._id }),
    UserModel.countDocuments({ vendorId: vendor._id }),
  ])

  const referenced = vehicles + drivers + assignments + linkedUsers > 0

  if (referenced) {
    if (vendor.status !== 'Inactive') {
      vendor.status = 'Inactive'
      vendor.statusChangedAt = new Date()
      vendor.statusChangedBy = actor._id
      vendor.statusNote = 'Deactivated instead of deleted: records still reference this vendor.'
      vendor.updatedBy = actor._id
      await vendor.save()
    }

    await recordActivity({
      vendorId: vendor._id,
      action: 'vendor.status',
      entityType: 'Vendor',
      entityId: vendor._id,
      entityLabel: vendor.name,
      summary: 'Deactivated instead of deleted — records still reference this vendor',
      actor,
    })

    return {
      id: String(vendor._id),
      deactivated: true,
      vehicles,
      drivers,
      assignments,
      linkedUsers,
    }
  }

  /**
   * Nothing references it, so it goes. Documents are checked and removed too:
   * a vendor with no vehicles and no drivers cannot have any, but the delete is
   * cheap and leaving the possibility open is how an orphan appears.
   */
  await VendorDocumentModel.deleteMany({ vendorId: vendor._id })
  await vendor.deleteOne()
  await purgeActivity(String(vendor._id))
  await discardVendorObject(vendor.photoKey)

  return {
    id: String(vendor._id),
    deactivated: false,
    vehicles: 0,
    drivers: 0,
    assignments: 0,
    linkedUsers: 0,
  }
}
