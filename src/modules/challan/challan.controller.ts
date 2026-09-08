import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { AppError } from "../../utils/app-error";
import { sendResponse } from "../../utils/send-response";
import type { SetChallanLocationInput } from "../location/location.validation";
import type { UserDocument } from "../user/user.model";
import {
  ChallanAlreadySubmitted,
  DuplicateChallanError,
  PageRangeError,
  buildBatchPdf,
  checkPageRangeAvailability,
  findDuplicateChallans,
  getChallan,
  getChallanBatch,
  getChallanStats,
  getSubmittedChallan,
  listChallanBatches,
  listChallans,
  readChallanDocumentStream,
  removeChallan,
  setBatchPrinted,
  setBatchSkippedPages,
  setChallanLocation,
  setChallanPrinted,
  submitChallan,
  suggestChallanValues,
  updateChallan,
} from "./challan.service";
import type {
  ChallanSuggestionQuery,
  DuplicateQuery,
  ListBatchesQuery,
  ListChallansQuery,
  PageRangeQuery,
  PrintedInput,
  SkippedPagesInput,
  SubmitChallanInput,
  UpdateChallanInput,
} from "./challan.validation";

/**
 * The authenticated profile. Every handler here runs behind requireDb, auth
 * and requireRole, so it is always present; reading it through one helper
 * keeps that guarantee in a single place rather than a non-null assertion in
 * each handler — and it stays honest if the route stack is ever changed.
 */
function actorFrom(req: Request): UserDocument {
  if (!req.user) {
    throw new AppError(403, "Profile not found. Sync the account first.");
  }
  return req.user;
}

function idFrom(req: Request): string {
  const params = req.validated?.params as { id: string } | undefined;
  if (!params) {
    throw new AppError(400, "Invalid id.");
  }
  return params.id;
}

export async function getChallans(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListChallansQuery;
  const {
    records,
    total,
    totalQty,
    totalAmount,
    unpricedChallans,
    blankAmount,
    partialAmount,
    locationPending,
    locationReview,
  } = await listChallans(query);

  sendResponse(res, {
    statusCode: 200,
    message: "Challans retrieved",
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
      // Summed over every matching record rather than this page, because the
      // question it answers is about the filters and not about the scroll.
      totalQty,
      /**
       * The same, for money — and `unpricedChallans` travels beside it rather
       * than being left for the client to work out. A charge total that
       * silently omits the challans nobody could price is a figure somebody
       * would put in a report, so the count of what is missing from it is part
       * of the answer, not a detail.
       */
      totalAmount,
      unpricedChallans,
      /**
       * The three backlogs the toolbar draws as chips: challans nobody has
       * charged, challans nobody has located, and locations the machine
       * inferred that nobody has read. Counted over the same matching set as
       * the totals beside them, so every figure in that row answers the same
       * question.
       */
      blankAmount,
      partialAmount,
      locationPending,
      locationReview,
    },
  });
}

export async function getStats(_req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: "Challan statistics retrieved",
    data: await getChallanStats(),
  });
}

export async function getSuggestions(
  req: Request,
  res: Response,
): Promise<void> {
  const query = req.validated?.query as ChallanSuggestionQuery;

  sendResponse(res, {
    statusCode: 200,
    message: "Suggestions retrieved",
    data: await suggestChallanValues(query),
  });
}

export async function getDuplicates(
  req: Request,
  res: Response,
): Promise<void> {
  const query = req.validated?.query as DuplicateQuery;

  sendResponse(res, {
    statusCode: 200,
    message: "Duplicate check complete",
    data: await findDuplicateChallans(query, actorFrom(req)),
  });
}

/**
 * Whether a page range is still free.
 *
 * Answered as a 200 with a verdict rather than a 409, because this is a
 * question the workspace asks continuously while somebody drags a range
 * selector — an error status for "those pages are taken" would make every
 * such answer look like a failure in the network tab and in every retry
 * policy that reads status codes.
 */
