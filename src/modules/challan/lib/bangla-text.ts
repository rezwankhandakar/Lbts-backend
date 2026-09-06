import {
  convertBijoyToUnicode,
  hasBengaliUnicode,
  looksLikeBijoy,
  shouldConvertAsBijoy,
} from "bijoy2unicode";

/**
 * Legacy Bangla (Bijoy / SutonnyMJ ANSI) to Unicode.
 *
 * Walton's challans are produced in an office that still types in Bijoy, so a
 * customer name copied out of one PDF arrives as Unicode Bangla, out of the
 * next as `†gvt Avwid †nv‡mb`, and out of a third as plain English. All three
 * have to end up stored correctly, and only one of them may be transformed.
 *
 * The mapping table and the reorder algorithm come from the `bijoy2unicode`
 * package rather than being hand-written here. That is a deliberate choice: a
 * Bijoy table is several hundred entries with pre-base vowel reordering and
 * conjunct rules on top, and a table reproduced from memory would convert
 * *almost* correctly — which is the worst possible outcome, because nobody
 * would notice until a customer name had been wrong for a month.
 *
 * What this file owns is the part specific to LBTS: **when** conversion is
 * allowed to happen. The library's converter is destructive if pointed at the
 * wrong text — run it over "ABC Electronics Ltd." and it produces Bangla
 * letters, run it over text that is already Unicode and it reorders the vowel
 * signs into nonsense. So it is never called directly anywhere in this
 * codebase; every path goes through one of the two functions below.
 *
 * `LBTS-Frontend/src/features/challan/lib/bangla-text.ts` mirrors this file so
 * the workspace can preview a conversion before the operator accepts it. The
 * server runs `normalizeBanglaText` on every stored string regardless, which
 * is what makes "the stored value is Unicode" true rather than hoped for.
 */

/** How a value reached its final form, so the UI can say what it did. */
export type BanglaConversion = "unchanged" | "converted";

export interface BanglaNormalization {
  value: string;
  conversion: BanglaConversion;
}

/**
 * Whether this text is confidently legacy Bijoy.
 *
 * The signal is the high-byte characters the Bijoy layout uses for vowel signs
 * and conjuncts — `‡`, `¯`, `©`, `Æ` and their neighbours. Nothing English
 * contains those, and nothing already in Unicode Bangla does either, which is
 * what makes the test safe to act on without asking.
 */
export function isLikelyLegacyBangla(value: string): boolean {
  return looksLikeBijoy(value);
}

export function containsUnicodeBangla(value: string): boolean {
  return hasBengaliUnicode(value);
}

/**
 * The safe conversion: legacy text becomes Unicode, everything else is
 * returned exactly as it arrived.
 *
 * This is what runs server-side on every stored value. It converts only when
 * the heuristic is confident, so English, model codes, phone numbers and text
 * that is already Unicode Bangla pass through untouched — the guarantee that
 * matters more here than converting every possible input.
 *
 * The limit is worth stating plainly: legacy Bijoy written entirely in plain
 * ASCII — `XvKv` for ঢাকা — is indistinguishable by any algorithm from an
 * English word, so it is left alone. That case is the operator's to catch,
 * which is why the workspace offers `forceBanglaConversion` on every text
 * field rather than only on the ones detection flagged.
 */
export function normalizeBanglaText(value: string): BanglaNormalization {
  if (!value || !shouldConvertAsBijoy(value)) {
    return { value, conversion: "unchanged" };
  }

  const converted = convertBijoyToUnicode(value);

  // A converter that returned the input unchanged did nothing worth reporting.
  return converted === value
    ? { value, conversion: "unchanged" }
    : { value: converted, conversion: "converted" };
}

/** Just the value, for the many callers that do not care how it got there. */
export function toUnicodeBangla(value: string): string {
  return normalizeBanglaText(value).value;
}

/**
 * Conversion the operator explicitly asked for, on text detection would have
 * left alone.
 *
 * Never called on the way into storage — only from a control the operator
 * pressed, and only into a preview they then accept or discard. That is the
 * whole reason it is a separate function from `normalizeBanglaText`: the
 * dangerous one is the one you have to name.
 */
export function forceBanglaConversion(value: string): string {
  if (!value) {
    return value;
  }
  return convertBijoyToUnicode(value);
}

/**
 * Whether a field is worth offering the conversion control on.
 *
 * True for text that is confidently legacy, and for anything that is neither
 * already Unicode Bangla nor obviously not Bangla at all — because that is
 * where the plain-ASCII Bijoy case hides. False once the value is Unicode
 * Bangla: there is nothing left to convert and pressing it would corrupt it.
 */
export function canOfferConversion(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || containsUnicodeBangla(trimmed)) {
    return false;
  }
  return true;
}
