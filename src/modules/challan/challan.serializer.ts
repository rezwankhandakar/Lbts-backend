import type { Types } from "mongoose";
import { batchProgress, unassignedRanges } from "./lib/page-ranges";
import type { PageRange } from "./lib/page-ranges";
import type {
  LocationSource,
  LocationStatus,
  LocationType,
} from "../location/location.constants";
import type { Rate } from "../product-rate/product-rate.constants";
import { totalOf } from "../product-rate/product-rate.pricing";
import type { ChallanBatchStatus, ChallanStatus } from "./challan.constants";
import type { ChallanBatchDocument } from "./challan-batch.model";
import type { ChallanDocument } from "./challan.model";

/**
 * What one product line was charged, as a client sees it.
 *
 * The stored sub-document keeps all five rate fields so a corrected row cannot
 * leave a stale figure behind; this is where that becomes the discriminated
 * union a client can actually render, so nothing on the other side has to know
 * which fields mean anything for which kind.
 */
export interface ChallanItemRate {
  masterId: string;
  /** Which column of the rate card was used. */
  locationType: LocationType;
  rate: Rate;
  /** This line's charge, tiered arithmetic already done. */
  amount: number;
  appliedAt: string;
}

/**
 * One product line, as a client sees it.
 *
 * The field is `model` here and `productModel` in MongoDB — the stored name
 * avoids a collision with Mongoose's own `Document.model()`, and this is where
 * the two are mapped. The same arrangement Gate Pass uses.
 */
export interface ChallanItem {
  productName: string;
  model: string;
  qty: number;
  /** The rate card's capacity band, or blank when no row answered. */
  capacity: string;
  /**
   * What this line was charged, or null because nothing costed it — a product
   * the rate card does not carry, or a challan whose location is still
   * Pending. Null is ordinary and never blocks anything.
   */
  rate: ChallanItemRate | null;
}

/** Who filed a record or last changed it, resolved to something displayable. */
export interface ActorRef {
  id: string;
  name: string;
}

/**
 * The generated document, as a client sees it.
 *
 * `url` is an API path, not a Cloudflare URL. A challan carries a customer's
 * home address and phone number, so the object is never served from a public
 * bucket: GET /challans/:id/document re-checks authentication and role and
 * streams it. That is the one place the R2 key is used, and the key is not
 * exposed here — it has no meaning to a client.
 */
export interface ChallanDocumentRef {
  url: string;
  /** Always a PDF. Present so the viewer needs no special case for this module. */
  mimeType: "application/pdf";
  size: number;
  /** Front pages plus the one generated back page. */
  pageCount: number;
  generatedAt: string;
}

/**
 * Where a challan actually went, as a client sees it.
 *
 * Separate from `thana` and `district` on the record, which are the text an
 * operator transcribed. This is what that text was resolved to in the Location
 * Master, and the two are shown side by side rather than one replacing the
 * other — the paper said one thing, the system worked out another, and both
 * are worth being able to look at.
 */
export interface ResolvedLocationRef {
  masterId: string
  district: string
  thana: string
  locationType: LocationType
  /** How it was decided. Diagnostic; the UI shows a plain sentence instead. */
  source: LocationSource
  confidence: number
  resolvedAt: string
  /** Who chose it, when a person did. Null for anything the system decided. */
  resolvedBy: ActorRef | null
}

export interface ChallanRecord {
  id: string;
  slNumber: number;
  challanNumber: string;
  status: ChallanStatus;

  batchId: string;
  sourceFileName: string;
  sourcePageStart: number;
  sourcePageEnd: number;
  /** Derived, so a list can say "3 pages" without doing the arithmetic. */
  sourcePageCount: number;

  customerName: string;
  deliveryAddress: string;
  thana: string;
  district: string;
  receiverMobile: string;
  senderMobile: string | null;
  zonePo: string | null;

  /**
   * Where this went, or null because nobody has determined it yet. Null is an
   * ordinary state — it never stopped the challan being filed and it never
   * stops anything else either.
   */
  resolvedLocation: ResolvedLocationRef | null;
  /** `Verified` exactly when `resolvedLocation` is set. */
  locationStatus: LocationStatus;

