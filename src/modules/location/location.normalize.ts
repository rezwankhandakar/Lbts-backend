/**
 * Turning what somebody typed into something two strings can be compared on.
 *
 * A challan's thana and district are transcribed off a PDF by hand, or pasted
 * out of one, or typed from memory over the phone. "Mirpur", "mirpur",
 * "Mirpur Thana", "Mirpur, Dhaka", "মিরপুর" and "মিরপুর থানা" are one place
 * written six ways, and a system that cannot see that files the same place as
 * six different locations and can report on none of them.
 *
 * Two rules shape everything here:
 *
 * 1. **Nothing is destroyed.** These functions produce a *comparison* value.
 *    The text the operator typed is stored beside it, unchanged, and is what
 *    the record and the printed page show. Normalisation is a lens, not an
 *    edit.
 * 2. **Only meaningless differences are removed.** Case, spacing, punctuation
 *    and the words that mean "this is a thana" carry no information. "Sadar",
 *    "Uttar", "Dakshin", "Model" and "Metro" do — Matlab Dakshin and Matlab
 *    Uttar are two places — so they stay. A normaliser that removed them would
 *    merge records that are genuinely different, which is the one failure this
 *    module must not have.
 *
 * The file imports nothing, so it can be unit tested on its own and read
 * without following anything.
 */

/**
 * Words that say what kind of administrative unit this is, rather than which
 * one. Stripped only from the end, and only while something is left over.
 *
 * `sadar` is deliberately absent: "Comilla Sadar" and "Comilla" are different
 * rows in the master collection.
 */
const SUFFIXES: readonly string[] = [
  'police station',
  'thana',
  'upazila',
  'upazilla',
  'upozila',
  'upazella',
  'upzila',
  'district',
  'zilla',
  'zila',
  'jela',
  'জেলা',
  'থানা',
  'উপজেলা',
]

/**
 * The same list, longest first \u2014 which is not a tidiness choice.
 *
 * A Bangla suffix has no space in front of it to anchor on, and \u0989\u09AA\u099C\u09C7\u09B2\u09BE *ends
 * with* \u099C\u09C7\u09B2\u09BE. Tried in declaration order, "\u09B8\u09BE\u09AD\u09BE\u09B0 \u0989\u09AA\u099C\u09C7\u09B2\u09BE" would have \u099C\u09C7\u09B2\u09BE taken
 * off it and be left as "\u09B8\u09BE\u09AD\u09BE\u09B0 \u0989\u09AA" \u2014 a name that matches nothing. Longest
 * first, plus one strip per pass, is what stops a shorter suffix eating into
 * what a longer one left behind.
 */
const LONGEST_SUFFIX_FIRST: readonly string[] = [...SUFFIXES].sort(
  (a, b) => b.length - a.length,
)

/** The Bangla block, so a value can be recognised as Bangla without a library. */
const BANGLA = /[\u0980-\u09FF]/

/**
 * The comparison form of a place name: lower case, no punctuation, single
 * spaces, no trailing "thana"/"upazila"/"জেলা".
 *
 * Apostrophes are removed rather than kept, so "Cox's Bazar" and "Coxs Bazar"
 * — both of which arrive — reduce to the same thing.
 */
