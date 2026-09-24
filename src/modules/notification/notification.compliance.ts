import { Types } from 'mongoose'
import { DriverModel } from '../vendor/driver.model'
import { VehicleModel } from '../vendor/vehicle.model'
import { VendorModel } from '../vendor/vendor.model'
import { VendorDocumentModel } from '../vendor/vendor-document.model'
import {
  DOCUMENT_EXPIRY_SOON_DAYS,
  daysUntilExpiry,
  documentStatusFor,
  startOfUtcDay,
} from '../vendor/vendor.constants'
import {
  COMPLIANCE_AUDIENCE_ROLES,
  COMPLIANCE_SWEEP_INTERVAL_MS,
} from './notification.constants'
import { notify } from './notification.recorder'

/**
 * The one notification in this system that nothing did.
 *
 * Every other event here is announced by the service that caused it, at the
 * moment it happened — somebody submitted a gate pass, somebody paid a vendor.
 * A certificate expiring is different in kind: **nothing happens.** The
 * calendar moves and a lorry that was road-legal on Tuesday is not on
 * Wednesday, and there is no request anywhere in the application to hang an
 * announcement off.
 *
 * CLAUDE.md says the Vendor module derives a document's status rather than
 * storing it, precisely because "a stored one is wrong the morning after it was
 * written with nothing there to notice". This sweep is the thing that notices.
 *
 * Three properties make it safe to run on a timer in a process that is usually
 * asleep:
 *
 * - **It is idempotent**, by a `groupKey` under a unique index rather than by a
 *   high-water mark. The key names the document, the status and the expiry
 *   date, so telling somebody twice about the same lapse is a duplicate-key
 *   error that is swallowed — while a *renewed* certificate has a new expiry
 *   date, and therefore a new key, and is announced again when it next lapses.
 *   No marker collection, no cursor, nothing to get wrong. It is the
 *   construction `foldLegacyVendorActivity` uses.
 * - **It never throws.** A sweep that took the API down on boot would be worse
 *   than the lapse it was reporting — the posture every migration and seeder in
 *   this codebase takes.
 * - **It is bounded.** One indexed range query, capped, so the cost does not
 *   grow with the fleet's history.
 */

/** A fuse rather than a policy: a fleet this size cannot honestly exceed it. */
const MAX_SWEEP_DOCUMENTS = 200

let sweepTimer: NodeJS.Timeout | undefined

/**
 * Formats the subject of a lapse as a person would say it.
 *
 * The owner is looked up because "Fitness Certificate expires in 4 days" is not
 * actionable and "Fitness Certificate on DHAKA METRO-TA-11-2233 expires in 4
 * days" is. Two queries for the whole sweep rather than one per document — the
 * treatment `resolveActorNames` gives the administration list.
 */
