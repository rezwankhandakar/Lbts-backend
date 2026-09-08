import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listChallansQuerySchema,
  pageRangeQuerySchema,
  printedSchema,
  submitChallanSchema,
  suggestionQuerySchema,
  updateChallanSchema,
} from "./challan.validation";
import {
  LOCATION_SOURCES,
  REVIEWABLE_LOCATION_SOURCES,
} from "../location/location.constants";

/**
 * The request contract.
 *
 * A submission arrives as multipart, so every value is a string on the way in
 * — including the page numbers, the quantity and the duplicate acknowledgement.
 * Half of what these tests check is that the coercion happens and the other
 * half is that the fields a client must never be able to set are not in the
 * schema at all.
 */

const VALID = {
  customerName: "ABC Electronics Ltd.",
  deliveryAddress: "House 12, Road 4, Block C",
  thana: "Mirpur",
  district: "Dhaka",
  receiverMobile: "01712345678",
  senderMobile: "",
  zonePo: "Zone-7",
  items: JSON.stringify([
    { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty: "2" },
  ]),
  sessionKey: "session-abc12345",
  sourceFileName: "Walton_Challan_05_09_2026.pdf",
  sourcePageCount: "24",
  sourcePageStart: "3",
  sourcePageEnd: "4",
  submissionKey: "submit-abc123456789",
  acknowledgeDuplicate: "false",
};

