import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHALLAN_BATCH_STATUSES,
  CHALLAN_READ_ROLES,
  CHALLAN_STATUSES,
  CHALLAN_WRITE_ROLES,
  MAX_CHALLAN_PAGES,
  canManageAnyChallan,
  chargeStatusFor,
  comparisonKey,
  deliveryKey,
  isNormalizedMobile,
  normalizeMobile,
} from "./challan.constants";
import { SL_NUMBER_BASE } from "./challan.counter";
import {
  assertCanDelete,
  assertCanEdit,
  managesAnyRecord,
  ownsRecord,
} from "./challan.access";
import type { ChallanDocument } from "./challan.model";
import type { UserDocument } from "../user/user.model";
import type { UserRole } from "../user/user.constants";
import { buildChallanKey, isPdfBuffer } from "./challan.storage";
import {
  assignedPageCount,
  batchProgress,
  checkRange,
  checkRangeAgainst,
  describeRange,
  findOverlaps,
  pageCountOf,
  rangesOverlap,
  unassignedRanges,
} from "./lib/page-ranges";

/**
 * The rules that decide what happens to a challan, tested without a database,
 * without R2 and without a PDF. Everything here is a decision the server has
 * to make the same way every time, which is the part worth pinning down.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("the challan vocabulary", () => {
  it("has no draft state, because nothing exists before submission", () => {
    assert.equal(CHALLAN_STATUSES.includes("Draft" as never), false);
    assert.deepEqual([...CHALLAN_STATUSES], ["Submitted", "Amended"]);
  });

  it("has exactly two batch states, and neither of them is a decision", () => {
    assert.deepEqual([...CHALLAN_BATCH_STATUSES], ["Processing", "Completed"]);
  });

  it("keeps Vendor out of the module entirely", () => {
    assert.equal(CHALLAN_READ_ROLES.includes("Vendor"), false);
    assert.equal(CHALLAN_WRITE_ROLES.includes("Vendor"), false);
  });

  it("lets the CEO read without writing", () => {
    assert.equal(CHALLAN_READ_ROLES.includes("CEO"), true);
    assert.equal(CHALLAN_WRITE_ROLES.includes("CEO"), false);
  });

  it("lets only Admin and Manager act on somebody else’s challan", () => {
    assert.equal(canManageAnyChallan("Admin"), true);
    assert.equal(canManageAnyChallan("Manager"), true);
    assert.equal(canManageAnyChallan("OpEx"), false);
    assert.equal(canManageAnyChallan("CEO"), false);
    assert.equal(canManageAnyChallan("Vendor"), false);
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe("comparisonKey", () => {
  it("sees the same customer however it was pasted", () => {
    assert.equal(
      comparisonKey("ABC Electronics Ltd."),
      comparisonKey("abc  electronics   ltd"),
    );
  });

  it("keeps Bangla letters, so a Bangla customer name is still comparable", () => {
    assert.equal(comparisonKey("ঢাকা মেট্রো"), comparisonKey("ঢাকা  মেট্রো!"));
    assert.notEqual(comparisonKey("ঢাকা"), "");
  });

  it("does not collapse two genuinely different values", () => {
    assert.notEqual(
      comparisonKey("WFA-2D4-GDEH-XX"),
      comparisonKey("WFA-2D4-GDEH-XY"),
    );
  });
});

describe("normalizeMobile", () => {
  it("reduces every written form of one number to the same eleven digits", () => {
    const expected = "01712345678";
    assert.equal(normalizeMobile("01712345678"), expected);
    assert.equal(normalizeMobile("01712-345678"), expected);
    assert.equal(normalizeMobile("01712 345 678"), expected);
    assert.equal(normalizeMobile("+8801712345678"), expected);
    assert.equal(normalizeMobile("8801712345678"), expected);
    assert.equal(normalizeMobile("(01712) 345678"), expected);
  });

  it("leaves an unrecognised number alone rather than guessing at it", () => {
    // A depot landline is a legitimate value on a challan.
    assert.equal(normalizeMobile("02-9558877"), "02-9558877");
    assert.equal(isNormalizedMobile("02-9558877"), false);
  });

  it("collapses stray whitespace even when it cannot normalise", () => {
    assert.equal(normalizeMobile("  02  955 8877 ext 4 "), "02 955 8877 ext 4");
  });
});

// ---------------------------------------------------------------------------
// Page ranges
// ---------------------------------------------------------------------------

describe("page range arithmetic", () => {
  it("counts the pages a range covers, inclusive of both ends", () => {
    assert.equal(pageCountOf({ startPage: 1, endPage: 2 }), 2);
    assert.equal(pageCountOf({ startPage: 6, endPage: 6 }), 1);
    assert.equal(pageCountOf({ startPage: 7, endPage: 9 }), 3);
  });

  it("describes a range the way a person would say it", () => {
    assert.equal(describeRange({ startPage: 6, endPage: 6 }), "page 6");
    assert.equal(describeRange({ startPage: 3, endPage: 5 }), "pages 3–5");
  });

  it("accepts a range inside the document", () => {
    assert.equal(checkRange({ startPage: 1, endPage: 2 }, 24), null);
    assert.equal(checkRange({ startPage: 24, endPage: 24 }, 24), null);
  });

  it("refuses a range that runs backwards", () => {
    assert.equal(
      checkRange({ startPage: 5, endPage: 3 }, 24)?.code,
      "reversed",
    );
  });

  it("refuses a page before the first one", () => {
    assert.equal(
      checkRange({ startPage: 0, endPage: 2 }, 24)?.code,
      "not-a-page",
    );
    assert.equal(
      checkRange({ startPage: -3, endPage: 2 }, 24)?.code,
      "not-a-page",
    );
  });

  it("refuses a fractional page number", () => {
    assert.equal(
      checkRange({ startPage: 1.5, endPage: 2 }, 24)?.code,
      "not-a-page",
    );
  });

  it("refuses a range past the end of the source PDF", () => {
    assert.equal(
      checkRange({ startPage: 23, endPage: 25 }, 24)?.code,
      "out-of-bounds",
    );
  });

  it("refuses a range too long to be one challan", () => {
    const problem = checkRange(
      { startPage: 1, endPage: MAX_CHALLAN_PAGES + 1 },
      500,
    );
    assert.equal(problem?.code, "too-many-pages");
  });
});

describe("overlap detection", () => {
  const claimed = [
    { startPage: 1, endPage: 2, challanNumber: "LBTS-CH-2026-000001" },
    { startPage: 3, endPage: 4, challanNumber: "LBTS-CH-2026-000002" },
    { startPage: 7, endPage: 9, challanNumber: "LBTS-CH-2026-000003" },
  ];

  it("knows two ranges that touch from two that do not", () => {
    assert.equal(
      rangesOverlap({ startPage: 1, endPage: 2 }, { startPage: 2, endPage: 3 }),
      true,
    );
    assert.equal(
      rangesOverlap({ startPage: 1, endPage: 2 }, { startPage: 3, endPage: 4 }),
      false,
    );
    // Fully contained counts.
    assert.equal(
      rangesOverlap({ startPage: 1, endPage: 9 }, { startPage: 4, endPage: 5 }),
      true,
    );
  });

  it("lets a challan take the gap nobody claimed", () => {
    assert.equal(
      checkRangeAgainst({ startPage: 5, endPage: 6 }, 24, claimed),
      null,
    );
  });

  it("refuses a range that reuses a page, and names what already has it", () => {
    const problem = checkRangeAgainst(
      { startPage: 4, endPage: 5 },
      24,
      claimed,
    );
    assert.equal(problem?.code, "overlap");
    assert.equal(
      problem?.code === "overlap" && problem.conflicts[0].challanNumber,
      "LBTS-CH-2026-000002",
    );
  });

  it("reports every range a wide selection collides with, in page order", () => {
    const conflicts = findOverlaps({ startPage: 1, endPage: 24 }, claimed);
    assert.deepEqual(
      conflicts.map((conflict) => conflict.challanNumber),
      ["LBTS-CH-2026-000001", "LBTS-CH-2026-000002", "LBTS-CH-2026-000003"],
    );
  });

  it("refuses filing exactly the same sheet twice", () => {
    const problem = checkRangeAgainst(
      { startPage: 1, endPage: 2 },
      24,
      claimed,
    );
    assert.equal(problem?.code, "overlap");
  });
});

describe("unassigned pages", () => {
  it("finds nothing left over when the whole file is accounted for", () => {
    const claimed = [
      { startPage: 1, endPage: 2 },
      { startPage: 3, endPage: 4 },
      { startPage: 5, endPage: 6 },
    ];
    assert.deepEqual(unassignedRanges(claimed, 6), []);
    assert.equal(assignedPageCount(claimed, 6), 6);
  });

  it("collapses the gaps into ranges rather than listing loose pages", () => {
    const claimed = [
      { startPage: 1, endPage: 2 },
      { startPage: 7, endPage: 9 },
    ];
    assert.deepEqual(unassignedRanges(claimed, 12), [
      { startPage: 3, endPage: 6 },
      { startPage: 10, endPage: 12 },
    ]);
  });

  it("reports the whole file when nothing has been filed", () => {
    assert.deepEqual(unassignedRanges([], 4), [{ startPage: 1, endPage: 4 }]);
  });

  it("does not count a page twice when two ranges overlap", () => {
    // Should never reach the database, but the arithmetic must not inflate.
    assert.equal(
      assignedPageCount(
        [
          { startPage: 1, endPage: 3 },
          { startPage: 2, endPage: 4 },
        ],
        10,
      ),
      4,
    );
  });
});

describe("batch progress", () => {
  it("is measured in pages, and refuses to be complete with pages left over", () => {
    const progress = batchProgress(
      [
        { startPage: 1, endPage: 2 },
        { startPage: 3, endPage: 4 },
      ],
      24,
      2,
    );

    assert.equal(progress.assignedPages, 4);
    assert.equal(progress.unassignedPages, 20);
    assert.equal(progress.challanCount, 2);
    assert.equal(progress.isComplete, false);
    assert.equal(progress.percent, 17);
  });

  it("is complete exactly when every page belongs to a challan", () => {
    const progress = batchProgress([{ startPage: 1, endPage: 6 }], 6, 1);
    assert.equal(progress.isComplete, true);
    assert.equal(progress.percent, 100);
    assert.equal(progress.unassignedPages, 0);
  });

  it("is never complete for a batch with nothing in it", () => {
    assert.equal(batchProgress([], 6, 0).isComplete, false);
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

function actor(id: string, role: UserRole): UserDocument {
  return {
    _id: id,
    role,
    status: "Active",
    name: role,
  } as unknown as UserDocument;
}

function challan(createdBy: string): ChallanDocument {
  return {
    _id: "challan-1",
    createdBy,
    status: "Submitted",
  } as unknown as ChallanDocument;
}

describe("who may change a challan", () => {
  const owner = actor("user-1", "OpEx");
  const colleague = actor("user-2", "OpEx");
  const manager = actor("user-3", "Manager");
  const admin = actor("user-4", "Admin");
  const record = challan("user-1");

  it("knows who filed it", () => {
    assert.equal(ownsRecord(record, owner), true);
    assert.equal(ownsRecord(record, colleague), false);
  });

  it("lets the operator correct and delete their own work", () => {
    assert.doesNotThrow(() => assertCanEdit(record, owner));
    assert.doesNotThrow(() => assertCanDelete(record, owner));
  });

  it("will not let one operator touch another operator’s challan", () => {
    assert.throws(
      () => assertCanEdit(record, colleague),
      /only correct challans you filed/,
    );
    assert.throws(
      () => assertCanDelete(record, colleague),
      /only delete challans you filed/,
    );
  });

  it("lets Admin and Manager act on anybody’s", () => {
    assert.equal(managesAnyRecord(manager), true);
    assert.equal(managesAnyRecord(admin), true);
    assert.doesNotThrow(() => assertCanEdit(record, manager));
    assert.doesNotThrow(() => assertCanDelete(record, admin));
  });

  it("does not make status a condition on correcting a filed challan", () => {
    const amended = {
      ...record,
      status: "Amended",
    } as unknown as ChallanDocument;
    assert.doesNotThrow(() => assertCanEdit(amended, owner));
  });
});

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

describe("object keys", () => {
  it("groups a challan document under its own number, in a dated folder", () => {
    const key = buildChallanKey(
      "challans",
      "LBTS-CH-2026-000123",
      new Date("2026-09-05T10:00:00Z"),
    );
    assert.match(
      key,
      /^challans\/2026\/09\/LBTS-CH-2026-000123\/[0-9a-f-]{36}\.pdf$/,
    );
  });

  it("never reuses a key, so a regenerated document cannot overwrite the old one", () => {
    const when = new Date("2026-09-05T10:00:00Z");
    assert.notEqual(
      buildChallanKey("challans", "LBTS-CH-2026-000123", when),
      buildChallanKey("challans", "LBTS-CH-2026-000123", when),
    );
  });

  it("proves a PDF by its signature rather than by what the client claimed", () => {
    assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7\n...")), true);
    assert.equal(isPdfBuffer(Buffer.from("MZ\x90\x00")), false);
    assert.equal(isPdfBuffer(Buffer.from("")), false);
  });
});

describe("SL numbering", () => {
  it("starts far enough up that an SL cannot be read as a page or a quantity", () => {
    assert.equal(SL_NUMBER_BASE, 10_000);
    assert.equal(String(SL_NUMBER_BASE + 1).length, 5);
  });
});

describe("charge status", () => {
  /**
   * The classification the records list filters and counts on. It is stored
   * rather than derived, so the only thing standing between it and a wrong
   * backlog count is this function and the pre-save hook that calls it.
   */
  const priced = { rate: { amount: 650 } };
  const unpriced = { rate: null };

  it("calls a challan charged when every line has a rate", () => {
    assert.equal(chargeStatusFor([priced, priced]), "Charged");
  });

  it("calls it unpriced when no line has one", () => {
    assert.equal(chargeStatusFor([unpriced, unpriced]), "Unpriced");
  });

  /**
   * The state worth telling apart from the other two: it renders as a figure
   * that looks complete and is not.
   */
  it("calls it partial when some lines have one and some do not", () => {
    assert.equal(chargeStatusFor([priced, unpriced]), "Partial");
    assert.equal(chargeStatusFor([unpriced, priced]), "Partial");
  });

  it("treats a missing rate field the same as an explicit null", () => {
    assert.equal(chargeStatusFor([{}, {}]), "Unpriced");
    assert.equal(chargeStatusFor([priced, {}]), "Partial");
  });

  /**
   * A challan carrying nothing has not been charged for anything. Calling it
   * settled would hide it from the one list that would have surfaced it.
   */
  it("calls a challan with no lines unpriced rather than charged", () => {
    assert.equal(chargeStatusFor([]), "Unpriced");
  });
});

