import type { Types } from 'mongoose'
import type { LocationType } from '../location/location.constants'
import type { Rate } from './product-rate.constants'
import { toRate } from './product-rate.model'
import type { ProductRateDocument } from './product-rate.model'

/**
 * One rate card row, as a client sees it.
 *
 * The comparison keys are not here. They are a lookup mechanism with no
 * meaning outside the matcher, and putting them on the wire would invite
 * something to start matching on them client-side — the same split brain the
 * Location serializer refuses for the same reason.
 *
 * The three rates come back as the discriminated union rather than as the
 * stored five-field shape, so a client never has to know which fields mean
 * anything for which kind.
 */
export interface ProductRateRecord {
  id: string
  productName: string
  /** Blank means the row prices this product whatever model a line names. */
  productModel: string
  capacity: string
  rates: Record<LocationType, Rate | null>
  isActive: boolean
  /** True for a row from the supplied card rather than one an Admin added. */
  isSeeded: boolean
  createdBy: ActorRef | null
  updatedBy: ActorRef | null
  createdAt: string
  updatedAt: string
}

export interface ActorRef {
  id: string
  name: string
}

/**
 * A product name the entry form may offer, and what the card knows about it.
 *
 * Deliberately narrower than a full record: the operator has pasted a model
 * and is choosing a product name, and three rate columns at that moment are
 * noise. The capacity comes along because it is what tells two otherwise
 * identical refrigerator rows apart.
 */
export interface ModelMatch {
  id: string
  productName: string
  productModel: string
  capacity: string
}

function actorFrom(
  id: Types.ObjectId | null | undefined,
  names: Map<string, string>,
): ActorRef | null {
  if (!id) {
    return null
  }
  const key = String(id)
  return { id: key, name: names.get(key) ?? 'Removed account' }
}

export function toProductRateRecord(
  rate: ProductRateDocument,
  actorNames: Map<string, string>,
): ProductRateRecord {
  return {
    id: String(rate._id),
    productName: rate.productName,
    productModel: rate.productModel,
    capacity: rate.capacity,
    rates: {
      ISD: toRate(rate.rates?.ISD),
      'OSD-Metro': toRate(rate.rates?.['OSD-Metro']),
      'OSD-Thana': toRate(rate.rates?.['OSD-Thana']),
    },
    isActive: rate.isActive,
    isSeeded: rate.isSeeded,
    createdBy: actorFrom(rate.createdBy, actorNames),
    updatedBy: actorFrom(rate.updatedBy, actorNames),
    createdAt: rate.createdAt.toISOString(),
    updatedAt: rate.updatedAt.toISOString(),
  }
}

export function toModelMatch(rate: ProductRateDocument): ModelMatch {
  return {
    id: String(rate._id),
    productName: rate.productName,
    productModel: rate.productModel,
    capacity: rate.capacity,
  }
}
