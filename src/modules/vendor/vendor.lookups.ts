import type { Types } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { UserModel } from '../user/user.model'
import { AssignmentModel } from './assignment.model'
import { DriverModel } from './driver.model'
import type { DriverDocument } from './driver.model'
import { VehicleModel } from './vehicle.model'
import type { VehicleDocument } from './vehicle.model'
import { VendorDocumentModel } from './vendor-document.model'
import { VendorModel } from './vendor.model'
import type { VendorDocument } from './vendor.model'
import { DOCUMENT_EXPIRY_SOON_DAYS, startOfUtcDay } from './vendor.constants'
import { EMPTY_TALLY } from './vendor.serializer'
import type { CurrentDriverRef, CurrentVehicleRef, DocumentTally } from './vendor.serializer'

/**
 * The reads more than one service needs.
 *
 * Everything here is shaped around the same constraint: M0 pays for every round
 * trip, so a page of records resolves its references in one query per kind
 * rather than one per row. That is the treatment administration gives its actor
 * names, generalised — a page of twelve vehicles costs one lookup for the
 * drivers on them and one for their documents, not twenty-four.
 */

/** User input reaches a regex, so metacharacters must lose their meaning. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type IdLike = Types.ObjectId | string | null | undefined

/**
 * Resolves every actor referenced across a set of records in a single indexed
 * lookup. Returns id -> display name.
 */
export async function resolveActorNames(ids: IdLike[]): Promise<Map<string, string>> {
  const unique = new Set<string>()

  for (const id of ids) {
    if (id) {
      unique.add(String(id))
    }
  }

  if (unique.size === 0) {
    return new Map()
  }

  const actors = await UserModel.find({ _id: { $in: [...unique] } }).select('name')
  return new Map(actors.map((actor) => [String(actor._id), actor.name]))
}

/** The vendor behind an id, or a 404. Scope is checked by the caller. */
export async function findVendorOr404(id: string): Promise<VendorDocument> {
  const vendor = await VendorModel.findById(id)
  if (!vendor) {
    throw new AppError(404, 'Vendor not found.')
  }
  return vendor
}

export async function findVehicleOr404(id: string): Promise<VehicleDocument> {
  const vehicle = await VehicleModel.findById(id)
  if (!vehicle) {
    throw new AppError(404, 'Vehicle not found.')
  }
  return vehicle
}

export async function findDriverOr404(id: string): Promise<DriverDocument> {
  const driver = await DriverModel.findById(id)
  if (!driver) {
    throw new AppError(404, 'Driver not found.')
  }
  return driver
}

/**
 * Who is currently driving each of these vehicles.
 *
 * One query over the active assignments plus one over the drivers they name,
 * whatever the size of the page. This is what lets the vehicle model carry no
 * `currentDriverId` without the list paying for it — the assignment collection
 * stays the only thing that knows, and reading it is cheap.
 */
export async function currentDriversFor(
  vehicleIds: (Types.ObjectId | string)[],
): Promise<Map<string, CurrentDriverRef>> {
  if (vehicleIds.length === 0) {
    return new Map()
  }

  const assignments = await AssignmentModel.find({
    vehicleId: { $in: vehicleIds },
    status: 'Active',
  })

  if (assignments.length === 0) {
    return new Map()
  }

  const drivers = await DriverModel.find({
    _id: { $in: assignments.map((assignment) => assignment.driverId) },
  }).select('driverCode name mobile')

  const byId = new Map(drivers.map((driver) => [String(driver._id), driver]))
  const result = new Map<string, CurrentDriverRef>()

  for (const assignment of assignments) {
    const driver = byId.get(String(assignment.driverId))
    if (!driver) {
      // The driver was deleted while an assignment was still open. The row is
      // history rather than a live pairing, so the vehicle reads as unassigned.
      continue
    }

    result.set(String(assignment.vehicleId), {
      assignmentId: String(assignment._id),
      driverId: String(driver._id),
      driverCode: driver.driverCode,
      name: driver.name,
      mobile: driver.mobile,
      assignedFrom: assignment.assignedFrom.toISOString().slice(0, 10),
    })
  }

  return result
}

