import { WalletModel } from './accounts.model'
import { nameKeyOf } from './wallet.service'

/**
 * A first wallet, once: `Cash in Hand`, because money is added into cash and
 * every payment leaves from it, so a new ledger can do nothing without one.
 *
 * Seeded **only into an empty collection**, so a wallet an Admin has deleted
 * does not come back on the next deploy. It never throws: a ledger with no
 * wallet yet is worth less than an API that boots.
 */
export async function seedAccounts(): Promise<void> {
  try {
    if ((await WalletModel.estimatedDocumentCount()) === 0) {
      await WalletModel.create({ name: 'Cash in Hand', nameKey: nameKeyOf('Cash in Hand'), kind: 'Cash' })
      console.log('[accounts] seeded the Cash in Hand wallet')
    }
  } catch (error) {
    console.error('[accounts] seeding failed', error)
  }
}
