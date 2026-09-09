import type { QueryFilter, Types } from 'mongoose'
import { getObjectStream } from '../../config/r2'
import type { ObjectStream } from '../../config/r2'
import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import { DriverModel } from './driver.model'
import { VehicleModel } from './vehicle.model'
import { VendorDocumentModel } from './vendor-document.model'
import type { VendorDocumentDocument, VendorDocumentRow } from './vendor-document.model'
import { assertCanManageVendor, assertCanReadVendor } from './vendor.access'
import { recordActivity } from './vendor.activity'
import { DRIVER_LICENCE_DOCUMENT, isDocumentTypeFor } from './vendor.constants'
import type { DocumentOwnerType } from './vendor.constants'
import {
  escapeRegex,
  expiryWindow,
  findDriverOr404,
  findVehicleOr404,
  resolveActorNames,
} from './vendor.lookups'
import { toDocumentRecord } from './vendor.serializer'
import type { DocumentRecord } from './vendor.serializer'
import { discardVendorObject, uploadVendorDocument } from './vendor.storage'
import type { CreateDocumentInput, ListDocumentsQuery, UpdateDocumentInput } from './vendor.validation'

/**
 * Compliance documents, for vehicles and for drivers.
 *
 * One collection rather than two, because everything anybody does with them is
 * the same — the documents tab lists them together, the compliance counts sum
 * them together, and the expiry arithmetic is identical. Two collections would
 * mean two of every query and a union in front of each.
 *
 * Status is never stored and never accepted. Whether a document is valid,
 * expiring or expired is arithmetic over its expiry date; a field somebody
 * could type would be a way to contradict the date printed beside it.
 */

export interface ListDocumentsResult {
  records: DocumentRecord[]
  total: number
}

/**
 * What each document is about, in words: a registration number or a name.
 *
 * Resolved for the whole page in two queries rather than one per row. It is a
 * label rather than a reference because the documents tab is read as a list of
 * sentences — "Fitness Certificate · DHAKA METRO-TA-11-1234" — and a row that
 * only carried an id would be one nobody could scan.
 */
async function ownerLabelsFor(rows: VendorDocumentDocument[]): Promise<Map<string, string>> {
  const vehicleIds: Types.ObjectId[] = []
  const driverIds: Types.ObjectId[] = []

  for (const row of rows) {
    if (row.ownerType === 'Vehicle') {
      vehicleIds.push(row.ownerId)
    } else {
      driverIds.push(row.ownerId)
    }
  }

  const [vehicles, drivers] = await Promise.all([
    vehicleIds.length > 0
      ? VehicleModel.find({ _id: { $in: vehicleIds } }).select('registrationNo')
      : Promise.resolve([]),
    driverIds.length > 0
      ? DriverModel.find({ _id: { $in: driverIds } }).select('name')
      : Promise.resolve([]),
  ])

  const labels = new Map<string, string>()
  for (const vehicle of vehicles) {
    labels.set(String(vehicle._id), vehicle.registrationNo)
  }
  for (const driver of drivers) {
    labels.set(String(driver._id), driver.name)
  }

  return labels
}

async function serializeMany(rows: VendorDocumentDocument[]): Promise<DocumentRecord[]> {
  if (rows.length === 0) {
    return []
  }

  const [labels, names] = await Promise.all([
    ownerLabelsFor(rows),
    resolveActorNames(rows.flatMap((row) => [row.createdBy, row.updatedBy])),
  ])

  return rows.map((row) =>
    toDocumentRecord(row, names, labels.get(String(row.ownerId)) ?? 'Removed record'),
  )
}

async function serialize(row: VendorDocumentDocument): Promise<DocumentRecord> {
  const [only] = await serializeMany([row])
  return only
}

