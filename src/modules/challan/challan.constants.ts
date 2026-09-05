import type { UserRole } from '../user/user.constants'

/**
 * The single source of truth for the Challan vocabulary. The frontend mirrors
 * this file at `LBTS-Frontend/src/features/challan/types/index.ts`, which adds
 * display metadata and nothing else. Change one, change both.
 */

/**
 * What a challan record is.
 *
 * There is deliberately no `Draft`. A challan comes into existence at the
 * moment it is submitted — that is the whole point of the module: the Walton
 * PDF that arrives over WhatsApp is a temporary working source, and nothing
 * about it is written down until an operator files one individual challan out
 * of it. A draft record would be a permanent row created because a file was
 * opened, which is exactly what the business rules forbid.
 *
 * Unfinished entries therefore live in the browser's processing session, not
 * in this collection. What survives a closed tab is what was submitted.
 *
 * `Amended` is not a workflow state either; it is a fact about the record. A
 * submitted challan can still be corrected — a customer name transcribed
 * wrongly is wrong whether it is caught in the workspace or a fortnight later
 * — and correcting one regenerates its barcode back page and its stored PDF.
 * Saying so on the record is what stops "the document matches the data" from
 * being an assumption nobody can check.
 */
export const CHALLAN_STATUSES = ['Submitted', 'Amended'] as const
export type ChallanStatus = (typeof CHALLAN_STATUSES)[number]

export const INITIAL_CHALLAN_STATUS: ChallanStatus = 'Submitted'

/**
 * A source batch: one WhatsApp PDF, and the challans cut out of it.
 *
 * Two states, not four. A batch does not exist until its first challan is
 * submitted, so there is no `Draft` to be in; and "partially completed" is
 * what `Processing` already means, so a second word for it would be a state
 * nothing could ever distinguish. Completion is not a button either — it is
 * arithmetic: a batch is Completed exactly when every page of the source PDF
 * belongs to a submitted challan.
 */
export const CHALLAN_BATCH_STATUSES = ['Processing', 'Completed'] as const
export type ChallanBatchStatus = (typeof CHALLAN_BATCH_STATUSES)[number]

/**
 * Module-level permissions, configured here because that is what CLAUDE.md
 * asks each module to do: a role says who someone is to the business, not what
 * they may do inside a module.
 *
 * The same shape Gate Pass uses, and for the same reasons. `Vendor` appears in
 * none of them — a challan carries a customer's home address and phone number,
 * and an external supplier has no business reading one. `CEO` reads everything
 * and writes nothing.
 */
export const CHALLAN_READ_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'CEO', 'OpEx']
export const CHALLAN_WRITE_ROLES: readonly UserRole[] = ['Admin', 'Manager', 'OpEx']

/**
 * Roles that may correct or remove a challan somebody else filed. Everyone
 * else is scoped to their own work.
 */
export const CHALLAN_MANAGE_ANY_ROLES: readonly UserRole[] = ['Admin', 'Manager']

export function canManageAnyChallan(role: UserRole): boolean {
  return CHALLAN_MANAGE_ANY_ROLES.includes(role)
}

/**
 * The source PDF never reaches this API, so these bound what the browser is
 * asked to hold and what one submission may carry.
 *
 * `MAX_SOURCE_PAGES` is a ceiling on a single WhatsApp file — a day's challans
 * from the corporate office, not an archive. `MAX_CHALLAN_PAGES` is the front
 * pages of one challan; three or four is normal and twenty is a page range
 * somebody selected by accident.
 */
export const MAX_SOURCE_PAGES = 500
export const MAX_CHALLAN_PAGES = 25

/**
 * The extracted front pages, as they arrive on a submission. Small on purpose:
 * this is a handful of pages copied out of a source PDF, not the source PDF.
 * A 15 MB extract is a sign the whole file was sent, and refusing it protects
 * a 512 MB instance from building a merged document on top of it.
 */
export const MAX_CHALLAN_UPLOAD_BYTES = 15 * 1024 * 1024

/**
 * Product rows one challan may carry.
 *
 * A Walton challan routinely lists several — a refrigerator and the stand it
 * ships on, or the indoor and outdoor halves of an air conditioner — each with
 * its own model and quantity. One is the minimum, because a challan carrying
 * nothing is not a challan; the ceiling is a sanity limit on a request body
 * rather than a business rule.
 */
export const MAX_CHALLAN_ITEMS = 30

/** How many challans one batch PDF may merge before it is refused outright. */
export const MAX_BATCH_MERGE_CHALLANS = 200

/** Rows one list page may return, and the ceiling on an export. */
export const MAX_CHALLAN_PAGE_SIZE = 50

/**
 * The comparison key for values an operator copies out of a PDF.
 *
 * The same reasoning as Gate Pass: duplicate detection has to see
 * "ABC Electronics Ltd." and "abc electronics ltd" as the same customer while
 * the record keeps exactly what was pasted — so this produces a separate
 * stored key rather than rewriting the field.
 */
export function comparisonKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9\u0980-\u09FF]/g, '')
}

/**
 * A Bangladeshi mobile number, reduced to the eleven digits that identify it.
 *
 * `+8801712345678`, `8801712345678`, `01712-345678` and `01712 345678` are one
 * number written four ways, and a record that cannot tell is a record nobody
 * can search. Anything that is not recognisably one of those is returned with
 * its whitespace collapsed and nothing else touched — guessing at an unusual
 * number is worse than storing what was on the paper.
 */
export function normalizeMobile(value: string): string {
  const digits = value.replace(/[^\d]/g, '')

  if (/^01\d{9}$/.test(digits)) {
    return digits
  }
  if (/^8801\d{9}$/.test(digits)) {
    return digits.slice(2)
  }

  return value.trim().replace(/\s+/g, ' ')
}

/** True for the eleven-digit local form this system stores. */
export function isNormalizedMobile(value: string): boolean {
  return /^01\d{9}$/.test(value)
}
