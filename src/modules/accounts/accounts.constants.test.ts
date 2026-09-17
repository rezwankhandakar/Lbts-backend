import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cashFlowOf,
  entryDirection,
  fiscalYearOf,
  formatEntryNumber,
  requiresCashWallet,
  marginOf,
  monthsBetween,
  outstandingOf,
  periodKey,
  periodRange,
  profitOf,
  settlementStatusFor,
  tripBillOf,
  vendorBillStatusFor,
  vendorDueOf,
} from './accounts.constants'

describe('entryDirection', () => {
  it('sends deposits and cash returned from an advance into a wallet', () => {
    assert.equal(entryDirection('Deposit'), 'In')
    assert.equal(entryDirection('AdvanceReturn'), 'In')
  })

  it('takes every payment, expense and advance out of a wallet', () => {
    for (const kind of ['Expense', 'Advance', 'TripAdvance', 'VendorPayment'] as const) {
      assert.equal(entryDirection(kind), 'Out')
    }
  })

  it('moves no cash when an advance is accepted as an expense', () => {
    assert.equal(entryDirection('AdvanceAdjust'), 'None')
    assert.equal(entryDirection('Transfer'), 'Transfer')
  })
})

describe('cashFlowOf', () => {
  const none = { deposits: 0, transfersIn: 0, advanceReturns: 0, vendorPayments: 0, tripAdvances: 0, advances: 0, expenses: 0, transfersOut: 0 }

  it('takes an advance return off money out instead of adding it to money in', () => {
    const flow = cashFlowOf({ ...none, deposits: 10000, advances: 3000, advanceReturns: 500 })
    assert.equal(flow.moneyIn, 10000)
    assert.equal(flow.advancesNet, 2500)
    assert.equal(flow.moneyOut, 2500)
    assert.equal(flow.net, 7500)
  })

  it('brings money out back to nothing when an advance is returned in full', () => {
    const flow = cashFlowOf({ ...none, deposits: 5000, advances: 3000, advanceReturns: 3000 })
    assert.equal(flow.moneyOut, 0)
    assert.equal(flow.net, 5000)
  })

  it('adds every payment and expense to money out', () => {
    const flow = cashFlowOf({ ...none, vendorPayments: 20000, tripAdvances: 3000, expenses: 1500 })
    assert.equal(flow.moneyOut, 24500)
    assert.equal(flow.net, -24500)
  })
})

describe('requiresCashWallet', () => {
  it('runs every transaction through cash', () => {
    for (const kind of ['Deposit', 'Transfer', 'Expense', 'Advance', 'AdvanceReturn', 'TripAdvance', 'VendorPayment'] as const) {
      assert.equal(requiresCashWallet(kind, false), true)
    }
  })

  it('lets a Walton payment against a final bill arrive in a bank or mobile wallet', () => {
    assert.equal(requiresCashWallet('Deposit', true), false)
  })

  it('keeps a bank wallet out of everything else, even when a final bill is somehow named', () => {
    assert.equal(requiresCashWallet('Expense', true), true)
    assert.equal(requiresCashWallet('Transfer', true), true)
  })
})

describe('formatEntryNumber', () => {
  it('prefixes by kind and pads the sequence to five digits', () => {
    assert.equal(formatEntryNumber('Expense', 2026, 42), 'EXP-2026-00042')
    assert.equal(formatEntryNumber('VendorPayment', 2027, 1), 'VPY-2027-00001')
  })
})

describe('settlementStatusFor', () => {
  it('is open until something is settled, partial until all of it is', () => {
    assert.equal(settlementStatusFor(5000, 0), 'Open')
    assert.equal(settlementStatusFor(5000, 2000), 'Partial')
    assert.equal(settlementStatusFor(5000, 5000), 'Settled')
  })

  it('never reports a negative outstanding amount', () => {
    assert.equal(outstandingOf(5000, 2000), 3000)
    assert.equal(outstandingOf(5000, 6000), 0)
  })
})

describe('vendor trip bills', () => {
  it('owes the bills less the trip advances less the payments', () => {
    assert.equal(vendorDueOf({ totalBill: 50000, advance: 8000, paid: 20000 }), 22000)
  })

  it('has no bill when nothing was entered and nothing paid', () => {
    assert.equal(vendorBillStatusFor({ totalBill: 0, advance: 0, paid: 0 }), 'No Bill')
  })

  it('reads unpaid, partial and paid off what is settled', () => {
    assert.equal(vendorBillStatusFor({ totalBill: 10000, advance: 0, paid: 0 }), 'Unpaid')
    assert.equal(vendorBillStatusFor({ totalBill: 10000, advance: 2000, paid: 0 }), 'Partial')
    assert.equal(vendorBillStatusFor({ totalBill: 10000, advance: 2000, paid: 8000 }), 'Paid')
  })

  it('is overpaid when an advance was given before the bill was entered', () => {
    assert.equal(vendorBillStatusFor({ totalBill: 0, advance: 3000, paid: 0 }), 'Overpaid')
    assert.equal(vendorDueOf({ totalBill: 0, advance: 3000, paid: 0 }), -3000)
  })

  it('counts a blank rent or labour bill as nothing', () => {
    assert.equal(tripBillOf(12000, null), 12000)
    assert.equal(tripBillOf(null, undefined), 0)
    assert.equal(tripBillOf(12000, 1500), 13500)
  })
})

describe('periods', () => {
  it('lists every month across a year boundary, inclusive', () => {
    const months = monthsBetween({ year: 2026, month: 11 }, { year: 2027, month: 2 }).map(periodKey)
    assert.deepEqual(months, ['2026-11', '2026-12', '2027-01', '2027-02'])
  })

  it('lists nothing when the range runs backwards', () => {
    assert.deepEqual(monthsBetween({ year: 2026, month: 5 }, { year: 2026, month: 4 }), [])
  })

  it('bounds a month at UTC midnight on the first of it and of the next', () => {
    const { start, end } = periodRange({ year: 2026, month: 12 })
    assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z')
    assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z')
  })

  it('puts July onward in the fiscal year that starts that July', () => {
    assert.deepEqual(fiscalYearOf({ year: 2026, month: 9 }), {
      from: { year: 2026, month: 7 },
      to: { year: 2027, month: 6 },
    })
    assert.deepEqual(fiscalYearOf({ year: 2026, month: 3 }), {
      from: { year: 2025, month: 7 },
      to: { year: 2026, month: 6 },
    })
  })
})

describe('profit and loss', () => {
  const figures = { income: 200000, tripRent: 90000, labourBill: 15000, officeExpense: 35000 }

  it('takes trip costs and office expenses off the final bills', () => {
    assert.equal(profitOf(figures), 60000)
    assert.equal(marginOf(figures), 30)
  })

  it('reports a loss as a negative profit', () => {
    assert.equal(profitOf({ ...figures, income: 100000 }), -40000)
  })

  it('has no margin without income', () => {
    assert.equal(marginOf({ ...figures, income: 0 }), null)
  })
})
