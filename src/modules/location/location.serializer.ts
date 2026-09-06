import type { Types } from 'mongoose'
import type { LocationType } from './location.constants'
import type { LocationMasterDocument } from './location.model'

/**
 * One master location, as a client sees it.
 *
 * The normalised comparison values are not here. They are a lookup mechanism
 * with no meaning outside the resolver, and putting them on the wire would
 * invite something to start matching on them client-side — which is exactly
 * the split brain the master collection exists to prevent.
 */
export interface LocationRecord {
  id: string
  district: string
  thana: string
  locationType: LocationType
  isActive: boolean
  /** True for a row that came from the supplied master list rather than an Admin. */
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

export function toLocationRecord(
  location: LocationMasterDocument,
  actorNames: Map<string, string>,
): LocationRecord {
  return {
    id: String(location._id),
    district: location.district,
    thana: location.thana,
    locationType: location.locationType as LocationType,
    isActive: location.isActive,
    isSeeded: location.isSeeded,
    createdBy: actorFrom(location.createdBy, actorNames),
    updatedBy: actorFrom(location.updatedBy, actorNames),
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  }
}
