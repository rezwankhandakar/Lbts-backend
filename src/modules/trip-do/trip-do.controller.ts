import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import { buildTripDoWorkbook, tripDoExportFilename } from './trip-do.export'
import {
  bulkLinkRows,
  exportTripDoRows,
  getGatePassTripDoStatus,
  linkRow,
  listColumnValues,
  listGatePassOptions,
  listTripDoRows,
  mergeRow,
  splitRow,
  unlinkRow,
} from './trip-do.service'
import type {
  BulkLinkInput,
  ColumnValuesQuery,
  GatePassOptionsQuery,
  LinkRowInput,
  ListTripDoQuery,
  SplitRowInput,
  TripDoFilterQuery,
} from './trip-do.validation'

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

export async function getRows(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListTripDoQuery
  const { records, totals } = await listTripDoRows(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Trip DO rows retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      totalPages: Math.max(1, Math.ceil(totals.total / query.limit)),
      ...totals,
    },
  })
}

export async function getExport(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as TripDoFilterQuery
  const workbook = await buildTripDoWorkbook(await exportTripDoRows(query))

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader('Content-Disposition', `attachment; filename="${tripDoExportFilename()}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Length', String(workbook.byteLength))
  res.end(workbook)
}

export async function getColumnValues(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ColumnValuesQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Column values retrieved',
    data: await listColumnValues(query),
  })
}

export async function getGatePassOptions(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as GatePassOptionsQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Gate passes retrieved',
    data: await listGatePassOptions(idFrom(req), query.q),
  })
}

export async function patchLink(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as LinkRowInput
  const result = await linkRow(idFrom(req), input, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message:
      result.remainderQty > 0
        ? `Trip DO ${result.tripDo} set on ${result.qty}; ${result.remainderQty} left on a row of their own.`
        : `Trip DO ${result.tripDo} set.`,
    data: result,
  })
}

export async function postBulkLink(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as BulkLinkInput
  const result = await bulkLinkRows(input, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: `Trip DO ${result.tripDo} set on ${result.rows} rows.`,
    data: result,
  })
}

export async function deleteLink(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Trip DO removed',
    data: await unlinkRow(idFrom(req)),
  })
}

export async function postSplit(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as SplitRowInput

  sendResponse(res, {
    statusCode: 200,
    message: 'Row split',
    data: await splitRow(idFrom(req), input),
  })
}

export async function postMerge(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Parts merged',
    data: await mergeRow(idFrom(req)),
  })
}

export async function getGatePassStatus(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Gate pass Trip DO status retrieved',
    data: await getGatePassTripDoStatus(idFrom(req), actorFrom(req)),
  })
}
