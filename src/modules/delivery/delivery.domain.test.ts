import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registrationKey } from '../vendor/vendor.constants'
import {
  DELIVERY_READ_ROLES,
  DELIVERY_WRITE_ROLES,
  TRIP_STATUSES,
  asciiDigits,
  banglaDigits,
  canManageAnyTrip,
  carryingTotalOf,
  comparePlates,
  completionMethodFor,
  dispatchStatusFor,
  driverTripBlocker,
  formatTripNumber,
  maxReceivedCopyBytesFor,
  plateMatch,
  plateSearchKey,
  returnFlowFor,
  tripCounterKey,
  tripIsEditable,
  tripStatusFor,
  vehicleTripBlocker,
} from './delivery.constants'

/**
 * The Delivery vocabulary, tested as decisions: which vehicles and drivers may
 * run, how a plate search is read, how a trip is numbered and which way it may
 * move.
 */

describe('plate search', () => {
  it('reads every way of typing the same plate as one key', () => {
    const keys = ['1234', 'ta 1234', 'TA-1234', 'ta1234'].map(plateSearchKey)

    assert.deepEqual(keys, ['1234', 'TA1234', 'TA1234', 'TA1234'])
  })

  it('uses the key the fleet is stored under', () => {
    // The vehicle collection's registrationNoKey is registrationKey(); a
    // search that normalised differently would find nothing.
    const plate = 'DHAKA METRO-TA-11-1234'

    assert.equal(plateSearchKey(plate), registrationKey(plate))
  })

  it('turns Bangla digits into the ASCII the key keeps', () => {
    assert.equal(asciiDigits('১২৩৪'), '1234')
    assert.equal(plateSearchKey('ঢাকা মেট্রো-ট ১১-১২৩৪'), '111234')
  })

  it('turns ASCII digits back into Bangla ones', () => {
    assert.equal(banglaDigits('1234'), '১২৩৪')
    assert.equal(asciiDigits(banglaDigits('0987654321')), '0987654321')
  })

  it('ranks a plate ending with the digits above one containing them', () => {
    const key = plateSearchKey('1234')

    assert.equal(plateMatch(plateSearchKey('DHAKA METRO-TA-11-1234'), key), 'tail')
    assert.equal(plateMatch(plateSearchKey('DHAKA METRO-TA-12-3456'), key), 'contains')
    assert.equal(plateMatch('1234', key), 'exact')
    assert.equal(plateMatch(plateSearchKey('DHAKA METRO-GA-99-8765'), key), null)
  })

  it('orders tail matches first and then alphabetically', () => {
    const key = plateSearchKey('1234')
    const plates = ['DHAKA METRO-TA-12-3456', 'DHAKA METRO-TA-11-1234', 'CHATTA METRO-GA-11-1234']
      .map((label) => ({ key: plateSearchKey(label), label }))
      .sort((a, b) => comparePlates(a, b, key))
      .map((plate) => plate.label)

    assert.deepEqual(plates, [
      'CHATTA METRO-GA-11-1234',
      'DHAKA METRO-TA-11-1234',
      'DHAKA METRO-TA-12-3456',
    ])
  })
})

describe('eligibility', () => {
  it('lets only an Active vehicle under an Active vendor run', () => {
    assert.equal(vehicleTripBlocker('Active', 'Active'), null)
  })

  it('refuses every stopped vehicle, whatever its vendor', () => {
    for (const status of ['Inactive', 'Under Maintenance', 'Suspended', 'Expired'] as const) {
      assert.match(vehicleTripBlocker(status, 'Active') ?? '', new RegExp(status))
    }
  })

  it('refuses a working vehicle whose vendor has stopped', () => {
    for (const status of ['Pending', 'Inactive', 'Suspended'] as const) {
      assert.match(vehicleTripBlocker('Active', status) ?? '', /vendor/)
    }
  })

  it('lets only an Active driver drive', () => {
    assert.equal(driverTripBlocker('Active'), null)
    for (const status of ['Inactive', 'Suspended', 'On Leave'] as const) {
      assert.notEqual(driverTripBlocker(status), null)
    }
  })
})