  /** One line per product on the challan; always at least one. */
  items: ChallanItem[];
  /** Every quantity added up. Derived, so a list can show one number. */
  totalQty: number;
  /**
   * Every priced line added up, or null because nothing on this challan could
   * be priced.
   *
   * Null rather than zero, and the distinction is the point: zero is a challan
   * that costs nothing, null is a challan nobody has costed. A report that
   * treated them alike would quietly average one into the other.
   */
  totalAmount: number | null;
  /**
   * How many lines carry no rate. Present so a total is never shown as though
   * it covered the whole challan when it covered three lines of four — the
   * missing line is exactly the one somebody needs to know about.
   */
  unpricedItems: number;

  document: ChallanDocumentRef;

  createdBy: ActorRef | null;
  submittedBy: ActorRef | null;
  updatedBy: ActorRef | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  amendedAt: string | null;

  /**
   * When this challan was last sent to a printer, or null if nobody has. A
   * dispatch rather than a sheet of paper — see the model — which is why the
   * client offers a way to clear it.
   */
  printedAt: string | null;
  printedBy: ActorRef | null;
}

/** One source file, and how far through it the operation has got. */
export interface ChallanBatchRecord {
  id: string;
  sourceFileName: string;
  sourcePageCount: number;
  sourceFileSize: number | null;
  status: ChallanBatchStatus;
  challanCount: number;
  /** Filed plus marked-blank: everything the operator has accounted for. */
  assignedPages: number;
  unassignedPages: number;
  /** Pages the operator said are not challans, in ascending order. */
  skippedPages: number[];
  percent: number;
  isComplete: boolean;
  completedAt: string | null;
  /** How many of this batch's challans have been sent to a printer. */
  printedChallanCount: number;
  /** True once every challan in it has. A batch with none is never printed. */
  isPrinted: boolean;
  createdBy: ActorRef | null;
  createdAt: string;
  updatedAt: string;
}

/** The batch page: the batch, its challans, and what is still unaccounted for. */
export interface ChallanBatchDetail extends ChallanBatchRecord {
  challans: ChallanRecord[];
  /**
   * Pages of the source PDF nobody has accounted for — neither filed as a
   * challan nor marked as not being one — collapsed into ranges. Empty for a
   * finished batch, and the list the batch page asks the operator to resolve.
   */
  unassignedRanges: PageRange[];
  /** The marked-blank pages, collapsed the same way, so they can be undone. */
  skippedRanges: PageRange[];
}

/**
 * The narrow view the duplicate dialog renders. Deliberately not a full
 * record: the operator is deciding "have I already filed this one", and
 * anything beyond these fields is noise at that moment.
 */
export interface DuplicateChallanCandidate {
  id: string;
  slNumber: number;
  challanNumber: string;
  customerName: string;
  deliveryAddress: string;
  receiverMobile: string;
  /** The first product line, which is enough to recognise the delivery. */
  product: string;
  model: string;
  qty: number;
  /** How many more lines the record carries beyond the one shown. */
  moreItems: number;
  sourceFileName: string;
  sourcePageStart: number;
  sourcePageEnd: number;
  /** Which probe matched, so the dialog can say why it is asking. */
  matchedOn: "batch" | "recent";
}

/**
 * The stored rate sub-document as the union a client renders.
 *
 * Defensive about a line written before rates existed, and about one whose
 * fields disagree with its kind: both come back as no rate rather than as a
 * zero, because zero is a price and "nobody costed this" is not.
 */
function toItemRate(
  stored: NonNullable<ChallanDocument["items"][number]["rate"]> | null | undefined,
): ChallanItemRate | null {
  if (!stored) {
    return null;
  }

  let rate: Rate | null = null;

  if (stored.kind === "flat" && typeof stored.unitAmount === "number") {
    rate = { kind: "flat", amount: stored.unitAmount };
  } else if (
    stored.kind === "tiered" &&
    typeof stored.firstQty === "number" &&
    typeof stored.firstAmount === "number" &&
    typeof stored.restAmount === "number"
  ) {
    rate = {
      kind: "tiered",
      firstQty: stored.firstQty,
      firstAmount: stored.firstAmount,
      restAmount: stored.restAmount,
    };
  }

  if (!rate) {
    return null;
  }

  return {
    masterId: String(stored.masterId),
    locationType: stored.locationType as LocationType,
    rate,
    amount: stored.amount,
    appliedAt: stored.appliedAt.toISOString(),
  };
}

