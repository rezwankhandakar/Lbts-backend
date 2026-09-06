import type { LocationSource, LocationType } from './location.constants'
import {
  addressTerms,
  editDistance,
  fuzzyTolerance,
  normalizeLocationName,
  tightLocationKey,
} from './location.normalize'

/**
 * Finding a master location for what somebody wrote on a challan, using
 * nothing but the master collection and arithmetic.
 *
 * This runs first, always, and answers most challans on its own. Gemini exists
 * for the residue this cannot settle — and the residue is smaller than it
 * looks, because almost every "unmatched" thana is a case difference, a
 * trailing "Thana", a missing space or one wrong letter.
 *
 * Two properties are worth stating before the code, because everything here
 * is arranged around them:
 *
 * **A match needs a district.** A thana on its own is not enough, however
 * confident the string comparison is. There is a Mirpur in Kushtia and a
 * Mirpur Model in Dhaka; a challan that says only "Mirpur" is a challan that
 * has not said which. Without evidence of a district — from the district
 * field, or from the delivery address — nothing here scores high enough to be
 * written to a record. It becomes a candidate, and a candidate is a question.
 *
 * **A tie is a refusal.** When the best tier holds more than one master row,
 * this returns no match at all rather than the first one. Guessing between two
 * real places is the failure mode the whole feature exists to avoid.
 *
 * The file is pure — it takes the master rows as an argument and touches no
 * database, no clock and no network — so the decisions above are testable as
 * decisions rather than as an integration.
 */

/** One master row, reduced to what matching needs. */
export interface MasterCandidate {
  id: string
  district: string
  thana: string
  locationType: LocationType
  normalizedDistrict: string
  normalizedThana: string
}

/** What a challan says about where it is going. Any of it may be blank. */
export interface LocationQuery {
  thana: string
  district: string
  deliveryAddress: string
}

export interface ScoredCandidate {
  candidate: MasterCandidate
  confidence: number
  /** Why it is on the list, in words a person can check. */
  reason: string
}

export interface LocalMatch {
  /** The one row this is confident about, or null. */
  match: MasterCandidate | null
  confidence: number
  /** How it was found. Null when nothing was. */
  source: Extract<
    LocationSource,
    'master_exact' | 'master_normalized' | 'master_fuzzy'
  > | null
  /**
   * The shortlist. Populated whether or not there was a match — a confident
   * match still lists what else was near it, and an unconfident one is
   * exactly what gets put in front of Gemini or in front of a person.
   */
  candidates: ScoredCandidate[]
  /** True when the best tier held more than one row and none was chosen. */
  ambiguous: boolean
}

/**
 * How sure the local matcher has to be before a result is written to a
 * challan without asking anything else.
 *
 * Anything below this is not wrong — it is a shortlist. It goes to Gemini if
 * Gemini is available, and to a person if it is not.
 */
export const LOCAL_AUTO_CONFIDENCE = 0.85

/**
 * The tiers, in the order they are tried. The first one that matches anything
 * is the answer; nothing below it is consulted, because a normalised match and
 * a fuzzy one are not comparable quantities to be ranked against each other.
 */
const TIER_CONFIDENCE = {
  /** The typed district and thana are the master row, character for character. */
  exact: 1,
  /** Same after case, punctuation and a trailing "Thana" are set aside. */
  normalized: 0.97,
  /** Same again once spacing is ignored: "Coxs Bazar", "coxsbazar". */
  tight: 0.95,
  /** One is a leading word of the other: "Mirpur" against "Mirpur Model". */
  prefix: 0.88,
  /** Within an edit or three, and nothing else that close. */
  fuzzy: 0.86,
  /** The thana was not stated; the delivery address contains its name. */
  address: 0.88,
  /**
   * The address contains a *part* of a master name. Below
   * `LOCAL_AUTO_CONFIDENCE` on purpose and at every level of district
   * evidence: this tier exists to produce candidates for somebody to choose
   * between, never to choose.
   */
  addressPrefix: 0.6,
} as const

