import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import morgan from 'morgan'
import { config } from './config/index'
import { globalErrorHandler } from './middlewares/global-error-handler'
import { notFound } from './middlewares/not-found'
import { apiRouter } from './routes/index'

const app = express()

// Render terminates TLS upstream, so trust its proxy for correct client IPs.
// Without this the rate limiter would bucket every request under one address.
app.set('trust proxy', 1)

app.use(helmet())

/**
 * Vite falls back to the next free port when 5173 is taken, so pinning one
 * localhost origin breaks as soon as a stale dev server is running. Any
 * localhost port is accepted in development; production stays strict.
 */
function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && url.hostname === 'localhost'
  } catch {
    return false
  }
}

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and non-browser callers (curl, Render health checks) send
      // no Origin header at all.
      if (!origin) {
        callback(null, true)
        return
      }

      if (config.clientOrigins.includes(origin)) {
        callback(null, true)
        return
      }

      if (!config.isProduction && isLocalhostOrigin(origin)) {
        callback(null, true)
        return
      }

      console.warn(`[cors] blocked origin: ${origin}`)
      callback(null, false)
    },
    credentials: true,
    /**
     * The browser cannot read a response header it was not handed across an
     * origin, and the frontend is on Netlify while this is on Render. Without
     * this the gate pass export would save as a generic filename, because the
     * name the server chose is in a header the client would never see.
     */
    exposedHeaders: ['Content-Disposition'],
  }),
)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(cookieParser())

if (config.isDevelopment) {
  app.use(morgan('dev'))
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
    errorSources: [{ path: '', message: 'Rate limit exceeded.' }],
  },
})

app.use('/api', apiLimiter)
app.use('/api/v1', apiRouter)

// Pathless: Express 5 rejects a bare '*' path.
app.use(notFound)
app.use(globalErrorHandler)

export default app
