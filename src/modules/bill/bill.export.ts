import type { Borders, Cell } from 'exceljs'
import { MONTH_NAMES } from './bill.constants'
import type { BillLineRecord, BillRecord } from './bill.serializer'

/**
 * A bill as the spreadsheet the office sends — the columns and the SL layout of
 * its own hand-kept file: one SL per Trip DO, merged down every row of it, and
 * a total of the quantities and the amounts at the foot.
 *
 * An .xlsx for the reason every export here is one: a CSV hands Excel dates and
 * phone numbers as text to re-guess, and a receiver's number that loses its
 * leading zero is a number nobody can call.
 */

const FONT = 'Times New Roman'

interface ColumnSpec {
  header: string
  width: number
  align: 'left' | 'center' | 'right'
  wrap?: boolean
}

/** In the order the bill prints them. */
const COLUMNS: ColumnSpec[] = [
  { header: 'SL', width: 6, align: 'center' },
  { header: 'Customer', width: 24, align: 'center', wrap: true },
  { header: 'CSD', width: 9, align: 'center' },
  { header: 'Receiver Number', width: 16, align: 'center' },
  { header: 'Address', width: 42, align: 'center', wrap: true },
  { header: 'District', width: 13, align: 'center' },
  { header: 'Thana', width: 15, align: 'center', wrap: true },
  { header: 'Location', width: 12, align: 'center' },
  { header: 'Unit', width: 8, align: 'center' },
  { header: 'Products Model', width: 22, align: 'center' },
  { header: 'Qty.', width: 6, align: 'center' },
  { header: 'Rate', width: 9, align: 'center' },
  { header: 'Amount', width: 11, align: 'center' },
  { header: 'Products', width: 16, align: 'center', wrap: true },
  { header: 'Trip Do', width: 12, align: 'center' },
  { header: 'Capacity', width: 20, align: 'center', wrap: true },
  { header: 'Remarks', width: 10, align: 'center' },
]

/** The office's one title line, and the column headers straight beneath it. */
const TITLE_ROW = 1
export const HEADER_ROW = 2
export const FIRST_DATA_ROW = HEADER_ROW + 1
const QTY_COLUMN = 11
const AMOUNT_COLUMN = 13

const LINE = { style: 'thin', color: { argb: 'FF7F8793' } } as const
const BORDER: Partial<Borders> = { top: LINE, left: LINE, bottom: LINE, right: LINE }
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } } as const
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } } as const

function letter(column: number): string {
  return String.fromCharCode(64 + column)
}

function moneyFormat(value: number): string {
  return Number.isInteger(value) ? '#,##0' : '#,##0.00'
}

/** A flat rate is a number Excel can add; a tiered one is "60 / 24", as the rate card writes it. */
function rateValue(rate: BillLineRecord['rate']): number | string | null {
  if (!rate) {
    return null
  }
  return rate.kind === 'flat' ? rate.amount : `${rate.firstAmount} / ${rate.restAmount}`
}

function rowValues(line: BillLineRecord): (string | number | null)[] {
  return [
    line.slRowSpan > 0 ? line.sl : null,
    line.customerName,
    line.csd,
    // Text, so a leading zero survives.
    line.receiverMobile,
    line.deliveryAddress,
    line.district,
    line.thana,
    line.locationType ?? '',
    line.unit,
    line.model,
    line.qty,
    rateValue(line.rate),
    line.amount,
    line.productName,
    line.tripDo,
    line.capacity,
    line.remarks,
  ]
}

function styleCell(cell: Cell, spec: ColumnSpec, bold = false): void {
  cell.font = { name: FONT, size: 11, bold }
  cell.border = BORDER
  cell.alignment = { horizontal: spec.align, vertical: 'middle', wrapText: spec.wrap ?? false }
}

/** Excel refuses a sheet name over 31 characters or holding `[]:*?/\`. */
function sheetName(bill: BillRecord): string {
  const month = MONTH_NAMES[bill.month - 1]?.slice(0, 3) ?? ''
  return `${bill.unit} ${month} ${bill.year}`.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31)
}

