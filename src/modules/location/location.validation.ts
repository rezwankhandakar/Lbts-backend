import * as z from 'zod'
import { LOCATION_TYPES, MAX_LOCATION_PAGE_SIZE } from './location.constants'

/** Mongo ObjectId as it arrives in a URL or a body. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

export const locationIdParamSchema = z.object({ id: objectId })

function name(label: string) {
  return z
    .string()
    .trim()
    .min(2, `${label} must be at least 2 characters`)
    .max(120, `${label} must be 120 characters or fewer`)
}

/**
 * A master location, as an Admin enters it.
 *
 * `normalizedDistrict` and `normalizedThana` are deliberately absent. They are
 * derived from these two by the service, exactly as `customerNameKey` is on a
 * challan — a client that could set a comparison key could make a row match
 * something it does not say, which is the one way this collection could lie.
 *
 * The location type is an enum rather than a string for the same reason the
 * entry form has no field for it: the classification belongs to the pair, and
 * a free-text value would put a fourth kind of place into a system that
 * recognises three.
 */
const locationFields = {
  district: name('District'),
  thana: name('Thana'),
  locationType: z.enum(LOCATION_TYPES, {
    error: 'Choose a location type.',
  }),
  /**
   * Undefaulted here on purpose. `updateLocationSchema` is built by making
   * these optional and then refusing a body that changes nothing — and a
   * default would quietly fill this in, so an empty request would look like a
   * request to activate the row.
   */
  isActive: z.boolean(),
}

export const createLocationSchema = z.object({
  ...locationFields,
  // A new row is usable unless it is explicitly not.
  isActive: locationFields.isActive.default(true),
})
export type CreateLocationInput = z.infer<typeof createLocationSchema>

/**
 * Correcting one.
 *
 * Every field optional, because the three reasons to edit a row are
 * independent: a misspelled thana, a wrong classification, and taking a row
 * out of use. `.partial()` over the same object, so the rules cannot drift
 * from the create ones.
 */
export const updateLocationSchema = z
  .object(locationFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to change.',
  })
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>

/**
 * What narrows the master list.
 *
 * `active` is a three-way filter rather than a boolean, because "show me the
 * deactivated ones" is a real question — it is how somebody finds a row they
 * turned off by mistake.
 */
export const listLocationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LOCATION_PAGE_SIZE).default(20),
  search: z.string().trim().max(160).default(''),
  district: z.string().trim().max(120).default(''),
  locationType: z.enum(['all', ...LOCATION_TYPES]).default('all'),
  active: z.enum(['all', 'active', 'inactive']).default('all'),
})
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>

/**
 * The cascading selector's two reads: every district, and the active thanas of
 * one of them. A district is required for the second, because the whole point
 * of the cascade is that a thana is only meaningful inside one.
 */
export const thanaQuerySchema = z.object({
  district: z.string().trim().min(1, 'Choose a district first.').max(120),
})
export type ThanaQuery = z.infer<typeof thanaQuerySchema>

/**
 * Asking what a piece of challan text resolves to, before anything is filed.
 *
 * Deliberately narrow: the three values that decide a location and nothing
 * else. A customer name and a phone number would tell the resolver nothing it
 * could use, and this is the request that may end up in front of a language
 * model.
 */
export const resolveLocationSchema = z.object({
  thana: z.string().trim().max(120).default(''),
  district: z.string().trim().max(120).default(''),
  deliveryAddress: z.string().trim().max(500).default(''),
})
export type ResolveLocationInput = z.infer<typeof resolveLocationSchema>

/**
 * Setting a challan's location by hand.
 *
 * `null` is a legitimate value and means "unset this" — a location put on the
 * wrong record has to be removable, and removing it returns the challan to
 * Pending rather than to some third state.
 */
export const setChallanLocationSchema = z.object({
  locationId: z.union([objectId, z.null()]),
})
export type SetChallanLocationInput = z.infer<typeof setChallanLocationSchema>
