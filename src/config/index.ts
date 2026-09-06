import 'dotenv/config'
import * as z from 'zod'

/**
 * A variable left blank in a .env file arrives as an empty string, not as
 * absent — `R2_BUCKET=` and no `R2_BUCKET` line at all are the same intent.
 * Every optional variable below is read through this, so emptying the values
 * leaves that feature cleanly unconfigured instead of failing startup on a
 * "too small" string.
 */
function blank(value: unknown): unknown {
  return typeof value === 'string' && value.trim().length === 0 ? undefined : value
}

/**
 * Environment contract. Validated once at startup so a missing or malformed
 * variable fails immediately with a readable message, rather than surfacing as
 * `undefined` somewhere deep in a request handler.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CLIENT_ORIGIN: z.string().min(1).default('http://localhost:5173'),

  // Firebase Admin service account. Firebase owns authentication; this is what
  // lets the API verify the ID tokens the browser sends.
  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  FIREBASE_CLIENT_EMAIL: z.string().min(1, 'FIREBASE_CLIENT_EMAIL is required'),
  FIREBASE_PRIVATE_KEY: z.string().min(1, 'FIREBASE_PRIVATE_KEY is required'),

  /**
   * Cloudflare R2 stores profile photos; MongoDB only ever holds the reference.
   * Optional on purpose — an unconfigured deployment still boots and serves
   * everything else, and the photo endpoints answer 503. That is the same
   * posture the database already takes through requireDb.
   *
   * The secret access key is server-side only. Nothing here is ever sent to a
   * client: the browser uploads to the API, and the API uploads to R2.
   */
  R2_ACCOUNT_ID: z.preprocess(blank, z.string().trim().min(1).optional()),
  R2_ACCESS_KEY_ID: z.preprocess(blank, z.string().trim().min(1).optional()),
  R2_SECRET_ACCESS_KEY: z.preprocess(blank, z.string().trim().min(1).optional()),
  R2_BUCKET: z.preprocess(blank, z.string().trim().min(1).optional()),
  /**
   * How the world reads the bucket. R2 buckets are private by default, so this
   * is either the bucket's r2.dev development subdomain or — in production — a
   * custom domain routed to it. There is no way to derive it from the account
   * id, which is why it is a separate variable rather than a computed one.
   */
  R2_PUBLIC_BASE_URL: z.preprocess(blank, z.url().optional()),
  /** Key prefix every avatar is stored under. Object storage has no folders. */
  R2_KEY_PREFIX: z.preprocess(blank, z.string().trim().min(1).default('avatars')),
  /**
   * Key prefix for scanned gate pass documents, kept separate from avatars so
   * the two can be given different lifecycle rules in the bucket — an avatar
   * is disposable, a gate pass is a business record.
   */
  R2_GATE_PASS_PREFIX: z.preprocess(blank, z.string().trim().min(1).default('gate-passes')),
  /**
   * Key prefix for generated challan documents. Its own prefix for the same
   * reason gate passes have one: a challan document is a business record with
   * a different retention story from a disposable avatar, and the bucket can
   * only give the two different lifecycle rules if they sit under different
   * keys.
   *
   * The *source* WhatsApp PDF is never written under this prefix, or anywhere
   * else. It is a temporary working document held in the operator's browser;
   * what lands here is only what an individual submitted challan became.
   */
  R2_CHALLAN_PREFIX: z.preprocess(blank, z.string().trim().min(1).default('challans')),

  /**
   * Gemini, which helps choose between location candidates this server has
   * already narrowed down. Optional in exactly the way R2 is: unconfigured,
   * the API boots and everything works, and location resolution simply stops
   * one step earlier — at the local matcher — leaving anything it could not
   * settle for a person.
   *
   * The key is server-side only and must never appear in a VITE_ variable.
   * The browser asks this API to resolve a location; this API asks Gemini.
   */
  GEMINI_API_KEY: z.preprocess(blank, z.string().trim().min(1).optional()),
  GEMINI_MODEL: z.preprocess(blank, z.string().trim().min(1).default('gemini-2.5-flash')),
  /**
   * How sure Gemini has to be before its choice is written to a challan.
   * Clamped to a floor in the resolver, because the business rule is that a
   * blank location beats a wrong one and a threshold near zero would invert it.
   */
  GEMINI_CONFIDENCE: z.preprocess(blank, z.coerce.number().min(0).max(1).default(0.85)),
  /**
   * Short on purpose. This runs while an operator is waiting to submit a
   * challan, and the correct answer to a slow model is to leave the location
   * blank and carry on — not to hold up the filing.
   */
  GEMINI_TIMEOUT_MS: z.preprocess(blank, z.coerce.number().int().min(1000).max(30000).default(8000)),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  // z.prettifyError replaces v3's .format()/.flatten() for human-readable output.
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error))
  process.exit(1)
}