describe("submitting a challan", () => {
  it("accepts a complete multipart body and coerces the numbers", () => {
    const parsed = submitChallanSchema.parse(VALID);

    assert.equal(parsed.items[0].qty, 2);
    assert.equal(parsed.sourcePageStart, 3);
    assert.equal(parsed.sourcePageEnd, 4);
    assert.equal(parsed.sourcePageCount, 24);
    assert.equal(parsed.acknowledgeDuplicate, false);
  });

  it("reads the acknowledgement as a boolean, not as a truthy string", () => {
    // "false" is a non-empty string. Trusting it would silently skip the
    // duplicate question on every submission.
    assert.equal(
      submitChallanSchema.parse({ ...VALID, acknowledgeDuplicate: "false" })
        .acknowledgeDuplicate,
      false,
    );
    assert.equal(
      submitChallanSchema.parse({ ...VALID, acknowledgeDuplicate: "true" })
        .acknowledgeDuplicate,
      true,
    );
    assert.equal(
      submitChallanSchema.parse({ ...VALID, acknowledgeDuplicate: "1" })
        .acknowledgeDuplicate,
      true,
    );
    assert.equal(
      submitChallanSchema.parse({ ...VALID, acknowledgeDuplicate: "yes" })
        .acknowledgeDuplicate,
      false,
    );
  });

  it("normalises a receiver mobile written any of the usual ways", () => {
    for (const written of [
      "01712345678",
      "01712-345678",
      "+8801712345678",
      "8801712345678",
    ]) {
      assert.equal(
        submitChallanSchema.parse({ ...VALID, receiverMobile: written })
          .receiverMobile,
        "01712345678",
      );
    }
  });

  it("refuses something that is not a contact number at all", () => {
    assert.equal(
      submitChallanSchema.safeParse({
        ...VALID,
        receiverMobile: "call the shop",
      }).success,
      false,
    );
  });

  it("has no way to set an SL number, a challan number or a status", () => {
    const parsed = submitChallanSchema.parse({
      ...VALID,
      slNumber: "1",
      challanNumber: "LBTS-CH-2026-000001",
      status: "Amended",
    }) as Record<string, unknown>;

    // The same reasoning as `role` being absent from the user sync schema:
    // a field that is not in the schema is one a crafted body cannot set.
    assert.equal("slNumber" in parsed, false);
    assert.equal("challanNumber" in parsed, false);
    assert.equal("status" in parsed, false);
  });

  /**
   * The one identifier a submission may carry, and only as a reference.
   *
   * An operator finishing a source PDF opens it in a new workspace with a new
   * session key, which names no batch — so the batch has to be named directly
   * or the second half of a file would start a second batch for it. What keeps
   * that safe is not the schema: the service loads the batch, refuses anyone
   * who may not add to it, and refuses a page count that disagrees with it.
   * The schema's job is only to insist it is an id.
   */
  it("takes a batch id, and only as an id", () => {
    const parsed = submitChallanSchema.parse({
      ...VALID,
      batchId: "68b0f0f0f0f0f0f0f0f0f0f0",
    });
    assert.equal(parsed.batchId, "68b0f0f0f0f0f0f0f0f0f0f0");

    assert.equal(
      submitChallanSchema.safeParse({ ...VALID, batchId: "not-an-id" }).success,
      false,
    );
  });

  it("treats an absent batch id as a new batch rather than a fault", () => {
    // The ordinary case: a freshly opened file, where the session key is what
    // creates the batch.
    assert.equal(submitChallanSchema.parse(VALID).batchId, "");
  });

  it("refuses a range that runs backwards", () => {
    const result = submitChallanSchema.safeParse({
      ...VALID,
      sourcePageStart: "6",
      sourcePageEnd: "3",
    });
    assert.equal(result.success, false);
  });

  it("refuses a range that runs past the end of the source PDF", () => {
    const result = submitChallanSchema.safeParse({
      ...VALID,
      sourcePageStart: "23",
      sourcePageEnd: "30",
      sourcePageCount: "24",
    });
    assert.equal(result.success, false);
  });

  it("refuses a range too long to be one challan", () => {
    const result = submitChallanSchema.safeParse({
      ...VALID,
      sourcePageStart: "1",
      sourcePageEnd: "40",
      sourcePageCount: "100",
    });
    assert.equal(result.success, false);
  });

  it("accepts a single-page challan", () => {
    const parsed = submitChallanSchema.parse({
      ...VALID,
      sourcePageStart: "6",
      sourcePageEnd: "6",
    });
    assert.equal(parsed.sourcePageStart, parsed.sourcePageEnd);
  });

  it("refuses a session key that is not one", () => {
    for (const key of ["", "short", "../../etc/passwd", "has spaces here"]) {
      assert.equal(
        submitChallanSchema.safeParse({ ...VALID, sessionKey: key }).success,
        false,
        key,
      );
    }
  });

  it("refuses a submission with no idempotency key", () => {
    assert.equal(
      submitChallanSchema.safeParse({ ...VALID, submissionKey: "" }).success,
      false,
    );
  });

  it("requires the values a challan cannot be filed without", () => {
    // Thana and district are deliberately absent from this list — see below.
    for (const field of ["customerName", "deliveryAddress", "receiverMobile"]) {
      const body = { ...VALID, [field]: "" };
      assert.equal(submitChallanSchema.safeParse(body).success, false, field);
    }
  });

  /**
   * The rule the whole location feature rests on. A Walton challan does not
   * always print a thana or a district, and a required field would mean an
   * operator inventing one to get past the form — a wrong district is a worse
   * record than a blank one, because nothing downstream can tell.
   */
  it("files a challan with no thana and no district", () => {
    const parsed = submitChallanSchema.parse({
      ...VALID,
      thana: "",
      district: "",
    });

    assert.equal(parsed.thana, "");
    assert.equal(parsed.district, "");
  });

  it("accepts one of the two without the other", () => {
    assert.equal(
      submitChallanSchema.safeParse({ ...VALID, district: "" }).success,
      true,
    );
    assert.equal(
      submitChallanSchema.safeParse({ ...VALID, thana: "" }).success,
      true,
    );
  });

  /**
   * A location can only ever be a reference into a collection the server owns.
   * These four would let a crafted body file a challan classified however it
   * liked, so none of them is in the schema at all — the same arrangement that
   * keeps `role` out of `syncUserSchema`.
   */
  it("has no field for a district, thana, type or confidence of its own", () => {
    const parsed = submitChallanSchema.parse({
      ...VALID,
      locationType: "ISD",
      resolvedLocation: JSON.stringify({ district: "Dhaka", thana: "Mirpur" }),
      locationStatus: "Verified",
      locationConfidence: "1",
    }) as Record<string, unknown>;

    assert.equal(parsed.locationType, undefined);
    assert.equal(parsed.resolvedLocation, undefined);
    assert.equal(parsed.locationStatus, undefined);
    assert.equal(parsed.locationConfidence, undefined);
  });

  it("takes a chosen location as an id, and refuses anything that is not one", () => {
    assert.equal(
      submitChallanSchema.parse({
        ...VALID,
        locationId: "65b2f1c3a4d5e6f7a8b9c0d1",
      }).locationId,
      "65b2f1c3a4d5e6f7a8b9c0d1",
    );

    // Blank is the ordinary case: nobody picked one, so the server resolves.
    assert.equal(submitChallanSchema.parse(VALID).locationId, "");
    assert.equal(
      submitChallanSchema.safeParse({ ...VALID, locationId: "Dhaka/Mirpur" })
        .success,
      false,
    );
  });

  it("treats the sender number and the zone/PO as optional", () => {
    const parsed = submitChallanSchema.parse({
      ...VALID,
      senderMobile: "",
      zonePo: "",
    });
    assert.equal(parsed.senderMobile, "");
    assert.equal(parsed.zonePo, "");
  });
});