async function labelOwners(
  vehicleIds: Types.ObjectId[],
  driverIds: Types.ObjectId[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>()

  const [vehicles, drivers] = await Promise.all([
    vehicleIds.length > 0
      ? VehicleModel.find({ _id: { $in: vehicleIds } })
          .select('registrationNo')
          .lean()
      : [],
    driverIds.length > 0
      ? DriverModel.find({ _id: { $in: driverIds } })
          .select('name')
          .lean()
      : [],
  ])

  for (const vehicle of vehicles) {
    labels.set(String(vehicle._id), vehicle.registrationNo)
  }
  for (const driver of drivers) {
    labels.set(String(driver._id), driver.name)
  }

  return labels
}

/** How a lapse reads: "expired 3 days ago", "expires in 4 days", "expires today". */
function lapsePhrase(days: number): string {
  if (days < 0) {
    const ago = Math.abs(days)
    return `expired ${ago} ${ago === 1 ? 'day' : 'days'} ago`
  }
  if (days === 0) {
    return 'expires today'
  }
  return `expires in ${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * Announces every compliance document that has lapsed or is about to.
 *
 * Scoped to **active vendors only**. A vendor that has been deactivated is one
 * the operation has stopped using — CLAUDE.md is explicit that a vendor with
 * records behind it is deactivated and kept rather than deleted — and chasing
 * a tax token on a lorry nobody will book is exactly the kind of row that
 * teaches people to stop reading the panel.
 */
export async function sweepExpiringDocuments(): Promise<void> {
  try {
    const now = new Date()
    const today = startOfUtcDay(now)
    const horizon = new Date(today.getTime() + DOCUMENT_EXPIRY_SOON_DAYS * 86_400_000)

    /**
     * One indexed range read. `expiryDate` is indexed precisely because the
     * status is derived rather than stored, which is what makes "what lapses in
     * the next thirty days" a range query in the first place.
     */
    const documents = await VendorDocumentModel.find({
      expiryDate: { $ne: null, $lte: horizon },
    })
      .sort({ expiryDate: 1 })
      .limit(MAX_SWEEP_DOCUMENTS)
      .lean()

    if (documents.length === 0) {
      return
    }

    const vendorIds = [...new Set(documents.map((doc) => String(doc.vendorId)))]
    const activeVendors = await VendorModel.find({
      _id: { $in: vendorIds.map((id) => new Types.ObjectId(id)) },
      status: 'Active',
    })
      .select('name')
      .lean()

    const vendorNames = new Map(activeVendors.map((vendor) => [String(vendor._id), vendor.name]))

    const live = documents.filter((doc) => vendorNames.has(String(doc.vendorId)))
    if (live.length === 0) {
      return
    }

    const ownerLabels = await labelOwners(
      live.filter((doc) => doc.ownerType === 'Vehicle').map((doc) => doc.ownerId),
      live.filter((doc) => doc.ownerType === 'Driver').map((doc) => doc.ownerId),
    )

    for (const doc of live) {
      const expiryDate = doc.expiryDate as Date
      const status = documentStatusFor(expiryDate, now)

      // The query's horizon admits nothing else, but the status is what decides
      // the event — so it is asked rather than assumed.
      if (status === 'Valid') {
        continue
      }

      const days = daysUntilExpiry(expiryDate, now)
      const owner = ownerLabels.get(String(doc.ownerId)) ?? 'a removed record'
      const vendorName = vendorNames.get(String(doc.vendorId)) ?? 'a vendor'

      await notify({
        event: status === 'Expired' ? 'vendor.document-expired' : 'vendor.document-expiring',
        audience: { kind: 'roles', roles: COMPLIANCE_AUDIENCE_ROLES },
        title: `${doc.documentType} on ${owner} ${lapsePhrase(days)}`,
        body: `${vendorName} — ${doc.ownerType === 'Vehicle' ? 'vehicle' : 'driver'} ${owner}. Renew the document to clear this.`,
        entityType: 'Document',
        entityId: doc._id,
        entityLabel: `${doc.documentType} — ${owner}`,
        /**
         * The whole of the idempotency, and every part of it earns its place:
         * the document, so two certificates on one lorry are two messages; the
         * status, so a document that was "expiring" in April and is "expired" in
         * May is announced again, which is the one repeat worth making; and the
         * expiry date, so renewing it resets the key and the *next* lapse is
         * announced rather than silently deduped against the old one.
         */
        groupKey: `document:${String(doc._id)}:${status}:${expiryDate.toISOString().slice(0, 10)}`,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[notification] compliance sweep skipped: ${message}`)
  }
}

/**
 * Runs the sweep now, and then on a timer.
 *
 * On a timer rather than on a cron expression, because there is no scheduler
 * here and Render's free tier gives this process no promise of being awake at
 * three in the morning. Once on boot is what actually makes it reliable: the
 * instance wakes when somebody uses the app, which is also when somebody is
 * there to read the result.
 *
 * `unref` so a pending sweep never holds the process open during a shutdown —
 * the treatment `connectDatabase`'s retry timer gets.
 */
export function startComplianceSweep(): void {
  if (sweepTimer) {
    return
  }

  void sweepExpiringDocuments()

  sweepTimer = setInterval(() => {
    void sweepExpiringDocuments()
  }, COMPLIANCE_SWEEP_INTERVAL_MS)
  sweepTimer.unref()
}

export function stopComplianceSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = undefined
  }
}
