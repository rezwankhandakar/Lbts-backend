import mongoose from 'mongoose'
import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { AssignmentModel } from './assignment.model'
import type { Assignment, AssignmentDocument } from './assignment.model'
import type { DriverDocument } from './driver.model'
import type { VehicleDocument } from './vehicle.model'
import { assertCanManageVendor, assertCanReadVendor } from './vendor.access'
import { recordActivity } from './vendor.activity'
import {
  driverAcceptsAssignment,
  startOfUtcDay,
  vehicleAcceptsDriver,
  vendorAcceptsAssignments,
} from './vendor.constants'
import type { DriverStatus, VehicleStatus, VendorStatus } from './vendor.constants'
import { closeBefore, isForwardRange, rangesOverlap } from './assignment.rules'
import {
  findDriverOr404,
  findVehicleOr404,
  findVendorOr404,
  referencedVehiclesAndDrivers,
  resolveActorNames,
} from './vendor.lookups'
import { toAssignmentRecord } from './vendor.serializer'
import type { AssignmentRecord } from './vendor.serializer'
import type {
  CreateAssignmentInput,
  EndAssignmentInput,
  ListAssignmentsQuery,
} from './vendor.validation'

/**
 * Who is driving what, and who was.
 *
 * This is the module's most rule-heavy service, and every rule here exists
 * because the alternative is a record that quietly lies. The vehicle carries no
 * driver and the driver carries no vehicle, so this collection is the only
 * thing that knows — which means it has to be right rather than approximately
 * right.
 */

export interface ListAssignmentsResult {
  records: AssignmentRecord[]
  total: number
}

/**
 * Raised when a request would displace a live assignment without saying so.
 *
 * A refusal carrying the thing it refused, in the same shape
 * `DuplicateGatePassError` uses: the client needs the current assignment to be
 * able to say "Rahim will become the active driver; the assignment with Karim
 * will be closed", and asking again with `replaceActive` is the confirmation.
 * Silently changing who is driving a vehicle is the one thing this module must
 * never do.
 */
export class ActiveAssignmentError extends Error {
  public readonly statusCode = 409
  public readonly current: AssignmentRecord

  constructor(message: string, current: AssignmentRecord) {
    super(message)
    this.name = 'ActiveAssignmentError'
    this.current = current
  }
}

async function serializeMany(records: AssignmentDocument[]): Promise<AssignmentRecord[]> {
  if (records.length === 0) {
    return []
  }

  const [{ vehicles, drivers }, names] = await Promise.all([
    referencedVehiclesAndDrivers(
      records.map((record) => record.vehicleId),
      records.map((record) => record.driverId),
    ),
    resolveActorNames(records.flatMap((record) => [record.createdBy, record.endedBy])),
  ])

  return records.map((record) => toAssignmentRecord(record, names, vehicles, drivers))
}

async function serialize(record: AssignmentDocument): Promise<AssignmentRecord> {
  const [only] = await serializeMany([record])
  return only
}

function buildFilter(vendorId: string, query: ListAssignmentsQuery): QueryFilter<Assignment> {
  const clauses: QueryFilter<Assignment>[] = [{ vendorId }]

  if (query.status !== 'all') {
    clauses.push({ status: query.status })
  }
  if (query.vehicleId) {
    clauses.push({ vehicleId: query.vehicleId })
  }
  if (query.driverId) {
    clauses.push({ driverId: query.driverId })
  }

  /**
   * A date filter asks "which assignments were in force during this window",
   * not "which started in it" — an assignment that began in July and is still
   * running is part of September, and a naive filter on `assignedFrom` would
   * hide exactly the one somebody was looking for.
   *
   * That is the overlap test from `assignment.rules.ts`, written as a query: an
   * assignment matches when it started on or before the end of the window and
   * had not ended before the start of it. An open-ended assignment has a null
   * end, which is why the second clause is an `$or`.
   */
  if (query.to) {
    clauses.push({ assignedFrom: { $lte: query.to } })
  }
  if (query.from) {
    clauses.push({
      $or: [{ assignedUntil: null }, { assignedUntil: { $gte: query.from } }],
    })
  }

  return { $and: clauses }
}

