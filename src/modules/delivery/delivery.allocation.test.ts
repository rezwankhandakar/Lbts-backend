import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  allocateLines,
  classifyLine,
  countChanges,
  drawsOn,
  findOverages,
  progressOf,
  rebuildChallanItems,
  sameItems,
} from './delivery.allocation'
import type { ReservedLine, SourceLine, TripLine } from './delivery.allocation'

/**
 * The arithmetic that keeps a split honest and a correction permanent.
 *
 * Tested as decisions rather than through a database, in the same spirit as
 * `assignment.rules.test.ts`: what has gone out, what is deliberately still to
 * come, and what the challan should say once a trip has run.
 */

const challan: SourceLine[] = [
  { productName: 'Air Conditioner', model: 'WSN-24H', qty: 2 },
  { productName: 'Refrigerator', model: 'WFN-1D5 GDEL', qty: 4 },
]

function drawn(index: number, qty: number, overrides: Partial<TripLine> = {}): TripLine {
  const source = challan[index]
  return {
    sourceIndex: index,
    source,
    productName: source.productName,
    model: source.model,
    qty,
    ...overrides,
  }
}

function added(productName: string, model: string, qty: number): TripLine {
  return { sourceIndex: null, source: null, productName, model, qty }
}

function reserve(index: number, qty: number, tripKey = 'trip-a'): ReservedLine {
  return {
    productName: challan[index].productName,
    model: challan[index].model,
    qty,
    tripKey,
  }
}

/** A trip line that went out and came back, in whole or in part. */
function sentBack(index: number, qty: number, returned: number): TripLine {
  return drawn(index, qty, { returned })
}

describe('allocateLines', () => {
  it('leaves everything remaining when no other trip carries the challan', () => {
    assert.deepEqual(
      allocateLines(challan, []).map((line) => [line.ordered, line.dispatched, line.remaining]),
      [
        [2, 0, 2],
        [4, 0, 4],
      ],
    )
  })

  it('subtracts what other trips carry, line by line', () => {
    const lines = allocateLines(challan, [drawn(1, 2)])

    assert.equal(lines[0].remaining, 2)
    assert.equal(lines[1].dispatched, 2)
    assert.equal(lines[1].remaining, 2)
  })

  it('matches on the product, not the position', () => {
    // The challan was corrected and the refrigerator moved to the first row;
    // the trip that carried two of them still counts against it.
    const reordered = [challan[1], challan[0]]

    assert.equal(allocateLines(reordered, [drawn(1, 2)])[0].dispatched, 2)
  })

  it('does not count a substitute against the line it replaced', () => {
    // A different model went instead. That is a correction to the challan, not
    // a delivery of the model the paper named.
    const lines = allocateLines(challan, [drawn(1, 4, { model: 'WFN-2N5 GDEL' })])

    assert.equal(lines[1].dispatched, 0)
  })

  it('never reports a negative remainder when a line went out over', () => {
    const lines = allocateLines(challan, [drawn(0, 3)])

    assert.equal(lines[0].dispatched, 3)
    assert.equal(lines[0].remaining, 0)
  })

  it('ignores a line the paper never listed', () => {
    assert.deepEqual(
      allocateLines(challan, [added('Stand', 'ST-1', 1)]).map((line) => line.dispatched),
      [0, 0],
    )
  })
})

describe('drawsOn', () => {
  it('reads a product through its spacing and case', () => {
    const line = drawn(1, 1, {
      productName: 'refrigerator',
      model: 'wfn 1d5-gdel',
    })

    assert.equal(drawsOn(line, challan[1]), true)
    assert.equal(drawsOn(line, challan[0]), false)
  })
})

describe('progressOf', () => {
  it('is complete only when every line has gone out', () => {
    assert.equal(progressOf(allocateLines(challan, [drawn(0, 2), drawn(1, 4)])).complete, true)
    assert.equal(progressOf(allocateLines(challan, [drawn(0, 2)])).complete, false)
  })

  it('is partial when something has gone and something has not', () => {
    const progress = progressOf(allocateLines(challan, [drawn(1, 1)]))

    assert.equal(progress.partial, true)
    assert.deepEqual(
      [progress.ordered, progress.dispatched, progress.remaining],
      [6, 1, 5],
    )
  })
})

describe('findOverages', () => {
  it('finds nothing when a split adds up to the order', () => {
    assert.deepEqual(findOverages(challan, [drawn(1, 2)], [drawn(1, 2)]), [])
  })

  it('catches the same challan filed in full on two trips', () => {
    const overages = findOverages(challan, [drawn(1, 4)], [drawn(1, 4)])

    assert.equal(overages.length, 1)
    assert.deepEqual(
      [overages[0].ordered, overages[0].onOtherTrips, overages[0].onThisTrip],
      [4, 4, 4],
    )
  })

  it('catches a quantity raised past the paper on a single trip', () => {
    assert.equal(findOverages(challan, [], [drawn(0, 3)]).length, 1)
  })

  it('says nothing about a line this trip does not carry', () => {
    assert.deepEqual(findOverages(challan, [drawn(0, 5)], [drawn(1, 1)]), [])
  })
})

