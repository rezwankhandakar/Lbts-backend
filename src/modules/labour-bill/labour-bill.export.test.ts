import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FIRST_DATA_ROW,
  HEADER_ROW,
  HEADER_ROW_TWO,
  buildLabourBillWorkbook,
  labourBillExportFilename,
} from './labour-bill.export'
import { labourGroupTotals } from './labour-bill.serializer'
import type {
  LabourBillLineRecord,
  LabourBillRecord,
  LabourCsdGroupRecord,
} from './labour-bill.serializer'

const BILL: LabourBillRecord = {
  id: 'b1',
  billNumber: 'LBTS-WLB-2026-0003',
  month: 9,
  year: 2026,
  periodLabel: 'September 2026',
  company: 'Walton Hi-Tech Industries',
  note: '',
  status: 'Draft',
  lineCount: 4,
  challanCount: 2,
  totalQty: 7,
  labourTotal: 2300,
  floorTotal: 800,
  totalAmount: 3100,
  unpricedLines: 0,
  finalizedAt: null,
  finalizedBy: null,
  reopenedAt: null,
  reopenedBy: null,
  createdBy: null,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedBy: null,
  updatedAt: '2026-09-15T00:00:00.000Z',
}

function line(overrides: Partial<LabourBillLineRecord>): LabourBillLineRecord {
  return {
    id: 'l',
    tripDoLineId: 't',
    challanId: 'c',
    gatePassId: 'g',
    sl: 1,
    slRowSpan: 1,
    challanNumber: 'LBTS-CH-2026-000001',
    challanSlNumber: 10001,
    challanDate: '2026-09-01T00:00:00.000Z',
    customerName: 'TMSS',
    deliveryAddress: 'Hobirbari, Mymensingh Road',
    district: 'Mymensingh',
    thana: 'Bhaluka',
    receiverMobile: '01958634157',
    productName: 'Refrigerator',
    model: 'WFA-2A3-GDEL-XX',
    qty: 1,
    tripDo: '4421072',
    tripDate: '2026-09-02',
    csd: 'CSD-02',
    gatePassNumber: 'GP-2026-000001',
    unit: 'WFR',
    company: 'Walton Hi-Tech Industries',
    labourAmount: 500,
    floorNo: 2,
    floorAmount: 200,
    total: 700,
    drift: 'none',
    addedAt: '2026-09-15T00:00:00.000Z',
    addedBy: null,
    updatedAt: '2026-09-15T00:00:00.000Z',
    updatedBy: null,
    ...overrides,
  }
}

const LINES = [
  line({ sl: 1, slRowSpan: 1, receiverMobile: '01772525487', labourAmount: 800, floorAmount: 300, total: 1100, qty: 4 }),
  line({ sl: 2, slRowSpan: 3, challanId: 'c2', labourAmount: 500, floorAmount: 200, total: 700 }),
  line({ sl: 2, slRowSpan: 0, challanId: 'c2', labourAmount: 500, floorNo: null, floorAmount: null, total: 500 }),
  line({ sl: 2, slRowSpan: 0, challanId: 'c2', labourAmount: 500, floorAmount: 300, total: 800 }),
]

function group(csd: string, lines: LabourBillLineRecord[]): LabourCsdGroupRecord {
  return {
    csd,
    key: csd.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
    label: csd || 'Trip DO pending',
    isPending: csd === '',
    totals: labourGroupTotals(lines),
    lines,
  }
}

const GROUPS = [group('CSD-02', LINES)]

async function load(bytes: Uint8Array, index = 0) {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[index]
  assert.ok(sheet)
  return sheet
}

async function sheetNames(bytes: Uint8Array): Promise<string[]> {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  return workbook.worksheets.map((sheet) => sheet.name)
}

