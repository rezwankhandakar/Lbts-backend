import { Router } from 'express'
import { auth, requireRole } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import { ADMIN_ROLE } from '../user/user.constants'
import {
  deleteUser,
  getStats,
  getUsers,
  patchUserRole,
  patchUserStatus,
} from './administration.controller'
import {
  listUsersQuerySchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
  userIdParamSchema,
} from './administration.validation'

const router = Router()

/**
 * Administration is the system-level module: it is Admin-only, and that is
 * enforced here rather than by anything the browser does. Hiding the sidebar
 * item is presentation; this is the security boundary.
 *
 * Order matters. requireDb first, because auth reads the profile from MongoDB;
 * then auth, which verifies the Firebase ID token and loads that profile; then
 * requireRole, which reads `role` from the profile — never from the token, so
 * a demoted Admin loses access on the very next request.
 */
router.use(requireDb, auth, requireRole(ADMIN_ROLE))

router.get('/users', validateRequest({ query: listUsersQuerySchema }), getUsers)
router.get('/users/stats', getStats)

router.patch(
  '/users/:id/role',
  validateRequest({ params: userIdParamSchema, body: updateUserRoleSchema }),
  patchUserRole,
)

router.patch(
  '/users/:id/status',
  validateRequest({ params: userIdParamSchema, body: updateUserStatusSchema }),
  patchUserStatus,
)

router.delete('/users/:id', validateRequest({ params: userIdParamSchema }), deleteUser)

export const administrationRoutes = router