/** The mirror image: which vehicle each of these drivers is currently on. */
export async function currentVehiclesFor(
  driverIds: (Types.ObjectId | string)[],
): Promise<Map<string, CurrentVehicleRef>> {
  if (driverIds.length === 0) {
    return new Map()
  }

  const assignments = await AssignmentModel.find({
    driverId: { $in: driverIds },
    status: 'Active',
  })

  if (assignments.length === 0) {
    return new Map()
  }

  const vehicles = await VehicleModel.find({
    _id: { $in: assignments.map((assignment) => assignment.vehicleId) },
  }).select('vehicleCode registrationNo')

  const byId = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]))
  const result = new Map<string, CurrentVehicleRef>()

  for (const assignment of assignments) {
    const vehicle = byId.get(String(assignment.vehicleId))
    if (!vehicle) {
      continue
    }

    result.set(String(assignment.driverId), {
      assignmentId: String(assignment._id),
      vehicleId: String(vehicle._id),
      vehicleCode: vehicle.vehicleCode,
      registrationNo: vehicle.registrationNo,
      assignedFrom: assignment.assignedFrom.toISOString().slice(0, 10),
    })
  }

  return result
}

/** The boundary of the "expiring soon" window, as a pair of dates. */
export function expiryWindow(now: Date = new Date()): { today: Date; soon: Date } {
  const today = startOfUtcDay(now)
  return {
    today,
    soon: new Date(today.getTime() + DOCUMENT_EXPIRY_SOON_DAYS * 86_400_000),
  }
}

/**
 * How many documents each of these owners has, and in what state.
 *
 * One aggregation for a whole page. The three states are derived in the
 * pipeline from `expiryDate` rather than read off a stored column, which is the
 * same rule `documentStatusFor` applies in process — there is one definition of
 * "expiring soon" and both sides compute it from the window above.
 */
export async function documentTalliesFor(
  ownerType: 'Vehicle' | 'Driver',
  ownerIds: (Types.ObjectId | string)[],
  now: Date = new Date(),
): Promise<Map<string, DocumentTally>> {
  if (ownerIds.length === 0) {
    return new Map()
  }

  const { today, soon } = expiryWindow(now)

  const rows = await VendorDocumentModel.aggregate<{
    _id: Types.ObjectId
    total: number
    expired: number
    expiringSoon: number
  }>([
    { $match: { ownerType, ownerId: { $in: ownerIds } } },
    {
      $group: {
        _id: '$ownerId',
        total: { $sum: 1 },
        expired: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$expiryDate', null] },
                  { $lt: ['$expiryDate', today] },
                ],
              },
              1,
              0,
            ],
          },
        },
        expiringSoon: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$expiryDate', null] },
                  { $gte: ['$expiryDate', today] },
                  { $lte: ['$expiryDate', soon] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ])

  const result = new Map<string, DocumentTally>()

  for (const row of rows) {
    result.set(String(row._id), {
      total: row.total,
      expired: row.expired,
      expiringSoon: row.expiringSoon,
      // Derived rather than counted a third time: a document is valid exactly
      // when it is neither of the other two.
      valid: row.total - row.expired - row.expiringSoon,
    })
  }

  return result
}

export function tallyFor(
  tallies: Map<string, DocumentTally>,
  ownerId: Types.ObjectId | string,
): DocumentTally {
  return tallies.get(String(ownerId)) ?? EMPTY_TALLY
}

/**
 * The vehicles and drivers named by a page of assignments, as lookup maps.
 *
 * Two `$in` queries rather than a `populate` per row, for the reason every
 * other lookup in this file gives.
 */
export async function referencedVehiclesAndDrivers(
  vehicleIds: (Types.ObjectId | string)[],
  driverIds: (Types.ObjectId | string)[],
): Promise<{ vehicles: Map<string, VehicleDocument>; drivers: Map<string, DriverDocument> }> {
  const [vehicles, drivers] = await Promise.all([
    vehicleIds.length > 0 ? VehicleModel.find({ _id: { $in: vehicleIds } }) : Promise.resolve([]),
    driverIds.length > 0 ? DriverModel.find({ _id: { $in: driverIds } }) : Promise.resolve([]),
  ])

  return {
    vehicles: new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle])),
    drivers: new Map(drivers.map((driver) => [String(driver._id), driver])),
  }
}
