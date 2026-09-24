import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import {
  clearReadNotifications,
  describeNotificationVocabulary,
  dismissNotification,
  getNotificationPreferences,
  getNotificationSummary,
  listNotifications,
  markAllNotificationsRead,
  setNotificationRead,
  updateNotificationPreferences,
} from './notification.service'
import type {
  ListNotificationsQuery,
  MarkAllReadInput,
  MarkNotificationInput,
  NotificationIdParams,
  UpdatePreferencesInput,
} from './notification.validation'

/**
 * Every handler here reads the caller off `req.user` and nothing takes a user
 * id, which is the module's whole access story — the Profile module's shape.
 * `requireActiveAccount` has already proved the profile exists; this narrows the
 * optional type without inventing a second code path for a case that cannot
 * happen.
 */
function actorOf(req: Request): UserDocument {
  if (!req.user) {
    throw new AppError(403, 'Profile not found. Sync the account first.')
  }
  return req.user
}

export async function getNotifications(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListNotificationsQuery
  const { records, total, unread } = await listNotifications(actorOf(req), query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Notifications retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
      /**
       * Unread across the whole inbox rather than within the filters, so the
       * header and the list can never tell two different stories about how much
       * is waiting. See `listNotifications`.
       */
      unreadTotal: unread,
    },
  })
}

/**
 * The header's one request: the count, what it is made of, and a short list.
 *
 * The most-called endpoint in the application — it runs on every page load and
 * then on a timer — which is why it is one call rather than four. See the
 * service for why this is polled rather than pushed.
 */
export async function getSummary(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Notification summary retrieved',
    data: await getNotificationSummary(actorOf(req)),
  })
}

export async function patchNotification(req: Request, res: Response): Promise<void> {
  const { id } = req.validated?.params as NotificationIdParams
  const { read } = req.validated?.body as MarkNotificationInput

  sendResponse(res, {
    statusCode: 200,
    message: read ? 'Notification marked read' : 'Notification marked unread',
    data: await setNotificationRead(actorOf(req), id, read),
  })
}

export async function patchAllRead(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as MarkAllReadInput
  const { updated } = await markAllNotificationsRead(actorOf(req), input)

  sendResponse(res, {
    statusCode: 200,
    message:
      updated === 0
        ? 'Nothing was waiting'
        : `${updated} ${updated === 1 ? 'notification' : 'notifications'} marked read`,
    data: { updated },
  })
}

export async function deleteNotification(req: Request, res: Response): Promise<void> {
  const { id } = req.validated?.params as NotificationIdParams

  sendResponse(res, {
    statusCode: 200,
    message: 'Notification dismissed',
    data: await dismissNotification(actorOf(req), id),
  })
}

export async function deleteRead(req: Request, res: Response): Promise<void> {
  const { removed } = await clearReadNotifications(actorOf(req))

  sendResponse(res, {
    statusCode: 200,
    message:
      removed === 0
        ? 'There was nothing read to clear'
        : `${removed} read ${removed === 1 ? 'notification' : 'notifications'} cleared`,
    data: { removed },
  })
}

export async function getPreferences(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Notification preferences retrieved',
    data: await getNotificationPreferences(actorOf(req)),
  })
}

export async function putPreferences(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdatePreferencesInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Notification preferences saved',
    data: await updateNotificationPreferences(actorOf(req), input),
  })
}

/**
 * What this deployment can announce, with each event's label and derived meta.
 *
 * Served rather than mirrored on the client, for the reason
 * `GET /activity/filters` serves the action list: a hand-copied vocabulary is
 * one chance per value to drift, and a filter that quietly matches nothing is
 * the one failure a message list cannot afford. No database read at all, so it
 * needs no `requireDb` of its own — the router's is harmless and keeps one
 * shape for every route.
 */
export function getVocabulary(_req: Request, res: Response): void {
  sendResponse(res, {
    statusCode: 200,
    message: 'Notification vocabulary retrieved',
    data: { events: describeNotificationVocabulary() },
  })
}
