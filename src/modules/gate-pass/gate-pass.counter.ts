import { nextSequence } from '../../utils/counter'

/**
 * Gate pass numbering.
 *
 * The counter itself is in `utils/counter.ts` — Mongoose allows exactly one
 * model per name in a process, and Challan allocates from the same mechanism,
 * so the model cannot belong to either module. Re-exported here so nothing
 * that already imported it from this file had to change.
 */
export { CounterModel, nextSequence } from '../../utils/counter'

/**
 * GP-2026-000123.
 *
 * Scoped per year so the running number stays short and readable on a printed
 * pass, and so the year is legible in the identifier itself. Six digits leaves
 * room for a million passes in a year, and the format degrades gracefully if
 * that is ever exceeded - the number simply grows a digit.
 */
export async function allocateGatePassId(now: Date = new Date()): Promise<string> {
  const year = now.getUTCFullYear()
  const sequence = await nextSequence(`gate-pass:${year}`)
  return `GP-${year}-${String(sequence).padStart(6, '0')}`
}
