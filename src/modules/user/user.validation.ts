import * as z from 'zod'

/**
 * Body accepted by POST /users/sync. Deliberately narrow: `role` and `status`
 * are absent, so a client cannot promote itself by sending extra fields.
 */
export const syncUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80).optional(),
  photoUrl: z.url('photoUrl must be a valid URL').optional(),
})

export type SyncUserInput = z.infer<typeof syncUserSchema>
