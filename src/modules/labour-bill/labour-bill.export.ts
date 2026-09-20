import type { Borders, Cell, Workbook } from 'exceljs'
import { MONTH_NAMES } from './labour-bill.constants'
import type {
  LabourBillLineRecord,
  LabourBillRecord,
  LabourCsdGroupRecord,
} from './labour-bill.serializer'

/**
 * A Walton Labour Bill as the spreadsheet the office sends: the columns in the
 * order it keeps them, one SL per challan merged down its models, and the
 * Ven/Pulling/Labour, Floor and Total columns totalled at the foot.
 *
 * An .xlsx rather than a CSV for the reason every export here is one: a CSV
 * hands Excel a receiver's number as text to re-guess, and a number that loses
 * its leading zero is a number nobody can call.
 *
 * **Floor is one column of two cells**, which is why the header is two rows
 * deep: "Floor" spans the pair and "Floor No." and "Amount" sit under it, while
 * every other heading is merged down through both rows. That is the office's
 * own sheet, and a flattened "Floor No." / "Floor Amount" pair would read as
 * two unrelated columns beside each other.
 */

const FONT = 'Times New Roman'

interface ColumnSpec {
  header: string
  width: number
  align: 'left' | 'center' | 'right'
  wrap?: boolean
  /** Set on the two cells of the Floor column; they share one heading above. */
  group?: string
}

/** In the order the labour bill prints them. */
const COLUMNS: ColumnSpec[] = [
  { header: 'SL', width: 6, align: 'center' },
  { header: 'Customer', width: 26, align: 'center', wrap: true },
  { header: 'CSD', width: 10, align: 'center' },
  { header: 'Receiver Number', width: 16, align: 'center' },
  { header: 'Address', width: 42, align: 'center', wrap: true },
  { header: 'Unit', width: 18, align: 'center', wrap: true },
  { header: 'Model', width: 22, align: 'center' },
  { header: 'Trip Do', width: 12, align: 'center' },
  { header: 'Qty', width: 6, align: 'center' },
  { header: 'Ven/Pulling/Labour', width: 16, align: 'center', wrap: true },
  { header: 'Floor No.', width: 9, align: 'center', group: 'Floor' },
  { header: 'Amount', width: 11, align: 'center', group: 'Floor' },
  { header: 'Total Amount', width: 13, align: 'center', wrap: true },
]

const TITLE_ROW = 1
/** The heading is two rows deep, so the Floor pair can share one label. */
export const HEADER_ROW = 2
export const HEADER_ROW_TWO = 3
export const FIRST_DATA_ROW = HEADER_ROW_TWO + 1

const QTY_COLUMN = 9
const LABOUR_COLUMN = 10
const FLOOR_NO_COLUMN = 11
const FLOOR_AMOUNT_COLUMN = 12
const TOTAL_COLUMN = 13

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

function rowValues(line: LabourBillLineRecord): (string | number | null)[] {
  return [
    line.slRowSpan > 0 ? line.sl : null,
    line.customerName,
    line.csd,
    // Text, so a leading zero survives.
    line.receiverMobile,
    line.deliveryAddress,
    line.company,
    line.model,
    line.tripDo,
    line.qty,
    line.labourAmount,
    line.floorNo,
    line.floorAmount,
    line.total,
  ]
}

function styleCell(cell: Cell, spec: ColumnSpec, bold = false): void {
  cell.font = { name: FONT, size: 11, bold }
  cell.border = BORDER
  cell.alignment = { horizontal: spec.align, vertical: 'middle', wrapText: spec.wrap ?? false }
}

/** Excel refuses a sheet name over 31 characters or holding `[]:*?/\`. */
function sheetName(group: LabourCsdGroupRecord, bill: LabourBillRecord): string {
  const month = MONTH_NAMES[bill.month - 1]?.slice(0, 3) ?? ''
  return `${group.label} ${month} ${bill.year}`.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31)
}

/**
 * "Line Business Transport service — Walton Labour Bill — CSD-02 — September 2026".
 *
 * The CSD is in the title because each worksheet **is** that CSD's bill: the
 * office sends them separately, so a sheet naming only the month would be one
 * of several nobody could tell apart once they were printed.
 */
export function labourBillTitle(
  group: Pick<LabourCsdGroupRecord, 'label'>,
  bill: Pick<LabourBillRecord, 'company' | 'periodLabel'>,
): string {
  const parts = ['Line Business Transport service', 'Walton Labour Bill', group.label]
  if (bill.company.trim()) {
    parts.push(bill.company.trim())
  }
  parts.push(bill.periodLabel)
  return parts.join(' \u2014 ')
}

/**
 * One CSD's worksheet: the office's own sheet for that CSD, with its own title,
 * its own SL series starting at 1 and its own totals at the foot.
 */
