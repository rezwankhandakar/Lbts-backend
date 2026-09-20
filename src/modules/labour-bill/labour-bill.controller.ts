import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import { buildLabourBillSignedCopiesPdf, readLabourBillSignedCopies } from './labour-bill.copies'
import { buildLabourBillWorkbook, labourBillExportFilename } from './labour-bill.export'
import {
  refreshLabourBillLines,
  removeLabourBillLines,
  scanChallanOntoLabourBill,
  updateLabourBillLine,
} from './labour-bill.lines'
import {
  createLabourBill,
  deleteLabourBill,
  finalizeLabourBill,
  getLabourBillDetail,
  listLabourBillCompanies,
  listLabourBills,
  reopenLabourBill,
  updateLabourBill,
} from './labour-bill.service'
import type {
  CreateLabourBillInput,
  ListLabourBillsQuery,
  RemoveLabourBillLinesInput,
  ScanLabourBillInput,
  SignedCopiesQuery,
  UpdateLabourBillInput,
  UpdateLabourBillLineInput,
} from './labour-bill.validation'

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

function lineIdFrom(req: Request): string {
  const params = req.validated?.params as { lineId?: string } | undefined
  if (!params?.lineId) {
    throw new AppError(400, 'Invalid id.')
  }
  return params.lineId
}

export async function getLabourBills(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListLabourBillsQuery
  const { records, totals } = await listLabourBills(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Labour bills retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      totalPages: Math.max(1, Math.ceil(totals.total / query.limit)),
      ...totals,
    },
  })
}

export async function getLabourBillCompanies(_req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Companies retrieved',
    data: await listLabourBillCompanies(),
  })
}

export async function postLabourBill(req: Request, res: Response): Promise<void> {
  const bill = await createLabourBill(req.validated?.body as CreateLabourBillInput, actorFrom(req))
  sendResponse(res, { statusCode: 201, message: `${bill.billNumber} opened`, data: bill })
}

export async function getLabourBill(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: 'Labour bill retrieved',
    data: await getLabourBillDetail(idFrom(req)),
  })
}

export async function patchLabourBill(req: Request, res: Response): Promise<void> {
  const bill = await updateLabourBill(
    idFrom(req),
    req.validated?.body as UpdateLabourBillInput,
    actorFrom(req),
  )
  sendResponse(res, { statusCode: 200, message: `${bill.billNumber} updated`, data: bill })
}

export async function removeLabourBill(req: Request, res: Response): Promise<void> {
  const result = await deleteLabourBill(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${result.billNumber} deleted`, data: result })
}

/**
 * One barcode read. The message is what the operator hears beside the scanner,
 * so it names the challan and says which of the two things happened: models
 * added, or nothing new because the challan is already on the sheet. A challan
 * with no product lines at all is refused by the service.
 */
export async function postLabourBillScan(req: Request, res: Response): Promise<void> {
  const { code } = req.validated?.body as ScanLabourBillInput
  const result = await scanChallanOntoLabourBill(idFrom(req), code, actorFrom(req))
  const added = result.added.length

  sendResponse(res, {
    statusCode: 200,
    message:
      added > 0
        ? `${result.challanNumber}: ${added} ${added === 1 ? 'row' : 'rows'} added`
        : `${result.challanNumber} is already on ${result.billNumber}`,
    data: result,
  })
}

export async function patchLabourBillLine(req: Request, res: Response): Promise<void> {
  const result = await updateLabourBillLine(
    idFrom(req),
    lineIdFrom(req),
    req.validated?.body as UpdateLabourBillLineInput,
    actorFrom(req),
  )
  sendResponse(res, { statusCode: 200, message: 'Row updated', data: result })
}

export async function postRemoveLabourBillLines(req: Request, res: Response): Promise<void> {
  const result = await removeLabourBillLines(
    idFrom(req),
    req.validated?.body as RemoveLabourBillLinesInput,
    actorFrom(req),
  )
  sendResponse(res, {
    statusCode: 200,
    message: `${result.removed} ${result.removed === 1 ? 'row' : 'rows'} taken off ${result.billNumber}`,
    data: result,
  })
}

export async function postLabourBillRefresh(req: Request, res: Response): Promise<void> {
  const result = await refreshLabourBillLines(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${result.billNumber} refreshed`, data: result })
}

export async function postLabourBillFinalize(req: Request, res: Response): Promise<void> {
  const bill = await finalizeLabourBill(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${bill.billNumber} finalized`, data: bill })
}

export async function postLabourBillReopen(req: Request, res: Response): Promise<void> {
  const bill = await reopenLabourBill(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${bill.billNumber} reopened`, data: bill })
}

export async function getLabourBillExport(req: Request, res: Response): Promise<void> {
  const detail = await getLabourBillDetail(idFrom(req))
  const workbook = await buildLabourBillWorkbook(detail.bill, detail.groups)

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${labourBillExportFilename(detail.bill)}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Length', String(workbook.byteLength))
  res.end(workbook)
}

/**
 * Which of the bill's challans have a receiver's signed copy, and which are
 * still waiting for one — in the sheet's own sections and SL order.
 *
 * A read, so it sits under the module's read roles: a CEO checking what a
 * month's handling cost may look at the paper behind it. The copies themselves
 * stay where they are; this carries the authenticated Delivery path to each
 * and never an object key.
 */
export async function getLabourBillSignedCopies(req: Request, res: Response): Promise<void> {
  const { list } = await readLabourBillSignedCopies(idFrom(req))

  sendResponse(res, { statusCode: 200, message: 'Signed copies retrieved', data: list })
}

/**
 * Those copies as one PDF, to print or to file with the bill.
 *
 * Bytes rather than the JSON envelope, the shape every document endpoint here
 * has. `Content-Disposition` is in the CORS `exposedHeaders`, so the browser
 * can read the filename across the Netlify/Render origin split — and it is the
 * only header it can read, which is why the counts are the list endpoint's job
 * rather than something smuggled out beside the file.
 */
export async function getLabourBillSignedCopiesFile(req: Request, res: Response): Promise<void> {
  const { csd } = (req.validated?.query ?? {}) as SignedCopiesQuery
  const file = await buildLabourBillSignedCopiesPdf(idFrom(req), csd)

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Length', String(file.pdf.byteLength))
  res.end(Buffer.from(file.pdf))
}