describe('dispatchStatusFor', () => {
  const at = (ordered: number, dispatched: number, trips: number, everyTripCompleted = false) =>
    dispatchStatusFor({ ordered, dispatched, trips, everyTripCompleted })

  it('is Pending for a challan no trip carries', () => {
    assert.equal(at(4, 0, 0), 'Pending')
  })

  it('is Pending even for an empty challan nobody has taken', () => {
    assert.equal(at(0, 0, 0), 'Pending')
  })

  it('is Partial while something is still to go', () => {
    assert.equal(at(4, 2, 1), 'Partial')
  })

  it('stays Partial when every trip so far has been signed for', () => {
    // The half that is waiting has not been delivered by anybody.
    assert.equal(at(4, 2, 1, true), 'Partial')
  })

  it('is Dispatched once everything has left the gate', () => {
    assert.equal(at(4, 4, 1), 'Dispatched')
    assert.equal(at(4, 2 + 2, 2), 'Dispatched')
  })

  it('is Delivered only when every trip carrying it has a signed copy in', () => {
    assert.equal(at(4, 4, 2, true), 'Delivered')
    assert.equal(at(4, 4, 2, false), 'Dispatched')
  })

  it('does not read more than ordered as anything less than sent', () => {
    // A correction raises the challan to what went, so this is transient —
    // but it must never read as Partial while it lasts.
    assert.equal(at(4, 6, 1), 'Dispatched')
  })
})

describe('returnFlowFor', () => {
  const trip = (delivered: number, returned = 0) => ({ delivered, returned })

  it('reports nothing for a challan nothing came back off', () => {
    assert.deepEqual(returnFlowFor([]), { returnedQty: 0, resentQty: 0 })
    assert.deepEqual(returnFlowFor([trip(4), trip(2)]), { returnedQty: 0, resentQty: 0 })
  })

  it('holds a full return at the depot until another trip takes it', () => {
    assert.deepEqual(returnFlowFor([trip(0, 11)]), { returnedQty: 11, resentQty: 0 })
    assert.deepEqual(returnFlowFor([trip(0, 11), trip(11)]), { returnedQty: 11, resentQty: 11 })
  })

  it('counts only the returned pieces a later lorry carries as re-sent', () => {
    // Trip one took 5 of 11 and 2 came back; trip two took the other 6 and the 2.
    assert.deepEqual(returnFlowFor([trip(3, 2), trip(8)]), { returnedQty: 2, resentQty: 2 })
  })

  it('never counts what went before the return as re-sent', () => {
    assert.deepEqual(returnFlowFor([trip(4), trip(1, 3)]), { returnedQty: 3, resentQty: 0 })
  })

  it('does not let a trip re-send what came back off itself', () => {
    assert.deepEqual(returnFlowFor([trip(1, 3)]), { returnedQty: 3, resentQty: 0 })
  })

  it('follows goods that come back twice without counting them twice', () => {
    // Four pieces, out and back twice: only ever four on the shelf.
    const twice = returnFlowFor([trip(0, 4), trip(0, 4)])
    assert.deepEqual(twice, { returnedQty: 8, resentQty: 4 })
    assert.equal(twice.returnedQty - twice.resentQty, 4)

    assert.deepEqual(returnFlowFor([trip(0, 4), trip(0, 4), trip(4)]), {
      returnedQty: 8,
      resentQty: 8,
    })
  })
})

describe('numbering', () => {
  it("writes a trip number as the vendor's code and its own serial", () => {
    assert.equal(formatTripNumber('V-0007', 12), 'V-0007-TRIP-0012')
  })

  it('grows a digit rather than wrapping past 9999', () => {
    assert.equal(formatTripNumber('V-0001', 12345), 'V-0001-TRIP-12345')
  })

  it('counts each vendor separately', () => {
    assert.notEqual(tripCounterKey('a'), tripCounterKey('b'))
  })
})