type Tier = keyof typeof TIER_CONFIDENCE

/**
 * What each tier is worth once the district is only inferred rather than
 * stated.
 *
 * Small, because a district name written out in an address is good evidence:
 * "House 10, Road 5, Savar, Dhaka" says Dhaka as plainly as a form field
 * would. What it costs is the two weakest tiers — a typo'd thana under an
 * inferred district no longer resolves on its own, and goes to be asked about
 * instead.
 */
const ADDRESS_DISTRICT_PENALTY = 0.98

/**
 * The ceiling when there is no district evidence at all.
 *
 * Deliberately below `LOCAL_AUTO_CONFIDENCE`, so this branch can never write a
 * location by itself however exact the thana match was. It is the rule that
 * "Mirpur" alone must not become Kushtia, expressed as a number.
 */
const NO_DISTRICT_CEILING = 0.7

const TIER_SOURCE: Record<Tier, LocalMatch['source']> = {
  exact: 'master_exact',
  normalized: 'master_normalized',
  tight: 'master_normalized',
  prefix: 'master_fuzzy',
  fuzzy: 'master_fuzzy',
  address: 'master_fuzzy',
  addressPrefix: 'master_fuzzy',
}

const TIER_REASON: Record<Tier, string> = {
  exact: 'District and thana match the master record exactly.',
  normalized: 'Matches the master record once case, spacing and suffixes are set aside.',
  tight: 'Matches the master record once spacing and punctuation are ignored.',
  prefix: 'The master thana begins with what was entered.',
  fuzzy: 'Within a typo of the master thana, and nothing else is that close.',
  address: 'The delivery address contains this thana.',
  addressPrefix: 'The delivery address mentions part of this thana name.',
}

interface DistrictEvidence {
  /** Normalised district names the query supports. Empty means none. */
  keys: string[]
  /** True when the district field said so, rather than the address implying it. */
  stated: boolean
  /**
   * True when the address named more than one district it recognises.
   *
   * The keys are still used to narrow the pool — one of them is probably
   * right, and a shortlist drawn from two districts is far better than one
   * drawn from the whole country — but they carry no confidence. "Dhaka to
   * Kushtia, Mirpur" is a note about a journey, not a statement of where the
   * goods are going, and this is the case that would otherwise quietly file it
   * under whichever district happened to spell its thana exactly.
   */
  contested: boolean
}

/**
 * Which districts this query is about.
 *
 * The district field first, because it is somebody's stated answer; the
 * delivery address only if the field is blank or says something the master
 * collection has never heard of. More than one district may come back — an
 * address can name two — and that is left for the thana tiers to narrow rather
 * than being resolved by picking one.
 */
function districtEvidenceFor(
  query: LocationQuery,
  masters: readonly MasterCandidate[],
  terms: ReadonlySet<string>,
): DistrictEvidence {
  const districts = new Set(masters.map((master) => master.normalizedDistrict))
  const stated = normalizeLocationName(query.district)

  if (stated) {
    if (districts.has(stated)) {
      return { keys: [stated], stated: true, contested: false }
    }

    // A district nobody in the master collection has under that spelling.
    // One close enough, and only one, is a typo; two is a question.
    const tight = tightLocationKey(query.district)
    const tolerance = fuzzyTolerance(tight.length)
    const near = [...districts].filter(
      (key) => editDistance(tightLocationKey(key), tight, tolerance) <= tolerance,
    )

    if (near.length === 1) {
      return { keys: near, stated: true, contested: false }
    }
  }

  const fromAddress = [...districts].filter((key) => terms.has(key))
  if (fromAddress.length > 0) {
    return { keys: fromAddress, stated: false, contested: fromAddress.length > 1 }
  }

  return { keys: [], stated: false, contested: false }
}

