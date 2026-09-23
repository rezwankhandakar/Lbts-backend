import type { UserRole } from '../user/user.constants'

/**
 * The activity journal's vocabulary.
 *
 * CLAUDE.md recorded for a long time that this application has no audit
 * module: the user document kept provenance (who last changed a role) rather
 * than a history, and `VendorActivity` was "the minimum audit integration" —
 * one append-only collection scoped to a vendor, shown nowhere on screen.
 * This module is what that sentence was waiting for, and it is deliberately a
 * promotion of that collection rather than a second one beside it. See
 * `activity.migration.ts`, which folds every legacy row in under its own id.
 *
 * Three rules shape everything here:
 *
 * 1. **Nothing branches on a row.** No service reads the journal to decide
 *    anything, which is what makes `recordActivity` safe to never throw: a
 *    write that happened and was not journalled is a gap in a list, and a
 *    write refused because the journal was down is an operator who cannot
 *    work.
 * 2. **A row is a sentence, and it has to still read once its subject is
 *    gone.** So the actor's name and role, and the entity's label, are
 *    *copies* rather than references — the reason `entityLabel` was a copy in
 *    the vendor journal, applied to the actor as well, because deleting a user
 *    must not blank a year of "who did it".
 * 3. **There is no write endpoint and no delete endpoint.** Rows are appended
 *    by services and by nothing else. An audit log a request can edit is not
 *    one.
 */

// --- What happened ---------------------------------------------------------

/**
 * Every action, grouped by the module that writes it.
 *
 * A closed set, like `SUGGESTION_FIELDS` in Gate Pass and for the same reason:
 * the values are read straight back out of the collection into a filter, so an
 * open one would be a way to ask questions nobody designed. The grouping is
 * what keeps a flat union of sixty strings legible — and the flat array below
 * is built from it, so a module's action can never be added to one and missed
 * by the other.
 *
 * **The vendor actions keep their exact spelling.** They were written into the
 * legacy `VendorActivity` collection and those rows are folded into this one
 * unchanged, so renaming `vehicle.status` here would orphan a year of history.
 */
export const ACTION_GROUPS = {
  Administration: ['user.created', 'user.role', 'user.status', 'user.deleted'],
  Vendor: [
    'vendor.created',
    'vendor.updated',
    'vendor.status',
    'vendor.photo',
    'vendor.deleted',
    'vehicle.created',
    'vehicle.updated',
    'vehicle.status',
    'vehicle.deleted',
    'driver.created',
    'driver.updated',
    'driver.status',
    'driver.deleted',
    'assignment.created',
    'assignment.ended',
    'assignment.deleted',
    'document.created',
    'document.updated',
    'document.deleted',
  ],
  Delivery: ['trip.created', 'trip.updated', 'trip.status', 'trip.deleted'],
  'Gate Pass': [
    'gate-pass.created',
    'gate-pass.updated',
    'gate-pass.submitted',
    'gate-pass.verified',
    'gate-pass.rejected',
    'gate-pass.deleted',
  ],
  Challan: [
    'challan.created',
    'challan.updated',
    'challan.deleted',
    'challan.printed',
    'challan.location',
  ],
  Location: ['location.created', 'location.updated', 'location.removed'],
  'Product Rate': ['product-rate.created', 'product-rate.updated', 'product-rate.removed'],
  'Excel Bill': ['bill.created', 'bill.finalized', 'bill.reopened', 'bill.deleted'],
  'Labour Bill': [
    'labour-bill.created',
    'labour-bill.finalized',
    'labour-bill.reopened',
    'labour-bill.deleted',
  ],
  Accounts: ['accounts.entry-created', 'accounts.entry-updated', 'accounts.entry-deleted'],
} as const satisfies Record<string, readonly string[]>

export type ActivityModule = keyof typeof ACTION_GROUPS

/** The modules, in the order they are declared above. */
export const ACTIVITY_MODULES = Object.keys(ACTION_GROUPS) as ActivityModule[]

type ActionsOf<M extends ActivityModule> = (typeof ACTION_GROUPS)[M][number]
export type ActivityAction = { [M in ActivityModule]: ActionsOf<M> }[ActivityModule]

/** Flattened, because a Mongoose enum and a Zod enum both want one list. */
export const ACTIVITY_ACTIONS: ActivityAction[] = ACTIVITY_MODULES.flatMap(
  (module) => ACTION_GROUPS[module] as readonly ActivityAction[],
)

/**
 * What *kind* of thing an action is, which is what the UI colours and what a
 * reader filters by when they do not know which module they are looking for.
 * "Show me everything anybody deleted last week" crosses every module, and is
 * the question an audit log exists to answer.
 */
