import { config } from '../../config/index'
import { AppError } from '../../utils/app-error'
import { MAX_GEMINI_CANDIDATES } from './location.constants'
import type { LocationSource, LocationStatus, LocationType } from './location.constants'
import { chooseWithGemini } from './location.gemini'
import { LOCAL_AUTO_CONFIDENCE, matchLocally, shortlistFor } from './location.matching'
import type { LocationQuery, MasterCandidate } from './location.matching'
import { LocationMasterModel } from './location.model'

/**
 * The Location Resolver: what a challan's district and thana are, given what
 * somebody typed.
 *
 * Five steps, in this order, and the order is the design:
 *
 * 1. an exact match against the master collection;
 * 2. a normalised one — case, spacing, punctuation, a trailing "Thana";
 * 3. a close one, and only if nothing else is that close;
 * 4. the delivery address, when the thana and district fields are no help;
 * 5. Gemini, choosing between candidates the four steps above produced.
 *
 * and then, when all five come to nothing, a person.
 *
 * Steps one to four are local, free and answer the great majority of
 * challans. Step five is reached only for the residue, is given a shortlist
 * rather than the collection, and cannot produce anything that was not on
 * that shortlist. Step six is not a failure mode — it is the designed
 * outcome for a challan that genuinely does not say where it is going, and
 * the module is built so that reaching it costs nothing at all: the challan
 * files, the document generates, the batch completes, and an administrator
 * sets the location later.
 *
 * Nothing in this file throws. A resolver that could fail would be a resolver
 * that could stop somebody filing a challan, and an optional enrichment must
 * never be able to do that.
 */

/** What gets written onto a challan when a location is settled. */
export interface ResolvedLocation {
  masterId: string
  district: string
  thana: string
  locationType: LocationType
  source: LocationSource
  confidence: number
}

/** A row offered to a person to choose from. Never an internal shape. */
export interface LocationCandidate {
  id: string
  district: string
  thana: string
  locationType: LocationType
}

export interface LocationResolution {
  resolved: ResolvedLocation | null
  status: LocationStatus
  /**
   * What happened, phrased for an operator. It is shown beside the fields and
   * never carries a driver message, an HTTP status or a model's own words.
   */
  message: string
  /** What it was choosing between, so a person can finish the job. */
  candidates: LocationCandidate[]
  /** Whether the assisted step ran. Diagnostic; not shown to operators. */
  usedGemini: boolean
}

const PENDING_MESSAGE =
  'The district and thana could not be determined from what was entered. This challan can still be filed; an administrator can set the location later.'

function pending(message = PENDING_MESSAGE, candidates: LocationCandidate[] = []): LocationResolution {
  return { resolved: null, status: 'Pending', message, candidates, usedGemini: false }
}

function toCandidate(master: MasterCandidate): LocationCandidate {
  return {
    id: master.id,
    district: master.district,
    thana: master.thana,
    locationType: master.locationType,
  }
}

// ---------------------------------------------------------------------------
// The master collection, in memory
// ---------------------------------------------------------------------------

interface MasterCache {
  rows: MasterCandidate[]
  loadedAt: number
}

let masterCache: MasterCache | null = null

/**
 * How long a loaded copy of the master collection is trusted.
 *
 * The collection is a few hundred rows that change when an Admin edits one,
 * which is rarely, and it is read on every resolution — so it is held rather
 * than fetched. Writes call `invalidateMasterCache`, which makes an edit
 * visible immediately; the TTL is only the floor under a process that somehow
 * missed one, and under a second instance that did the write.
 */
const MASTER_TTL_MS = 5 * 60_000

export function invalidateMasterCache(): void {
  masterCache = null
}

/**
 * Every active master row, as the matcher wants them.
 *
 * Inactive rows are excluded here rather than filtered later, which is what
 * makes "a deactivated location can never be resolved to" a property of the
 * loader instead of something six call sites have to remember.
 */
