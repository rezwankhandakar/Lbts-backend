import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { updateUserRoleSchema } from '../administration/administration.validation'
import {
  createAssignmentSchema,
  createDocumentSchema,
  createDriverSchema,
  createVehicleSchema,
  createVendorSchema,
  listDocumentsQuerySchema,
  listVendorsQuerySchema,
  updateDocumentSchema,
  updateVendorSchema,
} from './vendor.validation'

/**
 * What the API will and will not accept.
 *
 * Two things run through the whole file. Nothing may set a value the server is
 * supposed to derive — a vendor code, a comparison key, a document status — and
 * nothing may name an owner the URL has not already established, because the
 * whole security model of this module is that a vendor comes from one place.
 */

const VENDOR = '000000000000000000000a01'

describe('createVendorSchema', () => {
  it('accepts a vendor and defaults its address to blank', () => {
    const parsed = createVendorSchema.parse({
      name: 'Malek Transport',
      mobile: '01712345678',
    })

    assert.equal(parsed.name, 'Malek Transport')
    assert.equal(parsed.address, '')
    assert.equal(parsed.status, undefined)
  })

  it('has no field for the vendor code or the comparison keys', () => {
    // Allocated and derived by the server. A client that could set a comparison
    // key could make a record match something it does not say.
    const parsed = createVendorSchema.parse({
      name: 'Malek Transport',
      mobile: '01712345678',
      vendorCode: 'V-9999',
      nameKey: 'SOMETHINGELSE',
      mobileKey: '01700000000',
    }) as Record<string, unknown>

    assert.equal('vendorCode' in parsed, false)
    assert.equal('nameKey' in parsed, false)
    assert.equal('mobileKey' in parsed, false)
  })

  it('refuses a mobile number that is not one', () => {
    assert.throws(() => createVendorSchema.parse({ name: 'Malek', mobile: '12345' }))
  })

  it('accepts a number written with a country code or separators', () => {
    for (const mobile of ['+8801712345678', '8801712345678', '01712-345678', '01712 345678']) {
      assert.doesNotThrow(() => createVendorSchema.parse({ name: 'Malek', mobile }), mobile)
    }
  })

  it('refuses a change of nothing', () => {
    assert.throws(() => updateVendorSchema.parse({}), /Nothing to change/)
  })

  it('has no status field on the edit form', () => {
    // Moving a vendor between lifecycle states stops new assignments, so it has
    // its own endpoint where the transition is checked, rather than riding
    // along with a change of address.
    const parsed = updateVendorSchema.parse({
      address: 'Tejgaon',
      status: 'Active',
    }) as Record<string, unknown>

    assert.equal('status' in parsed, false)
  })
})

describe('createVehicleSchema', () => {
  it('accepts a plate and an ownership type, and nothing else is required', () => {
    const parsed = createVehicleSchema.parse({
      registrationNo: 'DHAKA METRO-TA-11-1234',
      ownershipType: 'Rented',
    })

    assert.equal(parsed.brand, '')
    assert.equal(parsed.model, '')
  })

  it('has no vendorId, so the owner can only come from the URL', () => {
    // The whole security model of this module is that a vendor comes from one
    // place. A second source in a body would be a way around the scope check.
    const parsed = createVehicleSchema.parse({
      registrationNo: 'DHAKA METRO-TA-11-1234',
      ownershipType: 'Rented',
      vendorId: VENDOR,
    }) as Record<string, unknown>

    assert.equal('vendorId' in parsed, false)
  })

  it('refuses an ownership type it does not recognise', () => {
    assert.throws(() =>
      createVehicleSchema.parse({ registrationNo: 'DM-TA-11-1234', ownershipType: 'Leased' }),
    )
  })
})

describe('createDriverSchema', () => {
  it('accepts a driver with no licence at all', () => {
    // A driver recorded today whose card is in a drawer at home is still a
    // driver the dispatcher has to be able to assign.
    const parsed = createDriverSchema.parse({ name: 'Md. Rahim', mobile: '01712345678' })

    assert.equal(parsed.licenseNumber, '')
    assert.equal(parsed.licenseExpiry, null)
    assert.equal(parsed.nidNumber, '')
  })

  it('refuses a licence expiry with no licence behind it', () => {
    // A deadline attached to nothing raises a compliance alert nobody can act
    // on, because there is no document to go and renew.
    assert.throws(
      () =>
        createDriverSchema.parse({
          name: 'Md. Rahim',
          mobile: '01712345678',
          licenseExpiry: '2027-04-30',
        }),
      /licence number/i,
    )
  })

  it('reads a licence expiry as a calendar day at UTC midnight', () => {
    const parsed = createDriverSchema.parse({
      name: 'Md. Rahim',
      mobile: '01712345678',
      licenseNumber: 'DK-4471',
      licenseExpiry: '2027-04-30',
    })

    assert.equal(parsed.licenseExpiry?.toISOString(), '2027-04-30T00:00:00.000Z')
  })

  it('has no vendorId either', () => {
    const parsed = createDriverSchema.parse({
      name: 'Md. Rahim',
      mobile: '01712345678',
      vendorId: VENDOR,
    }) as Record<string, unknown>

    assert.equal('vendorId' in parsed, false)
  })
})

