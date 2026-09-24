import type { UserRole } from '../user/user.constants'

/**
 * The notification system's vocabulary.
 *
 * CLAUDE.md listed the same gap twice, in two different places: "the attention
 * list is not a notification — it is read when somebody opens the dashboard
 * and at no other time", and "nothing warns them anywhere else — there is no
 * email, no badge on the sidebar and no notification, so an Admin who never
 * opens the dashboard still learns about a waiting account only by going to
 * look". This module is what those sentences were waiting for.
 *
 * It is deliberately the **activity journal's sibling rather than its second
 * copy**, and the difference between the two is the idea the whole module
 * turns on:
 *
 * - The journal answers *what happened*. One row per event, addressed to
 *   nobody, read by whoever opens the page, and it may never be deleted.
 * - A notification answers *what somebody needs to be told*. One row per
 *   **recipient**, carrying a read state that belongs to that person alone,
 *   and they may dismiss it — because a message somebody has dealt with and
 *   cannot clear is a message that teaches them to ignore the next one.
 *
 * So a notification is not an audit record and must never be relied on as one.
 * Everything worth keeping is already in the journal; this collection expires.
 *
 * Three rules run through all of it, and the first two are inherited verbatim
 * from `recordActivity`:
 *
 * 1. **Nothing branches on a notification.** No service reads this collection
 *    to decide anything, which is what makes `notify` safe to never throw. A
 *    write that happened and was not announced is a badge reading one lower; a
 *    write refused because a fan-out failed is an operator who cannot work.
 * 2. **A row is a sentence, and it has to still read once its subject is
 *    gone.** The entity's label and the actor's name and role are copies.
 * 3. **A recipient is resolved on the way in, never on the way out.** Who was
 *    told is a fact about the moment, so the fan-out happens at write time: a
 *    later role change never retro-addresses an old message, nor hands one to
 *    somebody who has since been promoted into its audience.
 */

// --- What somebody is told about --------------------------------------------

/**
 * Every event, grouped by the part of the system that announces it.
 *
 * A closed set, for the reason `SUGGESTION_FIELDS` is one in Gate Pass: these
 * values are read straight back out of the collection into a filter, so an
 * open one would be a way to ask questions nobody designed. The flat list
 * below is built from the groups, so an event can never be added to one and
 * missed by the other.
 *
 * **The set is deliberately small.** This is not "every write, announced" —
 * the journal is already that, and a bell that rings for two hundred filed
 * challans is a bell nobody looks at. What is here is the handful of moments
 * where somebody is *waiting* on something, or where something has quietly
 * gone wrong and nobody is looking at the page that would show it.
 */
export const NOTIFICATION_EVENT_GROUPS = {
  Account: [
    'account.pending',
    'account.approved',
    'account.rejected',
    'account.suspended',
    'account.role-changed',
  ],
  'Gate Pass': ['gate-pass.submitted', 'gate-pass.verified', 'gate-pass.rejected'],
  Delivery: ['delivery.goods-returned', 'delivery.copy-missing'],
  Vendor: ['vendor.document-expiring', 'vendor.document-expired'],
  Billing: ['bill.finalized', 'labour-bill.finalized'],
  Accounts: ['accounts.vendor-paid'],
} as const satisfies Record<string, readonly string[]>

export type NotificationModule = keyof typeof NOTIFICATION_EVENT_GROUPS

/** The modules, in the order they are declared above. */
export const NOTIFICATION_MODULES = Object.keys(NOTIFICATION_EVENT_GROUPS) as NotificationModule[]

type EventsOf<M extends NotificationModule> = (typeof NOTIFICATION_EVENT_GROUPS)[M][number]
export type NotificationEvent = { [M in NotificationModule]: EventsOf<M> }[NotificationModule]

/** Flattened, because a Zod enum wants one list. */
export const NOTIFICATION_EVENTS: NotificationEvent[] = NOTIFICATION_MODULES.flatMap(
  (module) => NOTIFICATION_EVENT_GROUPS[module] as readonly NotificationEvent[],
)

