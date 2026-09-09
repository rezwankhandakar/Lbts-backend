import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import type { UserDocument } from '../user/user.model'
import type { UserRole } from '../user/user.constants'
import {
  assertCanCreateVendor,
  assertCanManageVendor,
  assertCanReadVendor,
  ownVendorIdOf,
  seesEveryVendor,
  vendorFilterFor,
  vendorScopeOf,
} from './vendor.access'
import {
  DOCUMENT_EXPIRY_SOON_DAYS,
  VENDOR_MANAGE_ROLES,
  VENDOR_READ_ROLES,
  canManageVendors,
  canReadVendors,
  canTransitionVendor,
  daysUntilExpiry,
  documentStatusFor,
  driverAcceptsAssignment,
  expiryPhrase,
  isDocumentTypeFor,
  nameKey,
  normalizeMobile,
  registrationKey,
  vehicleAcceptsDriver,
  vendorAcceptsAssignments,
} from './vendor.constants'
import type { VendorStatus } from './vendor.constants'

/**
 * The rules that decide what happens to a vendor, its fleet and its papers,
 * tested without a database. Everything here is a decision the server must make
 * the same way every time — which is the part worth pinning down.
 */

/** A profile, as the access layer sees one. */
function actor(role: UserRole, vendorId?: string): UserDocument {
  return { _id: 'user-1', role, vendorId: vendorId ?? null } as unknown as UserDocument
}

const VENDOR_A = '000000000000000000000a01'
const VENDOR_B = '000000000000000000000b02'

describe('vendor access scope', () => {
  it('gives every staff role the whole collection', () => {
    for (const role of ['Admin', 'Manager', 'CEO', 'OpEx'] as UserRole[]) {
      assert.deepEqual(vendorScopeOf(actor(role)), { kind: 'all' }, role)
      assert.equal(seesEveryVendor(actor(role)), true, role)
      assert.equal(vendorFilterFor(actor(role)), null, role)
    }
  })

  it('confines a Vendor account to the vendor its profile is linked to', () => {
    const scope = vendorScopeOf(actor('Vendor', VENDOR_A))

    assert.deepEqual(scope, { kind: 'own', vendorId: VENDOR_A })
    assert.deepEqual(vendorFilterFor(actor('Vendor', VENDOR_A)), { vendorId: VENDOR_A })
  })

  it('refuses a Vendor account that has not been linked yet', () => {
    // Not "a smaller amount of access" — none, and said plainly rather than
    // rendered as an empty page nobody can explain.
    assert.throws(() => vendorScopeOf(actor('Vendor')), /not linked to a vendor/i)
  })

  it('answers 404 rather than 403 when a vendor reaches for another vendor', () => {
    // Telling them V-0042 exists but is not theirs is more than they need.
    assert.throws(
      () => assertCanReadVendor(VENDOR_B, actor('Vendor', VENDOR_A)),
      (error: { statusCode: number }) => error.statusCode === 404,
    )
  })

  it('lets a vendor read its own record', () => {
    assert.doesNotThrow(() => assertCanReadVendor(VENDOR_A, actor('Vendor', VENDOR_A)))
  })

  it('never lets a vendor write, even to its own record', () => {
    assert.throws(
      () => assertCanManageVendor(VENDOR_A, actor('Vendor', VENDOR_A)),
      (error: { statusCode: number }) => error.statusCode === 403,
    )
  })

  it('hides the existence of another vendor even from a write attempt', () => {
    // A 403 here would confirm the id was real. The read check runs first.
    assert.throws(
      () => assertCanManageVendor(VENDOR_B, actor('Vendor', VENDOR_A)),
      (error: { statusCode: number }) => error.statusCode === 404,
    )
  })

  it('makes CEO and OpEx read-only', () => {
    for (const role of ['CEO', 'OpEx'] as UserRole[]) {
      assert.doesNotThrow(() => assertCanReadVendor(VENDOR_A, actor(role)), role)
      assert.throws(
        () => assertCanManageVendor(VENDOR_A, actor(role)),
        (error: { statusCode: number }) => error.statusCode === 403,
        role,
      )
      assert.throws(() => assertCanCreateVendor(actor(role)), /permission/i, role)
    }
  })

  it('lets Admin and Manager change anything', () => {
    for (const role of ['Admin', 'Manager'] as UserRole[]) {
      assert.doesNotThrow(() => assertCanManageVendor(VENDOR_B, actor(role)), role)
      assert.doesNotThrow(() => assertCanCreateVendor(actor(role)), role)
    }
  })

  it('answers "my vendor" only for a vendor account', () => {
    assert.equal(ownVendorIdOf(actor('Vendor', VENDOR_A)), VENDOR_A)
    assert.throws(() => ownVendorIdOf(actor('Admin')), /not a vendor account/i)
  })
})

