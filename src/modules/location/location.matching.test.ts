import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LocationType } from './location.constants'
import { LOCAL_AUTO_CONFIDENCE, matchLocally, shortlistFor } from './location.matching'
import type { MasterCandidate } from './location.matching'
import { normalizeLocationName } from './location.normalize'

/**
 * The local matcher, which answers most challans on its own.
 *
 * Two kinds of test here, and the second kind is the important one.
 *
 * The first kind asks "does it find the right row when the text is a little
 * wrong" — case, spacing, a trailing "Thana", a typo. Those are the everyday
 * wins.
 *
 * The second kind asks "does it *refuse* when it should". A matcher that
 * always answers is worse than no matcher at all, because a wrong district on
 * a challan is invisible: nothing downstream can tell it from a right one. So
 * there are tests for a thana with no district behind it, for two rows that
 * both fit, and for text that matches nothing — and in every one of them the
 * expected result is no match and a shortlist.
 */

function master(district: string, thana: string, locationType: LocationType): MasterCandidate {
  return {
    id: `${district}/${thana}`,
    district,
    thana,
    locationType,
    normalizedDistrict: normalizeLocationName(district),
    normalizedThana: normalizeLocationName(thana),
  }
}

/**
 * A slice of the real collection, chosen for the collisions in it: two
 * Mirpurs in different districts, two Kaliganjs, a Matlab Dakshin beside a
 * Matlab Uttar, and a Cox's Bazar to carry the apostrophe.
 */
const MASTERS: MasterCandidate[] = [
  master('Dhaka', 'Mirpur Model', 'ISD'),
  master('Dhaka', 'Savar', 'OSD-Thana'),
  master('Dhaka', 'Dhanmondi', 'ISD'),
  master('Dhaka', 'Keraniganj', 'OSD-Thana'),
  master('Kushtia', 'Mirpur', 'OSD-Thana'),
  master('Kushtia', 'Kushtia Sadar', 'OSD-Metro'),
  master('Gazipur', 'Kaliganj', 'OSD-Thana'),
  master('Satkhira', 'Kaliganj', 'OSD-Thana'),
  master('Chandpur', 'Matlab Dakshin', 'OSD-Thana'),
  master('Chandpur', 'Matlab Uttar', 'OSD-Thana'),
  master("Cox's Bazar", "Cox's Bazar Sadar", 'OSD-Metro'),
  master('Chattogram', 'Sitakunda', 'OSD-Thana'),
]

function query(thana: string, district: string, deliveryAddress = '') {
  return { thana, district, deliveryAddress }
}

// ---------------------------------------------------------------------------
// The everyday wins
// ---------------------------------------------------------------------------

describe('matching against the master collection', () => {
  it('matches an exact district and thana', () => {
    const result = matchLocally(query('Savar', 'Dhaka'), MASTERS)

    assert.equal(result.match?.district, 'Dhaka')
    assert.equal(result.match?.thana, 'Savar')
    assert.equal(result.source, 'master_exact')
    assert.equal(result.confidence, 1)
  })

  it('derives the location type from the row it matched, never from the text', () => {
    assert.equal(matchLocally(query('Savar', 'Dhaka'), MASTERS).match?.locationType, 'OSD-Thana')
    assert.equal(
      matchLocally(query('Dhanmondi', 'Dhaka'), MASTERS).match?.locationType,
      'ISD',
    )
    assert.equal(
      matchLocally(query('Kushtia Sadar', 'Kushtia'), MASTERS).match?.locationType,
      'OSD-Metro',
    )
  })

  it('ignores case', () => {
    const result = matchLocally(query('savar', 'DHAKA'), MASTERS)

    assert.equal(result.match?.thana, 'Savar')
    assert.equal(result.source, 'master_normalized')
  })

  it('ignores spacing', () => {
    assert.equal(matchLocally(query('  Savar ', ' Dhaka  '), MASTERS).match?.thana, 'Savar')
    assert.equal(
      matchLocally(query('Matlab  Dakshin', 'Chandpur'), MASTERS).match?.thana,
      'Matlab Dakshin',
    )
  })

  it('ignores punctuation', () => {
    const result = matchLocally(query('Coxs Bazar Sadar', 'Coxs Bazar'), MASTERS)
    assert.equal(result.match?.thana, "Cox's Bazar Sadar")
  })

  it('ignores a trailing "Thana" or "Upazila"', () => {
    assert.equal(matchLocally(query('Savar Thana', 'Dhaka'), MASTERS).match?.thana, 'Savar')
    assert.equal(
      matchLocally(query('Savar Upazila', 'Dhaka District'), MASTERS).match?.thana,
      'Savar',
    )
  })

  it('ignores a trailing "থানা"', () => {
    const bangla = [...MASTERS, master('ঢাকা', 'মিরপুর', 'ISD')]
    const result = matchLocally(query('মিরপুর থানা', 'ঢাকা'), bangla)

    assert.equal(result.match?.thana, 'মিরপুর')
    assert.equal(result.match?.locationType, 'ISD')
  })

  it('forgives a spelling mistake in a long enough name', () => {
    // One letter wrong in "Keraniganj", with a stated district to anchor it.
    const result = matchLocally(query('Keranigonj', 'Dhaka'), MASTERS)

    assert.equal(result.match?.thana, 'Keraniganj')
    assert.equal(result.source, 'master_fuzzy')
  })

  it('forgives a spelling mistake in the district too', () => {
    const result = matchLocally(query('Sitakunda', 'Chattagram'), MASTERS)
    assert.equal(result.match?.district, 'Chattogram')
  })

  it('reaches a longer master name from its leading word', () => {
    // "Mirpur" in Dhaka is Mirpur Model, and only Mirpur Model.
    const result = matchLocally(query('Mirpur', 'Dhaka'), MASTERS)

    assert.equal(result.match?.thana, 'Mirpur Model')
    assert.equal(result.match?.district, 'Dhaka')
    assert.equal(result.source, 'master_fuzzy')
  })
})

