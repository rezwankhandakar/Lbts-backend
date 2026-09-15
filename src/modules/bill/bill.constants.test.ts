import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  arrangeBillLines,
  billPeriodRange,
  challanBillingStatusFor,
  formatBillNumber,
  gatePassBillingStatusFor,
} from './bill.constants'

describe('arrangeBillLines', () => {
  const line = (tripDoKey: string, seq: number) => ({ tripDoKey, seq })

  it('gives every row of one Trip DO the same SL and spans it from the first row', () => {
    const arranged = arrangeBillLines([
      line('4897277', 1),
      line('4387339', 2),
      line('4387339', 3),
      line('4387339', 4),
      line('4421072', 5),
    ])

    assert.deepEqual(
      arranged.map((row) => [row.tripDoKey, row.sl, row.slRowSpan]),
      [
        ['4897277', 1, 1],
        ['4387339', 2, 3],
        ['4387339', 2, 0],
        ['4387339', 2, 0],
        ['4421072', 3, 1],
      ],
    )
  })

  it('puts a row added later beneath its own Trip DO rather than opening a second SL', () => {
    const arranged = arrangeBillLines([line('A', 1), line('B', 2), line('A', 3)])

    assert.deepEqual(
      arranged.map((row) => [row.tripDoKey, row.seq, row.sl]),
      [
        ['A', 1, 1],
        ['A', 3, 1],
        ['B', 2, 2],
      ],
    )
    assert.equal(arranged[0].slRowSpan, 2)
  })

  it('orders Trip DOs by their first row whatever order the lines arrive in', () => {
    const arranged = arrangeBillLines([line('B', 7), line('A', 2), line('B', 5)])
    assert.deepEqual(
      arranged.map((row) => row.seq),
      [2, 5, 7],
    )
  })

  it('is empty for an empty bill', () => {
    assert.deepEqual(arrangeBillLines([]), [])
  })
})

describe('challanBillingStatusFor', () => {
  it('is unbilled with nothing billed, including a challan with no rows', () => {
    assert.equal(challanBillingStatusFor(3, 0), 'Unbilled')
    assert.equal(challanBillingStatusFor(0, 0), 'Unbilled')
  })

  it('is partial while a return or a split part is still off every bill', () => {
    assert.equal(challanBillingStatusFor(3, 2), 'Partial')
  })

  it('is billed when every row is', () => {
    assert.equal(challanBillingStatusFor(3, 3), 'Billed')
  })
})

describe('gatePassBillingStatusFor', () => {
  it('is unbilled with nothing billed', () => {
    assert.equal(
      gatePassBillingStatusFor({ totalQty: 5, billedOrderQty: 0, billedRows: 0, unbilledRows: 2 }),
      'Unbilled',
    )
  })

  it('is partial when fewer pieces are billed than it carried', () => {
    assert.equal(
      gatePassBillingStatusFor({ totalQty: 5, billedOrderQty: 3, billedRows: 2, unbilledRows: 0 }),
      'Partial',
    )
  })

  it('is partial when a linked row is still waiting, even with every piece billed', () => {
    assert.equal(
      gatePassBillingStatusFor({ totalQty: 5, billedOrderQty: 5, billedRows: 2, unbilledRows: 1 }),
      'Partial',
    )
  })

  it('is billed when every piece is billed and nothing linked waits', () => {
    assert.equal(
      gatePassBillingStatusFor({ totalQty: 5, billedOrderQty: 5, billedRows: 3, unbilledRows: 0 }),
      'Billed',
    )
  })
})

describe('numbering and periods', () => {
  it('pads the sequence under the bill year', () => {
    assert.equal(formatBillNumber(2026, 7), 'LBTS-BILL-2026-0007')
  })

  it('covers the whole month, December into the next year included', () => {
    const { start, end } = billPeriodRange(12, 2026)
    assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z')
    assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z')
  })
})
