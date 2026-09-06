import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LOCATION_TYPES } from './location.constants'
import { LOCATION_SEED } from './location.data'
import { normalizedPair } from './location.model'
import { normalizeLocationName } from './location.normalize'
import {
  createLocationSchema,
  listLocationsQuerySchema,
  resolveLocationSchema,
  setChallanLocationSchema,
  updateLocationSchema,
} from './location.validation'

const VALID = {
  district: 'Dhaka',
  thana: 'Savar',
  locationType: 'OSD-Thana',
  isActive: true,
}

describe('adding a master location', () => {
  it('accepts a district, a thana and one of the three types', () => {
    const parsed = createLocationSchema.parse(VALID)

    assert.equal(parsed.district, 'Dhaka')
    assert.equal(parsed.thana, 'Savar')
    assert.equal(parsed.locationType, 'OSD-Thana')
  })

  it('requires both halves of the pair', () => {
    assert.equal(createLocationSchema.safeParse({ ...VALID, district: '' }).success, false)
    assert.equal(createLocationSchema.safeParse({ ...VALID, thana: '' }).success, false)
  })

  /**
   * The location type is the reason this collection exists. A free-text value
   * would put a fourth kind of place into a system that recognises three, and
   * every report grouping by it would silently grow a column nobody defined.
   */
  it('refuses a location type that is not one of the three', () => {
    for (const bad of ['ISD ', 'isd', 'OSD', 'OSD-Metro-2', 'Other', '']) {
      assert.equal(
        createLocationSchema.safeParse({ ...VALID, locationType: bad }).success,
        false,
        bad,
      )
    }

    for (const good of LOCATION_TYPES) {
      assert.equal(
        createLocationSchema.safeParse({ ...VALID, locationType: good }).success,
        true,
        good,
      )
    }
  })

  it('defaults a new row to active', () => {
    const parsed = createLocationSchema.parse({
      district: 'Dhaka',
      thana: 'Savar',
      locationType: 'OSD-Thana',
    })
    assert.equal(parsed.isActive, true)
  })

  /**
   * The comparison keys are derived by the service, exactly as a challan's
   * `customerNameKey` is. A client that could set one could make a row match
   * something it does not say — the single way this collection could lie.
   */
  it('has no field for the comparison keys', () => {
    const parsed = createLocationSchema.parse({
      ...VALID,
      normalizedDistrict: 'anything',
      normalizedThana: 'anything',
      isSeeded: true,
      createdBy: '65b2f1c3a4d5e6f7a8b9c0d1',
    }) as Record<string, unknown>

    assert.equal(parsed.normalizedDistrict, undefined)
    assert.equal(parsed.normalizedThana, undefined)
    assert.equal(parsed.isSeeded, undefined)
    assert.equal(parsed.createdBy, undefined)
  })
})

describe('correcting a master location', () => {
  it('takes any one field on its own', () => {
    assert.equal(updateLocationSchema.safeParse({ isActive: false }).success, true)
    assert.equal(updateLocationSchema.safeParse({ locationType: 'ISD' }).success, true)
    assert.equal(updateLocationSchema.safeParse({ thana: 'Savar' }).success, true)
  })

  it('refuses a request that changes nothing', () => {
    assert.equal(updateLocationSchema.safeParse({}).success, false)
  })

  it('still refuses an invalid type', () => {
    assert.equal(updateLocationSchema.safeParse({ locationType: 'Zone' }).success, false)
  })
})

describe('duplicate prevention', () => {
  /**
   * Duplicates are refused on the normalised pair rather than the typed one.
   * Two rows for Mirpur would mean every lookup had to choose between them,
   * which is the ambiguity the resolver refuses to guess at — so the ways the
   * same pair can be written all have to collapse to one key.
   */
  it('reduces every spelling of one pair to the same key', () => {
    const canonical = normalizedPair('Dhaka', 'Mirpur Model')

    for (const [district, thana] of [
      ['dhaka', 'mirpur model'],
      ['  DHAKA ', 'Mirpur  Model'],
      ['Dhaka District', 'Mirpur Model Thana'],
      ['Dhaka.', 'Mirpur-Model'],
    ]) {
      assert.deepEqual(normalizedPair(district, thana), canonical, `${district}/${thana}`)
    }
  })

  it('keeps genuinely different pairs apart', () => {
    assert.notDeepEqual(
      normalizedPair('Chandpur', 'Matlab Dakshin'),
      normalizedPair('Chandpur', 'Matlab Uttar'),
    )
    assert.notDeepEqual(
      normalizedPair('Gazipur', 'Kaliganj'),
      normalizedPair('Satkhira', 'Kaliganj'),
    )
  })
})

