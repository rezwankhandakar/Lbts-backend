import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont, PDFPage } from 'pdf-lib'
import { AppError } from '../../../utils/app-error'
import { challanBarcodePayload, encodeCode128B } from './code128'

/**
 * Every PDF this module produces.
 *
 * Three rules shape all of it. The operator's original challan pages are
 * *copied*, never redrawn — `copyPages` carries the page object and its
 * resources across unchanged, so a scan stays a scan and a vector challan
 * stays vector and selectable. The back page is generated fresh from the
 * record, so it can never disagree with what is in MongoDB. And the back page
 * is always the *last* page of a challan document, which is what lets a
 * correction regenerate it by dropping one page and appending a new one rather
 * than needing the source file back weeks later.
 */

/** A4 in points, which is what every printer in this operation is loaded with. */
const PAGE_WIDTH = 595.276
const PAGE_HEIGHT = 841.89
const MARGIN = 48

const NAVY = rgb(0.09, 0.13, 0.32)
const ORANGE = rgb(0.96, 0.51, 0.12)
const INK = rgb(0.11, 0.11, 0.16)
const MUTED = rgb(0.42, 0.44, 0.52)
const HAIRLINE = rgb(0.85, 0.86, 0.9)
const PANEL = rgb(0.965, 0.968, 0.98)
const PAPER = rgb(1, 1, 1)
const BLACK = rgb(0, 0, 0)

/** Bars are filled rectangles, so this is real ink coverage on the sheet. */
const BARCODE_HEIGHT = 76
const BARCODE_MAX_WIDTH = 420
/** Ten modules either side, which is what the symbology requires to scan. */
const QUIET_ZONE_MODULES = 10

/** Height of one label/value row, including its rule and the gap under it. */
const DETAIL_ROW_HEIGHT = 26
/** A goods row is a table line, so it is tighter than a labelled detail. */
const ITEM_ROW_HEIGHT = 16
/** Where the goods table has to stop, leaving room for the footer. */
const CONTENT_FLOOR = MARGIN + 26

/**
 * How many product rows the back page will print before summarising the rest.
 *
 * A challan may carry up to `MAX_CHALLAN_ITEMS`, and a page is a page: past
 * this the table would run into the footer. The overflow is stated as a line
 * of its own rather than silently dropped — a back page that quietly omits
 * three products is worse than one that says it did.
 */
export const MAX_BACK_PAGE_ITEMS = 14

export interface BackPageLayout {
  /** Where the bars sit; the symbol grows upward from here. */
  barcodeBaseline: number
  /** The two identifier panels, measured from their bottom edge. */
  identifierY: number
  /** Baseline of the first detail row. */
  detailTop: number
  /** Baseline of the last detail row. */
  detailBottom: number
  /** Baseline of the goods table's header row. */
  itemsTop: number
  /** Baseline of the total line, which is the last thing the table draws. */
  itemsBottom: number
  /** Product rows that fit; anything beyond this is summarised in one line. */
  itemsDrawn: number
  /** Rows there was no room for, which the table names rather than hides. */
  itemsOmitted: number
  footerY: number
}

/**
 * Where everything on the back page goes, as arithmetic.
 *
 * Pulled out of the drawing code so it can be checked: this page has a fixed
 * height and a variable number of rows — a challan carrying eleven products
 * needs eleven lines — and the way it breaks is content running past the
 * footer, which no assertion about a page count would ever notice. PDF
 * coordinates run upward from the bottom of the page, so every number here is
 * a distance from there.
 */
