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
import {
  backfillChallanChargeStatus,
  backfillChallanLocations,
  foldLegacyChallanProducts,
  priceUnpricedChallanItems,
} from './modules/challan/challan.migration'
import { seedLocationMaster } from './modules/location/location.seed'
import {
  foldLegacyGatePassProducts,
  purgeCancelledGatePasses,
} from './modules/gate-pass/gate-pass.migration'
import { seedProductRates } from './modules/product-rate/product-rate.seed'
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
    /**
     * The district/thana master list, and then the challans filed before it
     * existed. Sequential on purpose: the backfill matches against the
     * collection the seeder fills, so starting both at once would have it
     * match against an empty one.
     */
    void seedLocationMaster().then(() => backfillChallanLocations())
    /**
     * The rate card, and then the challans whose lines it could not price when
     * they were filed. Sequential for the same reason the location pair is:
     * the backfill matches against the collection the seeder fills.
     *
     * It fills blanks only — a line already carrying a figure keeps it — so
     * this is not the bulk re-pricing the module refuses. It is the challans
     * filed before their product was on the card, and the ones filed before
     * the matcher could see the card's model inside a longer challan code.
     */
    void seedProductRates()
      .then(() => priceUnpricedChallanItems())
      /**
       * And then classify what is left. Last on purpose: pricing changes which
       * lines carry a rate, so classifying before it would file records under
       * a status the very next step invalidates.
       */
      .then(() => backfillChallanChargeStatus())
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
