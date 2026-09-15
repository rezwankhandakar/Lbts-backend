import type { Request, Response } from 'express'
import { AppError } from '../../utils/app-error'
import { sendResponse } from '../../utils/send-response'
import type { UserDocument } from '../user/user.model'
import { billExportFilename, buildBillWorkbook } from './bill.export'
import { addBillLines, listBillCandidates, refreshBillLines, removeBillLines } from './bill.lines'
import {
  createBill,
  deleteBill,
  finalizeBill,
  getBillDetail,
  listBillUnits,
  listBills,
  reopenBill,
  updateBill,
} from './bill.service'
import type {
  AddBillLinesInput,
  BillCandidatesQuery,
  CreateBillInput,
  ListBillsQuery,
  RemoveBillLinesInput,
  UpdateBillInput,
} from './bill.validation'

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

export async function getBills(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListBillsQuery
  const { records, totals } = await listBills(query)

  sendResponse(res, {
    statusCode: 200,
    message: 'Bills retrieved',
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      totalPages: Math.max(1, Math.ceil(totals.total / query.limit)),
      ...totals,
    },
  })
}

export async function getBillUnits(_req: Request, res: Response): Promise<void> {
  sendResponse(res, { statusCode: 200, message: 'Units retrieved', data: await listBillUnits() })
}

export async function postBill(req: Request, res: Response): Promise<void> {
  const bill = await createBill(req.validated?.body as CreateBillInput, actorFrom(req))
  sendResponse(res, { statusCode: 201, message: `${bill.billNumber} opened`, data: bill })
}

export async function getBill(req: Request, res: Response): Promise<void> {
  sendResponse(res, { statusCode: 200, message: 'Bill retrieved', data: await getBillDetail(idFrom(req)) })
}

export async function patchBill(req: Request, res: Response): Promise<void> {
  const bill = await updateBill(idFrom(req), req.validated?.body as UpdateBillInput, actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${bill.billNumber} updated`, data: bill })
}

export async function removeBill(req: Request, res: Response): Promise<void> {
  const result = await deleteBill(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${result.billNumber} deleted`, data: result })
}

export async function getCandidates(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as BillCandidatesQuery
  sendResponse(res, {
    statusCode: 200,
    message: 'Trip DO rows retrieved',
    data: await listBillCandidates(idFrom(req), query.q),
  })
}

export async function postLines(req: Request, res: Response): Promise<void> {
  const result = await addBillLines(idFrom(req), req.validated?.body as AddBillLinesInput, actorFrom(req))
  sendResponse(res, {
    statusCode: 200,
    message:
      result.added > 0
        ? `${result.added} ${result.added === 1 ? 'row' : 'rows'} added to ${result.billNumber}`
        : `Those rows are already on ${result.billNumber}`,
    data: result,
  })
}

export async function postRemoveLines(req: Request, res: Response): Promise<void> {
  const result = await removeBillLines(idFrom(req), req.validated?.body as RemoveBillLinesInput, actorFrom(req))
  sendResponse(res, {
    statusCode: 200,
    message: `${result.removed} ${result.removed === 1 ? 'row' : 'rows'} taken off ${result.billNumber}`,
    data: result,
  })
}

export async function postRefresh(req: Request, res: Response): Promise<void> {
  const result = await refreshBillLines(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${result.billNumber} refreshed`, data: result })
}

export async function postFinalize(req: Request, res: Response): Promise<void> {
  const bill = await finalizeBill(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${bill.billNumber} finalized`, data: bill })
}

export async function postReopen(req: Request, res: Response): Promise<void> {
  const bill = await reopenBill(idFrom(req), actorFrom(req))
  sendResponse(res, { statusCode: 200, message: `${bill.billNumber} reopened`, data: bill })
}

export async function getBillExport(req: Request, res: Response): Promise<void> {
  const detail = await getBillDetail(idFrom(req))
  const workbook = await buildBillWorkbook(detail.bill, detail.lines)

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${billExportFilename(detail.bill)}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Length', String(workbook.byteLength))
  res.end(workbook)
}