export const ACTIVITY_CATEGORIES = [
  'create',
  'update',
  'status',
  'delete',
  'access',
  'money',
  'document',
] as const
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

/**
 * How much a row deserves to be noticed.
 *
 * `critical` is about being **quietly wrong or hard to undo** rather than
 * about volume — the same rule `attention.ts` follows on the dashboard. A
 * deletion, a change to who may do what, a corrected money entry and an edit
 * to the reference data every future record is classified and priced against
 * all qualify; two hundred challans being filed is a busy week.
 */
export const ACTIVITY_SEVERITIES = ['info', 'notice', 'critical'] as const
export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number]

export interface ActionMeta {
  module: ActivityModule
  category: ActivityCategory
  severity: ActivitySeverity
  /** A short verb phrase, for where the written summary is too long to draw. */
  label: string
}

/**
 * The whole of what an action *means*, derived and never stored.
 *
 * Module, category and severity are all read out of this map at serialisation
 * rather than written onto the row, which is the treatment `documentStatusFor`
 * gives a compliance document and `completionMethodFor` gives a delivery: a
 * stored copy is a second answer a later change can make disagree with the
 * first, and reclassifying `challan.deleted` as critical must not mean a
 * migration over a year of rows.
 *
 * Filtering by module, category or severity therefore resolves to an `$in`
 * over actions, which the `{ action: 1, createdAt: -1 }` index answers.
 */
