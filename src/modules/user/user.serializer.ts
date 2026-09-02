import type { Types } from 'mongoose'
import type { UserDocument } from './user.model'
import type { UserRole, UserStatus } from './user.constants'

/**
 * The shape the signed-in user sees of their own account, and everything the
 * profile module renders. `photoPublicId` is deliberately absent: it is an
 * internal storage reference with no meaning to a client.
 */
export interface PublicUser {
  id: string
  firebaseUid: string
  email: string
  name: string
  phone: string | null
  photoUrl: string | null
  emailVerified: boolean
  role: UserRole
  status: UserStatus
  createdAt: string
  lastLoginAt: string | null
}

/** Who last changed a role or a status, resolved to something displayable. */
export interface ActorRef {
  id: string
  name: string
}

/**
 * The administration view. A superset of PublicUser: it carries the lifecycle
 * metadata the Admin needs to judge an account, so the details panel needs no
 * second request.
 */
export interface AdminUser extends PublicUser {
  roleUpdatedAt: string | null
  roleUpdatedBy: ActorRef | null
  statusUpdatedAt: string | null
  statusUpdatedBy: ActorRef | null
  statusNote: string | null
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: String(user._id),
    firebaseUid: user.firebaseUid,
    email: user.email,
    name: user.name,
    phone: user.phone ?? null,
    photoUrl: user.photoUrl ?? null,
    emailVerified: user.emailVerified,
    role: user.role as UserRole,
    status: user.status as UserStatus,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: toIso(user.lastLoginAt),
  }
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
 * `actorNames` maps an actor's id to their display name. The caller resolves
 * every actor on the page in one query rather than populating per row — on M0
 * the difference between one $in lookup and N lookups is worth the plumbing.
 */
export function toAdminUser(user: UserDocument, actorNames: Map<string, string>): AdminUser {
  return {
    ...toPublicUser(user),
    roleUpdatedAt: toIso(user.roleUpdatedAt),
    roleUpdatedBy: actorFrom(user.roleUpdatedBy, actorNames),
    statusUpdatedAt: toIso(user.statusUpdatedAt),
    statusUpdatedBy: actorFrom(user.statusUpdatedBy, actorNames),
    statusNote: user.statusNote ?? null,
  }
}