export async function listAssignments(
  vendorId: string,
  query: ListAssignmentsQuery,
  viewer: UserDocument,
): Promise<ListAssignmentsResult> {
  assertCanReadVendor(vendorId, viewer)

  const filter = buildFilter(vendorId, query)
  const skip = (query.page - 1) * query.limit

  const [records, total] = await Promise.all([
    /**
     * Active first, then by start date descending. The active row is the one
     * somebody opened this tab for; the history below it reads backwards from
     * now, which is how anybody reads a history.
     */
    AssignmentModel.find(filter)
      .sort({ status: 1, assignedFrom: -1 })
      .skip(skip)
      .limit(query.limit),
    AssignmentModel.countDocuments(filter),
  ])

  return { records: await serializeMany(records), total }
}

/** One vehicle's whole history, for the vehicle detail panel. */
export async function listVehicleAssignments(
  vehicleId: string,
  viewer: UserDocument,
): Promise<AssignmentRecord[]> {
  const vehicle = await findVehicleOr404(vehicleId)
  assertCanReadVendor(String(vehicle.vendorId), viewer)

  const records = await AssignmentModel.find({ vehicleId: vehicle._id })
    .sort({ assignedFrom: -1 })
    .limit(100)

  return serializeMany(records)
}

/** One driver's whole history, for the driver detail panel. */
export async function listDriverAssignments(
  driverId: string,
  viewer: UserDocument,
): Promise<AssignmentRecord[]> {
  const driver = await findDriverOr404(driverId)
  assertCanReadVendor(String(driver.vendorId), viewer)

  const records = await AssignmentModel.find({ driverId: driver._id })
    .sort({ assignedFrom: -1 })
    .limit(100)

  return serializeMany(records)
}

/**
 * Everything that has to be true before a driver may be put on a vehicle.
 *
 * All of it is checked server-side and none of it is merely prompted for. The
 * order is deliberate: the relationship rules come before the lifecycle ones,
 * because "this driver does not work for this vendor" is a different kind of
 * wrong from "this driver is on leave" and reporting the second when the first
 * is also true would send somebody to change a status that would not help.
 */
function assertAssignable(
  vendorStatus: VendorStatus,
  vehicle: VehicleDocument,
  driver: DriverDocument,
  vendorId: string,
): void {
  /**
   * The cross-vendor rule, and it is checked on both sides rather than on one.
   * A vehicle from Vendor A carrying a driver from Vendor B is not a slightly
   * wrong record — it is a claim about who is responsible for a load, and it is
   * the claim an insurer reads.
   */
  if (String(vehicle.vendorId) !== vendorId) {
    throw new AppError(400, 'That vehicle belongs to a different vendor.')
  }
  if (String(driver.vendorId) !== vendorId) {
    throw new AppError(400, 'That driver belongs to a different vendor.')
  }

  if (!vendorAcceptsAssignments(vendorStatus)) {
    throw new AppError(
      409,
      `This vendor is ${vendorStatus} and cannot take new assignments. Reactivate the vendor first.`,
    )
  }

  if (!vehicleAcceptsDriver(vehicle.status as VehicleStatus)) {
    throw new AppError(
      409,
      `${vehicle.registrationNo} is ${vehicle.status} and cannot be given a driver.`,
    )
  }

  if (!driverAcceptsAssignment(driver.status as DriverStatus)) {
    throw new AppError(409, `${driver.name} is ${driver.status} and cannot be assigned.`)
  }
}

/**
 * Whether the proposed period collides with anything already on record.
 *
 * Checked for the vehicle and for the driver, over *every* status rather than
 * the active ones — an assignment that ended in August still occupied August,
 * and letting a second one be back-filled over it would produce a history in
 * which two drivers held the same vehicle at once. The arithmetic is
 * `rangesOverlap`, tested on its own.
 *
 * The active row is excluded here when the caller has asked to replace it,
 * because it is about to be closed the day before the new one starts and
 * closing it is what removes the overlap.
 */
