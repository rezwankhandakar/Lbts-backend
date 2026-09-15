import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  gatePassLineDeliveredQty,
  gatePassProductStatusFor,
  orderRowStatusFor,
  rowAmountFor,
} from './trip-do.constants'
import { ledgerSourcesFor, reconcileRows } from './trip-do.ledger'
import type { LedgerRowState, LedgerTrip } from './trip-do.ledger'

/**
 * What the Trip DO sheet holds for a challan, and how stored rows are brought
 * back in line with it. Tested as decisions: which rows exist, which Trip DOs
 * survive a correction, and where the goods are said to be.
 */

const FRIDGE = { productName: 'Refrigerator', model: 'WFE-2H2-GDEN' }

function trip(
  id: string,
  lines: { qty: number }[],
  returned: { qty: number }[] = [],
  completed = false,
): LedgerTrip {
  return {
    id,
    tripNumber: `V-0001-TRIP-${id}`,
    completed,
    lines: lines.map((line) => ({ ...FRIDGE, qty: line.qty })),
    returned: returned.map((line) => ({ ...FRIDGE, qty: line.qty })),
  }
}

describe('ledgerSourcesFor', () => {
  it('gives every challan line one order source, keyed by product rather than position', () => {
    const sources = ledgerSourcesFor(
      'c1',
      [FRIDGE, { productName: 'Stand', model: 'ST-1' }].map((item, index) => ({
        ...item,
        qty: index + 2,
      })),
      [],
    )

    assert.equal(sources.length, 2)
    assert.deepEqual(
      sources.map((source) => [source.kind, source.qty, source.position]),
      [
        ['Order', 2, 0],
        ['Order', 3, 1],
      ],
    )
    assert.equal(sources[0].sourceKey, 'c1|O|REFRIGERATOR|WFE2H2GDEN|0')
  })

  it('keeps an order key when a correction moves the line to another position', () => {
    const before = ledgerSourcesFor('c1', [{ ...FRIDGE, qty: 5 }], [])
    const after = ledgerSourcesFor(
      'c1',
      [
        { productName: 'Stand', model: 'ST-1', qty: 1 },
        { ...FRIDGE, qty: 5 },
      ],
      [],
    )

    assert.equal(after[1].sourceKey, before[0].sourceKey)
  })

  it('names the trips that carried an order line', () => {
    const [order] = ledgerSourcesFor('c1', [{ ...FRIDGE, qty: 5 }], [trip('1', [{ qty: 3 }]), trip('2', [{ qty: 2 }])])
    assert.deepEqual(order.tripNumbers, ['V-0001-TRIP-1', 'V-0001-TRIP-2'])
  })

  it('adds a return row for pieces that came back, and a re-sent row when a later trip takes them', () => {
    const sources = ledgerSourcesFor(
      'c1',
      [{ ...FRIDGE, qty: 5 }],
      [trip('1', [{ qty: 5 }], [{ qty: 2 }], true), trip('2', [{ qty: 2 }], [], false)],
    )

    assert.deepEqual(
      sources.map((source) => [source.kind, source.qty, source.tripId]),
      [
        ['Order', 5, null],
        ['Return', 2, '1'],
        ['Resent', 2, '2'],
      ],
    )
  })

  it('never counts more as re-sent than was on the depot shelf', () => {
    const sources = ledgerSourcesFor(
      'c1',
      [{ ...FRIDGE, qty: 6 }],
      [trip('1', [{ qty: 4 }], [{ qty: 1 }]), trip('2', [{ qty: 3 }])],
    )

    const resent = sources.find((source) => source.kind === 'Resent')
    assert.equal(resent?.qty, 1)
  })

  it('does not re-send what came back off the same trip', () => {
    const sources = ledgerSourcesFor('c1', [{ ...FRIDGE, qty: 4 }], [trip('1', [{ qty: 4 }], [{ qty: 4 }])])
    assert.equal(sources.some((source) => source.kind === 'Resent'), false)
  })

  it('orders a line’s rows: the order, then each trip’s re-send before its return', () => {
    const sources = ledgerSourcesFor(
      'c1',
      [{ ...FRIDGE, qty: 5 }],
      [trip('1', [{ qty: 5 }], [{ qty: 2 }]), trip('2', [{ qty: 2 }], [{ qty: 1 }])],
    )

    const sorted = [...sources].sort((a, b) => a.rowSeq - b.rowSeq)
    assert.deepEqual(
      sorted.map((source) => `${source.kind}:${source.tripId ?? '-'}`),
      ['Order:-', 'Return:1', 'Resent:2', 'Return:2'],
    )
  })
})