/** `avatars/`, `/avatars` and `avatars` all have to produce the same key. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

/**
 * All five credentials, or none. A half-filled block is a configuration
 * mistake rather than a working setup, so it is reported as unset here instead
 * of failing halfway through an upload.
 */
const r2 =
  parsed.data.R2_ACCOUNT_ID &&
  parsed.data.R2_ACCESS_KEY_ID &&
  parsed.data.R2_SECRET_ACCESS_KEY &&
  parsed.data.R2_BUCKET &&
  parsed.data.R2_PUBLIC_BASE_URL
    ? {
        accessKeyId: parsed.data.R2_ACCESS_KEY_ID,
        secretAccessKey: parsed.data.R2_SECRET_ACCESS_KEY,
        bucket: parsed.data.R2_BUCKET,
        /**
         * The S3 API endpoint, which is always this shape for R2. It is not
         * the public URL and never serves an image — it is the authenticated
         * write side, reached only by this process.
         */
        endpoint: `https://${parsed.data.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        publicBaseUrl: parsed.data.R2_PUBLIC_BASE_URL.replace(/\/+$/, ''),
        keyPrefix: trimSlashes(parsed.data.R2_KEY_PREFIX),
        gatePassKeyPrefix: trimSlashes(parsed.data.R2_GATE_PASS_PREFIX),
        challanKeyPrefix: trimSlashes(parsed.data.R2_CHALLAN_PREFIX),
      }
    : null

if (!r2) {
  console.warn(
    '[config] Cloudflare R2 is not configured — profile photo, gate pass and challan document endpoints will return 503.',
  )
}

/**
 * Gemini is assistive and entirely optional, so an absent key is a
 * configuration state rather than an error. Everything downstream reads
 * `config.gemini === null` and takes the local-only path.
 */
const gemini = parsed.data.GEMINI_API_KEY
  ? {
      apiKey: parsed.data.GEMINI_API_KEY,
      model: parsed.data.GEMINI_MODEL,
      minConfidence: parsed.data.GEMINI_CONFIDENCE,
      timeoutMs: parsed.data.GEMINI_TIMEOUT_MS,
    }
  : null

if (!gemini) {
  console.warn(
    '[config] Gemini is not configured — location resolution will use the master collection only, and anything it cannot settle is left for an administrator.',
  )
}

export const config = {
  port: parsed.data.PORT,
  nodeEnv: parsed.data.NODE_ENV,
  isProduction: parsed.data.NODE_ENV === 'production',
  isDevelopment: parsed.data.NODE_ENV === 'development',
  databaseUrl: parsed.data.DATABASE_URL,
  /**
   * Comma-separated, so one deployment can serve a production domain and a
   * preview domain without a code change.
   */
  clientOrigins: parsed.data.CLIENT_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  firebase: {
    projectId: parsed.data.FIREBASE_PROJECT_ID,
    clientEmail: parsed.data.FIREBASE_CLIENT_EMAIL,
    /**
     * A PEM key spans multiple lines. Dashboards and .env files carry it as a
     * single line with literal "\n" sequences, which must be turned back into
     * real newlines or the SDK rejects the credential.
     */
    privateKey: parsed.data.FIREBASE_PRIVATE_KEY.replace(/\n/g, '\n'),
  },
  /** null when the deployment carries no Cloudflare R2 credentials. */
  r2,
  /**
   * null when no Gemini key is configured. The location resolver checks this
   * and skips its assisted step entirely — it never becomes a failed request
   * that has to be caught, and nothing in the Challan module notices.
   */
  gemini,
} as const