describe('createAssignmentSchema', () => {
  it('defaults to an open-ended assignment that does not displace anything', () => {
    const parsed = createAssignmentSchema.parse({
      vehicleId: VENDOR,
      driverId: '000000000000000000000b02',
      assignedFrom: '2026-09-01',
    })

    assert.equal(parsed.assignedUntil, null)
    // Displacing a live assignment is never the default: a request that would
    // has to say so, and is refused with the assignment it would have closed.
    assert.equal(parsed.replaceActive, false)
  })

  it('refuses an id that is not one', () => {
    assert.throws(() =>
      createAssignmentSchema.parse({
        vehicleId: 'not-an-id',
        driverId: VENDOR,
        assignedFrom: '2026-09-01',
      }),
    )
  })

  it('refuses a date that is not a calendar day', () => {
    assert.throws(() =>
      createAssignmentSchema.parse({
        vehicleId: VENDOR,
        driverId: '000000000000000000000b02',
        assignedFrom: '01-09-2026',
      }),
    )
  })

  it('has no status field, so nothing can file an assignment as history', () => {
    const parsed = createAssignmentSchema.parse({
      vehicleId: VENDOR,
      driverId: '000000000000000000000b02',
      assignedFrom: '2026-09-01',
      status: 'Ended',
    }) as Record<string, unknown>

    assert.equal('status' in parsed, false)
  })
})

describe('document schemas', () => {
  it('has no status field, because a status would contradict the date beside it', () => {
    const parsed = createDocumentSchema.parse({
      documentType: 'Fitness Certificate',
      expiryDate: '2026-09-20',
      status: 'Valid',
    }) as Record<string, unknown>

    assert.equal('status' in parsed, false)
  })

  it('reads a blank multipart date field as no date rather than as an error', () => {
    // Half of these arrive as form fields beside a file, and a form that leaves
    // a date blank sends "" rather than omitting the field.
    const parsed = createDocumentSchema.parse({
      documentType: 'NID',
      issueDate: '',
      expiryDate: '',
    })

    assert.equal(parsed.issueDate, null)
    assert.equal(parsed.expiryDate, null)
  })

  it('refuses an expiry before the issue date', () => {
    assert.throws(
      () =>
        createDocumentSchema.parse({
          documentType: 'Tax Token',
          issueDate: '2026-09-20',
          expiryDate: '2026-09-01',
        }),
      /before the issue date/i,
    )
  })

  it('accepts an update carrying only a replacement file', () => {
    // Replacing just the scan is a real change and it arrives as a file rather
    // than as a field, so an empty body is a legitimate request here.
    assert.deepEqual(updateDocumentSchema.parse({}), {})
  })

  it('cannot change what kind of document a row is', () => {
    const parsed = updateDocumentSchema.parse({
      documentNumber: 'X-1',
      documentType: 'Route Permit',
    }) as Record<string, unknown>

    assert.equal('documentType' in parsed, false)
  })
})

describe('list queries', () => {
  it('caps how much one page may ask for', () => {
    assert.throws(() => listVendorsQuerySchema.parse({ limit: '5000' }))
  })

  it('defaults to the whole collection, newest filters off', () => {
    const parsed = listVendorsQuerySchema.parse({})

    assert.equal(parsed.page, 1)
    assert.equal(parsed.status, 'all')
    assert.equal(parsed.compliance, 'all')
    assert.equal(parsed.sort, 'name')
  })

  it('accepts the three derived document states as filters', () => {
    for (const status of ['Valid', 'Expiring Soon', 'Expired']) {
      assert.equal(listDocumentsQuerySchema.parse({ status }).status, status)
    }
  })
})

describe('linking a user account to a vendor', () => {
  it('requires a vendor when the role is Vendor', () => {
    // A Vendor account with no vendor behind it can see nothing and is a
    // support call waiting to happen.
    assert.throws(() => updateUserRoleSchema.parse({ role: 'Vendor' }), /Choose the vendor/i)
  })

  it('accepts the pair together', () => {
    const parsed = updateUserRoleSchema.parse({ role: 'Vendor', vendorId: VENDOR })

    assert.equal(parsed.role, 'Vendor')
    assert.equal(parsed.vendorId, VENDOR)
  })

  it('needs no vendor for any other role', () => {
    assert.doesNotThrow(() => updateUserRoleSchema.parse({ role: 'Manager' }))
  })

  it('refuses a vendor id that is not an id', () => {
    assert.throws(() => updateUserRoleSchema.parse({ role: 'Vendor', vendorId: 'malek' }))
  })
})
