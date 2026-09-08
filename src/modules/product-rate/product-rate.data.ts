import type { Rate } from './product-rate.constants'

/**
 * The product rate card the business supplied.
 *
 * This is a *seed*, not the source of truth — the collection in MongoDB is.
 * The distinction matters more here than anywhere else in the system: these
 * are prices, they change, and an Admin who corrects one must not have it
 * overwritten on the next deploy. The seeder only ever inserts rows that are
 * absent, and nothing in this file is read at request time.
 *
 * It exists because a rate card with nothing in it prices nothing, and asking
 * somebody to type a hundred and forty rows into a form before the feature
 * does anything is not a reasonable first run.
 *
 * ---------------------------------------------------------------------------
 * TRANSCRIBED FROM AN IMAGE. SPOT-CHECK BEFORE RELYING ON IT.
 * ---------------------------------------------------------------------------
 * Every figure below was read off a screenshot of the printed card, not
 * imported from a spreadsheet. The structure is certain; individual digits are
 * as good as a careful reading of a picture gets, which is not the same thing
 * as correct. Two rows deserve a second look in particular — see IRON and
 * ELECTRIC KETTLE below, whose cells are sentences rather than numbers.
 *
 * Because the seeder only inserts, correcting a mistake found later is an edit
 * on the Product Rates page and not a redeploy.
 */

/** One figure per piece. */
function flat(amount: number): Rate {
  return { kind: 'flat', amount }
}

/**
 * "Ek challan e prothom N pics X, porer gulo Y kore" — the first N pieces on a
 * challan at X each and everything after at Y.
 */
function tier(firstQty: number, firstAmount: number, restAmount: number): Rate {
  return { kind: 'tiered', firstQty, firstAmount, restAmount }
}

export interface SeedRates {
  ISD: Rate
  'OSD-Metro': Rate
  'OSD-Thana': Rate
}

/**
 * One product, one capacity band, and the models that share it.
 *
 * Grouped rather than flat because that is how the card reads: twenty-seven
 * refrigerator models sit under one "Gross 151-285 Litre" band at one set of
 * three figures, and repeating those figures twenty-seven times is how a
 * transcription grows a typo nobody can see.
 *
 * `models` absent means the product has no model on the card — a hair dryer is
 * a hair dryer — and seeds exactly one model-blank row, which prices every
 * line naming that product whatever model it carries.
 */
export interface SeedGroup {
  productName: string
  capacity?: string
  models?: readonly string[]
  rates: SeedRates
}

