import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { columnFilterClause, parseRateKey } from './trip-do.columns'

/**
 * Which rows a column's ticked values keep. Tested as the query each tick
 * produces, because a blank that matched nothing — or everything — is the
 * mistake a filter dropdown makes quietly.
 */

describe('columnFilterClause', () => {
  it('is no filter when nothing is ticked', () => {
    assert.equal(columnFilterClause('customer', []), null)
  })

  it('keeps the ticked values of a plain column', () => {
    assert.deepEqual(columnFilterClause('customer', ['Arif', 'Karim']), {
      customerName: { $in: ['Arif', 'Karim'] },
    })
  })

  it('treats (Blanks) as null, empty and missing alike', () => {
    assert.deepEqual(columnFilterClause('csd', ['CSD-01', null]), {
      $or: [{ 'link.csd': { $in: ['CSD-01'] } }, { 'link.csd': { $in: [null, ''] } }],
    })
  })

  it('reads a blank trip column as a row on no trip', () => {
    assert.deepEqual(columnFilterClause('trip', [null]), { tripNumbers: { $size: 0 } })
  })

  it('turns ticked days into whole UTC days', () => {
    assert.deepEqual(columnFilterClause('date', ['2026-09-09']), {
      challanDate: {
        $gte: new Date('2026-09-09T00:00:00.000Z'),
        $lt: new Date('2026-09-10T00:00:00.000Z'),
      },
    })
  })

  it('matches nothing rather than everything when every value is unreadable', () => {
    assert.deepEqual(columnFilterClause('rate', ['nonsense']), { _id: { $exists: false } })
  })
})

describe('parseRateKey', () => {
  it('reads a flat and a tiered rate back', () => {
    assert.deepEqual(parseRateKey('flat:1100'), { 'rate.kind': 'flat', 'rate.unitAmount': 1100 })
    assert.deepEqual(parseRateKey('tiered:5:60:24'), {
      'rate.kind': 'tiered',
      'rate.firstQty': 5,
      'rate.firstAmount': 60,
      'rate.restAmount': 24,
    })
    assert.equal(parseRateKey('flat:abc'), null)
  })
})
