import type { QueryFilter, Types } from "mongoose";
import type { ObjectStream } from "../../config/r2";
import { requireStorage } from "../../config/r2";
import { AppError } from "../../utils/app-error";
import { UserModel } from "../user/user.model";
import type { UserDocument } from "../user/user.model";
import {
  assertCanChangeBatch,
  assertCanDelete,
  assertCanEdit,
  canChangeBatch,
} from "./challan.access";
import {
  MAX_BATCH_MERGE_CHALLANS,
  comparisonKey,
  deliveryKey,
  normalizeMobile,
} from "./challan.constants";
import type { ChallanStatus } from "./challan.constants";
import { allocateChallanIdentifiers } from "./challan.counter";
import { ChallanBatchModel } from "./challan-batch.model";
import type { ChallanBatchDocument } from "./challan-batch.model";
import { ChallanModel } from "./challan.model";
import type { Challan, ChallanDocument } from "./challan.model";
import { ChallanSubmissionModel } from "./challan-submission.model";
import {
  toChallanBatchDetail,
  toChallanBatchRecord,
  toChallanRecord,
  toDuplicateCandidate,
} from "./challan.serializer";
import type {
  ChallanBatchDetail,
  ChallanBatchRecord,
  ChallanRecord,
  DuplicateChallanCandidate,
} from "./challan.serializer";
import {
  assertUploadableExtract,
  discardChallanDocument,
  openChallanDocument,
  readChallanDocument,
  uploadChallanDocument,
} from "./challan.storage";
import { REVIEWABLE_LOCATION_SOURCES } from "../location/location.constants";
import type {
  LocationSource,
  LocationStatus,
  LocationType,
} from "../location/location.constants";
import { resolveByMasterId, resolveLocation } from "../location/location.resolver";
import type { RateKind } from "../product-rate/product-rate.constants";
import { priceItems } from "../product-rate/product-rate.service";
import { normalizeBanglaText } from "./lib/bangla-text";
import {
  generateChallanBackPage,
  generateChallanFinalPdf,
  mergeChallanPdfs,
  readPageCount,
  replaceChallanBackPage,
} from "./lib/challan-pdf";
import { checkRangeAgainst, pageCountOf } from "./lib/page-ranges";
import type { ClaimedRange, RangeProblem } from "./lib/page-ranges";
import type {
  DuplicateQuery,
  ListBatchesQuery,
  ListChallansQuery,
  ChallanSuggestionField,
  ChallanSuggestionQuery,
  PageRangeQuery,
  SubmitChallanInput,
  UpdateChallanInput,
} from "./challan.validation";

/**
 * Everything the Challan module does to the database and to storage.
 *
 * The shape of this file follows one rule that is worth stating before any of
 * the code: **nothing permanent happens until an operator submits one
 * challan.** There is no create-then-fill flow, no draft row, and no endpoint
 * that stores the source PDF. `submitChallan` is the only function here that
 * brings a record into existence, and it does the whole job in one call —
 * validate, allocate, generate, upload, save — because a half-done submission
 * is not a state this module has any use for.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** User input reaches a regex, so metacharacters must lose their meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function startOfUtcDay(value: string | Date): Date {
  const date =
    typeof value === "string"
      ? new Date(value.slice(0, 10) + "T00:00:00.000Z")
      : value;
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

function endOfUtcDay(value: string): Date {
  return new Date(startOfUtcDay(value).getTime() + 86_400_000 - 1);
}

/**
 * Resolves every actor referenced on this page of results in a single indexed
 * lookup, rather than populating row by row. Returns id -> display name. The
 * same treatment administration and gate pass give their lists.
 */
async function resolveActorNames(
  records: {
    createdBy: unknown;
    submittedBy?: unknown;
    updatedBy?: unknown;
    printedBy?: unknown;
    resolvedLocation?: { resolvedBy?: unknown } | null;
  }[],
  /** Names the caller already has, so they are never looked up again. */
  known?: Map<string, string>,
): Promise<Map<string, string>> {
  const ids = new Set<string>();

  for (const record of records) {
    if (record.createdBy) ids.add(String(record.createdBy));
    if (record.submittedBy) ids.add(String(record.submittedBy));
    if (record.updatedBy) ids.add(String(record.updatedBy));
    if (record.printedBy) ids.add(String(record.printedBy));
    // Whoever set the location by hand, so the details page can name them
    // without a second lookup per row.
    if (record.resolvedLocation?.resolvedBy) {
      ids.add(String(record.resolvedLocation.resolvedBy));
    }
  }

  const names = new Map(known ?? []);
  const missing = [...ids].filter((id) => !names.has(id));

  // Nothing left to ask about: a freshly filed challan names one person, and
  // the caller already handed us who they are.
  if (missing.length === 0) {
    return names;
  }

  const actors = await UserModel.find({ _id: { $in: missing } }).select("name");
  for (const actor of actors) {
    names.set(String(actor._id), actor.name);
  }

  return names;
}

/**
 * `known` seeds the name lookup with actors the caller already holds.
 *
 * A freshly filed challan names one person in every actor field, and that
 * person is the authenticated profile the request arrived with — so asking
 * MongoDB who they are is a round trip to be told something already in
 * memory. Passing them in skips the query entirely; anyone the caller does
 * not know is still looked up as before.
 */
async function serialize(
  challan: ChallanDocument,
  known?: UserDocument,
): Promise<ChallanRecord> {
  const seed = known
    ? new Map([[String(known._id), known.name]])
    : undefined;

  return toChallanRecord(challan, await resolveActorNames([challan], seed));
}