/**
 * What *kind* of thing a message is — which is what somebody mutes, and what
 * the panel groups by when a list is long.
 *
 * Categories rather than events, because muting is a decision about a kind of
 * interruption ("stop telling me about compliance") and never about one
 * particular sentence. Fourteen switches is a preferences page nobody finishes
 * reading; six is one somebody actually sets.
 */
export const NOTIFICATION_CATEGORIES = [
  /** Something is waiting for this person to decide. */
  'approvals',
  /** A verdict on somebody's work, or work that wants reviewing. */
  'review',
  /** Paper or a certificate that has lapsed, or is about to. */
  'compliance',
  /** The day's operating facts — what moved, what came back. */
  'operations',
  /** Money: a bill signed off, a vendor paid. */
  'money',
  /** This person's own account. */
  'account',
] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/**
 * The categories somebody may switch off.
 *
 * **`account` is not among them, and that is a rule rather than an oversight.**
 * Being told that your own account has been suspended, or that your role has
 * changed, is the one message this system may not let a person opt out of — an
 * account that silently stops working is a support call, and one whose owner
 * was told is a Tuesday.
 */
export const MUTABLE_CATEGORIES: readonly NotificationCategory[] = NOTIFICATION_CATEGORIES.filter(
  (category) => category !== 'account',
)

export function isMutableCategory(value: string): value is NotificationCategory {
  return (MUTABLE_CATEGORIES as readonly string[]).includes(value)
}

/**
 * How loudly a message asks to be read.
 *
 * `urgent` is about being **hard to undo or already wrong** rather than about
 * volume — the rule `ACTIVITY_SEVERITIES` follows, and `attention.ts` on the
 * dashboard. An expired certificate on a lorry that is out today is urgent; a
 * bill being signed off is a Tuesday.
 */
export const NOTIFICATION_PRIORITIES = ['info', 'attention', 'urgent'] as const
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number]

/** The kinds of record a message can point at. */
export const NOTIFICATION_ENTITY_TYPES = [
  'User',
  'GatePass',
  'Challan',
  'Trip',
  'Vendor',
  'Vehicle',
  'Driver',
  'Document',
  'Bill',
  'LabourBill',
  'AccountsEntry',
] as const
export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number]

export interface NotificationEventMeta {
  module: NotificationModule
  category: NotificationCategory
  priority: NotificationPriority
  /** A short noun phrase for the event, drawn as the row's kicker. */
  label: string
}

/**
 * The whole of what an event *means*, derived and never stored.
 *
 * Module, category and priority are read out of this map at serialisation
 * rather than written onto the row — the treatment `ACTION_META` gives a
 * journal row, `documentStatusFor` gives a compliance document and
 * `completionMethodFor` gives a delivery. A stored copy is a second answer a
 * later change can make disagree with the first, and deciding an expiring
 * certificate deserves `urgent` after all must not mean a migration.
 *
 * Filtering by module, category or priority therefore resolves to an `$in`
 * over events, which the `{ recipientId, event, createdAt }` index answers.
 */
