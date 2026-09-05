/**
 * Code 128 (subset B), as bar and space widths.
 *
 * A barcode is one of the few things in this system that has to be *exactly*
 * right or it is worth nothing: a scanner at a depot either reads the challan
 * number or it does not, and there is no half-correct. So this is a pure
 * function over a string — no canvas, no image library, no fonts — which makes
 * it something a unit test can check symbol by symbol against the standard.
 *
 * The renderer draws the widths as filled rectangles straight into the PDF, so
 * the bars are vector geometry at whatever resolution the printer has, rather
 * than a bitmap resampled onto paper.
 *
 * Subset B only, deliberately. Subset C packs digit pairs into one symbol and
 * would make an all-digit payload shorter, but a challan number is letters and
 * digits together, the saving on `LBTS-CH-2026-000001` is a few millimetres,
 * and every mode switch is a place for a subtle encoding bug to hide. Subset B
 * covers ASCII 32-127, which is the whole of what an identifier here can be.
 */

/**
 * The 107 symbol patterns, as element widths in modules. Each is six elements
 * — bar, space, bar, space, bar, space — beginning with a bar and summing to
 * 11 modules; the stop pattern is the exception at seven elements and 13.
 *
 * Index 0-102 are data values, 103-105 the three start codes, 106 the stop.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
] as const

const START_B = 104
const STOP = 106

/** Subset B encodes printable ASCII as codepoint minus 32. */
const MIN_CODE = 32
const MAX_CODE = 127

export class BarcodePayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BarcodePayloadError'
  }
}

/**
 * One element of the symbol: a run of `width` modules that is either ink or
 * paper. Bars and spaces alternate strictly, always starting on a bar, so a
 * renderer can walk the list and only draw the ones marked as bars.
 */
export interface BarcodeElement {
  width: number
  isBar: boolean
}

export interface Barcode128 {
  /** What was encoded, unchanged — printed under the bars for a human. */
  value: string
  /** The symbol values, start and check and stop included, for testing. */
  codes: number[]
  /** Modulo-103 check character, which every scanner recomputes. */
  checksum: number
  elements: BarcodeElement[]
  /** Total width in modules, quiet zones excluded. */
  moduleCount: number
}

/**
 * Encodes one string as a Code 128-B symbol.
 *
 * Throws rather than substituting a character it cannot encode: a barcode that
 * silently scans as something other than the challan number printed beside it
 * is worse than a submission that failed and said so.
 */
export function encodeCode128B(value: string): Barcode128 {
  if (value.length === 0) {
    throw new BarcodePayloadError('A barcode needs a value to encode.')
  }

  const codes: number[] = [START_B]

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0

    if (codePoint < MIN_CODE || codePoint > MAX_CODE) {
      throw new BarcodePayloadError(
        `Code 128-B cannot encode ${JSON.stringify(character)} in "${value}".`,
      )
    }

    codes.push(codePoint - MIN_CODE)
  }

  /**
   * The check character: the start code plus every data value weighted by its
   * one-based position, modulo 103. Getting the weighting wrong produces a
   * symbol that looks perfect and scans as nothing, which is why the codes are
   * exposed above for a test to assert on.
   */
  let sum = START_B
  for (let index = 1; index < codes.length; index += 1) {
    sum += codes[index] * index
  }

  const checksum = sum % 103
  codes.push(checksum, STOP)

  const elements: BarcodeElement[] = []
  let moduleCount = 0

  for (const code of codes) {
    const pattern = PATTERNS[code]
    for (let index = 0; index < pattern.length; index += 1) {
      const width = Number(pattern[index])
      // Every pattern starts on a bar and alternates from there.
      elements.push({ width, isBar: index % 2 === 0 })
      moduleCount += width
    }
  }

  return { value, codes, checksum, elements, moduleCount }
}

/**
 * The payload a challan's barcode carries.
 *
 * The challan number and nothing else: it is already unique, already printed
 * on the page in readable characters, and already what somebody would type if
 * the scanner failed. Encoding a URL or a database id instead would make the
 * barcode and the human-readable line say two different things.
 */
export function challanBarcodePayload(challanNumber: string): string {
  return challanNumber
}
