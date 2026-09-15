import { createHash } from 'node:crypto'
import type { Types } from 'mongoose'
import { refreshBillingStatus } from '../bill/bill.status'
import { ChallanModel } from '../challan/challan.model'
import { DeliveryModel } from '../delivery/delivery.model'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import { orderRowStatusFor } from './trip-do.constants'
import type { RowDeliveryStatus } from './trip-do.constants'
import { ledgerSourcesFor, reconcileRows } from './trip-do.ledger'
import type { LedgerSource, LedgerTrip } from './trip-do.ledger'
import { TripDoLineModel } from './trip-do.model'

/**
 * Keeps the Trip DO sheet in step with the challans and trips it is a view of.
 *
 * Called wherever either changes — a challan filed, corrected, relocated or
 * deleted, and every trip change through `refreshChallanDispatch` — in the
 * spirit of `refreshBatchProgress`: derived from the source and rewritten,
 * never incremented, so it cannot drift.
 *
 * Two things it deliberately does **not** do. It never throws: a sheet row one
 * write behind is a spreadsheet reading slightly stale, and refusing the
 * challan or the trip over it would be refusing the thing that actually
 * happened. And it never touches a Trip DO except to let one go when the goods
 * it pointed at no longer exist — see `reconcileRows`.
 */

type IdLike = Types.ObjectId | string

/** Challans per round of reads, so one sync cannot pull a whole collection. */
const CHUNK = 50

const CHALLAN_FIELDS =
  'challanNumber slNumber submittedAt customerName deliveryAddress district thana ' +
  'resolvedLocation receiverMobile zonePo items dispatchStatus returnedQty resentQty'

async function loadChallans(ids: string[]) {
  return ChallanModel.find({ _id: { $in: ids } }).select(CHALLAN_FIELDS)
}

type LoadedChallan = Awaited<ReturnType<typeof loadChallans>>[number]

async function loadTrips(ids: string[]): Promise<Map<string, LedgerTrip[]>> {
  const wanted = new Set(ids)
  const result = new Map<string, LedgerTrip[]>()

  const trips = await DeliveryModel.find({ 'challans.challanId': { $in: ids } })
    .select('tripNumber tripDate createdAt challans')
    .sort({ tripDate: 1, createdAt: 1 })

  for (const trip of trips) {
    for (const entry of trip.challans) {
      const key = String(entry.challanId)
      if (!wanted.has(key)) {
        continue
      }

      const list = result.get(key) ?? []
      list.push({
        id: String(trip._id),
        tripNumber: trip.tripNumber,
        completed: Boolean(entry.completedAt),
        lines: entry.lines.map((line) => ({
          productName: line.productName,
          model: line.productModel,
          qty: line.qty,
        })),
        returned: (entry.returned ?? []).map((line) => ({
          productName: line.productName,
          model: line.productModel,
          qty: line.qty,
        })),
      })
      result.set(key, list)
    }
  }

  return result
}

function rateCopyOf(item: LoadedChallan['items'][number] | undefined) {
  const rate = item?.rate
  if (!rate) {
    return null
  }
  return {
    kind: rate.kind,
    unitAmount: rate.unitAmount ?? null,
    firstQty: rate.firstQty ?? null,
    firstAmount: rate.firstAmount ?? null,
    restAmount: rate.restAmount ?? null,
  }
}

function deliveryStatusOf(challan: LoadedChallan, source: LedgerSource): RowDeliveryStatus {
  if (source.kind === 'Return') {
    return 'Returned'
  }
  if (source.kind === 'Resent') {
    return source.tripCompleted ? 'Delivered' : 'Dispatched'
  }
  return orderRowStatusFor(challan)
}

/**
 * Everything a row copies, for one source.
 *
 * A return or a re-send carries the rate, charge and quantity of the order line
 * it belongs under, so its Amount is those pieces' share of that line — what
 * the pieces that came back, or went out again, are worth. It is shown on the
 * row and left out of the sheet's total (`totalsFor` sums order rows only),
 * because the order row already counts that charge. See `rowAmountFor`.
 */
function copyFor(challan: LoadedChallan, source: LedgerSource) {
  const line = challan.items[source.position]
  const item = source.itemIndex !== null ? challan.items[source.itemIndex] : line
  const location = challan.resolvedLocation

  return {
    kind: source.kind,
    position: source.position,
    rowSeq: source.rowSeq,
    tripId: source.tripId,

    challanNumber: challan.challanNumber,
    slNumber: challan.slNumber,
    challanDate: challan.submittedAt,
    customerName: challan.customerName,
    deliveryAddress: challan.deliveryAddress,
    district: location?.district || challan.district || '',
    thana: location?.thana || challan.thana || '',
    locationType: location?.locationType ?? null,
    receiverMobile: challan.receiverMobile,
    zonePo: challan.zonePo ?? null,

    productName: source.productName,
    productModel: source.model,
    productModelKey: comparisonKey(source.model),
    capacity: item?.capacity ?? '',
    rate: rateCopyOf(item),
    lineQty: source.kind === 'Order' ? source.qty : (item?.qty ?? 0),
    lineAmount: item?.rate?.amount ?? null,
    firstDeliveredQty: source.kind === 'Order' ? source.firstDeliveredQty : null,

    tripNumbers: source.tripNumbers,
    deliveryStatus: deliveryStatusOf(challan, source),
  }
}

