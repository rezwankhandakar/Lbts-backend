import type { Types } from 'mongoose'
import type { UserDocument } from '../user/user.model'
import { MAX_ACTIVITY_CHANGES } from './activity.constants'
import type { ActivityAction, ActivityEntityType } from './activity.constants'
import type { ActivityChange } from './activity.diff'
import { ActivityModel } from './activity.model'

/**
 * The one seam every module writes the journal through.
 *
 * There is exactly one of these on purpose. Each module owns its own
 * permissions, its own vocabulary and its own rules — CLAUDE.md is explicit
 * that there is no central matrix — but "what happened, and who did it" is a
 * single question with a single answer, and a second journal is how the two
 * come to disagree about what a deletion looks like.
 */

export interface ActivityInput {
  action: ActivityAction
  entityType: ActivityEntityType
  entityId?: Types.ObjectId | string | null
  /** A copy, not a reference — the row still has to read after a deletion. */
  entityLabel?: string
  summary: string
  /** Field-level detail, where the caller had a before and an after. */
  changes?: readonly ActivityChange[]
  /** The vendor a row belongs to, where it belongs to one. */
  vendorId?: Types.ObjectId | string | null
  actor: UserDocument
}

/**
 * Appends one entry, and **never throws**.
 *
 * That is the whole contract, and it is inherited verbatim from the vendor
 * journal this collection grew out of. A failure to log must not fail the
 * write it was logging, because the write is the thing that mattered — a
 * vehicle that was added and not journalled is a gap in a list, and a vehicle
 * refused because the journal was down is an operator who cannot work.
 *
 * What makes the asymmetry safe is that nothing in this system branches on a
 * row. No service reads the journal to decide anything; it is read by people,
 * on one page, and by the vendor workspace's own tab.
 *
 * It is deliberately **not** part of any transaction, for the same reason.
 * A trip's two-document write is atomic; whether it was journalled is not part
 * of that atomicity, and joining the session would make a journal failure roll
 * back the work it was describing.
 */
export async function recordActivity(input: ActivityInput): Promise<void> {
  try {
    await ActivityModel.create({
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityLabel: (input.entityLabel ?? '').slice(0, 160),
      summary: input.summary.slice(0, 300),
      changes: (input.changes ?? []).slice(0, MAX_ACTIVITY_CHANGES).map((change) => ({
        field: change.field.slice(0, 80),
        label: change.label.slice(0, 80),
        from: change.from === null ? null : change.from.slice(0, 400),
        to: change.to === null ? null : change.to.slice(0, 400),
      })),
      actorId: input.actor._id,
      /**
       * The copies. Taken here rather than at read time so a deleted account
       * does not blank its own history, and so the role is the one the actor
       * held when they did it rather than the one they hold now.
       */
      actorName: input.actor.name,
      actorRole: input.actor.role,
      scopeVendorId: input.vendorId ?? null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[activity] entry not recorded (${input.action}): ${message}`)
  }
}
