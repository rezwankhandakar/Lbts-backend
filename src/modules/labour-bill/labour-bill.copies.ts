import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { AppError } from '../../utils/app-error'
import { EMPTY_COPY_STATE, readChallanSignedCopies } from '../delivery/delivery.copies'
import type { ChallanSignedCopy } from '../delivery/delivery.copies'
import { readReceivedCopy } from '../delivery/delivery.storage'
import type { LabourBillDetail } from './labour-bill.serializer'
import { buildLabourBillDetail, findLabourBill } from './labour-bill.service'

/**
 * The receivers' signed copies behind a labour bill — listed, and assembled as
 * one PDF to print.
 *
 * A labour bill is what the *handling* of a month's deliveries cost, and what
 * goes out with it is the paper proving each of those deliveries happened.
 * Without this that means opening every challan's trip in Delivery one at a
 * time; here the bill answers it, because the bill already is the list of
 * challans in question and its sections are the separate bills each CSD gets.
 *
 * Two things it deliberately does not do. It **stores nothing** — a signed copy
 * belongs to a trip and this only reads it, so no labour bill row carries a
 * copy of its own and a copy filed tomorrow is in the next assembly without
 * anything being refreshed. And it never calls a bill incomplete: a challan
 * still on the road has no copy yet, which is a fact about the lorry rather
 * than a fault in the bill, so the count is reported and printing what is in is
 * still offered.
 */

/**
 * A ceiling per download, because every copy is pulled into memory: pdf-lib
 * parses a cross-reference table at the end of each file and cannot stream. A
 * month past it is printed one CSD section at a time, which is how the office
 * sends them anyway — the refusal says so.
 */
export const MAX_SIGNED_COPY_MERGE = 80

/** And a byte budget, checked against the sizes on record before a byte is read. */
export const MAX_SIGNED_COPY_BYTES = 80 * 1024 * 1024

/** A4 in points, the sheet an image copy is fitted onto. */
const A4_WIDTH = 595.28
const A4_HEIGHT = 841.89

/** One signed copy as the browser gets it: the API path, never the object key. */
export type LabourSignedCopyRef = Omit<ChallanSignedCopy, 'key'>

/** One challan of the bill, and what paper has come back for it. */
export interface LabourSignedCopyChallan {
  challanId: string
  challanNumber: string
  challanSlNumber: number
  customerName: string
  /** The SL this challan carries in its own section. */
  sl: number
  copies: LabourSignedCopyRef[]
  /** Trips carrying it whose copy has not come back yet. */
  awaiting: number
  declaredMissing: number
  returnedInFull: number
  trips: number
}

/** One CSD's section, which is one bill the office sends. */
export interface LabourSignedCopySection {
  /** `comparisonKey` of the CSD, and `''` for the pending section. */
  key: string
  label: string
  isPending: boolean
  challans: LabourSignedCopyChallan[]
  withCopy: number
  withoutCopy: number
  copyCount: number
}

export interface LabourSignedCopyList {
  billId: string
  billNumber: string
  periodLabel: string
  sections: LabourSignedCopySection[]
  /** Distinct challans on the bill, counted once however many sections carry them. */
  challanCount: number
  withCopy: number
  withoutCopy: number
  /** Distinct copies, so a challan signed for on two trips counts twice. */
  copyCount: number
  /** What one download may assemble, so the dialog can explain a refusal before it happens. */
  maxPerDownload: number
}

function toWire(copy: ChallanSignedCopy): LabourSignedCopyRef {
  const { key: _key, ...wire } = copy
  return wire
}

/**
 * The bill's challans in sheet order, with the signed copies each has.
 *
 * Built on `buildLabourBillDetail` rather than on a query of its own, so the
 * sections, their order and each challan's SL are the sheet's own — a print
 * list filing a challan under a different CSD than the sheet does would be a
 * second answer to a question the sheet already answers.
 *
 * A challan that went out on two gate passes heads a row in two sections and
 * appears in both, because each of those CSDs is billed separately and both
 * bills want the paper. The download deduplicates by object, so the whole-bill
 * PDF still carries each sheet once.
 */
