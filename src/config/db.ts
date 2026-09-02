import mongoose from 'mongoose'
import { config } from './index'

const RETRY_DELAY_MS = 5_000

let retryTimer: NodeJS.Timeout | undefined

/**
 * Atlas M0 (free tier) caps concurrent connections, so the pool is kept small
 * and explicit rather than left at the driver default. See CLAUDE.md.
 */
const connectionOptions: mongoose.ConnectOptions = {
  maxPoolSize: 10,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  /**
   * The HTTP server starts before Mongo connects, so a query issued while the
   * connection is down would otherwise buffer silently until bufferTimeoutMS
   * expires and then fail with an opaque error. Fail fast instead — the
   * requireDb middleware turns that into a clean 503.
   */
  bufferCommands: false,
}

export function registerConnectionEvents(): void {
  const connection = mongoose.connection

  connection.on('connected', () => {
    console.log('[db] connected')
  })

  connection.on('disconnected', () => {
    console.warn('[db] disconnected')
  })

  connection.on('reconnected', () => {
    console.log('[db] reconnected')
  })

  connection.on('error', (error: Error) => {
    console.error(`[db] connection error: ${error.message}`)
  })
}

/**
 * Attempts a connection and retries indefinitely on failure. Never throws, so
 * a database outage cannot take down the HTTP listener.
 */
export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.databaseUrl, connectionOptions)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[db] initial connection failed: ${message}`)
    console.error(`[db] retrying in ${RETRY_DELAY_MS / 1000}s`)

    retryTimer = setTimeout(() => {
      void connectDatabase()
    }, RETRY_DELAY_MS)
    retryTimer.unref()
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (retryTimer) {
    clearTimeout(retryTimer)
  }
  await mongoose.connection.close()
}

/** 0 disconnected, 1 connected, 2 connecting, 3 disconnecting. */
export function getConnectionState(): string {
  const states: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  }
  return states[mongoose.connection.readyState] ?? 'unknown'
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1
}

/**
 * Runs `handler` as soon as the database is usable — immediately if it already
 * is, otherwise on the next successful connection. `once`, so a later reconnect
 * does not run it again.
 *
 * Kept here rather than in server.ts so nothing outside this module has to know
 * that connectDatabase resolves whether or not the connection actually came up.
 */
export function onceConnected(handler: () => void): void {
  if (isDatabaseConnected()) {
    handler()
    return
  }
  mongoose.connection.once('connected', handler)
}
