import type { LocationType } from "../location/location.constants";
import { priceItems } from "../product-rate/product-rate.service";
import { resolveLocation } from "../location/location.resolver";
import { ChallanModel } from "./challan.model";
import { comparisonKey } from "./challan.constants";

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
  _id: unknown;
  challanNumber?: string;
  product?: string;
  productModel?: string;
  qty?: number;
}

export async function foldLegacyChallanProducts(): Promise<void> {
  try {
    /**
     * Read through the driver rather than the model: these fields no longer
     * exist in the schema, so a Mongoose query would strip them out of both
     * the filter and the result — which is exactly the data being looked for.
     */
    const collection = ChallanModel.collection;

    const legacy = (await collection
      .find({
        $and: [
          { product: { $exists: true } },
          { $or: [{ items: { $exists: false } }, { items: { $size: 0 } }] },
        ],
      })
      .toArray()) as unknown as LegacyChallan[];

    if (legacy.length === 0) {
      return;
    }

    console.log(
      `[challan] folding ${legacy.length} legacy product row(s) into items`,
    );

    let repaired = 0;

    for (const record of legacy) {
      const productName = record.product?.trim();
      const productModel = record.productModel?.trim();
      const qty = record.qty;

      if (!productName || !productModel || typeof qty !== "number" || qty < 1) {
        // Nothing trustworthy to fold. Left alone and reported rather than
        // guessed at: an invented product line is worse than a visible gap.
        console.warn(
          `[challan] ${record.challanNumber ?? String(record._id)} has no usable product to migrate`,
        );
        continue;
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
          $unset: {
            product: "",
            productModel: "",
            productModelKey: "",
            qty: "",
          },
        },
      );

      repaired += 1;
    }

    console.log(`[challan] migrated ${repaired} of ${legacy.length} record(s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[challan] product migration failed: ${message}`);
  }
}

/**
 * Gives every challan filed before this feature existed a location status, and
 * resolves the ones that can be resolved safely.
 *
 * Two steps, and the second is deliberately timid.
 *
 * **First**, `locationStatus` is set to `Pending` on every record that has no
 * value for it. That is not cosmetic: the records list filters on this field,
 * and a record with no value at all would answer neither "verified" nor
 * "pending" and would quietly vanish from both — which is exactly the record
 * somebody is looking for.
 *
 * **Second**, a bounded pass tries to resolve them from the thana and district
 * already on the record. Local matching only — `allowAssisted: false` — for
 * three reasons: a backfill has nobody waiting on it, hundreds of assisted
 * calls at boot is precisely the wasteful use of an external quota this module
 * is written to avoid, and a bulk automatic classification of historical
 * records is the last place anybody would notice a systematic mistake.
 *
 * What it will not do:
 *
 * - it never touches a record that already has a resolved location, so an
 *   administrator's correction survives every future boot;
 * - it never writes a low-confidence match, because the resolver does not
 *   return one — an unresolved record simply stays Pending;
 * - it never fails a boot. A resolution that throws leaves that record alone.
 *
 * `BACKFILL_LIMIT` caps one run rather than the work: an M0 cluster should not
 * spend a boot on a year of records, and what is left is picked up next time
 * or set by an administrator, whichever happens first.
 */
const BACKFILL_LIMIT = 400;

