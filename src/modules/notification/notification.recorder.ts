import type { Types } from 'mongoose'
import type { UserDocument } from '../user/user.model'
import { resolveAudience, selectRecipients, withoutMuted } from './notification.audience'
import type { Audience } from './notification.audience'
import { notificationEventMeta } from './notification.constants'
import type { NotificationEntityType, NotificationEvent } from './notification.constants'
import { NotificationModel } from './notification.model'

/**
 * The one seam every module announces through.
 *
 * There is exactly one of these, for the reason there is exactly one
 * `recordActivity`: each module owns its own permissions, vocabulary and rules,
 * but "who needs to be told" is a single question with a single answer, and a
 * second fan-out is how the two come to disagree about whether the actor hears
 * about their own work.
 *
 * It is deliberately shaped like `recordActivity` down to the argument names,
 * so the two sit beside each other at a call site and read as one decision:
 * *record what happened, then tell whoever is waiting on it.*
 */

export interface NotifyInput {
  event: NotificationEvent
  /** Who to tell. Never a role list inline — use the sets in the constants. */
  audience: Audience
  /** One line. The sentence a person reads first. */
  title: string
  /** The line under it, where there is more to say. */
  body?: string

  /** What it is about. The label is a copy, so the row survives a deletion. */
  entityType?: NotificationEntityType
  entityId?: Types.ObjectId | string | null
  entityLabel?: string

  /**
   * Who caused it. Omitted by the compliance sweep, because a certificate
   * expiring is the calendar rather than a person — and because an invented
   * actor in a message somebody acts on is worse than no actor at all.
   *
   * When present, they are **excluded from their own announcement**.
   */
  actor?: UserDocument

  /**
   * What makes a repeated announcement the same announcement. Only the sweep
   * sets it; see the field's comment on the model for why an event-driven row
   * must not.
   */
  groupKey?: string
}

/** A duplicate `groupKey` is the sweep working, not the sweep failing. */
const DUPLICATE_KEY = 11000

function isDuplicateKeyOnly(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const { code, writeErrors } = error as {
    code?: number
    writeErrors?: { err?: { code?: number }; code?: number }[]
  }

  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    return writeErrors.every((entry) => (entry.err?.code ?? entry.code) === DUPLICATE_KEY)
  }

  return code === DUPLICATE_KEY
}

/**
 * Fans one event out to its audience, and **never throws**.
 *
 * That is the whole contract, and it is inherited verbatim from
 * `recordActivity`. A failure to announce must not fail the write it was
 * announcing: a gate pass that was submitted and not announced is a badge
 * reading one lower, and a gate pass *refused* because the fan-out failed is
 * an operator standing at a gate.
 *
 * What makes the asymmetry safe is that nothing in this system branches on a
 * notification. No service reads the collection to decide anything; it is read
 * by people, in a panel and on a page.
 *
 * It is deliberately **not** part of any transaction, for the same reason. A
 * trip's two-document write is atomic; whether anybody was told is not part of
 * that atomicity, and joining the session would make a fan-out failure roll
 * back the work it was describing.
 *
 * Three things happen in order, and the order is the design:
 *
 * 1. the audience is resolved to ids,
 * 2. the actor is removed and duplicates collapsed — so nobody is told what
 *    they just did, and nobody is told twice,
 * 3. anyone who has muted the category is dropped, because a row never written
 *    is a row that cannot disagree with its own unread count.
 *
 * A message with nobody left to receive it writes nothing, which is the common
 * case for a one-person office doing its own reviewing.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const meta = notificationEventMeta(input.event)

    const candidates = await resolveAudience(input.audience)
    const recipients = selectRecipients(
      candidates,
      input.actor ? String(input.actor._id) : null,
    )

    const audience = await withoutMuted(recipients, meta.category)

    if (audience.length === 0) {
      return
    }

    const base = {
      event: input.event,
      title: input.title.slice(0, 160),
      body: (input.body ?? '').slice(0, 400),
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      entityLabel: (input.entityLabel ?? '').slice(0, 160),
      /**
       * The copies. Taken here rather than at read time so a deleted account
       * does not blank what it did, and so the role reads as the one held when
       * they did it — the treatment `recordActivity` gives an actor.
       */
      actorId: input.actor?._id ?? null,
      actorName: input.actor?.name ?? '',
      actorRole: input.actor?.role ?? '',
      readAt: null,
      groupKey: input.groupKey ?? null,
    }

    /**
     * `ordered: false` so one recipient who already holds this `groupKey` does
     * not stop the rest of the fan-out — the arrangement the legacy activity
     * fold uses, and for the same reason: there is no state to keep beyond the
     * keys themselves.
     */
    await NotificationModel.insertMany(
      audience.map((recipientId) => ({ ...base, recipientId })),
      { ordered: false },
    )
  } catch (error) {
    if (isDuplicateKeyOnly(error)) {
      // Every row was already delivered under this group key. Nothing to say.
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[notification] not delivered (${input.event}): ${message}`)
  }
}
