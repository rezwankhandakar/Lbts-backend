import { createHash } from 'node:crypto'
import { AppError } from '../../utils/app-error'
import { comparisonKey } from '../gate-pass/gate-pass.constants'
import { rowAmountFor } from '../trip-do/trip-do.constants'
import type { TripDoLineDocument } from '../trip-do/trip-do.model'

/**
 * What a bill line copies off a Trip DO sheet row — every column the bill
 * prints, and the references it needs to find its challan and gate pass again.
 *
 * One function for both moments a copy is taken: adding a row, and checking
 * later whether the row still says the same thing. That is what makes the hash
 * comparison honest — two functions would eventually disagree about a field.
 */
export function snapshotOf(row: TripDoLineDocument) {
  const link = row.link
  if (!link) {
    throw new AppError(
      409,
      `${row.challanNumber} ${row.productModel || row.productName} has no Trip DO, so it cannot be billed. Set its Trip DO first.`,
    )
  }

  return {
    challanId: row.challanId,
    gatePassId: link.gatePassId,
    kind: row.kind,
    challanNumber: row.challanNumber,
    challanSlNumber: row.slNumber,
    challanDate: row.challanDate,
    customerName: row.customerName,
    deliveryAddress: row.deliveryAddress,
    district: row.district,
    thana: row.thana,
    locationType: row.locationType ?? null,
    receiverMobile: row.receiverMobile,
    productName: row.productName,
    productModel: row.productModel,
    capacity: row.capacity,
    qty: row.qty,
    rate: row.rate
      ? {
          kind: row.rate.kind,
          unitAmount: row.rate.unitAmount ?? null,
          firstQty: row.rate.firstQty ?? null,
          firstAmount: row.rate.firstAmount ?? null,
          restAmount: row.rate.restAmount ?? null,
        }
      : null,
    amount: rowAmountFor(row.lineAmount, row.lineQty, row.qty),
    tripDo: link.tripDo,
    tripDoKey: comparisonKey(link.tripDo),
    tripDate: link.tripDate,
    gatePassNumber: link.gatePassNumber,
    csd: link.csd,
    unit: link.unit,
    tripNumbers: [...row.tripNumbers],
  }
}

export type BillSnapshot = ReturnType<typeof snapshotOf>

/** A digest of a snapshot, ids and dates reduced to strings so the same row always hashes the same. */
export function snapshotHashOf(snapshot: BillSnapshot): string {
  const plain = {
    ...snapshot,
    challanId: String(snapshot.challanId),
    gatePassId: String(snapshot.gatePassId),
    challanDate: snapshot.challanDate.toISOString(),
    tripDate: snapshot.tripDate.toISOString(),
  }
  return createHash('sha1').update(JSON.stringify(plain)).digest('base64')
}