export function backPageLayout(detailRows: number, itemRows = 1): BackPageLayout {
  const barcodeBaseline = PAGE_HEIGHT - 200
  const identifierY = barcodeBaseline - 100
  const detailTop = identifierY - 34
  const detailBottom = detailTop - Math.max(detailRows - 1, 0) * DETAIL_ROW_HEIGHT

  // The goods table starts below the details, with its own header line.
  const itemsTop = detailBottom - DETAIL_ROW_HEIGHT

  /**
   * What fits between the header and the floor, capped. Two rows are held
   * back: the total, which always prints, and the overflow line when there is
   * one. At least one product row is drawn even on an implausibly cramped
   * page — a back page listing no goods at all would be unreadable.
   */
  const room = Math.floor((itemsTop - CONTENT_FLOOR) / ITEM_ROW_HEIGHT) - 2
  const itemsDrawn = Math.max(1, Math.min(itemRows, MAX_BACK_PAGE_ITEMS, room))
  const itemsOmitted = Math.max(itemRows - itemsDrawn, 0)

  // The rows, the overflow line when there is one, and the total.
  const linesBelowHeader = itemsDrawn + (itemsOmitted > 0 ? 1 : 0) + 1
  const itemsBottom = itemsTop - linesBelowHeader * ITEM_ROW_HEIGHT

  return {
    barcodeBaseline,
    identifierY,
    detailTop,
    detailBottom,
    itemsTop,
    itemsBottom,
    itemsDrawn,
    itemsOmitted,
    // Below the last row, but never inside the navy bar along the bottom edge.
    footerY: Math.max(MARGIN - 12, Math.min(MARGIN + 6, itemsBottom - 18)),
  }
}

export interface ChallanBackPageData {
  slNumber: number
  challanNumber: string
  customerName: string
  deliveryAddress: string
  thana: string
  district: string
  receiverMobile: string
  /** One line per product; always at least one. */
  items: BackPageItem[]
  sourceFileName: string
  sourcePageStart: number
  sourcePageEnd: number
  submittedAt: Date
  submittedByName: string
}

/**
 * Text the PDF standard fonts can actually draw.
 *
 * pdf-lib embeds Helvetica with WinAnsi encoding and throws on any codepoint
 * outside it, so a Bangla customer name would take the whole submission down
 * at its last step. Embedding a Bangla font would not fix it either: pdf-lib
 * does no complex-script shaping, so Bangla conjuncts and vowel signs would
 * come out as separate glyphs in the wrong order — text that looks like
 * writing and reads as nonsense, which is worse than an honest gap.
 *
 * So a value that cannot be drawn is reported as unrepresentable rather than
 * mangled. The customer's name in Bangla is on the original front pages, which
 * are the authoritative copy of it; the back page exists for the barcode and
 * the two identifiers, and both of those are always Latin.
 */
export function winAnsiSafe(value: string): string {
  let dropped = 0
  let kept = ''

  for (const character of value.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0

    // Printable ASCII plus the Latin-1 range WinAnsi covers, and nothing else.
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      kept += character
    } else if (code === 9 || code === 10 || code === 13) {
      kept += ' '
    } else {
      dropped += 1
    }
  }

  const trimmed = kept.replace(/\s+/g, ' ').trim()

  if (trimmed.length === 0 && dropped > 0) {
    return '(see front page)'
  }

  return trimmed
}

/** Cuts a value to what fits on one line at this size. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text
  }

  let cut = text
  while (cut.length > 1 && font.widthOfTextAtSize(cut + '...', size) > maxWidth) {
    cut = cut.slice(0, -1)
  }

  return cut.trimEnd() + '...'
}

const FILED_AT_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

/**
 * Draws the symbol.
 *
 * The module width is derived from the symbol's own length, so a longer
 * challan number stays inside the page rather than running off it. The quiet
 * zones are painted as explicit white rather than assumed: a barcode printed
 * flush against a tinted panel is one a scanner refuses, and the panel behind
 * this block is not always paper-coloured on a photocopy.
 */
function drawBarcode(page: PDFPage, payload: string, centerX: number, baselineY: number): void {
  const symbol = encodeCode128B(payload)
  const totalModules = symbol.moduleCount + QUIET_ZONE_MODULES * 2
  const moduleWidth = BARCODE_MAX_WIDTH / totalModules
  const totalWidth = totalModules * moduleWidth
  const left = centerX - totalWidth / 2

  page.drawRectangle({
    x: left,
    y: baselineY - 8,
    width: totalWidth,
    height: BARCODE_HEIGHT + 16,
    color: PAPER,
  })

  let cursor = left + QUIET_ZONE_MODULES * moduleWidth

  for (const element of symbol.elements) {
    const width = element.width * moduleWidth
    if (element.isBar) {
      page.drawRectangle({ x: cursor, y: baselineY, width, height: BARCODE_HEIGHT, color: BLACK })
    }
    cursor += width
  }
}

