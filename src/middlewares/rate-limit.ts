import type { Request } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

/**
 * The API-wide request budget, counted **per signed-in account** with a higher
 * ceiling **per address** underneath it.
 *
 * It used to be one bucket of 300 per IP address, which was wrong for this
 * operation in two ways at once. An office puts every operator behind one
 * public address, so three people filing gate passes shared a single 300 —
 * and filing is genuinely request-heavy (type-ahead on four fields, a duplicate
 * probe, then create, upload and submit), so a dozen gate passes spent the lot
 * and the thirteenth was refused with "Too many requests".
 *
 * The account key is read out of the Firebase ID token **without verifying
 * it**. That is safe for this job and only this job: the key decides which
 * bucket a request is counted in, never whether it is allowed — `auth`
 * verifies the token on every route after this. A forged token could pick its
 * own bucket, which is exactly why the per-address ceiling stays: it is the
 * limit an abuser meets, and it is set high enough that a whole office working
 * normally never does.
 */

const WINDOW_MS = 15 * 60 * 1000

/** One account's budget per window — a full shift's filing pace, several times over. */
export const PER_ACCOUNT_LIMIT = 600

/** One address's budget per window, shared by everyone behind it. */
export const PER_ADDRESS_LIMIT = 3000

const MESSAGE = {
  success: false,
  message: 'Too many requests. Please try again later.',
  errorSources: [{ path: '', message: 'Rate limit exceeded.' }],
}

/**
 * The Firebase uid inside a bearer token, or null for anything that is not a
 * readable JWT. Pure, and tested: a malformed header must fall back to the
 * address rather than throw inside a middleware every request passes through.
 */
export function accountKeyFromAuthorization(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null
  }

  const [, payload] = header.slice('Bearer '.length).trim().split('.')
  if (!payload) {
    return null
  }

  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims !== 'object' || claims === null) {
      return null
    }
    const subject = (claims as { sub?: unknown }).sub
    return typeof subject === 'string' && subject.length > 0 && subject.length <= 128
      ? subject
      : null
  } catch {
    return null
  }
}

function addressKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? '')}`
}

export const accountLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: PER_ACCOUNT_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const account = accountKeyFromAuthorization(req.headers.authorization)
    // A request with no token — sign-in pages, /health — falls back to the address.
    return account ? `uid:${account}` : addressKey(req)
  },
  message: MESSAGE,
})

export const addressLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: PER_ADDRESS_LIMIT,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: addressKey,
  message: MESSAGE,
})
