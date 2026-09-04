import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Gate Pass vocabulary. The frontend mirrors
 * this file at `LBTS-Frontend/src/features/gate-pass/lib/gate-pass-meta.ts`,
 * which adds display metadata and nothing else. Change one, change both.
 */

/**
 * Lifecycle of one gate pass document.
 *
 * `Draft` is a record being assembled — it may be missing the scan and any
 * optional field, and only its author (or an administrator) sees it as
 * unfinished work. `Submitted` is the claim that this is a real, complete gate
 * pass; from there a reviewer either `Verified` it against the physical
 * document or `Rejected` it back for correction. `Cancelled` is the terminal
 * "this should never have existed" state, and nothing leaves it.
 */
export const GATE_PASS_STATUSES = [
  'Draft',
  'Submitted',
  'Verified',
  'Rejected',
  'Cancelled',
] as const
export type GatePassStatus = (typeof GATE_PASS_STATUSES)[number]

export const DEFAULT_GATE_PASS_STATUS: GatePassStatus = 'Draft'

/**
 * Legal moves, enforced server-side in the service. A stale client menu cannot
 * force an illegal one, exactly as with the account lifecycle.
 *
 * `Rejected -> Submitted` is what makes a rejection actionable: the operator
 * fixes what the reviewer flagged and sends the same record back, rather than
 * creating a second gate pass for the same trip.
 */
export const GATE_PASS_TRANSITIONS: Record<GatePassStatus, readonly GatePassStatus[]> = {
  Draft: ['Submitted', 'Cancelled'],
  Submitted: ['Verified', 'Rejected', 'Cancelled'],
  Verified: ['Cancelled'],
  Rejected: ['Submitted', 'Cancelled'],
  Cancelled: [],
}

export function canTransitionGatePass(from: GatePassStatus, to: GatePassStatus): boolean {
  // Indexed defensively: a document written before this set existed holds a
  // value with no entry here, and must fail closed rather than throw.
  return (GATE_PASS_TRANSITIONS[from] ?? []).includes(to)
}

/** The two states in which the content of a gate pass may still be edited. */
export const EDITABLE_GATE_PASS_STATUSES: readonly GatePassStatus[] = ['Draft', 'Rejected']

export function isEditableStatus(status: GatePassStatus): boolean {
  return EDITABLE_GATE_PASS_STATUSES.includes(status)
}

/**
 * Which reference a gate pass is filed against. Kept as a discriminated pair
 * rather than one ambiguous "Zone / PO" string, so reporting can group by zone
 * without parsing free text back out of a column.
 */
export const GATE_PASS_REFERENCE_TYPES = ['None', 'Zone', 'PO'] as const
export type GatePassReferenceType = (typeof GATE_PASS_REFERENCE_TYPES)[number]

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do: a role says who someone is to the business, not what
 * they may do inside a module. There is deliberately no central matrix.
 *
 * Reading covers the records list, one record, and its scanned document.
 * Writing covers creating a gate pass and editing or submitting one that is
 * still open. Reviewing is the verification decision, and cancelling a record
 * that has already left Draft.
 *
 * `Vendor` appears in none of them: gate passes are the transport service's
 * own operating record, not something an external supplier files or reads.
 * `CEO` reads everything and writes nothing — executive oversight, not data
 * entry.
 */
export const GATE_PASS_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const GATE_PASS_WRITE_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'OpEx']
export const GATE_PASS_REVIEW_ROLES: readonly UserRole[] = ['Admin', 'Manager']

/**
 * Roles that may act on a record they did not create. Everyone else is scoped
 * to their own work — an OpEx edits and submits their own gate passes, and
 * cannot touch a colleague's.
 */
export const GATE_PASS_MANAGE_ANY_ROLES: readonly UserRole[] = ['Admin', 'Manager']

export function canManageAnyGatePass(role: UserRole): boolean {
  return GATE_PASS_MANAGE_ANY_ROLES.includes(role)
}

/**
 * Product rows one gate pass may carry.
 *
 * A challan routinely lists several — the indoor and outdoor halves of an air
 * conditioner arrive as two lines with their own barcodes and quantities. One
 * is the minimum because a gate pass with nothing on it is not a gate pass;
 * the ceiling is a sanity limit on a request body, not a business rule.
 */
export const MAX_GATE_PASS_ITEMS = 50

/** Document formats a scanned gate pass may arrive in. */
export const GATE_PASS_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
export type GatePassDocumentMimeType = (typeof GATE_PASS_DOCUMENT_MIME_TYPES)[number]

/**
 * Two limits, not one. A scan of a single A4 page at a sane resolution is well
 * under 10 MB, while a multi-page PDF off the document feeder legitimately is
 * not — so the PDF ceiling is higher and the image ceiling stays tight.
 *
 * Deliberately NOT the profile photo's 5 MB: an avatar is decoration that gets
 * resized to 512px regardless, and a gate pass is a legal record that has to
 * stay readable.
 */
export const MAX_GATE_PASS_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_GATE_PASS_PDF_BYTES = 25 * 1024 * 1024

/** The larger of the two, which is what the multipart parser is capped at. */
export const MAX_GATE_PASS_DOCUMENT_BYTES = MAX_GATE_PASS_PDF_BYTES

export function maxBytesFor(mimeType: string): number {
  return mimeType === 'application/pdf' ? MAX_GATE_PASS_PDF_BYTES : MAX_GATE_PASS_IMAGE_BYTES
}

/**
 * The comparison key for identifiers the operator types by hand.
 *
 * Trip DO and vehicle numbers are copied off a printed challan, so the same
 * trip legitimately arrives as "DHAKA METRO-NA-15-1469" one day and
 * "dhaka metro na 15 1469" the next. Duplicate detection has to see those as
 * the same value while the record keeps exactly what was typed — which is why
 * this produces a separate stored key rather than rewriting the field.
 */
export function comparisonKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}
