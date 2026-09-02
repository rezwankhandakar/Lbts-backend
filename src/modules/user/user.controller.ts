import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import { toPublicUser } from './user.serializer'
import { findUserByFirebaseUid, syncUserProfile } from './user.service'
import type { SyncUserInput } from './user.validation'

/**
 * Called by the client immediately after a Firebase sign-up or sign-in.
 * Creates the MongoDB profile on first call, refreshes it afterwards.
 */
export async function syncUser(req: Request, res: Response): Promise<void> {
  const token = req.firebaseUser
  if (!token) {
    throw new AppError(401, 'Authentication required.')
  }

  const input = (req.validated?.body ?? {}) as SyncUserInput
  const user = await syncUserProfile(token, input)

  sendResponse(res, {
    statusCode: 200,
    message: 'Profile synced',
    data: toPublicUser(user),
  })
}

export async function getMe(req: Request, res: Response): Promise<void> {
  const token = req.firebaseUser
  if (!token) {
    throw new AppError(401, 'Authentication required.')
  }

  const user = await findUserByFirebaseUid(token.uid)
  if (!user) {
    throw new AppError(404, 'Profile not found. Sync the account first.')
  }

  sendResponse(res, {
    statusCode: 200,
    message: 'Profile retrieved',
    data: toPublicUser(user),
  })
}