export const ACTION_META: Record<ActivityAction, ActionMeta> = {
  // Administration — every row here is about who may do what.
  'user.created': {
    module: 'Administration',
    category: 'access',
    severity: 'info',
    label: 'Account created',
  },
  'user.role': {
    module: 'Administration',
    category: 'access',
    severity: 'critical',
    label: 'Role changed',
  },
  'user.status': {
    module: 'Administration',
    category: 'access',
    severity: 'critical',
    label: 'Account status changed',
  },
  'user.deleted': {
    module: 'Administration',
    category: 'delete',
    severity: 'critical',
    label: 'Account deleted',
  },

  // Vendor and its fleet.
  'vendor.created': {
    module: 'Vendor',
    category: 'create',
    severity: 'info',
    label: 'Vendor added',
  },
  'vendor.updated': {
    module: 'Vendor',
    category: 'update',
    severity: 'info',
    label: 'Vendor updated',
  },
  'vendor.status': {
    module: 'Vendor',
    category: 'status',
    severity: 'notice',
    label: 'Vendor status changed',
  },
  'vendor.photo': {
    module: 'Vendor',
    category: 'document',
    severity: 'info',
    label: 'Vendor photo changed',
  },
  'vendor.deleted': {
    module: 'Vendor',
    category: 'delete',
    severity: 'critical',
    label: 'Vendor deleted',
  },
  'vehicle.created': {
    module: 'Vendor',
    category: 'create',
    severity: 'info',
    label: 'Vehicle added',
  },
  'vehicle.updated': {
    module: 'Vendor',
    category: 'update',
    severity: 'info',
    label: 'Vehicle updated',
  },
  'vehicle.status': {
    module: 'Vendor',
    category: 'status',
    severity: 'notice',
    label: 'Vehicle status changed',
  },
  'vehicle.deleted': {
    module: 'Vendor',
    category: 'delete',
    severity: 'critical',
    label: 'Vehicle deleted',
  },
  'driver.created': {
    module: 'Vendor',
    category: 'create',
    severity: 'info',
    label: 'Driver added',
  },
  'driver.updated': {
    module: 'Vendor',
    category: 'update',
    severity: 'info',
    label: 'Driver updated',
  },
  'driver.status': {
    module: 'Vendor',
    category: 'status',
    severity: 'notice',
    label: 'Driver status changed',
  },
  'driver.deleted': {
    module: 'Vendor',
    category: 'delete',
    severity: 'critical',
    label: 'Driver deleted',
  },
  'assignment.created': {
    module: 'Vendor',
    category: 'create',
    severity: 'info',
    label: 'Driver assigned',
  },
  'assignment.ended': {
    module: 'Vendor',
    category: 'status',
    severity: 'notice',
    label: 'Assignment ended',
  },
  'assignment.deleted': {
    module: 'Vendor',
    category: 'delete',
    severity: 'critical',
    label: 'Assignment deleted',
  },
  'document.created': {
    module: 'Vendor',
    category: 'document',
    severity: 'info',
    label: 'Document filed',
  },
  'document.updated': {
    module: 'Vendor',
    category: 'document',
    severity: 'info',
    label: 'Document renewed',
  },
  'document.deleted': {
    module: 'Vendor',
    category: 'delete',
    severity: 'critical',
    label: 'Document deleted',
  },

  // Delivery — written from Delivery, against the vendor the trip ran for.
  'trip.created': {
    module: 'Delivery',
    category: 'create',
    severity: 'info',
    label: 'Trip confirmed',
  },
  'trip.updated': {
    module: 'Delivery',
    category: 'update',
    severity: 'notice',
    label: 'Trip corrected',
  },
  'trip.status': {
    module: 'Delivery',
    category: 'status',
    severity: 'info',
    label: 'Trip progressed',
  },
  'trip.deleted': {
    module: 'Delivery',
    category: 'delete',
    severity: 'critical',
    label: 'Trip deleted',
  },

  // Gate Pass.
  'gate-pass.created': {
    module: 'Gate Pass',
    category: 'create',
    severity: 'info',
    label: 'Gate pass filed',
  },
  'gate-pass.updated': {
    module: 'Gate Pass',
    category: 'update',
    severity: 'notice',
    label: 'Gate pass corrected',
  },
  'gate-pass.submitted': {
    module: 'Gate Pass',
    category: 'status',
    severity: 'info',
    label: 'Gate pass submitted',
  },
  'gate-pass.verified': {
    module: 'Gate Pass',
    category: 'status',
    severity: 'notice',
    label: 'Gate pass verified',
  },
  'gate-pass.rejected': {
    module: 'Gate Pass',
    category: 'status',
    severity: 'notice',
    label: 'Gate pass sent back',
  },
  'gate-pass.deleted': {
    module: 'Gate Pass',
    category: 'delete',
    severity: 'critical',
    label: 'Gate pass deleted',
  },

  // Challan.
  'challan.created': {
    module: 'Challan',
    category: 'create',
    severity: 'info',
    label: 'Challan filed',
  },
  'challan.updated': {
    module: 'Challan',
    category: 'update',
    severity: 'notice',
    label: 'Challan amended',
  },
  'challan.deleted': {
    module: 'Challan',
    category: 'delete',
    severity: 'critical',
    label: 'Challan deleted',
  },
  'challan.printed': {
    module: 'Challan',
    category: 'document',
    severity: 'info',
    label: 'Print mark changed',
  },
  'challan.location': {
    module: 'Challan',
    category: 'update',
    severity: 'info',
    label: 'Location settled',
  },

  /**
   * Reference data. `critical` on a correction rather than on a creation,
   * because adding a district changes nothing that already exists while
   * correcting one reclassifies every challan pointing at it — and changing a
   * rate changes what every future delivery in a category is charged.
   */
  'location.created': {
    module: 'Location',
    category: 'create',
    severity: 'info',
    label: 'Location added',
  },
  'location.updated': {
    module: 'Location',
    category: 'update',
    severity: 'critical',
    label: 'Location corrected',
  },
  'location.removed': {
    module: 'Location',
    category: 'delete',
    severity: 'critical',
    label: 'Location removed',
  },
  'product-rate.created': {
    module: 'Product Rate',
    category: 'create',
    severity: 'notice',
    label: 'Rate added',
  },
  'product-rate.updated': {
    module: 'Product Rate',
    category: 'update',
    severity: 'critical',
    label: 'Rate corrected',
  },
  'product-rate.removed': {
    module: 'Product Rate',
    category: 'delete',
    severity: 'critical',
    label: 'Rate removed',
  },

  // The two bills.
  'bill.created': {
    module: 'Excel Bill',
    category: 'create',
    severity: 'info',
    label: 'Bill opened',
  },
  'bill.finalized': {
    module: 'Excel Bill',
    category: 'status',
    severity: 'notice',
    label: 'Bill finalized',
  },
  'bill.reopened': {
    module: 'Excel Bill',
    category: 'status',
    severity: 'notice',
    label: 'Bill reopened',
  },
  'bill.deleted': {
    module: 'Excel Bill',
    category: 'delete',
    severity: 'critical',
    label: 'Bill deleted',
  },
  'labour-bill.created': {
    module: 'Labour Bill',
    category: 'create',
    severity: 'info',
    label: 'Labour bill opened',
  },
  'labour-bill.finalized': {
    module: 'Labour Bill',
    category: 'status',
    severity: 'notice',
    label: 'Labour bill finalized',
  },
  'labour-bill.reopened': {
    module: 'Labour Bill',
    category: 'status',
    severity: 'notice',
    label: 'Labour bill reopened',
  },
  'labour-bill.deleted': {
    module: 'Labour Bill',
    category: 'delete',
    severity: 'critical',
    label: 'Labour bill deleted',
  },

  /**
   * Money. A correction and a deletion are both critical: an entry rewritten
   * after the fact is the one thing in a cash book that stops it reconciling,
   * and Accounts keeps no history of what an entry said before — which is
   * exactly the gap this row fills.
   */
  'accounts.entry-created': {
    module: 'Accounts',
    category: 'money',
    severity: 'notice',
    label: 'Entry recorded',
  },
  'accounts.entry-updated': {
    module: 'Accounts',
    category: 'money',
    severity: 'critical',
    label: 'Entry corrected',
  },
  'accounts.entry-deleted': {
    module: 'Accounts',
    category: 'delete',
    severity: 'critical',
    label: 'Entry deleted',
  },
}

