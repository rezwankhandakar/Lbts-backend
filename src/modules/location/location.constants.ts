import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Location vocabulary. The frontend mirrors
 * this file at `LBTS-Frontend/src/features/location/types/index.ts`, which adds
 * display metadata and nothing else. Change one, change both.
 */

/**
 * What kind of place a district/thana pair is, for the transport operation.
 *
 * A closed set, and deliberately not something a challan form can type. The
 * classification belongs to the pair, not to the delivery — Mirpur Model is
 * ISD whoever is delivering there — so it is read off the master record and
 * never entered beside it. That is the whole reason the master collection
 * exists rather than three free-text fields.
 */
export const LOCATION_TYPES = ['ISD', 'OSD-Thana', 'OSD-Metro'] as const
export type LocationType = (typeof LOCATION_TYPES)[number]

/**
 * How a challan's district and thana came to be decided.
 *
 * Recorded on the record because the four mechanisms are not equally
 * trustworthy and a wrong one has to be findable afterwards. `admin_manual` is
 * the only one a person produced, and it is the only one nothing may overwrite.
 */
export const LOCATION_SOURCES = [
  /** The text matched a master district and thana exactly, byte for byte. */
  'master_exact',
  /** It matched after normalisation — case, spacing, punctuation, a suffix. */
  'master_normalized',
  /** A single close-enough candidate, with nothing else near it. */
  'master_fuzzy',
  /** Gemini picked one of the candidates this server supplied. */
  'gemini_assisted',
  /** Somebody chose it. The final authority; never re-resolved over. */
  'admin_manual',
] as const
export type LocationSource = (typeof LOCATION_SOURCES)[number]

/**
 * Whether a challan's location is settled.
 *
 * Two values, because there are two states worth telling apart: a location
 * that came off the master collection, and one nobody has determined yet. A
 * third state for "the machine had a guess it was not sure about" would be a
 * wrong location wearing a hedge, and this module's central rule is that a
 * blank beats a wrong one.
 */
export const LOCATION_STATUSES = ['Verified', 'Pending'] as const
export type LocationStatus = (typeof LOCATION_STATUSES)[number]

export const PENDING_LOCATION_STATUS: LocationStatus = 'Pending'

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do.
 *
 * Reading the master collection is open to everyone who may reach a challan —
 * the entry form needs it to offer a cascading selector, and a challan list
 * needs it to say what a location type means. Writing it is Admin-only: this
 * is reference data the whole operation classifies deliveries against, and one
 * careless edit re-classifies every future challan in a district.
 */
export const LOCATION_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const LOCATION_MANAGE_ROLES: readonly UserRole[] = ['Admin']

/** Rows one page of the master list may return. */
export const MAX_LOCATION_PAGE_SIZE = 100

/**
 * How many master rows the resolver will put in front of Gemini.
 *
 * Small on purpose. Sending the collection would cost tokens, leak more of the
 * operation's reference data than the question needs, and — the part that
 * actually matters — give the model room to pick something plausible from far
 * away. A shortlist the local matcher already believes in is a much narrower
 * question than "which of six hundred".
 */
export const MAX_GEMINI_CANDIDATES = 12

/**
 * How sure Gemini has to be before its answer is written to a challan.
 *
 * Overridable from the environment, but never downwards past this floor: the
 * business rule is that a blank location beats a wrong one, and a threshold
 * low enough to always answer would quietly invert it.
 */
export const MIN_GEMINI_CONFIDENCE = 0.7
