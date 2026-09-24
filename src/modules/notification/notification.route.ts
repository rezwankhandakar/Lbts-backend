import { Router } from 'express'
import { auth, requireActiveAccount } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import {
  deleteNotification,
  deleteRead,
  getNotifications,
  getPreferences,
  getSummary,
  getVocabulary,
  patchAllRead,
  patchNotification,
  putPreferences,
} from './notification.controller'
import {
  listNotificationsQuerySchema,
  markAllReadSchema,
  markNotificationSchema,
  notificationIdParamsSchema,
  updatePreferencesSchema,
} from './notification.validation'

/**
 * One person's notifications.
 *
 * `requireDb, auth, requireActiveAccount` and **no `requireRole` anywhere**,
 * which is the Profile module's arrangement and for the same reason: every role
 * administers its own inbox, and there is no id in any URL for a request to
 * point at somebody else's. Identity comes from the verified token, so ownership
 * is a property of the shape of the module rather than a check that could be
 * forgotten on a route added later.
 *
 * `requireActiveAccount` rather than nothing: a Pending or Suspended account is
 * told *why* it is locked out by `/users/me`, and a list of the operation's
 * business is not part of that answer.
 *
 * Nothing here creates a notification. Rows are fanned out by services through
 * `notify`; a request may change the read state of a row addressed to it, clear
 * one it has dealt with, and say which categories it would rather not hear
 * about.
 */
const router = Router()

router.use(requireDb, auth, requireActiveAccount)

// Static segments first, so none is ever matched as an id.
router.get('/summary', getSummary)
router.get('/vocabulary', getVocabulary)

router.get('/preferences', getPreferences)
router.put('/preferences', validateRequest({ body: updatePreferencesSchema }), putPreferences)

router.patch('/read-all', validateRequest({ body: markAllReadSchema }), patchAllRead)
router.delete('/read', deleteRead)

router.get('/', validateRequest({ query: listNotificationsQuerySchema }), getNotifications)

router.patch(
  '/:id',
  validateRequest({ params: notificationIdParamsSchema, body: markNotificationSchema }),
  patchNotification,
)
router.delete('/:id', validateRequest({ params: notificationIdParamsSchema }), deleteNotification)

export const notificationRoutes = router
