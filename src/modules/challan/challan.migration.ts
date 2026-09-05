import { ChallanModel } from './challan.model'
import { comparisonKey } from './challan.constants'

/**
 * Folds a challan written with one product into the `items` list.
 *
 * Before a challan was allowed several product lines, the product lived on the
 * record itself: `product`, `productModel`, `productModelKey`, `qty`. Those
 * paths are gone from the schema, and a document still carrying them cannot be
 * saved at all — Mongoose validates the whole document, so `items` being absent
 * would refuse an unrelated correction with an opaque "Validation failed". It
 * also reads as a challan carrying nothing everywhere it is rendered, and its
 * quantity would drop out of every total the list reports.
 *
 * So this is not cosmetic; it is what keeps existing records usable. The same
 * reasoning, and the same shape, as `gate-pass.migration.ts` — which had to do
 * exactly this when a gate pass gained multiple product rows.
 *
 * Idempotent: a record that already has a non-empty `items` is not matched.
 * Never throws — a migration that takes the API down on boot is worse than the
 * records it was trying to fix.
 *
 * What it deliberately does **not** do is regenerate stored documents. A back
 * page generated before this change lists the one product that challan had, so
 * it is still an accurate page; rewriting hundreds of R2 objects on boot to
 * change nothing but the layout would be a long, failure-prone operation with
 * no reader waiting for it. A challan corrected after this point regenerates
 * its document in the normal way.
 */

/** The old top-level product fields, as they sit on an unmigrated document. */
interface LegacyChallan {
  _id: unknown
  challanNumber?: string
  product?: string
  productModel?: string
  qty?: number
}

export async function foldLegacyChallanProducts(): Promise<void> {
  try {
    /**
     * Read through the driver rather than the model: these fields no longer
     * exist in the schema, so a Mongoose query would strip them out of both
     * the filter and the result — which is exactly the data being looked for.
     */
    const collection = ChallanModel.collection

    const legacy = (await collection
      .find({
        $and: [
          { product: { $exists: true } },
          { $or: [{ items: { $exists: false } }, { items: { $size: 0 } }] },
        ],
      })
      .toArray()) as unknown as LegacyChallan[]

    if (legacy.length === 0) {
      return
    }

    console.log(`[challan] folding ${legacy.length} legacy product row(s) into items`)

    let repaired = 0

    for (const record of legacy) {
      const productName = record.product?.trim()
      const productModel = record.productModel?.trim()
      const qty = record.qty

      if (!productName || !productModel || typeof qty !== 'number' || qty < 1) {
        // Nothing trustworthy to fold. Left alone and reported rather than
        // guessed at: an invented product line is worse than a visible gap.
        console.warn(
          `[challan] ${record.challanNumber ?? String(record._id)} has no usable product to migrate`,
        )
        continue
      }

      await collection.updateOne(
        { _id: record._id as never },
        {
          $set: {
            items: [
              {
                productName,
                productModel,
                productModelKey: comparisonKey(productModel),
                qty,
              },
            ],
          },
          $unset: { product: '', productModel: '', productModelKey: '', qty: '' },
        },
      )

      repaired += 1
    }

    console.log(`[challan] migrated ${repaired} of ${legacy.length} record(s)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[challan] product migration failed: ${message}`)
  }
}
