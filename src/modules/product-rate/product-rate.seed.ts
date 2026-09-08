import { PRODUCT_RATE_SEED } from './product-rate.data'
import type { SeedRates } from './product-rate.data'
import { rateKey } from './product-rate.constants'
import { ProductRateModel } from './product-rate.model'

/**
 * Puts the supplied rate card into the collection, once.
 *
 * Runs on the first successful database connection, beside the other
 * migrations and the location seeder. It exists because a rate card with
 * nothing in it prices nothing — a first deploy would leave every challan line
 * uncharged until somebody had typed a hundred and forty rows into a form.
 *
 * Two properties make it safe to run on every boot, and they matter more here
 * than for locations because these are prices:
 *
 * **It only ever inserts.** A product and model already in the collection is
 * left exactly as it is, including its figures, its capacity and its active
 * flag. So an Admin who corrects a rate — or is told one has gone up — is not
 * overruled by the next deploy. That is the whole reason the collection is the
 * source of truth and `product-rate.data.ts` is only a seed.
 *
 * **It never throws.** A migration that takes the API down on boot is worse
 * than the reference data it was trying to install.
 */
export async function seedProductRates(): Promise<void> {
  try {
    const wanted = flattenSeed()

    const existing = await ProductRateModel.find({})
      .select('productNameKey productModelKey')
      .lean()

    const present = new Set(
      existing.map((row) => row.productNameKey + '|' + (row.productModelKey ?? '')),
    )

    const missing = wanted.filter((row) => !present.has(row.key))

    if (missing.length === 0) {
      return
    }

    console.log(`[product-rate] seeding ${missing.length} rate card row(s)`)

    /**
     * `ordered: false` so one unexpected duplicate — two instances booting at
     * the same moment, most likely — does not abandon the rest of the batch.
     * The unique index is what makes that collision harmless.
     */
    await ProductRateModel.collection.insertMany(
      missing.map((row) => ({
        productName: row.productName,
        productModel: row.productModel,
        productNameKey: row.productNameKey,
        productModelKey: row.productModelKey,
        capacity: row.capacity,
        rates: row.rates,
        isActive: true,
        isSeeded: true,
        createdBy: null,
        updatedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      { ordered: false },
    )

    console.log(`[product-rate] seeded ${missing.length} rate card row(s)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A duplicate-key error here is the expected shape of "two instances
    // seeded at once" and costs nothing; anything else is reported and
    // otherwise ignored, because a rate card is not worth a failed boot.
    console.error('[product-rate] seeding failed: ' + message)
  }
}

interface FlatSeedRow {
  key: string
  productName: string
  productModel: string
  productNameKey: string
  productModelKey: string
  capacity: string
  rates: SeedRates
}

/**
 * The grouped card as one row per product and model, with duplicates dropped.
 *
 * A genuine disagreement is reported rather than silently resolved: the same
 * model appearing twice under two different sets of figures is a mistake in
 * the transcription or in the card itself, and it is exactly the kind of thing
 * that would otherwise be discovered by somebody querying an invoice months
 * later. The first occurrence wins, so the behaviour is at least predictable.
 */
function flattenSeed(): FlatSeedRow[] {
  const rows = new Map<string, FlatSeedRow>()

  for (const group of PRODUCT_RATE_SEED) {
    const productNameKey = rateKey(group.productName)
    // No models on the card means one row that prices the product outright.
    const models = group.models && group.models.length > 0 ? group.models : ['']

    for (const productModel of models) {
      const productModelKey = rateKey(productModel)
      const key = productNameKey + '|' + productModelKey
      const existing = rows.get(key)

      if (existing) {
        console.warn(
          `[product-rate] seed lists ${group.productName} ` +
            `${productModel || '(no model)'} more than once; keeping the first`,
        )
        continue
      }

      rows.set(key, {
        key,
        productName: group.productName,
        productModel,
        productNameKey,
        productModelKey,
        capacity: group.capacity ?? '',
        rates: group.rates,
      })
    }
  }

  return [...rows.values()]
}
