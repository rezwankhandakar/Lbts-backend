import * as z from 'zod'
import { USER_ROLES, USER_STATUSES } from '../user/user.constants'

/** Mongo ObjectId as it arrives in a URL. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid user id.')

export const userIdParamSchema = z.object({
  id: objectId,
})

/**
 * The administration list is server-paginated and server-filtered: M0 has no
 * headroom for shipping every user to the browser and filtering there.
 * `limit` is capped so a crafted query cannot ask for the whole collection.
 */
export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  search: z.string().trim().max(120).optional(),
  role: z.enum(['all', ...USER_ROLES]).default('all'),
  status: z.enum(['all', ...USER_STATUSES]).default('all'),
})

export const updateUserRoleSchema = z.object({
  role: z.enum(USER_ROLES),
})

/**
 * One endpoint serves every lifecycle action — approve, reject, suspend,
 * reactivate — because each is a move to a target status. Which moves are
 * legal is decided by STATUS_TRANSITIONS, not by the client.
 */
export const updateUserStatusSchema = z.object({
  status: z.enum(USER_STATUSES),
  note: z.string().trim().max(240).optional(),
})

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>
