import { comparisonKey } from '../gate-pass/gate-pass.constants'

/**
 * How close a sheet row is to a gate pass line — the model and the customer.
 *
 * Pure arithmetic, tested as decisions. It never links anything: the operator
 * chooses the gate pass, and this only decides what the picker **offers** and
 * how it labels each offer. That is why "close" is allowed to be generous here
 * where the rate card's matcher is strict — a wrong rate is charged silently,
 * whereas a close model in the picker is a line somebody reads and presses.
 *
 * The gate pass and the challan are typed by two different people off two
 * different papers, so `WFE-2H2-GDEN` against `WFE-2H2-GDEN-XX`, or "Md. Arif
 * Hossain" against "Arif Hossen", are the ordinary case rather than a mistake
 * worth refusing a link over.
 */

export type MatchLevel = 'exact' | 'close' | 'different'

export interface MatchResult {
  level: MatchLevel
  /** 0..1, for ranking. */
  score: number
}

/** A score at or above this is "close". */
export const CLOSE_MATCH_SCORE = 0.75

const DIFFERENT: MatchResult = { level: 'different', score: 0 }

export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

/** 1 for identical strings, falling towards 0 as edits pile up. */
function editRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest
}

function graded(score: number): MatchResult {
  return { level: score >= CLOSE_MATCH_SCORE ? 'close' : 'different', score }
}

/** Model segments worth comparing: `WFE-2H2-GDEN` → `WFE`, `2H2`, `GDEN`. */
function segments(model: string): string[] {
  return model
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((part) => part.length >= 2)
}

/**
 * A challan model against a gate pass model.
 *
 * - **exact** — the same once spacing and punctuation are set aside.
 * - **close** — one contains the other (at least four characters of it), most
 *   segments agree, or a letter or two differs.
 * - **different** — anything else.
 */
export function modelMatch(rowModel: string, lineModel: string): MatchResult {
  const a = comparisonKey(rowModel)
  const b = comparisonKey(lineModel)

  if (!a || !b) {
    return DIFFERENT
  }
  if (a === b) {
    return { level: 'exact', score: 1 }
  }

  let score = editRatio(a, b)

  const shorter = a.length <= b.length ? a : b
  const longer = shorter === a ? b : a
  if (shorter.length >= 4 && longer.includes(shorter)) {
    score = Math.max(score, 0.9)
  }

  const left = segments(rowModel)
  const right = new Set(segments(lineModel))
  if (left.length > 0 && right.size > 0) {
    const shared = left.filter((part) => right.has(part)).length
    const overlap = shared / Math.max(left.length, right.size)
    if (shared >= 2) {
      score = Math.max(score, 0.75 + overlap * 0.2)
    }
  }

  return graded(Math.min(score, 0.99))
}

/** Words that say nothing about who a customer is. */
const FILLER = new Set(['md', 'mohammad', 'mohammed', 'muhammad', 'mr', 'mrs', 'ms', 'the', 'ltd', 'limited'])

function nameTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((token) => token.length > 0 && !FILLER.has(token))
}

/**
 * A challan customer against a gate pass customer.
 *
 * Exact is the same words in the same order once case, punctuation and
 * honorifics are set aside. Close is one name's words all appearing in the
 * other ("Arif Hossain" in "Md. Arif Hossain Traders"), most words agreeing, or
 * a spelling a letter or two apart ("Hossain" / "Hossen").
 */
export function customerMatch(rowCustomer: string, lineCustomer: string): MatchResult {
  const a = nameTokens(rowCustomer)
  const b = nameTokens(lineCustomer)

  if (a.length === 0 || b.length === 0) {
    return DIFFERENT
  }
  if (a.join(' ') === b.join(' ')) {
    return { level: 'exact', score: 1 }
  }

  let score = editRatio(a.join(''), b.join(''))

  const [fewer, more] = a.length <= b.length ? [a, b] : [b, a]
  const pool = new Set(more)
  if (fewer.every((token) => pool.has(token))) {
    score = Math.max(score, 0.9)
  }

  // Word by word, letting each word be a letter or two out.
  const matched = fewer.filter((token) =>
    more.some((other) => token === other || (token.length >= 4 && editRatio(token, other) >= 0.75)),
  ).length
  score = Math.max(score, (matched / more.length) * 0.95)

  return graded(Math.min(score, 0.99))
}

/**
 * A row's product against a gate pass line: by model when both carry one, and
 * by product name when either does not — a hair dryer has no model to compare.
 */
export function productLineMatch(
  row: { productName: string; model: string },
  line: { productName: string; model: string },
): MatchResult {
  if (comparisonKey(row.model) && comparisonKey(line.model)) {
    return modelMatch(row.model, line.model)
  }
  return customerMatch(row.productName, line.productName)
}
