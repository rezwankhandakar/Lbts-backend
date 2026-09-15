import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FIRST_DATA_ROW, HEADER_ROW, billExportFilename, buildBillWorkbook } from './bill.export'
import type { BillLineRecord, BillRecord } from './bill.serializer'

const BILL: BillRecord = {
  id: 'b1',
  billNumber: 'LBTS-BILL-2026-0003',
  month: 9,
  year: 2026,
  periodLabel: 'September 2026',
  unit: 'WFR',
  note: '',
  status: 'Draft',
  lineCount: 5,
  tripDoCount: 3,
  challanCount: 5,
  totalQty: 5,
  totalAmount: 7710,
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

function line(overrides: Partial<BillLineRecord>): BillLineRecord {
  return {
    id: 'l',
    tripDoLineId: 't',
    challanId: 'c',
    gatePassId: 'g',
    sl: 1,
    slRowSpan: 1,
    kind: 'Order',
    remarks: '',
    challanNumber: 'LBTS-CH-2026-000001',
    challanSlNumber: 10001,
    challanDate: '2026-09-01T00:00:00.000Z',
    customerName: 'TMSS',
    deliveryAddress: 'Hobirbari, Mymensingh Road',
    district: 'Mymensingh',
    thana: 'Bhaluka',
    locationType: 'OSD-Thana',
    receiverMobile: '01958634157',
    productName: 'Refrigerator',
    model: 'WFA-2A3-GDEL-XX',
    capacity: 'Gross 151-285 Litre',
    qty: 1,
    rate: { kind: 'flat', amount: 1680 },
    amount: 1680,
    tripDo: '4421072',
    tripDate: '2026-09-02',
    gatePassNumber: 'GP-2026-000001',
    csd: 'CSD-01',
    unit: 'WFR',
    tripNumbers: [],
    drift: 'none',
    addedAt: '2026-09-15T00:00:00.000Z',
    addedBy: null,
    ...overrides,
  }
}

const LINES = [
  line({ sl: 1, slRowSpan: 1, tripDo: '4897277', kind: 'Return', remarks: 'Return', amount: 1450, receiverMobile: '01772525487' }),
  line({ sl: 2, slRowSpan: 3, tripDo: '4387339', amount: 1450 }),
  line({ sl: 2, slRowSpan: 0, tripDo: '4387339', amount: 1680 }),
  line({ sl: 2, slRowSpan: 0, tripDo: '4387339', amount: 1450 }),
  line({ sl: 3, slRowSpan: 1, tripDo: '4421072', kind: 'Resent', remarks: 'Re-Sent', amount: 1680 }),
]

async function load(bytes: Uint8Array) {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet)
  return sheet
}

describe('buildBillWorkbook', () => {
  it('carries one title line and nothing else above the columns', async () => {
    const sheet = await load(await buildBillWorkbook(BILL, LINES))
    assert.equal(sheet.getCell(1, 1).value, 'Line Business Transport service Bill — Unit WFR — September 2026')
    assert.equal(HEADER_ROW, 2)
  })

  it('writes the office columns in their order', async () => {
    const sheet = await load(await buildBillWorkbook(BILL, LINES))
    const header = sheet.getRow(HEADER_ROW)
    assert.equal(header.getCell(1).value, 'SL')
    assert.equal(header.getCell(10).value, 'Products Model')
    assert.equal(header.getCell(15).value, 'Trip Do')
    assert.equal(header.getCell(17).value, 'Remarks')
  })

  it('merges one SL down every row of a Trip DO', async () => {
    const sheet = await load(await buildBillWorkbook(BILL, LINES))
    const first = FIRST_DATA_ROW

    assert.equal(sheet.getCell(first, 1).value, 1)
    assert.equal(sheet.getCell(first + 1, 1).value, 2)
    assert.equal(sheet.getCell(first + 2, 1).master.address, `A${first + 1}`)
    assert.equal(sheet.getCell(first + 3, 1).master.address, `A${first + 1}`)
    assert.equal(sheet.getCell(first + 4, 1).value, 3)
    assert.equal(sheet.getCell(first + 4, 1).master.address, `A${first + 4}`)
  })

  it('keeps a receiver number as text and writes the remarks', async () => {
    const sheet = await load(await buildBillWorkbook(BILL, LINES))
    assert.equal(sheet.getCell(FIRST_DATA_ROW, 4).value, '01772525487')
    assert.equal(sheet.getCell(FIRST_DATA_ROW, 17).value, 'Return')
    assert.equal(sheet.getCell(FIRST_DATA_ROW + 4, 17).value, 'Re-Sent')
  })

  it('totals the quantity and the amount under the rows', async () => {
    const sheet = await load(await buildBillWorkbook(BILL, LINES))
    const total = FIRST_DATA_ROW + LINES.length
    const last = total - 1

    assert.equal(sheet.getCell(total, 1).value, 'Total')
    assert.deepEqual(sheet.getCell(total, 11).value, {
      formula: `SUM(K${FIRST_DATA_ROW}:K${last})`,
      result: 5,
    })
    assert.deepEqual(sheet.getCell(total, 13).value, {
      formula: `SUM(M${FIRST_DATA_ROW}:M${last})`,
      result: 7710,
    })
  })

  it('still writes a header and a zero total for an empty bill', async () => {
    const sheet = await load(await buildBillWorkbook({ ...BILL, totalQty: 0, totalAmount: 0 }, []))
    assert.equal(sheet.getCell(HEADER_ROW, 1).value, 'SL')
    assert.equal(sheet.getCell(FIRST_DATA_ROW, 11).value, 0)
  })
})

describe('billExportFilename', () => {
  it('names the bill, its unit and its month', () => {
    assert.equal(billExportFilename(BILL), 'LBTS-BILL-2026-0003_WFR_2026-09.xlsx')
  })
})
