import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import {
  changeUserRole,
  changeUserStatus,
  getUserStats,
  listUsers,
  removeUser,
} from './administration.service'
import type {
  ListUsersQuery,
  UpdateUserRoleInput,
  UpdateUserStatusInput,
} from './administration.validation'

/**
 * Every handler here runs behind requireRole('Admin'), so req.user is
 * guaranteed to be a live, active Admin profile. This narrows the type without
 * a non-null assertion, and stays honest if the route stack is ever changed.
 */
function actorFrom(req: Request): UserDocument {
  if (!req.user) {
    throw new AppError(403, 'Profile not found. Sync the account first.')
  }
  return req.user
}

function targetIdFrom(req: Request): string {
  const params = req.validated?.params as { id: string } | undefined
  if (!params) {
    throw new AppError(400, 'Invalid user id.')
  }
  return params.id
}

export async function getUsers(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListUsersQuery
  const { users, total } = await listUsers(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Users retrieved',
    data: users,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  })
}

export async function getStats(_req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'User statistics retrieved',
    data: await getUserStats(),
  })
}

export async function patchUserRole(req: Request, res: Response): Promise<void> {
  const { role, vendorId } = req.validated?.body as UpdateUserRoleInput
  const user = await changeUserRole(targetIdFrom(req), role, vendorId, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    // A Vendor account is only half a decision without the vendor it speaks
    // for, so the confirmation names it rather than reporting the role alone.
    message: user.vendor ? `Role changed to ${role} · ${user.vendor.name}` : `Role changed to ${role}`,
    data: user,
  })
}

export async function patchUserStatus(req: Request, res: Response): Promise<void> {
  const { status, note } = req.validated?.body as UpdateUserStatusInput
  const user = await changeUserStatus(targetIdFrom(req), status, note, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: `Account ${status.toLowerCase()}`,
    data: user,
  })
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  const removed = await removeUser(targetIdFrom(req), actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'User deleted',
    data: removed,
  })
}