describe("the product rows on a submission", () => {
  const rows = (items: unknown[]) => ({
    ...VALID,
    items: JSON.stringify(items),
  });

  it("accepts several products on one challan", () => {
    const parsed = submitChallanSchema.parse(
      rows([
        { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty: "2" },
        { productName: "Refrigerator Stand", model: "WFS-01", qty: "1" },
      ]),
    );

    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[1].model, "WFS-01");
    assert.equal(parsed.items[1].qty, 1);
  });

  it("unpacks the rows out of the JSON string multipart forces them into", () => {
    // A multipart body has no arrays; the browser sends one field of JSON.
    const parsed = submitChallanSchema.parse(VALID);
    assert.ok(Array.isArray(parsed.items));
    assert.equal(parsed.items[0].productName, "Refrigerator");
  });

  it("also accepts a real array, which is what a JSON correction sends", () => {
    const parsed = submitChallanSchema.parse({
      ...VALID,
      items: [
        { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty: 2 },
      ],
    });
    assert.equal(parsed.items[0].qty, 2);
  });

  it("refuses a challan carrying nothing", () => {
    assert.equal(submitChallanSchema.safeParse(rows([])).success, false);
  });

  it("refuses more rows than one challan can carry", () => {
    const many = Array.from({ length: 31 }, () => ({
      productName: "Refrigerator",
      model: "WFA-2D4-GDEH-XX",
      qty: "1",
    }));
    assert.equal(submitChallanSchema.safeParse(rows(many)).success, false);
  });

  it("refuses a row missing its product or model", () => {
    assert.equal(
      submitChallanSchema.safeParse(
        rows([{ productName: "", model: "WFA", qty: "1" }]),
      ).success,
      false,
    );
    assert.equal(
      submitChallanSchema.safeParse(
        rows([{ productName: "Refrigerator", model: "", qty: "1" }]),
      ).success,
      false,
    );
  });

  it("refuses a quantity that is not a whole number of items", () => {
    for (const qty of ["0", "-2", "2.5", "two", ""]) {
      assert.equal(
        submitChallanSchema.safeParse(
          rows([
            { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty },
          ]),
        ).success,
        false,
        qty,
      );
    }
  });

  it("refuses a field that is not readable as rows at all", () => {
    assert.equal(
      submitChallanSchema.safeParse({ ...VALID, items: "not json" }).success,
      false,
    );
    assert.equal(
      submitChallanSchema.safeParse({ ...VALID, items: "{}" }).success,
      false,
    );
  });
});

describe("correcting a challan", () => {
  it("takes the values and nothing about where they came from", () => {
    const parsed = updateChallanSchema.parse({
      customerName: "ABC Electronics Ltd.",
      deliveryAddress: "House 12, Road 4",
      thana: "Mirpur",
      district: "Dhaka",
      receiverMobile: "01712345678",
      senderMobile: "",
      zonePo: "",
      items: [
        { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty: 3 },
      ],
      // Where in a source PDF it came from is a historical fact about a file
      // that no longer exists. It is not editable.
      sourcePageStart: "99",
      sourceFileName: "something-else.pdf",
    }) as Record<string, unknown>;

    assert.deepEqual(parsed.items, [
      { productName: "Refrigerator", model: "WFA-2D4-GDEH-XX", qty: 3 },
    ]);
    assert.equal("sourcePageStart" in parsed, false);
    assert.equal("sourceFileName" in parsed, false);
  });

  it("corrects a challan down to no thana and no district", () => {
    // A district transcribed from a sheet that never carried one is wrong, and
    // removing it has to be a legal correction rather than a value nobody can
    // take back out again.
    const parsed = updateChallanSchema.parse({
      customerName: "ABC Electronics Ltd.",
      deliveryAddress: "House 12, Road 4",
      thana: "",
      district: "",
      receiverMobile: "01712345678",
      senderMobile: "",
      zonePo: "",
      items: [{ productName: "Refrigerator", model: "WFA-2D4", qty: 1 }],
    });

    assert.equal(parsed.thana, "");
    assert.equal(parsed.district, "");
    assert.equal(parsed.locationId, "");
  });
});

