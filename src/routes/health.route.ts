import { Router } from 'express'
import { getConnectionState, isDatabaseConnected } from '../config/db'
import { sendResponse } from '../utils/send-response'

const router = Router()

/**
 * Liveness probe. Deliberately cheap — no database round trip — because
 * Render's free tier spins the service down after ~15 minutes idle and this is
 * the endpoint a warm-up ping hits.
 *
 * It returns 200 whenever the process is alive, even while MongoDB is
 * disconnected, and reports the connection state in the body instead. A 503
 * here would make Render's health check kill the service during a database
 * blip — the exact failure that starting the listener before connecting is
 * meant to prevent. Callers that need the database get their 503 from the
 * requireDb middleware, not from here.
 */
router.get('/', (_req, res) => {
  sendResponse(res, {
    statusCode: 200,
    message: 'API is healthy',
    data: {
      uptime: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
      database: {
        state: getConnectionState(),
        connected: isDatabaseConnected(),
      },
    },
  })
})

export const healthRoutes = router
