import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { accountKeyFromAuthorization } from './rate-limit'

function tokenWith(claims: unknown): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `Bearer ${encode({ alg: 'RS256' })}.${encode(claims)}.signature`
}

describe('accountKeyFromAuthorization', () => {
  it('reads the Firebase uid out of a bearer token', () => {
    assert.equal(accountKeyFromAuthorization(tokenWith({ sub: 'uid-123' })), 'uid-123')
  })

  it('gives two accounts behind one address two different buckets', () => {
    assert.notEqual(
      accountKeyFromAuthorization(tokenWith({ sub: 'operator-a' })),
      accountKeyFromAuthorization(tokenWith({ sub: 'operator-b' })),
    )
  })

  it('falls back to the address for anything that is not a readable token', () => {
    assert.equal(accountKeyFromAuthorization(undefined), null)
    assert.equal(accountKeyFromAuthorization('Basic abc'), null)
    assert.equal(accountKeyFromAuthorization('Bearer not-a-jwt'), null)
    assert.equal(accountKeyFromAuthorization('Bearer a.%%%.c'), null)
    assert.equal(accountKeyFromAuthorization(tokenWith({ sub: 42 })), null)
    assert.equal(accountKeyFromAuthorization(tokenWith(null)), null)
  })
})
