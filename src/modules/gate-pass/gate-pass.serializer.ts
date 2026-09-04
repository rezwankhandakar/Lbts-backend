import type { Types } from 'mongoose'
import type { GatePassReferenceType, GatePassStatus } from './gate-pass.constants'
import type { GatePassDocument } from './gate-pass.model'

/** Who created a record or last moved it, resolved to something displayable. */
export interface ActorRef {
  id: string
  name: string
}

/**
 * One product line, as a client sees it.
 *
 * The field is `model` here and `productModel` in MongoDB — the stored name
 * avoids a collision with Mongoose's own `Document.model()`, and this is where
 * the two are mapped.
 */
export interface GatePassItem {
  productName: string
  model: string
  qty: number
}

/**
 * The scanned document as a client sees it.
 *
 * `url` is an API path, not a Cloudflare URL. A gate pass carries customer
 * addresses and phone numbers, so the object is never served from the public
 * bucket: GET /gate-passes/:id/document re-checks authentication and role and
 * streams it. That is the one place the R2 key is ever used, and the key
 * itself is not exposed here — it has no meaning to a client.
 */
export interface GatePassDocumentRef {
  url: string
  mimeType: string
  size: number
  originalName: string
  uploadedAt: string
  /** Only ever a real count, reported by whatever produced the file. */
  pageCount: number | null
}

export interface GatePassRecord {
  id: string
  gatePassId: string

  tripDo: string
  /** YYYY-MM-DD. A trip date is a calendar day, so it is not sent as an instant. */
  tripDate: string
  csd: string
  unit: string

  customerName: string
  vehicleNo: string

  referenceType: GatePassReferenceType
  zone: string | null
  po: string | null

  /** One line per product on the vehicle; always at least one. */
  items: GatePassItem[]
  /** Every quantity added up. Derived, so a list can show one number. */
  totalQty: number

  status: GatePassStatus
  document: GatePassDocumentRef | null

  submittedAt: string | null
  statusChangedAt: string | null
  statusChangedBy: ActorRef | null
  statusNote: string | null

  createdBy: ActorRef | null
  createdAt: string
  updatedBy: ActorRef | null
  updatedAt: string
}

/**
 * The narrow view the duplicate dialog renders. Deliberately not a full
 * record: the operator is deciding "is this the same trip", and everything
 * beyond these fields is noise at that moment.
 */
export interface DuplicateCandidate {
  id: string
  gatePassId: string
  tripDo: string
  tripDate: string
  customerName: string
  vehicleNo: string
  /** The first product line, which is enough to recognise the delivery. */
  productName: string
  model: string
  /** How many more lines the record carries beyond the one shown. */
  moreItems: number
  status: GatePassStatus
  /** Which of the two probes matched, so the dialog can say why. */
  matchedOn: 'tripDo' | 'trip'
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

/** The stored rows, with `productModel` renamed back to `model`. */
function toItems(gatePass: GatePassDocument): GatePassItem[] {
  return gatePass.items.map((item) => ({
    productName: item.productName,
    model: item.productModel,
    qty: item.qty,
  }))
}

function totalQtyOf(gatePass: GatePassDocument): number {
  return gatePass.items.reduce((total, item) => total + item.qty, 0)
}

/** UTC, because that is the timezone the value was stored in. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10)
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

/**
 * `actorNames` maps an actor id to their display name. The caller resolves
 * every actor on a page of results in one indexed lookup rather than
 * populating row by row — on M0 the difference is worth the plumbing.
 */
export function toGatePassRecord(
  gatePass: GatePassDocument,
  actorNames: Map<string, string>,
): GatePassRecord {
  const id = String(gatePass._id)

  return {
    id,
    gatePassId: gatePass.gatePassId,

    tripDo: gatePass.tripDo,
    tripDate: toDateOnly(gatePass.tripDate),
    csd: gatePass.csd,
    unit: gatePass.unit,

    customerName: gatePass.customerName,
    vehicleNo: gatePass.vehicleNo,

    referenceType: gatePass.referenceType as GatePassReferenceType,
    zone: gatePass.zone ?? null,
    po: gatePass.po ?? null,

    items: toItems(gatePass),
    totalQty: totalQtyOf(gatePass),

    status: gatePass.status as GatePassStatus,
    document: gatePass.document
      ? {
          url: `/gate-passes/${id}/document`,
          mimeType: gatePass.document.mimeType,
          size: gatePass.document.size,
          originalName: gatePass.document.originalName,
          uploadedAt: gatePass.document.uploadedAt.toISOString(),
          pageCount: gatePass.document.pageCount ?? null,
        }
      : null,

    submittedAt: toIso(gatePass.submittedAt),
    statusChangedAt: toIso(gatePass.statusChangedAt),
    statusChangedBy: actorFrom(gatePass.statusChangedBy, actorNames),
    statusNote: gatePass.statusNote ?? null,

    createdBy: actorFrom(gatePass.createdBy, actorNames),
    createdAt: gatePass.createdAt.toISOString(),
    updatedBy: actorFrom(gatePass.updatedBy, actorNames),
    updatedAt: gatePass.updatedAt.toISOString(),
  }
}

export function toDuplicateCandidate(
  gatePass: GatePassDocument,
  matchedOn: DuplicateCandidate['matchedOn'],
): DuplicateCandidate {
  return {
    id: String(gatePass._id),
    gatePassId: gatePass.gatePassId,
    tripDo: gatePass.tripDo,
    tripDate: toDateOnly(gatePass.tripDate),
    customerName: gatePass.customerName,
    vehicleNo: gatePass.vehicleNo,
    // The first line is enough to recognise a delivery; the count says there
    // is more without turning the dialog into a second records table.
    productName: gatePass.items[0]?.productName ?? '',
    model: gatePass.items[0]?.productModel ?? '',
    moreItems: Math.max(gatePass.items.length - 1, 0),
    status: gatePass.status as GatePassStatus,
    matchedOn,
  }
}