/** The sheet's only title: "Line Business Transport service Bill — Unit WFR — August 2026". */
export function billTitle(bill: Pick<BillRecord, 'unit' | 'periodLabel'>): string {
  return `Line Business Transport service Bill — Unit ${bill.unit} — ${bill.periodLabel}`
}

export async function buildBillWorkbook(
  bill: BillRecord,
  lines: readonly BillLineRecord[],
  now: Date = new Date(),
): Promise<Uint8Array> {
  // Loaded on demand for the reason `buildGatePassWorkbook` gives.
  const { default: ExcelJS } = await import('exceljs')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'LBTS'
  workbook.created = now

  const sheet = workbook.addWorksheet(sheetName(bill), {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  })
  sheet.columns = COLUMNS.map((column) => ({ width: column.width }))
  // Every printed page repeats the header row.
  sheet.pageSetup.printTitlesRow = `${HEADER_ROW}:${HEADER_ROW}`

  sheet.mergeCells(TITLE_ROW, 1, TITLE_ROW, COLUMNS.length)
  const title = sheet.getCell(TITLE_ROW, 1)
  title.value = billTitle(bill)
  title.font = { name: FONT, size: 15, bold: true }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(TITLE_ROW).height = 26

  const header = sheet.getRow(HEADER_ROW)
  COLUMNS.forEach((spec, index) => {
    const cell = header.getCell(index + 1)
    cell.value = spec.header
    styleCell(cell, { ...spec, align: 'center', wrap: true }, true)
    cell.fill = HEADER_FILL
  })
  header.height = 20

  lines.forEach((line, index) => {
    const row = sheet.getRow(FIRST_DATA_ROW + index)
    const values = rowValues(line)

    COLUMNS.forEach((spec, column) => {
      const cell = row.getCell(column + 1)
      cell.value = values[column]
      styleCell(cell, spec)
    })

    if (typeof line.amount === 'number') {
      row.getCell(AMOUNT_COLUMN).numFmt = moneyFormat(line.amount)
    }
    if (line.rate?.kind === 'flat') {
      row.getCell(AMOUNT_COLUMN - 1).numFmt = moneyFormat(line.rate.amount)
    }
  })

  // One SL for the whole Trip DO, merged down its rows. After every row is
  // written: a value written into a merged cell lands on its master, so the
  // blank SL of a later row would otherwise wipe the number above it.
  lines.forEach((line, index) => {
    if (line.slRowSpan > 1) {
      const start = FIRST_DATA_ROW + index
      sheet.mergeCells(start, 1, start + line.slRowSpan - 1, 1)
    }
  })

  const lastDataRow = FIRST_DATA_ROW + lines.length - 1
  const totalRowNumber = FIRST_DATA_ROW + lines.length
  const totalRow = sheet.getRow(totalRowNumber)

  COLUMNS.forEach((spec, column) => {
    const cell = totalRow.getCell(column + 1)
    styleCell(cell, spec, true)
    cell.fill = TOTAL_FILL
  })
  sheet.mergeCells(totalRowNumber, 1, totalRowNumber, QTY_COLUMN - 1)
  const label = totalRow.getCell(1)
  label.value = 'Total'
  label.alignment = { horizontal: 'right', vertical: 'middle' }

  const sumOf = (column: number, result: number) =>
    lines.length > 0
      ? { formula: `SUM(${letter(column)}${FIRST_DATA_ROW}:${letter(column)}${lastDataRow})`, result }
      : 0
  totalRow.getCell(QTY_COLUMN).value = sumOf(QTY_COLUMN, bill.totalQty)
  totalRow.getCell(AMOUNT_COLUMN).value = sumOf(AMOUNT_COLUMN, bill.totalAmount)
  totalRow.getCell(AMOUNT_COLUMN).numFmt = moneyFormat(bill.totalAmount)
  totalRow.height = 20

  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** `LBTS-BILL-2026-0007_WFR_2026-09.xlsx`. */
export function billExportFilename(bill: Pick<BillRecord, 'billNumber' | 'unit' | 'month' | 'year'>): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe(bill.billNumber)}_${safe(bill.unit) || 'unit'}_${bill.year}-${String(bill.month).padStart(2, '0')}.xlsx`
}
