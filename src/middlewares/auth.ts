import type { NextFunction, Request, Response } from 'express'
import { getFirebaseAuth } from '../config/firebase'
import type { UserRole } from '../modules/user/user.constants'
import { findUserByFirebaseUid } from '../modules/user/user.service'
import { AppError } from '../utils/app-error'

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization

  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim()
  }

  const cookieToken: unknown = req.cookies?.idToken
  return typeof cookieToken === 'string' ? cookieToken : undefined
}

/**
 * Verifies the Firebase ID token and loads the matching MongoDB profile.
 *
 * Firebase owns identity (password, session, Google); MongoDB owns the role.
 * The profile is optional here because POST /users/sync is what creates it —
 * on a first-ever sign-in the token is valid but no profile exists yet.
 *
 * This layer deliberately does NOT reject an account whose status is not
 * Active. A Pending or Suspended user must still be able to read their own
 * profile, otherwise the client cannot tell them why they are locked out.
 * The lifecycle gate is requireActiveAccount, which every route that does real
 * work must mount — requireRole applies it for you.
 *
 * Express 5 forwards the async rejection from verifyIdToken to the global
 * handler, which maps Firebase auth/* codes to 401.
 */
export async function auth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req)

  if (!token) {
    next(new AppError(401, 'Authentication required.'))
    return
  }

  const decoded = await getFirebaseAuth().verifyIdToken(token)
  req.firebaseUser = decoded

  const profile = await findUserByFirebaseUid(decoded.uid)

  if (profile) {
    req.user = profile
  }

  next()
}

/** The message a locked-out account sees, phrased per lifecycle state. */
const STATUS_MESSAGES: Record<string, string> = {
  Pending: 'Your account is awaiting administrator approval.',
  Rejected: 'Your account request was declined. Contact an administrator.',
  Suspended: 'This account has been suspended. Contact an administrator.',
}

/**
 * Rejects anyone whose account is not Active. Mount this on every route that
 * does real work; requireRole already includes it, so a role-guarded route
 * does not need both.
 */
export function requireActiveAccount(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new AppError(403, 'Profile not found. Sync the account first.'))
    return
  }

  if (req.user.status !== 'Active') {
    next(new AppError(403, STATUS_MESSAGES[req.user.status] ?? 'This account is not active.'))
    return
  }

  next()
}

/**
 * Restricts a route to specific roles. The role is read from MongoDB, never
 * from the token, so revoking an Admin takes effect on the very next request —
 * a custom claim would keep working until the client refreshed its token.
 *
 * The status check runs first: a suspended Admin is not an Admin.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    requireActiveAccount(req, res, (error?: unknown) => {
      if (error) {
        next(error)
        return
      }

      // requireActiveAccount has already proved req.user exists.
      const role = req.user?.role as UserRole

      if (!roles.includes(role)) {
        next(new AppError(403, 'You do not have permission to perform this action.'))
        return
      }

      next()
    })
  }
}
