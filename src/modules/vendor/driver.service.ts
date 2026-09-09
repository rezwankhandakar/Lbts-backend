import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { AssignmentModel } from './assignment.model'
import { DriverModel } from './driver.model'
import type { Driver, DriverDocument } from './driver.model'
import { VendorDocumentModel } from './vendor-document.model'
import { assertCanManageVendor, assertCanReadVendor } from './vendor.access'
import { recordActivity } from './vendor.activity'
import {
  DRIVER_LICENCE_DOCUMENT,
  nameKey,
  normalizeMobile,
  registrationKey,
} from './vendor.constants'
import type { DriverStatus } from './vendor.constants'
import { allocateDriverCode } from './vendor.counter'
import {
  currentVehiclesFor,
  documentTalliesFor,
  escapeRegex,
  expiryWindow,
  findDriverOr404,
  findVendorOr404,
  resolveActorNames,
  tallyFor,
} from './vendor.lookups'
import { toDriverDetail, toDriverRecord } from './vendor.serializer'
import type { DriverDetail, DriverRecord } from './vendor.serializer'
import { discardVendorObject, uploadVendorPhoto } from './vendor.storage'
import type {
  CreateDriverInput,
  DriverStatusInput,
  ListDriversQuery,
  UpdateDriverInput,
} from './vendor.validation'

/**
 * A vendor's drivers.
 *
 * The same shape as the vehicle service, with one thing of its own: the licence.
 * A driver carries `licenseNumber` and `licenseExpiry` so a table of eighteen
 * rows can render a licence column without eighteen joins, and those two fields
 * are a copy of the driver's `Driving License` document. `syncDriverLicence`
 * below is the only place either side is written from the other, which is what
 * stops the copy and the document disagreeing — and it is why compliance counts
 * documents alone rather than documents plus a field.
 */

export interface ListDriversResult {
  records: DriverRecord[]
  total: number
}

async function serializeMany(records: DriverDocument[]): Promise<DriverRecord[]> {
  if (records.length === 0) {
    return []
  }

  const ids = records.map((record) => record._id)

  const [vehicles, tallies, names] = await Promise.all([
    currentVehiclesFor(ids),
    documentTalliesFor('Driver', ids),
    resolveActorNames(records.flatMap((record) => [record.createdBy, record.updatedBy])),
  ])

  return records.map((record) =>
    toDriverRecord(
      record,
      names,
      vehicles.get(String(record._id)) ?? null,
      tallyFor(tallies, record._id),
    ),
  )
}

/**
 * The full shape, with the NID and the address.
 *
 * Separate from the list shape on purpose: a table of eighteen drivers has no
 * use for eighteen national ID numbers, and putting them there spreads personal
 * data across every screen that shows a fleet. This is the one driver somebody
 * has actually opened.
 */
async function serializeDetail(record: DriverDocument): Promise<DriverDetail> {
  const [vehicles, tallies, names] = await Promise.all([
    currentVehiclesFor([record._id]),
    documentTalliesFor('Driver', [record._id]),
    resolveActorNames([record.createdBy, record.updatedBy]),
  ])

  return toDriverDetail(
    record,
    names,
    vehicles.get(String(record._id)) ?? null,
    tallyFor(tallies, record._id),
  )
}

function buildFilter(vendorId: string, query: ListDriversQuery): QueryFilter<Driver> {
  const clauses: QueryFilter<Driver>[] = [{ vendorId }]

  if (query.status !== 'all') {
    clauses.push({ status: query.status })
  }

  /**
   * The licence backlog, as a range on the indexed expiry field rather than a
   * derived status — the same reasoning `locationStatus` follows in Challan:
   * deriving it in a query would mean an unindexed scan on every page.
   */
  if (query.licence !== 'all') {
    const { today, soon } = expiryWindow()
    clauses.push(
      query.licence === 'expired'
        ? { licenseExpiry: { $ne: null, $lt: today } }
        : { licenseExpiry: { $ne: null, $gte: today, $lte: soon } },
    )
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({
      $or: [
        { name: pattern },
        { driverCode: pattern },
        { mobile: pattern },
        { mobileKey: new RegExp(escapeRegex(normalizeMobile(query.search)), 'i') },
        { licenseNumber: pattern },
      ],
    })
  }

  return { $and: clauses }
}

