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
import { migrateExpenseNames } from './modules/accounts/accounts.migration'
import { seedAccounts } from './modules/accounts/accounts.seed'
import {
  foldLegacyVendorActivity,
  syncActivityIndexes,
} from './modules/activity/activity.migration'
import { backfillBillingStatus } from './modules/bill/bill.status'
import { dropLabourBillSlotCsd } from './modules/labour-bill/labour-bill.migration'
import {
  backfillChallanChargeStatus,
  backfillChallanLocations,
  foldLegacyChallanProducts,
  priceUnpricedChallanItems,
} from './modules/challan/challan.migration'
import {
  backfillChallanDispatch,
  migrateTripStatuses,
  purgeLegacyDeliveries,
  syncDeliveryIndexes,
} from './modules/delivery/delivery.migration'
import { seedLocationMaster } from './modules/location/location.seed'
import { startComplianceSweep, stopComplianceSweep } from './modules/notification/notification.compliance'
import {
  purgeOrphanedNotifications,
  syncNotificationIndexes,
} from './modules/notification/notification.migration'
import {
  foldLegacyGatePassProducts,
  purgeCancelledGatePasses,
} from './modules/gate-pass/gate-pass.migration'
import { seedProductRates } from './modules/product-rate/product-rate.seed'
import { backfillTripDoLedger } from './modules/trip-do/trip-do.sync'
import { normalizeLegacyUserRecords } from './modules/user/user.migration'

let server: Server | undefined

function shutdown(signal: string): void {
  console.log(`[server] ${signal} received, shutting down`)

  // The compliance sweep's interval is unref'd, so it could never hold the
  // process open — but a sweep that starts while the connection is closing
  // would log a failure nobody needs to read.
  stopComplianceSweep()

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
    // A first cash wallet, into an empty collection only.
    void seedAccounts()
    // Expenses recorded under the retired category list get that name as their typed expense name.
    void migrateExpenseNames()
    // A labour bill's slot was briefly a CSD and a month; it is a month, and the
    // sheet splits itself by the CSD on each row, so the field describes nothing.
    void dropLabourBillSlotCsd()
    /**
     * The activity journal. The TTL index first — MongoDB will not change an
     * existing one's expiry on its own, so a retention change would otherwise
     * do nothing at all — and then the fold of the legacy vendor journal,
     * which CLAUDE.md kept precisely so an Activity module would inherit a
     * complete history. The fold is idempotent (each row keeps its own id), so
     * every boot after the first is a no-op, and neither step ever throws.
     */
    void syncActivityIndexes().then(() => foldLegacyVendorActivity())
    /**
     * Notifications. The TTL index first, for the reason the journal's comes
     * first — MongoDB will not change an existing one's expiry on its own — then
     * the messages addressed to accounts that no longer exist, and only then the
     * compliance sweep.
     *
     * The sweep is last because it *writes* messages, and there is no point
     * announcing a lapsed certificate into a collection whose retention has not
     * been corrected yet. It is also the one scheduled job in this application:
     * a certificate expiring is the calendar rather than a request, so nothing
     * else would ever notice. See `notification.compliance.ts` for why a timer
     * rather than a cron, on a host that spins the process down.
     */
    void syncNotificationIndexes()
      .then(() => purgeOrphanedNotifications())
      .then(() => startComplianceSweep())
    /**
     * The `deliveries` collection was used once by an earlier delivery design
     * whose documents this module cannot read — and one of them made the trips
     * list answer 500 for the whole page. Its *indexes* outlived it too,
     * including a unique one on a field no trip here has, which refused every
     * delivery after the first; `syncDeliveryIndexes` is what clears those.
     */
    const dispatchReady = purgeLegacyDeliveries()
      .then(() => syncDeliveryIndexes())
      /**
       * Then the trips written while a status was something an operator
       * pressed. They become `Open`, because a trip is `Completed` when every
       * challan on it has been signed for and no historical trip has a signed
       * copy. Before the backfill below, which reads those statuses.
       */
      .then(() => migrateTripStatuses())
      /**
       * And then what the trips say about the challans they carried. Last,
       * because it reads the trips this pass has just cleaned up.
       */
      .then(() => backfillChallanDispatch())
    /**
     * The district/thana master list, and then the challans filed before it
     * existed. Sequential on purpose: the backfill matches against the
     * collection the seeder fills, so starting both at once would have it
     * match against an empty one.
     */
    const locationsReady = seedLocationMaster().then(() => backfillChallanLocations())
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
    const ratesReady = seedProductRates()
      .then(() => priceUnpricedChallanItems())
      /**
       * And then classify what is left. Last on purpose: pricing changes which
       * lines carry a rate, so classifying before it would file records under
       * a status the very next step invalidates.
       */
      .then(() => backfillChallanChargeStatus())
    /**
     * The Trip DO sheet copies a challan's location, its rates and what its
     * trips did, so it is built after all three chains above have settled.
     * Every step in them never throws, so waiting on all of them is safe.
     */
    void Promise.all([dispatchReady, locationsReady, ratesReady])
      .then(() => backfillTripDoLedger())
      /**
       * And then the billing status on challans and gate passes, which reads
       * the sheet rows the step before has just rebuilt.
       */
      .then(() => backfillBillingStatus())
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