function writeGroupSheet(
  workbook: Workbook,
  bill: LabourBillRecord,
  group: LabourCsdGroupRecord,
): void {
  const lines = group.lines

  const sheet = workbook.addWorksheet(sheetName(group, bill), {
    views: [{ state: 'frozen', ySplit: HEADER_ROW_TWO }],
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
  // Every printed page repeats both heading rows.
  sheet.pageSetup.printTitlesRow = `${HEADER_ROW}:${HEADER_ROW_TWO}`

  sheet.mergeCells(TITLE_ROW, 1, TITLE_ROW, COLUMNS.length)
  const title = sheet.getCell(TITLE_ROW, 1)
  title.value = labourBillTitle(group, bill)
  title.font = { name: FONT, size: 15, bold: true }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(TITLE_ROW).height = 26

  // Both heading rows are written and styled first; the merges come after, for
  // the reason the SL merges do — a value written into a merged range lands on
  // its master, so a blank written later would wipe what is above it.
  COLUMNS.forEach((spec, index) => {
    const column = index + 1
    const top = sheet.getCell(HEADER_ROW, column)
    const bottom = sheet.getCell(HEADER_ROW_TWO, column)

    top.value = spec.group ?? spec.header
    bottom.value = spec.group ? spec.header : null

    for (const cell of [top, bottom]) {
      styleCell(cell, { ...spec, align: 'center', wrap: true }, true)
      cell.fill = HEADER_FILL
    }
  })

  COLUMNS.forEach((spec, index) => {
    const column = index + 1
    if (!spec.group) {
      sheet.mergeCells(HEADER_ROW, column, HEADER_ROW_TWO, column)
    }
  })
  sheet.mergeCells(HEADER_ROW, FLOOR_NO_COLUMN, HEADER_ROW, FLOOR_AMOUNT_COLUMN)
  sheet.getRow(HEADER_ROW).height = 18
  sheet.getRow(HEADER_ROW_TWO).height = 18

  lines.forEach((line, index) => {
    const row = sheet.getRow(FIRST_DATA_ROW + index)
    const values = rowValues(line)

    COLUMNS.forEach((spec, column) => {
      const cell = row.getCell(column + 1)
      cell.value = values[column]
      styleCell(cell, spec)
    })

    for (const [column, value] of [
      [LABOUR_COLUMN, line.labourAmount],
      [FLOOR_AMOUNT_COLUMN, line.floorAmount],
      [TOTAL_COLUMN, line.total],
    ] as const) {
      if (typeof value === 'number') {
        row.getCell(column).numFmt = moneyFormat(value)
      }
    }
  })

  // One SL for the whole challan, merged down its models — after every row is
  // written, for the reason above.
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

  totalRow.getCell(QTY_COLUMN).value = sumOf(QTY_COLUMN, group.totals.qty)
  totalRow.getCell(LABOUR_COLUMN).value = sumOf(LABOUR_COLUMN, group.totals.labourTotal)
  totalRow.getCell(LABOUR_COLUMN).numFmt = moneyFormat(group.totals.labourTotal)
  // The Floor No. cell is deliberately left blank: floors are not a quantity,
  // and a column of them added up is a figure that means nothing.
  totalRow.getCell(FLOOR_AMOUNT_COLUMN).value = sumOf(FLOOR_AMOUNT_COLUMN, group.totals.floorTotal)
  totalRow.getCell(FLOOR_AMOUNT_COLUMN).numFmt = moneyFormat(group.totals.floorTotal)
  totalRow.getCell(TOTAL_COLUMN).value = sumOf(TOTAL_COLUMN, group.totals.totalAmount)
  totalRow.getCell(TOTAL_COLUMN).numFmt = moneyFormat(group.totals.totalAmount)
  totalRow.height = 20
}

/**
 * The month as a workbook: **one worksheet per CSD**, in the sheet's own order
 * with the pending section last.
 *
 * Separate sheets rather than one long list with headings in it, because that
 * is what the office sends — each CSD is billed on its own — and a workbook
 * splits the same way a printer does. The month is what holds them together, so
 * a bill nobody has scanned into still produces a file with the empty sheet in
 * it rather than a workbook with no sheets at all, which Excel refuses to open.
 */
export async function buildLabourBillWorkbook(
  bill: LabourBillRecord,
  groups: readonly LabourCsdGroupRecord[],
  now: Date = new Date(),
): Promise<Uint8Array> {
  // Loaded on demand: it is the largest dependency in the process and no other
  // request path in this module touches it.
  const { default: ExcelJS } = await import('exceljs')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'LBTS'
  workbook.created = now

  const sheets: readonly LabourCsdGroupRecord[] =
    groups.length > 0
      ? groups
      : [
          {
            csd: '',
            key: '',
            label: 'Labour',
            isPending: false,
            totals: { rows: 0, challans: 0, qty: 0, labourTotal: 0, floorTotal: 0, totalAmount: 0, unpricedLines: 0 },
            lines: [],
          },
        ]

  for (const group of sheets) {
    writeGroupSheet(workbook, bill, group)
  }

  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** `LBTS-WLB-2026-0007_2026-09.xlsx` — one file, one worksheet per CSD inside it. */
export function labourBillExportFilename(
  bill: Pick<LabourBillRecord, 'billNumber' | 'month' | 'year'>,
): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe(bill.billNumber)}_labour_${bill.year}-${String(bill.month).padStart(2, '0')}.xlsx`
}
