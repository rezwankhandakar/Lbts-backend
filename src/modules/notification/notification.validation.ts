import * as z from 'zod'
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  MUTABLE_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_MODULES,
  NOTIFICATION_PRIORITIES,
} from './notification.constants'

/** Mongo ObjectId as it arrives in a URL. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const notificationIdParamsSchema = z.object({ id: objectId })
export type NotificationIdParams = z.infer<typeof notificationIdParamsSchema>

/**
 * What narrows one person's inbox.
 *
 * **There is no `recipientId`, and there never may be.** Every route reads the
 * caller off the verified profile, so there is nothing here for a crafted
 * request to aim at somebody else's messages — the shape the Profile module
 * takes, where identity comes from the token and never from an argument.
 *
 * Module, category and priority are all *derived* from the event, so each
 * resolves to an `$in` over events in the service rather than to a column. They
 * are three filters rather than one because they answer three different
 * questions: which part of the system, what kind of interruption, and how
 * loudly it asked.
 */
export const notificationFilterFields = {
  /**
   * `unread` is the filter this list is actually used with — somebody opening
   * the page is asking what they have not dealt with — so it is a first-class
   * value rather than a boolean hidden among the others.
   */
  state: z.enum(['all', 'unread', 'read']).default('all'),

  module: z.enum(['all', ...NOTIFICATION_MODULES]).default('all'),
  category: z.enum(['all', ...NOTIFICATION_CATEGORIES]).default('all'),
  priority: z.enum(['all', ...NOTIFICATION_PRIORITIES]).default('all'),

  /** One exact event, for when somebody knows precisely what they are after. */
  event: z.enum(['all', ...NOTIFICATION_EVENTS]).default('all'),

  search: z.string().trim().max(160).default(''),
}

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATION_PAGE_SIZE)
    .default(DEFAULT_NOTIFICATION_PAGE_SIZE),
  ...notificationFilterFields,
})
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>

/**
 * Marking one message read, or putting it back.
 *
 * A body rather than two endpoints, because "read" is a value on the row and
 * not two different operations — and because the client's optimistic update is
 * one mutation either way, which is what stops a mis-click needing a page
 * reload to undo.
 */
export const markNotificationSchema = z.object({
  read: z.boolean(),
})
export type MarkNotificationInput = z.infer<typeof markNotificationSchema>

/**
 * Marking everything read.
 *
 * `before` is optional and is the one thing that makes this safe on a list
 * somebody is reading: without it, a message that arrived between the page
 * rendering and the button being pressed would be marked read unseen. The
 * client sends the newest timestamp it has actually drawn.
 */
export const markAllReadSchema = z.object({
  before: z.coerce.date().optional(),
})
export type MarkAllReadInput = z.infer<typeof markAllReadSchema>

/**
 * The preferences.
 *
 * The enum is `MUTABLE_CATEGORIES` rather than the whole list, so `account`
 * cannot be muted by a request even though the column could store it. That is
 * where the rule belongs: a client that could send it would be a client that
 * could switch off being told its own account was suspended.
 */
export const updatePreferencesSchema = z.object({
  mutedCategories: z.array(z.enum(MUTABLE_CATEGORIES)).max(MUTABLE_CATEGORIES.length),
})
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>