function drawHeader(page: PDFPage, fonts: Fonts): void {
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 10, width: PAGE_WIDTH, height: 10, color: NAVY })
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 13, width: PAGE_WIDTH, height: 3, color: ORANGE })

  page.drawText('LBTS', { x: MARGIN, y: PAGE_HEIGHT - 54, size: 26, font: fonts.bold, color: NAVY })

  page.drawText('Line Business Transport Service', {
    x: MARGIN,
    y: PAGE_HEIGHT - 70,
    size: 9,
    font: fonts.regular,
    color: MUTED,
  })

  const label = 'CHALLAN RECORD'
  page.drawText(label, {
    x: PAGE_WIDTH - MARGIN - fonts.bold.widthOfTextAtSize(label, 10),
    y: PAGE_HEIGHT - 54,
    size: 10,
    font: fonts.bold,
    color: ORANGE,
  })

  page.drawLine({
    start: { x: MARGIN, y: PAGE_HEIGHT - 86 },
    end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 86 },
    thickness: 0.75,
    color: HAIRLINE,
  })
}

/** One label-over-value block: the shape the two identifiers are printed in. */
function drawIdentifier(
  page: PDFPage,
  fonts: Fonts,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  size: number,
): void {
  page.drawRectangle({
    x,
    y,
    width,
    height: 60,
    color: PANEL,
    borderColor: HAIRLINE,
    borderWidth: 0.75,
  })

  page.drawText(label, { x: x + 14, y: y + 40, size: 8, font: fonts.bold, color: MUTED })

  page.drawText(fit(value, fonts.bold, size, width - 28), {
    x: x + 14,
    y: y + 14,
    size,
    font: fonts.bold,
    color: NAVY,
  })
}

interface DetailRow {
  label: string
  value: string
}

function drawDetails(page: PDFPage, fonts: Fonts, rows: DetailRow[], top: number): void {
  const labelWidth = 118
  const valueX = MARGIN + labelWidth
  const valueWidth = PAGE_WIDTH - MARGIN - valueX
  let y = top

  for (const row of rows) {
    page.drawText(row.label, { x: MARGIN, y, size: 8.5, font: fonts.bold, color: MUTED })
    page.drawText(fit(row.value || '-', fonts.regular, 10, valueWidth), {
      x: valueX,
      y: y - 0.5,
      size: 10,
      font: fonts.regular,
      color: INK,
    })

    y -= 14
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.5,
      color: HAIRLINE,
    })
    y -= DETAIL_ROW_HEIGHT - 14
  }
}

/** One product line as it is printed. `model` is the API's name for it. */
export interface BackPageItem {
  productName: string
  model: string
  qty: number
}

/** Column edges for the goods table, measured from the left margin. */
const ITEM_MODEL_X = MARGIN + 210
const ITEM_QTY_RIGHT = PAGE_WIDTH - MARGIN

/**
 * The goods, as a small table.
 *
 * A table rather than a run of labelled rows because a challan carrying six
 * products is six lines that have to be *compared* — a warehouse hand reads
 * down the quantity column, and that only works if the quantities are in a
 * column. The total is printed under it, because the figure somebody checks
 * against the physical load is the sum and not any one line.
 */
