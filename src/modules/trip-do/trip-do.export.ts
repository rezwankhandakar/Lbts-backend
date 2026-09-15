import type { Column, Worksheet } from 'exceljs'
import type { TripDoRowRecord } from './trip-do.serializer'

/**
 * The Trip DO sheet as a real spreadsheet — the file the office kept by hand
 * before this module existed, column for column.
 *
 * An .xlsx rather than a CSV for the reason the gate pass export gives: dates
 * and quantities handed to Excel as text are re-guessed against the machine's
 * locale, and a transport record cannot carry that quiet wrongness.
 */

const COLUMNS: Partial<Column>[] = [
  { header: 'SL', key: 'sl', width: 9 },
  { header: 'Date', key: 'date', width: 13, style: { numFmt: 'dd-mmm-yyyy' } },
  { header: 'Trip Number', key: 'tripNumber', width: 22 },
  { header: 'Delivery Status', key: 'deliveryStatus', width: 15 },
  { header: 'Customer', key: 'customer', width: 28 },
  { header: 'Address', key: 'address', width: 40 },
  { header: 'District', key: 'district', width: 14 },
  { header: 'Thana', key: 'thana', width: 16 },
  { header: 'Location', key: 'location', width: 12 },
  { header: 'Receiver number', key: 'receiver', width: 15 },
  { header: 'Zone', key: 'zone', width: 14 },
  { header: 'Product name', key: 'productName', width: 24 },
  { header: 'Model', key: 'model', width: 22 },
  { header: 'Qty', key: 'qty', width: 8 },
  { header: 'Rate', key: 'rate', width: 12 },
  { header: 'Amount', key: 'amount', width: 12, style: { numFmt: '#,##0.##' } },
  { header: 'Capacity', key: 'capacity', width: 18 },
  { header: 'CSD', key: 'csd', width: 10 },
  { header: 'Unit', key: 'unit', width: 10 },
  { header: 'Trip Do', key: 'tripDo', width: 20 },
  { header: 'Row', key: 'kind', width: 10 },
  { header: 'Challan', key: 'challanNumber', width: 22 },
  { header: 'Gate pass', key: 'gatePass', width: 16 },
]

const QTY_COLUMN = 'N'
const AMOUNT_COLUMN = 'P'

const KIND_LABELS: Record<TripDoRowRecord['kind'], string> = {
  Order: 'Order',
  Return: 'Return',
  Resent: 'Re-sent',
}

/** A filing instant as the calendar day it was, at local midnight — see `toSheetDate`. */
function toSheetDay(iso: string): Date | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function rateText(rate: TripDoRowRecord['rate']): string {
  if (!rate) {
    return ''
  }
  return rate.kind === 'flat' ? String(rate.amount) : `${rate.firstAmount} / ${rate.restAmount}`
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
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }]
}

export async function buildTripDoWorkbook(rows: TripDoRowRecord[]): Promise<Uint8Array> {
  // Loaded on demand for the reason `buildGatePassWorkbook` gives.
  const { default: ExcelJS } = await import('exceljs')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'LBTS'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Trip DO')
  sheet.columns = COLUMNS

  for (const row of rows) {
    const added = sheet.addRow({
      sl: row.slNumber,
      date: toSheetDay(row.date),
      tripNumber: row.tripNumbers.join(', '),
      deliveryStatus: row.deliveryStatus,
      customer: row.customerName,
      address: row.deliveryAddress,
      district: row.district,
      thana: row.thana,
      location: row.locationType ?? '',
      receiver: row.receiverMobile,
      zone: row.zonePo ?? '',
      productName: row.productName,
      model: row.model,
      qty: row.qty,
      rate: rateText(row.rate),
      amount: row.amount,
      capacity: row.capacity,
      csd: row.link?.csd ?? '',
      unit: row.link?.unit ?? '',
      tripDo: row.link?.tripDo ?? '',
      kind: KIND_LABELS[row.kind],
      challanNumber: row.challanNumber,
      gatePass: row.link?.gatePassNumber ?? '',
    })

    // A return reads apart from an order at a glance, as it does on screen.
    if (row.kind !== 'Order') {
      added.font = { italic: true, color: { argb: row.kind === 'Return' ? 'FFB42318' : 'FF0E7490' } }
    }
  }

  const lastDataRow = sheet.rowCount
  styleHeader(sheet)
  sheet.autoFilter = { from: 'A1', to: { row: lastDataRow, column: COLUMNS.length } }

  const total = sheet.addRow([])
  total.getCell(1).value = 'Total'
  // SUBTOTAL, so the figures still answer after somebody filters inside Excel.
  total.getCell(QTY_COLUMN).value = { formula: `SUBTOTAL(109,${QTY_COLUMN}2:${QTY_COLUMN}${lastDataRow})` }
  total.getCell(AMOUNT_COLUMN).value = {
    formula: `SUBTOTAL(109,${AMOUNT_COLUMN}2:${AMOUNT_COLUMN}${lastDataRow})`,
  }
  total.font = { bold: true }
  total.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FFBFBFCC' } } }
  })

  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

export function tripDoExportFilename(now: Date = new Date()): string {
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  return `trip-do-${stamp}.xlsx`
}
