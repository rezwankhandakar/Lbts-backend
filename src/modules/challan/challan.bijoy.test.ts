import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canOfferConversion,
  containsUnicodeBangla,
  forceBanglaConversion,
  isLikelyLegacyBangla,
  normalizeBanglaText,
  toUnicodeBangla,
} from "./lib/bangla-text";

/**
 * The Bijoy contract.
 *
 * These tests are not about the conversion table — that comes from a
 * maintained package and is its own business. They are about the two
 * guarantees LBTS makes on top of it, both of which are ours to get wrong:
 *
 * 1. legacy Bijoy text that reaches storage comes out as Unicode; and
 * 2. **nothing else is touched.** English, model codes, phone numbers,
 *    punctuation and text that is already Unicode Bangla must survive the
 *    round trip byte for byte, because the converter is destructive when it is
 *    pointed at the wrong thing and the only defence is never pointing it
 *    there.
 *
 * The second is the one worth having tests for. A converter that misses a
 * legacy string leaves a value an operator can see and fix; a converter that
 * quietly rewrites "ABC Electronics Ltd." into Bangla letters produces a
 * record nobody will ever recognise as wrong.
 */

describe("legacy Bijoy text", () => {
  const cases: [string, string][] = [
    ["evsjv‡`k", "বাংলাদেশ"],
    ["†gvt Avwid †nv‡mb", "মোঃ আরিফ হোসেন"],
    ["PÆMÖvg", "চট্টগ্রাম"],
    ["Kg©KZ©vi", "কর্মকর্তার"],
    ["we¯ÍvwiZ", "বিস্তারিত"],
  ];

  for (const [legacy, unicode] of cases) {
    it(`converts ${JSON.stringify(legacy)} to Unicode`, () => {
      assert.equal(toUnicodeBangla(legacy), unicode);
      assert.equal(normalizeBanglaText(legacy).conversion, "converted");
    });
  }

  it("recognises legacy text by the characters only a Bijoy layout produces", () => {
    assert.equal(isLikelyLegacyBangla("evsjv‡`k"), true);
    assert.equal(isLikelyLegacyBangla("ABC Electronics Ltd."), false);
    assert.equal(isLikelyLegacyBangla("বাংলাদেশ"), false);
  });
});

describe("text that must not be touched", () => {
  const untouched = [
    "ABC Electronics Ltd.",
    "Mirpur, Dhaka",
    "House 12, Road 4, Block C",
    "WFA-2D4-GDEH-XX",
    "Refrigerator",
    "01712345678",
    "+8801712345678",
    "Zone-7 / PO-627143140",
    "12",
    "Md. Arif Hossain",
    "O'Brien & Sons (Pvt.) Ltd.",
  ];

  for (const value of untouched) {
    it(`leaves ${JSON.stringify(value)} exactly as it was`, () => {
      const result = normalizeBanglaText(value);
      assert.equal(result.value, value);
      assert.equal(result.conversion, "unchanged");
    });
  }
});

describe("text that is already Unicode Bangla", () => {
  const alreadyUnicode = [
    "ঢাকা",
    "মোঃ আরিফ হোসেন",
    "বাংলাদেশ",
    "মিরপুর, ঢাকা",
    "গাজীপুর সদর, গাজীপুর",
  ];

  for (const value of alreadyUnicode) {
    it(`preserves ${JSON.stringify(value)} rather than reordering it`, () => {
      // The library's converter, run over Unicode, moves the vowel signs and
      // produces nonsense. The guard is what stops that, and it is the whole
      // reason `normalizeBanglaText` exists rather than a direct call.
      const result = normalizeBanglaText(value);
      assert.equal(result.value, value);
      assert.equal(result.conversion, "unchanged");
      assert.equal(containsUnicodeBangla(value), true);
    });
  }

  it("normalising twice changes nothing the second time", () => {
    const once = toUnicodeBangla("evsjv‡`k");
    assert.equal(toUnicodeBangla(once), once);
  });
});

describe("conversion the operator asks for", () => {
  it("converts plain-ASCII Bijoy, which no heuristic could have detected", () => {
    // "XvKv" is legacy Bijoy for ঢাকা and is also, character for character, a
    // plausible English string. Detection cannot tell, so the operator does.
    assert.equal(normalizeBanglaText("XvKv").conversion, "unchanged");
    assert.equal(forceBanglaConversion("XvKv"), "ঢাকা");
  });

  it("is offered wherever there is something it could convert", () => {
    assert.equal(canOfferConversion("XvKv"), true);
    assert.equal(canOfferConversion("evsjv‡`k"), true);
    assert.equal(canOfferConversion("ABC Electronics"), true);
  });

  it("is not offered once the value is already Unicode Bangla", () => {
    // Pressing it there could only damage the value.
    assert.equal(canOfferConversion("ঢাকা"), false);
    assert.equal(canOfferConversion("মোঃ আরিফ হোসেন"), false);
  });

  it("is not offered on an empty field", () => {
    assert.equal(canOfferConversion(""), false);
    assert.equal(canOfferConversion("   "), false);
  });

  it("leaves an empty value alone rather than inventing one", () => {
    assert.equal(forceBanglaConversion(""), "");
    assert.equal(normalizeBanglaText("").value, "");
  });
});