export async function getPageRange(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as PageRangeQuery;

  sendResponse(res, {
    statusCode: 200,
    message: "Page range checked",
    data: await checkPageRangeAvailability(query, actorFrom(req)),
  });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: "Challan retrieved",
    data: await getChallan(idFrom(req)),
  });
}

/**
 * Filing one challan: the module's only write that creates anything.
 *
 * It catches three of its own failures, because each is a question rather than
 * a fault and each needs a payload the global error handler has no way to
 * carry:
 *
 * - a **replay** of a completed submission is answered with the record the
 *   first request produced, as a 200. That is what makes a retried request
 *   safe rather than merely refused — the operator sees a success, because
 *   there genuinely is one;
 * - a **possible duplicate** comes back with the matching challans, so the
 *   operator can look at them and answer;
 * - an **overlapping page range** comes back with the challans that already
 *   own those pages, so the operator can see which sheet they doubled up on.
 *
 * The envelope matches every other error in the API — the same
 * success/message/errorSources fields — with the payload added alongside.
 */
export async function postChallan(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as SubmitChallanInput;
  const file = req.file;

  if (!file) {
    throw new AppError(
      400,
      "The challan pages are missing from this submission.",
    );
  }

  try {
    const { record } = await submitChallan(
      input,
      { buffer: file.buffer, mimeType: file.mimetype },
      actorFrom(req),
    );

    sendResponse(res, {
      statusCode: 201,
      message: "Challan submitted",
      data: record,
    });
  } catch (error) {
    if (error instanceof ChallanAlreadySubmitted) {
      const { record } = await getSubmittedChallan(error.challanId);
      sendResponse(res, {
        statusCode: 200,
        message: "Challan already submitted",
        data: record,
      });
      return;
    }

    if (error instanceof DuplicateChallanError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        errorSources: [{ path: "customerName", message: error.message }],
        duplicates: error.duplicates,
      });
      return;
    }

    if (error instanceof PageRangeError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        errorSources: [{ path: "sourcePageStart", message: error.message }],
        pageRangeProblem: error.problem,
      });
      return;
    }

    throw error;
  }
}

export async function patchChallan(req: Request, res: Response): Promise<void> {
  const input = req.validated?.body as UpdateChallanInput;
  const record = await updateChallan(idFrom(req), input, actorFrom(req));

  sendResponse(res, {
    statusCode: 200,
    message: "Challan corrected, and its document regenerated",
    data: record,
  });
}

export async function deleteChallan(
  req: Request,
  res: Response,
): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: "Challan deleted",
    data: await removeChallan(idFrom(req), actorFrom(req)),
  });
}

/**
 * Recording that a challan was printed, or that it was not after all.
 *
 * The message says what the operator will see on the record rather than
 * "Updated", because that is the whole value of the call: a stack of filed
 * challans all look identical until something says which ones have come out
 * of the printer.
 */
export async function patchChallanPrinted(
  req: Request,
  res: Response,
): Promise<void> {
  const input = req.validated?.body as PrintedInput;
  const record = await setChallanPrinted(
    idFrom(req),
    input.printed,
    actorFrom(req),
  );

  sendResponse(res, {
    statusCode: 200,
    message: input.printed ? "Marked as printed" : "Marked as not printed",
    data: record,
  });
}

/**
 * Setting a filed challan's district and thana by hand.
 *
 * The end of the line for every challan the resolver could not settle, and the
 * reason leaving one blank is a workable outcome rather than a loss. It takes
 * a Location Master id and nothing else — no district name, no thana, no
 * location type — because every one of those is read from the row it points
 * at, and a client that could send them could file a challan classified
 * however it liked.
 *
 * `null` clears the location and returns the record to Pending.
 */
