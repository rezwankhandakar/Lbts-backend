import { AppError } from '../../utils/app-error'
import type { UserRole } from '../user/user.constants'
import type { UserDocument } from '../user/user.model'
import { VENDOR_SCOPED_ROLE, canManageVendors } from './vendor.constants'

/**
 * Who may see and change which vendor.
 *
 * The route stack has already proved the caller holds a role that may reach
 * this module at all — `requireRole` does that. What is left is the part a role
 * cannot express, and in this module it is the whole security story: a Vendor
 * user sees exactly one vendor's data and changes none of it.
 *
 * Every check here takes the authenticated MongoDB profile. **Nothing accepts a
 * vendor id from a request as authority.** An id in a URL is a subject to be
 * checked, never a claim to be believed — which is what makes
 * `GET /vendors/<somebody-elses-id>` a 404 rather than a leak.
 */

function roleOf(actor: UserDocument): UserRole {
  return actor.role as UserRole
}

/**
 * What a caller's account entitles them to.
 *
 * Two shapes and no third. `all` is the staff view — Admin, Manager, CEO and
 * OpEx see every vendor, and what separates them is whether they may write,
 * which `assertCanManage` answers. `own` is a Vendor account, narrowed to the
 * one vendor its profile is linked to.
 */
export type VendorScope = { kind: 'all' } | { kind: 'own'; vendorId: string }

export function vendorScopeOf(actor: UserDocument): VendorScope {
  if (roleOf(actor) !== VENDOR_SCOPED_ROLE) {
    return { kind: 'all' }
  }

  /**
   * A Vendor account with no vendor behind it is not a smaller amount of
   * access, it is none — and saying so plainly is better than a blank page.
   * Administration is where the link is made, and the message says so.
   */
  if (!actor.vendorId) {
    throw new AppError(
      403,
      'This account is not linked to a vendor yet. An administrator has to link it before there is anything to show.',
    )
  }

  return { kind: 'own', vendorId: String(actor.vendorId) }
}

/** True for a caller who sees the whole collection. */
export function seesEveryVendor(actor: UserDocument): boolean {
  return vendorScopeOf(actor).kind === 'all'
}

/**
 * The vendor a scoped caller is confined to, or null for a staff account.
 *
 * Applied as a query clause rather than filtered in memory, so a Vendor user's
 * counts and pagination are correct rather than merely appearing correct — the
 * same reasoning `visibilityFilter` follows in Gate Pass.
 */
export function vendorFilterFor(actor: UserDocument): { vendorId: string } | null {
  const scope = vendorScopeOf(actor)
  return scope.kind === 'own' ? { vendorId: scope.vendorId } : null
}

/**
 * The gate every read in this module passes through.
 *
 * A 404 rather than a 403 for a vendor outside the caller's scope, and that is
 * deliberate: telling a vendor that V-0042 exists but is not theirs is more
 * than they need to know, and it is the same posture `assertCanEdit` takes in
 * Gate Pass for somebody else's draft. Within a staff account there is nothing
 * to hide, so the distinction costs them nothing.
 */
export function assertCanReadVendor(vendorId: string, actor: UserDocument): void {
  const scope = vendorScopeOf(actor)

  if (scope.kind === 'own' && scope.vendorId !== String(vendorId)) {
    throw new AppError(404, 'Vendor not found.')
  }
}

/**
 * The gate every write passes through.
 *
 * Reads the scope first, so a Vendor user trying to change another vendor is
 * told the record does not exist rather than that they may not write to it —
 * a 403 there would confirm the id was real. Their own vendor is refused with
 * an honest 403, because that is a genuine permission answer and pretending
 * their own vendor does not exist would be absurd.
 *
 * CEO and OpEx land in the same 403: they read this module and change nothing.
 */
export function assertCanManageVendor(vendorId: string, actor: UserDocument): void {
  assertCanReadVendor(vendorId, actor)

  if (!canManageVendors(roleOf(actor))) {
    throw new AppError(403, 'You do not have permission to change vendor records.')
  }
}

/**
 * A write that is not about one existing vendor — creating one, for instance.
 * There is no subject to scope against, so this is the role check alone.
 */
export function assertCanCreateVendor(actor: UserDocument): void {
  if (!canManageVendors(roleOf(actor))) {
    throw new AppError(403, 'You do not have permission to change vendor records.')
  }
}

/**
 * The linked vendor of a Vendor account, for `GET /vendors/me`.
 *
 * A staff account has no linked vendor and is told so rather than being handed
 * an arbitrary one — "my vendor" is not a question an Admin's account has an
 * answer to, and the vendor list is where they go instead.
 */
export function ownVendorIdOf(actor: UserDocument): string {
  const scope = vendorScopeOf(actor)

  if (scope.kind !== 'own') {
    throw new AppError(
      404,
      'This account is not a vendor account. Open the vendor list to choose one.',
    )
  }

  return scope.vendorId
}