function row(id: string, qty: number, linked = false, splitIndex = 0, sourceKey = 's'): LedgerRowState {
  return { id, sourceKey, qty, linked, splitIndex }
}

describe('reconcileRows with billed rows', () => {
  it('takes a reduction from a linked row before one that is on a bill', () => {
    const plan = reconcileRows(
      [{ sourceKey: 's', qty: 3 }],
      [{ ...row('a', 3, true), billed: true }, row('b', 2, true, 1)],
    )
    assert.deepEqual(plan.remove, ['b'])
    assert.deepEqual(plan.setQty, [])
  })
})

describe('reconcileRows', () => {
  it('opens one unlinked row for a new source', () => {
    const plan = reconcileRows([{ sourceKey: 's', qty: 5 }], [])
    assert.deepEqual(plan.create, [{ sourceKey: 's', qty: 5, splitIndex: 0 }])
    assert.deepEqual(plan.remove, [])
  })

  it('leaves a split alone when the source has not changed', () => {
    const plan = reconcileRows([{ sourceKey: 's', qty: 5 }], [row('a', 3, true), row('b', 2, false, 1)])
    assert.deepEqual(plan, { create: [], setQty: [], remove: [] })
  })

  it('puts extra pieces on the unlinked part rather than a linked one', () => {
    const plan = reconcileRows([{ sourceKey: 's', qty: 7 }], [row('a', 3, true), row('b', 2, false, 1)])
    assert.deepEqual(plan.setQty, [{ id: 'b', qty: 4 }])
  })

  it('opens a new part for extra pieces when every part is linked', () => {
    const plan = reconcileRows([{ sourceKey: 's', qty: 6 }], [row('a', 3, true), row('b', 2, true, 1)])
    assert.deepEqual(plan.create, [{ sourceKey: 's', qty: 1, splitIndex: 2 }])
  })

  it('takes a reduction from unlinked parts before touching a Trip DO', () => {
    const plan = reconcileRows([{ sourceKey: 's', qty: 3 }], [row('a', 3, true), row('b', 2, false, 1)])
    assert.deepEqual(plan.remove, ['b'])
    assert.deepEqual(plan.setQty, [])
  })

  it('reduces linked parts, newest first, only once nothing unlinked is left', () => {
    const plan = reconcileRows([{ sourceKey: 's', qty: 2 }], [row('a', 3, true), row('b', 2, true, 1)])
    assert.deepEqual(plan.remove, ['b'])
    assert.deepEqual(plan.setQty, [{ id: 'a', qty: 2 }])
  })

  it('removes every row of a source that is gone', () => {
    const plan = reconcileRows([], [row('a', 3, true), row('b', 2, false, 1)])
    assert.deepEqual(plan.remove.sort(), ['a', 'b'])
  })
})

