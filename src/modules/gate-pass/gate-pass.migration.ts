import { GatePassModel } from './gate-pass.model'
import { comparisonKey } from './gate-pass.constants'

/**
 * Folds a gate pass written with one product into the `items` list.
 *
 * Before a challan was allowed several product lines, the product lived on the
 * record itself: `productName`, `productModel`, `productModelKey`, `qty`. Those
 * paths are gone from the schema, and a document still carrying them cannot be
 * saved at all — Mongoose validates the whole document, so `items` being absent
 * would refuse a reviewer's unrelated verification with an opaque "Validation
 * failed". It also reads as an empty gate pass everywhere it is rendered.
 *
 * So this is not cosmetic; it is what keeps existing records usable. The same
 * reasoning, and the same shape, as `user.migration.ts`.
 *
 * Idempotent: a record that already has a non-empty `items` is not matched.
 * Never throws — a migration that takes the API down on boot is worse than the
 * records it was trying to fix.
 */

/** The old top-level product fields, as they sit on an unmigrated document. */
interface LegacyGatePass {
  _id: unknown
  gatePassId?: string
  productName?: string
  productModel?: string
  qty?: number
}

export async function foldLegacyGatePassProducts(): Promise<void> {
  try {
    /**
     * Read through the driver rather than the model: these fields no longer
     * exist in the schema, so a Mongoose query would strip them out of both
     * the filter and the result — which is exactly the data being looked for.
     */
    const collection = GatePassModel.collection

    const legacy = (await collection
      .find({
        $and: [
          { productName: { $exists: true } },
          { $or: [{ items: { $exists: false } }, { items: { $size: 0 } }] },
        ],
      })
      .toArray()) as unknown as LegacyGatePass[]

    if (legacy.length === 0) {
      return
    }

    console.log(`[gate-pass] folding ${legacy.length} legacy product row(s) into items`)

    let repaired = 0

    for (const record of legacy) {
      const productName = record.productName?.trim()
      const productModel = record.productModel?.trim()
      const qty = record.qty

      if (!productName || !productModel || typeof qty !== 'number' || qty < 1) {
        // Nothing trustworthy to fold. Left alone and reported rather than
        // guessed at: an invented product line is worse than a visible gap.
        console.warn(
          `[gate-pass] ${record.gatePassId ?? String(record._id)} has no usable product to migrate`,
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
          $unset: { productName: '', productModel: '', productModelKey: '', qty: '' },
        },
      )

      repaired += 1
    }

    console.log(`[gate-pass] migrated ${repaired} of ${legacy.length} record(s)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[gate-pass] product migration failed: ${message}`)
  }
}
