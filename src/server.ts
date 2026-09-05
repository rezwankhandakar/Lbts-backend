import type { Server } from 'node:http'
import app from './app'
import { config } from './config/index'
import {
  connectDatabase,
  disconnectDatabase,
  onceConnected,
  registerConnectionEvents,
} from './config/db'
import { ensureDnsResolvers } from './config/dns'
import { foldLegacyChallanProducts } from './modules/challan/challan.migration'
import {
  foldLegacyGatePassProducts,
  purgeCancelledGatePasses,
} from './modules/gate-pass/gate-pass.migration'
import { normalizeLegacyUserRecords } from './modules/user/user.migration'

let server: Server | undefined

function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`)

  const finish = () => {
    disconnectDatabase()
      .then(() => {
        console.log('[server] shutdown complete')
        process.exit(0)
      })
      .catch((error: unknown) => {
        console.error('[server] error during shutdown', error)
        process.exit(1)
      })
  }

  if (server) {
    server.close(finish)
  } else {
    finish()
  }

  // Do not hang forever on lingering keep-alive sockets.
  setTimeout(() => {
    console.error('[server] forced exit after shutdown timeout')
    process.exit(1)
  }, 10_000).unref()
}

function start(): void {
  // Must run before any SRV lookup, i.e. before Mongoose connects.
  ensureDnsResolvers()
  registerConnectionEvents()

  /**
   * The listener starts BEFORE the database connects, so /health answers as
   * soon as the process is alive. On Render's free tier a cold start plus a
   * slow Atlas handshake would otherwise fail the platform health check and
   * kill the service. connectDatabase never throws; it retries in the
   * background and requireDb returns 503 while the connection is down.
   */
  server = app.listen(config.port, () => {
    console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`)
  })

  void connectDatabase()

  // Brings records written under the old role/status vocabulary in line with
  // the current enums. Without it those documents cannot be saved at all.
  onceConnected(() => {
    void normalizeLegacyUserRecords()
    // Gate passes written before a challan could carry several product lines
    // still hold one product on the record itself, where nothing can read it.
    void foldLegacyGatePassProducts()
    // Withdrawing a gate pass is a delete now, so records parked in the
    // retired Cancelled status hold a value the schema no longer accepts.
    void purgeCancelledGatePasses()
    // Challans written before one could carry several product lines still hold
    // a single product on the record itself, where nothing can read it — and
    // where its quantity drops out of every total the list reports.
    void foldLegacyChallanProducts()
  })

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[server] unhandled rejection', reason)
    shutdown('unhandledRejection')
  })

  process.on('uncaughtException', (error: Error) => {
    console.error('[server] uncaught exception', error)
    process.exit(1)
  })
}

start()