function drawItems(
  page: PDFPage,
  fonts: Fonts,
  items: BackPageItem[],
  layout: BackPageLayout,
): void {
  const header = layout.itemsTop

  page.drawText('PRODUCT', { x: MARGIN, y: header, size: 8.5, font: fonts.bold, color: MUTED })
  page.drawText('MODEL', { x: ITEM_MODEL_X, y: header, size: 8.5, font: fonts.bold, color: MUTED })

  const qtyLabel = 'QTY'
  page.drawText(qtyLabel, {
    x: ITEM_QTY_RIGHT - fonts.bold.widthOfTextAtSize(qtyLabel, 8.5),
    y: header,
    size: 8.5,
    font: fonts.bold,
    color: MUTED,
  })

  page.drawLine({
    start: { x: MARGIN, y: header - 5 },
    end: { x: PAGE_WIDTH - MARGIN, y: header - 5 },
    thickness: 0.75,
    color: HAIRLINE,
  })

  let y = header - ITEM_ROW_HEIGHT

  for (const item of items.slice(0, layout.itemsDrawn)) {
    page.drawText(fit(winAnsiSafe(item.productName), fonts.regular, 9.5, ITEM_MODEL_X - MARGIN - 8), {
      x: MARGIN,
      y,
      size: 9.5,
      font: fonts.regular,
      color: INK,
    })

    page.drawText(
      fit(winAnsiSafe(item.model), fonts.regular, 9.5, ITEM_QTY_RIGHT - ITEM_MODEL_X - 34),
      { x: ITEM_MODEL_X, y, size: 9.5, font: fonts.regular, color: INK },
    )

    const qty = String(item.qty)
    page.drawText(qty, {
      x: ITEM_QTY_RIGHT - fonts.bold.widthOfTextAtSize(qty, 9.5),
      y,
      size: 9.5,
      font: fonts.bold,
      color: INK,
    })

    y -= ITEM_ROW_HEIGHT
  }

  if (layout.itemsOmitted > 0) {
    page.drawText(
      `+ ${layout.itemsOmitted} more product ${layout.itemsOmitted === 1 ? 'line' : 'lines'} — see the challan pages`,
      { x: MARGIN, y, size: 8.5, font: fonts.regular, color: MUTED },
    )
    y -= ITEM_ROW_HEIGHT
  }

  // The total, on the line the table ends on.
  const total = items.reduce((sum, item) => sum + item.qty, 0)
  const totalLabel = 'TOTAL QUANTITY'

  page.drawLine({
    start: { x: MARGIN, y: y + ITEM_ROW_HEIGHT - 5 },
    end: { x: PAGE_WIDTH - MARGIN, y: y + ITEM_ROW_HEIGHT - 5 },
    thickness: 0.75,
    color: HAIRLINE,
  })

  page.drawText(totalLabel, {
    x: MARGIN,
    y: y + 2,
    size: 8.5,
    font: fonts.bold,
    color: MUTED,
  })

  page.drawText(String(total), {
    x: ITEM_QTY_RIGHT - fonts.bold.widthOfTextAtSize(String(total), 11),
    y: y + 1,
    size: 11,
    font: fonts.bold,
    color: NAVY,
  })
}

/**
 * The generated back page: one A4 sheet carrying the barcode, the SL number
 * and the challan number, with just enough supporting detail to identify the
 * delivery without turning it into a second challan.
 */
export async function generateChallanBackPage(data: ChallanBackPageData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(data.challanNumber + ' - LBTS challan record')
  pdf.setProducer('LBTS')
  pdf.setCreator('LBTS')

  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  }

  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  drawHeader(page, fonts)

  // --- Supporting detail, decided first so the layout can be measured -----
  const address = [data.deliveryAddress, data.thana, data.district]
    .map((part) => winAnsiSafe(part))
    .filter((part) => part.length > 0 && part !== '(see front page)')
    .join(', ')

  const rows: DetailRow[] = [
    { label: 'CUSTOMER', value: winAnsiSafe(data.customerName) },
    { label: 'DELIVERY', value: address || '(see front page)' },
    { label: 'RECEIVER', value: winAnsiSafe(data.receiverMobile) },
    {
      label: 'SOURCE PAGES',
      value:
        data.sourcePageStart + '-' + data.sourcePageEnd + ' of ' + winAnsiSafe(data.sourceFileName),
    },
    { label: 'FILED BY', value: winAnsiSafe(data.submittedByName) },
    { label: 'FILED AT', value: FILED_AT_FORMAT.format(data.submittedAt) + ' UTC' },
  ]

  const layout = backPageLayout(rows.length, data.items.length)

  // --- Barcode ------------------------------------------------------------
  const barcodeBaseline = layout.barcodeBaseline
  drawBarcode(page, challanBarcodePayload(data.challanNumber), PAGE_WIDTH / 2, barcodeBaseline)

  const readable = data.challanNumber
  page.drawText(readable, {
    x: PAGE_WIDTH / 2 - fonts.bold.widthOfTextAtSize(readable, 13) / 2,
    y: barcodeBaseline - 24,
    size: 13,
    font: fonts.bold,
    color: INK,
  })

  // --- The two identifiers ------------------------------------------------
  const identifierY = layout.identifierY
  const columnWidth = (PAGE_WIDTH - MARGIN * 2 - 16) / 2

  drawIdentifier(page, fonts, MARGIN, identifierY, columnWidth, 'SL NUMBER', String(data.slNumber), 22)
  drawIdentifier(
    page,
    fonts,
    MARGIN + columnWidth + 16,
    identifierY,
    columnWidth,
    'CHALLAN NUMBER',
    data.challanNumber,
    15,
  )

  // --- Supporting detail --------------------------------------------------
  drawDetails(page, fonts, rows, layout.detailTop)

  // --- Goods ---------------------------------------------------------------
  drawItems(page, fonts, data.items, layout)

  // --- Footer -------------------------------------------------------------
  page.drawText('Generated by LBTS. Issued with the challan pages preceding it.', {
    x: MARGIN,
    y: layout.footerY,
    size: 7.5,
    font: fonts.regular,
    color: MUTED,
  })

  page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: 6, color: NAVY })

  return pdf.save()
}

