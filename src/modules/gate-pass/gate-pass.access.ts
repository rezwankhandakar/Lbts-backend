import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { UserRole } from '../user/user.constants'
import type { UserDocument } from '../user/user.model'
import { canManageAnyGatePass, isEditableStatus } from './gate-pass.constants'
import type { GatePassStatus } from './gate-pass.constants'
import type { GatePass, GatePassDocument } from './gate-pass.model'

/**
 * Who may act on which record.
 *
 * The route stack has already proved the caller holds a role that may reach
 * this module at all — requireRole does that. What is left is the part a role
 * cannot express: an OpEx works on their own gate passes and nobody else's,
 * and an unfinished Draft is private to the person still writing it.
 *
 * Every check here takes the authenticated MongoDB profile. Nothing accepts a
 * user id from a request.
 */

function roleOf(actor: UserDocument): UserRole {
  return actor.role as UserRole
}

/** True for Admin and Manager: the two roles that see and act on everything. */
export function managesAnyRecord(actor: UserDocument): boolean {
  return canManageAnyGatePass(roleOf(actor))
}

export function ownsRecord(gatePass: GatePassDocument, actor: UserDocument): boolean {
  return String(gatePass.createdBy) === String(actor._id)
}

/**
 * A Draft is work in progress, so it is visible only to its author and to the
 * two roles that manage the whole module. Everything that has been submitted
 * is the operation's shared record and is readable by anyone with access to
 * this module.
 *
 * Applied as a query clause rather than filtered in memory, so a restricted
 * viewer's page counts and pagination are correct rather than merely
 * appearing correct.
 */
export function visibilityFilter(actor: UserDocument): QueryFilter<GatePass> | null {
  if (managesAnyRecord(actor)) {
    return null
  }

  return {
    $or: [{ status: { $ne: 'Draft' } }, { createdBy: actor._id }],
  }
}

export function canViewRecord(gatePass: GatePassDocument, actor: UserDocument): boolean {
  if (managesAnyRecord(actor)) {
    return true
  }
  return gatePass.status !== 'Draft' || ownsRecord(gatePass, actor)
}

/**
 * Editing means changing what the gate pass says. That is the author's job
 * while the record is still open, and a manager's job when they are correcting
 * somebody else's work.
 *
 * The 404 for a record the viewer cannot even see is deliberate: telling an
 * operator that GP-2026-000123 exists but is not theirs is more information
 * than they need.
 */
export function assertCanEdit(gatePass: GatePassDocument, actor: UserDocument): void {
  if (!canViewRecord(gatePass, actor)) {
    throw new AppError(404, 'Gate pass not found.')
  }

  if (!managesAnyRecord(actor) && !ownsRecord(gatePass, actor)) {
    throw new AppError(403, 'You can only change gate passes you created.')
  }

  if (!isEditableStatus(gatePass.status as GatePassStatus)) {
    throw new AppError(
      409,
      `A ${gatePass.status} gate pass cannot be edited. Cancel it and create a new one.`,
    )
  }
}

/** Reading one record, including its scanned document. */
export function assertCanView(gatePass: GatePassDocument, actor: UserDocument): void {
  if (!canViewRecord(gatePass, actor)) {
    throw new AppError(404, 'Gate pass not found.')
  }
}

/**
 * Deleting is confined to a Draft, and to the person who created it or an
 * administrator. Anything that has been submitted is part of the operating
 * record and is cancelled rather than removed — a gate pass that vanishes is
 * indistinguishable from one that never existed.
 */
export function assertCanDelete(gatePass: GatePassDocument, actor: UserDocument): void {
  if (!canViewRecord(gatePass, actor)) {
    throw new AppError(404, 'Gate pass not found.')
  }

  if (gatePass.status !== 'Draft') {
    throw new AppError(409, 'Only a draft can be deleted. Cancel this gate pass instead.')
  }

  if (roleOf(actor) !== 'Admin' && !ownsRecord(gatePass, actor)) {
    throw new AppError(403, 'You can only delete drafts you created.')
  }
}