describe('the supplied master list', () => {
  it('never classifies one pair two different ways', () => {
    const seen = new Map<string, string>()

    for (const group of LOCATION_SEED) {
      for (const thana of group.thanas) {
        const key = `${normalizeLocationName(group.district)}|${normalizeLocationName(thana)}`
        const existing = seen.get(key)

        assert.ok(
          existing === undefined || existing === group.locationType,
          `${group.district} / ${thana} is listed as both ${existing} and ${group.locationType}`,
        )

        seen.set(key, group.locationType)
      }
    }
  })

  it('carries only the three recognised types, and no blank names', () => {
    for (const group of LOCATION_SEED) {
      assert.ok(LOCATION_TYPES.includes(group.locationType), group.locationType)
      assert.ok(group.district.trim().length > 1, group.district)
      assert.ok(group.thanas.length > 0, group.district)

      for (const thana of group.thanas) {
        assert.ok(thana.trim().length > 1, `${group.district} / ${thana}`)
        // A name that normalises to nothing would match every other empty key.
        assert.ok(normalizeLocationName(thana).length > 0, thana)
      }
    }
  })

  it('covers the eight divisions worth of districts', () => {
    const districts = new Set(LOCATION_SEED.map((group) => group.district))

    for (const expected of [
      'Dhaka',
      'Chattogram',
      'Rajshahi',
      'Khulna',
      'Barishal',
      'Sylhet',
      'Rangpur',
      'Mymensingh',
    ]) {
      assert.ok(districts.has(expected), expected)
    }

    assert.ok(districts.size >= 60, `only ${districts.size} districts seeded`)
  })
})

describe('asking what a piece of text resolves to', () => {
  it('carries the three fields that decide a location, and nothing else', () => {
    const parsed = resolveLocationSchema.parse({
      thana: 'Mirpur',
      district: 'Dhaka',
      deliveryAddress: 'House 10, Road 5',
      customerName: 'ABC Electronics Ltd.',
      receiverMobile: '01712345678',
    }) as Record<string, unknown>

    assert.equal(parsed.thana, 'Mirpur')
    // Nothing about the customer is in the schema, so nothing about the
    // customer can reach the request that this endpoint may forward.
    assert.equal(parsed.customerName, undefined)
    assert.equal(parsed.receiverMobile, undefined)
  })

  it('is happy with nothing at all', () => {
    const parsed = resolveLocationSchema.parse({})
    assert.deepEqual(parsed, { thana: '', district: '', deliveryAddress: '' })
  })
})

describe('setting a challan location by hand', () => {
  it('takes an id', () => {
    assert.equal(
      setChallanLocationSchema.parse({ locationId: '65b2f1c3a4d5e6f7a8b9c0d1' }).locationId,
      '65b2f1c3a4d5e6f7a8b9c0d1',
    )
  })

  it('takes null, which clears it back to pending', () => {
    assert.equal(setChallanLocationSchema.parse({ locationId: null }).locationId, null)
  })

  /**
   * The manual path is the one with the most authority in the system, so it is
   * the one that must carry the least. An id, or nothing: every value written
   * to the challan is read from the row it points at.
   */
  it('refuses a district, a thana or a location type in its place', () => {
    for (const bad of [
      { locationId: 'Dhaka/Mirpur' },
      { locationId: '' },
      { district: 'Dhaka', thana: 'Mirpur' },
      { locationId: '65b2f1c3a4d5e6f7a8b9c0d1', locationType: 'ISD' },
    ]) {
      const parsed = setChallanLocationSchema.safeParse(bad)
      const asRecord = parsed.success ? (parsed.data as Record<string, unknown>) : null
      assert.ok(!parsed.success || asRecord?.locationType === undefined, JSON.stringify(bad))
    }

    assert.equal(setChallanLocationSchema.safeParse({ locationId: 'Dhaka' }).success, false)
    assert.equal(setChallanLocationSchema.safeParse({}).success, false)
  })
})

describe('the master list query', () => {
  it('offers a three-way active filter, because finding a deactivated row is a real question', () => {
    assert.equal(listLocationsQuerySchema.parse({}).active, 'all')
    assert.equal(listLocationsQuerySchema.parse({ active: 'inactive' }).active, 'inactive')
    assert.equal(listLocationsQuerySchema.safeParse({ active: 'maybe' }).success, false)
  })

  it('caps the page size', () => {
    assert.equal(listLocationsQuerySchema.safeParse({ limit: '5000' }).success, false)
  })
})