function buildFilter(
  vendorId: string,
  query: ListDocumentsQuery,
): QueryFilter<VendorDocumentRow> {
  const clauses: QueryFilter<VendorDocumentRow>[] = [{ vendorId }]

  if (query.ownerType !== 'all') {
    clauses.push({ ownerType: query.ownerType })
  }
  if (query.ownerId) {
    clauses.push({ ownerId: query.ownerId })
  }
  if (query.documentType !== 'all') {
    clauses.push({ documentType: query.documentType })
  }

  /**
   * The status filter is a date range rather than an equality, because the
   * status is not stored. That is the trade `documentStatusFor` makes and it is
   * the right way round: an indexed range query is cheap, and a stored status
   * would be wrong the morning after it was written.
   *
   * `Valid` is the awkward one — it means "has no expiry, or expires beyond the
   * window" — which is exactly why it is written out here once rather than
   * assembled at each call site.
   */
  if (query.status !== 'all') {
    const { today, soon } = expiryWindow()

    if (query.status === 'Expired') {
      clauses.push({ expiryDate: { $ne: null, $lt: today } })
    } else if (query.status === 'Expiring Soon') {
      clauses.push({ expiryDate: { $ne: null, $gte: today, $lte: soon } })
    } else {
      clauses.push({ $or: [{ expiryDate: null }, { expiryDate: { $gt: soon } }] })
    }
  }

  if (query.search) {
    clauses.push({ documentNumber: new RegExp(escapeRegex(query.search), 'i') })
  }

  return { $and: clauses }
}

export async function listDocuments(
  vendorId: string,
  query: ListDocumentsQuery,
  viewer: UserDocument,
): Promise<ListDocumentsResult> {
  assertCanReadVendor(vendorId, viewer)

  const filter = buildFilter(vendorId, query)
  const skip = (query.page - 1) * query.limit

  const [rows, total] = await Promise.all([
    /**
     * Soonest expiry first, with the never-expiring rows at the end. A
     * documents tab is a to-do list before it is an archive, so the thing that
     * lapses next belongs at the top.
     */
    VendorDocumentModel.find(filter).sort({ expiryDate: 1 }).skip(skip).limit(query.limit),
    VendorDocumentModel.countDocuments(filter),
  ])

  return { records: await serializeMany(rows), total }
}

/** The documents of one vehicle or one driver, for its detail panel. */
export async function listOwnerDocuments(
  ownerType: DocumentOwnerType,
  ownerId: string,
  viewer: UserDocument,
): Promise<DocumentRecord[]> {
  const owner =
    ownerType === 'Vehicle' ? await findVehicleOr404(ownerId) : await findDriverOr404(ownerId)

  assertCanReadVendor(String(owner.vendorId), viewer)

  const rows = await VendorDocumentModel.find({ ownerType, ownerId: owner._id }).sort({
    expiryDate: 1,
  })

  return serializeMany(rows)
}

async function findDocumentOr404(id: string): Promise<VendorDocumentDocument> {
  const row = await VendorDocumentModel.findById(id)
  if (!row) {
    throw new AppError(404, 'Document not found.')
  }
  return row
}

export async function getDocument(id: string, viewer: UserDocument): Promise<DocumentRecord> {
  const row = await findDocumentOr404(id)
  assertCanReadVendor(String(row.vendorId), viewer)
  return serialize(row)
}

export interface DocumentFileInput {
  buffer: Buffer
  mimeType: string
  originalName: string
}

/**
 * Filing a document against a vehicle or a driver.
 *
 * The vendor is read off the owner rather than accepted from the request, which
 * is what makes it impossible to file a document against a vendor its subject
 * does not belong to — the same rule the assignment service applies to a
 * vehicle and a driver.
 *
 * The document type is checked against the owner's own set. An NID on a lorry
 * is refused rather than stored as a curiosity, because a compliance panel that
 * can hold nonsense is one nobody reads.
 *
 * One row per type per owner: renewing a fitness certificate is an edit that
 * moves the date forward and replaces the attachment, not a second row. Two
 * rows would make "is this vehicle's fitness valid" a question with two answers.
 */