describe('row status and money', () => {
  it('reads a pending challan whose goods came back as Returned', () => {
    assert.equal(orderRowStatusFor({ dispatchStatus: 'Pending', returnedQty: 2, resentQty: 0 }), 'Returned')
    assert.equal(orderRowStatusFor({ dispatchStatus: 'Pending', returnedQty: 2, resentQty: 2 }), 'Pending')
    assert.equal(orderRowStatusFor({ dispatchStatus: 'Delivered' }), 'Delivered')
  })

  it('shares a line’s charge between its parts', () => {
    assert.equal(rowAmountFor(1000, 5, 3), 600)
    assert.equal(rowAmountFor(1000, 5, 2), 400)
    assert.equal(rowAmountFor(null, 5, 2), null)
    assert.equal(rowAmountFor(1000, 0, 2), null)
  })

  it('says a gate pass line is only as delivered as its slowest linked row', () => {
    const orders = (...statuses: string[]) =>
      statuses.map((deliveryStatus) => ({ kind: 'Order', deliveryStatus, qty: 1 }))

    assert.equal(gatePassProductStatusFor([]), 'Unlinked')
    assert.equal(gatePassProductStatusFor(orders('Delivered', 'Delivered')), 'Delivered')
    assert.equal(gatePassProductStatusFor(orders('Delivered', 'Dispatched')), 'Dispatched')
    assert.equal(gatePassProductStatusFor(orders('Delivered', 'Pending')), 'Partial')
    assert.equal(gatePassProductStatusFor(orders('Returned', 'Pending')), 'Returned')
    assert.equal(gatePassProductStatusFor(orders('Pending')), 'Pending')
  })

  it('reads Returned while a linked return has not gone out again, then Re-sent', () => {
    const order = { kind: 'Order', deliveryStatus: 'Partial', qty: 4 }
    const back = { kind: 'Return', deliveryStatus: 'Returned', qty: 2 }

    assert.equal(gatePassProductStatusFor([order, back]), 'Returned')
    assert.equal(
      gatePassProductStatusFor([order, back, { kind: 'Resent', deliveryStatus: 'Dispatched', qty: 2 }]),
      'Resent',
    )
    assert.equal(
      gatePassProductStatusFor([
        { ...order, deliveryStatus: 'Delivered' },
        back,
        { kind: 'Resent', deliveryStatus: 'Delivered', qty: 2 },
      ]),
      'Delivered',
    )
  })
})

describe('gatePassLineDeliveredQty', () => {
  const order = { kind: 'Order', deliveryStatus: 'Partial', qty: 4, lineQty: 4, firstDeliveredQty: 4 }

  it('counts what went out the first time on a completed trip', () => {
    assert.equal(gatePassLineDeliveredQty(4, [order]), 4)
    assert.equal(gatePassLineDeliveredQty(4, [{ ...order, firstDeliveredQty: 0 }]), 0)
  })

  it('takes a linked return off, so Not Delivered shows it', () => {
    assert.equal(gatePassLineDeliveredQty(4, [order, { kind: 'Return', deliveryStatus: 'Returned', qty: 2 }]), 2)
  })

  it('adds a linked re-send back, so Not Delivered comes down again', () => {
    const rows = [
      order,
      { kind: 'Return', deliveryStatus: 'Returned', qty: 2 },
      { kind: 'Resent', deliveryStatus: 'Dispatched', qty: 2 },
    ]
    assert.equal(gatePassLineDeliveredQty(4, rows), 4)
  })

  it('shares a line between its split parts and never leaves the line', () => {
    assert.equal(gatePassLineDeliveredQty(4, [{ ...order, qty: 2, firstDeliveredQty: 2 }]), 1)
    assert.equal(gatePassLineDeliveredQty(4, [{ kind: 'Return', deliveryStatus: 'Returned', qty: 3 }]), 0)
    assert.equal(gatePassLineDeliveredQty(3, [order]), 3)
  })

  it('reads a row written before the figure existed by its status', () => {
    assert.equal(
      gatePassLineDeliveredQty(4, [{ ...order, firstDeliveredQty: null, deliveryStatus: 'Delivered' }]),
      4,
    )
  })
})

describe('first delivery on an order line', () => {
  it('counts pieces out the first time on completed trips, returns included and re-sends not', () => {
    const [order] = ledgerSourcesFor(
      'c1',
      [{ ...FRIDGE, qty: 4 }],
      [trip('1', [{ qty: 4 }], [{ qty: 2 }], true), trip('2', [{ qty: 2 }], [], true)],
    )
    assert.equal(order.firstDeliveredQty, 4)
  })

  it('waits for the trip to complete', () => {
    const [order] = ledgerSourcesFor('c1', [{ ...FRIDGE, qty: 4 }], [trip('1', [{ qty: 4 }])])
    assert.equal(order.firstDeliveredQty, 0)
  })
})
