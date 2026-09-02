import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import { clearProfilePhoto, setProfilePhoto, updateMyProfile } from './profile.service'
import type { UpdateProfileInput } from './profile.validation'

/**
 * The signed-in user's own document. Every handler in this module runs behind
 * requireDb, auth and requireActiveAccount, so it is always present; reading it
 * through one helper keeps that guarantee in a single place instead of a
 * non-null assertion in each handler.
 *
 * This is also the only place an identity enters the module. Nothing here
 * reads a user id from the body, the query or the path, so no request can turn
 * "update my profile" into "update someone else's".
 */
function ownerFrom(req: Request): UserDocument {
  if (!req.user) {
    throw new AppError(403, 'Profile not found. Sync the account first.')
  }
  return req.user
}

export async function patchProfile(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateProfileInput
  const profile = await updateMyProfile(ownerFrom(req), input)

  sendResponse(res, {
    statusCode: 200,
    message: 'Profile updated',
    data: profile,
  })
}

export async function putProfilePhoto(req: Request, res: Response): Promise<void> {
  const file = req.file
  if (!file) {
    throw new AppError(400, 'Choose an image to upload.')
  }

  const profile = await setProfilePhoto(ownerFrom(req), file.buffer)

  sendResponse(res, {
    statusCode: 200,
    message: 'Profile photo updated',
    data: profile,
  })
}

export async function deleteProfilePhoto(req: Request, res: Response): Promise<void> {
  const profile = await clearProfilePhoto(ownerFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Profile photo removed',
    data: profile,
  })
}