export async function patchChallanLocation(
  req: Request,
  res: Response,
): Promise<void> {
  const { locationId } = req.validated?.body as SetChallanLocationInput;
  const record = await setChallanLocation(idFrom(req), locationId, actorFrom(req));

  sendResponse(res, {
    statusCode: 200,
    message: locationId ? "Location set" : "Location cleared",
    data: record,
  });
}

/**
 * Streams a challan's document.
 *
 * One of the two endpoints in this module that does not answer with the
 * standard JSON envelope, because the body is the file. `inline` rather than
 * `attachment`: the client fetches this into a blob for the viewer, and a
 * browser that ever opens the URL directly should render the page rather than
 * download it.
 *
 * Errors thrown before the first byte still reach the global handler as JSON.
 * Once bytes are flowing there is no way back to a JSON error, so a mid-stream
 * failure destroys the response instead of appending an error into the file.
 */
export async function getDocument(req: Request, res: Response): Promise<void> {
  const download = await readChallanDocumentStream(idFrom(req));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'inline; filename="' + download.filename + '"',
  );
  // The record is behind authentication, so no shared cache may keep a copy.
  res.setHeader("Cache-Control", "private, no-store");
  if (download.contentLength !== undefined) {
    res.setHeader("Content-Length", String(download.contentLength));
  }

  try {
    await pipeline(download.body, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[challan] document stream failed: " + message);
    res.destroy();
  }
}

export async function getBatches(req: Request, res: Response): Promise<void> {
  const query = req.validated?.query as ListBatchesQuery;
  const { records, total } = await listChallanBatches(query);

  sendResponse(res, {
    statusCode: 200,
    message: "Batches retrieved",
    data: records,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  });
}

export async function getBatchOne(req: Request, res: Response): Promise<void> {
  sendResponse(res, {
    statusCode: 200,
    message: "Batch retrieved",
    data: await getChallanBatch(idFrom(req)),
  });
}

/**
 * Marking pages of a source PDF as not being challans.
 *
 * A WhatsApp file occasionally carries a blank sheet or a cover page. Without
 * this the batch could never be completed, and a completed batch is the only
 * thing that can be downloaded as one document — so the operator would have to
 * file a junk challan, with a serial and a barcode, for a blank page.
 */
export async function patchBatchSkippedPages(
  req: Request,
  res: Response,
): Promise<void> {
  const input = req.validated?.body as SkippedPagesInput;
  const batch = await setBatchSkippedPages(
    idFrom(req),
    input.pages,
    actorFrom(req),
  );

  sendResponse(res, {
    statusCode: 200,
    message:
      input.pages.length === 0
        ? "Blank pages cleared"
        : "Pages marked as blank",
    data: batch,
  });
}

/**
 * The completed batch as one PDF.
 *
 * `attachment`, unlike a single challan: this is a file somebody saves and
 * prints as a set, not something to page through in a viewer. It is built
 * entirely in memory before the first byte is sent, which is why the route
 * gives it its own rate limit — and why the service refuses an unfinished
 * batch rather than quietly leaving the missing challans out.
 */
export async function getBatchDownload(
  req: Request,
  res: Response,
): Promise<void> {
  const download = await buildBatchPdf(idFrom(req));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="' + download.filename + '"',
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Length", String(download.pdf.byteLength));

  res.end(Buffer.from(download.pdf));
}

/**
 * The same, for every challan in one batch.
 *
 * It follows a batch print: the operator sends the assembled PDF to the
 * printer and says so once, rather than marking fifteen records by hand and
 * losing count somewhere around nine.
 */
export async function patchBatchPrinted(
  req: Request,
  res: Response,
): Promise<void> {
  const input = req.validated?.body as PrintedInput;
  const batch = await setBatchPrinted(
    idFrom(req),
    input.printed,
    actorFrom(req),
  );

  sendResponse(res, {
    statusCode: 200,
    message: input.printed
      ? "Every challan in this batch is marked as printed"
      : "Print marks cleared for this batch",
    data: batch,
  });
}