export async function createDocument(
  ownerType: DocumentOwnerType,
  ownerId: string,
  input: CreateDocumentInput,
  file: DocumentFileInput | null,
  actor: UserDocument,
): Promise<DocumentRecord> {
  const owner =
    ownerType === 'Vehicle' ? await findVehicleOr404(ownerId) : await findDriverOr404(ownerId)

  assertCanManageVendor(String(owner.vendorId), actor)

  if (!isDocumentTypeFor(ownerType, input.documentType)) {
    throw new AppError(
      400,
      `${input.documentType} is not a ${ownerType.toLowerCase()} document.`,
    )
  }

  const existing = await VendorDocumentModel.findOne({
    ownerType,
    ownerId: owner._id,
    documentType: input.documentType,
  })

  if (existing) {
    throw new AppError(
      409,
      `A ${input.documentType} is already on record here. Renewing it is an edit to that document rather than a second one.`,
    )
  }

  const label =
    ownerType === 'Vehicle'
      ? (owner as { registrationNo: string }).registrationNo
      : (owner as { name: string }).name

  /**
   * The upload happens before the row is written, so a storage failure leaves
   * nothing behind at all. If the *write* then fails the object is discarded
   * rather than orphaned — the same order every module here uses, and the same
   * cleanup.
   */
  const attachment = file
    ? await uploadVendorDocument({
        vendorRef: String(owner.vendorId),
        documentType: input.documentType,
        buffer: file.buffer,
        mimeType: file.mimeType,
        originalName: file.originalName,
      })
    : null

  let row: VendorDocumentDocument
  try {
    row = await VendorDocumentModel.create({
      vendorId: owner.vendorId,
      ownerType,
      ownerId: owner._id,
      documentType: input.documentType,
      documentNumber: input.documentNumber,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate,
      attachment,
      note: input.note ?? null,
      createdBy: actor._id,
    })
  } catch (error) {
    await discardVendorObject(attachment?.key)
    throw error
  }

  await syncBackToDriver(row, actor)

  await recordActivity({
    vendorId: owner.vendorId,
    action: 'document.created',
    entityType: 'Document',
    entityId: row._id,
    entityLabel: `${input.documentType} · ${label}`,
    summary: `${input.documentType} filed for ${label}`,
    actor,
  })

  return serialize(row)
}

/**
 * Correcting or renewing one.
 *
 * `documentType` cannot change: turning a tax token into a route permit is a
 * different document and belongs to a different row. Everything else can,
 * because a renewal is exactly a new number, new dates and a new scan on the
 * same row — which is what keeps the compliance count honest instead of
 * doubling it.
 */
export async function updateDocument(
  id: string,
  input: UpdateDocumentInput,
  file: DocumentFileInput | null,
  actor: UserDocument,
): Promise<DocumentRecord> {
  const row = await findDocumentOr404(id)
  assertCanManageVendor(String(row.vendorId), actor)

  if (input.documentNumber !== undefined) {
    row.documentNumber = input.documentNumber
  }
  if (input.issueDate !== undefined) {
    row.issueDate = input.issueDate
  }
  if (input.expiryDate !== undefined) {
    row.expiryDate = input.expiryDate
  }
  if (input.note !== undefined) {
    row.note = input.note
  }

  if (row.issueDate && row.expiryDate && row.expiryDate.getTime() < row.issueDate.getTime()) {
    throw new AppError(400, 'The expiry date cannot be before the issue date.')
  }

  const previousKey = row.attachment?.key ?? null

  /**
   * Replacement order, the one this codebase uses everywhere: upload the new
   * object, write the reference, *then* delete the old one. The worst outcome of
   * a failure is an orphan in the bucket, never a record pointing at a file that
   * is gone.
   */
  const uploaded = file
    ? await uploadVendorDocument({
        vendorRef: String(row.vendorId),
        documentType: row.documentType,
        buffer: file.buffer,
        mimeType: file.mimeType,
        originalName: file.originalName,
      })
    : null

  if (uploaded) {
    row.attachment = uploaded
  }

  row.updatedBy = actor._id

  try {
    await row.save()
  } catch (error) {
    // The upload succeeded but the reference never landed, so the new object is
    // already unreachable. Clean it up rather than leave it behind.
    await discardVendorObject(uploaded?.key)
    throw error
  }

  if (uploaded && previousKey) {
    await discardVendorObject(previousKey)
  }

  await syncBackToDriver(row, actor)

  await recordActivity({
    vendorId: row.vendorId,
    action: 'document.updated',
    entityType: 'Document',
    entityId: row._id,
    entityLabel: row.documentType,
    summary: file
      ? `${row.documentType} updated and a new file attached`
      : `${row.documentType} updated`,
    actor,
  })

  return serialize(row)
}

