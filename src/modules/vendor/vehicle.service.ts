import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { AssignmentModel } from './assignment.model'
import { VehicleModel } from './vehicle.model'
import type { Vehicle, VehicleDocument } from './vehicle.model'
import { VendorDocumentModel } from './vendor-document.model'
import { VendorModel } from './vendor.model'
import { assertCanManageVendor, assertCanReadVendor } from './vendor.access'
import { recordActivity } from './vendor.activity'
import { registrationKey } from './vendor.constants'
import type { VehicleStatus } from './vendor.constants'
import { allocateVehicleCode } from './vendor.counter'
import {
  currentDriversFor,
  documentTalliesFor,
  escapeRegex,
  findVehicleOr404,
  findVendorOr404,
  resolveActorNames,
  tallyFor,
} from './vendor.lookups'
import { toVehicleRecord } from './vendor.serializer'
import type { VehicleRecord } from './vendor.serializer'
import { discardVendorObject } from './vendor.storage'
import type {
  CreateVehicleInput,
  ListVehiclesQuery,
  UpdateVehicleInput,
  VehicleStatusInput,
} from './vendor.validation'

/**
 * A vendor's fleet.
 *
 * Every function takes the authenticated profile and scopes on the vehicle's
 * own `vendorId` — never on a vendor id from a request body, which is why
 * neither the create schema nor the update schema has one. A vehicle's owner
 * comes from the URL when it is created and is never editable afterwards: a
 * transfer between vendors would strand the assignment history on the far side
 * of a relationship that no longer exists, so it is a controlled operation
 * (retire one record, create another) rather than a field on a form.
 */

export interface ListVehiclesResult {
  records: VehicleRecord[]
  total: number
}

/**
 * Serializes a page of vehicles with everything a row needs: who is driving it,
 * and how its papers stand.
 *
 * Three lookups for the whole page rather than three per row. That is what lets
 * the model carry no `currentDriverId` — the denormalisation would have bought
 * one query and cost a second source of truth about who was driving, which is
 * exactly what destroys assignment history.
 */
async function serializeMany(records: VehicleDocument[]): Promise<VehicleRecord[]> {
  if (records.length === 0) {
    return []
  }

  const ids = records.map((record) => record._id)

  const [drivers, tallies, names] = await Promise.all([
    currentDriversFor(ids),
    documentTalliesFor('Vehicle', ids),
    resolveActorNames(records.flatMap((record) => [record.createdBy, record.updatedBy])),
  ])

  return records.map((record) =>
    toVehicleRecord(
      record,
      names,
      drivers.get(String(record._id)) ?? null,
      tallyFor(tallies, record._id),
    ),
  )
}

async function serialize(record: VehicleDocument): Promise<VehicleRecord> {
  const [only] = await serializeMany([record])
  return only
}

function buildFilter(vendorId: string, query: ListVehiclesQuery): QueryFilter<Vehicle> {
  const clauses: QueryFilter<Vehicle>[] = [{ vendorId }]

  if (query.status !== 'all') {
    clauses.push({ status: query.status })
  }

  if (query.ownershipType !== 'all') {
    clauses.push({ ownershipType: query.ownershipType })
  }

  if (query.brand) {
    clauses.push({ brand: new RegExp(escapeRegex(query.brand), 'i') })
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    // The plate as typed, its normalised form, and the two descriptive fields.
    // Matching the key too is what makes "DHAKA METRO TA 11 1234" find a
    // vehicle stored as "DHAKA METRO-TA-11-1234".
    clauses.push({
      $or: [
        { registrationNo: pattern },
        { registrationNoKey: new RegExp(escapeRegex(registrationKey(query.search)), 'i') },
        { vehicleCode: pattern },
        { brand: pattern },
        { vehicleModel: pattern },
      ],
    })
  }

  return { $and: clauses }
}

export async function listVehicles(
  vendorId: string,
  query: ListVehiclesQuery,
  viewer: UserDocument,
): Promise<ListVehiclesResult> {
  assertCanReadVendor(vendorId, viewer)

  const filter = buildFilter(vendorId, query)
  const skip = (query.page - 1) * query.limit

  const [records, total] = await Promise.all([
    VehicleModel.find(filter).sort({ registrationNo: 1 }).skip(skip).limit(query.limit),
    VehicleModel.countDocuments(filter),
  ])

  return { records: await serializeMany(records), total }
}

