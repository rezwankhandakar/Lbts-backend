import { EntryModel } from './accounts.model'

/**
 * Expenses recorded while an expense chose a category from a list carry the
 * category's name in `categoryName` and no `expenseName`. The list is gone and
 * the name is now typed, so that name is copied across — it is what the
 * expense was for — and the retired fields are dropped.
 *
 * Through the raw collection, because both old fields are outside the schema
 * and Mongoose would strip them out of the filter. Idempotent: an entry that
 * already has an `expenseName` is never touched. It never throws — an expense
 * shown without its name is worth less than an API that boots.
 */
export async function migrateExpenseNames(): Promise<void> {
  try {
    const collection = EntryModel.collection

    const named = await collection.updateMany(
      { expenseName: { $exists: false }, categoryName: { $type: 'string', $ne: '' } },
      [{ $set: { expenseName: '$categoryName' } }],
    )
    const cleared = await collection.updateMany(
      { $or: [{ categoryId: { $exists: true } }, { categoryName: { $exists: true } }] },
      { $unset: { categoryId: '', categoryName: '' } },
    )
    const blank = await collection.updateMany({ expenseName: { $exists: false } }, { $set: { expenseName: '' } })

    if (named.modifiedCount > 0 || cleared.modifiedCount > 0 || blank.modifiedCount > 0) {
      console.log(
        `[accounts] expense names: ${named.modifiedCount} copied from categories, ` +
          `${cleared.modifiedCount} entries cleared of category fields, ${blank.modifiedCount} set blank`,
      )
    }
  } catch (error) {
    console.error('[accounts] expense name migration failed', error)
  }
}
