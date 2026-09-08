import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { RATE_KINDS, rateKey } from './product-rate.constants'
import type { Rate } from './product-rate.constants'

/**
 * One product, optionally one model, and what it is charged at.
 *
 * The rate card the business supplied, as a collection. It is the authority on
 * what a delivery costs in exactly the way the Location master is the
 * authority on where a delivery went — no form types a rate, no constant holds
 * one, and a challan line carries a rate because a row here said so or it
 * carries none at all.
 *
 * The three figures live on one row because that is how the card is printed:
 * ISD, OSD-Metro and OSD-Thana are three columns of the same product, not
 * three products. Keeping them together is what makes "the rate for
 * Refrigerator 2N5" a single record an Admin corrects in one edit.
 *
 * A challan does **not** read this collection at display time. It copies the
 * figure it was charged at onto the record, the way `resolvedLocation` copies
 * a district — so correcting a rate here changes what future challans are
 * charged and never rewrites what a filed one says it charged.
 */

/**
 * One figure, in one of the two forms the rate card uses.
 *
 * A discriminated shape rather than five always-meaningful numbers: `kind`
 * says which fields mean anything, and validation refuses a row whose fields
 * do not match its kind. The unused half is null rather than absent, so a row
 * written as one kind and corrected into the other cannot leave a stale figure
 * behind for the arithmetic to find.
 */
const rateSchema = new Schema(
  {
    kind: { type: String, required: true, enum: RATE_KINDS },
    /** `flat` only: the charge per piece. */
    amount: { type: Number, default: null, min: 0 },
    /** `tiered` only: how many pieces on one challan get the first figure. */
    firstQty: { type: Number, default: null, min: 1 },
    firstAmount: { type: Number, default: null, min: 0 },
    restAmount: { type: Number, default: null, min: 0 },
  },
  { _id: false },
)

/**
 * The three columns of the rate card. All three are required: a product that
 * can be delivered inside the metropolitan area can be delivered outside it,
 * and an absent column would be a rate that silently priced nothing.
 */
const ratesSchema = new Schema(
  {
    ISD: { type: rateSchema, required: true },
    'OSD-Metro': { type: rateSchema, required: true },
    'OSD-Thana': { type: rateSchema, required: true },
  },
  { _id: false },
)

const productRateSchema = new Schema(
  {
    /** As printed on the card, and as displayed. "Air Conditioner", not "AC". */
    productName: { type: String, required: true, trim: true, maxlength: 200 },

    /**
     * The model this row is for, or blank.
     *
     * Blank is a first-class value and it is what much of the card looks like:
     * a hair dryer has a rate and no model. A blank row prices every line
     * carrying that product name whatever model it names, and a row naming a
     * model is preferred over it — see `rateFor` in the service, where that
     * preference is the whole of the lookup rule.
     *
     * The card prints `NA` here; `normalizeAbsent` turns that into a blank
     * before it is ever stored, because `NA` is a spelling of "nothing" and a
     * challan line reading `NA` must not match it.
     */
    productModel: { type: String, default: '', trim: true, maxlength: 120 },

    /**
     * The comparison forms. Written by the service through `rateKey`, never by
     * a client, and never displayed: they exist so `SWG-60N`, `swg 60n` and
     * `SWG60N` find one row rather than three.
     */
    productNameKey: { type: String, required: true, index: true },
    productModelKey: { type: String, default: '', index: true },

    /**
     * What the card's Capacity column said — "21 to 40 kg", "Gross 151-285
     * Litre", "Split AC: up to 1.5 Ton".
     *
     * Free text on purpose. It is a description printed beside a rate, not a
     * quantity anything computes with, and the card writes it a dozen
     * different ways. It is copied onto a challan line beside the rate,
     * because it is what tells somebody reading the record which of four
     * near-identical refrigerator rates was applied.
     */
    capacity: { type: String, default: '', trim: true, maxlength: 120 },

    rates: { type: ratesSchema, required: true },

    /**
     * Whether this row may still price anything.
     *
     * Deactivating rather than deleting, for the same reason the Location
     * master does it: an inactive row prices nothing and is offered nowhere,
     * while the challans already carrying its figure keep them. A rate that
     * was correct in March is still what March was charged.
     */
    isActive: { type: Boolean, default: true, index: true },

    /** True for a row from the supplied card rather than one an Admin added. */
    isSeeded: { type: Boolean, default: false },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/**
 * One row per product and model, enforced on the normalised values rather than
 * the typed ones — otherwise `SWG60N` and `swg-60n` would be two rows and
 * every lookup would have to choose between them, which is exactly the
 * ambiguity a rate card cannot afford.
 *
 * The model-less row participates: `Hair Dryer` with a blank key is one row,
 * and a second blank-model Hair Dryer is refused. The service checks first and
 * answers with a sentence; this index is the floor under that check.
 */
productRateSchema.index({ productNameKey: 1, productModelKey: 1 }, { unique: true })
/** The entry form's lookup: which products does this model belong to? */
productRateSchema.index({ isActive: 1, productModelKey: 1 })
/** Pricing a challan line: this product, and this model or the blank row. */
productRateSchema.index({ isActive: 1, productNameKey: 1, productModelKey: 1 })
/** The list, read alphabetically, because it is a reference card. */
productRateSchema.index({ productName: 1, productModel: 1 })

export type ProductRate = InferSchemaType<typeof productRateSchema>

export const ProductRateModel = model('ProductRate', productRateSchema)

/**
 * Derived from the model rather than written by hand: Mongoose 9 folds schema
 * options into the hydrated type, so a hand-written HydratedDocument does not
 * structurally match what queries return. The same arrangement every other
 * module uses.
 */
export type ProductRateDocument = InstanceType<typeof ProductRateModel>

/** The stored sub-document, before it is narrowed to a usable rate. */
export type StoredRate = ProductRate['rates']['ISD']

/** The normalised pair a row is identified by, as the schema stores them. */
export function normalizedProduct(
  productName: string,
  productModel: string,
): { productNameKey: string; productModelKey: string } {
  return {
    productNameKey: rateKey(productName),
    productModelKey: rateKey(productModel),
  }
}

/**
 * A stored rate sub-document as the discriminated union the arithmetic wants.
 *
 * The schema keeps all five fields so a corrected row cannot leave a stale
 * figure behind; this is where that storage shape becomes the shape
 * `priceLines` can reason about. A row whose fields disagree with its kind —
 * which validation refuses and the seeder cannot produce — comes back as no
 * rate at all rather than as a zero, because zero is a price.
 */
export function toRate(stored: StoredRate | null | undefined): Rate | null {
  if (!stored) {
    return null
  }

  if (stored.kind === 'flat') {
    return typeof stored.amount === 'number' ? { kind: 'flat', amount: stored.amount } : null
  }

  if (
    typeof stored.firstQty === 'number' &&
    typeof stored.firstAmount === 'number' &&
    typeof stored.restAmount === 'number'
  ) {
    return {
      kind: 'tiered',
      firstQty: stored.firstQty,
      firstAmount: stored.firstAmount,
      restAmount: stored.restAmount,
    }
  }

  return null
}