export async function getVehicle(id: string, viewer: UserDocument): Promise<VehicleRecord> {
  const vehicle = await findVehicleOr404(id)
  assertCanReadVendor(String(vehicle.vendorId), viewer)
  return serialize(vehicle)
}

/**
 * Whether a registration number is already on record.
 *
 * Unlike the deliberately unconstrained keys in Gate Pass, this one is a
 * confirmed invariant: a plate identifies one physical vehicle, so the same
 * plate under two vendors is either a typo or a transfer that was not carried
 * out. The check names the vendor holding it rather than reporting a bare
 * conflict, because "already registered" is useless information and "already
 * registered to Malek Transport as VH-0012" is what somebody can act on.
 */
async function assertRegistrationFree(key: string, exceptId?: string): Promise<void> {
  const clash = await VehicleModel.findOne({
    registrationNoKey: key,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select('vehicleCode registrationNo vendorId')

  if (!clash) {
    return
  }

  const owner = await VendorModel.findById(clash.vendorId).select('name')

  throw new AppError(
    409,
    `${clash.registrationNo} is already recorded as ${clash.vehicleCode}${
      owner ? ` under ${owner.name}` : ''
    }. Retire that record before adding the vehicle again.`,
  )
}

export async function createVehicle(
  vendorId: string,
  input: CreateVehicleInput,
  actor: UserDocument,
): Promise<VehicleRecord> {
  assertCanManageVendor(vendorId, actor)

  // Proves the vendor exists before a code is burned on a vehicle for it.
  const vendor = await findVendorOr404(vendorId)

  const key = registrationKey(input.registrationNo)
  if (!key) {
    throw new AppError(400, 'That registration number has no letters or digits in it.')
  }
  await assertRegistrationFree(key)

  const vehicle = await VehicleModel.create({
    vehicleCode: await allocateVehicleCode(),
    vendorId: vendor._id,
    registrationNo: input.registrationNo,
    registrationNoKey: key,
    brand: input.brand,
    vehicleModel: input.model,
    ownershipType: input.ownershipType,
    status: input.status ?? undefined,
    createdBy: actor._id,
  })

  await recordActivity({
    vendorId: vendor._id,
    action: 'vehicle.created',
    entityType: 'Vehicle',
    entityId: vehicle._id,
    entityLabel: vehicle.registrationNo,
    summary: `Vehicle ${vehicle.registrationNo} added (${vehicle.ownershipType})`,
    actor,
  })

  return serialize(vehicle)
}

export async function updateVehicle(
  id: string,
  input: UpdateVehicleInput,
  actor: UserDocument,
): Promise<VehicleRecord> {
  const vehicle = await findVehicleOr404(id)
  assertCanManageVendor(String(vehicle.vendorId), actor)

  if (input.registrationNo !== undefined) {
    const key = registrationKey(input.registrationNo)
    if (!key) {
      throw new AppError(400, 'That registration number has no letters or digits in it.')
    }
    await assertRegistrationFree(key, String(vehicle._id))
    vehicle.registrationNo = input.registrationNo
    vehicle.registrationNoKey = key
  }

  if (input.brand !== undefined) {
    vehicle.brand = input.brand
  }
  if (input.model !== undefined) {
    vehicle.vehicleModel = input.model
  }
  if (input.ownershipType !== undefined) {
    vehicle.ownershipType = input.ownershipType
  }

  vehicle.updatedBy = actor._id
  await vehicle.save()

  await recordActivity({
    vendorId: vehicle.vendorId,
    action: 'vehicle.updated',
    entityType: 'Vehicle',
    entityId: vehicle._id,
    entityLabel: vehicle.registrationNo,
    summary: `Vehicle ${vehicle.registrationNo} updated (${Object.keys(input).join(', ')})`,
    actor,
  })

  return serialize(vehicle)
}

/**
 * Changing a vehicle's operational state.
 *
 * Taking a vehicle out of service does **not** close its active assignment.
 * That is deliberate: a lorry going into the workshop on Tuesday does not mean
 * nobody was driving it on Monday, and silently ending the assignment would
 * rewrite the history somebody would later read. What the status does decide is
 * whether a *new* driver may be put on it — see `vehicleAcceptsDriver`.
 */
export async function changeVehicleStatus(
  id: string,
  input: VehicleStatusInput,
  actor: UserDocument,
): Promise<VehicleRecord> {
  const vehicle = await findVehicleOr404(id)
  assertCanManageVendor(String(vehicle.vendorId), actor)

  const current = vehicle.status as VehicleStatus

  if (current === input.status) {
    throw new AppError(409, `This vehicle is already ${input.status}.`)
  }

  vehicle.status = input.status
  vehicle.statusChangedAt = new Date()
  vehicle.statusChangedBy = actor._id
  vehicle.statusNote = input.status === 'Active' ? null : (input.note ?? null)
  vehicle.updatedBy = actor._id
  await vehicle.save()

  await recordActivity({
    vendorId: vehicle.vendorId,
    action: 'vehicle.status',
    entityType: 'Vehicle',
    entityId: vehicle._id,
    entityLabel: vehicle.registrationNo,
    summary: `Vehicle ${vehicle.registrationNo} moved from ${current} to ${input.status}`,
    actor,
  })

  return serialize(vehicle)
}

export interface VehicleRemoval {
  id: string
  assignments: number
  documents: number
}

/**
 * Removing a vehicle.
 *
 * Unlike a vendor this is always a real deletion, and the assignments go with
 * it. The reasoning is the opposite of the vendor case rather than an
 * inconsistency: an assignment's whole meaning is "this driver was on *this
 * vehicle*", so an assignment whose vehicle is gone is not history that has
 * lost some context — it is a sentence with its subject removed. Keeping those
 * rows would leave the assignments tab showing periods against a blank.
 *
 * What survives is the activity log, which carries the registration number as a
 * copy rather than a reference precisely so it still reads afterwards.
 *
 * The documents go last and their objects go after that, so the worst outcome
 * of a failure is an orphan in the bucket rather than a live reference to a
 * deleted file — the order every module here uses.
 */
export async function removeVehicle(
  id: string,
  actor: UserDocument,
): Promise<VehicleRemoval> {
  const vehicle = await findVehicleOr404(id)
  assertCanManageVendor(String(vehicle.vendorId), actor)

  const documents = await VendorDocumentModel.find({
    ownerType: 'Vehicle',
    ownerId: vehicle._id,
  }).select('attachment')

  const assignments = await AssignmentModel.countDocuments({ vehicleId: vehicle._id })

  await AssignmentModel.deleteMany({ vehicleId: vehicle._id })
  await VendorDocumentModel.deleteMany({ ownerType: 'Vehicle', ownerId: vehicle._id })
  await vehicle.deleteOne()

  for (const document of documents) {
    await discardVendorObject(document.attachment?.key)
  }

  await recordActivity({
    vendorId: vehicle.vendorId,
    action: 'vehicle.deleted',
    entityType: 'Vehicle',
    entityId: null,
    entityLabel: vehicle.registrationNo,
    summary: `Vehicle ${vehicle.registrationNo} removed, with ${assignments} assignment${
      assignments === 1 ? '' : 's'
    } and ${documents.length} document${documents.length === 1 ? '' : 's'}`,
    actor,
  })

  return { id: String(vehicle._id), assignments, documents: documents.length }
}

/**
 * Vehicles for a selector — the assignment form's list.
 *
 * Narrowed to the ones that may actually take a driver, so the form cannot
 * offer a vehicle the API would then refuse. It is the same instinct
 * `listVendorOptions` follows: an option nobody may choose is a dead end with a
 * 409 at the end of it.
 */
export async function listAssignableVehicles(
  vendorId: string,
  viewer: UserDocument,
): Promise<VehicleRecord[]> {
  assertCanReadVendor(vendorId, viewer)

  const records = await VehicleModel.find({ vendorId, status: 'Active' })
    .sort({ registrationNo: 1 })
    .limit(200)

  return serializeMany(records)
}
