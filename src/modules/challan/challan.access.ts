import { AppError } from "../../utils/app-error";
import type { UserRole } from "../user/user.constants";
import type { UserDocument } from "../user/user.model";
import { canManageAnyChallan } from "./challan.constants";
import type { ChallanDocument } from "./challan.model";

/**
 * Who may act on which challan.
 *
 * The route stack has already proved the caller holds a role that may reach
 * this module at all — `requireRole` does that. What is left is the part a
 * role cannot express: an operator corrects and removes their own work, and
 * nobody else's.
 *
 * There is no visibility rule to go with it, unlike Gate Pass. Gate Pass has
 * drafts, and an unfinished draft is private to the person still writing it.
 * A challan has no draft state at all — every record in the collection was
 * submitted, which makes it part of the operation's shared record and readable
 * by anyone the module is open to. Unfinished work lives in the browser
 * session, where no access rule reaches it because nothing has been written.
 *
 * Every check here takes the authenticated MongoDB profile. Nothing accepts a
 * user id from a request.
 */

function roleOf(actor: UserDocument): UserRole {
  return actor.role as UserRole;
}

/** True for Admin and Manager: the two roles that act on everything. */
export function managesAnyRecord(actor: UserDocument): boolean {
  return canManageAnyChallan(roleOf(actor));
}

export function ownsRecord(
  challan: ChallanDocument,
  actor: UserDocument,
): boolean {
  return String(challan.createdBy) === String(actor._id);
}

/**
 * Correcting a challan.
 *
 * Status is deliberately not a condition. A customer name transcribed wrongly
 * is wrong whether it is spotted in the workspace or a fortnight after filing,
 * and a record nobody may correct is a record nobody can trust. What a late
 * correction costs is a regenerated back page and a regenerated document —
 * handled in the service, not a reason to refuse the edit.
 */
export function assertCanEdit(
  challan: ChallanDocument,
  actor: UserDocument,
): void {
  if (!managesAnyRecord(actor) && !ownsRecord(challan, actor)) {
    throw new AppError(403, "You can only correct challans you filed.");
  }
}

/**
 * Changing a batch — marking pages of the source PDF as not being challans,
 * clearing its print mark, or filing another challan into it.
 *
 * Scoped like everything else in the module: the operator who worked through
 * that file, and the two roles that manage anybody's work. It is a statement
 * about a file only one person ever had, so somebody else declaring its pages
 * blank would be guessing.
 *
 * The boolean is what the read probes ask — a page-range check for a batch
 * somebody may not add to is answered as "no batch" rather than as a fault,
 * because it is a question asked repeatedly while a range is dragged.
 */
export function canChangeBatch(
  batch: { createdBy: unknown },
  actor: UserDocument,
): boolean {
  return (
    managesAnyRecord(actor) || String(batch.createdBy) === String(actor._id)
  );
}

export function assertCanChangeBatch(
  batch: { createdBy: unknown },
  actor: UserDocument,
): void {
  if (!canChangeBatch(batch, actor)) {
    throw new AppError(403, "You can only change batches you started.");
  }
}

/**
 * Removing one.
 *
 * The same rule as editing, for the same reason: a challan that should not
 * exist — the wrong page range, a sheet filed twice — is wrong whenever it is
 * noticed, and who filed it is the question, not when.
 */
export function assertCanDelete(
  challan: ChallanDocument,
  actor: UserDocument,
): void {
  if (!managesAnyRecord(actor) && !ownsRecord(challan, actor)) {
    throw new AppError(403, "You can only delete challans you filed.");
  }
}
