import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import {
  createProductRate,
  getProductRateStats,
  listProductRates,
  matchProductsForModel,
  priceItems,
  removeProductRate,
  suggestProductNames,
  updateProductRate,
} from './product-rate.service'
import { totalOf } from './product-rate.pricing'
import type {
  CreateProductRateInput,
  ListProductRatesQuery,
  ModelLookupQuery,
  ProductLookupQuery,
  QuoteRatesInput,
  UpdateProductRateInput,
} from './product-rate.validation'

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

export async function getProductRates(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListProductRatesQuery
  const { records, total } = await listProductRates(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Product rates retrieved',
    data: records,
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
    message: 'Rate card statistics retrieved',
    data: await getProductRateStats(),
  })
}

/**
 * Which products carry a model.
 *
 * The entry form's lookup: an operator pastes a model off the challan and this
 * says what the rate card calls it. Offering the card's own spelling before
 * anything is filed is what makes the pricing step able to insist on a
 * matching product name later.
 */
export async function getModelMatches(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ModelLookupQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Model matches retrieved',
    data: await matchProductsForModel(query.model),
  })
}

/**
 * Product names on the card, offered while somebody types in the product box.
 *
 * The counterpart to the model lookup, and the only assistance a model-less
 * product has: a hair dryer carries no model on the card, so there is nothing
 * to paste and the product name is the only way in.
 */
export async function getProductNames(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ProductLookupQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Product names retrieved',
    data: await suggestProductNames(query.q),
  })
}

/**
 * What a set of lines would be charged, asked before anything is filed.
 *
 * A read: it changes nothing, and its answer is a preview. The server prices
 * again at submit time from the values that actually get stored, so what this
 * returns can never be the thing a record is built on — the same arrangement
 * `POST /locations/resolve` has, and for the same reason.
 */
export async function postQuote(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as QuoteRatesInput

  const applications = await priceItems(input.items, input.locationType)
  const totals = totalOf(applications.map((application) => application?.amount ?? null))

  sendResponse(res, {
    statusCode: 200,
    message: 'Rates quoted',
    data: { items: applications, ...totals },
  })
}

export async function postProductRate(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateProductRateInput

  sendResponse(res, {
    statusCode: 201,
    message: 'Product added to the rate card',
    data: await createProductRate(input, actorFrom(req)),
  })
}

export async function patchProductRate(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateProductRateInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Rate card updated',
    data: await updateProductRate(idFrom(req), input, actorFrom(req)),
  })
}

/**
 * Removing a rate card row.
 *
 * Answers 200 either way and says which of the two things happened. A row
 * challans cite is deactivated rather than deleted, and calling that an error
 * would be wrong — the request was honoured, and the caller needs to know the
 * row was kept so the figures on those records stay traceable.
 */
export async function deleteProductRate(req: Request, res: Response): Promise<void> {
  const result = await removeProductRate(idFrom(req), actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: result.deactivated
      ? `Deactivated instead of deleted: ${result.challanCount} challan${
          result.challanCount === 1 ? '' : 's'
        } were charged from this row.`
      : 'Removed from the rate card',
    data: result,
  })
}