describe('role sets', () => {
  it('reads for everyone and writes for two', () => {
    assert.deepEqual(
      [...VENDOR_READ_ROLES],
      ['Admin', 'Manager', 'CEO', 'OpEx', 'Vendor'],
    )
    assert.deepEqual([...VENDOR_MANAGE_ROLES], ['Admin', 'Manager'])
  })

  it('puts Vendor in the read set and nowhere near the write set', () => {
    assert.equal(canReadVendors('Vendor'), true)
    assert.equal(canManageVendors('Vendor'), false)
    assert.equal(canManageVendors('CEO'), false)
    assert.equal(canManageVendors('OpEx'), false)
  })
})

describe('vendor lifecycle', () => {
  it('lets a pending vendor be approved or shelved', () => {
    assert.equal(canTransitionVendor('Pending', 'Active'), true)
    assert.equal(canTransitionVendor('Pending', 'Inactive'), true)
    assert.equal(canTransitionVendor('Pending', 'Suspended'), true)
  })

  it('makes every stop reversible', () => {
    // A vendor suspended over a lapsed certificate has to come back when it is
    // renewed, rather than being recreated — which would orphan its fleet.
    assert.equal(canTransitionVendor('Suspended', 'Active'), true)
    assert.equal(canTransitionVendor('Inactive', 'Active'), true)
  })

  it('refuses a move to the state it is already in', () => {
    for (const status of ['Pending', 'Active', 'Inactive', 'Suspended'] as VendorStatus[]) {
      assert.equal(canTransitionVendor(status, status), false, status)
    }
  })

  it('fails closed for a status written before this vocabulary existed', () => {
    assert.equal(canTransitionVendor('Blocked' as VendorStatus, 'Active'), false)
  })

  it('only lets an active vendor take new work', () => {
    assert.equal(vendorAcceptsAssignments('Active'), true)
    assert.equal(vendorAcceptsAssignments('Pending'), false)
    assert.equal(vendorAcceptsAssignments('Inactive'), false)
    assert.equal(vendorAcceptsAssignments('Suspended'), false)
  })
})

describe('operational gates', () => {
  it('only puts a driver on an active vehicle', () => {
    assert.equal(vehicleAcceptsDriver('Active'), true)
    // A vehicle in the workshop, out of service or out of papers records an
    // assignment the operation cannot honour.
    assert.equal(vehicleAcceptsDriver('Under Maintenance'), false)
    assert.equal(vehicleAcceptsDriver('Expired'), false)
    assert.equal(vehicleAcceptsDriver('Suspended'), false)
    assert.equal(vehicleAcceptsDriver('Inactive'), false)
  })

  it('only assigns an active driver', () => {
    assert.equal(driverAcceptsAssignment('Active'), true)
    assert.equal(driverAcceptsAssignment('On Leave'), false)
    assert.equal(driverAcceptsAssignment('Suspended'), false)
    assert.equal(driverAcceptsAssignment('Inactive'), false)
  })
})

