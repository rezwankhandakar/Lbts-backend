import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertCanDelete, assertCanEdit, canViewRecord, visibilityFilter } from './gate-pass.access'
import {
  GATE_PASS_STATUSES,
  MAX_GATE_PASS_IMAGE_BYTES,
  MAX_GATE_PASS_PDF_BYTES,
  canTransitionGatePass,
  comparisonKey,
  maxBytesFor,
  needsReverificationAfterEdit,
} from './gate-pass.constants'
import type { GatePassStatus } from './gate-pass.constants'
import type { GatePassDocument } from './gate-pass.model'
import { buildDocumentKey, safeOriginalName } from './gate-pass.storage'
import type { UserDocument } from '../user/user.model'
import type { UserRole } from '../user/user.constants'

/**
 * The rules that decide what happens to a gate pass, tested without a
 * database. Everything here is a decision the server must make the same way
 * every time, which is the part worth pinning down.
 */

describe('lifecycle transitions', () => {
  it('lets a draft be submitted, and nothing else', () => {
    assert.equal(canTransitionGatePass('Draft', 'Submitted'), true)
    assert.equal(canTransitionGatePass('Draft', 'Verified'), false)
    assert.equal(canTransitionGatePass('Draft', 'Rejected'), false)
  })

  it('lets a rejected gate pass be corrected and resubmitted', () => {
    assert.equal(canTransitionGatePass('Rejected', 'Submitted'), true)
  })

  it('will not verify anything that was never submitted', () => {
    assert.equal(canTransitionGatePass('Draft', 'Verified'), false)
    assert.equal(canTransitionGatePass('Rejected', 'Verified'), false)
    assert.equal(canTransitionGatePass('Submitted', 'Verified'), true)
  })

  it('sends a corrected verification back to be checked again', () => {
    assert.equal(canTransitionGatePass('Verified', 'Submitted'), true)
    assert.equal(canTransitionGatePass('Verified', 'Verified'), false)
    assert.equal(canTransitionGatePass('Verified', 'Rejected'), false)
  })

  it('has no withdrawn status left to move to', () => {
    assert.equal(GATE_PASS_STATUSES.includes('Cancelled' as GatePassStatus), false)

    for (const status of GATE_PASS_STATUSES) {
      assert.equal(
        canTransitionGatePass(status, 'Cancelled' as GatePassStatus),
        false,
        `${status} -> Cancelled`,
      )
    }
  })

  it('fails closed for a status written before this vocabulary existed', () => {
    assert.equal(canTransitionGatePass('Pending' as GatePassStatus, 'Submitted'), false)
  })

  it('charges a correction only where a verdict would be invalidated', () => {
    assert.equal(needsReverificationAfterEdit('Verified'), true)
    // Nothing to invalidate: no reviewer has signed any of these off.
    assert.equal(needsReverificationAfterEdit('Draft'), false)
    assert.equal(needsReverificationAfterEdit('Submitted'), false)
    assert.equal(needsReverificationAfterEdit('Rejected'), false)
  })
})

describe('comparisonKey', () => {
  it('sees the same vehicle however it was typed', () => {
    assert.equal(
      comparisonKey('DHAKA METRO-NA-15-1469'),
      comparisonKey('dhaka metro na 15 1469'),
    )
  })

  it('sees the same delivery order across punctuation', () => {
    assert.equal(comparisonKey('3667398-5090414'), comparisonKey('3667398 5090414'))
  })

  it('still tells two different trips apart', () => {
    assert.notEqual(comparisonKey('5044181'), comparisonKey('5044182'))
  })
})

describe('document size limits', () => {
  it('gives a PDF the larger allowance and an image the tighter one', () => {
    assert.equal(maxBytesFor('application/pdf'), MAX_GATE_PASS_PDF_BYTES)
    assert.equal(maxBytesFor('image/jpeg'), MAX_GATE_PASS_IMAGE_BYTES)
    assert.equal(maxBytesFor('image/png'), MAX_GATE_PASS_IMAGE_BYTES)
  })

  it('does not reuse the profile photo limit', () => {
    assert.ok(MAX_GATE_PASS_IMAGE_BYTES > 5 * 1024 * 1024)
  })
})

