import 'dotenv/config'
import * as z from 'zod'

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
   * Cloudinary stores profile photos; MongoDB only ever holds the reference.
   * Optional on purpose — an unconfigured deployment still boots and serves
   * everything else, and the photo endpoints answer 503. That is the same
   * posture the database already takes through requireDb.
   *
   * The API secret is server-side only. Nothing here is ever sent to a client.
   */
  CLOUDINARY_CLOUD_NAME: z.string().trim().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().trim().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().trim().min(1).optional(),
  CLOUDINARY_FOLDER: z.string().trim().min(1).default('lbts/avatars'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  // z.prettifyError replaces v3's .format()/.flatten() for human-readable output.
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error))
  process.exit(1)
}

/**
 * All three credentials, or none. A half-filled block is a configuration
 * mistake rather than a working setup, so it is reported as unset here instead
 * of failing halfway through an upload.
 */
const cloudinary =
  parsed.data.CLOUDINARY_CLOUD_NAME &&
  parsed.data.CLOUDINARY_API_KEY &&
  parsed.data.CLOUDINARY_API_SECRET
    ? {
        cloudName: parsed.data.CLOUDINARY_CLOUD_NAME,
        apiKey: parsed.data.CLOUDINARY_API_KEY,
        apiSecret: parsed.data.CLOUDINARY_API_SECRET,
        folder: parsed.data.CLOUDINARY_FOLDER,
      }
    : null

if (!cloudinary) {
  console.warn('[config] Cloudinary is not configured — profile photo uploads will return 503.')
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
    privateKey: parsed.data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  /** null when the deployment carries no Cloudinary credentials. */
  cloudinary,
} as const
