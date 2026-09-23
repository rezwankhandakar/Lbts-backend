import type { Request, Response } from 'express'
import { sendResponse } from '../../utils/send-response'
import { activityExportFilename, buildActivityWorkbook } from './activity.export'
import {
  describeActivityVocabulary,
  exportActivityRows,
  getActivityStats,
  listActivity,
  listActivityActors,
} from './activity.service'
import type {
  ActivityStatsQuery,
  ExportActivityQuery,
  ListActivityQuery,
} from './activity.validation'

/**
 * Four reads and nothing else.
 *
 * There is no POST, no PATCH and no DELETE in this module, deliberately: rows
 * are appended by services through `recordActivity` and by nothing a request
 * can reach. An audit log with a write endpoint is a log somebody can write
 * themselves out of.
 */

export async function getActivity(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListActivityQuery
  const { records, totals } = await listActivity(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Activity retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      total: totals.total,
      totalPages: Math.max(1, Math.ceil(totals.total / query.limit)),
    },
  })
}

export async function getStats(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ActivityStatsQuery

  sendResponse(res, {
    statusCode: 200,
    message: 'Activity overview retrieved',
    data: await getActivityStats(query),
  })
}

/**
 * The filter dropdowns' contents: who has done something, and what actions
 * exist. One call rather than two, because they are both asked for once when
 * the page opens and a second cold start buys nothing.
 */
export async function getFilters(_req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Activity filters retrieved',
    data: {
      actors: await listActivityActors(),
      actions: describeActivityVocabulary(),
    },
  })
}

export async function getExport(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ExportActivityQuery
  const workbook = await buildActivityWorkbook(await exportActivityRows(query))

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader('Content-Disposition', `attachment; filename="${activityExportFilename()}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Length', String(workbook.byteLength))
  res.end(workbook)
}
