import { Types } from 'mongoose'
import type { UserRole } from '../user/user.constants'
import { UserModel } from '../user/user.model'
import { MAX_NOTIFICATION_FANOUT, MUTABLE_CATEGORIES } from './notification.constants'
import type { NotificationCategory } from './notification.constants'
import { NotificationPreferenceModel } from './notification-preference.model'

/**
 * Who gets told, and who does not.
 *
 * Two kinds of audience and no third, because a third would be a way to
 * address a message at something other than a person:
 *
 * - **`roles`** — every *active* account holding one of these roles. Resolved
 *   at write time, so who was told is a fact about the moment rather than a
 *   query that would answer differently next month.
 * - **`user`** — one account, by id. What "your gate pass was sent back" and
 *   "your account has been suspended" both are.
 *
 * The one rule both share is the exclusion of the actor, and it is not a
 * nicety: a system that tells you what you have just done is one whose badge
 * is always lit, and a badge that is always lit is a badge nobody reads.
 */

export type Audience =
  | { kind: 'roles'; roles: readonly UserRole[] }
  | { kind: 'user'; userId: Types.ObjectId | string }

/**
 * The recipients of one message, as ids, with the actor taken out and
 * duplicates collapsed.
 *
 * Pure, and tested as decisions — everything above it is a database read and
 * everything below it is an insert, so this is the only part with a rule in
 * it. Ids arrive as strings because that is the only form two of them can be
 * compared in: `ObjectId` equality is not `===`, and a fan-out that deduped
 * with `===` would tell an Admin twice about an account they hold two paths to.
 */
export function selectRecipients(
  candidateIds: readonly string[],
  excludeId: string | null,
): string[] {
  const seen = new Set<string>()

  for (const id of candidateIds) {
    if (!id || id === excludeId) {
      continue
    }
    seen.add(id)
  }

  return [...seen].slice(0, MAX_NOTIFICATION_FANOUT)
}

/**
 * Whether a category is one this person has switched off.
 *
 * Reads the stored list through `MUTABLE_CATEGORIES`, so a value that *is*
 * stored but may not be muted — `account`, today — is ignored rather than
 * honoured. That is what makes "you cannot opt out of being told your account
 * was suspended" a property of the system rather than of whichever form last
 * wrote the preference.
 */
export function isMuted(
  category: NotificationCategory,
  mutedCategories: readonly string[],
): boolean {
  if (!(MUTABLE_CATEGORIES as readonly string[]).includes(category)) {
    return false
  }
  return mutedCategories.includes(category)
}

/**
 * The accounts behind an audience.
 *
 * **A role audience is Active accounts only.** A Pending account has not been
 * approved and a Suspended one is locked out, so addressing either would pile
 * up a backlog behind a door nobody can open — and in the Suspended case, would
 * tell somebody the operation's business after they have been shut out of it.
 *
 * **A named recipient is not filtered**, and the difference is deliberate: the
 * messages addressed to one person are about *their own account*, and the whole
 * point of "your account has been suspended" is that it reaches an account that
 * is suspended. It waits for them if the decision is ever reversed, which is the
 * honest shape when the alternative is saying nothing at all.
 *
 * The projection is `_id` alone. This runs on the write path of an ordinary
 * operator action, so it has to stay one indexed read of one small field.
 */
export async function resolveAudience(audience: Audience): Promise<string[]> {
  if (audience.kind === 'user') {
    return [String(audience.userId)]
  }

  if (audience.roles.length === 0) {
    return []
  }

  const accounts = await UserModel.find({
    role: { $in: audience.roles },
    status: 'Active',
  })
    .select('_id')
    .limit(MAX_NOTIFICATION_FANOUT)
    .lean()

  return accounts.map((account) => String(account._id))
}

/**
 * The recipients who have not muted this category.
 *
 * **Muting is applied at delivery, not at read time**, which is the one thing
 * about it worth stating out loud. A row that was never written costs nothing
 * to count, to page through or to keep for ninety days, whereas filtering on
 * the way out would mean the unread count and the list disagreeing with each
 * other the moment somebody changed a switch. The price is that switching a
 * category back on does not retrieve what was missed while it was off — which
 * is the honest behaviour for a mute, and is what the preferences page says.
 *
 * One query for the whole fan-out rather than one per recipient: preferences
 * are rare documents, so this usually reads nothing at all.
 */
export async function withoutMuted(
  recipientIds: readonly string[],
  category: NotificationCategory,
): Promise<string[]> {
  if (recipientIds.length === 0 || !(MUTABLE_CATEGORIES as readonly string[]).includes(category)) {
    return [...recipientIds]
  }

  const muted = await NotificationPreferenceModel.find({
    userId: { $in: recipientIds.map((id) => new Types.ObjectId(id)) },
    mutedCategories: category,
  })
    .select('userId')
    .lean()

  if (muted.length === 0) {
    return [...recipientIds]
  }

  const mutedIds = new Set(muted.map((row) => String(row.userId)))
  return recipientIds.filter((id) => !mutedIds.has(id))
}

/** What this person has switched off, with anything unmutable dropped. */
export async function mutedCategoriesOf(
  userId: Types.ObjectId | string,
): Promise<NotificationCategory[]> {
  const preference = await NotificationPreferenceModel.findOne({ userId }).lean()

  if (!preference) {
    return []
  }

  return (preference.mutedCategories as NotificationCategory[]).filter((category) =>
    (MUTABLE_CATEGORIES as readonly string[]).includes(category),
  )
}