async function assertNoOverlap(
  vehicleId: string,
  driverId: string,
  range: { from: Date; until: Date | null },
  ignoreAssignmentId: string | null,
): Promise<void> {
  const existing = await AssignmentModel.find({
    $or: [{ vehicleId }, { driverId }],
    ...(ignoreAssignmentId ? { _id: { $ne: ignoreAssignmentId } } : {}),
  })

  for (const row of existing) {
    if (!rangesOverlap(range, { from: row.assignedFrom, until: row.assignedUntil ?? null })) {
      continue
    }

    const subject = String(row.vehicleId) === String(vehicleId) ? 'vehicle' : 'driver'
    const until = row.assignedUntil
      ? row.assignedUntil.toISOString().slice(0, 10)
      : 'now'

    throw new AppError(
      409,
      `That period overlaps an assignment already on record for this ${subject} (${row.assignedFrom
        .toISOString()
        .slice(0, 10)} to ${until}).`,
    )
  }
}

/**
 * Putting a driver on a vehicle.
 *
 * The interesting part is what happens when the vehicle already has one. The
 * module takes the "close the previous assignment" route rather than "refuse
 * until it is closed", because the second makes the ordinary case — a
 * changeover — into two operations with a window in between where the vehicle
 * has no driver at all. What makes it safe is that it is never silent: a
 * request that would displace a live assignment and does not carry
 * `replaceActive` is refused with the assignment it would have closed, so the
 * client says so and asks again.
 *
 * Both writes run in one transaction. This is a genuinely multi-document write
 * — close one row, open another — and CLAUDE.md asks for a transaction there;
 * the partial unique index on active assignments is the floor underneath, so
 * even a caller who found a way around this function cannot leave two.
 */
export async function createAssignment(
  vendorId: string,
  input: CreateAssignmentInput,
  actor: UserDocument,
): Promise<AssignmentRecord> {
  assertCanManageVendor(vendorId, actor)

  const vendor = await findVendorOr404(vendorId)
  const [vehicle, driver] = await Promise.all([
    findVehicleOr404(input.vehicleId),
    findDriverOr404(input.driverId),
  ])

  assertAssignable(vendor.status as VendorStatus, vehicle, driver, String(vendor._id))

  const range = {
    from: startOfUtcDay(input.assignedFrom),
    until: input.assignedUntil ? startOfUtcDay(input.assignedUntil) : null,
  }

  if (!isForwardRange(range)) {
    throw new AppError(400, 'The end date cannot be before the start date.')
  }

  const active = await AssignmentModel.findOne({ vehicleId: vehicle._id, status: 'Active' })

  if (active && !input.replaceActive) {
    throw new ActiveAssignmentError(
      `${vehicle.registrationNo} already has an active driver.`,
      await serialize(active),
    )
  }

  /**
   * The driver side has no database index behind it, unlike the vehicle side,
   * and that asymmetry is deliberate. "One active driver per vehicle" is a rule
   * the business stated; "one vehicle per driver at a time" is one this system
   * infers, and the Gate Pass module's lesson about unique indexes is to
   * constrain only what has been confirmed. So it is refused here with a
   * message naming the vehicle, and it can be relaxed without a migration.
   */
  const driverActive = await AssignmentModel.findOne({
    driverId: driver._id,
    status: 'Active',
    ...(active ? { _id: { $ne: active._id } } : {}),
  })

  if (driverActive) {
    const other = await findVehicleOr404(String(driverActive.vehicleId))
    throw new AppError(
      409,
      `${driver.name} is already the active driver of ${other.registrationNo}. End that assignment first.`,
    )
  }

  await assertNoOverlap(
    String(vehicle._id),
    String(driver._id),
    range,
    active && input.replaceActive ? String(active._id) : null,
  )

  const session = await mongoose.startSession()
  let created: AssignmentDocument

  try {
    created = await session.withTransaction(async () => {
      if (active && input.replaceActive) {
        active.status = 'Ended'
        active.assignedUntil = closeBefore(active.assignedFrom, range.from)
        active.endedAt = new Date()
        active.endedBy = actor._id
        active.updatedBy = actor._id
        active.note =
          active.note ?? `Closed when ${driver.name} took over ${vehicle.registrationNo}.`
        await active.save({ session })
      }

      const [row] = await AssignmentModel.create(
        [
          {
            vendorId: vendor._id,
            vehicleId: vehicle._id,
            driverId: driver._id,
            assignedFrom: range.from,
            assignedUntil: range.until,
            /**
             * An assignment with an end date already in the past is history the
             * moment it is written — back-filling last month's changeover is a
             * legitimate thing to do, and calling the result `Active` would put
             * a finished period at the top of the list forever.
             */
            status:
              range.until && range.until.getTime() < startOfUtcDay(new Date()).getTime()
                ? 'Ended'
                : 'Active',
            note: input.note ?? null,
            createdBy: actor._id,
          },
        ],
        { session },
      )

      return row
    })
  } finally {
    await session.endSession()
  }

  await recordActivity({
    vendorId: vendor._id,
    action: 'assignment.created',
    entityType: 'Assignment',
    entityId: created._id,
    entityLabel: `${vehicle.registrationNo} / ${driver.name}`,
    summary:
      active && input.replaceActive
        ? `${driver.name} assigned to ${vehicle.registrationNo}, replacing the previous driver`
        : `${driver.name} assigned to ${vehicle.registrationNo}`,
    actor,
  })

  return serialize(created)
}

