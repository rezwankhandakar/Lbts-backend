import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createGatePassSchema,
  duplicateQuerySchema,
  listGatePassesQuerySchema,
  reviewGatePassSchema,
  submitGatePassSchema,
  suggestionQuerySchema,
} from './gate-pass.validation'

/**
 * The request contract, exercised against the values that actually arrive off
 * a Walton challan. These run without a database or a network: everything here
 * is a pure function of its input, which is exactly why it is worth testing.
 */

const VALID = {
  tripDo: '3667398-5090414',
  tripDate: '2026-09-01',
  csd: 'csd-04',
  unit: 'wfr',
  customerName: 'Fashion Step Limited',
  vehicleNo: 'DHAKA METRO-NA-15-1469',
  items: [{ productName: 'Walton Beverage Cooler', model: 'WBQ-4D0-GTCE-HX', qty: 2 }],
  referenceType: 'None' as const,
  zone: '',
  po: '',
}

/** The first message Zod reports for a given field path. */
function issueFor(error: unknown, path: string): string | undefined {
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues ?? []
  return issues.find((issue) => issue.path.join('.') === path)?.message
}

describe('createGatePassSchema', () => {
  it('accepts a gate pass copied off a challan', () => {
    const parsed = createGatePassSchema.parse(VALID)

    assert.equal(parsed.tripDo, '3667398-5090414')
    assert.equal(parsed.customerName, 'Fashion Step Limited')
    assert.equal(parsed.items[0].qty, 2)
  })

  it('normalises the depot and unit codes but never the typed identifiers', () => {
    const parsed = createGatePassSchema.parse(VALID)

    // Codes are a closed vocabulary, so case is noise.
    assert.equal(parsed.csd, 'CSD-04')
    assert.equal(parsed.unit, 'WFR')

    // These are transcribed from paper and must survive verbatim, spaces and
    // punctuation included.
    assert.equal(parsed.vehicleNo, 'DHAKA METRO-NA-15-1469')
    assert.equal(parsed.items[0].model, 'WBQ-4D0-GTCE-HX')
  })

  it('stores the trip date at UTC midnight', () => {
    const parsed = createGatePassSchema.parse(VALID)

    assert.ok(parsed.tripDate instanceof Date)
    assert.equal(parsed.tripDate.toISOString(), '2026-09-01T00:00:00.000Z')
  })

  it('keeps only the date part of a full timestamp', () => {
    const parsed = createGatePassSchema.parse({
      ...VALID,
      tripDate: '2026-09-01T16:09:20.000Z',
    })

    assert.equal(parsed.tripDate.toISOString(), '2026-09-01T00:00:00.000Z')
  })

  it('rejects a malformed date', () => {
    const result = createGatePassSchema.safeParse({ ...VALID, tripDate: '01-09-2026' })

    assert.equal(result.success, false)
    assert.equal(issueFor(result.error, 'tripDate'), 'Enter a valid date.')
  })

  it('rejects a quantity that is zero, negative or fractional', () => {
    for (const qty of [0, -1, 1.5]) {
      const result = createGatePassSchema.safeParse({
        ...VALID,
        items: [{ ...VALID.items[0], qty }],
      })
      assert.equal(result.success, false, `qty ${qty}`)
    }
  })

  it('coerces a quantity that arrives as a string', () => {
    const parsed = createGatePassSchema.parse({
      ...VALID,
      items: [{ ...VALID.items[0], qty: '2' }],
    })
    assert.equal(parsed.items[0].qty, 2)
  })

  it('requires a value for whichever reference type was chosen', () => {
    const zone = createGatePassSchema.safeParse({ ...VALID, referenceType: 'Zone' })
    assert.equal(zone.success, false)
    assert.equal(issueFor(zone.error, 'zone'), 'Enter the zone.')

    const po = createGatePassSchema.safeParse({ ...VALID, referenceType: 'PO' })
    assert.equal(po.success, false)
    assert.equal(issueFor(po.error, 'po'), 'Enter the PO number.')
  })

  it('accepts a reference once its value is supplied', () => {
    const parsed = createGatePassSchema.parse({ ...VALID, referenceType: 'Zone', zone: 'CSD-07' })
    assert.equal(parsed.referenceType, 'Zone')
    assert.equal(parsed.zone, 'CSD-07')
  })

  it('has no path to status, so a crafted body cannot set one', () => {
    const parsed = createGatePassSchema.parse({ ...VALID, status: 'Verified' })
    assert.equal('status' in parsed, false)
  })

  it('requires every trip field', () => {
    for (const field of [
      'tripDo',
      'csd',
      'unit',
      'customerName',
      'vehicleNo',
    ]) {
      const result = createGatePassSchema.safeParse({ ...VALID, [field]: '' })
      assert.equal(result.success, false, `${field} should be required`)
    }
  })
})