describe('buildLabourBillWorkbook', () => {
  it('carries one title line and nothing else above the columns', async () => {
    const sheet = await load(await buildLabourBillWorkbook(BILL, GROUPS))
    assert.equal(
      sheet.getCell(1, 1).value,
      'Line Business Transport service — Walton Labour Bill — CSD-02 — Walton Hi-Tech Industries — September 2026',
    )
    assert.equal(HEADER_ROW, 2)
  })

  it('writes the office columns in their order', async () => {
    const sheet = await load(await buildLabourBillWorkbook(BILL, GROUPS))
    const header = sheet.getRow(HEADER_ROW)
    assert.equal(header.getCell(1).value, 'SL')
    assert.equal(header.getCell(6).value, 'Unit')
    assert.equal(header.getCell(7).value, 'Model')
    assert.equal(header.getCell(8).value, 'Trip Do')
    assert.equal(header.getCell(10).value, 'Ven/Pulling/Labour')
    assert.equal(header.getCell(13).value, 'Total Amount')
  })

  // The Floor column is one column of two cells; flattening it into two
  // unrelated headings is exactly what the two-row header exists to avoid.
  it('spans one Floor heading over its two cells', async () => {
    const sheet = await load(await buildLabourBillWorkbook(BILL, GROUPS))
    assert.equal(sheet.getCell(HEADER_ROW, 11).value, 'Floor')
    assert.equal(sheet.getCell(HEADER_ROW, 12).master.address, `K${HEADER_ROW}`)
    assert.equal(sheet.getCell(HEADER_ROW_TWO, 11).value, 'Floor No.')
    assert.equal(sheet.getCell(HEADER_ROW_TWO, 12).value, 'Amount')
    // Everything else is merged down through both heading rows.
    assert.equal(sheet.getCell(HEADER_ROW_TWO, 1).master.address, `A${HEADER_ROW}`)
  })

  it('merges one SL down every model of a challan', async () => {
    const sheet = await load(await buildLabourBillWorkbook(BILL, GROUPS))
    const first = FIRST_DATA_ROW

    assert.equal(sheet.getCell(first, 1).value, 1)
    assert.equal(sheet.getCell(first + 1, 1).value, 2)
    assert.equal(sheet.getCell(first + 2, 1).master.address, `A${first + 1}`)
    assert.equal(sheet.getCell(first + 3, 1).master.address, `A${first + 1}`)
  })

  it('keeps a receiver number as text and leaves an untyped floor cell empty', async () => {
    const sheet = await load(await buildLabourBillWorkbook(BILL, GROUPS))
    assert.equal(sheet.getCell(FIRST_DATA_ROW, 4).value, '01772525487')
    assert.equal(sheet.getCell(FIRST_DATA_ROW + 2, 11).value, null)
    assert.equal(sheet.getCell(FIRST_DATA_ROW + 2, 12).value, null)
    assert.equal(sheet.getCell(FIRST_DATA_ROW + 2, 13).value, 500)
  })

  it('totals the quantity, the labour, the floor amount and the total', async () => {
    const sheet = await load(await buildLabourBillWorkbook(BILL, GROUPS))
    const total = FIRST_DATA_ROW + LINES.length
    const last = total - 1

    assert.equal(sheet.getCell(total, 1).value, 'Total')
    assert.deepEqual(sheet.getCell(total, 9).value, { formula: `SUM(I${FIRST_DATA_ROW}:I${last})`, result: 7 })
    assert.deepEqual(sheet.getCell(total, 10).value, { formula: `SUM(J${FIRST_DATA_ROW}:J${last})`, result: 2300 })
    assert.deepEqual(sheet.getCell(total, 12).value, { formula: `SUM(L${FIRST_DATA_ROW}:L${last})`, result: 800 })
    assert.deepEqual(sheet.getCell(total, 13).value, { formula: `SUM(M${FIRST_DATA_ROW}:M${last})`, result: 3100 })
    // Floors are not a quantity, so the column of them is not added up.
    assert.equal(sheet.getCell(total, 11).value, null)
  })

  // Each CSD is billed on its own, so each gets its own worksheet — the month
  // is only what holds them together in one file.
  it('writes one worksheet per CSD, in the sheet order, pending last', async () => {
    const bytes = await buildLabourBillWorkbook(BILL, [
      group('CSD-01', [line({ sl: 1, slRowSpan: 1, csd: 'CSD-01' })]),
      group('CSD-02', LINES),
      group('', [line({ sl: 1, slRowSpan: 1, csd: '', tripDo: '' })]),
    ])

    assert.deepEqual(await sheetNames(bytes), [
      'CSD-01 Sep 2026',
      'CSD-02 Sep 2026',
      'Trip DO pending Sep 2026',
    ])
  })

  it('restarts the SL at 1 in every section and totals each on its own', async () => {
    const bytes = await buildLabourBillWorkbook(BILL, [
      group('CSD-01', [line({ sl: 1, slRowSpan: 1, csd: 'CSD-01', total: 700, qty: 1 })]),
      group('CSD-02', LINES),
    ])

    const first = await load(bytes, 0)
    const second = await load(bytes, 1)

    assert.equal(first.getCell(FIRST_DATA_ROW, 1).value, 1)
    assert.equal(second.getCell(FIRST_DATA_ROW, 1).value, 1)
    // Each foot sums only its own rows, and each section starts again at the top.
    assert.deepEqual(first.getCell(FIRST_DATA_ROW + 1, 13).value, {
      formula: 'SUM(M4:M4)',
      result: 700,
    })
    assert.deepEqual(second.getCell(FIRST_DATA_ROW + 4, 13).value, {
      formula: 'SUM(M4:M7)',
      result: 3100,
    })
  })

  it('titles the pending sheet after the missing Trip DO rather than a missing CSD', async () => {
    const sheet = await load(
      await buildLabourBillWorkbook(BILL, [group('', [line({ sl: 1, slRowSpan: 1, csd: '' })])]),
    )
    assert.equal(
      sheet.getCell(1, 1).value,
      'Line Business Transport service — Walton Labour Bill — Trip DO pending — Walton Hi-Tech Industries — September 2026',
    )
  })

  // Excel refuses to open a workbook with no worksheets at all.
  it('still writes a header and a zero total for a bill nothing has been scanned onto', async () => {
    const sheet = await load(
      await buildLabourBillWorkbook({ ...BILL, totalQty: 0, labourTotal: 0, floorTotal: 0, totalAmount: 0 }, []),
    )
    assert.equal(sheet.getCell(HEADER_ROW, 1).value, 'SL')
    assert.equal(sheet.getCell(FIRST_DATA_ROW, 13).value, 0)
  })

  it('drops the company from the title when the slot names none', async () => {
    const sheet = await load(await buildLabourBillWorkbook({ ...BILL, company: '' }, GROUPS))
    assert.equal(
      sheet.getCell(1, 1).value,
      'Line Business Transport service — Walton Labour Bill — CSD-02 — September 2026',
    )
  })
})

describe('labourBillExportFilename', () => {
  it('names the bill and its month; the CSDs are the worksheets inside it', () => {
    assert.equal(labourBillExportFilename(BILL), 'LBTS-WLB-2026-0003_labour_2026-09.xlsx')
  })
})