/**
 * The other half of the licence sync.
 *
 * `syncDriverLicence` in the driver service writes the document from the driver
 * record; this writes the driver record from the document. Two explicit
 * functions rather than one hook firing from both sides, which is what stops
 * them looping — each is called from exactly one place and neither triggers the
 * other.
 *
 * A licence read off the scan wins over one typed into a form, which is the
 * right way round: the document is the evidence.
 */
async function syncBackToDriver(
  row: VendorDocumentDocument,
  actor: UserDocument,
): Promise<void> {
  if (row.ownerType !== 'Driver' || row.documentType !== DRIVER_LICENCE_DOCUMENT) {
    return
  }

  await DriverModel.updateOne(
    { _id: row.ownerId },
    {
      $set: {
        licenseNumber: row.documentNumber,
        licenseExpiry: row.expiryDate,
        updatedBy: actor._id,
      },
    },
  )
}

export interface DocumentDownload extends ObjectStream {
  mimeType: string
  /** What the browser should call the file if the viewer saves it. */
  filename: string
}

/**
 * Streams a document's file.
 *
 * The only read path there is. These objects are stored privately and never
 * served from the public bucket, so a registration certificate carrying an
 * owner's address is behind the same authentication, role check and vendor
 * scope as the record it belongs to — which is what lets a Vendor account read
 * its own papers and nobody else's.
 */
export async function readDocumentFile(
  id: string,
  viewer: UserDocument,
): Promise<DocumentDownload> {
  const row = await findDocumentOr404(id)
  assertCanReadVendor(String(row.vendorId), viewer)

  if (!row.attachment) {
    throw new AppError(404, 'That document has no file attached.')
  }

  const object = await getObjectStream(row.attachment.key)
  const extension =
    row.attachment.originalName.split('.').pop()?.toLowerCase() ??
    (row.attachment.mimeType === 'application/pdf' ? 'pdf' : 'jpg')

  return {
    ...object,
    mimeType: row.attachment.mimeType,
    // Named after the document rather than after whatever the scanner called
    // it, so a folder of downloads sorts usefully.
    filename: `${row.documentType.replace(/\s+/g, '-')}.${extension}`,
  }
}

/**
 * Removing a document.
 *
 * The row goes first and the object after it, so the worst outcome of a failure
 * is an orphan in the bucket rather than a record pointing at a file that no
 * longer exists — the trade the profile, gate pass and challan modules all
 * make, and the reason nothing sweeps orphans up here either.
 */
export async function removeDocument(
  id: string,
  actor: UserDocument,
): Promise<{ id: string }> {
  const row = await findDocumentOr404(id)
  assertCanManageVendor(String(row.vendorId), actor)

  const key = row.attachment?.key ?? null
  const type = row.documentType
  const vendorId = row.vendorId

  await row.deleteOne()
  await discardVendorObject(key)

  /**
   * A deleted licence document leaves the driver's copy behind on purpose. The
   * fields are what somebody typed and the document was the evidence for them;
   * removing the evidence does not mean the driver stopped having a licence,
   * and silently blanking a licence number because a scan was tidied away would
   * be this system deciding something it does not know.
   */

  await recordActivity({
    vendorId,
    action: 'document.deleted',
    entityType: 'Document',
    entityId: null,
    entityLabel: type,
    summary: `${type} removed`,
    actor,
  })

  return { id: String(row._id) }
}