/** The stored rows, with `productModel` renamed back to `model`. */
function toItems(challan: ChallanDocument): ChallanItem[] {
  return challan.items.map((item) => ({
    productName: item.productName,
    model: item.productModel,
    qty: item.qty,
    capacity: item.capacity ?? "",
    rate: toItemRate(item.rate),
  }));
}

/**
 * The stored location sub-document, or null.
 *
 * Defensive about a record written before the field existed: the migration
 * fills those in, but a serializer that threw on one would take a whole list
 * page down for one legacy row.
 */
function toResolvedLocation(
  challan: ChallanDocument,
  actorNames: Map<string, string>,
): ResolvedLocationRef | null {
  const location = challan.resolvedLocation;
  if (!location) {
    return null;
  }

  return {
    masterId: String(location.masterId),
    district: location.district,
    thana: location.thana,
    locationType: location.locationType as LocationType,
    source: location.source as LocationSource,
    confidence: location.confidence,
    resolvedAt: location.resolvedAt.toISOString(),
    resolvedBy: actorFrom(location.resolvedBy, actorNames),
  };
}

function totalQtyOf(challan: ChallanDocument): number {
  return challan.items.reduce((total, item) => total + item.qty, 0);
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function actorFrom(
  id: Types.ObjectId | null | undefined,
  names: Map<string, string>,
): ActorRef | null {
  if (!id) {
    return null;
  }
  const key = String(id);
  // An actor whose own account was deleted still leaves an id behind.
  return { id: key, name: names.get(key) ?? "Removed account" };
}

/**
 * `actorNames` maps an actor id to their display name. The caller resolves
 * every actor on a page of results in one indexed lookup rather than
 * populating row by row — on M0 the difference is worth the plumbing.
 */
export function toChallanRecord(
  challan: ChallanDocument,
  actorNames: Map<string, string>,
): ChallanRecord {
  const id = String(challan._id);
  const items = toItems(challan);
  /**
   * Derived rather than stored, exactly like `totalQty` and for the same
   * reason: a stored total is a number that can come to disagree with the rows
   * it is a total of, and this one would do it silently.
   */
  const totals = totalOf(items.map((item) => item.rate?.amount ?? null));

  return {
    id,
    slNumber: challan.slNumber,
    challanNumber: challan.challanNumber,
    status: challan.status as ChallanStatus,

    batchId: String(challan.batchId),
    sourceFileName: challan.sourceFileName,
    sourcePageStart: challan.sourcePageStart,
    sourcePageEnd: challan.sourcePageEnd,
    sourcePageCount: challan.sourcePageEnd - challan.sourcePageStart + 1,

    customerName: challan.customerName,
    deliveryAddress: challan.deliveryAddress,
    thana: challan.thana,
    district: challan.district,
    receiverMobile: challan.receiverMobile,
    senderMobile: challan.senderMobile ?? null,
    zonePo: challan.zonePo ?? null,

    resolvedLocation: toResolvedLocation(challan, actorNames),
    locationStatus: (challan.locationStatus as LocationStatus) ?? "Pending",

    items,
    totalQty: totalQtyOf(challan),
    totalAmount: totals.total,
    unpricedItems: totals.unpriced,

    document: {
      url: "/challans/" + id + "/document",
      mimeType: "application/pdf",
      size: challan.document.size,
      pageCount: challan.document.pageCount,
      generatedAt: challan.document.generatedAt.toISOString(),
    },

    createdBy: actorFrom(challan.createdBy, actorNames),
    submittedBy: actorFrom(challan.submittedBy, actorNames),
    updatedBy: actorFrom(challan.updatedBy, actorNames),
    createdAt: challan.createdAt.toISOString(),
    updatedAt: challan.updatedAt.toISOString(),
    submittedAt: challan.submittedAt.toISOString(),
    amendedAt: toIso(challan.amendedAt),

    printedAt: toIso(challan.printedAt),
    printedBy: actorFrom(challan.printedBy, actorNames),
  };
}

export function toChallanBatchRecord(
  batch: ChallanBatchDocument,
  actorNames: Map<string, string>,
): ChallanBatchRecord {
  const progress = batchProgress([], batch.sourcePageCount, batch.challanCount);

  return {
    id: String(batch._id),
    sourceFileName: batch.sourceFileName,
    sourcePageCount: batch.sourcePageCount,
    sourceFileSize: batch.sourceFileSize ?? null,
    status: batch.status as ChallanBatchStatus,
    challanCount: batch.challanCount,
    assignedPages: batch.assignedPageCount,
    unassignedPages: Math.max(
      batch.sourcePageCount - batch.assignedPageCount,
      0,
    ),
    skippedPages: [...batch.skippedPages].sort((a, b) => a - b),
    percent:
      batch.sourcePageCount > 0
        ? Math.round((batch.assignedPageCount / batch.sourcePageCount) * 100)
        : progress.percent,
    isComplete: batch.status === "Completed",
    completedAt: toIso(batch.completedAt),
    printedChallanCount: batch.printedChallanCount,
    /**
     * Every challan printed, and at least one to print. An empty batch cannot
     * be "all printed" — it would read as finished work when there is none.
     */
    isPrinted:
      batch.challanCount > 0 && batch.printedChallanCount >= batch.challanCount,
    createdBy: actorFrom(batch.createdBy, actorNames),
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
  };
}

/**
 * A batch with its challans, and — the part the batch page exists for — the
 * pages of the source PDF that still belong to nothing. A batch cannot be
 * called finished while that list has anything in it, and showing the gaps is
 * how an operator finds the challan they skipped.
 */
export function toChallanBatchDetail(
  batch: ChallanBatchDocument,
  challans: ChallanDocument[],
  actorNames: Map<string, string>,
): ChallanBatchDetail {
  const skipped = [...batch.skippedPages].sort((a, b) => a - b);

  /**
   * A marked-blank page counts as accounted for, so it is fed into the same
   * gap calculation as a filed challan — otherwise the batch page would keep
   * asking the operator to deal with pages they have already dealt with.
   */
  const claimed = [
    ...challans.map((challan) => ({
      startPage: challan.sourcePageStart,
      endPage: challan.sourcePageEnd,
    })),
    ...skipped.map((page) => ({ startPage: page, endPage: page })),
  ];

  return {
    ...toChallanBatchRecord(batch, actorNames),
    challans: challans.map((challan) => toChallanRecord(challan, actorNames)),
    unassignedRanges: unassignedRanges(claimed, batch.sourcePageCount),
    // Collapsed the same way, so "pages 7-9 marked blank" reads as one thing.
    skippedRanges: unassignedRanges(
      invert(skipped, batch.sourcePageCount),
      batch.sourcePageCount,
    ),
  };
}

/**
 * The complement of a page list, as ranges.
 *
 * `unassignedRanges` finds the gaps between claimed ranges, so feeding it
 * everything *except* the skipped pages hands back the skipped pages collapsed
 * into ranges — one function doing both jobs rather than a second range-merger
 * that could disagree with the first.
 */
function invert(pages: number[], total: number): PageRange[] {
  const marked = new Set(pages);
  const kept: PageRange[] = [];

  for (let page = 1; page <= total; page += 1) {
    if (!marked.has(page)) {
      kept.push({ startPage: page, endPage: page });
    }
  }

  return kept;
}

export function toDuplicateCandidate(
  challan: ChallanDocument,
  matchedOn: DuplicateChallanCandidate["matchedOn"],
): DuplicateChallanCandidate {
  return {
    id: String(challan._id),
    slNumber: challan.slNumber,
    challanNumber: challan.challanNumber,
    customerName: challan.customerName,
    deliveryAddress: challan.deliveryAddress,
    receiverMobile: challan.receiverMobile,
    product: challan.items[0]?.productName ?? "",
    model: challan.items[0]?.productModel ?? "",
    qty: challan.items[0]?.qty ?? 0,
    moreItems: Math.max(challan.items.length - 1, 0),
    sourceFileName: challan.sourceFileName,
    sourcePageStart: challan.sourcePageStart,
    sourcePageEnd: challan.sourcePageEnd,
    matchedOn,
  };
}
