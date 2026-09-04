import { Schema, model } from 'mongoose'

/**
 * One monotonic counter per key. Used only to allocate gate pass numbers.
 *
 * The alternative - counting existing records and adding one - races under any
 * concurrency at all and would hand two operators the same number. A single
 * findOneAndUpdate with $inc is atomic in MongoDB, so this is correct without
 * a transaction and costs one indexed write per gate pass.
 */
const counterSchema = new Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
)

export const CounterModel = model('Counter', counterSchema)

/**
 * The next value for a key, allocated atomically. The document is created on
 * first use, so nothing has to be seeded.
 */
export async function nextSequence(key: string): Promise<number> {
  const counter = await CounterModel.findByIdAndUpdate(
    key,
    { $inc: { value: 1 } },
    { new: true, upsert: true },
  )

  return counter.value
}

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
