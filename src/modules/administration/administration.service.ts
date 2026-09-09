import type { QueryFilter } from 'mongoose'
import { getFirebaseAuth } from '../../config/firebase'
import { AppError } from '../../utils/app-error'
import { ADMIN_ROLE, canTransition } from '../user/user.constants'
import type { UserRole, UserStatus } from '../user/user.constants'
import { UserModel } from '../user/user.model'
import type { User, UserDocument } from '../user/user.model'
import { toAdminUser } from '../user/user.serializer'
import type { AdminUser, VendorRef } from '../user/user.serializer'
import { VendorModel } from '../vendor/vendor.model'
import type { VendorDocument } from '../vendor/vendor.model'
import type { ListUsersQuery } from './administration.validation'

export interface UserStats {
  total: number
  pending: number
  active: number
  rejected: number
  suspended: number
}

export interface ListUsersResult {
  users: AdminUser[]
  total: number
}

/** User input reaches a regex, so metacharacters must lose their meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildFilter(query: ListUsersQuery): QueryFilter<User> {
  const filter: QueryFilter<User> = {}

  if (query.role !== 'all') {
    filter.role = query.role
  }

  if (query.status !== 'all') {
    filter.status = query.status
  }

  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    filter.$or = [{ name: pattern }, { email: pattern }]
  }

  return filter
}

/**
 * Resolves every actor referenced on this page of results in a single indexed
 * lookup, rather than populating row by row. Returns id -> display name.
 */
async function resolveActorNames(users: UserDocument[]): Promise<Map<string, string>> {
  const ids = new Set<string>()

  for (const user of users) {
    if (user.roleUpdatedBy) {
      ids.add(String(user.roleUpdatedBy))
    }
    if (user.statusUpdatedBy) {
      ids.add(String(user.statusUpdatedBy))
    }
  }

  if (ids.size === 0) {
    return new Map()
  }

  const actors = await UserModel.find({ _id: { $in: [...ids] } }).select('name')
  return new Map(actors.map((actor) => [String(actor._id), actor.name]))
}

/**
 * The vendors linked to a page of accounts, resolved in one indexed lookup
 * rather than populated row by row — the same treatment `resolveActorNames`
 * gives its actors, and for the same reason: on M0 the difference between one
 * `$in` and ten lookups is worth the plumbing.
 *
 * The administration table needs the vendor's *name*, not its id, because "John
 * Doe · Vendor · Malek Transport" is a sentence an Admin can check and "John
 * Doe · Vendor · 66f1a2..." is not.
 */
async function vendorRefsFor(users: UserDocument[]): Promise<Map<string, VendorRef>> {
  const ids = new Set<string>()

  for (const user of users) {
    if (user.vendorId) {
      ids.add(String(user.vendorId))
    }
  }

  if (ids.size === 0) {
    return new Map()
  }

  const vendors = await VendorModel.find({ _id: { $in: [...ids] } }).select('name vendorCode')

  return new Map(
    vendors.map((vendor) => [
      String(vendor._id),
      { id: String(vendor._id), name: vendor.name, vendorCode: vendor.vendorCode },
    ]),
  )
}

export async function listUsers(query: ListUsersQuery): Promise<ListUsersResult> {
  const filter = buildFilter(query)
  const skip = (query.page - 1) * query.limit

  const [users, total] = await Promise.all([
    UserModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    UserModel.countDocuments(filter),
  ])

  const [actorNames, vendorRefs] = await Promise.all([
    resolveActorNames(users),
    vendorRefsFor(users),
  ])

  return {
    users: users.map((user) => toAdminUser(user, actorNames, vendorRefs)),
    total,
  }
}

/**
 * One grouped aggregation rather than five countDocuments calls — the overview
 * cards are the first thing the page renders, and M0 pays for every round trip.
 */
export async function getUserStats(): Promise<UserStats> {
  const rows = await UserModel.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ])

  const counts = new Map(rows.map((row) => [row._id, row.count]))
  const read = (status: UserStatus): number => counts.get(status) ?? 0

  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    pending: read('Pending'),
    active: read('Active'),
    rejected: read('Rejected'),
    suspended: read('Suspended'),
  }
}

async function findTarget(id: string): Promise<UserDocument> {
  const target = await UserModel.findById(id)
  if (!target) {
    throw new AppError(404, 'User not found.')
  }
  return target
}

/**
 * The self-lockout guard. An Admin may administer everyone except themselves,
 * which is what makes it impossible to demote, suspend, reject or delete your
 * way out of the system. Changing your own account is a support operation, not
 * a self-service one.
 */
