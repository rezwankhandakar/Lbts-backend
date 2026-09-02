import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import type { Auth } from 'firebase-admin/auth'
import { config } from './index'

let authInstance: Auth | undefined

/**
 * Lazily initialises the Admin SDK once per process. Called on the first
 * authenticated request rather than at startup, so the server still boots (and
 * /health still answers) if the Firebase credentials are missing or wrong.
 */
export function getFirebaseAuth(): Auth {
  if (authInstance) {
    return authInstance
  }

  const existing = getApps()[0]
  const app =
    existing ??
    initializeApp({
      credential: cert({
        projectId: config.firebase.projectId,
        clientEmail: config.firebase.clientEmail,
        privateKey: config.firebase.privateKey,
      }),
    })

  authInstance = getAuth(app)
  return authInstance
}