/** The rows a tier is allowed to consider, given what is known about the district. */
function poolFor(
  masters: readonly MasterCandidate[],
  evidence: DistrictEvidence,
): readonly MasterCandidate[] {
  if (evidence.keys.length === 0) {
    return masters
  }
  return masters.filter((master) => evidence.keys.includes(master.normalizedDistrict))
}

/**
 * The rows matching one tier.
 *
 * Each tier is a predicate and nothing more; the ordering between them is in
 * `matchLocally`, where it can be read in one place.
 */
function rowsForTier(
  tier: Tier,
  query: LocationQuery,
  pool: readonly MasterCandidate[],
  terms: ReadonlySet<string>,
): MasterCandidate[] {
  const thanaNorm = normalizeLocationName(query.thana)
  const thanaTight = tightLocationKey(query.thana)

  switch (tier) {
    case 'exact': {
      const district = query.district.trim()
      const thana = query.thana.trim()
      if (!district || !thana) {
        return []
      }
      return pool.filter((master) => master.district === district && master.thana === thana)
    }

    case 'normalized':
      return thanaNorm ? pool.filter((master) => master.normalizedThana === thanaNorm) : []

    case 'tight':
      return thanaTight
        ? pool.filter((master) => tightLocationKey(master.normalizedThana) === thanaTight)
        : []

    case 'prefix':
      /**
       * One name is a whole-word part of the other. "Mirpur" reaching "Mirpur
       * Model" is the case this exists for; "Ram" must not reach "Ramu", which
       * is why only whole words count.
       *
       * The *suffix* half is not symmetry for its own sake — it is what stops
       * this tier being confidently wrong. Cumilla has "Cumilla Sadar",
       * "Sadar Dakshin" and "South Sadar"; matching only on a leading word,
       * the query "Sadar" would hit "Sadar Dakshin" alone, come back as a
       * single unambiguous answer, and file a Cumilla Sadar delivery under a
       * different thana. Matching a trailing word too makes it three, and
       * three is a refusal.
       */
      return thanaNorm.length >= 3
        ? pool.filter(
            (master) =>
              master.normalizedThana.startsWith(thanaNorm + ' ') ||
              master.normalizedThana.endsWith(' ' + thanaNorm) ||
              thanaNorm.startsWith(master.normalizedThana + ' ') ||
              thanaNorm.endsWith(' ' + master.normalizedThana),
          )
        : []

    case 'fuzzy': {
      if (!thanaTight) {
        return []
      }
      const tolerance = fuzzyTolerance(thanaTight.length)
      if (tolerance === 0) {
        return []
      }
      return pool.filter(
        (master) =>
          editDistance(tightLocationKey(master.normalizedThana), thanaTight, tolerance) <=
          tolerance,
      )
    }

    case 'address':
      return pool.filter((master) => terms.has(master.normalizedThana))

    case 'addressPrefix':
      /**
       * The address names a place the master spells longer: "Mirpur DOHS,
       * Dhaka" against a collection whose Dhaka row is "Mirpur Model".
       *
       * Deliberately scored below `LOCAL_AUTO_CONFIDENCE`, so it can never
       * resolve on its own — and it should not. Mirpur DOHS is in Dhaka but it
       * is not Mirpur Model thana, and a tier confident enough to say so would
       * be confidently wrong. What it is for is the alternative to silence:
       * without it this query produces no candidates at all, and a challan
       * nobody can be helped with is worse than one somebody is offered three
       * plausible rows for.
       *
       * Four characters minimum, or an address containing "new" would drag in
       * New Market.
       */
      return [...terms]
        .filter((term) => term.length >= 4)
        .flatMap((term) =>
          pool.filter(
            (master) =>
              master.normalizedThana.startsWith(term + ' ') ||
              master.normalizedThana.endsWith(' ' + term),
          ),
        )
        .filter((master, index, all) => all.indexOf(master) === index)

    default:
      return []
  }
}