// ---------------------------------------------------------------------------
// Reading the address, when the fields do not say
// ---------------------------------------------------------------------------

describe('falling back to the delivery address', () => {
  it('finds both the district and the thana in an address', () => {
    const result = matchLocally(
      query('', '', 'House 10, Road 5, Savar, Dhaka'),
      MASTERS,
    )

    assert.equal(result.match?.district, 'Dhaka')
    assert.equal(result.match?.thana, 'Savar')
    assert.equal(result.source, 'master_fuzzy')
    assert.ok(result.confidence >= LOCAL_AUTO_CONFIDENCE)
  })

  it('uses the address for the district when only the thana was entered', () => {
    const result = matchLocally(
      query('Mirpur', '', 'Plot 3, Mirpur DOHS, Dhaka'),
      MASTERS,
    )

    assert.equal(result.match?.district, 'Dhaka')
    assert.equal(result.match?.thana, 'Mirpur Model')
  })

  /**
   * Also found against the real list. "Mirpur DOHS" is in Dhaka, and Dhaka's
   * row is "Mirpur Model" — so the exact-term address tier finds nothing and,
   * without this, the challan comes back with no candidates at all. That is
   * worse than an uncertain shortlist: there is nothing for the assisted step
   * to choose between and nothing to offer a person.
   *
   * It must not resolve on its own, though. Mirpur DOHS is genuinely not
   * Mirpur Model thana, and a tier confident enough to say so would be
   * confidently wrong.
   */
  it('offers candidates when the address names part of a longer master name', () => {
    const result = matchLocally(
      query('', '', 'Plot 3, Road 2, Mirpur DOHS, Dhaka'),
      MASTERS,
    )

    assert.equal(result.match, null)
    assert.ok(result.confidence < LOCAL_AUTO_CONFIDENCE)
    assert.ok(result.candidates.some((scored) => scored.candidate.thana === 'Mirpur Model'))
  })

  it('will not settle on an address naming two districts it knows', () => {
    /**
     * "Dhaka to Kushtia" is a note about a journey, not a statement of where
     * the goods are going. Kushtia has a thana spelled exactly "Mirpur" and
     * Dhaka does not, so without this rule the address would quietly decide
     * the district on a spelling coincidence.
     */
    const result = matchLocally(query('Mirpur', '', 'Dhaka to Kushtia, Mirpur'), MASTERS)

    assert.equal(result.match, null)
    assert.ok(result.confidence < LOCAL_AUTO_CONFIDENCE)
    // Still offered, so a person or the assisted step can settle it.
    assert.equal(result.candidates[0].candidate.district, 'Kushtia')
    assert.ok(shortlistFor(result, MASTERS, 12).length > 1)
  })
})

// ---------------------------------------------------------------------------
// The refusals, which matter more
// ---------------------------------------------------------------------------

