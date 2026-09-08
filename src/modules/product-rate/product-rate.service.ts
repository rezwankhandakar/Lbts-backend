import type { QueryFilter } from 'mongoose'
import { AppError } from '../../utils/app-error'
import { ChallanModel } from '../challan/challan.model'
import type { LocationType } from '../location/location.constants'
import { UserModel } from '../user/user.model'
import type { UserDocument } from '../user/user.model'
import {
  MAX_MODEL_MATCHES,
  embeddedModelKeys,
  modelMatchKeys,
} from './product-rate.constants'
import type { Rate } from './product-rate.constants'
import { ProductRateModel, normalizedProduct, toRate } from './product-rate.model'
import type { ProductRate, ProductRateDocument } from './product-rate.model'
import { priceLines } from './product-rate.pricing'
import { toModelMatch, toProductRateRecord } from './product-rate.serializer'
import type { ModelMatch, ProductRateRecord } from './product-rate.serializer'
import type {
  CreateProductRateInput,
  ListProductRatesQuery,
  UpdateProductRateInput,
} from './product-rate.validation'

/**
 * Administering the rate card, and applying it.
 *
 * Reference data, so its rules look like the Location master's rather than a
 * records module's: no lifecycle, no ownership, and the only interesting
 * decisions are about identity and about what happens to the challans holding
 * a figure from a row somebody wants gone.
 *
 * The second half of the file is the part Challan calls. It is deliberately
 * one function — `priceItems` — because there is exactly one rule for what a
 * line is charged, and a second entry point into it is a second rule waiting
 * to disagree.
 */

