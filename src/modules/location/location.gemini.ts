import * as z from 'zod'
import { MIN_GEMINI_CONFIDENCE } from './location.constants'
import type { MasterCandidate } from './location.matching'
import { normalizeLocationName } from './location.normalize'

/**
 * Gemini, used for exactly one job: choosing between location candidates this
 * server has already picked out of the master collection.
 *
 * It is not a source of truth and it is not a geocoder. It never sees the
 * collection, it is never asked what district a place is in, and it cannot
 * return a district, thana or location type — only the number of one of the
 * rows it was shown, or nothing. Every answer is then re-checked against the
 * collection by the resolver before a word of it reaches a challan.
 *
 * Three rules shape the rest of this file:
 *
 * **It may never break a submission.** Nothing here throws. A timeout, a
 * quota, a malformed answer and an unreachable network all come back as the
 * same thing — no choice, and a reason — because the correct response to all
 * of them is identical: leave the location blank and let somebody set it.
 *
 * **It must not be wasteful.** The local matcher answers first and this is
 * only reached for the residue; identical questions are answered from a small
 * cache; and repeated failures open a circuit breaker so a dead quota costs
 * one request rather than one per challan. There is deliberately no key
 * rotation and no second account: quota is a limit to work within, not one to
 * route around.
 *
 * **It sees the minimum.** The thana text, the district text, the delivery
 * address and a numbered shortlist. No customer name, no phone number, no
 * challan or record identifier — the candidates are numbered 1..n in the
 * prompt and mapped back here, so not even a Mongo id leaves the process.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

/** What the resolver gets back. `candidate` is null when nothing was chosen. */
export interface GeminiChoice {
  candidate: MasterCandidate | null
  confidence: number
  /** A short justification, or the reason there is no choice. Never shown raw. */
  reason: string
  /** True when the call did not happen at all — not configured, cached, open breaker. */
  skipped: boolean
}

/**
 * The answer, as a schema.
 *
 * `candidate` is an index into the list that was sent, not an identifier and
 * not a place name, so there is nothing for the model to invent. Zero means
 * "none of these", which is an answer this prompt actively wants — a model
 * with no honest way to decline is a model that picks something.
 */
const geminiAnswerSchema = z.object({
  candidate: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(400).default(''),
})

// ---------------------------------------------------------------------------
// Usage, and the circuit breaker
// ---------------------------------------------------------------------------

/**
 * What this client needs to make a call.
 *
 * Passed in rather than read from `config` here, so this file imports no
 * environment at all: the resolver owns the decision about whether assisted
 * resolution is available, and this owns how to ask. It also makes the whole
 * client testable without a validated environment behind it.
 */
export interface GeminiSettings {
  apiKey: string
  model: string
  minConfidence: number
  timeoutMs: number
}

export interface GeminiUsage {
  /** Requests actually sent over the network. */
  calls: number
  /** Questions answered from the cache instead of being sent. */
  cacheHits: number
  /** Answers that named a candidate and cleared the confidence threshold. */
  accepted: number
  /** Answers that named a candidate but were not sure enough. */
  lowConfidence: number
  /** Answers that declined, or named something outside the list they were given. */
  rejected: number
  errors: number
  lastError: string | null
  lastErrorAt: string | null
  /** ISO time until which no request will be sent, or null. */
  pausedUntil: string | null
}

const usage = {
  calls: 0,
  cacheHits: 0,
  accepted: 0,
  lowConfidence: 0,
  rejected: 0,
  errors: 0,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
}

/**
 * Consecutive failures, and the time this stops holding back.
 *
 * A quota that has run out will run out again on the next challan and the one
 * after it, so retrying per submission would turn one exhausted key into
 * hundreds of pointless requests and hundreds of operators waiting eight
 * seconds each. Backing off doubles each time to a quarter of an hour, and one
 * success clears it.
 */
let failureStreak = 0
let pausedUntil = 0

const BASE_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 15 * 60_000

function recordFailure(message: string): void {
  usage.errors += 1
  usage.lastError = message
  usage.lastErrorAt = new Date()
  failureStreak += 1
  pausedUntil =
    Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** (failureStreak - 1), MAX_BACKOFF_MS)
}

function recordSuccess(): void {
  failureStreak = 0
  pausedUntil = 0
}

