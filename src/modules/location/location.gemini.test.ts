import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { chooseWithGemini, geminiUsage, resetGeminiState } from './location.gemini'
import type { GeminiSettings } from './location.gemini'
import type { MasterCandidate } from './location.matching'
import { normalizeLocationName } from './location.normalize'

/**
 * The assisted step, and specifically the things that must be true of it when
 * it goes wrong.
 *
 * Almost every test here is about a failure: a timeout, a quota, a malformed
 * answer, an answer naming something that was never offered. That is the point
 * of the file. When this works it saves an operator a click; when it
 * misbehaves it could put a wrong district on a business record, so what is
 * worth pinning down is that every one of these paths ends in the same place —
 * no choice, no exception, and a challan that files exactly as it would have.
 *
 * `fetch` is replaced per test. The client takes its settings as an argument
 * rather than reading the environment, which is what lets this run with no
 * configuration at all.
 */

const SETTINGS: GeminiSettings = {
  apiKey: 'test-key',
  model: 'gemini-test',
  minConfidence: 0.85,
  timeoutMs: 50,
}

function master(district: string, thana: string): MasterCandidate {
  return {
    id: `${district}/${thana}`,
    district,
    thana,
    locationType: 'OSD-Thana',
    normalizedDistrict: normalizeLocationName(district),
    normalizedThana: normalizeLocationName(thana),
  }
}

const CANDIDATES: MasterCandidate[] = [
  master('Gazipur', 'Kaliganj'),
  master('Satkhira', 'Kaliganj'),
  master('Jhenaidah', 'Kaliganj'),
]

const QUERY = {
  thana: 'Kaliganj',
  district: '',
  deliveryAddress: 'Bazar Road, Kaliganj, Gazipur',
}

type FetchLike = typeof globalThis.fetch

/** A response shaped the way the Generative Language API shapes one. */
function answering(body: unknown, status = 200): FetchLike {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
      }),
    }) as unknown as Response) as FetchLike
}

/** A response whose text is not the JSON it promised. */
function answeringText(text: string): FetchLike {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    }) as unknown as Response) as FetchLike
}

function failing(status: number): FetchLike {
  return (async () =>
    ({
      ok: false,
      status,
      json: async () => ({}),
    }) as unknown as Response) as FetchLike
}

const original = globalThis.fetch

function withFetch(implementation: FetchLike): void {
  globalThis.fetch = implementation
}

beforeEach(() => {
  resetGeminiState()
  globalThis.fetch = original
})

// ---------------------------------------------------------------------------
// When it works
// ---------------------------------------------------------------------------

describe('choosing a candidate', () => {
  it('returns the row it named, by position in the list it was given', () => {
    withFetch(answering({ candidate: 1, confidence: 0.94, reason: 'Address says Gazipur.' }))

    return chooseWithGemini(QUERY, CANDIDATES, SETTINGS).then((choice) => {
      assert.equal(choice.candidate?.district, 'Gazipur')
      assert.equal(choice.candidate?.thana, 'Kaliganj')
      assert.equal(choice.confidence, 0.94)
      assert.equal(geminiUsage().accepted, 1)
    })
  })

  it('accepts an answer wrapped in a code fence', async () => {
    // Models add one despite a response schema, and an answer thrown away over
    // three backticks is a wrong location for no reason.
    withFetch(answeringText('```json\n{"candidate":2,"confidence":0.9}\n```'))

    const choice = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)
    assert.equal(choice.candidate?.district, 'Satkhira')
  })

  it('answers a repeated question from the cache instead of asking again', async () => {
    withFetch(answering({ candidate: 1, confidence: 0.94 }))
    await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    // Any further call would throw rather than answer.
    withFetch((() => {
      throw new Error('should not have been called')
    }) as unknown as FetchLike)

    const second = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.equal(second.candidate?.district, 'Gazipur')
    assert.equal(geminiUsage().calls, 1)
    assert.equal(geminiUsage().cacheHits, 1)
  })
})

// ---------------------------------------------------------------------------
// When it should be refused
// ---------------------------------------------------------------------------