describe('object keys', () => {
  it('files a document under the trip date and the gate pass', () => {
    const key = buildDocumentKey(
      'gate-passes',
      'GP-2026-000123',
      new Date('2026-08-20T00:00:00.000Z'),
      'pdf',
    )

    assert.match(
      key,
      /^gate-passes\/2026\/08\/20\/GP-2026-000123\/[0-9a-f-]{36}\.pdf$/,
    )
  })

  it('never reuses a key, so a replacement cannot overwrite the live document', () => {
    const date = new Date('2026-08-20T00:00:00.000Z')
    const first = buildDocumentKey('gate-passes', 'GP-2026-000123', date, 'jpg')
    const second = buildDocumentKey('gate-passes', 'GP-2026-000123', date, 'jpg')

    assert.notEqual(first, second)
  })
})

describe('safeOriginalName', () => {
  it('keeps only the file name, never a path the client supplied', () => {
    assert.equal(safeOriginalName('C:\\Users\\kmraz\\Desktop\\challan.pdf'), 'challan.pdf')
    assert.equal(safeOriginalName('../../etc/passwd'), 'passwd')
  })

  it('strips control characters', () => {
    assert.equal(safeOriginalName(`scan${String.fromCharCode(10)}.pdf`), 'scan.pdf')
  })

  it('falls back rather than storing an empty name', () => {
    assert.equal(safeOriginalName('   '), 'document')
  })
})

/**
 * Minimal stand-ins. The access rules read exactly two things off each object,
 * so building a full Mongoose document to test them would prove nothing extra.
 */
function userStub(id: string, role: UserRole): UserDocument {
  return { _id: id, role } as unknown as UserDocument
}

function recordStub(createdBy: string, status: GatePassStatus): GatePassDocument {
  return { createdBy, status } as unknown as GatePassDocument
}

describe('record visibility', () => {
  const admin = userStub('admin1', 'Admin')
  const manager = userStub('manager1', 'Manager')
  const opex = userStub('opex1', 'OpEx')
  const otherOpex = userStub('opex2', 'OpEx')

  it('scopes nobody when the viewer manages the whole module', () => {
    assert.equal(visibilityFilter(admin), null)
    assert.equal(visibilityFilter(manager), null)
  })

  it('hides an unfinished draft belonging to another operator', () => {
    const draft = recordStub('opex1', 'Draft')

    assert.equal(canViewRecord(draft, opex), true)
    assert.equal(canViewRecord(draft, otherOpex), false)
    assert.equal(canViewRecord(draft, manager), true)
  })

  it('shares everything that has been submitted', () => {
    const submitted = recordStub('opex1', 'Submitted')
    assert.equal(canViewRecord(submitted, otherOpex), true)
  })
})

describe('edit and delete rules', () => {
  const admin = userStub('admin1', 'Admin')
  const reviewer = userStub('manager1', 'Manager')
  const opex = userStub('opex1', 'OpEx')
  const otherOpex = userStub('opex2', 'OpEx')

  it('lets an operator correct their own record in any status', () => {
    // A transcription error is worth fixing whenever it is spotted; what a
    // late correction costs is needsReverificationAfterEdit's business, not
    // a reason to refuse the edit.
    for (const status of GATE_PASS_STATUSES) {
      assert.doesNotThrow(() => assertCanEdit(recordStub('opex1', status), opex), status)
    }
  })

  it('lets Admin and Manager correct anybody’s record in any status', () => {
    for (const status of GATE_PASS_STATUSES) {
      assert.doesNotThrow(() => assertCanEdit(recordStub('opex1', status), admin), status)
      assert.doesNotThrow(() => assertCanEdit(recordStub('opex1', status), reviewer), status)
    }
  })

  it('refuses to edit work created by somebody else', () => {
    // Visible, because it has been submitted — but still not theirs to change.
    assert.throws(
      () => assertCanEdit(recordStub('opex1', 'Submitted'), otherOpex),
      /only change gate passes you created/,
    )
  })

  it('lets an operator delete their own record in any status', () => {
    // Withdrawing is a delete now, so a mistake noticed after verification is
    // still removable — by the person who filed it.
    for (const status of GATE_PASS_STATUSES) {
      assert.doesNotThrow(() => assertCanDelete(recordStub('opex1', status), opex), status)
    }
  })

  it("lets Admin and Manager delete anybody's record in any status", () => {
    for (const status of GATE_PASS_STATUSES) {
      assert.doesNotThrow(() => assertCanDelete(recordStub('opex1', status), admin), status)
      assert.doesNotThrow(() => assertCanDelete(recordStub('opex1', status), reviewer), status)
    }
  })

  it('will not let one operator delete a draft created by another', () => {
    assert.throws(
      () => assertCanDelete(recordStub('opex1', 'Draft'), otherOpex),
      /Gate pass not found/,
    )
  })
})