export async function backfillChallanLocations(): Promise<void> {
  try {
    const marked = await ChallanModel.updateMany(
      { locationStatus: { $exists: false } },
      { $set: { locationStatus: "Pending", resolvedLocation: null } },
    );

    if (marked.modifiedCount > 0) {
      console.log(
        `[challan] marked ${marked.modifiedCount} record(s) as needing a location`,
      );
    }

    const pending = await ChallanModel.find({
      locationStatus: "Pending",
      resolvedLocation: null,
    })
      .select("thana district deliveryAddress")
      .sort({ createdAt: -1 })
      .limit(BACKFILL_LIMIT);

    if (pending.length === 0) {
      return;
    }

    let resolved = 0;

    for (const challan of pending) {
      const resolution = await resolveLocation(
        {
          thana: challan.thana ?? "",
          district: challan.district ?? "",
          deliveryAddress: challan.deliveryAddress,
        },
        { allowAssisted: false },
      );

      if (!resolution.resolved) {
        continue;
      }

      await ChallanModel.updateOne(
        { _id: challan._id },
        {
          $set: {
            resolvedLocation: {
              ...resolution.resolved,
              resolvedAt: new Date(),
              // Nothing chose it, so nothing is recorded as having.
              resolvedBy: null,
            },
            locationStatus: "Verified",
          },
        },
      );

      resolved += 1;
    }

    console.log(
      `[challan] resolved ${resolved} of ${pending.length} pending location(s) from the master list`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[challan] location backfill failed: ${message}`);
  }
}

/**
 * Prices the challan lines nobody could price when they were filed.
 *
 * Two things produce a line with no rate, and neither is the operator's fault:
 * a challan filed before its product was on the rate card, and a challan filed
 * before the card could match the model at all — which every challan was,
 * until the matcher learned that the card's `1D5` is a segment of the
 * challan's `WCF-1D5-GDEL-LX`.
 *
 * **It only ever fills a blank.** A line that already carries a figure is
 * untouched, and that is the difference between this and the bulk re-pricing
 * the module deliberately refuses: rewriting a stored rate would change what a
 * past delivery cost, whereas writing one where there was none changes nothing
 * that was ever charged. It also leaves alone any challan with no location,
 * because the location is what chooses the card's column.
 *
 * Bounded and idempotent. It runs on every boot, finds nothing once the
 * backlog is cleared, and never throws — a migration that takes the API down
 * is worse than the figures it was trying to fill in.
 */
export async function priceUnpricedChallanItems(): Promise<void> {
  try {
    const unpriced = await ChallanModel.find({
      locationStatus: "Verified",
      "resolvedLocation.masterId": { $ne: null },
      items: { $elemMatch: { rate: null } },
    })
      .sort({ createdAt: -1 })
      .limit(BACKFILL_LIMIT);

    if (unpriced.length === 0) {
      return;
    }

    let priced = 0;

    for (const challan of unpriced) {
      const locationType = challan.resolvedLocation?.locationType;
      if (!locationType) {
        continue;
      }

      const applications = await priceItems(
        challan.items.map((item) => ({
          productName: item.productName,
          model: item.productModel,
          qty: item.qty,
        })),
        locationType as LocationType,
      );

      const appliedAt = new Date();
      let changed = false;

      challan.items.forEach((item, index) => {
        const applied = applications[index];
        // Only a blank is filled. A line that already has a figure keeps it,
        // whatever the card says today.
        if (!applied || item.rate) {
          return;
        }

        item.capacity = applied.capacity;
        item.set("rate", {
          masterId: applied.masterId,
          locationType: applied.locationType,
          kind: applied.rate.kind,
          unitAmount: applied.rate.kind === "flat" ? applied.rate.amount : null,
          firstQty: applied.rate.kind === "tiered" ? applied.rate.firstQty : null,
          firstAmount:
            applied.rate.kind === "tiered" ? applied.rate.firstAmount : null,
          restAmount:
            applied.rate.kind === "tiered" ? applied.rate.restAmount : null,
          amount: applied.amount,
          appliedAt,
        });
        changed = true;
      });

      if (!changed) {
        continue;
      }

      /**
       * Saved without touching `updatedBy`, `status` or `amendedAt`. Nobody
       * corrected this challan — the system finished a job it had failed at —
       * and recording it as an amendment would tell an operator to reprint a
       * sheet whose printed side has not changed.
       */
      await challan.save();
      priced += 1;
    }

    if (priced > 0) {
      console.log(
        `[challan] priced ${priced} of ${unpriced.length} challan(s) that had uncharged lines`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[challan] rate backfill failed: ${message}`);
  }
}

/**
 * Gives every existing challan a `chargeStatus`.
 *
 * The field is derived from `items` and kept in step by a pre-save hook, so
 * anything written from now on carries it — but a record filed before the
 * field existed has nothing, and the records list filters and counts on it.
 * Without this the charge chips would report zero and the "Amount blank"
 * filter would find nothing, both of which are worse than no feature at all
 * because they look like answers.
 *
 * Three `updateMany` calls rather than a loop: this is a classification of
 * existing data, not a computation, and Mongo can do it in one pass each. It
 * only ever writes records whose stored value disagrees with their lines, so
 * it is idempotent and finds nothing on the second boot.
 *
 * Never throws, for the same reason none of the others do.
 */
export async function backfillChallanChargeStatus(): Promise<void> {
  try {
    /** A challan with no lines at all counts as uncharged, not as settled. */
    const noPricedLine = {
      $nor: [{ items: { $elemMatch: { rate: { $ne: null } } } }],
    };
    const noUnpricedLine = {
      $nor: [{ items: { $elemMatch: { rate: null } } }],
      "items.0": { $exists: true },
    };

    const [unpriced, charged, partial] = await Promise.all([
      ChallanModel.updateMany(
        { ...noPricedLine, chargeStatus: { $ne: "Unpriced" } },
        { $set: { chargeStatus: "Unpriced" } },
      ),
      ChallanModel.updateMany(
        { ...noUnpricedLine, chargeStatus: { $ne: "Charged" } },
        { $set: { chargeStatus: "Charged" } },
      ),
      ChallanModel.updateMany(
        {
          items: { $elemMatch: { rate: null } },
          $and: [{ items: { $elemMatch: { rate: { $ne: null } } } }],
          chargeStatus: { $ne: "Partial" },
        },
        { $set: { chargeStatus: "Partial" } },
      ),
    ]);

    const changed =
      unpriced.modifiedCount + charged.modifiedCount + partial.modifiedCount;

    if (changed > 0) {
      console.log(
        `[challan] classified ${changed} record(s) by charge status ` +
          `(${charged.modifiedCount} charged, ${partial.modifiedCount} partial, ` +
          `${unpriced.modifiedCount} unpriced)`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[challan] charge status backfill failed: ${message}`);
  }
}