function hashOf(copy: ReturnType<typeof copyFor>): string {
  return createHash('sha1').update(JSON.stringify(copy)).digest('base64')
}

async function syncIds(ids: string[]): Promise<void> {
  const [challans, tripsByChallan, rows] = await Promise.all([
    loadChallans(ids),
    loadTrips(ids),
    TripDoLineModel.find({ challanId: { $in: ids } }).select(
      '_id challanId sourceKey qty link bill splitIndex copyHash',
    ),
  ])

  const writes: Parameters<typeof TripDoLineModel.bulkWrite>[0] = []
  const found = new Set(challans.map((challan) => String(challan._id)))
  const missing = ids.filter((id) => !found.has(id))

  if (missing.length > 0) {
    // The challan is gone, and the rows it was the source of go with it.
    writes.push({ deleteMany: { filter: { challanId: { $in: missing } } } })
  }

  for (const challan of challans) {
    const id = String(challan._id)
    const sources = ledgerSourcesFor(
      id,
      challan.items.map((item) => ({
        productName: item.productName,
        model: item.productModel,
        qty: item.qty,
      })),
      tripsByChallan.get(id) ?? [],
    )

    const own = rows.filter((row) => String(row.challanId) === id)
    const plan = reconcileRows(
      sources,
      own.map((row) => ({
        id: String(row._id),
        sourceKey: row.sourceKey,
        qty: row.qty,
        linked: Boolean(row.link),
        billed: Boolean(row.bill),
        splitIndex: row.splitIndex,
      })),
    )

    const removed = new Set(plan.remove)
    const copies = new Map(
      sources.map((source) => {
        const copy = copyFor(challan, source)
        return [source.sourceKey, { copy, hash: hashOf(copy) }]
      }),
    )

    for (const rowId of plan.remove) {
      writes.push({ deleteOne: { filter: { _id: rowId } } })
    }

    for (const change of plan.setQty) {
      writes.push({ updateOne: { filter: { _id: change.id }, update: { $set: { qty: change.qty } } } })
    }

    for (const created of plan.create) {
      const entry = copies.get(created.sourceKey)
      if (!entry) {
        continue
      }
      writes.push({
        insertOne: {
          document: {
            challanId: challan._id,
            sourceKey: created.sourceKey,
            splitIndex: created.splitIndex,
            qty: created.qty,
            link: null,
            tripDoKey: '',
            ...entry.copy,
            copyHash: entry.hash,
          },
        },
      })
    }

    // Rows that survive, whose challan or trips said something new.
    for (const row of own) {
      const entry = copies.get(row.sourceKey)
      if (!entry || removed.has(String(row._id)) || row.copyHash === entry.hash) {
        continue
      }
      writes.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { ...entry.copy, copyHash: entry.hash } },
        },
      })
    }
  }

  if (writes.length > 0) {
    await TripDoLineModel.bulkWrite(writes, { ordered: false })
  }

  // A billed row may have just shrunk or gone, and a new unbilled row may have
  // appeared beside billed ones: either moves a challan's billing status. A
  // challan none of whose rows was billed stays Unbilled, so it is not asked.
  const billed = rows.filter((row) => row.bill)
  if (billed.length > 0) {
    await refreshBillingStatus({
      challanIds: billed.map((row) => row.challanId),
      gatePassIds: billed.map((row) => row.link?.gatePassId),
    })
  }
}

export async function syncTripDoLedger(challanIds: IdLike[]): Promise<void> {
  const unique = [...new Set(challanIds.map(String))]

  for (let start = 0; start < unique.length; start += CHUNK) {
    try {
      await syncIds(unique.slice(start, start + CHUNK))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[trip-do] sheet rows not refreshed: ${message}`)
    }
  }
}

/**
 * Builds the sheet for every challan on record, and clears rows whose challan
 * no longer exists.
 *
 * Run once per boot, after the dispatch, location and rate backfills — each of
 * those changes something a row copies. Idempotent and cheap on a boot with
 * nothing to do: every row carries a digest of what it copied, so a row whose
 * challan has not moved is read and not written. It never throws.
 */
export async function backfillTripDoLedger(): Promise<void> {
  try {
    let after: Types.ObjectId | null = null

    for (;;) {
      const batch: { _id: Types.ObjectId }[] = await ChallanModel.find(
        after ? { _id: { $gt: after } } : {},
      )
        .select('_id')
        .sort({ _id: 1 })
        .limit(200)

      if (batch.length === 0) {
        break
      }

      await syncTripDoLedger(batch.map((challan) => challan._id))
      after = batch[batch.length - 1]._id
    }

    const referenced = await TripDoLineModel.distinct('challanId')
    const existing = new Set(
      (await ChallanModel.distinct('_id', { _id: { $in: referenced } })).map(String),
    )
    const orphaned = referenced.filter((id) => !existing.has(String(id)))

    if (orphaned.length > 0) {
      await TripDoLineModel.deleteMany({ challanId: { $in: orphaned } })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[trip-do] sheet backfill skipped: ${message}`)
  }
}
