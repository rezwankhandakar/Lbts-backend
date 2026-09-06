import { randomUUID } from "node:crypto";
import {
  deleteObject,
  getObjectStream,
  putObject,
  requireStorage,
} from "../../config/r2";
import { AppError } from "../../utils/app-error";
import { MAX_CHALLAN_UPLOAD_BYTES } from "./challan.constants";

/**
 * Cloudflare R2, for challan documents.
 *
 * One thing is stored per challan and nothing else: the PDF that challan
 * became — its original front pages followed by the generated back page. The
 * WhatsApp source file the operator worked from is never written here. That is
 * not an optimisation, it is the business rule: the source is a temporary
 * working document, and archiving a 24-page file fifteen times over because
 * fifteen challans came out of it would be storing the same bytes fifteen
 * times to answer a question nobody asked.
 *
 * The bucket is private. Unlike an avatar, a challan carries a customer's home
 * address and phone number, so the only read path is the authenticated API.
 */

/**
 * Safe to cache forever because every write lands on a fresh key — correcting
 * a challan regenerates the document under a new key, so no cached copy is
 * ever stale. `private` rather than `public`: the object is served through the
 * authenticated API and no shared cache may hold a copy of it.
 */
const DOCUMENT_CACHE_CONTROL = "private, max-age=31536000, immutable";

export interface StoredChallanDocument {
  key: string;
  size: number;
  pageCount: number;
  generatedAt: Date;
}

/**
 * The object key.
 *
 * Dated folders keep the bucket browsable a year from now, the challan number
 * groups a record's documents together, and the filename itself is random.
 * Nothing the operator controls reaches the key: a user-supplied filename in
 * an object key is a path-traversal and overwrite problem waiting to happen,
 * and a predictable key would make one challan guessable from another.
 */
export function buildChallanKey(
  prefix: string,
  challanNumber: string,
  when: Date,
): string {
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, "0");

  return (
    prefix +
    "/" +
    year +
    "/" +
    month +
    "/" +
    challanNumber +
    "/" +
    randomUUID() +
    ".pdf"
  );
}

/** The signature check. Multer trusts a Content-Type; this trusts the bytes. */
export function isPdfBuffer(buffer: Uint8Array): boolean {
  return Buffer.from(buffer.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/**
 * Validates the extracted challan pages before anything expensive happens.
 *
 * The declared type has to agree with the bytes, and the size ceiling is far
 * below the multipart parser's for a reason: this is a handful of pages cut
 * out of a source PDF, not the source PDF. A 15 MB "extract" is a sign the
 * whole file was sent, and refusing it there protects a 512 MB instance from
 * being asked to build a merged document on top of it.
 */
export function assertUploadableExtract(
  buffer: Uint8Array,
  mimeType: string,
): void {
  if (mimeType !== "application/pdf") {
    throw new AppError(400, "The challan pages have to be sent as a PDF.");
  }

  if (buffer.length === 0) {
    throw new AppError(400, "The challan pages are empty.");
  }

  if (buffer.length > MAX_CHALLAN_UPLOAD_BYTES) {
    const megabytes = Math.round(MAX_CHALLAN_UPLOAD_BYTES / (1024 * 1024));
    throw new AppError(
      413,
      "Those challan pages are larger than " +
        megabytes +
        " MB. Select a narrower page range, or use a smaller source PDF.",
    );
  }

  if (!isPdfBuffer(buffer)) {
    throw new AppError(400, "The challan pages are not a readable PDF.");
  }
}

/**
 * Writes one generated challan document.
 *
 * The credentials are demanded first, before any bytes move: an unconfigured
 * deployment should answer "storage is not set up" rather than spend a cold
 * instance's CPU building a PDF it cannot store — and, more to the point,
 * rather than allocate an SL number for a submission that was always going to
 * fail.
 */
export async function uploadChallanDocument(
  challanNumber: string,
  pdf: Uint8Array,
  pageCount: number,
): Promise<StoredChallanDocument> {
  const { challanKeyPrefix } = requireStorage();
  const generatedAt = new Date();
  const key = buildChallanKey(challanKeyPrefix, challanNumber, generatedAt);

  await putObject({
    key,
    body: Buffer.from(pdf),
    contentType: "application/pdf",
    cacheControl: DOCUMENT_CACHE_CONTROL,
  });

  return { key, size: pdf.length, pageCount, generatedAt };
}

/**
 * Reads a stored document back into memory.
 *
 * Needed for the two operations that build on what is already filed:
 * regenerating a corrected challan's back page, and merging a completed batch.
 * Both need the whole document at once — pdf-lib parses a cross-reference
 * table at the end of the file, so there is no streaming version of either.
 *
 * That is also why both are capped and rate limited upstream: this is the one
 * place in the module that pulls whole PDFs onto a small instance's heap.
 */
export async function readChallanDocument(key: string): Promise<Uint8Array> {
  const object = await getObjectStream(key);
  const chunks: Buffer[] = [];

  for await (const chunk of object.body) {
    // A Node readable in non-object mode yields Buffers, but its type is the
    // wider `any` the stream types declare — narrowed here rather than cast.
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "binary"),
    );
  }

  return new Uint8Array(Buffer.concat(chunks));
}

/** The stream itself, for the endpoint that hands the document to a browser. */
export async function openChallanDocument(key: string) {
  return getObjectStream(key);
}

/**
 * Removes an object nothing references any more. Safe to call with null, and
 * never throws — every caller has already replaced or cleared the reference in
 * MongoDB, so a failure here leaves an orphan in the bucket rather than a
 * challan pointing at a document that no longer exists.
 */
export async function discardChallanDocument(
  key: string | null | undefined,
): Promise<void> {
  if (!key) {
    return;
  }
  await deleteObject(key);
}
