import { LabourBillModel } from './labour-bill.model'

/**
 * A labour bill briefly carried a CSD of its own, when the slot was a CSD and a
 * month together. It is a month now — each row files itself under whatever CSD
 * its gate pass carries, and the sheet splits into a section and a worksheet per
 * CSD — so the two fields on the record describe nothing and are dropped.
 *
 * Through the raw collection, because both are outside the schema and Mongoose
 * would strip them out of the filter. Idempotent: a bill that no longer has them
 * is never touched. It never throws — a dead field on a record is worth less
 * than an API that boots.
 */
export async function dropLabourBillSlotCsd(): Promise<void> {
  try {
    const result = await LabourBillModel.collection.updateMany(
      { $or: [{ csd: { $exists: true } }, { csdKey: { $exists: true } }] },
      { $unset: { csd: '', csdKey: '' } },
    )

    if (result.modifiedCount > 0) {
      console.log(
        `[labour-bill] dropped the retired slot CSD from ${result.modifiedCount} ${
          result.modifiedCount === 1 ? 'bill' : 'bills'
        }`,
      )
    }
  } catch (error) {
    console.error('[labour-bill] slot CSD cleanup failed', error)
  }
}
