import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  gatePassColumnValue,
  lineConditions,
  lineHasPieces,
  lineMatchesColumns,
  recordFilterClauses,
} from './gate-pass.columns'

/**
 * The gate pass sheet's column filters, as decisions: which gate passes a tick
 * keeps, and — because the sheet is one row per line — which lines.
 */

const RECORD = {
  tripDo: '5119060',
  tripDate: new Date('2026-09-09T00:00:00.000Z'),
  csd: 'CSD-01',
  unit: '',
  vehicleNo: 'DHAKA METRO-NA-15-1469',
  customerName: 'Arif Hossain',
  status: 'Submitted',
}
const FRIDGE = { productName: 'Refrigerator', productModel: 'WBQ-4D0-GTCE-HX', qty: 4 }

describe('recordFilterClauses', () => {
  it('filters gate pass fields, a blank matching null, empty or missing', () => {
    assert.deepEqual(recordFilterClauses({ csd: ['CSD-01'], unit: [null] }), [
      { csd: { $in: ['CSD-01'] } },
      { unit: { $in: [null, ''] } },
    ])
  })

  it('turns ticked trip dates into whole days', () => {
    assert.deepEqual(recordFilterClauses({ tripDate: ['2026-09-09'] }), [
      {
        tripDate: {
          $gte: new Date('2026-09-09T00:00:00.000Z'),
          $lt: new Date('2026-09-10T00:00:00.000Z'),
        },
      },
    ])
  })
})

describe('lineConditions', () => {
  it('puts every line filter on the same line', () => {
    assert.deepEqual(lineConditions({ product: ['Refrigerator'], qty: [4] }), {
      productName: { $in: ['Refrigerator'] },
      qty: { $in: [4] },
    })
  })

  it('is nothing when no line column is filtered', () => {
    assert.equal(lineConditions({ csd: ['CSD-01'], delivery: ['Delivered'] }), null)
  })
})

describe('lineMatchesColumns', () => {
  it('needs one line to satisfy every line filter, delivery status included', () => {
    assert.equal(lineMatchesColumns(FRIDGE, 'Returned', { model: ['WBQ-4D0-GTCE-HX'], delivery: ['Returned'] }), true)
    assert.equal(lineMatchesColumns(FRIDGE, 'Delivered', { model: ['WBQ-4D0-GTCE-HX'], delivery: ['Returned'] }), false)
    assert.equal(lineMatchesColumns(FRIDGE, 'Unlinked', {}), true)
  })
})

describe('lineHasPieces', () => {
  const pieces = (deliveredQty: number, sentQty = 0, returnedQty = 0) => ({
    deliveredQty,
    sentQty,
    returnedQty,
  })

  it('keeps a line under every card it holds pieces for', () => {
    const mixed = pieces(2, 1, 1)
    assert.equal(lineHasPieces(4, mixed, 'delivered'), true)
    assert.equal(lineHasPieces(4, mixed, 'notDelivered'), true)
    assert.equal(lineHasPieces(4, mixed, 'sent'), true)
    assert.equal(lineHasPieces(4, mixed, 'returned'), true)
  })

  it('leaves a fully delivered line out of Not Delivered, Sent and Returned', () => {
    assert.equal(lineHasPieces(4, pieces(4), 'notDelivered'), false)
    assert.equal(lineHasPieces(4, pieces(4), 'sent'), false)
    assert.equal(lineHasPieces(4, pieces(4), 'returned'), false)
  })

  it('reads delivered pieces at no more than the line carries', () => {
    // Two lines of one model share an uncapped figure.
    assert.equal(lineHasPieces(2, pieces(5), 'notDelivered'), false)
    assert.equal(lineHasPieces(4, pieces(0), 'delivered'), false)
  })

  it('keeps every line when no card is pressed', () => {
    assert.equal(lineHasPieces(4, pieces(0), 'all'), true)
  })
})

describe('gatePassColumnValue', () => {
  it('reads a row as the sheet draws it, a blank as null', () => {
    assert.equal(gatePassColumnValue('tripDate', RECORD, FRIDGE, 'Unlinked'), '2026-09-09')
    assert.equal(gatePassColumnValue('unit', RECORD, FRIDGE, 'Unlinked'), null)
    assert.equal(gatePassColumnValue('qty', RECORD, FRIDGE, 'Unlinked'), 4)
    assert.equal(gatePassColumnValue('delivery', RECORD, FRIDGE, 'Returned'), 'Returned')
  })
})
