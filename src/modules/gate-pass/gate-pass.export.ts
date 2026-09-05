import type { Column, Row, Worksheet } from 'exceljs'
import type { GatePassRecord } from './gate-pass.serializer'

/**
 * The spreadsheet an operator downloads.
 *
 * A real .xlsx rather than a CSV, for one reason that matters: a gate pass
 * carries dates and quantities, and a CSV hands both to Excel as text to be
 * re-guessed against whatever locale the machine is set to. `01-09-2026`
 * becoming the first of September on one desk and the ninth of January on the
 * next is exactly the kind of quiet wrongness a transport record cannot carry.
 *
 * **One row per product line, not per gate pass.** A challan carrying an
 * indoor and an outdoor unit is two rows, with the trip repeated across both.
 * Product name, model and quantity are three columns, because a spreadsheet
 * exists to be sorted, filtered and pivoted — and none of that works on
 * "Refrigerator (WFA-2A3-GDEL-SC) x1; Air Conditioner (WSN-KRYSTALINE-24H) x1"
 * squashed into a single cell. The cost is that a row count is a line count
 * rather than a record count; the gate pass number is the first column, so
 * counting records is one `Remove duplicates` away.
 */

/** Wide enough that nothing on the page is truncated on first open. */
const COLUMNS: Partial<Column>[] = [
  { header: 'Gate pass', key: 'gatePassId', width: 16 },
  { header: 'Trip date', key: 'tripDate', width: 13, style: { numFmt: 'dd-mmm-yyyy' } },
  { header: 'Trip DO', key: 'tripDo', width: 20 },
  { header: 'CSD', key: 'csd', width: 10 },
  { header: 'Unit', key: 'unit', width: 10 },
  { header: 'Customer', key: 'customerName', width: 30 },
  { header: 'Vehicle', key: 'vehicleNo', width: 24 },
  { header: 'Product', key: 'productName', width: 30 },
  { header: 'Model', key: 'model', width: 26 },
  { header: 'Qty', key: 'qty', width: 9 },
  { header: 'Reference', key: 'reference', width: 18 },
  { header: 'Status', key: 'status', width: 12 },
  { header: 'Created by', key: 'createdBy', width: 20 },
  { header: 'Created at', key: 'createdAt', width: 20, style: { numFmt: 'dd-mmm-yyyy hh:mm' } },
  { header: 'Scan', key: 'scan', width: 8 },
]

/** Where the quantity lives, for the totals formula. */
const QTY_COLUMN = 'J'

/**
 * A trip date as a spreadsheet date.
 *
 * Built from the calendar parts at *local* midnight on purpose. A trip date is
 * a day, and Excel stores a day as a serial number that a writer derives using
 * the machine's own offset — hand it a UTC midnight and a workbook generated
 * west of Greenwich would date every gate pass to the day before. Local
 * midnight cancels that offset exactly, wherever the file is built.
 */
export function toSheetDate(value: string): Date | null {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  if (!year || !month || !day) {
    return null
  }
  return new Date(year, month - 1, day)
}

function toInstant(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "Zone CSD-07", "PO 627143140", or nothing — the same rule the UI renders. */
function referenceOf(record: GatePassRecord): string {
  if (record.referenceType === 'Zone' && record.zone) {
    return `Zone ${record.zone}`
  }
  if (record.referenceType === 'PO' && record.po) {
    return `PO ${record.po}`
  }
  return ''
}

function styleHeader(sheet: Worksheet): void {
  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDF2' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFCC' } } }
  })
  header.height = 20
  // The header stays put while an operator scrolls a month of records.
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}

/**
 * The quantity total, under the last row.
 *
 * `SUBTOTAL` rather than a written-out number, so the figure still answers the
 * question after somebody filters the sheet inside Excel — a fixed sum would
 * go on reporting the whole month while the rows on screen showed one
 * customer. Summed over the line quantities, so it matches the total the
 * records page shows for the same filters.
 */
function addTotalRow(sheet: Worksheet, column: string, lastDataRow: number): Row {
  const total = sheet.addRow([])
  total.getCell(1).value = 'Total'
  total.getCell(column).value = { formula: `SUBTOTAL(109,${column}2:${column}${lastDataRow})` }
  total.font = { bold: true }
  total.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FFBFBFCC' } } }
  })
  return total
}

export async function buildGatePassWorkbook(records: GatePassRecord[]): Promise<Uint8Array> {
  /**
   * Loaded only when somebody exports. ExcelJS is the largest dependency in
   * this process and no other request path touches it, so an instance that
   * never exports never pays to hold it — the same posture `config/r2.ts`
   * takes with its S3 client. Reached through `default` because ExcelJS is a
   * CommonJS package: a dynamic import of one puts its module.exports there,
   * and named bindings off the namespace are undefined at runtime whatever the
   * types imply.
   */
  const { default: ExcelJS } = await import('exceljs')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'LBTS'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Gate passes')
  sheet.columns = COLUMNS

  for (const record of records) {
    // The trip is repeated on every line it carried, which is what lets a
    // pivot group by customer, by model or by both without joining anything.
    for (const item of record.items) {
      sheet.addRow({
        gatePassId: record.gatePassId,
        tripDate: toSheetDate(record.tripDate),
        tripDo: record.tripDo,
        csd: record.csd,
        unit: record.unit,
        customerName: record.customerName,
        vehicleNo: record.vehicleNo,
        productName: item.productName,
        model: item.model,
        qty: item.qty,
        reference: referenceOf(record),
        status: record.status,
        createdBy: record.createdBy?.name ?? '',
        createdAt: toInstant(record.createdAt),
        scan: record.document ? 'Yes' : 'No',
      })
    }
  }

  const lastDataRow = sheet.rowCount
  styleHeader(sheet)
  // Set before the totals row exists, so filtering the table never hides or
  // reorders the figure sitting underneath it.
  sheet.autoFilter = { from: 'A1', to: { row: lastDataRow, column: COLUMNS.length } }
  addTotalRow(sheet, QTY_COLUMN, lastDataRow)

  /**
   * ExcelJS declares a global `Buffer extends ArrayBuffer` of its own, which is
   * not node's and not what the rest of this codebase means by the name. A
   * plain byte view is the honest way across that seam, and is what the
   * response writer wants anyway.
   */
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/**
 * What the browser saves the file as. Dated so a folder of exports sorts
 * usefully, and named after the module rather than after the filters — a
 * filename carrying eight optional values is unreadable, and the filters that
 * produced it are visible in the sheet itself.
 */
export function gatePassExportFilename(now: Date = new Date()): string {
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
  return `gate-passes-${stamp}.xlsx`
}
