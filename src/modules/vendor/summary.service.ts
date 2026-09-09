import { Types } from 'mongoose'
import type { UserDocument } from '../user/user.model'
import { AssignmentModel } from './assignment.model'
import { DriverModel } from './driver.model'
import { VehicleModel } from './vehicle.model'
import { VendorDocumentModel } from './vendor-document.model'
import { VendorModel } from './vendor.model'
import { assertCanReadVendor, vendorFilterFor } from './vendor.access'
import { listActivity } from './vendor.activity'
import { MAX_SUMMARY_ALERTS } from './vendor.constants'
import type { DriverStatus, VehicleStatus, VendorStatus } from './vendor.constants'
import { expiryWindow, findVendorOr404 } from './vendor.lookups'
import { listAssignments } from './assignment.service'
import { listDocuments } from './document.service'
import type { ActivityRecord, AssignmentRecord, DocumentRecord } from './vendor.serializer'
import {
  listAssignmentsQuerySchema,
  listDocumentsQuerySchema,
} from './vendor.validation'

/**
 * Everything the vendor overview needs, in one request.
 *
 * CLAUDE.md asks each module to prefer an efficient summary endpoint over a
 * screenful of separate calls, and this is the one place in the module where
 * that matters: an overview firing six requests at a sleeping Render instance
 * is six cold starts stacked one behind the other. What it costs instead is one
 * handler that fans out in parallel and answers once.
 *
 * Every number here is counted from the collections. There is no placeholder
 * figure anywhere in this file, and an overview that invented one would be
 * worse than an overview that admitted it had none.
 */

export interface VehicleSummary {
  total: number
  active: number
  inactive: number
  maintenance: number
  suspended: number
  expired: number
}

export interface DriverSummary {
  total: number
  active: number
  inactive: number
  suspended: number
  onLeave: number
}

export interface ComplianceSummary {
  total: number
  valid: number
  expiringSoon: number
  expired: number
}

/**
 * One thing that wants somebody's attention, and where to go about it.
 *
 * `severity` decides the colour and `filter` decides where pressing it lands —
 * which is what makes an alert actionable rather than an announcement. Nothing
 * here is generated speculatively: a vendor with nothing wrong gets an empty
 * array and the panel says so.
 */
export interface ComplianceAlert {
  id: string
  severity: 'critical' | 'warning'
  /** Which tab answers it, and with what filter applied. */
  tab: 'documents' | 'vehicles' | 'drivers'
  filter: Record<string, string>
  title: string
  detail: string
  count: number
}

export interface VendorSummary {
  vehicles: VehicleSummary
  drivers: DriverSummary
  documents: ComplianceSummary
  alerts: ComplianceAlert[]
  /** How many alerts were left out of the list above, if any. */
  moreAlerts: number
  activeAssignments: number
  recentAssignments: AssignmentRecord[]
  expiringDocuments: DocumentRecord[]
  recentActivity: ActivityRecord[]
}

/** Summed from the grouped rows, so it can never disagree with the parts. */
function sumOf(rows: { count: number }[]): number {
  return rows.reduce((total, row) => total + row.count, 0)
}