async function loadMasters(): Promise<MasterCandidate[]> {
  if (masterCache && Date.now() - masterCache.loadedAt < MASTER_TTL_MS) {
    return masterCache.rows
  }

  const documents = await LocationMasterModel.find({ isActive: true })
    .select('district thana locationType normalizedDistrict normalizedThana')
    .lean()

  const rows: MasterCandidate[] = documents.map((document) => ({
    id: String(document._id),
    district: document.district,
    thana: document.thana,
    locationType: document.locationType as LocationType,
    normalizedDistrict: document.normalizedDistrict,
    normalizedThana: document.normalizedThana,
  }))

  masterCache = { rows, loadedAt: Date.now() }
  return rows
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/**
 * The whole ladder, for one challan.
 *
 * `allowAssisted` is false wherever a call is not worth its latency — a bulk
 * backfill over historical records, most obviously, where hundreds of requests
 * would be spent on records nobody is waiting for.
 */
export async function resolveLocation(
  query: LocationQuery,
  options: { allowAssisted?: boolean } = {},
): Promise<LocationResolution> {
  const allowAssisted = options.allowAssisted ?? true

  try {
    if (!query.thana.trim() && !query.district.trim() && !query.deliveryAddress.trim()) {
      return pending(
        'No thana, district or delivery address was entered, so there was nothing to match.',
      )
    }

    const masters = await loadMasters()
    if (masters.length === 0) {
      return pending(
        'The location master list is empty, so nothing can be matched against it yet.',
      )
    }

    const local = matchLocally(query, masters)

    if (local.match) {
      return {
        resolved: {
          masterId: local.match.id,
          district: local.match.district,
          thana: local.match.thana,
          locationType: local.match.locationType,
          // `matchLocally` only ever sets `source` alongside a match.
          source: local.source ?? 'master_normalized',
          confidence: local.confidence,
        },
        status: 'Verified',
        message: 'Resolved from the location master list.',
        candidates: local.candidates.map((scored) => toCandidate(scored.candidate)),
        usedGemini: false,
      }
    }

    const shortlist = shortlistFor(local, masters, MAX_GEMINI_CANDIDATES)
    const offered = shortlist.map(toCandidate)

    /**
     * The assisted step is skipped outright when it is not configured, not
     * wanted, or has nothing to choose between. Note the last of those: a
     * shortlist of nothing would be an invitation to invent a location, which
     * is the single thing this arrangement must never allow.
     */
    if (!allowAssisted || !config.gemini || shortlist.length === 0) {
      return pending(localFailureMessage(local.ambiguous, shortlist.length), offered)
    }

    const choice = await chooseWithGemini(query, shortlist, config.gemini)

    if (choice.candidate) {
      /**
       * The last check, and the one that matters: whatever came back has to
       * still be a live row of the master collection. `shortlist` was built
       * from active rows a moment ago, and this re-reads the row rather than
       * trusting the copy — a row deactivated in between must not be written
       * onto a challan.
       */
      const verified = await verifyMaster(choice.candidate.id)
      if (!verified) {
        return pending(
          'The suggested location is no longer available in the master list.',
          offered,
        )
      }

      return {
        resolved: {
          masterId: verified.id,
          district: verified.district,
          thana: verified.thana,
          locationType: verified.locationType,
          source: 'gemini_assisted',
          confidence: choice.confidence,
        },
        status: 'Verified',
        message: 'Matched to the location master list with assistance.',
        candidates: offered,
        usedGemini: true,
      }
    }

    return {
      ...pending(choice.reason || PENDING_MESSAGE, offered),
      usedGemini: !choice.skipped,
    }
  } catch (error) {
    /**
     * Any failure at all — a dropped database connection mid-lookup, a bug in
     * the matcher — ends here, as a location nobody set. The challan it was
     * called for goes on to be filed exactly as it would have been.
     */
    const message = error instanceof Error ? error.message : String(error)
    console.error('[location] resolution failed: ' + message)
    return pending()
  }
}

function localFailureMessage(ambiguous: boolean, candidateCount: number): string {
  if (ambiguous) {
    return 'More than one location matches what was entered, so none was chosen. Pick the right one, or leave it for an administrator.'
  }
  if (candidateCount > 0) {
    return 'No location matched closely enough to fill in on its own. The nearest ones are offered below.'
  }
  return PENDING_MESSAGE
}

async function verifyMaster(id: string): Promise<MasterCandidate | null> {
  const document = await LocationMasterModel.findOne({ _id: id, isActive: true })
    .select('district thana locationType normalizedDistrict normalizedThana')
    .lean()

  if (!document) {
    return null
  }

  return {
    id: String(document._id),
    district: document.district,
    thana: document.thana,
    locationType: document.locationType as LocationType,
    normalizedDistrict: document.normalizedDistrict,
    normalizedThana: document.normalizedThana,
  }
}

/**
 * A location somebody chose, rather than one anything worked out.
 *
 * This is the top of the authority order and the reason the rest of it is
 * safe: whatever the matcher and Gemini between them decided, a person
 * selecting a district and a thana overrules it, and nothing re-resolves over
 * the result afterwards. It is also the only path that can produce a location
 * for a challan whose text says nothing useful at all.
 *
 * Unlike everything else here this *does* throw, because it is a direct
 * response to somebody's action: choosing a row that has been deleted or
 * deactivated is a mistake worth reporting rather than silently ignoring.
 */
export async function resolveByMasterId(id: string): Promise<ResolvedLocation> {
  const master = await verifyMaster(id)

  if (!master) {
    throw new AppError(
      404,
      'That location is not in the master list any more, or has been deactivated.',
    )
  }

  return {
    masterId: master.id,
    district: master.district,
    thana: master.thana,
    locationType: master.locationType,
    source: 'admin_manual',
    // Somebody looked at it and said so. There is no probability to report.
    confidence: 1,
  }
}

/** Re-exported so callers do not have to reach into the matcher for one number. */
export { LOCAL_AUTO_CONFIDENCE }