describe('product rows', () => {
  /** The two halves of an air conditioner, as one challan actually lists them. */
  const TWO_ROWS = [
    { productName: 'WALTON Ceiling Type Air Conditioner', model: 'WFI-Freddo-48Z Indoor', qty: 1 },
    { productName: 'WALTON Ceiling Type Air Conditioner', model: 'WFI-Freddo-48Z Outdoor', qty: 1 },
  ]

  it('accepts several product lines on one gate pass', () => {
    const parsed = createGatePassSchema.parse({ ...VALID, items: TWO_ROWS })

    assert.equal(parsed.items.length, 2)
    assert.equal(parsed.items[1].model, 'WFI-Freddo-48Z Outdoor')
  })

  it('refuses a gate pass carrying nothing', () => {
    const result = createGatePassSchema.safeParse({ ...VALID, items: [] })

    assert.equal(result.success, false)
    assert.equal(issueFor(result.error, 'items'), 'Add at least one product')
  })

  it('reports the row that is wrong, not just that something is', () => {
    const result = createGatePassSchema.safeParse({
      ...VALID,
      items: [VALID.items[0], { ...VALID.items[0], model: '' }],
    })

    assert.equal(result.success, false)
    // Path points at the second row's model, which is what the form needs to
    // put the message beside the right box.
    assert.equal(issueFor(result.error, 'items.1.model'), 'Model is required')
  })

  it('requires every field on every row', () => {
    for (const field of ['productName', 'model'] as const) {
      const result = createGatePassSchema.safeParse({
        ...VALID,
        items: [{ ...VALID.items[0], [field]: '' }],
      })
      assert.equal(result.success, false, `${field} should be required`)
    }
  })

  it('caps how many rows one gate pass can carry', () => {
    const tooMany = Array.from({ length: 51 }, () => VALID.items[0])
    assert.equal(createGatePassSchema.safeParse({ ...VALID, items: tooMany }).success, false)
  })
})

describe('reviewGatePassSchema', () => {
  it('refuses a rejection with no explanation', () => {
    const result = reviewGatePassSchema.safeParse({ status: 'Rejected' })

    assert.equal(result.success, false)
    assert.equal(issueFor(result.error, 'note'), 'Say what needs correcting.')
  })

  it('accepts a rejection that says what to fix', () => {
    const parsed = reviewGatePassSchema.parse({ status: 'Rejected', note: 'Vehicle number differs' })
    assert.equal(parsed.note, 'Vehicle number differs')
  })

  it('accepts a verification with no note', () => {
    assert.equal(reviewGatePassSchema.parse({ status: 'Verified' }).status, 'Verified')
  })

  it('will not accept a lifecycle state that is not a review outcome', () => {
    assert.equal(reviewGatePassSchema.safeParse({ status: 'Draft' }).success, false)
    assert.equal(reviewGatePassSchema.safeParse({ status: 'Submitted' }).success, false)
  })
})

describe('submitGatePassSchema', () => {
  it('defaults to not having acknowledged a duplicate', () => {
    assert.equal(submitGatePassSchema.parse({}).acknowledgeDuplicate, false)
  })
})

describe('listGatePassesQuerySchema', () => {
  it('applies safe defaults for an empty query', () => {
    const parsed = listGatePassesQuerySchema.parse({})

    assert.equal(parsed.page, 1)
    assert.equal(parsed.limit, 10)
    assert.equal(parsed.status, 'all')
  })

  it('caps the page size so a crafted query cannot ask for the collection', () => {
    assert.equal(listGatePassesQuerySchema.safeParse({ limit: 5000 }).success, false)
  })

  it('rejects a date range that runs backwards', () => {
    const result = listGatePassesQuerySchema.safeParse({ from: '2026-09-10', to: '2026-09-01' })

    assert.equal(result.success, false)
    assert.equal(issueFor(result.error, 'to'), 'The end date is before the start date.')
  })

  it('accepts one open-ended bound', () => {
    assert.equal(listGatePassesQuerySchema.safeParse({ from: '2026-09-01' }).success, true)
    assert.equal(listGatePassesQuerySchema.safeParse({ to: '2026-09-01' }).success, true)
  })

  it('rejects a createdBy that is not an ObjectId', () => {
    assert.equal(listGatePassesQuerySchema.safeParse({ createdBy: 'me' }).success, false)
  })
})

describe('duplicateQuerySchema', () => {
  it('tolerates a partly filled form, because the probe runs while typing', () => {
    const parsed = duplicateQuerySchema.parse({ tripDo: '5044181' })

    assert.equal(parsed.tripDo, '5044181')
    assert.equal(parsed.tripDate, '')
    assert.equal(parsed.excludeId, '')
  })
})

describe('suggestionQuerySchema', () => {
  it('accepts the fields the entry form offers type-ahead for', () => {
    for (const field of ['customerName', 'vehicleNo', 'productName', 'model'] as const) {
      assert.equal(suggestionQuerySchema.safeParse({ field, q: 'ba' }).success, true, field)
    }
  })

  it('refuses a field name it was not built for', () => {
    // The endpoint reads distinct values out of the collection, so an open
    // field name would let a caller enumerate any column it liked.
    assert.equal(suggestionQuerySchema.safeParse({ field: 'statusNote', q: 'ab' }).success, false)
    assert.equal(suggestionQuerySchema.safeParse({ field: 'createdBy', q: 'ab' }).success, false)
  })

  it('waits for two characters before offering anything', () => {
    assert.equal(suggestionQuerySchema.safeParse({ field: 'customerName', q: 'b' }).success, false)
    assert.equal(suggestionQuerySchema.safeParse({ field: 'customerName', q: 'ba' }).success, true)
  })
})
