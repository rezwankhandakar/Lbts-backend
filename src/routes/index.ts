import { Router } from 'express'
import { administrationRoutes } from '../modules/administration/administration.route'
import { gatePassRoutes } from '../modules/gate-pass/gate-pass.route'
import { profileRoutes } from '../modules/profile/profile.route'
import { userRoutes } from '../modules/user/user.route'
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
]

const router = Router()

for (const route of routes) {
  router.use(route.path, route.route)
}

export const apiRouter = router
