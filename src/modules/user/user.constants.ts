/**
 * The single source of truth for identity/access categories and account
 * lifecycle states. Everything that talks about a role or a status — the
 * Mongoose enum, the Zod schemas, the administration guards — reads from here,
 * so no two layers can drift onto different strings.
 *
 * The frontend mirrors this file at `src/lib/roles.ts`. Change one, change both.
 *
 * A role answers "who is this person to the business". It deliberately does
 * NOT answer "what may they do in module X" — module-level permissions are
 * configured by each module when that module is built.
 */
export const USER_ROLES = ['Admin', 'Manager', 'CEO', 'OpEx', 'Vendor'] as const
export type UserRole = (typeof USER_ROLES)[number]

/**
 * Account lifecycle. An account is only usable in `Active`; every other state
 * is a stop, and requireActiveAccount is what enforces that.
 */
export const USER_STATUSES = ['Pending', 'Active', 'Rejected', 'Suspended'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/** The one role that may administer the system. */
export const ADMIN_ROLE: UserRole = 'Admin'

/**
 * What a brand-new account gets. Never a privileged role, and never usable
 * until an Admin approves it — which is why the default status is Pending.
 *
 * `Vendor` is the least-privileged role in the fixed set. There is no sixth
 * "unassigned" role by design: the status, not the role, is what gates access
 * before an Admin has decided who this person is.
 */
export const DEFAULT_USER_ROLE: UserRole = 'Vendor'
export const DEFAULT_USER_STATUS: UserStatus = 'Pending'

/**
 * Allowed account lifecycle transitions. The administration service checks
 * this rather than trusting whichever action the client happened to render,
 * so a stale table cannot, say, approve an already-active account.
 */
export const STATUS_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  Pending: ['Active', 'Rejected'],
  Active: ['Suspended'],
  Rejected: ['Active'],
  Suspended: ['Active'],
}

export function canTransition(from: UserStatus, to: UserStatus): boolean {
  // Indexed defensively: a document written before this status set existed
  // holds a value with no entry here, and must fail closed rather than throw.
  return (STATUS_TRANSITIONS[from] ?? []).includes(to)
}
