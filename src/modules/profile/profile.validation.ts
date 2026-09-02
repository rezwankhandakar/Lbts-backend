import * as z from 'zod'

/**
 * Loose on formatting, strict on shape: the business spans countries, so a
 * number is accepted with or without a country code, spaces, dashes or
 * brackets — but nothing else gets through.
 */
const PHONE_PATTERN = /^\+?[0-9][0-9\s()-]{5,23}$/

/**
 * Everything the account owner may change about themselves — and nothing else.
 *
 * `role`, `status` and `email` are absent by construction, exactly as they are
 * in syncUserSchema. A crafted body carrying them is not rejected so much as
 * ignored: there is no path from this schema to those fields at all.
 */
export const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Name must be at least 2 characters')
    .max(80, 'Name must be 80 characters or fewer'),
  /**
   * Optional, and an empty string is how the client clears it. The service
   * turns that into null, so "no phone number" has exactly one representation
   * in MongoDB rather than two.
   */
  phone: z
    .string()
    .trim()
    .max(24, 'Phone number must be 24 characters or fewer')
    .refine((value) => value.length === 0 || PHONE_PATTERN.test(value), {
      message: 'Enter a valid phone number, for example +880 1712 345678',
    })
    .default(''),
})

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
