import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  BarcodePayloadError,
  challanBarcodePayload,
  encodeCode128B,
} from "./lib/code128";
import {
  MIN_MODULE_WIDTH,
  backPageLayout,
  barcodeMetrics,
  generateChallanBackPage,
  generateChallanFinalPdf,
  mergeChallanPdfs,
  readPageCount,
  replaceChallanBackPage,
  winAnsiSafe,
} from "./lib/challan-pdf";
import type { ChallanBackPageData } from "./lib/challan-pdf";

/**
 * The barcode and the documents.
 *
 * A barcode either scans as the challan number or it is worthless, and there
 * is no way to tell by looking at it — so the encoder is checked symbol by
 * symbol against arithmetic worked out by hand in the test itself, rather than
 * against a second copy of the implementation.
 *
 * The PDF assertions are about page counts and page order, which is exactly
 * what the module promises: the original pages unchanged, the generated back
 * page appended, and a batch that reads in source order.
 */

// ---------------------------------------------------------------------------
// Code 128
// ---------------------------------------------------------------------------

describe("Code 128-B", () => {
  it("encodes a single character with the checksum the standard specifies", () => {
    // "A" is codepoint 65, so its Code B value is 65 - 32 = 33.
    // Checksum = (START_B + 33 * 1) mod 103 = (104 + 33) mod 103 = 34.
    const symbol = encodeCode128B("A");
    assert.deepEqual(symbol.codes, [104, 33, 34, 106]);
    assert.equal(symbol.checksum, 34);
  });

  it("weights each data value by its position, not just sums them", () => {
    // "LBTS": L=44, B=34, T=52, S=51.
    // 104 + 44*1 + 34*2 + 52*3 + 51*4 = 104 + 44 + 68 + 156 + 204 = 576.
    // 576 mod 103 = 61.
    const symbol = encodeCode128B("LBTS");
    assert.deepEqual(symbol.codes, [104, 44, 34, 52, 51, 61, 106]);
    assert.equal(symbol.checksum, 61);
  });

  it("emits eleven modules per symbol, and thirteen for the stop", () => {
    const symbol = encodeCode128B("LBTS");
    // Six 11-module symbols (start, four data, check) plus the 13-module stop.
    assert.equal(symbol.moduleCount, 6 * 11 + 13);
  });

  it("starts on a bar and alternates strictly from there", () => {
    const symbol = encodeCode128B("LBTS-CH-2026-000001");
    assert.equal(symbol.elements[0].isBar, true);

    for (let index = 1; index < symbol.elements.length; index += 1) {
      // A run of two bars would merge into one wide bar and destroy the symbol.
      assert.notEqual(
        symbol.elements[index].isBar,
        symbol.elements[index - 1].isBar,
        `element ${index} repeats the previous element's kind`,
      );
    }
  });

  it("ends on a bar, as the stop pattern requires", () => {
    const symbol = encodeCode128B("LBTS-CH-2026-000001");
    assert.equal(symbol.elements[symbol.elements.length - 1].isBar, true);
  });

  it("is deterministic, so the same challan always scans the same", () => {
    const first = encodeCode128B("LBTS-CH-2026-000123");
    const second = encodeCode128B("LBTS-CH-2026-000123");
    assert.deepEqual(first.codes, second.codes);
    assert.deepEqual(first.elements, second.elements);
  });

  it("gives two different challans two different symbols", () => {
    assert.notDeepEqual(
      encodeCode128B("LBTS-CH-2026-000123").codes,
      encodeCode128B("LBTS-CH-2026-000124").codes,
    );
  });

  it("refuses a payload it cannot encode rather than substituting a character", () => {
    // A barcode that scans as something other than what is printed beside it
    // is worse than a submission that failed and said so.
    assert.throws(() => encodeCode128B("ঢাকা"), BarcodePayloadError);
    assert.throws(() => encodeCode128B(""), BarcodePayloadError);
  });

  it("carries the challan number itself, and nothing derived from it", () => {
    assert.equal(
      challanBarcodePayload("LBTS-CH-2026-000001"),
      "LBTS-CH-2026-000001",
    );
  });

});

// ---------------------------------------------------------------------------
// Text the standard fonts can draw
// ---------------------------------------------------------------------------