/** pdf-lib's failures are library internals; these are what an operator reads. */
async function loadPdf(bytes: Uint8Array, what: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[challan] could not read ' + what + ': ' + message)

    if (message.toLowerCase().includes('encrypt')) {
      throw new AppError(
        400,
        'That PDF is password protected, so its pages cannot be used. Remove the protection and try again.',
      )
    }

    throw new AppError(400, 'That ' + what + ' could not be read as a PDF.')
  }
}

/** How many pages a PDF carries. Used to prove an extract matches its range. */
export async function readPageCount(bytes: Uint8Array, what = 'PDF'): Promise<number> {
  const pdf = await loadPdf(bytes, what)
  return pdf.getPageCount()
}

export interface FinalPdfInput {
  /** The original challan pages, exactly as they were cut from the source. */
  frontPages: Uint8Array
  backPage: Uint8Array
}

/**
 * The document a submitted challan becomes: its original front pages, then the
 * generated back page.
 *
 * The front pages go through `copyPages`, which lifts each page and its
 * resources into the new document unchanged. Nothing is rasterised, nothing is
 * re-encoded, and text on the original stays selectable.
 */
export async function generateChallanFinalPdf(input: FinalPdfInput): Promise<Uint8Array> {
  const front = await loadPdf(input.frontPages, 'challan pages')
  const back = await loadPdf(input.backPage, 'generated back page')

  if (front.getPageCount() === 0) {
    throw new AppError(400, 'Those challan pages are empty.')
  }

  const output = await PDFDocument.create()
  output.setProducer('LBTS')
  output.setCreator('LBTS')

  for (const page of await output.copyPages(front, front.getPageIndices())) {
    output.addPage(page)
  }

  for (const page of await output.copyPages(back, back.getPageIndices())) {
    output.addPage(page)
  }

  return output.save()
}

/**
 * A corrected challan's document.
 *
 * The back page is always the last page, so the original front pages are
 * everything before it — which means a correction never needs the source PDF
 * back. That is what makes editing a challan possible weeks later, long after
 * the WhatsApp file the operator worked from has gone.
 */
export async function replaceChallanBackPage(
  storedPdf: Uint8Array,
  backPage: Uint8Array,
): Promise<Uint8Array> {
  const stored = await loadPdf(storedPdf, 'stored challan document')
  const pageCount = stored.getPageCount()

  if (pageCount < 2) {
    throw new AppError(
      500,
      'The stored challan document is missing its pages, so it cannot be regenerated.',
    )
  }

  const output = await PDFDocument.create()
  output.setProducer('LBTS')
  output.setCreator('LBTS')

  // Everything except the old back page.
  const keep = await output.copyPages(
    stored,
    Array.from({ length: pageCount - 1 }, (_, index) => index),
  )
  for (const page of keep) {
    output.addPage(page)
  }

  const back = await loadPdf(backPage, 'generated back page')
  for (const page of await output.copyPages(back, back.getPageIndices())) {
    output.addPage(page)
  }

  return output.save()
}

/**
 * One PDF for a completed batch: every challan document in source order, front
 * pages then back page, then the next challan.
 *
 * The order is the caller's, and the caller sorts by the page each challan
 * started on in the original file — so the batch reads in the order the
 * corporate office sent it, which is the order somebody filing the printouts
 * expects to find.
 */
export async function mergeChallanPdfs(documents: Uint8Array[]): Promise<Uint8Array> {
  if (documents.length === 0) {
    throw new AppError(400, 'There are no challan documents to merge.')
  }

  const output = await PDFDocument.create()
  output.setProducer('LBTS')
  output.setCreator('LBTS')

  for (const bytes of documents) {
    const source = await loadPdf(bytes, 'challan document')
    for (const page of await output.copyPages(source, source.getPageIndices())) {
      output.addPage(page)
    }
  }

  return output.save()
}
