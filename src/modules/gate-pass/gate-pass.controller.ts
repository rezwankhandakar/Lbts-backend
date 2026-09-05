import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import {
  DuplicateGatePassError,
  createGatePass,
  exportGatePasses,
  findDuplicates,
  getGatePass,
  getGatePassStats,
  listGatePasses,
  readGatePassDocument,
  removeGatePass,
  reviewGatePass,
  setGatePassDocument,
  submitGatePass,
  suggestValues,
  updateGatePass,
} from './gate-pass.service'
import { buildGatePassWorkbook, gatePassExportFilename } from './gate-pass.export'
import type {
  CreateGatePassInput,
  DuplicateQuery,
  GatePassFilterQuery,
  ListGatePassesQuery,
  ReviewGatePassInput,
  SubmitGatePassInput,
  SuggestionQuery,
  UpdateGatePassInput,
} from './gate-pass.validation'

/**
 * The authenticated profile. Every handler here runs behind requireDb, auth
 * and requireRole, so it is always present; reading it through one helper
 * keeps that guarantee in a single place rather than a non-null assertion in
 * each handler — and it stays honest if the route stack is ever changed.
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
    throw new AppError(400, 'Invalid gate pass id.')
  }
  return params.id
}

export async function getGatePasses(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListGatePassesQuery
  const { records, total, totalQty } = await listGatePasses(query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Gate passes retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
      // Summed over every matching record rather than this page, because the
      // question it answers is about the filters and not about the scroll.
      totalQty,
    },
  })
}

export async function getStats(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Gate pass statistics retrieved',
    data: await getGatePassStats(actorFrom(req)),
  })
}

export async function getDuplicates(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as DuplicateQuery
  const duplicates = await findDuplicates(query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Duplicate check complete',
    data: duplicates,
  })
}

export async function getSuggestions(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as SuggestionQuery
  const values = await suggestValues(query, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Suggestions retrieved',
    data: values,
  })
}

/**
 * The records list as a spreadsheet.
 *
 * Like the document endpoint, this answers with bytes rather than the standard
 * JSON envelope — the body is the file. Anything thrown before the first byte
 * still reaches the global error handler as JSON, which is what lets the
 * service refuse a set too large to build and have the browser read the
 * reason.
 *
 * `attachment` rather than `inline`: a spreadsheet is something the operator
 * opens in Excel, not something a browser should try to render.
 */
export async function getExport(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as GatePassFilterQuery
  const { records } = await exportGatePasses(query, actorFrom(req))
  const workbook = await buildGatePassWorkbook(records)

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader('Content-Disposition', `attachment; filename="${gatePassExportFilename()}"`)
  // The file is built from records behind authentication, so no shared cache
  // may keep a copy of it.
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Length', String(workbook.byteLength))

  res.end(workbook)
}

export async function getOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Gate pass retrieved',
    data: await getGatePass(idFrom(req), actorFrom(req)),
  })
}

export async function postGatePass(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as CreateGatePassInput
  const record = await createGatePass(input, actorFrom(req))

  sendResponse(res, {
    statusCode: 201,
    message: 'Gate pass created',
    data: record,
  })
}

export async function patchGatePass(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateGatePassInput
  const record = await updateGatePass(idFrom(req), input, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Gate pass updated',
    data: record,
  })
}

/**
 * The one handler that catches its own error.
 *
 * A possible duplicate is not a failure the operator can only read about — it
 * is a question, and answering it needs the matching records. The global error
 * handler emits one flat shape for everything, so carrying a payload through
 * it would mean teaching it about this module. Answering here keeps that
 * knowledge where it belongs, and the envelope still matches every other
 * error: the same success/message/errorSources fields, with the candidates
 * added alongside.
 */
export async function postSubmit(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as SubmitGatePassInput

  try {
    const record = await submitGatePass(idFrom(req), input, actorFrom(req))

    sendResponse(res, {
      statusCode: 200,
      message: 'Gate pass submitted',
      data: record,
    })
  } catch (error) {
    if (!(error instanceof DuplicateGatePassError)) {
      throw error
    }

    res.status(error.statusCode).json({
      success: false,
      message: error.message,
      errorSources: [{ path: 'tripDo', message: error.message }],
      duplicates: error.duplicates,
    })
  }
}

export async function postReview(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as ReviewGatePassInput
  const record = await reviewGatePass(idFrom(req), input, actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: `Gate pass ${input.status.toLowerCase()}`,
    data: record,
  })
}

/**
 * The page count a multi-page scan reports. It arrives as a form field beside
 * the file, so it is a string until proven otherwise, and anything that is not
 * a positive whole number is dropped rather than guessed at.
 */
function pageCountFrom(req: Request): number | null {
  const raw = (req.body as Record<string, unknown> | undefined)?.pageCount
  if (typeof raw !== 'string') {
    return null
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function postDocument(req: Request, res: Response): Promise<void> {
  const file = req.file
  if (!file) {
    throw new AppError(400, 'Choose a scanned document to upload.')
  }

  const record = await setGatePassDocument(
    idFrom(req),
    {
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
      pageCount: pageCountFrom(req),
    },
    actorFrom(req),
  )

  sendResponse(res, {
    statusCode: 200,
    message: 'Document attached',
    data: record,
  })
}

/**
 * Streams the scanned document.
 *
 * The only endpoint in the API that does not answer with the standard JSON
 * envelope, because the body is the file. `inline` rather than `attachment`:
 * the client fetches this into a blob for the viewer, and a browser that ever
 * opens the URL directly should render the page rather than download it.
 *
 * Errors thrown before the first byte still reach the global handler as JSON.
 * Once bytes are flowing there is no way back to a JSON error, so a mid-stream
 * failure destroys the response instead of appending an error into the file.
 */
export async function getDocument(req: Request, res: Response): Promise<void> {
  const download = await readGatePassDocument(idFrom(req), actorFrom(req))

  res.setHeader('Content-Type', download.mimeType)
  res.setHeader('Content-Disposition', `inline; filename="${download.filename}"`)
  // The record is behind authentication, so no shared cache may keep a copy.
  res.setHeader('Cache-Control', 'private, no-store')
  if (download.contentLength !== undefined) {
    res.setHeader('Content-Length', String(download.contentLength))
  }

  try {
    await pipeline(download.body, res)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[gate-pass] document stream failed: ${message}`)
    res.destroy()
  }
}

export async function deleteGatePass(req: Request, res: Response): Promise<void> {
  const removed = await removeGatePass(idFrom(req), actorFrom(req))

  sendResponse(res, {
    statusCode: 200,
    message: 'Gate pass deleted',
    data: removed,
  })
}
