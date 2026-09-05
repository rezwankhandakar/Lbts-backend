import { Schema, model } from 'mongoose'

/**
 * One monotonic counter per key, shared by every module that needs to hand out
 * a human-facing running number.
 *
 * It lived in `gate-pass.counter.ts` first and was lifted here when Challan
 * needed the same guarantee, for a reason more concrete than tidiness:
 * Mongoose registers a model by name, so a second `model('Counter', …)`
 * anywhere in the process throws `OverwriteModelError` at import time. There
 * can be exactly one definition, so it belongs to no single module.
 *
 * The alternative — counting existing records and adding one — races under any
 * concurrency at all and would hand two operators the same number. A single
 * findOneAndUpdate with $inc is atomic in MongoDB, so this is correct without
 * a transaction and costs one indexed write per allocation.
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
