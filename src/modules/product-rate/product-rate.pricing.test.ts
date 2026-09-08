import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Rate } from './product-rate.constants'
import { lineAmount, priceLines, totalOf } from './product-rate.pricing'

/**
 * The rate arithmetic.
 *
 * The flat cases are here to pin the obvious, but the tiered ones are why this
 * file exists. "Ek challan e prothom 5 pics 60, porer gulo 24 kore" is a rule
 * about a *challan*, not about a row, and the two ways of getting it wrong are
 * both invisible afterwards: giving every line its own allowance undercharges,
 * and charging the higher figure for everything overcharges. Neither shows up
 * on the printed sheet, because the rate is not on it.
 */

const FLAT: Rate = { kind: 'flat', amount: 650 }
/** Iron, as the supplied rate card writes it in the ISD column. */
const IRON_ISD: Rate = { kind: 'tiered', firstQty: 5, firstAmount: 60, restAmount: 24 }

describe('lineAmount', () => {
  it('multiplies a flat rate by the quantity', () => {
    assert.equal(lineAmount(FLAT, 4), 2600)
  })

  it('charges nothing for a line with no pieces on it', () => {
    assert.equal(lineAmount(FLAT, 0), 0)
    assert.equal(lineAmount(IRON_ISD, 0), 0)
  })

  it('charges a tiered rate entirely at the first figure inside the allowance', () => {
    assert.equal(lineAmount(IRON_ISD, 5), 300)
    assert.equal(lineAmount(IRON_ISD, 3), 180)
  })

  it('charges the remainder of a tiered rate at the second figure', () => {
    // 5 x 60 + 7 x 24
    assert.equal(lineAmount(IRON_ISD, 12), 468)
  })

  it('spends whatever is left of an allowance and no more', () => {
    // Three already priced, so two at 60 and four at 24.
    assert.equal(lineAmount(IRON_ISD, 6, 3), 216)
  })

  it('charges everything at the second figure once the allowance is gone', () => {
    assert.equal(lineAmount(IRON_ISD, 4, 5), 96)
    assert.equal(lineAmount(IRON_ISD, 4, 900), 96)
  })
})

describe('priceLines', () => {
  it('prices independent flat lines without interfering', () => {
    const amounts = priceLines([
      { rateId: 'fridge', rate: FLAT, qty: 2 },
      { rateId: 'fridge', rate: FLAT, qty: 1 },
    ])

    assert.deepEqual(amounts, [1300, 650])
  })

  it('spends one tiered allowance across every line of the same rate row', () => {
    const amounts = priceLines([
      { rateId: 'iron', rate: IRON_ISD, qty: 3 },
      { rateId: 'iron', rate: IRON_ISD, qty: 3 },
    ])

    // Six irons on one challan: 5 x 60 + 1 x 24, however they are split.
    assert.deepEqual(amounts, [180, 144])
    assert.equal(amounts[0]! + amounts[1]!, lineAmount(IRON_ISD, 6))
  })

  it('gives each rate row its own allowance', () => {
    const kettle: Rate = { kind: 'tiered', firstQty: 5, firstAmount: 60, restAmount: 30 }

    const amounts = priceLines([
      { rateId: 'iron', rate: IRON_ISD, qty: 5 },
      { rateId: 'kettle', rate: kettle, qty: 5 },
    ])

    assert.deepEqual(amounts, [300, 300])
  })

  it('leaves a line that matched no rate row unpriced', () => {
    const amounts = priceLines([
      { rateId: null, rate: null, qty: 9 },
      { rateId: 'fridge', rate: FLAT, qty: 1 },
    ])

    assert.deepEqual(amounts, [null, 650])
  })
})

describe('totalOf', () => {
  it('adds up what was priced and counts what was not', () => {
    assert.deepEqual(totalOf([1300, null, 650]), { total: 1950, unpriced: 1 })
  })

  /**
   * The distinction the rest of the system depends on: a challan nobody could
   * price is not a challan that costs nothing. A zero total would be a figure
   * a report could add up.
   */
  it('reports no total at all when nothing could be priced', () => {
    assert.deepEqual(totalOf([null, null]), { total: null, unpriced: 2 })
  })

  it('reports no total for a challan with no lines', () => {
    assert.deepEqual(totalOf([]), { total: null, unpriced: 0 })
  })
})
