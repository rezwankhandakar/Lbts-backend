import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import { resolveLocation } from './location.resolver'
import {
  createLocation,
  getLocationStats,
  listDistricts,
  listLocations,
  listThanas,
  removeLocation,
  updateLocation,
} from './location.service'
import type {
  CreateLocationInput,
  ListLocationsQuery,
  ResolveLocationInput,
  ThanaQuery,
  UpdateLocationInput,
} from './location.validation'

/**
 * The authenticated profile. Every handler here runs behind requireDb, auth
 * and requireRole, so it is always present; reading it through one helper
 * keeps that guarantee in a single place rather than a non-null assertion in
 * each handler.
 */
function actorFrom(req: Request): UserDocument {
  if (!req.user) {
    throw new AppError(403, 'Profile not found. Sync the account first.')
  }
  return req.user
}

function idFrom(req: Request): string {
  const params = req.validated?.params as { id: string } | undefined
  if (!params) {
    throw new AppError(400, 'Invalid id.')
  }
  return params.id
}

export async function getLocations(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListLocationsQuery
  const { records, total } = await listLocations(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Locations retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  })
}

export async function getDistricts(_req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Districts retrieved',
    data: await listDistricts(),
  })
}

export async function getThanas(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ThanaQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Thanas retrieved',
    data: await listThanas(query.district),
  })
}

export async function getStats(_req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Location statistics retrieved',
    data: await getLocationStats(),
  })
}

export async function postLocation(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateLocationInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Location added',
    data: await createLocation(input, actorFrom(req)),
  })
}

export async function patchLocation(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateLocationInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Location updated',
    data: await updateLocation(idFrom(req), input, actorFrom(req)),
  })
}

/**
 * Removing a location.
 *
 * Answers 200 either way, and says which of the two things happened. A row
 * challans reference is deactivated rather than deleted, and calling that an
 * error would be wrong — the request was honoured, and the caller needs to
 * know that historical records kept their location.
 */
export async function deleteLocation(req: Request, res: Response): Promise<void> {
  const result = await removeLocation(idFrom(req), actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: result.deactivated
      ? `Deactivated instead of deleted: ${result.challanCount} challan${
          result.challanCount === 1 ? '' : 's'
        } still reference this location.`
      : 'Location deleted',
    data: result,
  })
}

/**
 * What a piece of challan text resolves to, asked before anything is filed.
 *
 * A read rather than a write: it changes nothing, and its answer is a
 * suggestion the entry form shows beside the fields. The server resolves
 * again at submit time from the values that actually get stored, so what this
 * returns can never be the thing a record is built on — which is what stops a
 * crafted response to this endpoint from setting a location.
 */
export async function postResolve(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as ResolveLocationInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Location resolution complete',
    data: await resolveLocation(input),
  })
}
