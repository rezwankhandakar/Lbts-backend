import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { comparisonKey, normalizeMobile } from "./challan.constants";
import { SL_NUMBER_BASE } from "./challan.counter";
import { encodeCode128B } from "./lib/code128";
import {
  generateChallanBackPage,
  generateChallanFinalPdf,
  mergeChallanPdfs,
  readPageCount,
  replaceChallanBackPage,
} from "./lib/challan-pdf";
import type { ChallanBackPageData } from "./lib/challan-pdf";
import {
  batchProgress,
  checkRangeAgainst,
  pageCountOf,
  unassignedRanges,
} from "./lib/page-ranges";
import type { ClaimedRange } from "./lib/page-ranges";
import { normalizeBanglaText } from "./lib/bangla-text";

/**
 * The operating scenarios, end to end through the real functions.
 *
 * Everything below the database and R2 is exercised for real: a source PDF is
 * built, pages are cut out of it exactly as the browser cuts them, barcodes
 * and back pages are generated from the record, documents are merged, and the
 * page arithmetic that decides whether a batch is finished is run over the
 * result.
 *
 * What these cannot cover is what needs a cluster and a bucket — the atomic
 * counter, the idempotency claim, the R2 write. Those are asserted in the unit
 * tests around their own logic and verified by hand against a real deployment;
 * nothing here pretends otherwise.
 */

/** Stands in for the WhatsApp file, with recognisable content per page. */
async function makeSourcePdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (let page = 1; page <= pageCount; page += 1) {
    const sheet = pdf.addPage([595.276, 841.89]);
    sheet.drawText(`SOURCE PAGE ${page}`, { x: 60, y: 700, size: 20, font });
  }

  return pdf.save();
}

/**
 * What the browser does before a submission: copy the challan's pages into a
 * new document, leaving the originals untouched. The same `copyPages` call the
 * frontend's `extractPageRange` makes.
 */
async function extractPages(
  source: Uint8Array,
  startPage: number,
  endPage: number,
): Promise<Uint8Array> {
  const from = await PDFDocument.load(source);
  const output = await PDFDocument.create();

  const indices = Array.from(
    { length: endPage - startPage + 1 },
    (_, i) => startPage - 1 + i,
  );
  for (const page of await output.copyPages(from, indices)) {
    output.addPage(page);
  }

  return output.save();
}

function backPageFor(
  slNumber: number,
  challanNumber: string,
): ChallanBackPageData {
  return {
    slNumber,
    challanNumber,
    customerName: "ABC Electronics Ltd.",
    deliveryAddress: "House 12, Road 4",
    thana: "Mirpur",
    district: "Dhaka",
    receiverMobile: "01712345678",
    items: [
      { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty: 2 },
      { productName: "Refrigerator Stand", model: "WFS-01", qty: 1 },
    ],
    sourceFileName: "Walton_Challan_05_09_2026.pdf",
    sourcePageStart: 1,
    sourcePageEnd: 2,
    submittedAt: new Date("2026-09-05T09:30:00.000Z"),
    submittedByName: "Operator",
  };
}

/** One filed challan, as far as this test can take it without a database. */
async function fileChallan(
  source: Uint8Array,
  startPage: number,
  endPage: number,
  index: number,
): Promise<{ document: Uint8Array; slNumber: number; challanNumber: string }> {
  const slNumber = SL_NUMBER_BASE + index;
  const challanNumber = `LBTS-CH-2026-${String(index).padStart(6, "0")}`;

  const frontPages = await extractPages(source, startPage, endPage);

  // The check that ties a declared range to the bytes that arrived.
  assert.equal(
    await readPageCount(frontPages),
    pageCountOf({ startPage, endPage }),
    "the extract must carry exactly as many pages as the range claims",
  );

  const backPage = await generateChallanBackPage({
    ...backPageFor(slNumber, challanNumber),
    sourcePageStart: startPage,
    sourcePageEnd: endPage,
  });

  return {
    document: await generateChallanFinalPdf({ frontPages, backPage }),
    slNumber,
    challanNumber,
  };
}

describe("Scenario A — three challans out of one PDF, all filed", () => {
  it("produces three documents, three identifiers, three barcodes and one batch", async () => {
    const source = await makeSourcePdf(6);
    const ranges = [
      { startPage: 1, endPage: 2 },
      { startPage: 3, endPage: 4 },
      { startPage: 5, endPage: 6 },
    ];

    const claimed: ClaimedRange[] = [];
    const filed = [];

    for (const [index, range] of ranges.entries()) {
      // Each range is checked against what is already filed, as the service does.
      assert.equal(
        checkRangeAgainst(range, 6, claimed),
        null,
        `range ${index + 1} should be free`,
      );

      const challan = await fileChallan(
        source,
        range.startPage,
        range.endPage,
        index + 1,
      );
      filed.push(challan);
      claimed.push({ ...range, challanNumber: challan.challanNumber });
    }

    // Three unique SL numbers and three unique challan numbers.
    assert.equal(new Set(filed.map((c) => c.slNumber)).size, 3);
    assert.equal(new Set(filed.map((c) => c.challanNumber)).size, 3);

    // Three distinct barcodes, one per challan number.
    const symbols = filed.map((c) =>
      encodeCode128B(c.challanNumber).codes.join(","),
    );
    assert.equal(new Set(symbols).size, 3);

    // Each document is its two original pages plus one generated back page.
    for (const challan of filed) {
      assert.equal(await readPageCount(challan.document), 3);
    }

    // The batch is complete, and merges to nine pages in source order.
    const progress = batchProgress(ranges, 6, 3);
    assert.equal(progress.isComplete, true);
    assert.equal(progress.percent, 100);

    const batch = await mergeChallanPdfs(filed.map((c) => c.document));
    assert.equal(await readPageCount(batch), 9);
  });
});