/** User input reaches a regex, so metacharacters must lose their meaning. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function resolveActorNames(
  records: { createdBy?: unknown; updatedBy?: unknown }[],
): Promise<Map<string, string>> {
  const ids = new Set<string>()

  for (const record of records) {
    if (record.createdBy) ids.add(String(record.createdBy))
    if (record.updatedBy) ids.add(String(record.updatedBy))
  }

  if (ids.size === 0) {
    return new Map()
  }

  const actors = await UserModel.find({ _id: { $in: [...ids] } }).select('name')
  return new Map(actors.map((actor) => [String(actor._id), actor.name]))
}

async function serialize(rate: ProductRateDocument): Promise<ProductRateRecord> {
  return toProductRateRecord(rate, await resolveActorNames([rate]))
}

async function findProductRate(id: string): Promise<ProductRateDocument> {
  const rate = await ProductRateModel.findById(id)
  if (!rate) {
    throw new AppError(404, 'That product is not on the rate card.')
  }
  return rate
}

/** "Refrigerator 2N5", or just "Hair Dryer" for a row with no model. */
function labelOf(rate: { productName: string; productModel: string }): string {
  return rate.productModel ? `${rate.productName} ${rate.productModel}` : rate.productName
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListProductRatesResult {
  records: ProductRateRecord[]
  total: number
}

function buildListFilter(query: ListProductRatesQuery): QueryFilter<ProductRate> {
  const clauses: QueryFilter<ProductRate>[] = []

  if (query.productName) {
    clauses.push({ productName: new RegExp(escapeRegex(query.productName), 'i') })
  }
  if (query.active !== 'all') {
    clauses.push({ isActive: query.active === 'active' })
  }
  if (query.hasModel !== 'all') {
    clauses.push(query.hasModel === 'yes' ? { productModel: { $ne: '' } } : { productModel: '' })
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    clauses.push({
      $or: [{ productName: pattern }, { productModel: pattern }, { capacity: pattern }],
    })
  }

  return clauses.length > 0 ? { $and: clauses } : {}
}

export async function listProductRates(
  query: ListProductRatesQuery,
): Promise<ListProductRatesResult> {
  const filter = buildListFilter(query)
  const skip = (query.page - 1) * query.limit

  const [records, total] = await Promise.all([
    ProductRateModel.find(filter)
      // Alphabetical rather than newest-first: this is a rate card, and
      // somebody looking for the washing machine rates is looking under W.
      .sort({ productName: 1, productModel: 1 })
      .skip(skip)
      .limit(query.limit),
    ProductRateModel.countDocuments(filter),
  ])

  const names = await resolveActorNames(records)

  return { records: records.map((record) => toProductRateRecord(record, names)), total }
}

/**
 * Which products carry this model.
 *
 * The lookup behind the entry form's product suggestions: an operator pastes a
 * model off the challan and the rate card says what that model is.
 *
 * The keys it asks about are the ones `modelMatchKeys` derives — the whole
 * code and each of its segments — because the card names a refrigerator `1D5`
 * and the challan names it `WCF-1D5-GDEL-LX`. Comparing whole strings finds
 * nothing, which is what a correctly seeded card looked like before this.
 *
 * Matches first, prefixes only when there are none: a model normally
 * identifies exactly one product, and an outright answer should never be
 * diluted by everything that merely starts the same way.
 *
 * Active rows only. An inactive row prices nothing, and offering its product
 * name would be suggesting a value the pricing step would then decline to use.
 */
export async function matchProductsForModel(model: string): Promise<ModelMatch[]> {
  const keys = modelMatchKeys(model)
  if (keys.length === 0) {
    return []
  }

  /**
   * The whole code and each of its segments, together. A challan writing
   * `WCF-1D5-GDEL-LX` is answered by the card's `1D5` row; one writing `1D5`
   * is answered by the same row. Whichever key found it, the answer is the
   * product name the card uses — which is the point, because pricing insists
   * the product name match a card row.
   */
  const exact = await ProductRateModel.find({
    isActive: true,
    productModelKey: { $in: keys },
  })
    .sort({ productName: 1, productModel: 1 })
    .limit(MAX_MODEL_MATCHES)

  if (exact.length > 0) {
    return exact.map(toModelMatch)
  }

  /**
   * Nothing matched the whole code or any of its segments, so the model
   * probably carries no separators at all — `WCF1D5GDELLX` rather than
   * `WCF-1D5-GDEL-LX`. The card's model is in there; only containment can see
   * it.
   *
   * A tier of its own rather than folded into the query above, so an exact
   * answer is never diluted by a buried one — and so a challan whose model
   * matches cleanly costs exactly the one query it always did.
   */
  const embedded = embeddedModelKeys(model)

  if (embedded.length > 0) {
    const buried = await ProductRateModel.find({
      isActive: true,
      productModelKey: { $in: embedded },
    })
      .sort({ productName: 1, productModel: 1 })
      .limit(MAX_MODEL_MATCHES)

    if (buried.length > 0) {
      return buried.map(toModelMatch)
    }
  }

  /**
   * Nothing matched outright, so the operator is probably still typing. Each
   * key is tried as a prefix — the segments included, so a half-typed
   * `WCF-1D` reaches `1D4` and `1D5` rather than waiting for the separator.
   */
  const prefix = await ProductRateModel.find({
    isActive: true,
    $or: keys.map((key) => ({
      productModelKey: new RegExp('^' + escapeRegex(key)),
    })),
  })
    .sort({ productName: 1, productModel: 1 })
    .limit(MAX_MODEL_MATCHES)

  return prefix.map(toModelMatch)
}

export interface ProductNameMatch {
  productName: string
  /** How many rows name a model. Zero means the product is priced outright. */
  modelCount: number
}

/**
 * Product names on the card, offered while somebody types in the product box.
 *
 * The other half of the entry form's help, and the half the model lookup
 * cannot give. A hair dryer has no model on the card, so there is nothing to
 * paste and nothing to look up — the product name is the only way in, and
 * without this the operator is left to guess whether the card says "Gas
 * Stove-Single" or "Single Gas Stove". Getting that wrong is not a typo; it is
 * a line nothing can charge.
 *
 * Grouped by name rather than returned row by row: `Refrigerator` is sixty-six
 * rows of the card and one answer to "what is this product called". The model
 * count travels with it so the caller can say which names still want a model
 * beside them.
 *
 * A short prefix is deliberately allowed. The card is a few hundred rows, the
 * result is capped, and two characters is what somebody actually types before
 * expecting help.
 */
export async function suggestProductNames(query: string): Promise<ProductNameMatch[]> {
  const rows = await ProductRateModel.aggregate<{ _id: string; modelCount: number }>([
    {
      $match: {
        isActive: true,
        productName: new RegExp('^' + escapeRegex(query), 'i'),
      },
    },
    {
      $group: {
        _id: '$productName',
        modelCount: {
          $sum: { $cond: [{ $ne: ['$productModel', ''] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: MAX_MODEL_MATCHES },
  ])

  return rows
    .filter((row) => typeof row._id === 'string' && row._id.length > 0)
    .map((row) => ({ productName: row._id, modelCount: row.modelCount }))
}

export interface ProductRateStats {
  total: number
  active: number
  inactive: number
  /** Distinct product names, which is how many things the card actually covers. */
  products: number
  withModel: number
  withoutModel: number
  tiered: number
}

export async function getProductRateStats(): Promise<ProductRateStats> {
  const [byStatus, byModel, products, tiered] = await Promise.all([
    ProductRateModel.aggregate<{ _id: boolean; count: number }>([
      { $group: { _id: '$isActive', count: { $sum: 1 } } },
    ]),
    ProductRateModel.aggregate<{ _id: boolean; count: number }>([
      { $group: { _id: { $ne: ['$productModel', ''] }, count: { $sum: 1 } } },
    ]),
    ProductRateModel.aggregate<{ _id: string }>([
      { $group: { _id: '$productName' } },
      { $count: 'total' },
    ]).then((rows) => (rows[0] as unknown as { total?: number } | undefined)?.total ?? 0),
    /**
     * How many rows carry a tiered figure in any column. Diagnostic, and worth
     * showing: a tiered rate is the one shape on this card that cannot be read
     * off a single number, so an Admin should be able to see at a glance how
     * many of them there are.
     */
    ProductRateModel.countDocuments({
      $or: [
        { 'rates.ISD.kind': 'tiered' },
        { 'rates.OSD-Metro.kind': 'tiered' },
        { 'rates.OSD-Thana.kind': 'tiered' },
      ],
    }),
  ])

  const active = byStatus.find((row) => row._id === true)?.count ?? 0
  const inactive = byStatus.find((row) => row._id === false)?.count ?? 0
  const withModel = byModel.find((row) => row._id === true)?.count ?? 0
  const withoutModel = byModel.find((row) => row._id === false)?.count ?? 0

  return { total: active + inactive, active, inactive, products, withModel, withoutModel, tiered }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Refuses a product and model the card already holds.
 *
 * Compared on the normalised values rather than the typed ones, or `SWG60N`
 * and `swg-60n` would be two rows and every lookup would have to choose
 * between them. The unique index enforces the same rule; this is here so the
 * answer is a sentence rather than a driver error.
 */
async function assertNotDuplicate(
  productName: string,
  productModel: string,
  excludeId?: string,
): Promise<void> {
  const keys = normalizedProduct(productName, productModel)
  const filter: QueryFilter<ProductRate> = { ...keys }
  if (excludeId) {
    filter._id = { $ne: excludeId }
  }

  const existing = await ProductRateModel.findOne(filter).select(
    'productName productModel isActive',
  )

  if (existing) {
    const label = labelOf(existing)
    throw new AppError(
      409,
      existing.isActive
        ? `${label} is already on the rate card.`
        : `${label} is already on the rate card, but deactivated. Reactivate it rather than adding it again.`,
    )
  }
}

export async function createProductRate(
  input: CreateProductRateInput,
  actor: UserDocument,
): Promise<ProductRateRecord> {
  await assertNotDuplicate(input.productName, input.productModel)

  const rate = await ProductRateModel.create({
    productName: input.productName,
    productModel: input.productModel,
    ...normalizedProduct(input.productName, input.productModel),
    capacity: input.capacity,
    rates: input.rates,
    isActive: input.isActive,
    isSeeded: false,
    createdBy: actor._id,
    updatedBy: actor._id,
  })

  return serialize(rate)
}

/**
 * Corrects a row.
 *
 * A changed product or model rewrites the comparison keys with it — they are
 * derived from the typed values and can never be set independently, which is
 * what stops a row from pricing something it does not name.
 *
 * Nothing is rewritten on the challans already carrying a figure from this
 * row, and that is the opposite of what the Location master does. A challan
 * stores a *reference* to a location because a misclassified district was
 * always wrong; it stores a *copy* of a rate because the rate was right when
 * it was applied. Correcting a figure here changes what the next challan is
 * charged and leaves what was already charged exactly as it was.
 */
export async function updateProductRate(
  id: string,
  input: UpdateProductRateInput,
  actor: UserDocument,
): Promise<ProductRateRecord> {
  const rate = await findProductRate(id)

  const productName = input.productName ?? rate.productName
  const productModel = input.productModel ?? rate.productModel

  if (productName !== rate.productName || productModel !== rate.productModel) {
    await assertNotDuplicate(productName, productModel, id)
    rate.productName = productName
    rate.productModel = productModel
    const keys = normalizedProduct(productName, productModel)
    rate.productNameKey = keys.productNameKey
    rate.productModelKey = keys.productModelKey
  }

  if (input.capacity !== undefined) {
    rate.capacity = input.capacity
  }
  if (input.rates) {
    // Replaced wholesale, never merged: three figures decided together stay
    // together, or a row ends up half from one revision of the card.
    rate.set('rates', input.rates)
  }
  if (input.isActive !== undefined) {
    rate.isActive = input.isActive
  }

  rate.updatedBy = actor._id
  await rate.save()

  return serialize(rate)
}

export interface ProductRateRemoval {
  id: string
  /** True when the row was deactivated instead, because challans cite it. */
  deactivated: boolean
  challanCount: number
}

/**
 * Removing a rate card row, safely.
 *
 * A row nothing cites is deleted outright — a product added by mistake should
 * not have to be lived with. A row challans point at is **deactivated
 * instead**, and the caller is told so plainly.
 *
 * The reason is different from the Location master's and worth saying. A
 * challan does not read its rate through this row, so deleting it would not
 * break any record. What it would break is the answer to "where did this
 * figure come from" — the one question anybody asks about a charge they
 * disagree with. Keeping the row is what keeps that answerable.
 */
export async function removeProductRate(
  id: string,
  actor: UserDocument,
): Promise<ProductRateRemoval> {
  const rate = await findProductRate(id)

  const challanCount = await ChallanModel.countDocuments({ 'items.rate.masterId': rate._id })

  if (challanCount > 0) {
    if (rate.isActive) {
      rate.isActive = false
      rate.updatedBy = actor._id
      await rate.save()
    }

    return { id: String(rate._id), deactivated: true, challanCount }
  }

  await rate.deleteOne()

  return { id: String(rate._id), deactivated: false, challanCount: 0 }
}

// ---------------------------------------------------------------------------
// Applying the card
// ---------------------------------------------------------------------------

/** A challan line, as much of it as pricing needs. */
export interface PriceableItem {
  productName: string
  model: string
  qty: number
}

/**
 * What one line was charged, and on whose authority.
 *
 * A reference plus a copy, exactly like `resolvedLocation` on a challan —
 * `masterId` says which row of the card answered, and everything beside it is
 * what that row said at the time. The copy is what makes a filed challan
 * immune to a later correction of the card, and the reference is what makes
 * the figure traceable back to the row it came from.
 */
export interface RateApplication {
  masterId: string
  /** The column used, which is the challan's location type. */
  locationType: LocationType
  rate: Rate
  capacity: string
  /** This line's charge, tiered arithmetic included. */
  amount: number
}

/**
 * The rate card row that answers for one line.
 *
 * The rule, and there is only one: **the product name must match.** A row
 * naming the line's model is preferred; failing that, the product's
 * model-blank row answers, which is how a hair dryer gets a rate without
 * having a model at all.
 *
 * There is deliberately no model-only fallback. A model that matched while the
 * product name did not would price a line the card does not describe, and the
 * operator would have no way to see that it had happened — which is the same
 * shape of quiet wrongness the Location resolver refuses when it declines to
 * guess a district. The right cure for a mistyped product name is the model
 * lookup above, which offers the card's own spelling before anything is filed.
 */
function pickRow(
  rows: readonly ProductRateDocument[],
  nameKey: string,
  modelKeys: readonly string[],
): ProductRateDocument | null {
  const forProduct = rows.filter((row) => row.productNameKey === nameKey)

  /**
   * The whole model first, then its segments left to right — so a challan
   * writing the card's own code is answered by that row, and one writing
   * `WCF-1D5-GDEL-LX` is answered by `1D5`.
   *
   * **Two different rows matching two different segments is a refusal**, not a
   * choice. A line reading `TWG80-Q60` names two washing machine models the
   * card prices separately, and nothing here knows which of them the delivery
   * actually was. The same rule the location matcher applies to a tie: guessing
   * between two real answers is the failure this exists to avoid. It falls
   * through to the product's model-blank row, which is a rule somebody wrote
   * down rather than a coin toss.
   */
  for (const key of modelKeys) {
    const matches = forProduct.filter((row) => row.productModelKey === key)
    if (matches.length === 1) {
      return matches[0]
    }
    if (matches.length > 1) {
      break
    }
  }

  return forProduct.find((row) => row.productModelKey === '') ?? null
}

/**
 * Prices a challan's lines against the card.
 *
 * One database read for the whole challan, whatever it carries: the `$or` is
 * built from the lines themselves and every clause is an indexed equality, so
 * a ten-line challan is one query rather than ten. That matters more than it
 * looks on M0, where this runs inside a submission that is already holding a
 * connection open.
 *
 * Every line comes back positionally, and a line the card does not cover comes
 * back null. That is an ordinary outcome and never an error: a product absent
 * from the rate card is priced by a person, and a challan is filed, numbered
 * and printed whether or not anything here answered.
 */
export async function priceItems(
  items: readonly PriceableItem[],
  locationType: LocationType,
): Promise<(RateApplication | null)[]> {
  if (items.length === 0) {
    return []
  }

  const keys = items.map((item) => ({
    productNameKey: normalizedProduct(item.productName, '').productNameKey,
    modelKeys: modelMatchKeys(item.model),
  }))

  /**
   * Each line asks for the rows its own model could be answered by — the whole
   * code and each of its segments — plus its product's model-blank row, and
   * nothing else. Every clause is an indexed equality, so a ten-line challan
   * is still one query rather than ten, and fetching every row of a product
   * would pull fifty refrigerator rates to price one line.
   */
  const clauses = keys.map(({ productNameKey, modelKeys }) => ({
    productNameKey,
    productModelKey: { $in: [...modelKeys, ''] },
  }))

  const rows = await ProductRateModel.find({ isActive: true, $or: clauses })

  let matched = keys.map(({ productNameKey, modelKeys }) =>
    pickRow(rows, productNameKey, modelKeys),
  )

  /**
   * A second pass, for the lines nothing answered — and only for those.
   *
   * Their models probably carry no separators, so the card's model is buried
   * inside them and only containment can see it. That costs a much wider set
   * of candidate keys, which is exactly why it is a second query rather than a
   * wider first one: a challan whose models match cleanly pays nothing for
   * this, and on M0 the round trip it saves is worth the branch.
   */
  const buried = keys
    .map((key, index) => ({ ...key, index }))
    .filter((key) => matched[key.index] === null)
    .map((key) => ({ ...key, embedded: embeddedModelKeys(items[key.index].model) }))
    .filter((key) => key.embedded.length > 0)

  if (buried.length > 0) {
    const extraRows = await ProductRateModel.find({
      isActive: true,
      $or: buried.map((key) => ({
        productNameKey: key.productNameKey,
        productModelKey: { $in: key.embedded },
      })),
    })

    if (extraRows.length > 0) {
      matched = [...matched]
      for (const key of buried) {
        // Longest candidate first, so the most specific buried match wins and
        // two rows matching one candidate is still refused rather than guessed.
        matched[key.index] = pickRow(extraRows, key.productNameKey, key.embedded)
      }
    }
  }

  const amounts = priceLines(
    matched.map((row, index) => ({
      rateId: row ? String(row._id) : null,
      rate: row ? toRate(row.rates?.[locationType]) : null,
      qty: items[index].qty,
    })),
  )

  return matched.map((row, index) => {
    const amount = amounts[index]
    const rate = row ? toRate(row.rates?.[locationType]) : null

    if (!row || !rate || amount === null) {
      return null
    }

    return {
      masterId: String(row._id),
      locationType,
      rate,
      capacity: row.capacity,
      amount,
    }
  })
}
