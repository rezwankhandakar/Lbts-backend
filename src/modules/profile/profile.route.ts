import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { auth, requireActiveAccount } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { uploadProfilePhoto } from '../../middlewares/upload'
import { validateRequest } from '../../middlewares/validate-request'
import { deleteProfilePhoto, patchProfile, putProfilePhoto } from './profile.controller'
import { updateProfileSchema } from './profile.validation'

const router = Router()

/**
 * The account owner's own profile. Reading it is still GET /users/me — this
 * module deliberately adds no second read endpoint, so there is exactly one
 * shape of "the signed-in user" and one place it comes from.
 *
 * Order matters, and matches the rest of the API: requireDb first, because
 * auth reads the profile from MongoDB; then auth, which verifies the Firebase
 * ID token; then requireActiveAccount, because a Pending or Suspended account
 * may see why it is locked out but may not change anything.
 *
 * There is deliberately no requireRole. Every role administers their own
 * account, and nothing reachable from here can touch role or status — see
 * profile.validation.ts.
 */
router.use(requireDb, auth, requireActiveAccount)

router.patch('/', validateRequest({ body: updateProfileSchema }), patchProfile)

/**
 * Tighter than the global API limit. An upload costs a Cloudinary
 * transformation and free-tier bandwidth, so it gets its own budget: generous
 * for anyone adjusting their photo, useless for anyone burning quota.
 */
const photoUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many photo uploads. Please try again in a few minutes.',
    errorSources: [{ path: 'photo', message: 'Upload rate limit exceeded.' }],
  },
})

router.post('/photo', photoUploadLimiter, uploadProfilePhoto, putProfilePhoto)
router.delete('/photo', deleteProfilePhoto)

export const profileRoutes = router