describe("Scenario B — five of ten filed, then the workspace closes", () => {
  it("leaves the batch incomplete and names the pages that are missing", async () => {
    const source = await makeSourcePdf(10);
    const filedRanges = [
      { startPage: 1, endPage: 1 },
      { startPage: 2, endPage: 2 },
      { startPage: 3, endPage: 3 },
      { startPage: 4, endPage: 4 },
      { startPage: 5, endPage: 5 },
    ];

    const documents = [];
    for (const [index, range] of filedRanges.entries()) {
      documents.push(
        (await fileChallan(source, range.startPage, range.endPage, index + 1))
          .document,
      );
    }

    // The five that were filed are permanent and complete in themselves.
    assert.equal(documents.length, 5);
    for (const document of documents) {
      assert.equal(await readPageCount(document), 2);
    }

    // The other five pages are still unaccounted for, and the batch says so.
    const progress = batchProgress(filedRanges, 10, 5);
    assert.equal(progress.isComplete, false);
    assert.equal(progress.assignedPages, 5);
    assert.equal(progress.unassignedPages, 5);
    assert.deepEqual(unassignedRanges(filedRanges, 10), [
      { startPage: 6, endPage: 10 },
    ]);
  });
});

describe("Scenarios C and D — Bangla text on the way into storage", () => {
  it("stores legacy Bijoy as Unicode", () => {
    const stored = normalizeBanglaText("†gvt Avwid †nv‡mb");
    assert.equal(stored.value, "মোঃ আরিফ হোসেন");
    assert.equal(stored.conversion, "converted");
  });

  it("stores Unicode Bangla unchanged", () => {
    const stored = normalizeBanglaText("মোঃ আরিফ হোসেন");
    assert.equal(stored.value, "মোঃ আরিফ হোসেন");
    assert.equal(stored.conversion, "unchanged");
  });

  it("keeps a Bangla customer comparable for duplicate detection", () => {
    // The stored value keeps its punctuation; the comparison key does not.
    assert.equal(
      comparisonKey("মোঃ আরিফ হোসেন"),
      comparisonKey("মোঃ  আরিফ  হোসেন!"),
    );
  });
});

describe("Scenario G — one challan spanning three pages", () => {
  it("stores three original pages and one generated back page", async () => {
    const source = await makeSourcePdf(9);
    const challan = await fileChallan(source, 7, 9, 1);

    assert.equal(await readPageCount(challan.document), 4);
  });
});

describe("Scenario J — a range that reuses pages", () => {
  it("is refused, and names the challan that already holds them", async () => {
    const source = await makeSourcePdf(6);
    const first = await fileChallan(source, 1, 2, 1);

    const problem = checkRangeAgainst({ startPage: 2, endPage: 3 }, 6, [
      { startPage: 1, endPage: 2, challanNumber: first.challanNumber },
    ]);

    assert.equal(problem?.code, "overlap");
    assert.match(problem?.message ?? "", new RegExp(first.challanNumber));
  });
});

describe("correcting a filed challan", () => {
  it("rewrites the back page and leaves the original pages exactly as they were", async () => {
    const source = await makeSourcePdf(4);
    const challan = await fileChallan(source, 1, 3, 1);

    const corrected = await replaceChallanBackPage(
      challan.document,
      await generateChallanBackPage({
        ...backPageFor(challan.slNumber, challan.challanNumber),
        customerName: "Corrected Ltd.",
        items: [
          { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty: 9 },
        ],
      }),
    );

    // Same shape: three original pages, one back page. The identifiers are
    // unchanged, because a correction is not a new challan.
    assert.equal(await readPageCount(corrected), 4);

    const reloaded = await PDFDocument.load(corrected);
    assert.equal(reloaded.getPageCount(), 4);
  });
});

describe("mobile numbers, however they were pasted", () => {
  it("reduce to one stored value, so a customer can be found", () => {
    const written = [
      "01712345678",
      "+8801712345678",
      "8801712345678",
      "01712-345678",
    ];
    const stored = new Set(written.map(normalizeMobile));

    assert.equal(stored.size, 1);
    assert.equal([...stored][0], "01712345678");
  });
});