/** Read defensively: a row written before an action was retired still renders. */
const UNKNOWN_ACTION: ActionMeta = {
  module: 'Administration',
  category: 'update',
  severity: 'info',
  label: 'Activity',
}

export function actionMeta(action: string): ActionMeta {
  return ACTION_META[action as ActivityAction] ?? UNKNOWN_ACTION
}

/** Every action belonging to a module — what a module filter resolves to. */
export function actionsOfModule(module: ActivityModule): ActivityAction[] {
  return ACTIVITY_ACTIONS.filter((action) => ACTION_META[action].module === module)
}

export function actionsOfCategory(category: ActivityCategory): ActivityAction[] {
  return ACTIVITY_ACTIONS.filter((action) => ACTION_META[action].category === category)
}

export function actionsOfSeverity(severity: ActivitySeverity): ActivityAction[] {
  return ACTIVITY_ACTIONS.filter((action) => ACTION_META[action].severity === severity)
}

// --- What a row is about ---------------------------------------------------

/**
 * The kinds of thing a row can name. A superset of the legacy vendor list,
 * whose six values are kept verbatim so folded rows keep reading.
 */
export const ACTIVITY_ENTITY_TYPES = [
  'User',
  'Vendor',
  'Vehicle',
  'Driver',
  'Assignment',
  'Document',
  'Trip',
  'GatePass',
  'Challan',
  'Location',
  'ProductRate',
  'Bill',
  'LabourBill',
  'AccountsEntry',
] as const
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number]

// --- Limits ----------------------------------------------------------------

export const MAX_ACTIVITY_PAGE_SIZE = 100
export const DEFAULT_ACTIVITY_PAGE_SIZE = 25

/** Beyond this a workbook is refused with the count, never truncated. */
export const MAX_ACTIVITY_EXPORT_ROWS = 5000

/** How many distinct actors the filter dropdown offers. */
export const MAX_ACTIVITY_ACTORS = 60

/** How many field-level changes one row records; the rest are counted, not kept. */
export const MAX_ACTIVITY_CHANGES = 12

/**
 * How long a row is kept, as a TTL index on `createdAt`.
 *
 * Two years, and it is a free-tier decision rather than a policy one. M0 is a
 * 512 MB shared cluster, and this is the one collection in the system that
 * grows without bound and is read by no decision — a journal that eventually
 * fills the cluster takes *every* module down with it, which is a far worse
 * audit outcome than losing rows from two years ago. The export is how a
 * period is taken off before it expires.
 *
 * Set to 0 to keep everything: `syncActivityIndexes` drops the TTL index when
 * it is, and rebuilds it at the right length whenever this number changes.
 * MongoDB will not alter an existing TTL index's expiry on its own, which is
 * exactly the trap `syncDeliveryIndexes` exists for in Delivery.
 */
export const ACTIVITY_RETENTION_DAYS = 730

// --- Permissions -----------------------------------------------------------

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do.
 *
 * **Read is `Admin`, `Manager` and `CEO`, and writing is not a permission at
 * all.** The journal spans every module, so it carries what Accounts carries —
 * a vendor payment's amount, an advance, a corrected entry — and Accounts' own
 * audience is exactly these three. Widening to `OpEx` would hand the office's
 * money movements to a role the business deliberately keeps out of Accounts,
 * by a back door; `Vendor` is out for the reason it is out of every operating
 * module, and reads its own vendor's rows through the vendor page instead,
 * scoped from the profile as everything else there is.
 *
 * There is no write set and no manage set, because no request writes here.
 * Rows are appended by services through `recordActivity`, and there is no
 * endpoint that creates, edits or deletes one.
 */
export const ACTIVITY_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO']

/**
 * Who may take the journal off the system as a file.
 *
 * Narrower than reading, deliberately: reading a page of it answers a
 * question, and downloading five thousand rows of who did what is a copy of
 * the audit trail leaving the building. It is also the module's only expensive
 * read, so it carries its own rate limit on top.
 */
export const ACTIVITY_EXPORT_ROLES: readonly UserRole[] = ['Admin']