describe('refusing an answer', () => {
  /**
   * The hallucination this whole arrangement exists to make harmless. The
   * model was shown three rows and named a fourth; there is no fourth, and
   * nothing here goes looking for what it might have meant.
   */
  it('refuses a candidate that was never offered', async () => {
    withFetch(answering({ candidate: 9, confidence: 0.99 }))

    const choice = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.equal(choice.candidate, null)
    assert.equal(geminiUsage().rejected, 1)
  })

  it('refuses a negative or fractional position', async () => {
    withFetch(answering({ candidate: -1, confidence: 0.99 }))
    assert.equal((await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)).candidate, null)

    resetGeminiState()
    withFetch(answering({ candidate: 1.5, confidence: 0.99 }))
    assert.equal((await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)).candidate, null)
  })

  it('takes zero as an honest "I cannot tell"', async () => {
    withFetch(answering({ candidate: 0, confidence: 0.2, reason: 'Three fit equally.' }))

    const choice = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.equal(choice.candidate, null)
    assert.equal(geminiUsage().rejected, 1)
  })

  it('refuses an answer below the confidence threshold', async () => {
    withFetch(answering({ candidate: 1, confidence: 0.6 }))

    const choice = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.equal(choice.candidate, null)
    assert.equal(geminiUsage().lowConfidence, 1)
  })

  it('will not let the threshold be configured below its floor', async () => {
    // A deployment that set 0 would otherwise accept every guess, which
    // inverts the rule the whole feature rests on.
    withFetch(answering({ candidate: 1, confidence: 0.4 }))

    const choice = await chooseWithGemini(QUERY, CANDIDATES, {
      ...SETTINGS,
      minConfidence: 0,
    })

    assert.equal(choice.candidate, null)
  })

  it('refuses an answer that is not the shape it promised', async () => {
    withFetch(answering({ district: 'Dhaka', thana: 'Mirpur' }))

    const choice = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.equal(choice.candidate, null)
    assert.equal(geminiUsage().rejected, 1)
  })

  it('refuses an answer that is not JSON at all', async () => {
    withFetch(answeringText('I think it is probably Gazipur.'))

    assert.equal((await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)).candidate, null)
  })

  it('never asks when there is nothing to choose between', async () => {
    withFetch((() => {
      throw new Error('should not have been called')
    }) as unknown as FetchLike)

    const choice = await chooseWithGemini(QUERY, [], SETTINGS)

    assert.equal(choice.candidate, null)
    assert.equal(choice.skipped, true)
    assert.equal(geminiUsage().calls, 0)
  })
})

// ---------------------------------------------------------------------------
// When the service itself misbehaves
// ---------------------------------------------------------------------------

describe('surviving the service', () => {
  it('gives up quietly on a timeout', async () => {
    withFetch(((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })) as unknown as FetchLike)

    const choice = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.equal(choice.candidate, null)
    assert.equal(geminiUsage().errors, 1)
  })

  it('gives up quietly on a rate limit, and stops asking for a while', async () => {
    withFetch(failing(429))

    const first = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)
    assert.equal(first.candidate, null)
    assert.ok(geminiUsage().pausedUntil !== null)

    /**
     * The point of the pause. A quota that has run out will run out again on
     * the next challan, so the second request is not sent at all — one
     * exhausted key costs one call rather than one per submission.
     */
    withFetch((() => {
      throw new Error('should not have been called')
    }) as unknown as FetchLike)

    const second = await chooseWithGemini(
      { ...QUERY, thana: 'Something else' },
      CANDIDATES,
      SETTINGS,
    )

    assert.equal(second.candidate, null)
    assert.equal(second.skipped, true)
    assert.equal(geminiUsage().calls, 1)
  })

  it('gives up quietly on a server error', async () => {
    withFetch(failing(503))

    assert.equal((await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)).candidate, null)
    assert.equal(geminiUsage().errors, 1)
  })

  it('gives up quietly when the network is unreachable', async () => {
    withFetch((() => Promise.reject(new Error('ENOTFOUND'))) as unknown as FetchLike)

    assert.equal((await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)).candidate, null)
  })

  it('never surfaces a status code, a URL or a key to the caller', async () => {
    withFetch(failing(429))

    const choice = await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.ok(!choice.reason.includes('429'))
    assert.ok(!choice.reason.includes('test-key'))
    assert.ok(!choice.reason.toLowerCase().includes('http'))
  })
})

// ---------------------------------------------------------------------------
// What leaves the process
// ---------------------------------------------------------------------------

describe('what is sent', () => {
  it('sends the candidates as numbers, and no identifier of any kind', async () => {
    let sent = ''

    withFetch((async (_url: string, init: RequestInit) => {
      sent = String(init.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ candidate: 0, confidence: 0 }) }] } },
          ],
        }),
      } as unknown as Response
    }) as unknown as FetchLike)

    await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    // The rows are there by name, so the model can reason about them...
    assert.ok(sent.includes('Gazipur'))
    assert.ok(sent.includes('Kaliganj'))
    // ...but nothing that identifies a record in this system goes with them.
    assert.ok(!sent.includes('Gazipur/Kaliganj'))
  })

  it('sends the address but nothing else about the customer', async () => {
    let sent = ''

    withFetch((async (_url: string, init: RequestInit) => {
      sent = String(init.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ candidate: 0, confidence: 0 }) }] } },
          ],
        }),
      } as unknown as Response
    }) as unknown as FetchLike)

    await chooseWithGemini(QUERY, CANDIDATES, SETTINGS)

    assert.ok(sent.includes('Bazar Road'))
    // The client is only ever handed three fields, so there is nothing else it
    // could send — this is the assertion that keeps it that way.
    assert.ok(!sent.includes('01712'))
    assert.ok(!sent.toLowerCase().includes('customer name'))
  })
})
