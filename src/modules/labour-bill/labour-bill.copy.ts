import { createHash } from 'node:crypto'
import type { TripDoLineDocument } from '../trip-do/trip-do.model'

/**
 * What a labour bill row copies off a Trip DO sheet row — every column the
 * sheet prints, and the references it needs to find its challan and gate pass
 * again.
 *
 * One function for both moments a copy is taken: scanning a challan in, and
 * asking later whether the row still says the same thing. That is what makes
 * the comparison honest — two functions would eventually disagree about a
 * field, and the disagreement would look like drift that never clears.
 *
 * A Trip DO is deliberately **not** required here, unlike the Excel Bill's
 * snapshot, which refuses an unlinked row outright. Labour is charged on goods
 * that were carried whether or not the gate pass has been matched yet, so an
 * unlinked row lands with its Trip DO and CSD blank, is flagged on the sheet,
 * and fills itself in on the next refresh once somebody links it.
 */
export function labourCopyOf(row: TripDoLineDocument) {
  const link = row.link

  return {
    challanId: row.challanId,
    gatePassId: link?.gatePassId ?? null,
    challanNumber: row.challanNumber,
    challanSlNumber: row.slNumber,
    challanDate: row.challanDate,
    customerName: row.customerName,
    deliveryAddress: row.deliveryAddress,
    district: row.district,
    thana: row.thana,
    receiverMobile: row.receiverMobile,
    productName: row.productName,
    productModel: row.productModel,
    qty: row.qty,
    tripDo: link?.tripDo ?? '',
    tripDate: link?.tripDate ?? null,
    csd: link?.csd ?? '',
    unit: link?.unit ?? '',
    gatePassNumber: link?.gatePassNumber ?? '',
  }
}

export type LabourCopy = ReturnType<typeof labourCopyOf>

/** A digest of a copy, ids and dates reduced to strings so the same row always hashes the same. */
export function labourCopyHashOf(copy: LabourCopy): string {
  const plain = {
    ...copy,
    challanId: String(copy.challanId),
    gatePassId: copy.gatePassId ? String(copy.gatePassId) : null,
    challanDate: copy.challanDate.toISOString(),
    tripDate: copy.tripDate ? copy.tripDate.toISOString() : null,
  }
  return createHash('sha1').update(JSON.stringify(plain)).digest('base64')
}