export function geminiUsage(): GeminiUsage {
  return {
    calls: usage.calls,
    cacheHits: usage.cacheHits,
    accepted: usage.accepted,
    lowConfidence: usage.lowConfidence,
    rejected: usage.rejected,
    errors: usage.errors,
    lastError: usage.lastError,
    lastErrorAt: usage.lastErrorAt ? usage.lastErrorAt.toISOString() : null,
    pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
  }
}

/** Test seam, and what a redeploy would do anyway. */
export function resetGeminiState(): void {
  cache.clear()
  failureStreak = 0
  pausedUntil = 0
  usage.calls = 0
  usage.cacheHits = 0
  usage.accepted = 0
  usage.lowConfidence = 0
  usage.rejected = 0
  usage.errors = 0
  usage.lastError = null
  usage.lastErrorAt = null
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  answer: z.infer<typeof geminiAnswerSchema> | null
  expiresAt: number
}

/**
 * A small cache of answered questions.
 *
 * An operator working through one WhatsApp PDF files fifteen challans for the
 * same district, and a good half of them phrase the thana the same way. The
 * key includes a fingerprint of the shortlist, so editing the master
 * collection cannot serve an answer about rows that have changed underneath.
 *
 * A *declined* answer is cached too. "I could not tell" is as stable a result
 * as any other, and re-asking it is the most wasteful thing this module could
 * do.
 */
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60_000
const MAX_CACHE_ENTRIES = 500

function cacheKeyFor(query: GeminiQuery, candidates: readonly MasterCandidate[]): string {
  return [
    normalizeLocationName(query.thana),
    normalizeLocationName(query.district),
    normalizeLocationName(query.deliveryAddress),
    candidates.map((candidate) => candidate.id).join(','),
  ].join('|')
}

function readCache(key: string): CacheEntry | null {
  const entry = cache.get(key)
  if (!entry) {
    return null
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry
}

function writeCache(key: string, answer: CacheEntry['answer']): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Oldest insertion first: Map preserves it, and an LRU would be more
    // bookkeeping than a five-hundred-entry cache is worth.
    const oldest = cache.keys().next()
    if (!oldest.done) {
      cache.delete(oldest.value)
    }
  }
  cache.set(key, { answer, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface GeminiQuery {
  thana: string
  district: string
  deliveryAddress: string
}

const INSTRUCTIONS = [
  'You are matching a delivery address in Bangladesh to one row of a fixed reference list.',
  '',
  'Rules:',
  '- Choose ONLY from the numbered candidates below. Never propose anything else.',
  '- If none of them is clearly the right one, answer with candidate 0.',
  '- Answering 0 is the correct answer whenever you are unsure. A blank result is',
  '  wanted; a wrong district or thana is not.',
  '- The text may contain spelling mistakes, Bangla, or Bijoy-era transliterations.',
  '- confidence is your own probability that the chosen row is correct, 0 to 1.',
].join('\n')

function promptFor(query: GeminiQuery, candidates: readonly MasterCandidate[]): string {
  const lines = [INSTRUCTIONS, '', 'Challan text:']

  lines.push('- thana field: ' + (query.thana.trim() || '(blank)'))
  lines.push('- district field: ' + (query.district.trim() || '(blank)'))
  lines.push('- delivery address: ' + (query.deliveryAddress.trim() || '(blank)'))
  lines.push('', 'Candidates:')

  candidates.forEach((candidate, index) => {
    lines.push(`${index + 1}. district: ${candidate.district} | thana: ${candidate.thana}`)
  })

  return lines.join('\n')
}

/**
 * The response body, narrowed far enough to reach the text part.
 *
 * Everything below this is `unknown` until Zod has looked at it — the answer
 * is JSON produced by a language model, which is the definition of a value
 * that must be parsed rather than trusted.
 */
const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional() })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

function textFrom(body: unknown): string | null {
  const parsed = geminiResponseSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }

  const text = parsed.data.candidates?.[0]?.content?.parts?.[0]?.text
  return typeof text === 'string' && text.trim().length > 0 ? text : null
}

/** Strips a ```json fence, which the model adds despite the response schema. */
function parseAnswer(text: string): z.infer<typeof geminiAnswerSchema> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  let json: unknown
  try {
    json = JSON.parse(cleaned)
  } catch {
    return null
  }

  const parsed = geminiAnswerSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

function declined(reason: string, skipped = false): GeminiChoice {
  return { candidate: null, confidence: 0, reason, skipped }
}