async function findChallan(id: string): Promise<ChallanDocument> {
  const challan = await ChallanModel.findById(id);
  if (!challan) {
    throw new AppError(404, "Challan not found.");
  }
  return challan;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListChallansResult {
  records: ChallanRecord[];
  total: number;
  /** Every quantity on every matching record, not just the page on screen. */
  totalQty: number;
  /** Every charge on every matching record. Understated by unpriced lines. */
  totalAmount: number;
  /** How many of them carry a line nothing priced, so the total says so. */
  unpricedChallans: number;
  /**
   * The three backlogs, over the same matching set. What the toolbar chips
   * count, and each one is the filter that finds them.
   */
  blankAmount: number;
  partialAmount: number;
  locationPending: number;
  locationReview: number;
}

function buildListFilter(query: ListChallansQuery): QueryFilter<Challan> {
  const clauses: QueryFilter<Challan>[] = [];

  if (query.status !== "all") {
    clauses.push({ status: query.status });
  }
  if (query.batchId) {
    clauses.push({ batchId: query.batchId });
  }
  if (query.createdBy) {
    clauses.push({ createdBy: query.createdBy });
  }
  /**
   * `review` is a different question from the other two and so a different
   * clause. `verified` and `pending` ask whether a location exists; `review`
   * asks who decided it — the challans that carry one the machine inferred and
   * nobody has read. Those are `Verified` by definition, so filtering on the
   * status as well would only add a redundant term to the query.
   */
  if (query.location === "review") {
    clauses.push({
      "resolvedLocation.source": { $in: REVIEWABLE_LOCATION_SOURCES },
    });
  } else if (query.location !== "all") {
    clauses.push({
      locationStatus: query.location === "verified" ? "Verified" : "Pending",
    });
  }
  /**
   * The charge backlog, off the stored status rather than the items array —
   * an indexed lookup instead of a pass over a sub-document on every page.
   */
  if (query.amount !== "all") {
    clauses.push({
      chargeStatus: query.amount === "unpriced" ? "Unpriced" : "Partial",
    });
  }
  if (query.district) {
    /**
     * Either district: the one somebody typed, or the one it resolved to.
     *
     * They are usually the same string and occasionally not — "Comilla" typed,
     * "Cumilla" on record — and somebody filtering for a district means the
     * deliveries that went there, not the ones that happened to be spelled a
     * particular way.
     */
    const pattern = new RegExp(escapeRegex(query.district), "i");
    clauses.push({
      $or: [{ district: pattern }, { "resolvedLocation.district": pattern }],
    });
  }
  if (query.customer) {
    clauses.push({
      customerName: new RegExp(escapeRegex(query.customer), "i"),
    });
  }
  // Matches a challan where *any* line carries the product or the model.
  if (query.product) {
    clauses.push({
      "items.productName": new RegExp(escapeRegex(query.product), "i"),
    });
  }
  if (query.model) {
    clauses.push({
      "items.productModel": new RegExp(escapeRegex(query.model), "i"),
    });
  }
  if (query.zonePo) {
    clauses.push({ zonePo: new RegExp(escapeRegex(query.zonePo), "i") });
  }

  if (query.from || query.to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (query.from) range.$gte = startOfUtcDay(query.from);
    if (query.to) range.$lte = endOfUtcDay(query.to);
    clauses.push({ submittedAt: range });
  }

  if (query.search) {
    /**
     * Whatever the operator has in front of them: the number off a printed
     * back page, the SL somebody read out over the phone, a customer who
     * called, or the model on the box. The SL is matched as a number when the
     * search looks like one, because a regex over an integer field matches
     * nothing.
     */
    const pattern = new RegExp(escapeRegex(query.search), "i");
    const asNumber = Number.parseInt(query.search, 10);

    const or: QueryFilter<Challan>[] = [
      { challanNumber: pattern },
      { customerName: pattern },
      { deliveryAddress: pattern },
      { thana: pattern },
      { district: pattern },
      { receiverMobile: pattern },
      { "items.productName": pattern },
      { "items.productModel": pattern },
    ];

    if (Number.isInteger(asNumber)) {
      or.push({ slNumber: asNumber });
    }

    clauses.push({ $or: or });
  }

  return clauses.length > 0 ? { $and: clauses } : {};
}

interface ChallanTotals {
  total: number;
  totalQty: number;
  /**
   * Every charged line on every matching challan, added up.
   *
   * A server figure by necessity, for exactly the reason `totalQty` is: the
   * browser never holds more than a page of rows, so anything added up there
   * would be the total of one page pretending to be the total of a month.
   *
   * Lines that carry no rate contribute nothing rather than breaking the sum,
   * which means this figure can understate what a set of challans is worth. It
   * is reported beside the count of unpriced records rather than on its own,
   * because a total that quietly leaves challans out is worse than no total.
   */
  totalAmount: number;
  /** How many matching challans have at least one line nobody could price. */
  unpricedChallans: number;
  /**
   * The three backlogs, counted over the same matching set as everything else
   * — because they are shown beside the record count and the totals, and a
   * figure in that row that answered a different question would be the one
   * thing on the toolbar nobody could trust.
   *
   * That does mean acting on one narrows the others: filtering to the blank
   * amounts leaves the location counts describing only those. That is the
   * honest reading of a filtered list, and the chips show their pressed state
   * so it is never a mystery which question is being asked.
   */
  blankAmount: number;
  partialAmount: number;
  locationPending: number;
  locationReview: number;
}

/**
 * How many records match a filter, and how much they carry between them. One
 * grouped pass rather than a count plus a second aggregation: both figures are
 * read off the same matching set, and M0 charges for every round trip.
 */
async function totalsFor(filter: QueryFilter<Challan>): Promise<ChallanTotals> {
  const [row] = await ChallanModel.aggregate<ChallanTotals>([
    { $match: filter },
    // The inner $sum adds the quantities inside one challan's items array; the
    // outer one adds those subtotals across the matching challans.
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        totalQty: { $sum: { $sum: "$items.qty" } },
        /**
         * `$items.rate.amount` yields one entry per line, null for the ones
         * nothing priced, and `$sum` ignores non-numeric entries — so an
         * unpriced line contributes nothing instead of poisoning the total.
         */
        totalAmount: { $sum: { $sum: "$items.rate.amount" } },
        /**
         * The backlogs, read off the two stored status fields rather than
         * worked out from the arrays underneath them. That is what those
         * fields are for — counting them any other way would mean opening
         * every items array on every page of the list.
         */
        blankAmount: {
          $sum: { $cond: [{ $eq: ["$chargeStatus", "Unpriced"] }, 1, 0] },
        },
        partialAmount: {
          $sum: { $cond: [{ $eq: ["$chargeStatus", "Partial"] }, 1, 0] },
        },
        locationPending: {
          $sum: { $cond: [{ $eq: ["$locationStatus", "Pending"] }, 1, 0] },
        },
        /**
         * A location the machine inferred and nobody has read. The same set
         * `REVIEWABLE_LOCATION_SOURCES` names and the `review` filter queries,
         * so the chip and the list it leads to can never disagree about what
         * counts.
         */
        locationReview: {
          $sum: {
            $cond: [
              {
                $in: [
                  { $ifNull: ["$resolvedLocation.source", ""] },
                  REVIEWABLE_LOCATION_SOURCES,
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        total: 1,
        totalQty: 1,
        totalAmount: 1,
        blankAmount: 1,
        partialAmount: 1,
        locationPending: 1,
        locationReview: 1,
      },
    },
  ]);

  const totals = row ?? {
    total: 0,
    totalQty: 0,
    totalAmount: 0,
    blankAmount: 0,
    partialAmount: 0,
    locationPending: 0,
    locationReview: 0,
    unpricedChallans: 0,
  };

  return {
    ...totals,
    /**
     * Anything not fully charged. Derived from the two rather than counted a
     * third time: it is what the toolbar's "this total leaves some out"
     * caveat reads, and a separate accumulator could come to disagree with the
     * parts it is a sum of.
     */
    unpricedChallans: totals.blankAmount + totals.partialAmount,
  };
}

export async function listChallans(
  query: ListChallansQuery,
): Promise<ListChallansResult> {
  const filter = buildListFilter(query);
  const skip = (query.page - 1) * query.limit;

  const [records, totals] = await Promise.all([
    ChallanModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit),
    totalsFor(filter),
  ]);

  const names = await resolveActorNames(records);

  return {
    records: records.map((record) => toChallanRecord(record, names)),
    total: totals.total,
    totalQty: totals.totalQty,
    totalAmount: totals.totalAmount,
    unpricedChallans: totals.unpricedChallans,
    blankAmount: totals.blankAmount,
    partialAmount: totals.partialAmount,
    locationPending: totals.locationPending,
    locationReview: totals.locationReview,
  };
}

export async function getChallan(id: string): Promise<ChallanRecord> {
  return serialize(await findChallan(id));
}

export interface ChallanStats {
  total: number;
  today: number;
  totalQty: number;
  batchesProcessing: number;
  batchesCompleted: number;
}

/**
 * The five figures the records page and the dashboard card render. Real counts
 * from two grouped passes — never a placeholder, because an overview that
 * invents numbers is worse than one that admits it has none.
 */
export async function getChallanStats(): Promise<ChallanStats> {
  const today = startOfUtcDay(new Date());
  const tomorrow = new Date(today.getTime() + 86_400_000);

  const [totals, todayCount, batchRows] = await Promise.all([
    totalsFor({}),
    ChallanModel.countDocuments({
      submittedAt: { $gte: today, $lt: tomorrow },
    }),
    ChallanBatchModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const batches = new Map(batchRows.map((row) => [row._id, row.count]));

  return {
    total: totals.total,
    today: todayCount,
    totalQty: totals.totalQty,
    batchesProcessing: batches.get("Processing") ?? 0,
    batchesCompleted: batches.get("Completed") ?? 0,
  };
}

/** Where each suggestible field actually lives in a document. */
const SUGGESTION_PATHS: Record<ChallanSuggestionField, string> = {
  customerName: "customerName",
  thana: "thana",
  district: "district",
  product: "items.productName",
  model: "items.productModel",
  zonePo: "zonePo",
};

/** Enough to be useful, few enough to read without scrolling. */
const SUGGESTION_LIMIT = 8;

/**
 * Values already on record for one field, for the entry form's type-ahead.
 *
 * The same districts, thanas, products and models come back every day, so
 * offering what has been filed before is partly speed and mostly consistency:
 * a suggestion is what stops one district being recorded as three strings no
 * report can put back together.
 *
 * Anchored at the start of the value on purpose — a prefix is what an index
 * can answer, and what somebody typing expects.
 */
export async function suggestChallanValues(
  query: ChallanSuggestionQuery,
): Promise<string[]> {
  const path = SUGGESTION_PATHS[query.field];
  const prefix = new RegExp("^" + escapeRegex(query.q), "i");

  const rows = await ChallanModel.aggregate<{ _id: string; count: number }>([
    { $match: { [path]: prefix } },
    /**
     * Product fields live inside an array, so the rows have to be opened out
     * before they can be grouped — and re-filtered, or a challan matching on
     * one line would offer every other line it carries too. The same shape the
     * Gate Pass suggestion query uses.
     */
    ...(path.startsWith("items.")
      ? [{ $unwind: "$items" }, { $match: { [path]: prefix } }]
      : []),
    { $group: { _id: "$" + path, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: SUGGESTION_LIMIT },
  ]);

  return rows
    .map((row) => row._id)
    .filter((value) => typeof value === "string" && value.length > 0);
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export interface ListBatchesResult {
  records: ChallanBatchRecord[];
  total: number;
}

export async function listChallanBatches(
  query: ListBatchesQuery,
): Promise<ListBatchesResult> {
  const filter: QueryFilter<unknown> = {};

  if (query.status !== "all") {
    filter.status = query.status;
  }
  if (query.search) {
    filter.sourceFileName = new RegExp(escapeRegex(query.search), "i");
  }

  const skip = (query.page - 1) * query.limit;

  const [records, total] = await Promise.all([
    ChallanBatchModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit),
    ChallanBatchModel.countDocuments(filter),
  ]);

  const names = await resolveActorNames(records);

  return {
    records: records.map((record) => toChallanBatchRecord(record, names)),
    total,
  };
}

async function findBatch(id: string): Promise<ChallanBatchDocument> {
  const batch = await ChallanBatchModel.findById(id);
  if (!batch) {
    throw new AppError(404, "That batch could not be found.");
  }
  return batch;
}

export async function getChallanBatch(id: string): Promise<ChallanBatchDetail> {
  const batch = await findBatch(id);
  const challans = await ChallanModel.find({ batchId: batch._id }).sort({
    sourcePageStart: 1,
  });
  const names = await resolveActorNames([batch, ...challans]);

  return toChallanBatchDetail(batch, challans, names);
}

/**
 * Recomputes a batch's progress from the challans that actually exist.
 *
 * Called after every write that could change the answer — a submission, a
 * correction that never touches pages, a deletion. Derived rather than
 * incremented, because an increment that ran twice or not at all would leave a
 * batch permanently claiming to be somewhere it is not, and there is no way to
 * notice that from the outside.
 *
 * A batch with no challans left is deleted rather than kept at zero: it exists
 * only because a challan came out of that source file, and if none did there
 * is nothing for it to be a batch of.
 */
async function refreshBatchProgress(batchId: unknown): Promise<void> {
  const batch = await ChallanBatchModel.findById(batchId);
  if (!batch) {
    return;
  }

  const challans = await ChallanModel.find({ batchId: batch._id }).select(
    "sourcePageStart sourcePageEnd printedAt",
  );

  if (challans.length === 0) {
    await batch.deleteOne();
    return;
  }

  const filed = new Set<number>();
  for (const challan of challans) {
    for (
      let page = Math.max(1, challan.sourcePageStart);
      page <= Math.min(batch.sourcePageCount, challan.sourcePageEnd);
      page += 1
    ) {
      filed.add(page);
    }
  }

  /**
   * A page marked blank stops being marked the moment a challan claims it —
   * an operator who marked page 5 by mistake and then filed it should not
   * leave the batch counting page 5 twice. Recomputing from the challans is
   * what makes that automatic rather than something to remember.
   */
  const skipped = batch.skippedPages.filter(
    (page) => page >= 1 && page <= batch.sourcePageCount && !filed.has(page),
  );

  const accounted = new Set([...filed, ...skipped]);
  const isComplete =
    batch.sourcePageCount > 0 && accounted.size === batch.sourcePageCount;

  batch.set(
    "skippedPages",
    [...new Set(skipped)].sort((a, b) => a - b),
  );
  batch.challanCount = challans.length;
  // Counted here rather than adjusted at each print, for the same reason the
  // page counts are: a number that is derived cannot drift, and a number that
  // is incremented eventually does with nothing to notice it.
  batch.printedChallanCount = challans.filter(
    (challan) => challan.printedAt !== null,
  ).length;
  batch.assignedPageCount = accounted.size;
  batch.status = isComplete ? "Completed" : "Processing";
  // Kept from the first time it completed; a correction that leaves it
  // complete should not keep moving the date.
  batch.completedAt = isComplete ? (batch.completedAt ?? new Date()) : null;

  await batch.save();
}

/**
 * The batch an operator has come back to, rather than one they are starting.
 *
 * A source PDF is not stored, so finishing one that was left half-processed
 * means opening the same file again in a *new* workspace — with a new session
 * key, which names no batch at all. The batch is therefore identified the only
 * way it still can be: by the id the batch page handed over.
 *
 * Two things are checked, and the second is the one that matters. Who: the
 * same rule as marking a page blank, because filing into somebody's batch
 * changes what their file is a batch of. And what: a page count that disagrees
 * with the batch's is a different document, whatever the operator picked — the
 * pages of file B filed into batch A would be a batch that could never
 * honestly complete, and the mismatch is the last moment anything can tell.
 */
async function joinBatch(
  batchId: string,
  sourcePageCount: number,
  actor: UserDocument,
): Promise<ChallanBatchDocument> {
  const batch = await findBatch(batchId);
  assertCanChangeBatch(batch, actor);

  if (batch.sourcePageCount !== sourcePageCount) {
    throw new AppError(
      409,
      `This batch was started from a ${batch.sourcePageCount}-page file and the PDF you opened has ${sourcePageCount}. Open the file this batch came from.`,
    );
  }

  return batch;
}

/**
 * The batch this submission belongs to, created if this is the first challan
 * out of the source file.
 *
 * `$setOnInsert` fixes the file's identity at creation, exactly as
 * `syncUserProfile` fixes a new account's role: a later submission carrying a
 * different page count for the same session key is refused rather than
 * silently rewriting what the batch is a batch of.
 *
 * The unique index on `{ createdBy, sessionKey }` is what makes this safe when
 * two submissions race to be the first — one inserts, the other finds.
 *
 * A submission naming a batch skips all of that: it is joining one that exists
 * rather than deciding whether to create one.
 */
async function ensureBatch(
  input: SubmitChallanInput,
  actor: UserDocument,
): Promise<ChallanBatchDocument> {
  if (input.batchId) {
    return joinBatch(input.batchId, input.sourcePageCount, actor);
  }

  const batch = await ChallanBatchModel.findOneAndUpdate(
    { createdBy: actor._id, sessionKey: input.sessionKey },
    {
      $setOnInsert: {
        createdBy: actor._id,
        sessionKey: input.sessionKey,
        sourceFileName: input.sourceFileName,
        sourcePageCount: input.sourcePageCount,
        challanCount: 0,
        assignedPageCount: 0,
        status: "Processing",
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  if (batch.sourcePageCount !== input.sourcePageCount) {
    throw new AppError(
      409,
      "This workspace session already belongs to a different source PDF. Reload the workspace and open the file again.",
    );
  }

  return batch;
}

/**
 * Marks pages of a source PDF as not being challans, or unmarks them.
 *
 * The whole list is replaced rather than added to, which makes the operation
 * idempotent and makes "undo" the same call with one page removed — there is
 * no separate unmark endpoint to keep in step.
 *
 * A page a challan already claims is refused rather than quietly dropped. The
 * two would be a contradiction on the batch page — a page shown as both filed
 * and blank — and the operator who sent it has misread something, which is
 * worth saying.
 */
export async function setBatchSkippedPages(
  id: string,
  pages: number[],
  actor: UserDocument,
): Promise<ChallanBatchDetail> {
  const batch = await findBatch(id);
  assertCanChangeBatch(batch, actor);

  const wanted = [...new Set(pages)].sort((a, b) => a - b);

  const outOfBounds = wanted.filter(
    (page) => page < 1 || page > batch.sourcePageCount,
  );
  if (outOfBounds.length > 0) {
    throw new AppError(
      400,
      `This PDF has ${batch.sourcePageCount} pages, so page ${outOfBounds[0]} is not one of them.`,
    );
  }

  const claimed = await claimedRangesFor(batch._id);
  const taken = new Set<number>();
  for (const range of claimed) {
    for (let page = range.startPage; page <= range.endPage; page += 1) {
      taken.add(page);
    }
  }

  const conflict = wanted.find((page) => taken.has(page));
  if (conflict !== undefined) {
    const owner = claimed.find(
      (range) => conflict >= range.startPage && conflict <= range.endPage,
    );
    throw new AppError(
      409,
      `Page ${conflict} belongs to ${owner?.challanNumber ?? "a filed challan"}, so it cannot be marked blank. Delete that challan first.`,
    );
  }

  batch.set("skippedPages", wanted);
  await batch.save();

  // Recomputed rather than adjusted here, so the count and the status come
  // from the same place they always do.
  await refreshBatchProgress(batch._id);

  return getChallanBatch(id);
}

// ---------------------------------------------------------------------------
// Page ranges
// ---------------------------------------------------------------------------

/**
 * The batch a workspace is working in, for the questions it asks before it
 * submits anything.
 *
 * Two ways of naming one, because there are two ways to be in a workspace: a
 * session key, which the browser generated for a file it just opened, and an
 * id, which is a batch it came back to finish. Neither is trusted further than
 * it goes — a key only ever finds this operator's own batch, and an id has to
 * name one they may add to.
 *
 * Null covers every miss, including a batch this actor may not change. These
 * are questions asked repeatedly while a range is being dragged, and answering
 * one with a fault would turn a probe into an error somebody has to read.
 */
async function batchInPlay(
  ref: { batchId: string; sessionKey: string },
  actor: UserDocument,
): Promise<ChallanBatchDocument | null> {
  if (ref.batchId) {
    const batch = await ChallanBatchModel.findById(ref.batchId);
    return batch && canChangeBatch(batch, actor) ? batch : null;
  }

  if (!ref.sessionKey) {
    return null;
  }

  return ChallanBatchModel.findOne({
    createdBy: actor._id,
    sessionKey: ref.sessionKey,
  });
}

/** Ranges already spoken for in a batch, in the shape the checker wants. */
async function claimedRangesFor(
  batchId: unknown,
  excludeChallanId?: string,
): Promise<ClaimedRange[]> {
  const filter: QueryFilter<Challan> = { batchId: batchId as never };
  if (excludeChallanId) {
    filter._id = { $ne: excludeChallanId };
  }

  const challans = await ChallanModel.find(filter).select(
    "sourcePageStart sourcePageEnd challanNumber",
  );

  return challans.map((challan) => ({
    startPage: challan.sourcePageStart,
    endPage: challan.sourcePageEnd,
    challanNumber: challan.challanNumber,
  }));
}

export class PageRangeError extends AppError {
  public readonly problem: RangeProblem;

  constructor(problem: RangeProblem) {
    super(409, problem.message);
    this.problem = problem;
  }
}

export interface PageRangeAvailability {
  available: boolean;
  problem: RangeProblem | null;
  claimed: ClaimedRange[];
}

/**
 * Whether a page range is free, asked before anything is submitted.
 *
 * The workspace can see overlaps inside its own session on its own. What it
 * cannot see is a challan somebody filed out of the same PDF an hour ago, or
 * one this operator filed before a browser crash — and only the collection
 * knows about those.
 */
export async function checkPageRangeAvailability(
  query: PageRangeQuery,
  actor: UserDocument,
): Promise<PageRangeAvailability> {
  const batch = await batchInPlay(query, actor);

  const claimed = batch ? await claimedRangesFor(batch._id) : [];

  const problem = checkRangeAgainst(
    { startPage: query.sourcePageStart, endPage: query.sourcePageEnd },
    query.sourcePageCount,
    claimed,
  );

  return { available: problem === null, problem, claimed };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export class DuplicateChallanError extends AppError {
  public readonly duplicates: DuplicateChallanCandidate[];

  constructor(duplicates: DuplicateChallanCandidate[]) {
    super(409, "A challan with these details may already have been filed.");
    this.duplicates = duplicates;
  }
}

/** How far back the mobile probe looks. Beyond this it is noise, not a signal. */
const DUPLICATE_LOOKBACK_DAYS = 90;

/**
 * Possible duplicates for a challan about to be filed.
 *
 * Two probes, because there are two ways the same delivery gets recorded
 * twice. Inside one source PDF, the same customer with the same model almost
 * always means a page range was filed twice — that is the strong signal, and
 * it is the mistake this workspace makes easiest. Across batches, the same
 * receiver's number with the same model within three months is the weaker one:
 * it happens legitimately when a customer orders a second unit, so it is
 * offered as a question and never enforced.
 *
 * Nothing here is a unique index. The business has not confirmed that any of
 * these combinations is globally unique, and a constraint built on that
 * assumption would eventually refuse a real challan.
 */
export async function findDuplicateChallans(
  query: DuplicateQuery,
  actor: UserDocument,
): Promise<DuplicateChallanCandidate[]> {
  const modelKey = query.model ? comparisonKey(query.model) : "";
  const identity = deliveryKey(query);

  /**
   * All four or nothing. A challan missing any of them cannot be shown to be
   * the same delivery as another, and a probe that fired on the three it did
   * have would be asking the looser question this one exists to stop asking.
   */
  if (!modelKey || !identity) {
    return [];
  }

  const since = new Date(Date.now() - DUPLICATE_LOOKBACK_DAYS * 86_400_000);
  const batch = await batchInPlay(query, actor);

  /**
   * One query, two scopes.
   *
   * Inside this source PDF, whatever its age — filing the same sheet twice out
   * of one file is the mistake this is really for, and a batch resumed after a
   * long gap must still be checked. And anywhere at all within the lookback
   * window, because the same delivery filed twice out of two files is the same
   * delivery twice.
   *
   * The scopes overlap, which is why they are an `$or` and not two queries:
   * the record is either a duplicate or it is not, and asking twice would only
   * produce two ways of saying so.
   */
  const scopes: QueryFilter<Challan>[] = [{ submittedAt: { $gte: since } }];
  if (batch) {
    scopes.push({ batchId: batch._id });
  }

  const filter: QueryFilter<Challan> = {
    customerNameKey: comparisonKey(query.customerName),
    receiverMobile: normalizeMobile(query.receiverMobile),
    // Any line carrying the model counts: a split delivery repeats the same
    // product across two challans, which is exactly what this asks about.
    "items.productModelKey": modelKey,
    $or: scopes,
  };
  if (query.excludeId) {
    filter._id = { $ne: query.excludeId };
  }

  /**
   * A few more than are shown, because the address is compared here rather
   * than in the query. Same customer, same number and same model is already
   * narrow enough that this is a handful of documents at most — and comparing
   * the address in memory is what saves storing and indexing a fourth
   * comparison key for a question that is only ever asked.
   */
  const matches = await ChallanModel.find(filter).sort({ createdAt: -1 }).limit(20);

  const candidates = matches.filter(
    (match) =>
      deliveryKey({
        customerName: match.customerName,
        deliveryAddress: match.deliveryAddress,
        receiverMobile: match.receiverMobile,
      }) === identity,
  );

  // Five is a decision aid; a longer list is a research task nobody performs
  // with a stack of challans still to type.
  return candidates
    .slice(0, 5)
    .map((match) =>
      toDuplicateCandidate(
        match,
        batch && String(match.batchId) === String(batch._id) ? "batch" : "recent",
      ),
    );
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * The values, normalised. Legacy Bijoy text becomes Unicode here and nowhere
 * else, which is what makes "the stored value is Unicode" a property of the
 * server rather than something the client is trusted to have done.
 *
 * `normalizeBanglaText` converts only when its heuristic is confident, so
 * English, model codes and text that is already Unicode pass through
 * untouched. Numbers and identifiers are deliberately not put through it at
 * all — there is no Bangla in a quantity, and nothing to gain from asking.
 */
/**
 * What one line was charged, in the shape the schema stores it. All five rate
 * fields are present so a line re-priced from a tiered rate into a flat one
 * cannot keep a stale figure the arithmetic would later find.
 */
interface AppliedRate {
  masterId: string;
  locationType: LocationType;
  kind: RateKind;
  unitAmount: number | null;
  firstQty: number | null;
  firstAmount: number | null;
  restAmount: number | null;
  amount: number;
  appliedAt: Date;
}

interface NormalizedItem {
  productName: string;
  productModel: string;
  productModelKey: string;
  qty: number;
  capacity: string;
  rate: AppliedRate | null;
}

interface NormalizedFields {
  customerName: string;
  customerNameKey: string;
  deliveryAddress: string;
  thana: string;
  district: string;
  receiverMobile: string;
  senderMobile: string | null;
  zonePo: string | null;
  items: NormalizedItem[];
}

function normalizeFields(
  input: SubmitChallanInput | UpdateChallanInput,
): NormalizedFields {
  const customerName = normalizeBanglaText(input.customerName).value;

  return {
    customerName,
    customerNameKey: comparisonKey(customerName),
    deliveryAddress: normalizeBanglaText(input.deliveryAddress).value,
    thana: normalizeBanglaText(input.thana).value,
    district: normalizeBanglaText(input.district).value,
    receiverMobile: input.receiverMobile,
    senderMobile: input.senderMobile
      ? normalizeMobile(input.senderMobile)
      : null,
    zonePo: input.zonePo ? input.zonePo : null,
    /**
     * Replaced wholesale rather than merged, exactly as Gate Pass does: a
     * product row has no identity of its own, so removing the second of three
     * and editing the third is indistinguishable from rewriting all three. The
     * client sends the list it wants and this is what it becomes.
     */
    items: input.items.map((item) => ({
      productName: normalizeBanglaText(item.productName).value,
      // A model number is a code, not prose. Running it through a Bangla
      // converter could only ever damage it.
      productModel: item.model,
      productModelKey: comparisonKey(item.model),
      qty: item.qty,
      /**
       * Both filled in by `withRates` once the location is known, because
       * neither can be decided without it: the rate card has three columns and
       * which one applies is a fact about where the challan is going.
       */
      capacity: "",
      rate: null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * The product lines, priced against the rate card.
 *
 * Everything about this follows from one thing: **the column is the location
 * type**. A challan whose location is still Pending has no column, so it has
 * no rate — which is not a failure and never blocks a submission. The challan
 * is filed, numbered, barcoded and printed exactly as it would have been, and
 * the moment somebody settles its location the lines are priced by the same
 * function, from the same card.
 *
 * That is why this is called from all three places a challan's values or its
 * location can change — submit, correct, and set-location — rather than only
 * at submit time. Anything less would leave a challan whose location arrived
 * five minutes late permanently uncharged, which is precisely the challan an
 * operator would never think to look at again.
 *
 * A line the card does not cover comes back with no rate, and that is also
 * ordinary. `priceItems` insists the product name match a card row; the entry
 * form's model lookup is what puts the card's own spelling in front of the
 * operator so that it does.
 */
async function withRates(
  items: NormalizedItem[],
  location: LocationFields,
): Promise<NormalizedItem[]> {
  const locationType = location.resolvedLocation?.locationType;

  if (!locationType) {
    // Cleared rather than left alone: a challan whose location has just been
    // unset must not keep a figure that was charged on the strength of it.
    return items.map((item) => ({ ...item, capacity: "", rate: null }));
  }

  const applications = await priceItems(
    items.map((item) => ({
      productName: item.productName,
      model: item.productModel,
      qty: item.qty,
    })),
    locationType,
  );

  const appliedAt = new Date();

  return items.map((item, index) => {
    const applied = applications[index];

    if (!applied) {
      return { ...item, capacity: "", rate: null };
    }

    const rate = applied.rate;

    return {
      ...item,
      capacity: applied.capacity,
      rate: {
        masterId: applied.masterId,
        locationType: applied.locationType,
        kind: rate.kind,
        unitAmount: rate.kind === "flat" ? rate.amount : null,
        firstQty: rate.kind === "tiered" ? rate.firstQty : null,
        firstAmount: rate.kind === "tiered" ? rate.firstAmount : null,
        restAmount: rate.kind === "tiered" ? rate.restAmount : null,
        amount: applied.amount,
        appliedAt,
      },
    };
  });
}

/** The stored lines, in the shape `withRates` prices. */
function storedItems(challan: ChallanDocument): NormalizedItem[] {
  return challan.items.map((item) => ({
    productName: item.productName,
    productModel: item.productModel,
    productModelKey: item.productModelKey,
    qty: item.qty,
    capacity: item.capacity ?? "",
    rate: null,
  }));
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** The two fields a decided location writes onto a challan. */
interface LocationFields {
  resolvedLocation: {
    masterId: string;
    district: string;
    thana: string;
    locationType: LocationType;
    source: LocationSource;
    confidence: number;
    resolvedAt: Date;
    resolvedBy: Types.ObjectId | null;
  } | null;
  locationStatus: LocationStatus;
}

const UNRESOLVED_LOCATION: LocationFields = {
  resolvedLocation: null,
  locationStatus: "Pending",
};

/**
 * Where this challan is going, decided.
 *
 * There is one authority order and this function is the whole of it:
 *
 * 1. **A person's choice wins.** An explicit `locationId` from the cascading
 *    selector is validated against the master collection and recorded as
 *    chosen by somebody. Nothing overrules it.
 * 2. **An existing manual choice is left alone.** Correcting a customer name
 *    on a challan whose location an administrator set by hand must not send
 *    the resolver back over it — that is the "AI never overwrites a person"
 *    rule, and this is where it lives.
 * 3. **Otherwise the resolver runs**, against the master collection first and
 *    with assistance only for what it could not settle on its own.
 * 4. **And if that comes to nothing, nothing is written.** Blank, Pending,
 *    submitted anyway. That is the designed outcome and not a failure.
 *
 * `strict` separates the two callers. A submission must never be refused over
 * an optional field, so a `locationId` that has since been deleted quietly
 * falls through to automatic resolution there. A request whose entire purpose
 * is to set the location says so instead.
 */
async function decideLocation(
  input: {
    thana: string;
    district: string;
    deliveryAddress: string;
    locationId?: string;
  },
  existing: ChallanDocument["resolvedLocation"] | null,
  actor: UserDocument,
  strict = false,
): Promise<LocationFields> {
  const chosen = input.locationId?.trim();

  if (chosen) {
    try {
      const resolved = await resolveByMasterId(chosen);
      return {
        resolvedLocation: {
          ...resolved,
          resolvedAt: new Date(),
          resolvedBy: actor._id,
        },
        locationStatus: "Verified",
      };
    } catch (error) {
      if (strict) {
        throw error;
      }
      // The row was removed between the selector loading and the form being
      // submitted. Refusing the whole challan over it would be absurd; the
      // automatic path below is the right fallback.
      console.warn("[challan] chosen location is no longer available; resolving instead");
    }
  }

  if (existing?.source === "admin_manual") {
    return {
      resolvedLocation: {
        masterId: String(existing.masterId),
        district: existing.district,
        thana: existing.thana,
        locationType: existing.locationType as LocationType,
        source: "admin_manual",
        confidence: existing.confidence,
        resolvedAt: existing.resolvedAt,
        resolvedBy: existing.resolvedBy ?? null,
      },
      locationStatus: "Verified",
    };
  }

  const resolution = await resolveLocation({
    thana: input.thana,
    district: input.district,
    deliveryAddress: input.deliveryAddress,
  });

  if (!resolution.resolved) {
    return UNRESOLVED_LOCATION;
  }

  return {
    resolvedLocation: {
      ...resolution.resolved,
      resolvedAt: new Date(),
      // Nobody chose it, so nobody is recorded as having.
      resolvedBy: null,
    },
    locationStatus: "Verified",
  };
}

/**
 * Sets, changes or clears a filed challan's location by hand.
 *
 * The final authority, and the answer to every challan the resolver left
 * blank. Deliberately **cheap**: it does not regenerate the document. The back
 * page prints the delivery address and the thana and district *as transcribed*
 * — which a location correction does not touch — so there is nothing on the
 * printed sheet that this could make untrue, and rebuilding a PDF and
 * rewriting an R2 object to record a classification would be an expensive way
 * to change nothing.
 *
 * `null` clears it, returning the challan to Pending. A location put on the
 * wrong record has to be removable, and there is no third state for "was set,
 * then unset".
 *
 * Scoped like every other correction in the module — `assertCanEdit`, so the
 * operator who filed it and the two roles that manage anybody's work. An
 * Admin is inside that set; the rule is not loosened for this endpoint,
 * because setting where a delivery went is a statement about the record.
 */
export async function setChallanLocation(
  id: string,
  locationId: string | null,
  actor: UserDocument,
): Promise<ChallanRecord> {
  const challan = await findChallan(id);
  assertCanEdit(challan, actor);

  const fields = locationId
    ? await decideLocation(
        {
          thana: challan.thana,
          district: challan.district,
          deliveryAddress: challan.deliveryAddress,
          locationId,
        },
        null,
        actor,
        true,
      )
    : UNRESOLVED_LOCATION;

  challan.set("resolvedLocation", fields.resolvedLocation);
  challan.locationStatus = fields.locationStatus;
  /**
   * And the rates with it, which is the whole reason this endpoint is not
   * quite as cheap as it looks.
   *
   * The rate card has three columns and the location is what chooses between
   * them, so settling a location is the moment a challan filed as Pending
   * becomes chargeable. Doing it anywhere else would leave a permanent class
   * of uncharged challans — the ones whose location arrived late — and those
   * are exactly the records nobody goes back to.
   *
   * Clearing a location clears the figures for the same reason: they were
   * charged on the strength of a classification that no longer stands.
   *
   * It still does not regenerate the document. The back page prints no rate,
   * so there is nothing on the printed sheet this could make untrue.
   */
  challan.set("items", await withRates(storedItems(challan), fields));
  challan.updatedBy = actor._id;
  await challan.save();

  return serialize(challan);
}

export interface SubmitChallanFile {
  buffer: Buffer;
  mimeType: string;
}

/**
 * A submission that was already completed under this key.
 *
 * Not an error: it is the same request arriving twice, and the honest answer
 * is the record the first one produced. The controller answers 200 with it,
 * so a retried submission looks to the operator exactly like a successful one
 * — which is the entire point of an idempotency key.
 */
export class ChallanAlreadySubmitted extends Error {
  public readonly challanId: string;

  constructor(challanId: string) {
    super("This challan has already been submitted.");
    this.name = "ChallanAlreadySubmitted";
    this.challanId = challanId;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

/**
 * Reserves the idempotency key, or says who already holds it.
 *
 * The insert is the lock. `_id` carries a unique index by definition, so there
 * is no read-then-write window for a second request to slip through — the
 * loser gets a duplicate-key error rather than a second challan.
 */
async function claimSubmission(
  submissionKey: string,
  actor: UserDocument,
): Promise<void> {
  try {
    await ChallanSubmissionModel.create({
      _id: submissionKey,
      status: "pending",
      createdBy: actor._id,
      createdAt: new Date(),
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const existing = await ChallanSubmissionModel.findById(submissionKey);

    if (existing?.status === "completed" && existing.challanId) {
      throw new ChallanAlreadySubmitted(String(existing.challanId));
    }

    throw new AppError(
      409,
      "This challan is already being submitted. Wait for it to finish before trying again.",
    );
  }
}

/** Lets the operator fix whatever went wrong and retry with the same key. */
async function releaseSubmission(submissionKey: string): Promise<void> {
  try {
    await ChallanSubmissionModel.deleteOne({
      _id: submissionKey,
      status: "pending",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[challan] could not release submission claim: " + message);
  }
}

export interface SubmitChallanResult {
  record: ChallanRecord;
  /** True when this was a replay of a submission that had already completed. */
  wasAlreadySubmitted: boolean;
}

/**
 * Files one challan. The only function in this module that creates anything.
 *
 * The order of the steps is the whole design, and it is chosen so that no
 * failure can leave a false success behind:
 *
 * 1. Refuse early — storage credentials, the uploaded PDF, and the page count
 *    it actually carries. All of that is free, and all of it happens before an
 *    SL number is burned.
 * 2. Claim the idempotency key. Everything after this point happens at most
 *    once per key, however many times the request arrives.
 * 3. Find or create the batch, and check the range against what the batch
 *    already holds. Overlap is refused, never silently allowed.
 * 4. Ask the duplicate question, unless the operator has already answered it.
 * 5. Allocate the two identifiers atomically.
 * 6. Build the back page and merge it onto the original pages.
 * 7. Upload the document.
 * 8. **Then** write the record — so a challan never exists without the
 *    document it promises. If the write fails, the object just uploaded is
 *    discarded rather than left behind.
 *
 * Anything that throws releases the claim, so the operator can correct the
 * problem and submit the same entry again. The identifiers it had already
 * allocated are not reused: a gap in the SL sequence costs nothing, and
 * recycling an identifier is how two challans end up sharing one.
 *
 * There is deliberately no MongoDB transaction. R2 is not part of one, and
 * holding a transaction open across a PDF build and an upload would pin an M0
 * connection for the length of somebody's broadband.
 */
export async function submitChallan(
  input: SubmitChallanInput,
  file: SubmitChallanFile,
  actor: UserDocument,
): Promise<SubmitChallanResult> {
  // Before anything is allocated: an unconfigured deployment must answer
  // "storage is not set up" rather than burn an SL number on a submission that
  // could never have been stored.
  requireStorage();

  assertUploadableExtract(file.buffer, file.mimeType);

  const range = {
    startPage: input.sourcePageStart,
    endPage: input.sourcePageEnd,
  };
  const expectedPages = pageCountOf(range);
  const actualPages = await readPageCount(file.buffer, "challan pages");

  /**
   * The check that ties the declared range to the bytes.
   *
   * `sourcePageCount` is the browser's word about a file this API never
   * receives, so on its own it proves nothing. This does: whatever the form
   * said, the pages actually uploaded have to be exactly as many as the range
   * claims. A range edited in a request body no longer matches its own
   * document, and is refused.
   */
  if (actualPages !== expectedPages) {
    throw new AppError(
      400,
      "Those pages do not match the selected range: the range covers " +
        expectedPages +
        " page" +
        (expectedPages === 1 ? "" : "s") +
        " and " +
        actualPages +
        " arrived.",
    );
  }

  await claimSubmission(input.submissionKey, actor);

  let uploadedKey: string | null = null;

  try {
    const batch = await ensureBatch(input, actor);

    const fields = normalizeFields(input);

    /**
     * The three questions asked of the collection before anything is
     * allocated, run **together**.
     *
     * They are independent reads — is this page range free, has this delivery
     * already been filed, and where is it going — and they used to be three
     * waits in a row. Location resolution is the expensive one because it can
     * reach an external model, so overlapping it with two indexed queries is
     * most of what makes a submission feel slower than it needs to.
     *
     * What is deliberately *not* parallelised is the order the answers are
     * acted on. Each returns a value rather than throwing, and the refusals
     * below happen in exactly the sequence they always did — a bad page range
     * is reported ahead of a possible duplicate, whichever query finished
     * first. Only an infrastructure failure can reject here, and that is a 500
     * whichever of the three hits it.
     *
     * The cost is that a submission about to be refused now also pays for a
     * location lookup it will not use. That is one read against a cached
     * master list, and a refusal is the rare case.
     */
    const duplicateProbe = input.acknowledgeDuplicate
      ? null
      : {
          sessionKey: input.sessionKey,
          // A resumed session's key names no batch, so the inside-this-PDF
          // probe would find nothing without it.
          batchId: input.batchId,
          customerName: input.customerName,
          /**
           * The address is part of the question now, not context beside it.
           * One customer takes the same model to twenty branches out of one
           * PDF, and every one of those is a different delivery — without the
           * address and the number this asked about the organisation rather
           * than the delivery, and fired on almost every sheet.
           */
          deliveryAddress: input.deliveryAddress,
          receiverMobile: input.receiverMobile,
          // The first line stands for the load. Probing every model would find
          // more matches and ask a longer question; the operator is deciding
          // "is this the same delivery", and one product answers that — the
          // same choice Gate Pass makes at submit time.
          model: input.items[0]?.model ?? "",
          excludeId: "",
        };

    const [claimed, duplicates, location] = await Promise.all([
      claimedRangesFor(batch._id),
      duplicateProbe
        ? findDuplicateChallans(duplicateProbe, actor)
        : Promise.resolve([]),
      /**
       * `decideLocation` cannot refuse a submission: an unresolvable location
       * comes back as blank and Pending, and the challan files exactly as it
       * would have. That is what makes it safe to run beside the two checks
       * that can.
       */
      decideLocation(
        {
          thana: fields.thana,
          district: fields.district,
          deliveryAddress: fields.deliveryAddress,
          locationId: input.locationId,
        },
        null,
        actor,
      ),
    ]);

    const problem = checkRangeAgainst(range, batch.sourcePageCount, claimed);
    if (problem) {
      throw new PageRangeError(problem);
    }

    if (duplicates.length > 0) {
      throw new DuplicateChallanError(duplicates);
    }

    /**
     * The two identifiers and the rate card lookup, together.
     *
     * Pricing needs the location, which is settled above, and nothing else —
     * it does not need a challan number and the back page does not need a
     * price. They were one after the other for no reason beyond the order they
     * were written in.
     *
     * Awaited as a pair rather than started and picked up later: a promise
     * left dangling while something between here and the create call throws
     * becomes an unhandled rejection, and this process shuts itself down on
     * one of those.
     */
    const [identifiers, pricedItems] = await Promise.all([
      allocateChallanIdentifiers(),
      withRates(fields.items, location),
    ]);
    const submittedAt = new Date();

    /**
     * Two values, because the back page prints two. Everything it used to
     * restate — the customer, the address, the receiver, the goods — is
     * already on the challan pages this sheet is bound behind.
     */
    const backPage = await generateChallanBackPage({
      slNumber: identifiers.slNumber,
      challanNumber: identifiers.challanNumber,
    });

    const finalPdf = await generateChallanFinalPdf({
      frontPages: new Uint8Array(file.buffer),
      backPage,
    });

    const stored = await uploadChallanDocument(
      identifiers.challanNumber,
      finalPdf,
      actualPages + 1,
    );
    uploadedKey = stored.key;

    const challan = await ChallanModel.create({
      slNumber: identifiers.slNumber,
      challanNumber: identifiers.challanNumber,
      batchId: batch._id,
      sourceFileName: input.sourceFileName,
      sourcePageStart: input.sourcePageStart,
      sourcePageEnd: input.sourcePageEnd,
      ...fields,
      // Priced above rather than in `normalizeFields`, because the column of
      // the rate card that applies is decided by the location.
      items: pricedItems,
      ...location,
      status: "Submitted",
      document: {
        key: stored.key,
        size: stored.size,
        pageCount: stored.pageCount,
        generatedAt: stored.generatedAt,
      },
      createdBy: actor._id,
      submittedBy: actor._id,
      submittedAt,
    });

    // The record now owns the object, so a later failure must not delete it.
    uploadedKey = null;

    /**
     * Both tail writes together. They touch different collections and neither
     * reads what the other wrote — the batch's page counts and the
     * idempotency claim have nothing to say to each other — so waiting for one
     * before starting the other was a round trip spent on nothing.
     */
    await Promise.all([
      refreshBatchProgress(batch._id),
      ChallanSubmissionModel.updateOne(
        { _id: input.submissionKey },
        { $set: { status: "completed", challanId: challan._id } },
      ),
    ]);

    return { record: await serialize(challan, actor), wasAlreadySubmitted: false };
  } catch (error) {
    // The document was written but the record never was, so nothing points at
    // it and nothing ever will. Cleaned up rather than left as an orphan.
    await discardChallanDocument(uploadedKey);
    await releaseSubmission(input.submissionKey);
    throw error;
  }
}

/** Answers a replay of an already-completed submission with what it produced. */
export async function getSubmittedChallan(
  challanId: string,
): Promise<SubmitChallanResult> {
  const challan = await ChallanModel.findById(challanId);

  if (!challan) {
    // The claim outlived the record: the challan was filed and then deleted.
    // Saying so is better than a 200 pointing at nothing.
    throw new AppError(
      409,
      "That challan was submitted and has since been deleted. Start the entry again.",
    );
  }

  return { record: await serialize(challan), wasAlreadySubmitted: true };
}

// ---------------------------------------------------------------------------
// Correcting and removing
// ---------------------------------------------------------------------------

/**
 * Corrects a filed challan, and rebuilds its document to match.
 *
 * A correction that left the stored PDF alone would produce exactly the thing
 * this module cannot have: a back page whose customer name, product or
 * quantity disagrees with the record it belongs to, printed and filed and
 * indistinguishable from a correct one. So every save regenerates the back
 * page and rewrites the document.
 *
 * The original front pages come back out of the stored document rather than
 * from the source PDF, which no longer exists anywhere. That is what makes a
 * correction possible weeks after the WhatsApp file has gone — and why the
 * back page is always the last page.
 *
 * The order is the same as everywhere else in this codebase: build, upload,
 * write the reference, then delete what it replaced. The worst outcome of a
 * failure is an orphaned object, never a challan pointing at a document that
 * is not there.
 */
export async function updateChallan(
  id: string,
  input: UpdateChallanInput,
  actor: UserDocument,
): Promise<ChallanRecord> {
  requireStorage();

  const challan = await findChallan(id);
  assertCanEdit(challan, actor);

  const previousKey = challan.document.key;
  const fields = normalizeFields(input);

  /**
   * The location, decided again — except where somebody had already decided
   * it. `decideLocation` keeps an `admin_manual` result untouched, so
   * correcting a typo in a customer name cannot quietly undo an
   * administrator's classification. An explicit `locationId` in this request
   * is that administrator, and does replace it.
   */
  const location = await decideLocation(
    {
      thana: fields.thana,
      district: fields.district,
      deliveryAddress: fields.deliveryAddress,
      locationId: input.locationId,
    },
    challan.resolvedLocation,
    actor,
  );

  /**
   * Regenerated from the two identifiers, which a correction cannot change —
   * so the new back page is byte-for-byte what the old one said.
   *
   * It is rebuilt anyway rather than lifted from the stored document, because
   * that keeps one rule ("the back page is generated from the record") instead
   * of two, and the cost is one page of drawing. What it does mean is that a
   * correction no longer changes anything on paper: see the note on `Amended`
   * in CLAUDE.md.
   */
  const backPage = await generateChallanBackPage({
    slNumber: challan.slNumber,
    challanNumber: challan.challanNumber,
  });

  const stored = await readChallanDocument(previousKey);
  const regenerated = await replaceChallanBackPage(stored, backPage);

  const uploaded = await uploadChallanDocument(
    challan.challanNumber,
    regenerated,
    challan.document.pageCount,
  );

  /**
   * Re-priced from the corrected lines. A correction can change the product,
   * the model, the quantity or the location, and every one of those changes
   * what the challan should be charged — so the figures are worked out again
   * rather than carried over. The card is read fresh, which means a challan
   * corrected after a price rise is charged at the new figure; that is the
   * right answer, because the correction is what decides the charge and it is
   * happening now.
   */
  challan.set(fields);
  challan.set("items", await withRates(fields.items, location));
  challan.set("resolvedLocation", location.resolvedLocation);
  challan.locationStatus = location.locationStatus;
  challan.status = "Amended";
  challan.amendedAt = new Date();
  challan.updatedBy = actor._id;
  challan.document = {
    key: uploaded.key,
    size: uploaded.size,
    pageCount: uploaded.pageCount,
    generatedAt: uploaded.generatedAt,
  };

  try {
    await challan.save();
  } catch (error) {
    // The new document is already unreachable, so it goes rather than sitting
    // in the bucket forever.
    await discardChallanDocument(uploaded.key);
    throw error;
  }

  await discardChallanDocument(previousKey);

  return serialize(challan);
}

/**
 * Removes a challan entirely — the record and its document, in that order, so
 * the worst outcome of a failure is an orphan rather than a live reference to
 * a deleted object.
 *
 * The batch is recomputed afterwards, which is what re-opens a batch that had
 * been complete: its pages are unassigned again, and it can no longer be
 * downloaded as a finished set. A batch left with no challans at all is
 * deleted, because it only ever existed because one came out of that file.
 */
export async function removeChallan(
  id: string,
  actor: UserDocument,
): Promise<{ id: string }> {
  const challan = await findChallan(id);
  assertCanDelete(challan, actor);

  const key = challan.document.key;
  const batchId = challan.batchId;

  await challan.deleteOne();
  await discardChallanDocument(key);
  await refreshBatchProgress(batchId);

  return { id: String(challan._id) };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/**
 * Records that a challan has been sent to a printer, or takes that back.
 *
 * The point of the module is a printed challan going out with the goods, and
 * until now nothing on the record said whether that had happened — `Submitted`
 * means filed, not printed. An operator working through a stack of fifteen,
 * or coming back to a batch the next morning, has no other way to tell which
 * sheets are already on the counter.
 *
 * What this stores is a **dispatch**, not a sheet of paper: the browser hands
 * the document to a print dialog and never learns whether Print or Cancel was
 * pressed, or whether the tray was empty. So it is a claim, and a claim has to
 * be correctable — which is what `printed: false` is for, and why nothing
 * anywhere refuses an action because a challan is already marked printed.
 *
 * Deliberately not scoped to the challan's author, unlike correcting or
 * deleting one. Those change what the record says; this says what came out of
 * a printer, and the person standing at the printer is whoever is standing at
 * it. The write roles are the boundary, applied on the route.
 */
export async function setChallanPrinted(
  id: string,
  printed: boolean,
  actor: UserDocument,
): Promise<ChallanRecord> {
  const challan = await findChallan(id);

  challan.printedAt = printed ? new Date() : null;
  challan.printedBy = printed ? actor._id : null;
  await challan.save();

  // Keeps the batch's denormalised count in step, so the batch page and the
  // record can never disagree about how much of a file has been printed.
  await refreshBatchProgress(challan.batchId);

  return serialize(challan);
}

/**
 * The same, for every challan in one batch at once.
 *
 * This is what the batch document is for: an operator prints a whole source
 * file as one PDF, and marking its fifteen challans one at a time afterwards
 * would be fifteen chances to lose count. One call, one statement — these
 * came out of the printer together, because they were printed together.
 *
 * `updateMany` rather than a loop of saves: this is two fields on documents
 * that are otherwise untouched, and fifteen round trips to an M0 cluster to
 * set a date would be the most expensive write in the module for no reason.
 */
export async function setBatchPrinted(
  id: string,
  printed: boolean,
  actor: UserDocument,
): Promise<ChallanBatchDetail> {
  const batch = await findBatch(id);

  await ChallanModel.updateMany(
    { batchId: batch._id },
    printed
      ? { $set: { printedAt: new Date(), printedBy: actor._id } }
      : { $set: { printedAt: null, printedBy: null } },
  );

  await refreshBatchProgress(batch._id);

  return getChallanBatch(id);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface ChallanDownload extends ObjectStream {
  filename: string;
}

/**
 * Streams one challan's document.
 *
 * The only read path for it. The bucket is never the source: the object is
 * stored privately and served from here, so a customer's home address is
 * behind the same authentication and the same role check as the record it
 * belongs to.
 */
export async function readChallanDocumentStream(
  id: string,
): Promise<ChallanDownload> {
  const challan = await findChallan(id);
  const object = await openChallanDocument(challan.document.key);

  return {
    ...object,
    // Named after the challan rather than after anything the operator chose,
    // so a folder of downloads sorts usefully.
    filename: challan.challanNumber + ".pdf",
  };
}

export interface BatchDownload {
  pdf: Uint8Array;
  filename: string;
  challanCount: number;
}

/**
 * The whole batch as one PDF: every challan's front pages and back page, in
 * the order the source file had them.
 *
 * Refused while the batch is unfinished. A "complete batch" document missing
 * the two challans nobody got round to filing is worse than no document —
 * somebody would print it, file it, and never learn what was not in it.
 *
 * Expensive by nature: every challan document is pulled into memory and merged
 * there, because pdf-lib parses a cross-reference table at the end of each
 * file and cannot stream. Hence the ceiling and the rate limit on the route.
 */
export async function buildBatchPdf(id: string): Promise<BatchDownload> {
  const batch = await findBatch(id);

  if (batch.status !== "Completed") {
    const remaining = Math.max(
      batch.sourcePageCount - batch.assignedPageCount,
      0,
    );
    throw new AppError(
      409,
      "This batch is not finished: " +
        remaining +
        " page" +
        (remaining === 1 ? "" : "s") +
        " of the source PDF " +
        (remaining === 1 ? "is" : "are") +
        " neither filed as a challan nor marked as blank.",
    );
  }

  const challans = await ChallanModel.find({ batchId: batch._id })
    .sort({ sourcePageStart: 1 })
    .select("document challanNumber");

  if (challans.length === 0) {
    throw new AppError(404, "This batch has no challans to assemble.");
  }

  if (challans.length > MAX_BATCH_MERGE_CHALLANS) {
    throw new AppError(
      400,
      "That batch holds " +
        challans.length +
        " challans, more than the " +
        MAX_BATCH_MERGE_CHALLANS +
        " this can merge in one file. Download them individually.",
    );
  }

  const documents: Uint8Array[] = [];
  for (const challan of challans) {
    documents.push(await readChallanDocument(challan.document.key));
  }

  const pdf = await mergeChallanPdfs(documents);
  const safeName = batch.sourceFileName
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");

  return {
    pdf,
    filename: "LBTS-batch-" + (safeName || String(batch._id)) + ".pdf",
    challanCount: challans.length,
  };
}

/** Re-exported so the controller can narrow a status without importing twice. */
export type { ChallanStatus };