describe('rebuildChallanItems', () => {
  it('leaves an untouched challan exactly as it was', () => {
    const next = rebuildChallanItems(challan, [drawn(0, 2), drawn(1, 4)], [])

    assert.deepEqual(next, challan)
    assert.equal(sameItems(challan, next), true)
  })

  it('keeps the quantity a split holds back for a later trip', () => {
    // Two refrigerators now, two on the next lorry: the challan still says 4.
    const next = rebuildChallanItems(challan, [drawn(0, 2), drawn(1, 2)], [reserve(1, 2)])

    assert.equal(sameItems(challan, next), true)
  })

  it('cuts the challan to what went when nothing is reserved', () => {
    // Only three existed. The paper becomes three, and there is nothing left
    // for a later trip to collect.
    const next = rebuildChallanItems(challan, [drawn(0, 2), drawn(1, 3)], [])

    assert.deepEqual(next.map((line) => line.qty), [2, 3])
    assert.equal(allocateLines(next, [drawn(1, 3)])[1].remaining, 0)
  })

  it('raises the challan when more went than the paper ordered', () => {
    assert.deepEqual(
      rebuildChallanItems(challan, [drawn(0, 2), drawn(1, 6)], []).map((line) => line.qty),
      [2, 6],
    )
  })

  it('drops a line the trip removed', () => {
    const next = rebuildChallanItems(challan, [drawn(0, 2)], [])

    assert.deepEqual(next, [challan[0]])
  })

  it('replaces a line with the model that stood in for it', () => {
    const next = rebuildChallanItems(
      challan,
      [drawn(0, 2), drawn(1, 4, { model: 'WFN-2N5 GDEL' })],
      [],
    )

    assert.deepEqual(
      next.map((line) => [line.model, line.qty]),
      [
        ['WSN-24H', 2],
        ['WFN-2N5 GDEL', 4],
      ],
    )
  })

  it('keeps both when only part of a line was substituted', () => {
    const next = rebuildChallanItems(
      challan,
      [drawn(1, 1), drawn(1, 3, { model: 'WFN-2N5 GDEL' })],
      [],
    )

    assert.deepEqual(
      next.map((line) => [line.model, line.qty]),
      [
        ['WFN-1D5 GDEL', 1],
        ['WFN-2N5 GDEL', 3],
      ],
    )
  })

  it('appends a product the challan never listed', () => {
    const next = rebuildChallanItems(
      challan,
      [drawn(0, 2), drawn(1, 4), added('Stand', 'ST-1', 1)],
      [],
    )

    assert.equal(next.length, 3)
    assert.deepEqual(next[2], { productName: 'Stand', model: 'ST-1', qty: 1 })
  })

  it('counts every trip carrying the challan, not just the one being saved', () => {
    // Two on the first lorry and two on the second is the whole order.
    const next = rebuildChallanItems(challan, [drawn(0, 2), drawn(1, 2), drawn(1, 2)], [])

    assert.equal(sameItems(challan, next), true)
  })

  it('merges two lines of the same product into one', () => {
    const twice: SourceLine[] = [challan[1], { ...challan[1], qty: 1 }]
    const next = rebuildChallanItems(twice, [drawn(1, 4), drawn(1, 1)], [])

    assert.deepEqual(next, [{ productName: 'Refrigerator', model: 'WFN-1D5 GDEL', qty: 5 }])
  })

  it('empties the challan when a trip carries and reserves nothing of it', () => {
    assert.deepEqual(rebuildChallanItems(challan, [], []), [])
  })
})

describe('classifyLine', () => {
  it('tells a split apart from a cut by what was reserved', () => {
    assert.equal(classifyLine(drawn(1, 2), 2), 'split')
    assert.equal(classifyLine(drawn(1, 2), 0), 'reduced')
  })

  it('names everything else a trip can do to a line', () => {
    assert.equal(classifyLine(drawn(1, 4)), 'as-ordered')
    assert.equal(classifyLine(drawn(1, 6)), 'increased')
    assert.equal(classifyLine(drawn(1, 4, { model: 'WFN-2N5 GDEL' })), 'substituted')
    assert.equal(classifyLine(added('Stand', 'ST', 1)), 'added')
  })

  it('treats the same model written differently as unchanged', () => {
    assert.equal(classifyLine(drawn(1, 4, { model: 'wfn-1d5-gdel' })), 'as-ordered')
  })

  it('counts every line that differs from the paper', () => {
    assert.equal(countChanges([drawn(0, 2), drawn(1, 3)]), 1)
  })
})