describe('refusing to guess', () => {
  /**
   * The rule the whole feature turns on. There is a Mirpur in Kushtia and a
   * Mirpur Model in Dhaka; a challan that says only "Mirpur" has not said
   * which, and filing it as Kushtia because that spelling happens to be exact
   * would be wrong far more often than right.
   */
  it('never resolves a thana with no district behind it', () => {
    const result = matchLocally(query('Mirpur', ''), MASTERS)

    assert.equal(result.match, null)
    assert.ok(result.confidence < LOCAL_AUTO_CONFIDENCE)
    assert.ok(result.candidates.some((scored) => scored.candidate.district === 'Kushtia'))
  })

  it('never resolves an unambiguous thana with no district either', () => {
    // "Sitakunda" exists once in the whole collection, and it still is not
    // enough: the rule is about evidence, not about how lucky the text is.
    const result = matchLocally(query('Sitakunda', ''), MASTERS)

    assert.equal(result.match, null)
    assert.equal(result.candidates[0].candidate.thana, 'Sitakunda')
  })

  it('refuses when two rows fit equally well', () => {
    // Kaliganj is in Gazipur and in Satkhira, and nothing here says which.
    const result = matchLocally(query('Kaliganj', ''), MASTERS)

    assert.equal(result.match, null)
    assert.equal(result.ambiguous, true)
    assert.equal(result.candidates.length, 2)
  })

  /**
   * Found by running the matcher over the real seeded list rather than this
   * fixture, and worth keeping as a test because it is the exact failure this
   * module exists to prevent — a single, confident, *wrong* answer.
   *
   * Cumilla has "Cumilla Sadar", "Sadar Dakshin" and "South Sadar". Matching
   * only on a leading word, "Sadar" hits "Sadar Dakshin" alone, comes back
   * unambiguous, and files a Cumilla Sadar delivery under a different thana.
   * Matching a trailing word too makes it three, and three is a refusal.
   */
  it('will not read a generic word as the one thana that happens to start with it', () => {
    const cumilla = [
      master('Cumilla', 'Cumilla Sadar', 'OSD-Metro'),
      master('Cumilla', 'Sadar Dakshin', 'OSD-Metro'),
      master('Cumilla', 'South Sadar', 'OSD-Metro'),
      master('Cumilla', 'Barura', 'OSD-Thana'),
    ]

    const result = matchLocally(query('Sadar', 'Cumilla'), cumilla)

    assert.equal(result.match, null)
    assert.equal(result.ambiguous, true)
    assert.equal(result.candidates.length, 3)
  })

  it('does not let a typo merge two places that differ by a real word', () => {
    // Matlab Dakshin and Matlab Uttar are two thanas, not one misspelled.
    const result = matchLocally(query('Matlab', 'Chandpur'), MASTERS)

    assert.equal(result.match, null)
    assert.equal(result.ambiguous, true)
    assert.deepEqual(
      result.candidates.map((scored) => scored.candidate.thana).sort(),
      ['Matlab Dakshin', 'Matlab Uttar'],
    )
  })

  it('gives a short name no room for a typo at all', () => {
    const small = [master('Cox’s Bazar', 'Ramu', 'OSD-Thana')]
    assert.equal(matchLocally(query('Rama', "Cox's Bazar"), small).match, null)
  })

  it('finds nothing in text that is nothing like a place', () => {
    const result = matchLocally(query('Zzzz', 'Qqqq', 'no address at all'), MASTERS)

    assert.equal(result.match, null)
    assert.equal(result.candidates.length, 0)
    assert.equal(result.ambiguous, false)
  })

  it('finds nothing when there is nothing to look at', () => {
    const result = matchLocally(query('', '', ''), MASTERS)

    assert.equal(result.match, null)
    assert.equal(result.candidates.length, 0)
  })

  /**
   * Not a test of the matcher so much as of the contract it is used under: the
   * resolver loads active rows only, so a deactivated pair is never in the
   * pool and can never come back — from any tier, and from Gemini, whose
   * candidates are drawn from this same list.
   */
  it('cannot return a row that is not in the collection it was given', () => {
    const withoutSavar = MASTERS.filter((row) => row.thana !== 'Savar')
    const result = matchLocally(query('Savar', 'Dhaka'), withoutSavar)

    assert.equal(result.match, null)
    assert.ok(!result.candidates.some((scored) => scored.candidate.thana === 'Savar'))
  })
})

// ---------------------------------------------------------------------------
// The shortlist
// ---------------------------------------------------------------------------

describe('the shortlist handed on for assistance', () => {
  it('never exceeds its cap', () => {
    const local = matchLocally(query('Mirpur', ''), MASTERS)
    assert.ok(shortlistFor(local, MASTERS, 3).length <= 3)
  })

  it('is drawn entirely from the master collection', () => {
    const local = matchLocally(query('Kaliganj', ''), MASTERS)
    const shortlist = shortlistFor(local, MASTERS, 12)

    assert.ok(shortlist.length > 0)
    for (const candidate of shortlist) {
      assert.ok(MASTERS.some((row) => row.id === candidate.id))
    }
  })

  it('widens a thin list with the rest of the districts already on it', () => {
    const local = matchLocally(query('Keranigonj', 'Dhaka'), MASTERS)
    const shortlist = shortlistFor(local, MASTERS, 12)

    // Every addition is still a Dhaka row: the operator's likely mistake is
    // the thana, not the district they stated.
    assert.ok(shortlist.length > local.candidates.length)
    assert.ok(shortlist.every((candidate) => candidate.district === 'Dhaka'))
  })

  it('has nothing to offer when nothing matched', () => {
    const local = matchLocally(query('Zzzz', 'Qqqq'), MASTERS)
    assert.deepEqual(shortlistFor(local, MASTERS, 12), [])
  })
})
