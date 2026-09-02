import { Router } from 'express'
import { auth } from '../../middlewares/auth'
import { requireDb } from '../../middlewares/require-db'
import { validateRequest } from '../../middlewares/validate-request'
import { getMe, syncUser } from './user.controller'
import { syncUserSchema } from './user.validation'

const router = Router()

// requireDb runs before auth: auth itself reads the profile from MongoDB.
router.post('/sync', requireDb, auth, validateRequest({ body: syncUserSchema }), syncUser)
router.get('/me', requireDb, auth, getMe)

export const userRoutes = router