export const PRODUCT_RATE_SEED: readonly SeedGroup[] = [
  // --- Personal care -------------------------------------------------------
  {
    productName: 'Hair Dryer',
    rates: { ISD: flat(60), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
  {
    productName: 'Hair Styler',
    rates: { ISD: flat(60), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
  {
    productName: 'Shaver',
    rates: { ISD: flat(60), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
  {
    productName: 'Trimmer',
    rates: { ISD: flat(60), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
  {
    productName: 'Grooming Kit',
    rates: { ISD: flat(60), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },

  // --- Washing machines ----------------------------------------------------
  {
    productName: 'Washing Machine',
    capacity: 'Up to 20 kg',
    models: ['SWG60N', 'SWG80'],
    rates: { ISD: flat(300), 'OSD-Metro': flat(420), 'OSD-Thana': flat(480) },
  },
  {
    productName: 'Washing Machine',
    capacity: '21 to 40 kg',
    models: [
      'TWG80',
      'TWG90M',
      'TWG100P',
      'TWG100PL',
      'TWG110',
      'TWP110DP',
      'TTP60',
      'TTM70',
      'TSM80',
      'ATP70',
      'Q60',
      'Q70',
      'Q80',
      'ATV70',
      'ATV80',
      'ATV90',
    ],
    rates: { ISD: flat(420), 'OSD-Metro': flat(600), 'OSD-Thana': flat(720) },
  },
  {
    productName: 'Washing Machine',
    capacity: 'More than 40 kg',
    models: ['AFM60', 'AFM70', 'AFM90', 'AFT80W', 'AFC90W'],
    rates: { ISD: flat(600), 'OSD-Metro': flat(840), 'OSD-Thana': flat(1080) },
  },

  // --- Cooling -------------------------------------------------------------
  {
    productName: 'Air Cooler',
    capacity: '19-30 Litre',
    models: ['25L', '30L'],
    rates: { ISD: flat(216), 'OSD-Metro': flat(300), 'OSD-Thana': flat(384) },
  },

  /**
   * IRON — a tiered row. Read as "ek challan e prothom 5 pics 60, porer gulo
   * 24 kore" in the ISD column, 72/30 in OSD-Metro and 84/36 in OSD-Thana.
   * Worth confirming against the printed card: these three cells are the only
   * ones on it that are sentences rather than figures.
   */
  {
    productName: 'Iron',
    rates: {
      ISD: tier(5, 60, 24),
      'OSD-Metro': tier(5, 72, 30),
      'OSD-Thana': tier(5, 84, 36),
    },
  },

  {
    productName: 'Gyser',
    rates: { ISD: flat(240), 'OSD-Metro': flat(300), 'OSD-Thana': flat(336) },
  },
  {
    productName: 'Vacuum Cleaner',
    rates: { ISD: flat(240), 'OSD-Metro': flat(300), 'OSD-Thana': flat(336) },
  },

  // --- Kitchen -------------------------------------------------------------
  {
    productName: 'Microwave Oven',
    capacity: 'Upto 30 litre',
    models: ['20', '23', '25', '26', '28', '30'],
    rates: { ISD: flat(180), 'OSD-Metro': flat(216), 'OSD-Thana': flat(240) },
  },
  {
    productName: 'Induction Cooker',
    rates: { ISD: flat(96), 'OSD-Metro': flat(120), 'OSD-Thana': flat(144) },
  },
  {
    productName: 'Gas Stove-Single',
    rates: { ISD: flat(96), 'OSD-Metro': flat(120), 'OSD-Thana': flat(144) },
  },
  {
    productName: 'Gas Stove-Double',
    rates: { ISD: flat(132), 'OSD-Metro': flat(168), 'OSD-Thana': flat(180) },
  },
  {
    productName: 'Weight machine',
    capacity: 'Upto 40Kg',
    models: ['20kg', '30kg', '40kg'],
    rates: { ISD: flat(78), 'OSD-Metro': flat(108), 'OSD-Thana': flat(120) },
  },
  {
    productName: 'Blender',
    rates: { ISD: flat(90), 'OSD-Metro': flat(114), 'OSD-Thana': flat(120) },
  },
  {
    productName: 'Juicer',
    rates: { ISD: flat(90), 'OSD-Metro': flat(114), 'OSD-Thana': flat(120) },
  },
  {
    productName: 'Grinder',
    rates: { ISD: flat(90), 'OSD-Metro': flat(114), 'OSD-Thana': flat(120) },
  },

  /**
   * ELECTRIC KETTLE — the second tiered row, and the one most worth checking.
   * Read as 60/30 in ISD, 84/36 in OSD-Metro and 84/42 in OSD-Thana. The
   * repeated 84 is what the card appears to say and is not obviously a
   * transcription slip, but it is the one figure here that does not follow the
   * pattern of every other row, so confirm it before invoicing on it.
   */
  {
    productName: 'Electric Kettle',
    rates: {
      ISD: tier(5, 60, 30),
      'OSD-Metro': tier(5, 84, 36),
      'OSD-Thana': tier(5, 84, 42),
    },
  },

  {
    productName: 'Coffee Maker',
    rates: { ISD: flat(70), 'OSD-Metro': flat(80), 'OSD-Thana': flat(90) },
  },
  {
    productName: 'Toaster',
    rates: { ISD: flat(65), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
  {
    productName: 'Sandwich Maker',
    rates: { ISD: flat(65), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
  {
    productName: 'Rice Cooker',
    rates: { ISD: flat(70), 'OSD-Metro': flat(80), 'OSD-Thana': flat(90) },
  },
  {
    productName: 'Pressure cooker',
    rates: { ISD: flat(70), 'OSD-Metro': flat(80), 'OSD-Thana': flat(90) },
  },
  {
    productName: 'Kitchen Hood',
    rates: { ISD: flat(350), 'OSD-Metro': flat(450), 'OSD-Thana': flat(550) },
  },
  {
    productName: 'Room heater',
    rates: { ISD: flat(350), 'OSD-Metro': flat(450), 'OSD-Thana': flat(550) },
  },

  // --- Television ----------------------------------------------------------
  {
    productName: 'TV',
    capacity: 'Up to 43 Inch',
    models: ['24', '32', '40', '43'],
    rates: { ISD: flat(420), 'OSD-Metro': flat(540), 'OSD-Thana': flat(720) },
  },
  {
    productName: 'TV',
    capacity: '44 to 55 Inch',
    models: ['50'],
    rates: { ISD: flat(540), 'OSD-Metro': flat(900), 'OSD-Thana': flat(1080) },
  },
  {
    /**
     * The card prints "45 to 55 Inch" on this row and "44 to 55 Inch" on the
     * one above it. Both are kept as printed rather than reconciled: the
     * capacity is a description beside a rate, and the two rows carry the same
     * three figures, so the difference changes nothing that is computed.
     */
    productName: 'TV',
    capacity: '45 to 55 Inch',
    models: ['55'],
    rates: { ISD: flat(540), 'OSD-Metro': flat(900), 'OSD-Thana': flat(1080) },
  },

  // --- Air conditioners ----------------------------------------------------
  {
    productName: 'Air Conditioner',
    capacity: 'Split AC: up to 1.5 Ton',
    models: ['09', '12', '18'],
    rates: { ISD: flat(905), 'OSD-Metro': flat(1206), 'OSD-Thana': flat(1508) },
  },
  {
    productName: 'Air Conditioner',
    capacity: 'Split AC: 2-2.5 Ton',
    models: ['24', '30'],
    rates: { ISD: flat(1056), 'OSD-Metro': flat(1357), 'OSD-Thana': flat(1810) },
  },
  {
    productName: 'Air Conditioner',
    capacity: 'Split AC: 3 Ton',
    models: ['36', '42'],
    rates: { ISD: flat(1357), 'OSD-Metro': flat(1810), 'OSD-Thana': flat(2413) },
  },
  {
    productName: 'Air Conditioner',
    capacity: 'Split AC: 4-5Ton',
    models: ['48', '60'],
    rates: { ISD: flat(1508), 'OSD-Metro': flat(1960), 'OSD-Thana': flat(2714) },
  },

  // --- Refrigerators -------------------------------------------------------
  {
    productName: 'Refrigerator',
    capacity: 'Gross 50-150 Litre',
    models: ['JET', 'TE0', '1X1', 'TG2', 'TN3', '1B5', '1D5', '1B6'],
    rates: { ISD: flat(650), 'OSD-Metro': flat(950), 'OSD-Thana': flat(1150) },
  },
  {
    productName: 'Refrigerator',
    capacity: 'Gross 151-285 Litre',
    models: [
      '1N3',
      '1G7',
      '1H5',
      '1D4',
      '1F3',
      '1G0',
      '1N5',
      '2B4',
      '2F0',
      '2T5',
      '2E5',
      '2A3',
      '2B0',
      '2B5',
      '2D4',
      '2A8',
      '2B3',
      '2B6',
      '2E0',
      '2X1',
      '2A7',
      '2F1',
      '2G2',
      '2G0',
      '2E4',
      '2H2',
      '2A0',
    ],
    rates: { ISD: flat(950), 'OSD-Metro': flat(1450), 'OSD-Thana': flat(1680) },
  },
  {
    productName: 'Refrigerator',
    capacity: 'Gross 286-460 Litre',
    models: [
      '2N5',
      '3J0',
      '3A7',
      '3D8',
      '3F5',
      '3X7',
      '3A2',
      '3B0',
      '3C3',
      '3E8',
      '3X9',
      '3D7',
      '3G0',
      '3H6',
      '3D3',
      '3B5',
      '3C4',
      '4C0',
      '4D0',
      '3X8',
    ],
    rates: { ISD: flat(1100), 'OSD-Metro': flat(1700), 'OSD-Thana': flat(1900) },
  },
  {
    productName: 'Refrigerator',
    capacity: 'Gross 461-800 Litre',
    models: ['5F3', '5A2', '5B6', '5E5', '5H5', '6A9', '6D6', '6E2', '6F0', '5F0', '5A5'],
    rates: { ISD: flat(1400), 'OSD-Metro': flat(2100), 'OSD-Thana': flat(2500) },
  },

  // --- Fans and lighting ---------------------------------------------------
  {
    productName: 'Pedal Stand Fan',
    rates: { ISD: flat(145), 'OSD-Metro': flat(180), 'OSD-Thana': flat(180) },
  },
  {
    productName: 'Wall Fan',
    rates: { ISD: flat(95), 'OSD-Metro': flat(120), 'OSD-Thana': flat(155) },
  },
  {
    productName: 'Table Fan',
    rates: { ISD: flat(95), 'OSD-Metro': flat(120), 'OSD-Thana': flat(155) },
  },
  {
    productName: 'Ceiling Fan',
    rates: { ISD: flat(90), 'OSD-Metro': flat(120), 'OSD-Thana': flat(145) },
  },
  {
    productName: 'Tornado Fan',
    rates: { ISD: flat(90), 'OSD-Metro': flat(120), 'OSD-Thana': flat(145) },
  },
  {
    productName: 'Exhaust Fan',
    rates: { ISD: flat(40), 'OSD-Metro': flat(50), 'OSD-Thana': flat(50) },
  },
  {
    productName: 'Bulb',
    rates: { ISD: flat(60), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
  {
    productName: 'Light',
    rates: { ISD: flat(60), 'OSD-Metro': flat(70), 'OSD-Thana': flat(80) },
  },
]