describe('document expiry', () => {
  const today = new Date('2026-09-08T12:00:00.000Z')

  it('counts calendar days rather than elapsed hours', () => {
    // "Expires in 12 days" must not become 11 because it was opened at 11pm.
    assert.equal(daysUntilExpiry(new Date('2026-09-20T00:00:00.000Z'), today), 12)
    assert.equal(daysUntilExpiry(new Date('2026-09-08T00:00:00.000Z'), today), 0)
    assert.equal(daysUntilExpiry(new Date('2026-09-07T00:00:00.000Z'), today), -1)
  })

  it('is the worked example from the specification', () => {
    const fitness = new Date('2026-09-20T00:00:00.000Z')

    assert.equal(expiryPhrase(fitness, today), 'Expires in 12 days')
    assert.equal(documentStatusFor(fitness, today), 'Expiring Soon')
  })

  it('treats a document with no expiry as valid rather than as a deadline', () => {
    // An NID does not lapse, and inventing one would be a permanent false alarm.
    assert.equal(documentStatusFor(null, today), 'Valid')
    assert.equal(expiryPhrase(null, today), 'No expiry recorded')
  })

  it('puts the boundary exactly where the constant says', () => {
    const day = 86_400_000
    const edge = new Date(
      Date.UTC(2026, 8, 8) + DOCUMENT_EXPIRY_SOON_DAYS * day,
    )
    const justOutside = new Date(edge.getTime() + day)

    assert.equal(documentStatusFor(edge, today), 'Expiring Soon')
    assert.equal(documentStatusFor(justOutside, today), 'Valid')
  })

  it('reports the day itself as expiring, not expired', () => {
    const now = new Date('2026-09-08T23:59:00.000Z')
    assert.equal(documentStatusFor(new Date('2026-09-08T00:00:00.000Z'), now), 'Expiring Soon')
    assert.equal(expiryPhrase(new Date('2026-09-08T00:00:00.000Z'), now), 'Expires today')
  })

  it('phrases a lapse in the past tense', () => {
    assert.equal(expiryPhrase(new Date('2026-09-07T00:00:00.000Z'), today), 'Expired yesterday')
    assert.equal(expiryPhrase(new Date('2026-08-29T00:00:00.000Z'), today), 'Expired 10 days ago')
  })
})

describe('document types belong to their owner', () => {
  it('will not file an NID against a lorry', () => {
    assert.equal(isDocumentTypeFor('Vehicle', 'NID'), false)
    assert.equal(isDocumentTypeFor('Vehicle', 'Fitness Certificate'), true)
  })

  it('will not file a tax token against a person', () => {
    assert.equal(isDocumentTypeFor('Driver', 'Tax Token'), false)
    assert.equal(isDocumentTypeFor('Driver', 'Driving License'), true)
  })
})

describe('comparison keys', () => {
  it('sees the same plate however it was typed', () => {
    assert.equal(
      registrationKey('DHAKA METRO-TA-11-1234'),
      registrationKey('dhaka metro ta 11 1234'),
    )
  })

  /**
   * The join back to Gate Pass. A gate pass stores `vehicleNoKey` under exactly
   * this normalisation, so the same plate on a challan and on a vehicle here
   * reduce to the same string — which is what makes a future join one indexed
   * lookup rather than a migration. The two functions are deliberately separate
   * copies, so this is what stops them drifting.
   */
  it('agrees with the Gate Pass vehicle key, character for character', () => {
    for (const plate of [
      'DHAKA METRO-TA-11-1234',
      'dhaka metro na 15 1469',
      'CHATTO METRO — TA 02 3344',
      '',
    ]) {
      assert.equal(registrationKey(plate), comparisonKey(plate), plate)
    }
  })

  it('keeps Bangla in a name key and drops it from a plate key', () => {
    // A vendor may legitimately be recorded in Bangla; a registration plate is
    // a code, so Bangla letters have no business in its key.
    assert.notEqual(nameKey('মালেক ট্রান্সপোর্ট'), '')
    assert.equal(registrationKey('মালেক'), '')
  })

  it('reduces one mobile number written three ways to one key', () => {
    assert.equal(normalizeMobile('+8801712345678'), '01712345678')
    assert.equal(normalizeMobile('8801712345678'), '01712345678')
    assert.equal(normalizeMobile('01712-345678'), '01712345678')
  })

  it('keeps an unrecognised number as typed rather than guessing at it', () => {
    assert.equal(normalizeMobile('  ext 4471  '), 'ext 4471')
  })
})
