import { Router } from 'express'
import { administrationRoutes } from '../modules/administration/administration.route'
import { challanBatchRoutes, challanRoutes } from '../modules/challan/challan.route'
import { gatePassRoutes } from '../modules/gate-pass/gate-pass.route'
import { locationRoutes } from '../modules/location/location.route'
import { productRateRoutes } from '../modules/product-rate/product-rate.route'
import { profileRoutes } from '../modules/profile/profile.route'
import { userRoutes } from '../modules/user/user.route'
import {
  assignmentRoutes,
  driverRoutes,
  vehicleRoutes,
  vendorDocumentRoutes,
  vendorRoutes,
} from '../modules/vendor/vendor.route'
import { healthRoutes } from './health.route'

interface RouteDefinition {
  path: string
  route: Router
}

/**
 * Central registry. Mounting a new module means adding one entry here and
 * nothing else.
 */
const routes: RouteDefinition[] = [
  { path: '/health', route: healthRoutes },
  { path: '/users', route: userRoutes },
  { path: '/profile', route: profileRoutes },
  { path: '/administration', route: administrationRoutes },
  { path: '/gate-passes', route: gatePassRoutes },
  { path: '/challans', route: challanRoutes },
  /**
   * Batches are their own collection rather than a sub-path of a challan: a
   * batch outlives any one challan in it, and its two reads — the progress of
   * a source file, and the assembled document for a finished one — are about
   * the file rather than about a record.
   */
  { path: '/challan-batches', route: challanBatchRoutes },
  /**
   * The location master: reference data rather than a records module, which is
   * why it is mounted at the top level and not underneath the module that
   * happens to use it first. Challan is that module; anything else that has to
   * classify a delivery reads this same collection rather than growing a copy.
   */
  { path: '/locations', route: locationRoutes },
  /**
   * The product rate card, mounted beside the location master and for the same
   * reason: it is reference data the operation prices against, not a records
   * module belonging to whichever feature reads it first. Challan is that
   * feature today; anything else that has to charge for a delivery reads this
   * same collection rather than growing a copy of it.
   */
  { path: '/product-rates', route: productRateRoutes },
  /**
   * The vendor and its fleet.
   *
   * Five mounts rather than one nested tree. `/vendors` owns the vendor record
   * and the lists underneath it, because a vehicle only makes sense inside a
   * vendor when you are asking for all of them. A single vehicle, driver,
   * assignment or document has a stable global id and is reached directly —
   * `/vendors/:vendorId/vehicles/:vehicleId` would carry the vendor twice and
   * invite the second copy to be trusted, which is exactly what a module whose
   * whole security model is "the vendor comes from the profile" must not do.
   */
  { path: '/vendors', route: vendorRoutes },
  { path: '/vehicles', route: vehicleRoutes },
  { path: '/drivers', route: driverRoutes },
  { path: '/vendor-assignments', route: assignmentRoutes },
  { path: '/vendor-documents', route: vendorDocumentRoutes },
]

const router = Router()

for (const route of routes) {
  router.use(route.path, route.route)
}

export const apiRouter = router
