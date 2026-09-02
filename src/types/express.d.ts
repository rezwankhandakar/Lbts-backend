import type { DecodedIdToken } from 'firebase-admin/auth'
import type { UserDocument } from '../modules/user/user.model'

declare global {
  namespace Express {
    interface Request {
      /** Verified Firebase ID token claims. Set by the auth middleware. */
      firebaseUser?: DecodedIdToken
      /**
       * The MongoDB profile for the authenticated user, when one exists.
       * Absent on a first-ever sign-in, before POST /users/sync has run.
       */
      user?: UserDocument
      /**
       * Output of validateRequest. Express 5 made req.query a read-only
       * getter, so parsed data is attached here rather than written back
       * onto req.query.
       */
      validated?: {
        body?: unknown
        query?: unknown
        params?: unknown
      }
    }
  }
}

export {}