export async function readLabourBillSignedCopies(
  id: string,
): Promise<{ detail: LabourBillDetail; list: LabourSignedCopyList }> {
  const bill = await findLabourBill(id)
  const detail = await buildLabourBillDetail(bill)

  const challanIds = [
    ...new Set(detail.groups.flatMap((group) => group.lines.map((line) => line.challanId))),
  ]
  const copies = await readChallanSignedCopies(challanIds)

  const sections = detail.groups.map((group) => {
    const challans = group.lines
      // One entry per challan: the SL cell is drawn on the first row of each and
      // spans the rest, which is the grouping the sheet itself reads by.
      .filter((line) => line.slRowSpan > 0)
      .map((line) => {
        const state = copies.get(line.challanId) ?? EMPTY_COPY_STATE

        return {
          challanId: line.challanId,
          challanNumber: line.challanNumber,
          challanSlNumber: line.challanSlNumber,
          customerName: line.customerName,
          sl: line.sl,
          copies: state.copies.map(toWire),
          awaiting: state.awaiting,
          declaredMissing: state.declaredMissing,
          returnedInFull: state.returnedInFull,
          trips: state.trips,
        }
      })

    return {
      key: group.key,
      label: group.label,
      isPending: group.isPending,
      challans,
      withCopy: challans.filter((challan) => challan.copies.length > 0).length,
      withoutCopy: challans.filter((challan) => challan.copies.length === 0).length,
      copyCount: challans.reduce((sum, challan) => sum + challan.copies.length, 0),
    }
  })

  const withCopy = challanIds.filter((challanId) => (copies.get(challanId)?.copies.length ?? 0) > 0)
  const distinctCopies = new Set(
    [...copies.values()].flatMap((state) => state.copies.map((copy) => copy.key)),
  )

  return {
    detail,
    list: {
      billId: String(bill._id),
      billNumber: bill.billNumber,
      periodLabel: detail.bill.periodLabel,
      sections,
      challanCount: challanIds.length,
      withCopy: withCopy.length,
      withoutCopy: challanIds.length - withCopy.length,
      copyCount: distinctCopies.size,
      maxPerDownload: MAX_SIGNED_COPY_MERGE,
    },
  }
}