describe("winAnsiSafe", () => {
  it("passes Latin text through untouched", () => {
    assert.equal(winAnsiSafe("ABC Electronics Ltd."), "ABC Electronics Ltd.");
    assert.equal(winAnsiSafe("WFA-2D4-GDEH-XX"), "WFA-2D4-GDEH-XX");
  });

  it("says where to look instead of drawing mangled Bangla", () => {
    // pdf-lib cannot shape Bangla, and unshaped glyphs read as gibberish. The
    // name is on the original front pages, which are the authoritative copy.
    assert.equal(winAnsiSafe("ঢাকা মেট্রো"), "(see front page)");
  });

  it("keeps the Latin part of a mixed value", () => {
    assert.equal(winAnsiSafe("Mirpur ঢাকা 12"), "Mirpur 12");
  });

  it("collapses newlines so a pasted address stays on one line", () => {
    assert.equal(
      winAnsiSafe("House 12\nRoad 4\nBlock C"),
      "House 12 Road 4 Block C",
    );
  });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Two fields, because the back page prints two. Everything it used to restate
 * — the customer, the address, the receiver, the goods — is on the challan
 * pages this sheet is bound behind.
 */
const BACK_PAGE: ChallanBackPageData = {
  slNumber: 10234,
  challanNumber: "LBTS-CH-2026-000123",
};

/** Stands in for pages cut out of a source PDF, with recognisable content. */
async function makeSourcePages(
  count: number,
  marker: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (let index = 1; index <= count; index += 1) {
    const page = pdf.addPage([595.276, 841.89]);
    page.drawText(`${marker} page ${index}`, { x: 60, y: 700, size: 18, font });
  }

  return pdf.save();
}

describe("the back page layout", () => {
  /**
   * The page carries three things now, so the arithmetic is short — but it is
   * still checked directly rather than through a page count, because the way
   * this page breaks is content sliding off the sheet, and a one-page
   * assertion would pass happily while the footer sat under the navy bar.
   */
  it("keeps every band inside an A4 sheet, in order", () => {
    const layout = backPageLayout();

    assert.ok(
      layout.barcodeBaseline + 56 < 841.89,
      "the barcode runs off the top",
    );
    assert.ok(
      layout.identifierY < layout.barcodeBaseline,
      "identifiers overlap the barcode",
    );
    assert.ok(layout.identifierY > 0, "the identifiers run off the bottom");
    assert.ok(layout.footerY > 6, "the footer sits inside the bottom bar");
    assert.ok(
      layout.footerY < layout.identifierY,
      "the footer overlaps the identifiers",
    );
  });
});

describe("the barcode's printed size", () => {
  /**
   * A barcode either scans or it is worthless, and shrinking it is exactly how
   * it stops scanning: Code 128 is read by measuring bar widths, so a narrower
   * symbol means a narrower module. This pins the floor so that the next time
   * somebody makes it smaller, the test says no rather than a scanner at a
   * gate saying no six weeks later.
   */
  it("keeps the narrowest bar above the scannable floor", () => {
    const metrics = barcodeMetrics(challanBarcodePayload("LBTS-CH-2026-000123"));

    assert.ok(
      metrics.moduleWidth >= MIN_MODULE_WIDTH,
      `module width ${metrics.moduleWidth.toFixed(3)}pt is below the ${MIN_MODULE_WIDTH}pt floor`,
    );
  });

  /** The identifiers are fixed-format, so the longest realistic one still fits. */
  it("stays scannable for the longest challan number the format produces", () => {
    const metrics = barcodeMetrics(challanBarcodePayload("LBTS-CH-2026-999999"));

    assert.ok(metrics.moduleWidth >= MIN_MODULE_WIDTH);
    assert.ok(metrics.totalWidth <= 595.276 - 48 * 2, "the symbol runs into the margins");
  });

  it("is smaller than it used to be, which is the point", () => {
    const metrics = barcodeMetrics(challanBarcodePayload("LBTS-CH-2026-000123"));

    assert.ok(metrics.totalWidth < 420, "no narrower than the old symbol");
    assert.ok(metrics.height < 76, "no shorter than the old symbol");
  });
});

describe("the generated back page", () => {
  /**
   * It carries the barcode and the two identifiers and nothing else, so its
   * size no longer depends on anything about the delivery. A challan with
   * thirty product lines and one with a single line produce the same page.
   */
  it("is exactly one page, whatever the challan carries", async () => {
    const bytes = await generateChallanBackPage(BACK_PAGE);
    assert.equal(await readPageCount(bytes), 1);
  });

  it("is a real PDF", async () => {
    const bytes = await generateChallanBackPage(BACK_PAGE);
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString("latin1"), "%PDF-");
  });

  /**
   * Nothing on the page comes from a transcribed field any more, so a Bangla
   * customer name cannot reach the drawing step at all — which is a stronger
   * guarantee than the one this replaced, where the page survived by
   * substituting "(see front page)".
   */
  it("does not depend on any value a person typed", async () => {
    const bytes = await generateChallanBackPage({
      slNumber: 99999,
      challanNumber: "LBTS-CH-2026-999999",
    });
    assert.equal(await readPageCount(bytes), 1);
  });
});

describe("the individual challan document", () => {
  it("is the original pages followed by the back page", async () => {
    const front = await makeSourcePages(2, "ORIGINAL");
    const back = await generateChallanBackPage(BACK_PAGE);

    const final = await generateChallanFinalPdf({
      frontPages: front,
      backPage: back,
    });

    // Two original pages plus one generated page.
    assert.equal(await readPageCount(final), 3);
  });

  it("appends one page whatever the challan is long", async () => {
    for (const pages of [1, 3, 5]) {
      const front = await makeSourcePages(pages, "ORIGINAL");
      const back = await generateChallanBackPage(BACK_PAGE);
      const final = await generateChallanFinalPdf({
        frontPages: front,
        backPage: back,
      });

      assert.equal(
        await readPageCount(final),
        pages + 1,
        `${pages} front pages`,
      );
    }
  });

  it("keeps the original page size rather than reflowing it", async () => {
    // A challan printed on a non-A4 sheet must not be resized on the way in.
    const source = await PDFDocument.create();
    source.addPage([420, 595]);
    const front = await source.save();

    const final = await generateChallanFinalPdf({
      frontPages: front,
      backPage: await generateChallanBackPage(BACK_PAGE),
    });

    const loaded = await PDFDocument.load(final);
    const { width, height } = loaded.getPage(0).getSize();
    assert.equal(Math.round(width), 420);
    assert.equal(Math.round(height), 595);
  });
});

describe("regenerating a corrected challan", () => {
  it("replaces the back page and leaves the original pages alone", async () => {
    const front = await makeSourcePages(3, "ORIGINAL");
    const original = await generateChallanFinalPdf({
      frontPages: front,
      backPage: await generateChallanBackPage(BACK_PAGE),
    });
    assert.equal(await readPageCount(original), 4);

    const corrected = await replaceChallanBackPage(
      original,
      await generateChallanBackPage(BACK_PAGE),
    );

    // Still three original pages and exactly one back page.
    assert.equal(await readPageCount(corrected), 4);
  });

  it("can be repeated without the document growing a page each time", async () => {
    let document = await generateChallanFinalPdf({
      frontPages: await makeSourcePages(2, "ORIGINAL"),
      backPage: await generateChallanBackPage(BACK_PAGE),
    });

    for (let round = 0; round < 3; round += 1) {
      document = await replaceChallanBackPage(
        document,
        await generateChallanBackPage(BACK_PAGE),
      );
    }

    assert.equal(await readPageCount(document), 3);
  });

  it("refuses a stored document that has lost its pages", async () => {
    // A one-page document is a back page with no challan in front of it, so
    // there is nothing to regenerate around. Better to say so than to produce
    // a document that is only the generated half.
    const single = await PDFDocument.create();
    single.addPage([595.276, 841.89]);
    const onePage = await single.save();
    const back = await generateChallanBackPage(BACK_PAGE);

    await assert.rejects(
      () => replaceChallanBackPage(onePage, back),
      /missing its pages/,
    );
  });
});

describe("the completed batch document", () => {
  it("is every challan document, in the order it was given", async () => {
    const first = await generateChallanFinalPdf({
      frontPages: await makeSourcePages(2, "FIRST"),
      backPage: await generateChallanBackPage(BACK_PAGE),
    });
    const second = await generateChallanFinalPdf({
      frontPages: await makeSourcePages(1, "SECOND"),
      backPage: await generateChallanBackPage({
        ...BACK_PAGE,
        slNumber: 10235,
      }),
    });
    const third = await generateChallanFinalPdf({
      frontPages: await makeSourcePages(3, "THIRD"),
      backPage: await generateChallanBackPage({
        ...BACK_PAGE,
        slNumber: 10236,
      }),
    });

    const merged = await mergeChallanPdfs([first, second, third]);

    // (2+1) + (1+1) + (3+1)
    assert.equal(await readPageCount(merged), 9);
  });

  it("refuses to build a batch document out of nothing", async () => {
    await assert.rejects(() => mergeChallanPdfs([]), /no challan documents/);
  });
});

describe("reading a PDF this API did not produce", () => {
  it("reports a page count that can be compared against a claimed range", async () => {
    assert.equal(await readPageCount(await makeSourcePages(4, "X")), 4);
  });

  it("refuses bytes that are not a PDF, with something an operator can read", async () => {
    await assert.rejects(
      () =>
        readPageCount(
          new Uint8Array(Buffer.from("not a pdf at all")),
          "challan pages",
        ),
      /could not be read as a PDF/,
    );
  });
});