/**
 * Closing an assignment.
 *
 * The end date defaults to today, because the ordinary case is "he came off the
 * vehicle this morning" and making somebody type today's date is friction with
 * a typo in it. It may not be earlier than the start — an assignment that ran
 * backwards is not history, it is a mistake — and the row keeps everything
 * else it had.
 */
export async function endAssignment(
  id: string,
  input: EndAssignmentInput,
  actor: UserDocument,
): Promise<AssignmentRecord> {
  const assignment = await AssignmentModel.findById(id)
  if (!assignment) {
    throw new AppError(404, 'Assignment not found.')
  }

  assertCanManageVendor(String(assignment.vendorId), actor)

  if (assignment.status === 'Ended') {
    throw new AppError(409, 'That assignment has already ended.')
  }

  const until = startOfUtcDay(input.assignedUntil ?? new Date())

  if (until.getTime() < startOfUtcDay(assignment.assignedFrom).getTime()) {
    throw new AppError(400, 'The end date cannot be before the assignment started.')
  }

  assignment.status = 'Ended'
  assignment.assignedUntil = until
  assignment.endedAt = new Date()
  assignment.endedBy = actor._id
  assignment.updatedBy = actor._id
  if (input.note) {
    assignment.note = input.note
  }
  await assignment.save()

  const record = await serialize(assignment)

  await recordActivity({
    vendorId: assignment.vendorId,
    action: 'assignment.ended',
    entityType: 'Assignment',
    entityId: assignment._id,
    entityLabel: `${record.vehicle?.registrationNo ?? 'Vehicle'} / ${record.driver?.name ?? 'Driver'}`,
    summary: `Assignment ended on ${until.toISOString().slice(0, 10)}`,
    actor,
  })

  return record
}

/**
 * Deleting an assignment.
 *
 * The narrow escape hatch for a row that should never have existed — a
 * changeover recorded against the wrong vehicle, typed and saved. It is **not**
 * how an assignment finishes: ending one is `endAssignment`, and a period that
 * genuinely ran is history the operation may need, so deleting it would destroy
 * exactly what this collection is for.
 *
 * Nothing distinguishes the two cases automatically, which is why deleting is
 * confined to the roles that manage the vendor and why the client asks a
 * question that says what it is for.
 */
export async function removeAssignment(
  id: string,
  actor: UserDocument,
): Promise<{ id: string }> {
  const assignment = await AssignmentModel.findById(id)
  if (!assignment) {
    throw new AppError(404, 'Assignment not found.')
  }

  assertCanManageVendor(String(assignment.vendorId), actor)

  const record = await serialize(assignment)
  await assignment.deleteOne()

  await recordActivity({
    vendorId: assignment.vendorId,
    action: 'assignment.deleted',
    entityType: 'Assignment',
    entityId: null,
    entityLabel: `${record.vehicle?.registrationNo ?? 'Vehicle'} / ${record.driver?.name ?? 'Driver'}`,
    summary: `Assignment record removed (${record.assignedFrom} to ${
      record.assignedUntil ?? 'open'
    })`,
    actor,
  })

  return { id: String(assignment._id) }
}
