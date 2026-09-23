import * as z from 'zod'
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_CATEGORIES,
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_MODULES,
  ACTIVITY_SEVERITIES,
  DEFAULT_ACTIVITY_PAGE_SIZE,
  MAX_ACTIVITY_PAGE_SIZE,
} from './activity.constants'

/** Mongo ObjectId as it arrives in a URL or a query string. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id.')

/**
 * What narrows the journal.
 *
 * Shared between the list query and the export query, exactly as
 * `gatePassFilterFields` is in Gate Pass and for the same reason: a downloaded
 * file must never describe a set of rows nobody was looking at.
 *
 * Every filter is a **closed set or an id**. This list reads its own values
 * straight back out of the collection, so an open one would be a way to ask
 * questions nobody designed — the rule `SUGGESTION_FIELDS` follows in Gate
 * Pass.
 */
export const activityFilterFields = {
  search: z.string().trim().max(160).default(''),

  /**
   * Module, category and severity are all *derived* from the action, so each
   * resolves to an `$in` over actions in the service rather than to a column.
   * They are three filters rather than one because they answer three different
   * questions: which part of the system, what kind of change, and how much it
   * deserves to be noticed.
   */
  module: z.enum(['all', ...ACTIVITY_MODULES]).default('all'),
  category: z.enum(['all', ...ACTIVITY_CATEGORIES]).default('all'),
  severity: z.enum(['all', ...ACTIVITY_SEVERITIES]).default('all'),

  /** One exact action, for when somebody knows precisely what they are after. */
  action: z.enum(['all', ...ACTIVITY_ACTIONS]).default('all'),

  entityType: z.enum(['all', ...ACTIVITY_ENTITY_TYPES]).default('all'),

  /**
   * One record's own history. Paired with `entityType` by the index, and
   * accepted without it too — an id is unique enough on its own that
   * demanding the type would only make a link harder to build.
   */
  entityId: objectId.optional(),

  /** One person's trail. */
  actorId: objectId.optional(),

  /** One vendor's journal, as the vendor page asks for it. */
  vendorId: objectId.optional(),

  /**
   * A closed date range over `createdAt`, inclusive at both ends.
   *
   * These are instants rather than calendar days — a journal row is a moment,
   * unlike a trip date — so the client sends what it means and the service
   * widens `to` to the end of that day, which is what somebody typing two
   * dates into a filter expects.
   */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}

export const listActivityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_ACTIVITY_PAGE_SIZE)
    .default(DEFAULT_ACTIVITY_PAGE_SIZE),
  ...activityFilterFields,
})
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>

/** The same filters, no page — the export describes the whole matching set. */
export const exportActivityQuerySchema = z.object(activityFilterFields)
export type ExportActivityQuery = z.infer<typeof exportActivityQuerySchema>

/**
 * The overview.
 *
 * `today` is the **viewer's** calendar day, as Delivery's stats and the
 * Accounts overview both take it: "what happened today" is a question about
 * the reader's day, and the server's UTC midnight is six hours out of step
 * with Dhaka's.
 */
export const activityStatsQuerySchema = z.object({
  today: z.coerce.date().optional(),
  ...activityFilterFields,
})
export type ActivityStatsQuery = z.infer<typeof activityStatsQuerySchema>
