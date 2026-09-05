import { GatePassModel } from './gate-pass.model'
import { comparisonKey } from './gate-pass.constants'
import { discardGatePassDocument } from './gate-pass.storage'

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

/** A withdrawn record, as it sits in the collection under the old vocabulary. */
interface CancelledGatePass {
  _id: unknown
  gatePassId?: string
  document?: { key?: string }
}

/**
 * Removes gate passes left in the retired `Cancelled` status.
 *
 * The module used to withdraw a record by parking it in a terminal status;
 * it now deletes one outright, and `Cancelled` is gone from the enum. A
 * document still holding that value is not merely stale — Mongoose validates
 * the whole document, so it could no longer be saved at all, and it would
 * render as an unrecognised status in every list it appeared in.
 *
 * Withdrawn is what these records already meant, so they are deleted rather
 * than moved to some other status that would misrepresent them. The scanned
 * document goes with each one, in the same order the service uses: the record
 * first, then the object, so the worst outcome is an orphan in the bucket.
 *
 * Idempotent — a second run finds nothing. Never throws, for the same reason
 * the product migration does not: a migration that takes the API down on boot
 * is worse than the records it was trying to fix.
 */
export async function purgeCancelledGatePasses(): Promise<void> {
  try {
    /**
     * Through the driver rather than the model: `Cancelled` is no longer part
     * of the schema's enum, and reading these through Mongoose would mean
     * casting a value the schema has been told does not exist.
     */
    const collection = GatePassModel.collection

    const cancelled = (await collection
      .find({ status: 'Cancelled' })
      .toArray()) as unknown as CancelledGatePass[]

    if (cancelled.length === 0) {
      return
    }

    console.log(`[gate-pass] removing ${cancelled.length} cancelled record(s)`)

    for (const record of cancelled) {
      await collection.deleteOne({ _id: record._id as never })
      await discardGatePassDocument(record.document?.key ?? null)
      console.log(`[gate-pass] removed ${record.gatePassId ?? String(record._id)} (cancelled)`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[gate-pass] cancelled-record purge failed: ${message}`)
  }
}