export const NOTIFICATION_EVENT_META: Record<NotificationEvent, NotificationEventMeta> = {
  // --- The account itself. ---
  'account.pending': {
    module: 'Account',
    category: 'approvals',
    priority: 'attention',
    label: 'Account waiting for approval',
  },
  'account.approved': {
    module: 'Account',
    category: 'account',
    priority: 'info',
    label: 'Account approved',
  },
  'account.rejected': {
    module: 'Account',
    category: 'account',
    priority: 'attention',
    label: 'Account request declined',
  },
  'account.suspended': {
    module: 'Account',
    category: 'account',
    priority: 'urgent',
    label: 'Account suspended',
  },
  'account.role-changed': {
    module: 'Account',
    category: 'account',
    priority: 'attention',
    label: 'Role changed',
  },

  // --- Gate Pass review: the one place in the app with two sides to a verdict. ---
  'gate-pass.submitted': {
    module: 'Gate Pass',
    category: 'review',
    priority: 'info',
    label: 'Gate pass submitted for review',
  },
  'gate-pass.verified': {
    module: 'Gate Pass',
    category: 'review',
    priority: 'info',
    label: 'Gate pass verified',
  },
  'gate-pass.rejected': {
    module: 'Gate Pass',
    category: 'review',
    priority: 'attention',
    label: 'Gate pass sent back',
  },

  // --- Delivery. ---
  /**
   * Goods that came back off a lorry are the one *operating* fact in this
   * system that nothing else surfaces in time to act on. The challan goes back
   * to `Pending` and the pieces sit on the depot shelf waiting for the next
   * trip — which is a decision somebody makes tomorrow morning, and only if
   * they know. The Challan records list can be filtered to find them, but that
   * is a question somebody has to think to ask.
   */
  'delivery.goods-returned': {
    module: 'Delivery',
    category: 'operations',
    priority: 'attention',
    label: 'Goods returned to depot',
  },
  /**
   * A signed copy declared lost is the other delivery event worth announcing: it
   * closes a delivery on somebody's word rather than on paper, and the people
   * who would want to know are precisely not the operator who declared it.
   */
  'delivery.copy-missing': {
    module: 'Delivery',
    category: 'compliance',
    priority: 'attention',
    label: 'Signed copy declared missing',
  },

  // --- Vendor compliance, from the sweep rather than from a request. ---
  'vendor.document-expiring': {
    module: 'Vendor',
    category: 'compliance',
    priority: 'attention',
    label: 'Document expiring soon',
  },
  'vendor.document-expired': {
    module: 'Vendor',
    category: 'compliance',
    priority: 'urgent',
    label: 'Document expired',
  },

  // --- Billing and money. ---
  'bill.finalized': {
    module: 'Billing',
    category: 'money',
    priority: 'info',
    label: 'Excel bill finalized',
  },
  'labour-bill.finalized': {
    module: 'Billing',
    category: 'money',
    priority: 'info',
    label: 'Labour bill finalized',
  },
  /**
   * Accounts is the one module where `Admin` cannot write — the business's
   * rule, stated as such in CLAUDE.md. The consequence is that the roles who
   * *read* the books and never touch them have no way of learning a vendor was
   * paid short of going to look. So they are told.
   */
  'accounts.vendor-paid': {
    module: 'Accounts',
    category: 'money',
    priority: 'info',
    label: 'Vendor payment recorded',
  },
}

/**
 * Degrades to a neutral reading rather than throwing.
 *
 * The event is stored as a plain string rather than a Mongoose enum — the
 * departure `activity.model.ts` makes, for the same reason: Mongoose validates
 * the *whole* document on save, and an event retired next year would make an
 * unread row written this year unsaveable. The set stays closed where it
 * matters: `notify` only ever passes a typed event, and the validation layer
 * refuses an unknown one on the way in.
 */
const UNKNOWN_EVENT: NotificationEventMeta = {
  module: 'Account',
  category: 'operations',
  priority: 'info',
  label: 'Notification',
}

export function notificationEventMeta(event: string): NotificationEventMeta {
  return NOTIFICATION_EVENT_META[event as NotificationEvent] ?? UNKNOWN_EVENT
}

export function eventsOfModule(module: NotificationModule): NotificationEvent[] {
  return NOTIFICATION_EVENTS.filter((event) => NOTIFICATION_EVENT_META[event].module === module)
}

export function eventsOfCategory(category: NotificationCategory): NotificationEvent[] {
  return NOTIFICATION_EVENTS.filter((event) => NOTIFICATION_EVENT_META[event].category === category)
}

export function eventsOfPriority(priority: NotificationPriority): NotificationEvent[] {
  return NOTIFICATION_EVENTS.filter((event) => NOTIFICATION_EVENT_META[event].priority === priority)
}

// --- Limits ------------------------------------------------------------------

export const MAX_NOTIFICATION_PAGE_SIZE = 100
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20

