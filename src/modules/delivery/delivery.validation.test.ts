import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  challanCandidatesQuerySchema,
  createTripSchema,
  listTripsQuerySchema,
  quickDriverSchema,
  updateTripSchema,
} from './delivery.validation'

/**
 * What a trip request may and may not carry.
 *
 * The refusals matter more than the acceptances: a request must not be able to
 * name a vendor, a trip number, a status or what a challan line ordered,
 * because every one of those is the server's to decide.
 */

const VEHICLE = 'a'.repeat(24)
const DRIVER = 'b'.repeat(24)
const CHALLAN = 'c'.repeat(24)

function challanEntry(overrides: Record<string, unknown> = {}) {
  return {
    challanId: CHALLAN,
    customerName: 'ABC Electronics',
    deliveryAddress: 'House 12, Road 3, Mirpur',
    receiverMobile: '+8801712-345678',
    lines: [{ sourceIndex: 0, productName: 'Refrigerator', model: 'WFN-1D5', qty: 2 }],
    ...overrides,
  }
}

function trip(overrides: Record<string, unknown> = {}) {
  return {
    submissionKey: 'key-1234567890',
    vehicleId: VEHICLE,
    driverId: DRIVER,
    tripDate: '2026-09-11',
    challans: [challanEntry()],
    ...overrides,
  }
}

describe('createTripSchema', () => {
  it('accepts a trip and normalises the receiver number', () => {
    const parsed = createTripSchema.parse(trip())

    assert.equal(parsed.challans[0].receiverMobile, '01712345678')
    assert.equal(parsed.acknowledgeOverage, false)
    assert.equal(parsed.tripDate.toISOString(), '2026-09-11T00:00:00.000Z')
  })

  it('strips a vendor, a number and a status rather than trusting them', () => {
    const parsed = createTripSchema.parse(
      trip({ vendorId: DRIVER, tripNumber: 'V-0001-TRIP-9999', status: 'Delivered' }),
    ) as Record<string, unknown>

    assert.equal('vendorId' in parsed, false)
    assert.equal('tripNumber' in parsed, false)
    assert.equal('status' in parsed, false)
  })

  it('never takes what a challan line ordered from the request', () => {
    const parsed = createTripSchema.parse(
      trip({
        challans: [
          challanEntry({
            lines: [
              {
                sourceIndex: 0,
                source: { productName: 'Refrigerator', model: 'WFN-1D5', qty: 40 },
                productName: 'Refrigerator',
                model: 'WFN-1D5',
                qty: 40,
              },
            ],
          }),
        ],
      }),
    )

    assert.equal('source' in parsed.challans[0].lines[0], false)
  })

  it('refuses the same challan twice on one trip', () => {
    assert.throws(() => createTripSchema.parse(trip({ challans: [challanEntry(), challanEntry()] })))
  })

  it('refuses an empty trip and an empty challan', () => {
    assert.throws(() => createTripSchema.parse(trip({ challans: [] })))
    assert.throws(() => createTripSchema.parse(trip({ challans: [challanEntry({ lines: [] })] })))
  })

  it('refuses a zero or fractional quantity', () => {
    for (const qty of [0, 1.5, -1]) {
      assert.throws(() =>
        createTripSchema.parse(
          trip({
            challans: [
              challanEntry({ lines: [{ sourceIndex: 0, productName: 'A', model: 'B', qty }] }),
            ],
          }),
        ),
      )
    }
  })

  it('accepts a line the challan never listed', () => {
    const parsed = createTripSchema.parse(
      trip({
        challans: [
          challanEntry({
            lines: [{ sourceIndex: null, productName: 'Stand', model: 'ST-1', qty: 1 }],
          }),
        ],
      }),
    )

    assert.equal(parsed.challans[0].lines[0].sourceIndex, null)
  })

  it('needs a submission key so a second press can be recognised', () => {
    assert.throws(() => createTripSchema.parse(trip({ submissionKey: undefined })))
  })

  it('refuses a date that is not a calendar day', () => {
    assert.throws(() => createTripSchema.parse(trip({ tripDate: '11/09/2026' })))
  })
})

describe('updateTripSchema', () => {
  it('carries no submission key', () => {
    const parsed = updateTripSchema.parse(trip()) as Record<string, unknown>

    assert.equal('submissionKey' in parsed, false)
  })
})

describe('quickDriverSchema', () => {
  const driver = {
    vehicleId: VEHICLE,
    name: 'Karim Mia',
    mobile: '01812345678',
  }

  it('names the vehicle, never the vendor', () => {
    const parsed = quickDriverSchema.parse({ ...driver, vendorId: DRIVER }) as Record<
      string,
      unknown
    >

    assert.equal(parsed.vehicleId, VEHICLE)
    assert.equal('vendorId' in parsed, false)
  })

  it('refuses a status — a driver added to drive a trip is Active', () => {
    assert.throws(() => quickDriverSchema.parse({ ...driver, status: 'On Leave' }))
  })

  it("keeps the fleet form's licence rule", () => {
    assert.throws(() => quickDriverSchema.parse({ ...driver, licenseExpiry: '2027-01-01' }))
  })
})

describe('challanCandidatesQuerySchema', () => {
  it('splits a list of ids and checks each one', () => {
    assert.deepEqual(challanCandidatesQuerySchema.parse({ ids: `${CHALLAN},${VEHICLE}` }).ids, [
      CHALLAN,
      VEHICLE,
    ])
    assert.throws(() => challanCandidatesQuerySchema.parse({ ids: 'nope' }))
  })
})

describe('listTripsQuerySchema', () => {
  it('refuses a range that runs backwards', () => {
    assert.throws(() => listTripsQuerySchema.parse({ from: '2026-09-11', to: '2026-09-01' }))
  })
})