function assertNotSelf(target: UserDocument, actor: UserDocument, action: string): void {
  if (String(target._id) === String(actor._id)) {
    throw new AppError(403, `You cannot ${action} your own account.`)
  }
}

/**
 * Belt-and-braces invariant: the system must never be left without a working
 * Admin. assertNotSelf already makes this unreachable today — the actor is an
 * active Admin and cannot target themselves — but the check costs one indexed
 * count on the rare Admin-targeting path and keeps the invariant true if the
 * self rule is ever relaxed.
 */
async function assertNotLastAdmin(target: UserDocument): Promise<void> {
  if (target.role !== ADMIN_ROLE || target.status !== 'Active') {
    return
  }

  const remaining = await UserModel.countDocuments({
    _id: { $ne: target._id },
    role: ADMIN_ROLE,
    status: 'Active',
  })

  if (remaining === 0) {
    throw new AppError(409, 'This is the last active Admin. Promote another Admin first.')
  }
}

/**
 * Resolves the vendor a Vendor account will speak for, and refuses an id that
 * names nothing.
 *
 * The link is the whole of a Vendor user's authority — `vendorScopeOf` reads it
 * off the profile and every endpoint in that module narrows to it — so an
 * unchecked id here would be an account scoped to a vendor that does not exist,
 * which fails in a way nobody could diagnose from the symptom.
 */
async function resolveVendorLink(vendorId: string): Promise<VendorDocument> {
  const vendor = await VendorModel.findById(vendorId)

  if (!vendor) {
    throw new AppError(404, 'That vendor does not exist.')
  }

  return vendor
}

export async function changeUserRole(
  id: string,
  role: UserRole,
  vendorId: string | null | undefined,
  actor: UserDocument,
): Promise<AdminUser> {
  const target = await findTarget(id)

  assertNotSelf(target, actor, 'change the role of')

  /**
   * A Vendor account may legitimately be *relinked* to a different vendor
   * without its role changing, which is why "already this role" is only a
   * conflict when the vendor is not moving too.
   */
  const relinking =
    role === 'Vendor' && vendorId && String(target.vendorId ?? '') !== String(vendorId)

  if (target.role === role && !relinking) {
    throw new AppError(409, `This user is already ${role}.`)
  }

  if (role !== ADMIN_ROLE) {
    await assertNotLastAdmin(target)
  }

  /**
   * The role and the link are written together, because they are one decision.
   * Moving *to* Vendor requires a vendor — the schema enforces that — and
   * moving away clears it, so an account promoted to Manager cannot be left
   * carrying a relationship nothing would ever look at again.
   */
  if (role === 'Vendor') {
    const vendor = await resolveVendorLink(vendorId as string)
    target.vendorId = vendor._id
  } else {
    target.vendorId = null
  }

  target.role = role
  target.roleUpdatedAt = new Date()
  target.roleUpdatedBy = actor._id
  await target.save()

  return toAdminUser(
    target,
    new Map([[String(actor._id), actor.name]]),
    await vendorRefsFor([target]),
  )
}

export async function changeUserStatus(
  id: string,
  status: UserStatus,
  note: string | undefined,
  actor: UserDocument,
): Promise<AdminUser> {
  const target = await findTarget(id)
  const current = target.status as UserStatus

  assertNotSelf(target, actor, 'change the status of')

  if (!canTransition(current, status)) {
    throw new AppError(409, `A ${current} account cannot be moved to ${status}.`)
  }

  if (status !== 'Active') {
    await assertNotLastAdmin(target)
  }

  target.status = status
  target.statusUpdatedAt = new Date()
  target.statusUpdatedBy = actor._id
  // A note explains a rejection or suspension; clearing it on reactivation
  // stops a stale reason from following a restored account around.
  target.statusNote = status === 'Active' ? null : (note ?? null)
  await target.save()

  return toAdminUser(
    target,
    new Map([[String(actor._id), actor.name]]),
    await vendorRefsFor([target]),
  )
}

/**
 * Removes the account from Firebase and from MongoDB.
 *
 * Firebase goes first, deliberately. Deleting the Firebase user revokes its
 * refresh tokens, so an open session dies at its next refresh; the reverse
 * order would leave a live identity able to sign in and have `syncUserProfile`
 * recreate a fresh Pending profile. An already-missing Firebase user is not an
 * error — the profile still has to go.
 */
export async function removeUser(id: string, actor: UserDocument): Promise<{ id: string }> {
  const target = await findTarget(id)

  assertNotSelf(target, actor, 'delete')
  await assertNotLastAdmin(target)

  try {
    await getFirebaseAuth().deleteUser(target.firebaseUid)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'auth/user-not-found') {
      throw error
    }
  }

  await target.deleteOne()

  return { id: String(target._id) }
}