/**
 * How many rows the header panel holds.
 *
 * Small on purpose. The panel is a glance — "is there anything?" — and the
 * page is where a backlog is worked. A panel that scrolls is a page somebody
 * has put in a box.
 */
export const PANEL_NOTIFICATION_LIMIT = 8

/**
 * The ceiling on one fan-out.
 *
 * A role audience is every active account holding one of a handful of roles,
 * which at this operation is a dozen people and could not plausibly be a
 * thousand. The cap exists so a misconfigured audience cannot turn one gate
 * pass submission into a collection scan's worth of inserts on an M0 cluster —
 * it is a fuse, not a policy.
 */
export const MAX_NOTIFICATION_FANOUT = 200

/**
 * How long a row is kept, as a TTL index on `createdAt`.
 *
 * Ninety days, and far shorter than the journal's two years **on purpose**. A
 * notification is a message rather than a record: everything it announces is
 * already in the activity journal, permanently and addressed to nobody, so
 * expiring these costs no history at all. What it buys is the one thing an M0
 * cluster cannot do without — a bound on the collection that grows fastest,
 * because this is the only one in the system that writes a row *per person*
 * per event.
 *
 * Set to 0 to keep everything. `syncNotificationIndexes` drops the TTL index
 * when it is, and rebuilds it at the right length whenever this changes:
 * MongoDB will not alter an existing TTL index's expiry on its own, which is
 * exactly the trap `syncActivityIndexes` and `syncDeliveryIndexes` exist for.
 */
export const NOTIFICATION_RETENTION_DAYS = 90

/**
 * How often the compliance sweep runs.
 *
 * Six hours rather than nightly, because Render's free tier spins the instance
 * down after fifteen minutes of inactivity, and a cron-shaped assumption about
 * a process that is usually asleep would simply never fire. The sweep is
 * idempotent — every row it writes carries a `groupKey` under a unique index —
 * so running it more often than strictly needed costs one query and writes
 * nothing, which is the right trade when the alternative is not running at
 * all. See `notification.compliance.ts`.
 */
export const COMPLIANCE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

// --- Permissions --------------------------------------------------------------

/**
 * There is no read role set and no write role set, and that is this module's
 * whole security model.
 *
 * **Every route here reads `req.user._id` and nothing else.** No endpoint takes
 * a user id, so there is nothing in any URL for a request to aim at somebody
 * else's inbox — the shape the Profile module uses, and for the same reason:
 * ownership enforced by the shape of the module rather than by a check inside
 * it. Every active account of every role, `Vendor` included, reads its own.
 *
 * What keeps a Vendor account out of the operating modules is the *audience*,
 * decided at fan-out time: a vendor is in no audience but its own account's,
 * so a message about a challan is never addressed to one in the first place.
 * That is stronger than a filter on the way out, because a row that does not
 * exist cannot leak.
 *
 * The sets below are the narrower question — who may be *told* — and each one
 * mirrors the read audience of the module whose figures it would carry. A
 * notification quoting an amount to somebody who may not read amounts would be
 * a leak by announcement.
 */

/** Who hears that an account is waiting for approval: whoever can approve it. */
export const APPROVAL_AUDIENCE_ROLES: readonly UserRole[] = ['Admin']

/** Who hears that a gate pass wants reviewing. Mirrors `GATE_PASS_REVIEW_ROLES`. */
export const GATE_PASS_REVIEW_AUDIENCE: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']

/** Who hears that compliance paper has lapsed: the two roles who chase it. */
export const COMPLIANCE_AUDIENCE_ROLES: readonly UserRole[] = ['Admin', 'Manager']

/**
 * Who hears an operating fact — goods back at the depot, a copy declared lost.
 *
 * The people who will load the next lorry, which is deliberately not Delivery's
 * whole read audience: a `CEO` reads trips and does not plan them, and a return
 * is a job rather than a figure. Widening it is one entry here.
 */
export const OPERATIONS_AUDIENCE_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'OpEx']

/** Who hears about money. Accounts' own read audience, which is the honest answer. */
export const MONEY_AUDIENCE_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO']
