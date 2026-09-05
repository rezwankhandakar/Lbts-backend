import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import type { UserRole } from '../user/user.constants'
import type { UserDocument } from '../user/user.model'
import { canManageAnyGatePass } from './gate-pass.constants'
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
 * Editing means changing what the gate pass says, or replacing the scan it was
 * read from. That is the author's job on their own records, and a manager's
 * job when they are correcting somebody else's work.
 *
 * Status is deliberately not a condition. A vehicle number transcribed wrongly
 * is wrong whether it is noticed in a draft or a fortnight after verification,
 * and a record nobody may correct is a record nobody can trust. What a late
 * correction costs is decided elsewhere: `needsReverificationAfterEdit` sends
 * a verified record back to be checked against what it now says.
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
}

/** Reading one record, including its scanned document. */
export function assertCanView(gatePass: GatePassDocument, actor: UserDocument): void {
  if (!canViewRecord(gatePass, actor)) {
    throw new AppError(404, 'Gate pass not found.')
  }
}

/**
 * Deleting is how a gate pass that should not exist leaves the system. It
 * replaces the withdrawn status this module used to carry: a record parked in
 * "cancelled" is one every list, count and duplicate probe has to remember to
 * exclude, and one an operator still has to scroll past.
 *
 * Status is deliberately not a condition here. A wrong gate pass is wrong
 * whether it was noticed while still a draft or after a reviewer verified it,
 * and refusing the later case only produces a record nobody trusts.
 *
 * Who, rather than when, is the rule: the author removes their own work at any
 * point in its life, and Admin and Manager — the roles that already see and
 * act on everything — remove anybody's.
 *
 * The 404 for a record the actor cannot see is the same reasoning as
 * assertCanEdit: an operator does not learn that somebody else's draft exists
 * by trying to delete it.
 */
export function assertCanDelete(gatePass: GatePassDocument, actor: UserDocument): void {
  if (!canViewRecord(gatePass, actor)) {
    throw new AppError(404, 'Gate pass not found.')
  }

  if (!managesAnyRecord(actor) && !ownsRecord(gatePass, actor)) {
    throw new AppError(403, 'You can only delete gate passes you created.')
  }
}