describe('lifecycle', () => {
  const signed = { completedAt: new Date() }
  const waiting = { completedAt: null }

  it('is Open while any challan on it is still waiting to be signed for', () => {
    assert.equal(tripStatusFor([signed, waiting]), 'Open')
    assert.equal(tripStatusFor([waiting]), 'Open')
  })

  it('is Completed once every challan has been signed for', () => {
    assert.equal(tripStatusFor([signed, signed]), 'Completed')
  })

  it('completes a delivery on its signed copy, a full return, or a declared lost copy', () => {
    const base = { hasCopy: false, copyMissing: false, carried: 8, returned: 0 }

    assert.equal(completionMethodFor(base), null)
    assert.equal(completionMethodFor({ ...base, hasCopy: true }), 'SignedCopy')
    assert.equal(completionMethodFor({ ...base, returned: 8 }), 'Returned')
    assert.equal(completionMethodFor({ ...base, copyMissing: true }), 'CopyMissing')
  })

  it('still wants a copy when only part came back', () => {
    // Somebody took the other six, and somebody signed for them.
    assert.equal(
      completionMethodFor({ hasCopy: false, copyMissing: false, carried: 8, returned: 2 }),
      null,
    )
  })

  it('prefers the evidence over a full return or an excuse', () => {
    assert.equal(
      completionMethodFor({ hasCopy: true, copyMissing: true, carried: 8, returned: 8 }),
      'SignedCopy',
    )
  })

  it('never calls a line nothing carried a full return', () => {
    assert.equal(
      completionMethodFor({ hasCopy: false, copyMissing: false, carried: 0, returned: 0 }),
      null,
    )
  })

  it('does not call an empty trip finished', () => {
    // The schema refuses one, and "nothing to do" is not "done" — the same
    // reasoning that makes a challan with no lines Unpriced rather than Charged.
    assert.equal(tripStatusFor([]), 'Open')
  })

  it('keeps the manifest fixed once every receiver has signed', () => {
    assert.deepEqual(TRIP_STATUSES.filter(tripIsEditable), ['Open'])
  })
})

describe('completing a delivery', () => {
  it('adds up what the last few metres cost', () => {
    assert.equal(carryingTotalOf([{ amount: 300 }, { amount: 150 }]), 450)
    assert.equal(carryingTotalOf([]), 0)
  })

  it('counts a charge of nothing as a charge all the same', () => {
    // A helper who carried two boxes up for free is worth recording; the
    // entry exists, and its amount is zero.
    assert.equal(carryingTotalOf([{ amount: 0 }]), 0)
  })

  it('gives a scanned PDF more room than a photograph', () => {
    assert.equal(maxReceivedCopyBytesFor('application/pdf'), 25 * 1024 * 1024)
    assert.equal(maxReceivedCopyBytesFor('image/jpeg'), 10 * 1024 * 1024)
  })
})

describe('permissions', () => {
  it('keeps Vendor out of a module that carries customer addresses', () => {
    assert.equal(DELIVERY_READ_ROLES.includes('Vendor'), false)
    assert.equal(DELIVERY_WRITE_ROLES.includes('Vendor'), false)
  })

  it('gives every other role the whole module', () => {
    for (const role of ['Admin', 'Manager', 'CEO', 'OpEx'] as const) {
      assert.equal(DELIVERY_READ_ROLES.includes(role), true)
      assert.equal(DELIVERY_WRITE_ROLES.includes(role), true)
    }
  })

  it('scopes nobody to their own trips any more', () => {
    assert.equal(canManageAnyTrip('Admin'), true)
    assert.equal(canManageAnyTrip('Manager'), true)
    assert.equal(canManageAnyTrip('OpEx'), true)
    assert.equal(canManageAnyTrip('CEO'), true)
    assert.equal(canManageAnyTrip('Vendor'), false)
  })
})
