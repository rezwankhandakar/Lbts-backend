import { MAX_CHALLAN_PAGES, MAX_SOURCE_PAGES } from "../challan.constants";

/**
 * Page ranges over one source PDF, as pure arithmetic.
 *
 * A challan is a slice of the WhatsApp file — pages 3 to 5 of 24 — and every
 * interesting rule about that slice is a statement about integers: it has to
 * be inside the document, it has to run forwards, and it must not claim pages
 * another challan already took. None of that needs a database or a PDF, so
 * none of it is written where a database or a PDF is in the way.
 *
 * The frontend mirrors this file so the workspace can say "pages 3–5 overlap
 * LBTS-CH-2026-000004" before anything is sent. The server runs the same rules
 * against what is actually on record, and that is the check that decides.
 */

export interface PageRange {
  startPage: number;
  endPage: number;
}

/** A range already claimed by a submitted challan, with something to name it. */
export interface ClaimedRange extends PageRange {
  challanNumber: string;
}

export type RangeProblem =
  | { code: "not-a-page"; message: string }
  | { code: "reversed"; message: string }
  | { code: "out-of-bounds"; message: string }
  | { code: "too-many-pages"; message: string }
  | { code: "overlap"; message: string; conflicts: ClaimedRange[] };

export function pageCountOf(range: PageRange): number {
  return range.endPage - range.startPage + 1;
}

/** "page 4" or "pages 4–6", for a sentence a person reads. */
export function describeRange(range: PageRange): string {
  return range.startPage === range.endPage
    ? `page ${range.startPage}`
    : `pages ${range.startPage}\u2013${range.endPage}`;
}

/**
 * Whether the range itself makes sense, before anything else is consulted.
 *
 * `sourcePageCount` is what the browser reported about a file this API never
 * receives, so it bounds the range rather than proving it. What proves it is
 * `assertExtractMatchesRange` below: the uploaded extract has to carry exactly
 * as many pages as the range claims, which no client can fake by editing a
 * number in a form.
 */
export function checkRange(
  range: PageRange,
  sourcePageCount: number,
): RangeProblem | null {
  const { startPage, endPage } = range;

  if (!Number.isInteger(startPage) || !Number.isInteger(endPage)) {
    return {
      code: "not-a-page",
      message: "A page number has to be a whole number.",
    };
  }

  if (startPage < 1) {
    return {
      code: "not-a-page",
      message: "The first page of a challan is page 1 or later.",
    };
  }

  if (endPage < startPage) {
    return {
      code: "reversed",
      message: "The last page comes before the first page.",
    };
  }

  if (!Number.isInteger(sourcePageCount) || sourcePageCount < 1) {
    return {
      code: "out-of-bounds",
      message: "The source PDF has no pages to select from.",
    };
  }

  if (sourcePageCount > MAX_SOURCE_PAGES) {
    return {
      code: "out-of-bounds",
      message: `That PDF has ${sourcePageCount} pages. This workspace handles up to ${MAX_SOURCE_PAGES}.`,
    };
  }

  if (endPage > sourcePageCount) {
    return {
      code: "out-of-bounds",
      message: `The source PDF ends at page ${sourcePageCount}.`,
    };
  }

  if (pageCountOf(range) > MAX_CHALLAN_PAGES) {
    return {
      code: "too-many-pages",
      message: `That is ${pageCountOf(range)} pages for one challan. The limit is ${MAX_CHALLAN_PAGES}.`,
    };
  }

  return null;
}

export function rangesOverlap(a: PageRange, b: PageRange): boolean {
  return a.startPage <= b.endPage && b.startPage <= a.endPage;
}

/** Every claimed range this one collides with, in page order. */
export function findOverlaps(
  range: PageRange,
  claimed: ClaimedRange[],
): ClaimedRange[] {
  return claimed
    .filter((other) => rangesOverlap(range, other))
    .sort((left, right) => left.startPage - right.startPage);
}

/**
 * The full check: the range on its own, then against what the batch already
 * holds. Overlap is never silently allowed — the same page cannot be the front
 * of two different challans, and a batch where it was would produce two
 * documents claiming the same piece of paper.
 */
export function checkRangeAgainst(
  range: PageRange,
  sourcePageCount: number,
  claimed: ClaimedRange[],
): RangeProblem | null {
  const problem = checkRange(range, sourcePageCount);
  if (problem) {
    return problem;
  }

  const conflicts = findOverlaps(range, claimed);
  if (conflicts.length > 0) {
    return {
      code: "overlap",
      message: `${describeRange(range)} already belong${
        pageCountOf(range) === 1 ? "s" : ""
      } to ${conflicts.map((conflict) => conflict.challanNumber).join(", ")}.`,
      conflicts,
    };
  }

  return null;
}

/**
 * Pages of the source nobody has claimed yet, collapsed into ranges.
 *
 * This is what decides whether a batch is finished, and it is deliberately not
 * a count the operator types: "15 challans" is a guess, "every page belongs to
 * something" is a fact. It is also what the workspace shows before somebody
 * closes a session with two pages still unfiled.
 */
export function unassignedRanges(
  claimed: PageRange[],
  sourcePageCount: number,
): PageRange[] {
  if (sourcePageCount < 1) {
    return [];
  }

  const taken = new Set<number>();
  for (const range of claimed) {
    for (
      let page = Math.max(1, range.startPage);
      page <= Math.min(sourcePageCount, range.endPage);
      page += 1
    ) {
      taken.add(page);
    }
  }

  const gaps: PageRange[] = [];
  let open: PageRange | null = null;

  for (let page = 1; page <= sourcePageCount; page += 1) {
    if (taken.has(page)) {
      if (open) {
        gaps.push(open);
        open = null;
      }
      continue;
    }

    if (open) {
      open.endPage = page;
    } else {
      open = { startPage: page, endPage: page };
    }
  }

  if (open) {
    gaps.push(open);
  }

  return gaps;
}

/** How many distinct pages of the source are spoken for. */
export function assignedPageCount(
  claimed: PageRange[],
  sourcePageCount: number,
): number {
  const taken = new Set<number>();
  for (const range of claimed) {
    for (
      let page = Math.max(1, range.startPage);
      page <= Math.min(sourcePageCount, range.endPage);
      page += 1
    ) {
      taken.add(page);
    }
  }
  return taken.size;
}

export interface BatchProgress {
  sourcePageCount: number;
  assignedPages: number;
  unassignedPages: number;
  challanCount: number;
  /** 0-100, rounded. The figure the progress bar renders. */
  percent: number;
  isComplete: boolean;
}

/**
 * Where a batch has got to.
 *
 * Progress is measured in pages rather than in challans because pages are the
 * only quantity both sides agree on: the operator decides how many challans a
 * 24-page file contains, and the file decides how many pages it has. A batch
 * is finished when nothing is left over.
 */
export function batchProgress(
  claimed: PageRange[],
  sourcePageCount: number,
  challanCount: number,
): BatchProgress {
  const assigned = assignedPageCount(claimed, sourcePageCount);
  const total = Math.max(sourcePageCount, 0);

  return {
    sourcePageCount: total,
    assignedPages: assigned,
    unassignedPages: Math.max(total - assigned, 0),
    challanCount,
    percent: total > 0 ? Math.round((assigned / total) * 100) : 0,
    isComplete: total > 0 && assigned === total,
  };
}
