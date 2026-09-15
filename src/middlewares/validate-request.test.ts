import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { validateRequest } from './validate-request'

/**
 * The one rule this middleware has beyond parsing: what it attaches accumulates.
 *
 * A route reaches it twice whenever the body is multipart — the id can be
 * validated straight away, but a form field does not exist until the parser has
 * run, so the body is validated after it. While the second pass replaced
 * `req.validated` outright it dropped the params the first had written, and
 * every vendor document endpoint answered "Invalid id." on a request that was
 * entirely valid. That is a plumbing detail no controller test would catch, so
 * it is pinned here.
 */

interface FakeRequest {
  body?: unknown
  params?: unknown
  validated?: Request['validated']
}

/** Runs a middleware over a bare object, and returns what it left behind. */
function run(schemas: Parameters<typeof validateRequest>[0], req: FakeRequest): FakeRequest {
  let called = false
  const next: NextFunction = () => {
    called = true
  }

  validateRequest(schemas)(req as unknown as Request, {} as Response, next)
  assert.equal(called, true, 'next() was not called')

  return req
}

const idParams = z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/) })
const body = z.object({ documentType: z.string() })

const ID = '000000000000000000000a01'

describe('validateRequest', () => {
  it('attaches each section it was given', () => {
    const req = run({ params: idParams, body }, { params: { id: ID }, body: { documentType: 'NID' } })

    assert.deepEqual(req.validated?.params, { id: ID })
    assert.deepEqual(req.validated?.body, { documentType: 'NID' })
  })

  it('keeps params written by an earlier pass when a later one validates only the body', () => {
    const req: FakeRequest = { params: { id: ID }, body: { documentType: 'NID' } }

    run({ params: idParams }, req)
    run({ body }, req)

    assert.deepEqual(req.validated?.params, { id: ID }, 'the id survived the second pass')
    assert.deepEqual(req.validated?.body, { documentType: 'NID' })
  })

  it('lets a later pass overwrite the section it actually parsed', () => {
    const req: FakeRequest = { params: { id: ID }, body: { documentType: 'NID' } }

    run({ params: idParams, body }, req)
    run({ body: z.object({ documentType: z.string().toUpperCase() }) }, req)

    assert.deepEqual(req.validated?.body, { documentType: 'NID' })
    assert.deepEqual(req.validated?.params, { id: ID })
  })

  it('replaces req.body with the parsed value, so handlers read coerced fields', () => {
    const req = run(
      { body: z.object({ page: z.coerce.number() }) },
      { body: { page: '3' } },
    )

    assert.deepEqual(req.body, { page: 3 })
  })
})
