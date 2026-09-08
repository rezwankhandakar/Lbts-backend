import * as z from 'zod'
import { LOCATION_TYPES } from '../location/location.constants'
import { MAX_PRODUCT_RATE_PAGE_SIZE, normalizeAbsent } from './product-rate.constants'

/** Mongo ObjectId as it arrives in a URL or a body. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const productRateIdParamSchema = z.object({ id: objectId })

/**
 * One figure from the rate card.
 *
 * A discriminated union rather than five optional numbers, because the two
 * forms have nothing in common and a body carrying `amount` beside `restAmount`
 * is a mistake somebody should be told about rather than a row that prices
 * unpredictably. Zod refuses the mixture; the model stores the unused half as
 * null so a corrected row cannot keep a stale figure.
 *
 * Every figure is non-negative and finite. A rate of zero is legitimate — a
 * category the business does not charge for — and is meaningfully different
 * from no rate at all, which is what an absent rate card row produces.
 */
const money = z
  .coerce.number({ error: 'Enter a rate.' })
  .finite('That is not a rate.')
  .min(0, 'A rate cannot be negative.')
  .max(10_000_000, 'That rate looks too large. Check the card.')

const flatRateSchema = z.object({
  kind: z.literal('flat'),
  amount: money,
})

/**
 * "Ek challan e prothom 5 pics 60, porer gulo 24 kore."
 *
 * `firstQty` is at least one, because a tier that starts at zero pieces is a
 * flat rate written the long way round, and two spellings of the same thing is
 * how a rate card starts disagreeing with itself.
 */
const tieredRateSchema = z.object({
  kind: z.literal('tiered'),
  firstQty: z.coerce
    .number({ error: 'Enter how many pieces get the first rate.' })
    .int('That has to be a whole number of pieces.')
    .min(1, 'The first tier has to cover at least one piece.')
    .max(100_000, 'That looks too large. Check the card.'),
  firstAmount: money,
  restAmount: money,
})

const rateSchema = z.discriminatedUnion('kind', [flatRateSchema, tieredRateSchema], {
  error: 'A rate is either a flat figure or a tiered one.',
})

export type RateInput = z.infer<typeof rateSchema>

/**
 * All three columns, always.
 *
 * There is no partial rate card row. A product that can be delivered inside
 * the metropolitan area can be delivered outside it, and a row missing a
 * column would price some challans and silently skip others depending on where
 * they happened to go — which is the least findable kind of wrong.
 */
const ratesSchema = z.object({
  ISD: rateSchema,
  'OSD-Metro': rateSchema,
  'OSD-Thana': rateSchema,
})

/**
 * A rate card row, as an Admin enters it.
 *
 * `productNameKey` and `productModelKey` are deliberately absent. They are
 * derived from the two typed values by the service, exactly as a challan's
 * `customerNameKey` is — a client that could set a comparison key could make a
 * row price something it does not name, which is the one way this collection
 * could lie about money.
 */
const productRateFields = {
  productName: z
    .string()
    .trim()
    .min(2, 'Product must be at least 2 characters')
    .max(200, 'Product must be 200 characters or fewer'),
  /**
   * Optional, and `NA` means blank.
   *
   * The card prints `NA` for a product that has no model, and a row stored
   * with the literal text `NA` would be matched by a challan line somebody
   * typed `NA` into. `normalizeAbsent` reduces every spelling of "nothing" to
   * an empty string, which is this module's one meaning for "any model".
   */
  productModel: z
    .string()
    .trim()
    .max(120, 'Model must be 120 characters or fewer')
    .transform(normalizeAbsent)
    .default(''),
  capacity: z
    .string()
    .trim()
    .max(120, 'Capacity must be 120 characters or fewer')
    .transform(normalizeAbsent)
    .default(''),
  rates: ratesSchema,
  /**
   * Undefaulted here on purpose. `updateProductRateSchema` is built by making
   * these optional and then refusing a body that changes nothing — and a
   * default would quietly fill this in, so an empty request would look like a
   * request to reactivate the row.
   */
  isActive: z.boolean(),
}

export const createProductRateSchema = z.object({
  ...productRateFields,
  // A new row prices things unless it is explicitly not meant to.
  isActive: productRateFields.isActive.default(true),
})
export type CreateProductRateInput = z.infer<typeof createProductRateSchema>

/**
 * Correcting one.
 *
 * Every field optional, because the reasons to edit are independent: a
 * misspelled product, a rate that went up, a capacity that was never filled
 * in, and taking a row out of use. `.partial()` over the same object, so the
 * rules cannot drift from the create ones.
 *
 * `rates` is replaced wholesale rather than merged. A rate row is three
 * figures that were decided together, and merging one column into a row whose
 * other two came from a different revision of the card is how a rate card
 * quietly becomes two.
 */
export const updateProductRateSchema = z
  .object(productRateFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to change.',
  })
export type UpdateProductRateInput = z.infer<typeof updateProductRateSchema>

/**
 * What narrows the rate card.
 *
 * `active` is three-way rather than a boolean for the same reason it is on the
 * Location master: "show me the ones that are switched off" is how somebody
 * finds a row they deactivated by mistake.
 *
 * `hasModel` is the one filter this list has that the Location master does
 * not, and it earns its place — "which products are priced regardless of
 * model" is the question behind half the rate card, and it is unanswerable by
 * searching for a blank.
 */
export const listProductRatesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PRODUCT_RATE_PAGE_SIZE).default(20),
  search: z.string().trim().max(160).default(''),
  productName: z.string().trim().max(200).default(''),
  hasModel: z.enum(['all', 'yes', 'no']).default('all'),
  active: z.enum(['all', 'active', 'inactive']).default('all'),
})
export type ListProductRatesQuery = z.infer<typeof listProductRatesQuerySchema>

/**
 * "Which products carry this model?" — the entry form's lookup.
 *
 * One field and a closed answer. This reads straight out of the rate card, so
 * the request says a model and gets back the products that have one; there is
 * no field name a caller can name and therefore no column to enumerate.
 */
export const modelLookupQuerySchema = z.object({
  model: z.string().trim().min(1, 'Enter a model.').max(120),
})
export type ModelLookupQuery = z.infer<typeof modelLookupQuerySchema>

/**
 * "Which products on the card start like this?" — the entry form's other
 * lookup, and the only one a model-less product has.
 *
 * One character is enough. The card is a few hundred rows and the answer is
 * capped, so a short prefix costs nothing and is what somebody actually types
 * before expecting help — a hair dryer has no model to paste, so this is the
 * whole of the assistance available for it.
 */
export const productLookupQuerySchema = z.object({
  q: z.string().trim().min(1, 'Type at least one character.').max(200),
})
export type ProductLookupQuery = z.infer<typeof productLookupQuerySchema>

/**
 * What a set of challan lines would be charged, asked before anything is
 * filed.
 *
 * Advisory only, exactly like `POST /locations/resolve`: the server prices
 * again at submit time from the values that actually get stored, so a crafted
 * response to this endpoint can never be what a record is built on.
 */
export const quoteRatesSchema = z.object({
  locationType: z.enum(LOCATION_TYPES),
  items: z
    .array(
      z.object({
        productName: z.string().trim().max(200).default(''),
        model: z.string().trim().max(120).default(''),
        qty: z.coerce.number().int().min(1).max(100_000).default(1),
      }),
    )
    .min(1, 'Send at least one product row.')
    .max(30, 'That is more rows than a challan can carry.'),
})
export type QuoteRatesInput = z.infer<typeof quoteRatesSchema>