describe("the records list", () => {
  it("defaults to the first page of ten with nothing filtered out", () => {
    const parsed = listChallansQuerySchema.parse({});
    assert.equal(parsed.page, 1);
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.status, "all");
    assert.equal(parsed.search, "");
  });

  it("caps the page size, so a crafted query cannot ask for everything", () => {
    assert.equal(
      listChallansQuerySchema.safeParse({ limit: "5000" }).success,
      false,
    );
  });

  /**
   * The working list for whoever clears the location backlog. Without it a
   * challan filed with no district is a record nobody could find again — which
   * is what would make "leave it blank" an unusable answer rather than the
   * right one.
   */
  it("filters by whether the location has been settled", () => {
    assert.equal(listChallansQuerySchema.parse({}).location, "all");
    assert.equal(
      listChallansQuerySchema.parse({ location: "pending" }).location,
      "pending",
    );
    assert.equal(
      listChallansQuerySchema.parse({ location: "verified" }).location,
      "verified",
    );
    assert.equal(
      listChallansQuerySchema.parse({ location: "review" }).location,
      "review",
    );
    assert.equal(
      listChallansQuerySchema.safeParse({ location: "Pending" }).success,
      false,
    );
  });

  /**
   * The review queue is a set of sources, not a status, and it is the one
   * thing about it that could silently rot: adding a sixth source without
   * deciding which side of this line it falls on would either bury the queue
   * or quietly empty it.
   */
  it("puts every inferred source in the review set, and neither of the two decided ones", () => {
    assert.deepEqual([...REVIEWABLE_LOCATION_SOURCES], [
      "master_normalized",
      "master_fuzzy",
      "gemini_assisted",
    ]);

    for (const source of LOCATION_SOURCES) {
      assert.equal(
        REVIEWABLE_LOCATION_SOURCES.includes(source),
        source !== "master_exact" && source !== "admin_manual",
        `${source} is on the wrong side of the review line`,
      );
    }
  });

  it("refuses a date range that ends before it starts", () => {
    const result = listChallansQuerySchema.safeParse({
      from: "2026-09-10",
      to: "2026-09-01",
    });
    assert.equal(result.success, false);
  });
});

describe("type-ahead", () => {
  it("only answers for the fields it was told about", () => {
    assert.equal(
      suggestionQuerySchema.safeParse({ field: "district", q: "Dh" }).success,
      true,
    );
    // An open field name would let a caller enumerate any column it liked.
    assert.equal(
      suggestionQuerySchema.safeParse({ field: "receiverMobile", q: "017" })
        .success,
      false,
    );
    assert.equal(
      suggestionQuerySchema.safeParse({ field: "createdBy", q: "ad" }).success,
      false,
    );
  });

  it("will not run on a single letter", () => {
    assert.equal(
      suggestionQuerySchema.safeParse({ field: "district", q: "D" }).success,
      false,
    );
  });
});

describe("checking a page range before submitting", () => {
  it("applies the same arithmetic the submission does", () => {
    assert.equal(
      pageRangeQuerySchema.safeParse({
        sessionKey: "session-abc12345",
        sourcePageCount: "24",
        sourcePageStart: "5",
        sourcePageEnd: "3",
      }).success,
      false,
    );

    assert.equal(
      pageRangeQuerySchema.safeParse({
        sessionKey: "session-abc12345",
        sourcePageCount: "24",
        sourcePageStart: "5",
        sourcePageEnd: "6",
      }).success,
      true,
    );
  });
});

describe("printedSchema", () => {
  /**
   * A print mark is a claim about what came out of a printer, not a
   * measurement — the browser hands a document to a print dialog and never
   * learns what happened next. So the whole contract is that it goes both
   * ways: a mark that could only ever be set would be one nobody could
   * correct after a cancelled dialog or a jammed printer.
   */
  it("marks and unmarks", () => {
    assert.equal(printedSchema.parse({ printed: true }).printed, true);
    assert.equal(printedSchema.parse({ printed: false }).printed, false);
  });

  it("refuses anything that is not a decision", () => {
    assert.equal(printedSchema.safeParse({}).success, false);
    assert.equal(printedSchema.safeParse({ printed: "yes" }).success, false);
  });

  /**
   * Who printed it comes from the authenticated profile and when from the
   * server's clock, exactly as every other actor and timestamp in this module
   * does. A body that could name either would let a caller write somebody
   * else's name onto a record.
   */
  it("has no path to the actor or the time", () => {
    const parsed = printedSchema.parse({
      printed: true,
      printedBy: "507f1f77bcf86cd799439011",
      printedAt: "2020-01-01T00:00:00.000Z",
    });

    assert.deepEqual(parsed, { printed: true });
  });
});