export interface SignedCopyDownload {
  pdf: Uint8Array
  filename: string
  copyCount: number
  /** Challans the file actually carries paper for. */
  challanCount: number
  pageCount: number
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/**
 * A copy that is not a PDF becomes one A4 page, **fitted rather than filled** —
 * a signed sheet cropped by the paper edge has lost the signature somebody
 * needed. A landscape scan gets a landscape sheet for the same reason.
 *
 * pdf-lib embeds JPEG and PNG and nothing else, so a WEBP is re-encoded once on
 * the way in. The scanner's own output is JPEG or PNG and never passes through
 * that branch.
 */
async function addImagePage(
  output: PDFDocument,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  const image =
    mimeType === 'image/jpeg'
      ? await output.embedJpg(bytes)
      : await output.embedPng(
          mimeType === 'image/png'
            ? bytes
            : new Uint8Array(await sharp(Buffer.from(bytes)).png().toBuffer()),
        )

  const page = output.addPage(
    image.width > image.height ? [A4_HEIGHT, A4_WIDTH] : [A4_WIDTH, A4_HEIGHT],
  )

  const scale = Math.min(page.getWidth() / image.width, page.getHeight() / image.height)
  const width = image.width * scale
  const height = image.height * scale

  page.drawImage(image, {
    x: (page.getWidth() - width) / 2,
    y: (page.getHeight() - height) / 2,
    width,
    height,
  })
}

/**
 * Every signed copy on the bill — or on one of its CSD sections — merged into
 * one PDF, in the sheet's own order.
 *
 * PDF copies are carried across as page objects with `copyPages`, the same call
 * the Challan module slices a source file with, so a scan that arrived as a PDF
 * is neither rasterised nor re-compressed. The page count comes back
 * **measured** from the assembled document rather than summed from what each
 * part claimed, for the reason Gate Pass's join gives: this is the one moment a
 * real count exists.
 *
 * A copy that cannot be read is **refused rather than skipped**, the rule the
 * batch download follows — a document quietly missing two of the sheets it says
 * it carries is one somebody sends and never learns what was not in.
 */
export async function buildLabourBillSignedCopiesPdf(
  id: string,
  csdKey?: string,
): Promise<SignedCopyDownload> {
  const bill = await findLabourBill(id)
  const detail = await buildLabourBillDetail(bill)

  const groups =
    csdKey === undefined ? detail.groups : detail.groups.filter((group) => group.key === csdKey)

  if (csdKey !== undefined && groups.length === 0) {
    throw new AppError(404, `${bill.billNumber} has no section for that CSD.`)
  }

  const challanIds = [
    ...new Set(groups.flatMap((group) => group.lines.map((line) => line.challanId))),
  ]

  if (challanIds.length === 0) {
    throw new AppError(404, `Nothing has been scanned onto ${bill.billNumber} yet.`)
  }

  const copies = await readChallanSignedCopies(challanIds)

  /**
   * In the order the sheet reads, and each object once: a challan billed under
   * two CSDs is the same sheet of paper twice, and printing it twice is a
   * second copy nobody asked for.
   */
  const seen = new Set<string>()
  const queue: ChallanSignedCopy[] = []
  const waiting = new Set<string>()

  for (const group of groups) {
    for (const line of group.lines) {
      if (line.slRowSpan === 0) {
        continue
      }

      const state = copies.get(line.challanId) ?? EMPTY_COPY_STATE

      if (state.copies.length === 0) {
        waiting.add(line.challanId)
      }

      for (const copy of state.copies) {
        if (!seen.has(copy.key)) {
          seen.add(copy.key)
          queue.push(copy)
        }
      }
    }
  }

  if (queue.length === 0) {
    throw new AppError(
      409,
      `No signed copy has come back for any of the ${challanIds.length} ${
        challanIds.length === 1 ? 'challan' : 'challans'
      } on ${bill.billNumber} yet.`,
    )
  }

  if (queue.length > MAX_SIGNED_COPY_MERGE) {
    throw new AppError(
      400,
      `That is ${queue.length} signed copies, more than the ${MAX_SIGNED_COPY_MERGE} this can merge into one file. Print one CSD section at a time.`,
    )
  }

  const bytes = queue.reduce((sum, copy) => sum + copy.size, 0)
  if (bytes > MAX_SIGNED_COPY_BYTES) {
    throw new AppError(
      400,
      `Those ${queue.length} signed copies come to ${megabytes(bytes)} MB, more than the ${megabytes(
        MAX_SIGNED_COPY_BYTES,
      )} MB this can merge into one file. Print one CSD section at a time.`,
    )
  }

  const output = await PDFDocument.create()
  output.setProducer('LBTS')
  output.setCreator('LBTS')

  for (const copy of queue) {
    const file = await readReceivedCopy(copy.key)

    if (copy.mimeType === 'application/pdf') {
      let source: PDFDocument

      try {
        source = await PDFDocument.load(file)
      } catch {
        throw new AppError(
          422,
          `The signed copy filed against ${copy.tripNumber} could not be opened. Replace it on that delivery and try again.`,
        )
      }

      for (const page of await output.copyPages(source, source.getPageIndices())) {
        output.addPage(page)
      }
      continue
    }

    try {
      await addImagePage(output, file, copy.mimeType)
    } catch {
      throw new AppError(
        422,
        `The signed copy filed against ${copy.tripNumber} could not be read as an image. Replace it on that delivery and try again.`,
      )
    }
  }

  const section = csdKey === undefined ? '' : `-${safeFilePart(groups[0].label)}`

  return {
    pdf: await output.save(),
    filename: `${bill.billNumber}${section}-signed-copies.pdf`,
    copyCount: queue.length,
    challanCount: challanIds.length - waiting.size,
    pageCount: output.getPageCount(),
  }
}
