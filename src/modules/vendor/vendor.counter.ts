import { nextSequence } from '../../utils/counter'

/**
 * Human-facing identifiers for the three things a vendor's fleet is made of.
 *
 * All three come off the shared atomic counter in `utils/counter.ts` — the same
 * mechanism Gate Pass and Challan use, and for the same reason: counting the
 * existing records and adding one races under any concurrency at all and would
 * hand two operators the same code.
 *
 * None of them is year-scoped, unlike `GP-2026-000123`. A gate pass is an event
 * and the year is part of reading it; a vendor, a vehicle and a driver are
 * relationships that outlive any year, and `VH-2026-000004` would suggest the
 * vehicle expired with the calendar.
 *
 * Four digits with room to grow — the format degrades gracefully past 9999, the
 * number simply grows a digit rather than wrapping. A failed create burns its
 * code rather than recycling it; a gap in the sequence costs nothing and a
 * reused identifier would be a real problem on a printed document.
 */

export async function allocateVendorCode(): Promise<string> {
  const sequence = await nextSequence('vendor')
  return `V-${String(sequence).padStart(4, '0')}`
}

export async function allocateVehicleCode(): Promise<string> {
  const sequence = await nextSequence('vendor-vehicle')
  return `VH-${String(sequence).padStart(4, '0')}`
}

export async function allocateDriverCode(): Promise<string> {
  const sequence = await nextSequence('vendor-driver')
  return `DR-${String(sequence).padStart(4, '0')}`
}