export async function listDrivers(
  vendorId: string,
  query: ListDriversQuery,
  viewer: UserDocument,
): Promise<ListDriversResult> {
  assertCanReadVendor(vendorId, viewer)

  const filter = buildFilter(vendorId, query)
  const skip = (query.page - 1) * query.limit

  const [records, total] = await Promise.all([
    DriverModel.find(filter).sort({ name: 1 }).skip(skip).limit(query.limit),
    DriverModel.countDocuments(filter),
  ])

  return { records: await serializeMany(records), total }
}

export async function getDriver(id: string, viewer: UserDocument): Promise<DriverDetail> {
  const driver = await findDriverOr404(id)
  assertCanReadVendor(String(driver.vendorId), viewer)
  return serializeDetail(driver)
}

/**
 * Two drivers with the same mobile number under one vendor is a duplicate
 * record rather than two people, and a dispatcher ringing the number would
 * never learn which of the two they had reached.
 *
 * Scoped to the vendor rather than global, because a driver working for two
 * firms is legitimate and refusing the second one would be this system telling
 * the business something untrue about its own drivers.
 */
async function assertMobileFree(
  vendorId: string,
  mobileKey: string,
  exceptId?: string,
): Promise<void> {
  const clash = await DriverModel.findOne({
    vendorId,
    mobileKey,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select('driverCode name')

  if (clash) {
    throw new AppError(
      409,
      `${clash.name} (${clash.driverCode}) is already recorded on that number for this vendor.`,
    )
  }
}

/**
 * Keeps the driver's licence fields and the `Driving License` document row in
 * step, in the one direction that is safe to automate.
 *
 * The driver record is the side people type into, so it is the side that
 * writes: creating or correcting a licence number or expiry here upserts the
 * document row that carries it. Editing the *document* — to attach a scan or
 * correct a date read off it — writes back the other way, and that lives in the
 * document service. Two functions, each explicit, rather than a hook that fires
 * from both sides and eventually loops.
 *
 * A driver with no licence number has no document row: an expiry attached to
 * nothing would raise a compliance alert nobody could act on, because there
 * would be no document to go and renew.
 */
export async function syncDriverLicence(
  driver: DriverDocument,
  actor: UserDocument,
): Promise<void> {
  if (!driver.licenseNumber) {
    await VendorDocumentModel.deleteOne({
      ownerType: 'Driver',
      ownerId: driver._id,
      documentType: DRIVER_LICENCE_DOCUMENT,
      // Only a row this sync created and nobody has attached a scan to. A
      // document somebody uploaded is evidence, and clearing a typed field
      // must not delete evidence.
      attachment: null,
    })
    return
  }

  await VendorDocumentModel.updateOne(
    {
      ownerType: 'Driver',
      ownerId: driver._id,
      documentType: DRIVER_LICENCE_DOCUMENT,
    },
    {
      $set: {
        documentNumber: driver.licenseNumber,
        expiryDate: driver.licenseExpiry,
        updatedBy: actor._id,
      },
      $setOnInsert: {
        vendorId: driver.vendorId,
        ownerType: 'Driver',
        ownerId: driver._id,
        documentType: DRIVER_LICENCE_DOCUMENT,
        createdBy: actor._id,
      },
    },
    { upsert: true },
  )
}

export async function createDriver(
  vendorId: string,
  input: CreateDriverInput,
  actor: UserDocument,
): Promise<DriverDetail> {
  assertCanManageVendor(vendorId, actor)

  const vendor = await findVendorOr404(vendorId)

  const key = nameKey(input.name)
  if (!key) {
    throw new AppError(400, 'That driver name has no letters or digits in it.')
  }

  const mobileKey = normalizeMobile(input.mobile)
  await assertMobileFree(String(vendor._id), mobileKey)

  const driver = await DriverModel.create({
    driverCode: await allocateDriverCode(),
    vendorId: vendor._id,
    name: input.name,
    nameKey: key,
    mobile: input.mobile,
    mobileKey,
    nidNumber: input.nidNumber,
    // The NID key uses the registration normalisation rather than the name one:
    // a national ID is a code, so case and separators are noise and Bangla
    // letters have no business in it.
    nidKey: registrationKey(input.nidNumber),
    address: input.address,
    licenseNumber: input.licenseNumber,
    licenseExpiry: input.licenseExpiry,
    status: input.status ?? undefined,
    createdBy: actor._id,
  })

  await syncDriverLicence(driver, actor)

  await recordActivity({
    vendorId: vendor._id,
    action: 'driver.created',
    entityType: 'Driver',
    entityId: driver._id,
    entityLabel: driver.name,
    summary: `Driver ${driver.name} added as ${driver.driverCode}`,
    actor,
  })

  return serializeDetail(driver)
}

export async function updateDriver(
  id: string,
  input: UpdateDriverInput,
  actor: UserDocument,
): Promise<DriverDetail> {
  const driver = await findDriverOr404(id)
  assertCanManageVendor(String(driver.vendorId), actor)

  if (input.name !== undefined) {
    const key = nameKey(input.name)
    if (!key) {
      throw new AppError(400, 'That driver name has no letters or digits in it.')
    }
    driver.name = input.name
    driver.nameKey = key
  }

  if (input.mobile !== undefined) {
    const mobileKey = normalizeMobile(input.mobile)
    await assertMobileFree(String(driver.vendorId), mobileKey, String(driver._id))
    driver.mobile = input.mobile
    driver.mobileKey = mobileKey
  }

  if (input.nidNumber !== undefined) {
    driver.nidNumber = input.nidNumber
    driver.nidKey = registrationKey(input.nidNumber)
  }

  if (input.address !== undefined) {
    driver.address = input.address
  }

  const licenceChanged = input.licenseNumber !== undefined || input.licenseExpiry !== undefined

  if (input.licenseNumber !== undefined) {
    driver.licenseNumber = input.licenseNumber
  }
  if (input.licenseExpiry !== undefined) {
    driver.licenseExpiry = input.licenseExpiry
  }

  /**
   * The same rule the create schema enforces, restated here because a partial
   * update can reach it from the other side: clearing the licence number while
   * leaving an expiry behind would leave a deadline attached to nothing.
   */
  if (driver.licenseExpiry && !driver.licenseNumber) {
    throw new AppError(400, 'Add the licence number the expiry date belongs to.')
  }

  driver.updatedBy = actor._id
  await driver.save()

  if (licenceChanged) {
    await syncDriverLicence(driver, actor)
  }

  await recordActivity({
    vendorId: driver.vendorId,
    action: 'driver.updated',
    entityType: 'Driver',
    entityId: driver._id,
    entityLabel: driver.name,
    summary: `Driver ${driver.name} updated (${Object.keys(input).join(', ')})`,
    actor,
  })

  return serializeDetail(driver)
}

/**
 * Changing a driver's state.
 *
 * Like a vehicle's status, this does **not** close an active assignment. A
 * driver going on leave on Tuesday does not mean nobody was driving on Monday,
 * and silently ending the assignment would rewrite history. What it decides is
 * whether they may be given a *new* one — see `driverAcceptsAssignment`.
 */
export async function changeDriverStatus(
  id: string,
  input: DriverStatusInput,
  actor: UserDocument,
): Promise<DriverDetail> {
  const driver = await findDriverOr404(id)
  assertCanManageVendor(String(driver.vendorId), actor)

  const current = driver.status as DriverStatus

  if (current === input.status) {
    throw new AppError(409, `This driver is already ${input.status}.`)
  }

  driver.status = input.status
  driver.statusChangedAt = new Date()
  driver.statusChangedBy = actor._id
  driver.statusNote = input.status === 'Active' ? null : (input.note ?? null)
  driver.updatedBy = actor._id
  await driver.save()

  await recordActivity({
    vendorId: driver.vendorId,
    action: 'driver.status',
    entityType: 'Driver',
    entityId: driver._id,
    entityLabel: driver.name,
    summary: `Driver ${driver.name} moved from ${current} to ${input.status}`,
    actor,
  })

  return serializeDetail(driver)
}

export async function setDriverPhoto(
  id: string,
  buffer: Buffer,
  actor: UserDocument,
): Promise<DriverDetail> {
  const driver = await findDriverOr404(id)
  assertCanManageVendor(String(driver.vendorId), actor)

  const previousKey = driver.photoKey
  const uploaded = await uploadVendorPhoto(buffer, 'drivers')

  driver.photoUrl = uploaded.url
  driver.photoKey = uploaded.key
  driver.updatedBy = actor._id

  try {
    await driver.save()
  } catch (error) {
    await discardVendorObject(uploaded.key)
    throw error
  }

  await discardVendorObject(previousKey)

  return serializeDetail(driver)
}

export async function clearDriverPhoto(
  id: string,
  actor: UserDocument,
): Promise<DriverDetail> {
  const driver = await findDriverOr404(id)
  assertCanManageVendor(String(driver.vendorId), actor)

  if (!driver.photoUrl && !driver.photoKey) {
    throw new AppError(409, 'There is no driver photo to remove.')
  }

  const previousKey = driver.photoKey
  driver.photoUrl = null
  driver.photoKey = null
  driver.updatedBy = actor._id
  await driver.save()

  await discardVendorObject(previousKey)

  return serializeDetail(driver)
}

export interface DriverRemoval {
  id: string
  assignments: number
  documents: number
}

/**
 * Removing a driver. The same reasoning as removing a vehicle: an assignment
 * whose driver is gone is a sentence with its subject removed, so the
 * assignments go too, and the activity log keeps the name as a copy so the
 * history still reads.
 */
export async function removeDriver(id: string, actor: UserDocument): Promise<DriverRemoval> {
  const driver = await findDriverOr404(id)
  assertCanManageVendor(String(driver.vendorId), actor)

  const documents = await VendorDocumentModel.find({
    ownerType: 'Driver',
    ownerId: driver._id,
  }).select('attachment')

  const assignments = await AssignmentModel.countDocuments({ driverId: driver._id })

  await AssignmentModel.deleteMany({ driverId: driver._id })
  await VendorDocumentModel.deleteMany({ ownerType: 'Driver', ownerId: driver._id })
  await driver.deleteOne()

  await discardVendorObject(driver.photoKey)
  for (const document of documents) {
    await discardVendorObject(document.attachment?.key)
  }

  await recordActivity({
    vendorId: driver.vendorId,
    action: 'driver.deleted',
    entityType: 'Driver',
    entityId: null,
    entityLabel: driver.name,
    summary: `Driver ${driver.name} removed, with ${assignments} assignment${
      assignments === 1 ? '' : 's'
    } and ${documents.length} document${documents.length === 1 ? '' : 's'}`,
    actor,
  })

  return { id: String(driver._id), assignments, documents: documents.length }
}

/** Drivers a new assignment may name — the ones that may actually take one. */
export async function listAssignableDrivers(
  vendorId: string,
  viewer: UserDocument,
): Promise<DriverRecord[]> {
  assertCanReadVendor(vendorId, viewer)

  const records = await DriverModel.find({ vendorId, status: 'Active' })
    .sort({ name: 1 })
    .limit(200)

  return serializeMany(records)
}