describe('sameItems', () => {
  it('ignores how a product was spelled, and nothing else', () => {
    assert.equal(sameItems(challan, [challan[0], { ...challan[1], model: 'wfn 1d5 gdel' }]), true)
    assert.equal(sameItems(challan, [challan[0], { ...challan[1], qty: 3 }]), false)
    assert.equal(sameItems(challan, [challan[0]]), false)
  })
})

/**
 * Goods that went out and came back.
 *
 * A return is the one thing a trip can do to a line *after* the lorry has
 * left, and it is a **retroactive split**: the pieces are released for another
 * trip and the challan is never rewritten. These are the decisions that keep
 * those two halves true, because getting either wrong is invisible — a return
 * counted as delivered leaves a customer's order reading as satisfied, and a
 * return counted as a correction quietly deletes goods they are still owed.
 */
describe('returns', () => {
  it('frees what came back for another trip', () => {
    // Four went out on Tuesday and all four came back: the challan is waiting
    // for a lorry exactly as it was before anybody loaded one.
    const lines = allocateLines(challan, [sentBack(1, 4, 4)])

    assert.deepEqual(
      [lines[1].ordered, lines[1].dispatched, lines[1].remaining],
      [4, 0, 4],
    )
  })

  it('frees only the part that came back', () => {
    const lines = allocateLines(challan, [sentBack(1, 4, 1)])

    assert.deepEqual(
      [lines[1].ordered, lines[1].dispatched, lines[1].remaining],
      [4, 3, 1],
    )
  })

  it('leaves the challan saying what it always said', () => {
    // The whole point. The receiver refused two; the customer still ordered
    // four, and correcting the paper down would lose the two they are owed.
    const next = rebuildChallanItems(
      challan,
      [drawn(0, 2), sentBack(1, 4, 2)],
      [reserve(1, 2)],
    )

    assert.equal(sameItems(challan, next), true)
  })

  it('does not let a second trip stack on top of the hold the first one has', () => {
    // Trip A took four and two came back, so it is holding two. Trip B then
    // carried those two. Adding the two holds together would raise a challan
    // of four to six; the largest single hold is what counts.
    const next = rebuildChallanItems(
      challan,
      [drawn(0, 2), sentBack(1, 4, 2), drawn(1, 2)],
      [reserve(1, 2, 'trip-a')],
    )

    assert.equal(sameItems(challan, next), true)
  })

  it('does not let two splits stack either', () => {
    // The same rule, on the case that has nothing to do with returns: this is
    // an ordinary split collected by a later trip.
    const next = rebuildChallanItems(
      challan,
      [drawn(0, 2), drawn(1, 2), drawn(1, 2)],
      [reserve(1, 2, 'trip-a')],
    )

    assert.deepEqual(next.map((line) => line.qty), [2, 4])
  })

  it('still cuts a line nothing is held against', () => {
    // A return holds a line open. A trim does not, and must still correct the
    // paper down — the distinction the whole module turns on.
    const next = rebuildChallanItems(challan, [drawn(0, 2), drawn(1, 3)], [])

    assert.deepEqual(next.map((line) => line.qty), [2, 3])
  })

  it('cannot raise a challan by holding goods nobody added', () => {
    // A hold restores a line; it never grows one. Four were ordered, four came
    // back, and a hold of four leaves four rather than eight.
    const next = rebuildChallanItems(challan, [sentBack(1, 4, 4)], [reserve(1, 4)])

    assert.deepEqual(
      next.map((line) => [line.productName, line.qty]),
      [['Refrigerator', 4]],
    )
  })

  it('is stable when it is run again', () => {
    // Rebuilding writes the challan, and the next trip rebuilds against what
    // was written. A rule that moved on every pass would drift a record.
    const once = rebuildChallanItems(challan, [drawn(0, 2), sentBack(1, 4, 2)], [reserve(1, 2)])
    const twice = rebuildChallanItems(once, [drawn(0, 2), sentBack(1, 4, 2)], [reserve(1, 2)])

    assert.equal(sameItems(once, twice), true)
  })

  it('does not count returned goods as an overage', () => {
    // Four went out and came back; sending four again is the delivery finally
    // happening, not eight refrigerators leaving the gate.
    assert.deepEqual(findOverages(challan, [sentBack(1, 4, 4)], [drawn(1, 4)]), [])
  })

  it('still asks when more is genuinely going out than was ordered', () => {
    const overages = findOverages(challan, [sentBack(1, 4, 1)], [drawn(1, 4)])

    assert.equal(overages.length, 1)
    assert.deepEqual(
      [overages[0].ordered, overages[0].onOtherTrips, overages[0].onThisTrip],
      [4, 3, 4],
    )
  })
})
