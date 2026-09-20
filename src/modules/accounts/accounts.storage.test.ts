import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_VOUCHER_IMAGE_BYTES,
  MAX_VOUCHER_PDF_BYTES,
  maxVoucherBytesFor,
} from './accounts.constants'
import { buildVoucherKey, safeVoucherName } from './accounts.storage'

/**
 * The two things about a stored voucher that are decisions rather than plumbing:
 * what goes into its object key, and which ceiling a file is held to.
 *
 * Neither is visible from the outside. A key built out of a client-supplied
 * filename is a path-traversal and an overwrite waiting to happen, and a
 * replacement landing on the key the entry still points at would make
 * `immutable` a lie — so both are pinned here rather than left to a reviewer
 * noticing.
 */

describe('buildVoucherKey', () => {
  const date = new Date('2026-08-14T00:00:00.000Z')

  it('files under the entry, in a dated folder', () => {
    const key = buildVoucherKey('accounts-vouchers', 'entry123', date, 'pdf')

    assert.match(key, /^accounts-vouchers\/2026\/08\/entry123\/[0-9a-f-]{36}\.pdf$/)
  })

  it('pads the month, so a bucket listing sorts', () => {
    const key = buildVoucherKey('accounts-vouchers', 'entry123', new Date('2026-01-09T00:00:00.000Z'), 'jpg')

    assert.ok(key.startsWith('accounts-vouchers/2026/01/entry123/'))
  })

  it('reads the day in UTC, so a voucher never files itself under the wrong month', () => {
    // Late on the 31st in Dhaka is still the 31st here, which is the day the
    // entry itself is stored under.
    const key = buildVoucherKey('accounts-vouchers', 'entry123', new Date('2026-07-31T00:00:00.000Z'), 'pdf')

    assert.ok(key.startsWith('accounts-vouchers/2026/07/'))
  })

  it('lands on a fresh key every time, so a replacement never overwrites what the entry points at', () => {
    const first = buildVoucherKey('accounts-vouchers', 'entry123', date, 'pdf')
    const second = buildVoucherKey('accounts-vouchers', 'entry123', date, 'pdf')

    assert.notEqual(first, second)
  })
})

describe('safeVoucherName', () => {
  it('keeps only the file name, never a path the client supplied', () => {
    assert.equal(safeVoucherName('C:\\Users\\kmraz\\Desktop\\fuel-bill.pdf'), 'fuel-bill.pdf')
    assert.equal(safeVoucherName('../../etc/passwd'), 'passwd')
  })

  it('strips control characters', () => {
    assert.equal(safeVoucherName(`memo${String.fromCharCode(10)}.pdf`), 'memo.pdf')
  })

  it('falls back rather than storing an empty name', () => {
    assert.equal(safeVoucherName('   '), 'voucher')
  })
})

describe('maxVoucherBytesFor', () => {
  it('holds a PDF and an image to their own ceilings', () => {
    assert.equal(maxVoucherBytesFor('application/pdf'), MAX_VOUCHER_PDF_BYTES)
    assert.equal(maxVoucherBytesFor('image/jpeg'), MAX_VOUCHER_IMAGE_BYTES)
    assert.equal(maxVoucherBytesFor('image/png'), MAX_VOUCHER_IMAGE_BYTES)
    assert.equal(maxVoucherBytesFor('image/webp'), MAX_VOUCHER_IMAGE_BYTES)
  })

  it('is the same pair the multipart parser and the client mirror', () => {
    assert.equal(MAX_VOUCHER_PDF_BYTES, 25 * 1024 * 1024)
    assert.equal(MAX_VOUCHER_IMAGE_BYTES, 10 * 1024 * 1024)
  })
})