/**
 * Asks Gemini to pick one of the candidates, and validates whatever comes back.
 *
 * The candidate list is the contract: an index outside it, a missing field, a
 * confidence below the configured threshold and an outright refusal all
 * produce the same "no choice", because the caller does the same thing with
 * all four. Nothing here can produce a district, a thana or a location type
 * that was not already in the list this function was handed.
 */
export async function chooseWithGemini(
  query: GeminiQuery,
  candidates: readonly MasterCandidate[],
  settings: GeminiSettings,
): Promise<GeminiChoice> {
  if (candidates.length === 0) {
    // Nothing to choose between. Asking anyway would be an invitation to
    // invent one, which is the single thing this must never allow.
    return declined('There were no candidate locations to choose from.', true)
  }
  if (Date.now() < pausedUntil) {
    return declined('Assisted resolution is paused after repeated failures.', true)
  }

  const key = cacheKeyFor(query, candidates)
  const cached = readCache(key)
  if (cached) {
    usage.cacheHits += 1
    return interpret(cached.answer, candidates, settings.minConfidence, true)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)

  try {
    usage.calls += 1

    const response = await fetch(
      `${ENDPOINT}/${encodeURIComponent(settings.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': settings.apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptFor(query, candidates) }] }],
          generationConfig: {
            // Structured output, so the answer is JSON rather than prose that
            // happens to contain some. It is still parsed and validated.
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                candidate: { type: 'INTEGER' },
                confidence: { type: 'NUMBER' },
                reason: { type: 'STRING' },
              },
              required: ['candidate', 'confidence'],
            },
            // A classification, not a composition. Nothing is gained by
            // letting it wander.
            temperature: 0,
            maxOutputTokens: 256,
          },
        }),
      },
    )

    if (!response.ok) {
      /**
       * 429 and 5xx are transient and open the breaker; a 4xx is this code's
       * own mistake and would repeat identically, so it opens it too. The
       * status is logged and never surfaced — an operator has no use for
       * somebody else's HTTP code.
       */
      recordFailure(`Gemini responded ${response.status}`)
      console.warn(`[location] Gemini responded ${response.status}; backing off`)
      return declined('Assisted resolution is unavailable at the moment.')
    }

    const text = textFrom(await response.json())
    if (!text) {
      recordFailure('Gemini returned no usable text')
      return declined('Assisted resolution returned nothing usable.')
    }

    const answer = parseAnswer(text)
    recordSuccess()

    if (!answer) {
      // A malformed answer is not a failure of the service, so it does not
      // open the breaker — but it is still no answer.
      usage.rejected += 1
      writeCache(key, null)
      return declined('Assisted resolution returned an answer that could not be read.')
    }

    writeCache(key, answer)
    return interpret(answer, candidates, settings.minConfidence, false)
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    recordFailure(aborted ? 'Gemini timed out' : messageOf(error))
    return declined(
      aborted
        ? 'Assisted resolution took too long.'
        : 'Assisted resolution could not be reached.',
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turns a validated answer into a choice, or into nothing.
 *
 * The threshold is applied here rather than at the call site so that a cached
 * answer and a fresh one are held to the same bar, and it never drops below
 * `MIN_GEMINI_CONFIDENCE` however the environment is configured.
 */
function interpret(
  answer: z.infer<typeof geminiAnswerSchema> | null,
  candidates: readonly MasterCandidate[],
  configuredMinimum: number,
  fromCache: boolean,
): GeminiChoice {
  if (!answer) {
    return declined('Assisted resolution returned an answer that could not be read.', fromCache)
  }

  if (answer.candidate === 0) {
    usage.rejected += 1
    return declined('Assisted resolution could not tell which location this is.', fromCache)
  }

  const candidate = candidates[answer.candidate - 1]
  if (!candidate) {
    /**
     * An index outside the list it was given. This is the hallucination this
     * whole arrangement is built to make harmless: it is refused rather than
     * mapped to something nearby.
     */
    usage.rejected += 1
    console.warn('[location] Gemini chose a candidate outside the supplied list; refused')
    return declined('Assisted resolution chose something that was not offered.', fromCache)
  }

  const minimum = Math.max(configuredMinimum, MIN_GEMINI_CONFIDENCE)
  if (answer.confidence < minimum) {
    usage.lowConfidence += 1
    return declined('Assisted resolution was not confident enough to fill this in.', fromCache)
  }

  usage.accepted += 1
  return {
    candidate,
    confidence: answer.confidence,
    reason: answer.reason || 'Selected from the supplied candidates.',
    skipped: fromCache,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