export async function getVendorSummary(
  vendorId: string,
  viewer: UserDocument,
): Promise<VendorSummary> {
  assertCanReadVendor(vendorId, viewer)
  // Proves the vendor exists before six queries are spent on an id that is not
  // one — and gives the Vendor account the same 404 as any other stranger.
  await findVendorOr404(vendorId)

  const { today, soon } = expiryWindow()

  /**
   * An aggregation `$match` does no schema casting, unlike a `find`, so the id
   * has to arrive as an ObjectId rather than as the string it was in the URL.
   * A string here matches nothing and reports a vendor with an empty fleet,
   * which is the quietest possible way for this panel to be wrong.
   */
  const vendorObjectId = new Types.ObjectId(vendorId)

  const [vehicleRows, driverRows, documentRows, activeAssignments] = await Promise.all([
    VehicleModel.aggregate<{ _id: string; count: number }>([
      { $match: { vendorId: vendorObjectId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    DriverModel.aggregate<{ _id: string; count: number }>([
      { $match: { vendorId: vendorObjectId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    VendorDocumentModel.aggregate<{ _id: string; count: number }>([
      { $match: { vendorId: vendorObjectId } },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$expiryDate', null] },
              'Valid',
              {
                $cond: [
                  { $lt: ['$expiryDate', today] },
                  'Expired',
                  { $cond: [{ $lte: ['$expiryDate', soon] }, 'Expiring Soon', 'Valid'] },
                ],
              },
            ],
          },
          count: { $sum: 1 },
        },
      },
    ]),
    AssignmentModel.countDocuments({ vendorId, status: 'Active' }),
  ])

  const vehicleCounts = new Map(vehicleRows.map((row) => [row._id, row.count]))
  const driverCounts = new Map(driverRows.map((row) => [row._id, row.count]))
  const documentCounts = new Map(documentRows.map((row) => [row._id, row.count]))

  const vehicle = (status: VehicleStatus): number => vehicleCounts.get(status) ?? 0
  const driver = (status: DriverStatus): number => driverCounts.get(status) ?? 0

  const vehicles: VehicleSummary = {
    total: sumOf(vehicleRows),
    active: vehicle('Active'),
    inactive: vehicle('Inactive'),
    maintenance: vehicle('Under Maintenance'),
    suspended: vehicle('Suspended'),
    expired: vehicle('Expired'),
  }

  const drivers: DriverSummary = {
    total: sumOf(driverRows),
    active: driver('Active'),
    inactive: driver('Inactive'),
    suspended: driver('Suspended'),
    onLeave: driver('On Leave'),
  }

  const documents: ComplianceSummary = {
    total: sumOf(documentRows),
    valid: documentCounts.get('Valid') ?? 0,
    expiringSoon: documentCounts.get('Expiring Soon') ?? 0,
    expired: documentCounts.get('Expired') ?? 0,
  }

  /**
   * The three lists underneath the numbers, fetched in parallel with each other
   * and reusing the list services rather than growing a second set of queries —
   * so a summary can never describe a set of records the tabs would disagree
   * with.
   */
  const [expiring, recent, activity] = await Promise.all([
    listDocuments(
      vendorId,
      listDocumentsQuerySchema.parse({ limit: '5', status: 'Expiring Soon' }),
      viewer,
    ),
    listAssignments(vendorId, listAssignmentsQuerySchema.parse({ limit: '5' }), viewer),
    listActivity(vendorId, 8),
  ])

  const alerts = buildAlerts(vehicles, drivers, documents)

  return {
    vehicles,
    drivers,
    documents,
    alerts: alerts.slice(0, MAX_SUMMARY_ALERTS),
    moreAlerts: Math.max(0, alerts.length - MAX_SUMMARY_ALERTS),
    activeAssignments,
    recentAssignments: recent.records,
    expiringDocuments: expiring.records,
    recentActivity: activity,
  }
}

/**
 * Turns the counts into a to-do list.
 *
 * Severest first, and only where there is something to act on — a vendor with
 * nothing wrong gets no alerts rather than a row saying everything is fine,
 * because a panel that always has content is one people stop reading. That is
 * the opposite of the rule a *status badge* follows on a row, where an absent
 * chip would wrongly read as "no information": here an absent alert means there
 * is nothing to do, which is exactly what it looks like.
 *
 * Every alert carries the filter that answers it, so pressing one lands on the
 * rows rather than on a tab somebody then has to narrow by hand.
 */
function buildAlerts(
  vehicles: VehicleSummary,
  drivers: DriverSummary,
  documents: ComplianceSummary,
): ComplianceAlert[] {
  const alerts: ComplianceAlert[] = []

  if (documents.expired > 0) {
    alerts.push({
      id: 'documents-expired',
      severity: 'critical',
      tab: 'documents',
      filter: { status: 'Expired' },
      title: `${documents.expired} document${documents.expired === 1 ? '' : 's'} expired`,
      detail: 'A vehicle or driver is working on papers that have run out.',
      count: documents.expired,
    })
  }

  if (documents.expiringSoon > 0) {
    alerts.push({
      id: 'documents-expiring',
      severity: 'warning',
      tab: 'documents',
      filter: { status: 'Expiring Soon' },
      title: `${documents.expiringSoon} document${
        documents.expiringSoon === 1 ? '' : 's'
      } expiring soon`,
      detail: 'Renew these before the vehicle or driver has to stand down.',
      count: documents.expiringSoon,
    })
  }

  if (vehicles.expired > 0) {
    alerts.push({
      id: 'vehicles-expired',
      severity: 'critical',
      tab: 'vehicles',
      filter: { status: 'Expired' },
      title: `${vehicles.expired} vehicle${vehicles.expired === 1 ? '' : 's'} marked expired`,
      detail: 'These cannot be given a driver until their papers are back in order.',
      count: vehicles.expired,
    })
  }

  if (vehicles.maintenance > 0) {
    alerts.push({
      id: 'vehicles-maintenance',
      severity: 'warning',
      tab: 'vehicles',
      filter: { status: 'Under Maintenance' },
      title: `${vehicles.maintenance} vehicle${
        vehicles.maintenance === 1 ? ' is' : 's are'
      } under maintenance`,
      detail: 'Out of service, and not available for a new assignment.',
      count: vehicles.maintenance,
    })
  }

  if (drivers.suspended > 0) {
    alerts.push({
      id: 'drivers-suspended',
      severity: 'critical',
      tab: 'drivers',
      filter: { status: 'Suspended' },
      title: `${drivers.suspended} driver${drivers.suspended === 1 ? ' is' : 's are'} suspended`,
      detail: 'They cannot be assigned until the suspension is lifted.',
      count: drivers.suspended,
    })
  }

  if (drivers.onLeave > 0) {
    alerts.push({
      id: 'drivers-leave',
      severity: 'warning',
      tab: 'drivers',
      filter: { status: 'On Leave' },
      title: `${drivers.onLeave} driver${drivers.onLeave === 1 ? ' is' : 's are'} on leave`,
      detail: 'Plan cover for any vehicle they were on.',
      count: drivers.onLeave,
    })
  }

  return alerts
}

// --- Cross-vendor statistics ----------------------------------------------

export interface VendorStats {
  total: number
  active: number
  pending: number
  inactive: number
  suspended: number
  vehicles: number
  drivers: number
  expiredDocuments: number
  expiringDocuments: number
}

/**
 * The figures above the vendor list.
 *
 * Scoped exactly like the list underneath it, so a Vendor account's overview
 * describes their own vendor rather than the collection — a summary that
 * ignored the viewer would be the one number on the page answering a different
 * question, which is the mistake the Challan backlog chips were written to
 * avoid.
 */
export async function getVendorStats(viewer: UserDocument): Promise<VendorStats> {
  const scope = vendorFilterFor(viewer)
  const vendorMatch = scope ? { _id: scope.vendorId } : {}
  const childMatch: Record<string, unknown> = scope ? { vendorId: scope.vendorId } : {}

  const { today, soon } = expiryWindow()

  const [rows, vehicles, drivers, documents] = await Promise.all([
    VendorModel.aggregate<{ _id: string; count: number }>([
      { $match: vendorMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    VehicleModel.countDocuments(childMatch),
    DriverModel.countDocuments(childMatch),
    VendorDocumentModel.aggregate<{ _id: Types.ObjectId | null; expired: number; expiring: number }>(
      [
        { $match: { ...childMatch, expiryDate: { $ne: null } } },
        {
          $group: {
            _id: null,
            expired: { $sum: { $cond: [{ $lt: ['$expiryDate', today] }, 1, 0] } },
            expiring: {
              $sum: {
                $cond: [
                  { $and: [{ $gte: ['$expiryDate', today] }, { $lte: ['$expiryDate', soon] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ],
    ),
  ])

  const counts = new Map(rows.map((row) => [row._id, row.count]))
  const read = (status: VendorStatus): number => counts.get(status) ?? 0
  const [documentTotals] = documents

  return {
    total: sumOf(rows),
    active: read('Active'),
    pending: read('Pending'),
    inactive: read('Inactive'),
    suspended: read('Suspended'),
    vehicles,
    drivers,
    expiredDocuments: documentTotals?.expired ?? 0,
    expiringDocuments: documentTotals?.expiring ?? 0,
  }
}
