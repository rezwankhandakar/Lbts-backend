import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  arrangeLabourLines,
  formatLabourBillNumber,
  groupLabourLinesByCsd,
  isUnpricedLabourLine,
  lineTotal,
  shortLabourBillNumber,
} from './labour-bill.constants'

describe('lineTotal', () => {
  it('adds the labour cell and the floor cell', () => {
    assert.equal(lineTotal(600, 250), 850)
  })

  it('treats a blank half as nothing once the other half is typed', () => {
    assert.equal(lineTotal(600, null), 600)
    assert.equal(lineTotal(null, 250), 250)
  })

  // The distinction the whole column rests on: a row nobody has priced is not a
  // row charged nothing, and a Total of zero for both would hide the first.
  it('is null while neither cell has been typed, and zero once one says zero', () => {
    assert.equal(lineTotal(null, null), null)
    assert.equal(lineTotal(undefined, undefined), null)
    assert.equal(lineTotal(0, null), 0)
    assert.equal(lineTotal(0, 0), 0)
  })
})

describe('isUnpricedLabourLine', () => {
  it('counts only a row with both cells blank', () => {
    assert.equal(isUnpricedLabourLine({ labourAmount: null, floorAmount: null }), true)
    assert.equal(isUnpricedLabourLine({ labourAmount: 0, floorAmount: null }), false)
    assert.equal(isUnpricedLabourLine({ labourAmount: null, floorAmount: 0 }), false)
  })
})

describe('arrangeLabourLines', () => {
  const line = (challanId: string, seq: number) => ({ challanId, seq })

  it('gives every model of one challan the same SL and spans it from the first row', () => {
    const arranged = arrangeLabourLines([
      line('c1', 1),
      line('c2', 2),
      line('c2', 3),
      line('c2', 4),
      line('c3', 5),
    ])

    assert.deepEqual(
      arranged.map((row) => [row.challanId, row.sl, row.slRowSpan]),
      [
        ['c1', 1, 1],
        ['c2', 2, 3],
        ['c2', 2, 0],
        ['c2', 2, 0],
        ['c3', 3, 1],
      ],
    )
  })

  it('puts a model added later beneath its own challan rather than opening a second SL', () => {
    const arranged = arrangeLabourLines([line('a', 1), line('b', 2), line('a', 3)])

    assert.deepEqual(
      arranged.map((row) => [row.challanId, row.seq, row.sl]),
      [
        ['a', 1, 1],
        ['a', 3, 1],
        ['b', 2, 2],
      ],
    )
  })

  it('numbers challans by when each was first scanned, not by id', () => {
    const arranged = arrangeLabourLines([line('zzz', 1), line('aaa', 2)])
    assert.deepEqual(
      arranged.map((row) => [row.challanId, row.sl]),
      [
        ['zzz', 1],
        ['aaa', 2],
      ],
    )
  })

  it('is empty for an empty sheet', () => {
    assert.deepEqual(arrangeLabourLines([]), [])
  })
})

describe('groupLabourLinesByCsd', () => {
  const line = (csd: string, challanId: string, seq: number) => ({ csd, challanId, seq })

  it('splits the month into one section per CSD, each with its own SL series', () => {
    const groups = groupLabourLinesByCsd([
      line('CSD-02', 'c1', 1),
      line('CSD-01', 'c1', 2),
      line('CSD-02', 'c2', 3),
    ])

    assert.deepEqual(
      groups.map((group) => [group.label, group.lines.map((row) => [row.challanId, row.sl])]),
      [
        ['CSD-01', [['c1', 1]]],
        ['CSD-02', [
          ['c1', 1],
          ['c2', 2],
        ]],
      ],
    )
  })

  // One scan, two sections: this is the case that makes the CSD a property of
  // the row rather than of the slot.
  it('files one challan into two sections when it went out on two gate passes', () => {
    const groups = groupLabourLinesByCsd([line('CSD-01', 'c1', 1), line('CSD-04', 'c1', 2)])
    assert.deepEqual(groups.map((group) => group.label), ['CSD-01', 'CSD-04'])
    assert.equal(groups[0]?.lines.length, 1)
    assert.equal(groups[1]?.lines.length, 1)
  })

  it('keeps rows with no CSD in a pending section, always last', () => {
    const groups = groupLabourLinesByCsd([
      line('', 'c1', 1),
      line('CSD-07', 'c2', 2),
      line('CSD-01', 'c3', 3),
    ])

    assert.deepEqual(groups.map((group) => group.label), ['CSD-01', 'CSD-07', 'Trip DO pending'])
    assert.deepEqual(groups.map((group) => group.isPending), [false, false, true])
  })

  it('reads two spellings of one CSD as one section', () => {
    const groups = groupLabourLinesByCsd([line('CSD-01', 'c1', 1), line('csd 01', 'c2', 2)])
    assert.equal(groups.length, 1)
    assert.equal(groups[0]?.lines.length, 2)
  })

  it('is empty for an empty sheet', () => {
    assert.deepEqual(groupLabourLinesByCsd([]), [])
  })
})

describe('labour bill numbering', () => {
  it('pads to four digits inside the bill’s own year', () => {
    assert.equal(formatLabourBillNumber(2026, 7), 'LBTS-WLB-2026-0007')
    assert.equal(formatLabourBillNumber(2026, 1234), 'LBTS-WLB-2026-1234')
  })

  it('reads short where the year is already on screen, and leaves anything else alone', () => {
    assert.equal(shortLabourBillNumber('LBTS-WLB-2026-0007'), 'WLB-0007')
    assert.equal(shortLabourBillNumber('LBTS-BILL-2026-0007'), 'LBTS-BILL-2026-0007')
  })
})
