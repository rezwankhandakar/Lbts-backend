import { nextSequence } from "../../utils/counter";

/**
 * The two identifiers a submitted challan is given, both allocated by the
 * server and neither ever accepted from a request body.
 *
 * They come from the same atomic counter Gate Pass uses — one
 * `findOneAndUpdate` with `$inc`, which MongoDB applies as a single operation.
 * The alternative, counting the collection and adding one, races under any
 * concurrency at all: two operators submitting in the same second would both
 * read 41 and both write 42. The counter cannot do that, which is why the
 * unique indexes on `slNumber` and `challanNumber` should never actually fire
 * — they are the second line, not the first.
 *
 * Allocation is not reversible. A submission that fails after allocating
 * leaves a gap in the sequence and that is deliberate: recycling an identifier
 * is how two challans end up sharing one, and a missing number costs nothing
 * because nothing counts challans by subtracting SL numbers.
 */

/**
 * Where the running serial starts.
 *
 * A five-digit SL is legible across a printed page and cannot be mistaken for
 * a page number, a quantity or a year — all of which sit near it on the back
 * page. The offset is applied to the counter rather than seeded into it, so
 * the counter itself stays a plain count of challans ever filed.
 */
export const SL_NUMBER_BASE = 10_000;

/** The next serial. Globally unique across every year and every batch. */
export async function allocateSlNumber(): Promise<number> {
  return SL_NUMBER_BASE + (await nextSequence("challan:sl"));
}

/**
 * LBTS-CH-2026-000001.
 *
 * Scoped per year so the running part stays short enough to read off paper and
 * short enough to keep the Code 128 symbol inside an A4 margin, and so the
 * year is legible in the identifier itself. Six digits leaves room for a
 * million challans in a year; past that the number simply grows a digit rather
 * than wrapping.
 */
export async function allocateChallanNumber(
  now: Date = new Date(),
): Promise<string> {
  const year = now.getUTCFullYear();
  const sequence = await nextSequence("challan:" + year);
  return "LBTS-CH-" + year + "-" + String(sequence).padStart(6, "0");
}

/** Both, in one place, because a challan is never given one without the other. */
export interface ChallanIdentifiers {
  slNumber: number;
  challanNumber: string;
}

export async function allocateChallanIdentifiers(
  now: Date = new Date(),
): Promise<ChallanIdentifiers> {
  const [slNumber, challanNumber] = await Promise.all([
    allocateSlNumber(),
    allocateChallanNumber(now),
  ]);

  return { slNumber, challanNumber };
}