export function normalizeLocationName(value: string): string {
  const base = value
    .normalize('NFC')
    .toLowerCase()
    // Straight and curly apostrophes vanish rather than becoming a space, or
    // "cox's" would split into two tokens and stop matching "coxs".
    .replace(/['\u2018\u2019\u02bc]/g, '')
    /**
     * Everything that is not a letter, a digit, a combining mark or a space
     * becomes a space. Hyphens included: "Cox-s Bazar" and "Cox s Bazar" are
     * the same mistake.
     *
     * `\p{M}` is not decoration. Bangla vowel signs — the আ-কার in থানা, the
     * ে in মেহেরপুর — are nonspacing marks, not letters, so a class of
     * `\p{L}\p{N}` alone would blank every one of them and reduce থানা to
     * "থ ন". Every Bangla place name in the collection would have matched
     * nothing at all.
     */
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return stripUnitSuffix(base)
}

/**
 * Removes trailing "thana", "upazila" and their Bangla equivalents, repeatedly
 * — "mirpur thana upazila" is not a sentence anybody would write on purpose,
 * but it is one a paste can produce.
 *
 * Never strips down to nothing: a value that is *only* the word "Thana" is
 * meaningless either way, and returning an empty string would make it match
 * every other empty value in the collection.
 */
function stripUnitSuffix(value: string): string {
  let current = value

  for (let pass = 0; pass < 3; pass += 1) {
    const before = current

    for (const suffix of LONGEST_SUFFIX_FIRST) {
      // Bangla suffixes are frequently written without the space that an
      // English one always has, so the separator is optional for those.
      const separator = BANGLA.test(suffix) ? '\\s*' : '\\s+'
      const pattern = new RegExp(separator + escapeRegex(suffix) + '$')
      const stripped = current.replace(pattern, '').trim()

      if (stripped.length > 0 && stripped !== current) {
        current = stripped
        // One strip per pass, or the shorter suffixes would keep eating into
        // what a longer one left behind — see LONGEST_SUFFIX_FIRST.
        break
      }
    }

    if (current === before) {
      break
    }
  }

  return current
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The whitespace-blind form of a normalised name.
 *
 * "Cox s Bazar", "CoxsBazar" and "cox  s   bazar" all reduce to `coxsbazar`.
 * Used for the tier below an exact normalised match, where spacing is the only
 * remaining difference — which on a value typed off a PDF it very often is.
 */
export function tightLocationKey(value: string): string {
  return normalizeLocationName(value).replace(/\s+/g, '')
}

/**
 * Edit distance, capped.
 *
 * The cap is not an optimisation so much as a statement: beyond a few edits
 * two place names are not a typo of each other, they are different places, and
 * a number saying "nineteen" is no more useful than one saying "too far". It
 * also keeps the inner loop bounded when this is run across the whole master
 * collection for one lookup.
 */
export function editDistance(a: string, b: string, cap = 4): number {
  if (a === b) {
    return 0
  }
  if (Math.abs(a.length - b.length) > cap) {
    return cap + 1
  }

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let rowBest = i

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, substitution)
      current.push(value)
      rowBest = Math.min(rowBest, value)
    }

    // Every remaining row can only add to the best value on this one, so once
    // the whole row is past the cap the answer is already known.
    if (rowBest > cap) {
      return cap + 1
    }

    previous = current
  }

  return previous[b.length]
}

/**
 * How many edits are tolerable for a name of this length.
 *
 * Proportional rather than fixed, because one wrong letter in "Ramu" is a
 * different place and one wrong letter in "Brahmanbaria" is a slip of the
 * hand. Short names get no slack at all below five characters — there are too
 * many four-letter thanas one edit apart.
 */
export function fuzzyTolerance(length: number): number {
  if (length <= 4) {
    return 0
  }
  if (length <= 7) {
    return 1
  }
  if (length <= 12) {
    return 2
  }
  return 3
}

/**
 * The word groups an address might contain a place name in.
 *
 * "House 10, Road 5, Mirpur DOHS, Dhaka" holds its thana and its district as
 * ordinary words among a dozen others, so the only honest way to find them is
 * to try every short run of words against the master collection and see which
 * ones are places. Runs of one to three words, because "Cox's Bazar Sadar" is
 * three and nothing in the collection is four.
 *
 * Deliberately not a parser. An address has no grammar to rely on — the
 * commas are decoration, the order varies, and half of these are typed by
 * somebody in a hurry. Candidate terms and a master collection to check them
 * against is the whole idea.
 */
export function addressTerms(address: string, maxWords = 3): string[] {
  const words = normalizeLocationName(address)
    .split(' ')
    .filter((word) => word.length > 0)

  const terms = new Set<string>()

  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= maxWords && start + size <= words.length; size += 1) {
      terms.add(words.slice(start, start + size).join(' '))
    }
  }

  return [...terms]
}
