import type { Types } from 'mongoose'
import type { AssignmentDocument } from './assignment.model'
import type { DriverDocument } from './driver.model'
import type { VehicleDocument } from './vehicle.model'
import type { VendorActivityDocument } from './vendor-activity.model'
import type { VendorDocumentDocument } from './vendor-document.model'
import type { VendorDocument } from './vendor.model'
import {
  daysUntilExpiry,
  documentStatusFor,
  expiryPhrase,
} from './vendor.constants'
import type {
  ActivityAction,
  AssignmentStatus,
  DocumentOwnerType,
  DocumentStatus,
  DriverStatus,
  VehicleOwnershipType,
  VehicleStatus,
  VendorDocumentType,
  VendorStatus,
} from './vendor.constants'

/**
 * What each record looks like on the wire.
 *
 * Two rules run through the whole file. Comparison keys are never serialized —
 * they are a matching mechanism with no meaning to a client, and putting them
 * on the wire invites something to start matching on them in a browser, which
 * is the split brain the Location and Product Rate serializers refuse for the
 * same reason. And derived values are computed here rather than stored, so a
 * document's status can never disagree with the date beside it.
 */

export interface ActorRef {
  id: string
  name: string
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

/** A calendar day, as `YYYY-MM-DD`. Never an instant — see the models. */
function toDay(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

function actorFrom(
  id: Types.ObjectId | null | undefined,
  names: Map<string, string>,
): ActorRef | null {
  if (!id) {
    return null
  }
  const key = String(id)
  // An actor whose own account was deleted still leaves an id behind.
  return { id: key, name: names.get(key) ?? 'Removed account' }
}

// --- Vendor ----------------------------------------------------------------

export interface VendorRecord {
  id: string
  vendorCode: string
  name: string
  mobile: string
  address: string
  photoUrl: string | null
  status: VendorStatus
  statusNote: string | null
  statusChangedAt: string | null
  statusChangedBy: ActorRef | null
  /**
   * Fleet and compliance counts, when the caller asked for a list that carries
   * them. Absent on a single record, where the summary endpoint answers the
   * same question in more detail — a list needs four numbers per row and a
   * details page needs twelve, and computing twelve for a page of ten vendors
   * would be ten aggregations nobody reads.
   */
  counts?: VendorCounts
  createdBy: ActorRef | null
  updatedBy: ActorRef | null
  createdAt: string
  updatedAt: string
}

export interface VendorCounts {
  vehicles: number
  activeVehicles: number
  drivers: number
  activeDrivers: number
  /** Documents past their expiry date, and documents inside the warning window. */
  expiredDocuments: number
  expiringDocuments: number
}

export function toVendorRecord(
  vendor: VendorDocument,
  actorNames: Map<string, string>,
  counts?: VendorCounts,
): VendorRecord {
  return {
    id: String(vendor._id),
    vendorCode: vendor.vendorCode,
    name: vendor.name,
    mobile: vendor.mobile,
    address: vendor.address,
    photoUrl: vendor.photoUrl ?? null,
    status: vendor.status as VendorStatus,
    statusNote: vendor.statusNote ?? null,
    statusChangedAt: toIso(vendor.statusChangedAt),
    statusChangedBy: actorFrom(vendor.statusChangedBy, actorNames),
    ...(counts ? { counts } : {}),
    createdBy: actorFrom(vendor.createdBy, actorNames),
    updatedBy: actorFrom(vendor.updatedBy, actorNames),
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
  }
}

/** The vendor selector's shape: enough to choose one, and nothing heavier. */
export interface VendorOption {
  id: string
  vendorCode: string
  name: string
  status: VendorStatus
}

export function toVendorOption(vendor: VendorDocument): VendorOption {
  return {
    id: String(vendor._id),
    vendorCode: vendor.vendorCode,
    name: vendor.name,
    status: vendor.status as VendorStatus,
  }
}

// --- Vehicle ---------------------------------------------------------------

/**
 * The driver currently on a vehicle, resolved from the assignment collection.
 *
 * Not a stored field, deliberately — see the note on the vehicle model. The
 * list resolves it for a whole page in one indexed lookup, so a table of
 * twelve vehicles costs one extra query rather than twelve.
 */
export interface CurrentDriverRef {
  assignmentId: string
  driverId: string
  driverCode: string
  name: string
  mobile: string
  assignedFrom: string
}

export interface VehicleRecord {
  id: string
  vehicleCode: string
  vendorId: string
  registrationNo: string
  brand: string
  /** Stored as `vehicleModel`; `model` collides with Mongoose's own method. */
  model: string
  ownershipType: VehicleOwnershipType
  status: VehicleStatus
  statusNote: string | null
  currentDriver: CurrentDriverRef | null
  /** Compliance for this vehicle's own papers, so a row can carry a chip. */
  documents: DocumentTally
  createdBy: ActorRef | null
  updatedBy: ActorRef | null
  createdAt: string
  updatedAt: string
}

/** How many of a subject's documents are in each state. */
export interface DocumentTally {
  total: number
  valid: number
  expiringSoon: number
  expired: number
}

export const EMPTY_TALLY: DocumentTally = {
  total: 0,
  valid: 0,
  expiringSoon: 0,
  expired: 0,
}

export function toVehicleRecord(
  vehicle: VehicleDocument,
  actorNames: Map<string, string>,
  currentDriver: CurrentDriverRef | null,
  documents: DocumentTally,
): VehicleRecord {
  return {
    id: String(vehicle._id),
    vehicleCode: vehicle.vehicleCode,
    vendorId: String(vehicle.vendorId),
    registrationNo: vehicle.registrationNo,
    brand: vehicle.brand,
    model: vehicle.vehicleModel,
    ownershipType: vehicle.ownershipType as VehicleOwnershipType,
    status: vehicle.status as VehicleStatus,
    statusNote: vehicle.statusNote ?? null,
    currentDriver,
    documents,
    createdBy: actorFrom(vehicle.createdBy, actorNames),
    updatedBy: actorFrom(vehicle.updatedBy, actorNames),
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  }
}

// --- Driver ----------------------------------------------------------------

/**
 * A driver as a **list** sees them.
 *
 * The NID and the address are absent, and that is the point: a table of
 * eighteen drivers has no use for eighteen national ID numbers, and putting
 * them there spreads personal data across every screen that shows a fleet. The
 * detail shape below carries them, for the one driver somebody has opened.
 */
export interface DriverRecord {
  id: string
  driverCode: string
  vendorId: string
  name: string
  mobile: string
  photoUrl: string | null
  licenseNumber: string
  licenseExpiry: string | null
  /** "Expires in 12 days" — computed here so every surface says it the same way. */
  licenceStatus: DocumentStatus | null
  licencePhrase: string | null
  status: DriverStatus
  statusNote: string | null
  currentVehicle: CurrentVehicleRef | null
  documents: DocumentTally
  createdBy: ActorRef | null
  updatedBy: ActorRef | null
  createdAt: string
  updatedAt: string
}

/** The one driver somebody has opened, with the personal fields. */
export interface DriverDetail extends DriverRecord {
  nidNumber: string
  address: string
}

export interface CurrentVehicleRef {
  assignmentId: string
  vehicleId: string
  vehicleCode: string
  registrationNo: string
  assignedFrom: string
}

function licenceFields(driver: DriverDocument, now: Date) {
  if (!driver.licenseExpiry) {
    return { licenceStatus: null, licencePhrase: null }
  }

  return {
    licenceStatus: documentStatusFor(driver.licenseExpiry, now),
    licencePhrase: expiryPhrase(driver.licenseExpiry, now),
  }
}

export function toDriverRecord(
  driver: DriverDocument,
  actorNames: Map<string, string>,
  currentVehicle: CurrentVehicleRef | null,
  documents: DocumentTally,
  now: Date = new Date(),
): DriverRecord {
  return {
    id: String(driver._id),
    driverCode: driver.driverCode,
    vendorId: String(driver.vendorId),
    name: driver.name,
    mobile: driver.mobile,
    photoUrl: driver.photoUrl ?? null,
    licenseNumber: driver.licenseNumber,
    licenseExpiry: toDay(driver.licenseExpiry),
    ...licenceFields(driver, now),
    status: driver.status as DriverStatus,
    statusNote: driver.statusNote ?? null,
    currentVehicle,
    documents,
    createdBy: actorFrom(driver.createdBy, actorNames),
    updatedBy: actorFrom(driver.updatedBy, actorNames),
    createdAt: driver.createdAt.toISOString(),
    updatedAt: driver.updatedAt.toISOString(),
  }
}

export function toDriverDetail(
  driver: DriverDocument,
  actorNames: Map<string, string>,
  currentVehicle: CurrentVehicleRef | null,
  documents: DocumentTally,
  now: Date = new Date(),
): DriverDetail {
  return {
    ...toDriverRecord(driver, actorNames, currentVehicle, documents, now),
    nidNumber: driver.nidNumber,
    address: driver.address,
  }
}

// --- Assignment ------------------------------------------------------------

export interface AssignmentRecord {
  id: string
  vendorId: string
  vehicle: { id: string; vehicleCode: string; registrationNo: string } | null
  driver: { id: string; driverCode: string; name: string; mobile: string } | null
  assignedFrom: string
  assignedUntil: string | null
  status: AssignmentStatus
  note: string | null
  endedAt: string | null
  endedBy: ActorRef | null
  createdBy: ActorRef | null
  createdAt: string
  updatedAt: string
}

/**
 * The vehicle and driver come from lookup maps rather than from `populate`,
 * because a page of assignments references at most a page's worth of each and
 * two `$in` queries beat twenty populates on M0 — the same treatment
 * administration gives its actor names.
 *
 * Either side may be null: a vehicle or driver deleted after the assignment
 * ended leaves history that still has to render. The row says so rather than
 * disappearing, because the history is the reason the row exists.
 */
export function toAssignmentRecord(
  assignment: AssignmentDocument,
  actorNames: Map<string, string>,
  vehicles: Map<string, VehicleDocument>,
  drivers: Map<string, DriverDocument>,
): AssignmentRecord {
  const vehicle = vehicles.get(String(assignment.vehicleId))
  const driver = drivers.get(String(assignment.driverId))

  return {
    id: String(assignment._id),
    vendorId: String(assignment.vendorId),
    vehicle: vehicle
      ? {
          id: String(vehicle._id),
          vehicleCode: vehicle.vehicleCode,
          registrationNo: vehicle.registrationNo,
        }
      : null,
    driver: driver
      ? {
          id: String(driver._id),
          driverCode: driver.driverCode,
          name: driver.name,
          mobile: driver.mobile,
        }
      : null,
    // Non-null: the schema requires it, and a day is what was stored.
    assignedFrom: toDay(assignment.assignedFrom) ?? '',
    assignedUntil: toDay(assignment.assignedUntil),
    status: assignment.status as AssignmentStatus,
    note: assignment.note ?? null,
    endedAt: toIso(assignment.endedAt),
    endedBy: actorFrom(assignment.endedBy, actorNames),
    createdBy: actorFrom(assignment.createdBy, actorNames),
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  }
}

// --- Document --------------------------------------------------------------

export interface DocumentRecord {
  id: string
  vendorId: string
  ownerType: DocumentOwnerType
  ownerId: string
  /** "DHAKA METRO-TA-11-1234" or "Md. Rahim" — what the document is about. */
  ownerLabel: string
  documentType: VendorDocumentType
  documentNumber: string
  issueDate: string | null
  expiryDate: string | null
  /** Derived from `expiryDate`, never stored. See `documentStatusFor`. */
  status: DocumentStatus
  /** Negative once it has passed; null when the document does not expire. */
  daysRemaining: number | null
  expiryPhrase: string
  /**
   * Whether a file is attached, and what it is. The key is deliberately not
   * here: it is an internal storage reference, and the only read path is
   * `GET /vendor-documents/:id/file`, which re-checks the caller.
   */
  attachment: { mimeType: string; size: number; originalName: string; uploadedAt: string } | null
  note: string | null
  createdBy: ActorRef | null
  updatedBy: ActorRef | null
  createdAt: string
  updatedAt: string
}

export function toDocumentRecord(
  row: VendorDocumentDocument,
  actorNames: Map<string, string>,
  ownerLabel: string,
  now: Date = new Date(),
): DocumentRecord {
  return {
    id: String(row._id),
    vendorId: String(row.vendorId),
    ownerType: row.ownerType as DocumentOwnerType,
    ownerId: String(row.ownerId),
    ownerLabel,
    documentType: row.documentType as VendorDocumentType,
    documentNumber: row.documentNumber,
    issueDate: toDay(row.issueDate),
    expiryDate: toDay(row.expiryDate),
    status: documentStatusFor(row.expiryDate, now),
    daysRemaining: row.expiryDate ? daysUntilExpiry(row.expiryDate, now) : null,
    expiryPhrase: expiryPhrase(row.expiryDate, now),
    attachment: row.attachment
      ? {
          mimeType: row.attachment.mimeType,
          size: row.attachment.size,
          originalName: row.attachment.originalName,
          uploadedAt: row.attachment.uploadedAt.toISOString(),
        }
      : null,
    note: row.note ?? null,
    createdBy: actorFrom(row.createdBy, actorNames),
    updatedBy: actorFrom(row.updatedBy, actorNames),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// --- Activity --------------------------------------------------------------

export interface ActivityRecord {
  id: string
  action: ActivityAction
  entityType: string
  entityId: string | null
  entityLabel: string
  summary: string
  actor: ActorRef | null
  createdAt: string
}

export function toActivityRecord(
  entry: VendorActivityDocument,
  actorNames: Map<string, string>,
): ActivityRecord {
  return {
    id: String(entry._id),
    action: entry.action as ActivityAction,
    entityType: entry.entityType,
    entityId: entry.entityId ? String(entry.entityId) : null,
    entityLabel: entry.entityLabel,
    summary: entry.summary,
    actor: actorFrom(entry.actorId, actorNames),
    createdAt: entry.createdAt.toISOString(),
  }
}
