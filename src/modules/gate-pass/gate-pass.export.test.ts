import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Workbook } from 'exceljs'
import { buildGatePassWorkbook, gatePassExportFilename, toSheetDate } from './gate-pass.export'
import type { GatePassRecord } from './gate-pass.serializer'

/**
 * The spreadsheet writer, exercised by writing a workbook and reading it back.
 *
 * Worth pinning down for the same reason the PDF writer is: nobody reviews an
 * export before it is opened somewhere else, and the two things most likely to
 * be silently wrong in one — a trip date landing on the day before, and a
 * quantity total that does not match the list it came from — are both invisible
 * until somebody reconciles a month by hand.
 */

function record(overrides: Partial<GatePassRecord> = {}): GatePassRecord {
  return {
    id: '1',
    gatePassId: 'GP-2026-000012',
    tripDo: '5090413',
    tripDate: '2026-09-01',
    csd: 'CSD-03',
    unit: 'WFR',
    customerName: 'Fan Fare Bangladesh Ltd',
    vehicleNo: 'DHAKA METRO-NA-15-1469',
    referenceType: 'Zone',
    zone: 'CSD-07',
    po: null,
    items: [
      { productName: 'Refrigerator', model: 'WFA-2A3-GDEL-SC', qty: 1 },
      { productName: 'Air Conditioner', model: 'WSN-KRYSTALINE-24H', qty: 2 },
    ],
    totalQty: 3,
    status: 'Verified',
    document: {
      url: '/gate-passes/1/document',
      mimeType: 'application/pdf',
      size: 2048,
      originalName: 'scan.pdf',
      uploadedAt: '2026-09-01T10:00:00.000Z',
      pageCount: 1,
    },
    submittedAt: '2026-09-01T09:00:00.000Z',
    statusChangedAt: '2026-09-01T11:00:00.000Z',
    statusChangedBy: { id: 'u1', name: 'Rezwan Khandaker' },
    statusNote: null,
    createdBy: { id: 'u1', name: 'Rezwan Khandaker' },
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedBy: null,
    updatedAt: '2026-09-01T11:00:00.000Z',
    ...overrides,
  }
}

async function readBack(records: GatePassRecord[]): Promise<Workbook> {
  const bytes = await buildGatePassWorkbook(records)
  const workbook = new Workbook()
  await workbook.xlsx.load(bytes.buffer as ArrayBuffer)
  return workbook
}

describe('gate pass export', () => {
  it('gives every product line its own row, under a header', async () => {
    const workbook = await readBack([record()])
    const sheet = workbook.getWorksheet('Gate passes')
    assert.ok(sheet)

    assert.equal(sheet.getRow(1).getCell(1).value, 'Gate pass')

    // One gate pass carrying two lines is two rows, and the trip is repeated
    // across both so each row stands on its own in a pivot.
    assert.equal(sheet.getRow(2).getCell(1).value, 'GP-2026-000012')
    assert.equal(sheet.getRow(3).getCell(1).value, 'GP-2026-000012')
    assert.equal(sheet.getRow(2).getCell('F').value, 'Fan Fare Bangladesh Ltd')
    assert.equal(sheet.getRow(3).getCell('F').value, 'Fan Fare Bangladesh Ltd')
  })

  it('keeps product name, model and quantity in three columns', async () => {
    const workbook = await readBack([record()])
    const sheet = workbook.getWorksheet('Gate passes')

    assert.equal(sheet?.getRow(1).getCell('H').value, 'Product')
    assert.equal(sheet?.getRow(1).getCell('I').value, 'Model')
    assert.equal(sheet?.getRow(1).getCell('J').value, 'Qty')

    assert.equal(sheet?.getRow(2).getCell('H').value, 'Refrigerator')
    assert.equal(sheet?.getRow(2).getCell('I').value, 'WFA-2A3-GDEL-SC')
    assert.equal(sheet?.getRow(2).getCell('J').value, 1)

    assert.equal(sheet?.getRow(3).getCell('H').value, 'Air Conditioner')
    assert.equal(sheet?.getRow(3).getCell('I').value, 'WSN-KRYSTALINE-24H')
    assert.equal(sheet?.getRow(3).getCell('J').value, 2)
  })

  /**
   * The invariant behind the day, stated where it can be checked in any
   * timezone: a trip date becomes local midnight. Excel stores a day as a
   * serial number that ExcelJS derives using the machine's own offset, so a
   * UTC midnight would be written as the evening before anywhere west of
   * Greenwich — local midnight cancels that offset exactly.
   */
  it('turns a trip date into local midnight on the same day', () => {
    const date = toSheetDate('2026-09-01')
    assert.ok(date instanceof Date)
    assert.equal(date.getFullYear(), 2026)
    assert.equal(date.getMonth() + 1, 9)
    assert.equal(date.getDate(), 1)
    assert.equal(date.getHours(), 0)
    assert.equal(date.getMinutes(), 0)
  })

  it('keeps a trip date on its own calendar day', async () => {
    const workbook = await readBack([record({ tripDate: '2026-09-01' })])
    const cell = workbook.getWorksheet('Gate passes')?.getRow(2).getCell('B').value

    assert.ok(cell instanceof Date)
    assert.equal(cell.getFullYear(), 2026)
    assert.equal(cell.getMonth() + 1, 9)
    assert.equal(cell.getDate(), 1)
  })

  it('totals the line quantities, matching what the records page shows', async () => {
    const workbook = await readBack([
      record(),
      record({ id: '2', gatePassId: 'GP-2026-000014', items: [{ productName: 'Gas Stove', model: 'WGS-SDH90', qty: 4 }] }),
    ])
    const sheet = workbook.getWorksheet('Gate passes')

    // Two lines from the first record, one from the second: three data rows.
    const totals = sheet?.getRow(5)
    assert.equal(totals?.getCell(1).value, 'Total')
    // A formula rather than a number, so the figure survives being filtered
    // inside Excel. 1 + 2 + 4 is the 7 the same filters would show on screen.
    assert.deepEqual(totals?.getCell('J').value, { formula: 'SUBTOTAL(109,J2:J4)' })
  })

  it('says whether a record carries its scan', async () => {
    const workbook = await readBack([
      record({ items: [{ productName: 'Gas Stove', model: 'WGS-SDH90', qty: 1 }] }),
      record({ id: '2', document: null, items: [{ productName: 'Gas Stove', model: 'WGS-SDH90', qty: 1 }] }),
    ])
    const sheet = workbook.getWorksheet('Gate passes')

    assert.equal(sheet?.getRow(2).getCell('O').value, 'Yes')
    assert.equal(sheet?.getRow(3).getCell('O').value, 'No')
  })

  it('names the file after the day it was exported', () => {
    assert.equal(gatePassExportFilename(new Date(2026, 8, 5, 14, 30)), 'gate-passes-2026-09-05.xlsx')
  })
})
