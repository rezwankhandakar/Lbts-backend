import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  gatePassLineDeliveredQty,
  gatePassLinePieces,
  gatePassProductStatusFor,
  gatePassStatusOfLines,
  lineHeldQty,
  lineRoomFor,
  orderRowStatusFor,
  returnedPiecesReusedQty,
  rowAmountFor,
  rowsCarryingReturns,
} from './trip-do.constants'
import { ledgerSourcesFor, planBulkLink, reconcileRows } from './trip-do.ledger'
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
    tripNumber: `TRIP-${id}`,
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
    assert.deepEqual(order.tripNumbers, ['TRIP-1', 'TRIP-2'])
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

describe('ledgerSourcesFor delivery status', () => {
  const SMALL = { productName: 'Air Conditioner', model: 'WCI-Cordelia-18M' }
  const LARGE = { productName: 'Air Conditioner', model: 'WCI-Hexacomb-48D' }

  const statusOf = (sources: ReturnType<typeof ledgerSourcesFor>, model: string, kind = 'Order') =>
    sources.find((source) => source.kind === kind && source.model === model)?.deliveryStatus

  it('reads an order row off its own product, never the rest of the challan', () => {
    // One piece delivered, the other product out and all of it back: the challan
    // is Partial, but the delivered product is not.
    const sources = ledgerSourcesFor(
      'c1',
      [
        { ...SMALL, qty: 1 },
        { ...LARGE, qty: 2 },
      ],
      [
        {
          id: '1',
          tripNumber: 'TRIP-1',
          completed: true,
          lines: [
            { ...SMALL, qty: 1 },
            { ...LARGE, qty: 2 },
          ],
          returned: [{ ...LARGE, qty: 2 }],
        },
      ],
    )

    assert.equal(statusOf(sources, SMALL.model), 'Delivered')
    assert.equal(statusOf(sources, LARGE.model), 'Returned')
    assert.equal(statusOf(sources, LARGE.model, 'Return'), 'Returned')
  })

  it('leaves a product on no trip Pending while another product on the challan has gone', () => {
    const sources = ledgerSourcesFor(
      'c1',
      [
        { ...SMALL, qty: 1 },
        { ...LARGE, qty: 2 },
      ],
      [{ id: '1', tripNumber: 'TRIP-1', completed: false, lines: [{ ...SMALL, qty: 1 }], returned: [] }],
    )

    assert.equal(statusOf(sources, SMALL.model), 'Dispatched')
    assert.equal(statusOf(sources, LARGE.model), 'Pending')
  })

  it('reads a product split across trips as Partial until the rest has gone', () => {
    const [order] = ledgerSourcesFor('c1', [{ ...FRIDGE, qty: 4 }], [trip('1', [{ qty: 2 }], [], true)])
    assert.equal(order.deliveryStatus, 'Partial')
  })

  it('waits for every trip carrying the product before calling it Delivered', () => {
    const [order] = ledgerSourcesFor(
      'c1',
      [{ ...FRIDGE, qty: 4 }],
      [trip('1', [{ qty: 2 }], [], true), trip('2', [{ qty: 2 }], [], false)],
    )
    assert.equal(order.deliveryStatus, 'Dispatched')
  })

  it('reads a re-send by its own trip', () => {
    const sources = ledgerSourcesFor(
      'c1',
      [{ ...FRIDGE, qty: 2 }],
      [trip('1', [{ qty: 2 }], [{ qty: 2 }], true), trip('2', [{ qty: 2 }], [], false)],
    )
    assert.equal(statusOf(sources, FRIDGE.model, 'Resent'), 'Dispatched')
    assert.equal(statusOf(sources, FRIDGE.model), 'Dispatched')
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

describe('a gate pass line’s room, once goods come back', () => {
  const order = (challanId: string, qty: number) => ({ challanId, kind: 'Order', qty })
  const back = (challanId: string, qty: number) => ({ challanId, kind: 'Return', qty })
  const resent = (challanId: string, qty: number) => ({ challanId, kind: 'Resent', qty })

  it('gives a linked return’s pieces back to the line', () => {
    assert.equal(lineHeldQty([order('c1', 2)]), 2)
    assert.equal(lineHeldQty([order('c1', 2), back('c1', 2)]), 0)
    assert.equal(lineHeldQty([order('c1', 3), back('c1', 1)]), 2)
  })

  it('lets another challan take the returned pieces', () => {
    assert.equal(lineRoomFor(2, [order('c1', 2)], 'c2'), 0)
    assert.equal(lineRoomFor(2, [order('c1', 2), back('c1', 2)], 'c2'), 2)
    assert.equal(lineHeldQty([order('c1', 2), back('c1', 2), order('c2', 2)]), 2)
  })

  it('counts a re-send as taking its pieces off the line again', () => {
    assert.equal(lineHeldQty([order('c1', 2), back('c1', 2), resent('c1', 2)]), 2)
    assert.equal(lineRoomFor(2, [order('c1', 2), back('c1', 2), order('c2', 2)], 'c1'), 0)
    assert.equal(lineRoomFor(2, [order('c1', 2), back('c1', 2)], 'c1'), 2)
  })

  it('frees only what the return’s own challan took off the line', () => {
    // A return linked where its challan drew nothing makes no room for anybody else.
    assert.equal(lineHeldQty([order('c2', 2), back('c1', 2)]), 2)
    assert.equal(lineRoomFor(2, [order('c2', 2), back('c1', 2)], 'c3'), 0)
    // And a partial one frees only its own pieces.
    assert.equal(lineHeldQty([order('c1', 1), back('c1', 2), order('c2', 1)]), 1)
  })

  it('reads Returned only while the returned pieces are still on the shelf', () => {
    const rows = [
      { challanId: 'c1', kind: 'Order', deliveryStatus: 'Returned', qty: 2 },
      { challanId: 'c1', kind: 'Return', deliveryStatus: 'Returned', qty: 2 },
    ]
    assert.equal(gatePassProductStatusFor(rows, 2), 'Returned')

    // Another challan taking them is a re-send, until it is signed for.
    const taken = [...rows, { challanId: 'c2', kind: 'Order', deliveryStatus: 'Dispatched', qty: 2 }]
    assert.equal(gatePassProductStatusFor(taken, 2), 'Resent')
    assert.equal(
      gatePassProductStatusFor([...rows, { challanId: 'c2', kind: 'Order', deliveryStatus: 'Delivered', qty: 2 }], 2),
      'Delivered',
    )
  })

  it('still reads Returned where the line has room the other challan did not need', () => {
    const rows = [
      { challanId: 'c1', kind: 'Order', deliveryStatus: 'Returned', qty: 2 },
      { challanId: 'c1', kind: 'Return', deliveryStatus: 'Returned', qty: 2 },
      { challanId: 'c2', kind: 'Order', deliveryStatus: 'Dispatched', qty: 2 },
    ]
    assert.equal(gatePassProductStatusFor(rows, 5), 'Returned')
  })

  it('reads a whole gate pass line by line, so one line’s room never hides another’s return', () => {
    const shelf = {
      qty: 2,
      rows: [
        { challanId: 'c1', kind: 'Order', deliveryStatus: 'Returned', qty: 2 },
        { challanId: 'c1', kind: 'Return', deliveryStatus: 'Returned', qty: 2 },
        { challanId: 'c2', kind: 'Order', deliveryStatus: 'Delivered', qty: 2 },
      ],
    }
    const other = { qty: 3, rows: [{ challanId: 'c3', kind: 'Order', deliveryStatus: 'Delivered', qty: 1 }] }
    assert.equal(gatePassStatusOfLines([shelf, other]), 'Delivered')
    assert.equal(gatePassStatusOfLines([{ qty: 2, rows: [] }]), 'Unlinked')
  })

  it('tags the row that went out on returned pieces Re-sent, and only that row', () => {
    const at = (id: string, challanId: string, kind: string, qty: number, linkedAt: number) => ({
      id,
      challanId,
      kind,
      qty,
      linkedAt,
    })
    const line = [at('o1', 'c1', 'Order', 2, 1), at('r1', 'c1', 'Return', 2, 2)]

    assert.equal(returnedPiecesReusedQty(line, 2), 0)
    assert.deepEqual([...rowsCarryingReturns([...line, at('o2', 'c2', 'Order', 2, 3)], 2)], [['o2', 2]])
  })

  it('tags nobody while the line still had untouched pieces to give', () => {
    const line = [
      { id: 'o1', challanId: 'c1', kind: 'Order', qty: 2, linkedAt: 1 },
      { id: 'r1', challanId: 'c1', kind: 'Return', qty: 2, linkedAt: 2 },
      { id: 'o2', challanId: 'c2', kind: 'Order', qty: 2, linkedAt: 3 },
    ]
    assert.equal(rowsCarryingReturns(line, 5).size, 0)
    // The next row is the one that can only have taken returned pieces.
    assert.deepEqual(
      [...rowsCarryingReturns([...line, { id: 'o3', challanId: 'c3', kind: 'Order', qty: 3, linkedAt: 4 }], 5)],
      [['o3', 2]],
    )
  })

  it('never tags the returning challan’s own order, and stops at what came back', () => {
    const line = [
      { id: 'o2', challanId: 'c2', kind: 'Order', qty: 3, linkedAt: 2 },
      { id: 'o1', challanId: 'c1', kind: 'Order', qty: 2, linkedAt: 9 },
      { id: 'r1', challanId: 'c1', kind: 'Return', qty: 1, linkedAt: 3 },
    ]
    assert.deepEqual([...rowsCarryingReturns(line, 4)], [['o2', 1]])
  })

  it('counts a re-send by the returning challan as its own, not another challan’s', () => {
    const line = [
      { challanId: 'c1', kind: 'Order', qty: 2 },
      { challanId: 'c1', kind: 'Return', qty: 2 },
      { challanId: 'c1', kind: 'Resent', qty: 2 },
    ]
    assert.equal(returnedPiecesReusedQty(line, 2), 0)
  })

  it('counts what the other challan delivered, the return taken off', () => {
    const rows = [
      { challanId: 'c1', kind: 'Order', deliveryStatus: 'Returned', qty: 2, lineQty: 2, firstDeliveredQty: 2 },
      { challanId: 'c1', kind: 'Return', deliveryStatus: 'Returned', qty: 2 },
    ]
    assert.equal(gatePassLineDeliveredQty(2, rows), 0)
    assert.equal(
      gatePassLineDeliveredQty(2, [
        ...rows,
        { challanId: 'c2', kind: 'Order', deliveryStatus: 'Delivered', qty: 2, lineQty: 2, firstDeliveredQty: 2 },
      ]),
      2,
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

  it('adds a linked re-send back once its own copy is in, so Not Delivered comes down again', () => {
    const rows = [
      order,
      { kind: 'Return', deliveryStatus: 'Returned', qty: 2 },
      { kind: 'Resent', deliveryStatus: 'Delivered', qty: 2 },
    ]
    assert.equal(gatePassLineDeliveredQty(4, rows), 4)
  })

  it('leaves a re-send still on the road out of Delivered', () => {
    const rows = [
      order,
      { kind: 'Return', deliveryStatus: 'Returned', qty: 2 },
      { kind: 'Resent', deliveryStatus: 'Dispatched', qty: 2 },
    ]
    assert.equal(gatePassLineDeliveredQty(4, rows), 2)
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

  it('counts what left the gate the first time whether or not the copy is in', () => {
    const [order] = ledgerSourcesFor(
      'c1',
      [{ ...FRIDGE, qty: 5 }],
      [trip('1', [{ qty: 3 }], [{ qty: 1 }], true), trip('2', [{ qty: 2 }])],
    )
    // Trip 2 re-sends the one returned piece and takes one more out first time.
    assert.equal(order.firstDispatchedQty, 4)
    assert.equal(order.firstDeliveredQty, 3)
  })
})

describe('gatePassLinePieces', () => {
  const order = (firstDispatchedQty: number, firstDeliveredQty: number) => ({
    kind: 'Order',
    deliveryStatus: 'Partial',
    qty: 4,
    lineQty: 4,
    firstDispatchedQty,
    firstDeliveredQty,
  })
  const back = (qty: number) => ({ kind: 'Return', deliveryStatus: 'Returned', qty })
  const resent = (qty: number, deliveryStatus = 'Dispatched') => ({ kind: 'Resent', deliveryStatus, qty })

  it('reads pieces out with no signed copy as Sent', () => {
    assert.deepEqual(gatePassLinePieces(4, [order(4, 0)]), { delivered: 0, sent: 4, returned: 0 })
  })

  it('reads signed-for pieces as Delivered and nothing else', () => {
    assert.deepEqual(gatePassLinePieces(4, [order(4, 4)]), { delivered: 4, sent: 0, returned: 0 })
  })

  it('reads pieces back off a lorry as Returned, whether or not that trip has closed', () => {
    assert.deepEqual(gatePassLinePieces(4, [order(4, 4), back(2)]), { delivered: 2, sent: 0, returned: 2 })
    assert.deepEqual(gatePassLinePieces(4, [order(4, 0), back(2)]), { delivered: 0, sent: 2, returned: 2 })
  })

  it('moves re-sent pieces from Returned to Sent, and to Delivered once signed for', () => {
    assert.deepEqual(
      gatePassLinePieces(4, [order(4, 4), back(2), resent(2)]),
      { delivered: 2, sent: 2, returned: 0 },
    )
    assert.deepEqual(
      gatePassLinePieces(4, [order(4, 4), back(2), resent(2, 'Delivered')]),
      { delivered: 4, sent: 0, returned: 0 },
    )
  })

  it('leaves pieces that never left the gate in no bucket', () => {
    assert.deepEqual(gatePassLinePieces(4, [order(2, 0)]), { delivered: 0, sent: 2, returned: 0 })
    assert.deepEqual(gatePassLinePieces(4, []), { delivered: 0, sent: 0, returned: 0 })
  })

  it('never counts a returned piece another challan has taken out again', () => {
    // A's two came back and B's order went out on them.
    const rows = [
      { ...order(2, 2), qty: 2, lineQty: 2 },
      back(2),
      { ...order(2, 0), qty: 2, lineQty: 2, challanId: 'b' },
    ]
    assert.deepEqual(gatePassLinePieces(2, rows), { delivered: 0, sent: 2, returned: 0 })
  })

  it('reads a row written before the figure existed by its status', () => {
    const legacy = { ...order(0, 0), firstDispatchedQty: null, firstDeliveredQty: null, deliveryStatus: 'Dispatched' }
    assert.deepEqual(gatePassLinePieces(4, [legacy]), { delivered: 0, sent: 4, returned: 0 })
  })
})

describe('a bulk link of fewer pieces than were ticked', () => {
  it('takes every row whole when the pieces cover them', () => {
    assert.deepEqual(planBulkLink([6, 10, 10], 26), [6, 10, 10])
  })

  it('splits the row the pieces run out on, in the order listed', () => {
    assert.deepEqual(planBulkLink([10, 10, 6], 25), [10, 10, 5])
  })

  it('leaves rows after that one as they were', () => {
    assert.deepEqual(planBulkLink([6, 10, 10], 8), [6, 2, 0])
    assert.deepEqual(planBulkLink([6, 10, 10], 6), [6, 0, 0])
  })

  it('never links more than a row carries, however many are asked for', () => {
    assert.deepEqual(planBulkLink([3, 4], 99), [3, 4])
  })

  it('links nothing for nothing', () => {
    assert.deepEqual(planBulkLink([3, 4], 0), [0, 0])
    assert.deepEqual(planBulkLink([3, 4], -2), [0, 0])
  })
})