const TIER_ORDER: readonly Tier[] = [
  'exact',
  'normalized',
  'tight',
  'prefix',
  'fuzzy',
  'address',
  'addressPrefix',
]

function confidenceFor(tier: Tier, evidence: DistrictEvidence): number {
  if (evidence.keys.length === 0 || evidence.contested) {
    return Math.min(TIER_CONFIDENCE[tier], NO_DISTRICT_CEILING)
  }
  if (evidence.stated) {
    return TIER_CONFIDENCE[tier]
  }
  return Number((TIER_CONFIDENCE[tier] * ADDRESS_DISTRICT_PENALTY).toFixed(3))
}

/**
 * The local answer for one challan.
 *
 * Tiers are tried in order and the first that finds anything is the answer.
 * Exactly one row at that tier, scored at or above `LOCAL_AUTO_CONFIDENCE`, is
 * a match. Anything else — several rows, or one that did not score high enough
 * — comes back as a shortlist with no match, which is a question rather than a
 * guess.
 */
export function matchLocally(
  query: LocationQuery,
  masters: readonly MasterCandidate[],
): LocalMatch {
  const terms = new Set(addressTerms(query.deliveryAddress))
  const evidence = districtEvidenceFor(query, masters, terms)
  const pool = poolFor(masters, evidence)

  for (const tier of TIER_ORDER) {
    const rows = rowsForTier(tier, query, pool, terms)
    if (rows.length === 0) {
      continue
    }

    const confidence = confidenceFor(tier, evidence)
    const candidates = rows
      .map((candidate) => ({ candidate, confidence, reason: TIER_REASON[tier] }))
      .sort(byDistrictThenThana)

    /**
     * One row, and confident enough. Anything else falls through to the
     * shortlist deliberately: two rows at the same tier are two real places
     * and this has no way to tell them apart, and a single row below the
     * threshold is a district nobody actually stated.
     */
    if (rows.length === 1 && confidence >= LOCAL_AUTO_CONFIDENCE) {
      return {
        match: rows[0],
        confidence,
        source: TIER_SOURCE[tier],
        candidates,
        ambiguous: false,
      }
    }

    return {
      match: null,
      confidence,
      source: null,
      candidates,
      ambiguous: rows.length > 1,
    }
  }

  return { match: null, confidence: 0, source: null, candidates: [], ambiguous: false }
}

function byDistrictThenThana(a: ScoredCandidate, b: ScoredCandidate): number {
  return (
    a.candidate.district.localeCompare(b.candidate.district) ||
    a.candidate.thana.localeCompare(b.candidate.thana)
  )
}

/**
 * The shortlist Gemini is shown, capped.
 *
 * Anything the local matcher put on the list, plus — when the list is short —
 * the other thanas of the districts already on it, because the operator's most
 * likely mistake is the thana rather than the district. Never the collection:
 * a wide list costs tokens, leaks more reference data than the question needs
 * and gives the model room to reach for something far away.
 */
export function shortlistFor(
  local: LocalMatch,
  masters: readonly MasterCandidate[],
  limit: number,
): MasterCandidate[] {
  const chosen: MasterCandidate[] = []
  const seen = new Set<string>()

  for (const scored of local.candidates) {
    if (chosen.length >= limit) {
      break
    }
    if (!seen.has(scored.candidate.id)) {
      seen.add(scored.candidate.id)
      chosen.push(scored.candidate)
    }
  }

  if (chosen.length === 0 || chosen.length >= limit) {
    return chosen
  }

  const districts = new Set(chosen.map((candidate) => candidate.normalizedDistrict))
  for (const master of masters) {
    if (chosen.length >= limit) {
      break
    }
    if (districts.has(master.normalizedDistrict) && !seen.has(master.id)) {
      seen.add(master.id)
      chosen.push(master)
    }
  }

  return chosen
}
