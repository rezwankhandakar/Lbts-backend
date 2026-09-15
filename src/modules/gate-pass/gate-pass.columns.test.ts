import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  gatePassColumnValue,
  lineConditions,
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

describe('gatePassColumnValue', () => {
  it('reads a row as the sheet draws it, a blank as null', () => {
    assert.equal(gatePassColumnValue('tripDate', RECORD, FRIDGE, 'Unlinked'), '2026-09-09')
    assert.equal(gatePassColumnValue('unit', RECORD, FRIDGE, 'Unlinked'), null)
    assert.equal(gatePassColumnValue('qty', RECORD, FRIDGE, 'Unlinked'), 4)
    assert.equal(gatePassColumnValue('delivery', RECORD, FRIDGE, 'Returned'), 'Returned')
  })
})
