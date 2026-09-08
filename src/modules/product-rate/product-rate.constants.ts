import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Product Rate vocabulary. The frontend
 * mirrors this file at `LBTS-Frontend/src/features/product-rate/types/index.ts`,
 * which adds display metadata and nothing else. Change one, change both.
 */

/**
 * How a rate is expressed.
 *
 * Two kinds, because the supplied rate card has two. Most products are a
 * single figure per piece; Iron and Electric Kettle are written as "ek challan
 * e prothom 5 pics 60, porer gulo 24 kore" — the first few pieces on a challan
 * at one figure and everything after it at another.
 *
 * That second form is arithmetic, not a note. Storing it as prose would mean
 * every iron line on every challan was priced by somebody with a calculator,
 * which is precisely the quiet inconsistency a rate card exists to remove.
 */
export const RATE_KINDS = ['flat', 'tiered'] as const
export type RateKind = (typeof RATE_KINDS)[number]

/** One figure per piece, however many pieces there are. */
export interface FlatRate {
  kind: 'flat'
  amount: number
}

/**
 * The first `firstQty` pieces **on one challan** at `firstAmount` each, and
 * every piece after that at `restAmount`.
 *
 * "On one challan" is the part that matters and it is what the rate card
 * says. A challan carrying two separate iron lines gets one allowance between
 * them, not one each — see `priceItems`, which walks the rows in order and
 * spends the allowance as it goes.
 */
export interface TieredRate {
  kind: 'tiered'
  firstQty: number
  firstAmount: number
  restAmount: number
}

export type Rate = FlatRate | TieredRate

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do.
 *
 * The same split the Location master takes, and for the same reason. Reading
 * is open to everyone who may reach a challan: the entry form offers product
 * names off this collection when a model is pasted, and refusing that to an
 * Operation Executive would make the feature useless to the people who use it
 * most. Writing is Admin-only — a rate is money, one careless edit changes
 * what every future challan in a category is charged at, and there is no
 * per-row owner to scope it to.
 */
export const PRODUCT_RATE_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const PRODUCT_RATE_MANAGE_ROLES: readonly UserRole[] = ['Admin']

/** Rows one page of the rate card may return. */
export const MAX_PRODUCT_RATE_PAGE_SIZE = 100

/**
 * How many product names one model lookup may offer the entry form.
 *
 * A model normally identifies exactly one product. More than a handful coming
 * back means the model text is a prefix somebody is still typing, and a list
 * longer than this helps nobody choose.
 */
export const MAX_MODEL_MATCHES = 8

/**
 * The comparison key a rate row is matched on.
 *
 * The same shape as `comparisonKey` in `challan.constants.ts` and deliberately
 * owned here rather than imported from it: this is the key that decides
 * whether a challan line finds its rate, so the module that defines the rates
 * defines what counts as the same model. `SWG-60N`, `swg 60n` and `SWG60N` are
 * one model written three ways, and a rate card that could not tell would
 * price two of them at nothing.
 *
 * Bangla is kept for the same reason the challan key keeps it — a product name
 * may legitimately be Bangla, and stripping it would collapse every such name
 * to the empty string.
 */
export function rateKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9\u0980-\u09FF]/g, '')
}

/**
 * The keys a challan's model could be answered by.
 *
 * This is the whole reason the matcher works at all, and it comes from what
 * the paperwork actually says. The rate card names a refrigerator model `1D5`;
 * the challan names it `WCF-1D5-GDEL-LX`. Those are the same product, and a
 * comparison of whole strings says they are not \u2014 which is how a correctly
 * seeded card prices nothing.
 *
 * So a line offers two kinds of key. Its **whole** model, for a challan that
 * writes the card's own code; and each **separator-delimited segment** of it,
 * because a Walton code is a hyphenated compound and the card's model is one
 * of its parts.
 *
 * A segment, and never a substring. `1D5` is a whole part of
 * `WCF-1D5-GDEL-LX`, which is strong evidence; but `12` sits inside `W1234`
 * and means nothing there, and the card carries models as short as `09`. A
 * substring rule would find those everywhere and charge an air conditioner
 * rate for a television. This is the same instinct the location resolver
 * follows when it refuses to match a thana without a district: the cost of a
 * miss is a blank somebody fills in, and the cost of a wrong match is a figure
 * nobody ever questions.
 *
 * Order is significant \u2014 the whole key first, then the segments left to right
 * \u2014 because the caller prefers the earliest match.
 */
/**
 * How short a key may be before containment stops being evidence.
 *
 * Two characters is not a model number, it is a coincidence. The card carries
 * models as short as `09`, and `09` sits inside a great many strings.
 */