describe("delivery identity", () => {
  const base = {
    customerName: "Padakhep Manabik Unnayan Kendra",
    deliveryAddress: "House 12, Road 3, Sunamganj Sadar",
    receiverMobile: "01713379249",
  };

  /**
   * What makes two challans the same delivery.
   *
   * The rule this replaced asked only about the customer and the model, and
   * that is not a duplicate: one organisation takes the same refrigerator to
   * twenty branches out of a single PDF, and every one of those fired the
   * alert. The address and the receiver's number are what separate "this
   * customer again" from "this exact sheet, twice".
   */
  it("treats the same customer, address and number as one delivery", () => {
    assert.equal(deliveryKey(base), deliveryKey({ ...base }));
  });

  it("ignores case, spacing and punctuation in the address", () => {
    assert.equal(
      deliveryKey(base),
      deliveryKey({ ...base, deliveryAddress: "house-12  road 3, SUNAMGANJ sadar" }),
    );
  });

  it("reads a mobile written four ways as one number", () => {
    for (const written of ["+8801713379249", "8801713379249", "01713-379249", "01713 379249"]) {
      assert.equal(deliveryKey({ ...base, receiverMobile: written }), deliveryKey(base));
    }
  });

  /** The whole point: a different branch of the same customer is not a duplicate. */
  it("tells two branches of the same customer apart", () => {
    assert.notEqual(
      deliveryKey(base),
      deliveryKey({ ...base, deliveryAddress: "House 40, Road 9, Tangail Sadar" }),
    );
  });

  it("tells two receivers at the same address apart", () => {
    assert.notEqual(
      deliveryKey(base),
      deliveryKey({ ...base, receiverMobile: "01730793070" }),
    );
  });

  it("tells two customers apart", () => {
    assert.notEqual(
      deliveryKey(base),
      deliveryKey({ ...base, customerName: "Advanced Chemical Industries Ltd" }),
    );
  });

  /**
   * No fingerprint rather than a partial one. A key built from a missing field
   * would match every other record missing it, which is the opposite of
   * identifying anything — and the safe direction for a probe that only asks.
   */
  it("refuses to identify a delivery missing any of the three", () => {
    assert.equal(deliveryKey({ ...base, customerName: "" }), null);
    assert.equal(deliveryKey({ ...base, deliveryAddress: "" }), null);
    assert.equal(deliveryKey({ ...base, receiverMobile: "" }), null);
    assert.equal(deliveryKey({ ...base, deliveryAddress: "   " }), null);
  });
});