const MIN_EMBEDDED_KEY_LENGTH = 3

/**
 * How long. No model on the card is longer than this, so generating candidates
 * past it is work that can never match anything.
 */
const MAX_EMBEDDED_KEY_LENGTH = 12

/**
 * How long a challan model this is worth attempting at all. Beyond it the
 * string is not a product code — it is a description somebody pasted — and the
 * candidate list would grow faster than its usefulness.
 */
const MAX_EMBEDDED_SOURCE_LENGTH = 32

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

/**
 * Whether a candidate is distinctive enough to be believed on containment
 * alone: at least one letter **and** at least one digit.
 *
 * This is what separates a model code from a word or a number. `1D5`, `2N5`,
 * `SWG60N` and `25L` all qualify. `JET` does not — three letters turn up
 * inside longer strings for reasons that have nothing to do with
 * refrigerators — and neither does `09`, `12` or `30`. Those still match by
 * the whole-key and segment tiers, which are exact; they simply do not get to
 * be found buried inside something else.
 */
function isDistinctive(key: string): boolean {
  return /[A-Z]/.test(key) && /[0-9]/.test(key)
}

/**
 * Card models buried inside a challan model that carries no separators.
 *
 * The third and weakest tier. `WCF-1D5-GDEL-LX` is answered by the segment
 * rule; `WCF1D5GDELLX` is the same product written without the hyphens, and
 * only containment can see it.
 *
 * Two guards make that safe enough to price on, and both exist because a wrong
 * rate is money and nothing downstream would ever question it:
 *
 * **Distinctiveness** — a candidate needs a letter and a digit, and at least
 * three characters. That is what makes it a code rather than a coincidence.
 *
 * **Digit boundaries** — a candidate starting with a digit may not sit
 * immediately after another digit, and one ending with a digit may not sit
 * immediately before another. This is the rule that stops `25L` being found
 * inside `125L`, which is a different capacity of a different machine. Letter
 * boundaries are deliberately *not* checked: `1D5` in `WCF1D5GDELLX` is
 * flanked by letters, and that is the case this whole tier exists for.
 *
 * Returned longest first, because a longer match is more specific evidence —
 * so a caller trying them in order reaches the best answer before the worst.
 * Ambiguity is still the caller's to refuse: two card rows matching is not a
 * choice this makes.
 */
export function embeddedModelKeys(model: string): string[] {
  const key = rateKey(model)

  if (key.length < MIN_EMBEDDED_KEY_LENGTH || key.length > MAX_EMBEDDED_SOURCE_LENGTH) {
    return []
  }

  const seen = new Set<string>()
  const keys: string[] = []
  const longest = Math.min(MAX_EMBEDDED_KEY_LENGTH, key.length)

  for (let length = longest; length >= MIN_EMBEDDED_KEY_LENGTH; length -= 1) {
    for (let start = 0; start + length <= key.length; start += 1) {
      const end = start + length
      const candidate = key.slice(start, end)

      if (seen.has(candidate) || !isDistinctive(candidate)) {
        continue
      }
      // A number cut out of the middle of a longer number is not a model.
      if (isDigit(candidate[0]) && start > 0 && isDigit(key[start - 1])) {
        continue
      }
      if (isDigit(candidate[length - 1]) && end < key.length && isDigit(key[end])) {
        continue
      }

      seen.add(candidate)
      keys.push(candidate)
    }
  }

  return keys
}

export function modelMatchKeys(model: string): string[] {
  const whole = rateKey(model)
  if (!whole) {
    return []
  }

  const keys = [whole]

  for (const part of model.split(/[^A-Za-z0-9\u0980-\u09FF]+/)) {
    const key = rateKey(part)
    if (key && !keys.includes(key)) {
      keys.push(key)
    }
  }

  return keys
}

/**
 * The rate card writes a model-less row as an empty string, never as "NA".
 *
 * The supplied table prints `NA` in the Model and Capacity columns for
 * products that do not have one — a hair dryer is a hair dryer. `NA` is a
 * spelling of "nothing here", not a model number, and storing it would produce
 * a row that a challan line reading `NA` could match. So the seeder and the
 * validation both reduce it to blank, and blank is what "this rate applies to
 * the product whatever the model" means throughout this module.
 */
const ABSENT_VALUES = new Set(['', 'NA', 'N/A', 'NIL', 'NONE', '-', '--'])

export function normalizeAbsent(value: string): string {
  return ABSENT_VALUES.has(value.trim().toUpperCase()) ? '' : value.trim()
}
