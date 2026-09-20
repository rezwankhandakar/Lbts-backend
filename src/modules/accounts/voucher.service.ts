import { AppError } from '../../utils/app-error'
import type { UserDocument } from '../user/user.model'
import type { VoucherMimeType } from './accounts.constants'
import { serializeEntry } from './accounts.serializer'
import type { EntryRecord } from './accounts.serializer'
import { deleteVoucher, uploadVoucher } from './accounts.storage'
import { findEntry } from './entry.service'

/**
 * The paper behind an entry: attaching it, taking it off, and finding the
 * object the route streams.
 *
 * It is its own file rather than more of `entry.service.ts` for the reason that
 * file is already long: nothing here reads or writes a figure, and nothing in
 * the ledger arithmetic reads a voucher. A voucher is evidence beside an entry,
 * never part of what the entry says.
 *
 * **It is never part of creating one.** The object key contains the entry id,
 * so the entry has to exist first — the same ordering Gate Pass's three calls
 * and a vehicle's photo both have — which means the browser saves the entry and
 * then uploads. That also keeps the entry's idempotency claim about the *money*
 * rather than about the file: a retried upload replaces a file, a retried save
 * must never pay a vendor twice.
 */

export interface VoucherRef {
  key: string
  mimeType: VoucherMimeType
  originalName: string
}

/**
 * The voucher arriving, or replacing the one on record.
 *
 * The order is the safety property, and it is the one every storage path in
 * this codebase keeps: upload the new object, write the reference, *then*
 * delete the one it replaced. The worst outcome of a failure is an orphan in
 * the bucket, never an entry pointing at a file that is gone. If the write
 * fails after an upload, the new object is discarded rather than left behind.
 *
 * Replacing is ordinary — a photograph too dark to read a figure off, a page
 * missed off the feeder — and it changes nothing about the entry itself. An
 * amount is what the entry says; this is only the paper it came from.
 */
export async function attachVoucher(
  id: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
  pageCount: number | null,
  actor: UserDocument,
): Promise<EntryRecord> {
  const entry = await findEntry(id)
  const previous = entry.voucher?.key ?? null

  const stored = await uploadVoucher({
    entryId: String(entry._id),
    entryDate: entry.date,
    buffer: file.buffer,
    mimeType: file.mimetype,
    originalName: file.originalname,
    pageCount,
  })

  entry.set('voucher', { ...stored, uploadedBy: actor._id })
  /**
   * `updatedBy` is deliberately left alone. Nobody corrected the entry — the
   * figures, the wallet and the day are exactly what they were — and moving it
   * would tell a reader the books had changed when only the paper behind them
   * arrived. Who attached it is on the voucher itself.
   */
  try {
    await entry.save()
  } catch (error) {
    // The reference never landed, so the object just written is litter.
    await deleteVoucher(stored.key)
    throw error
  }

  if (previous && previous !== stored.key) {
    await deleteVoucher(previous)
  }

  return serializeEntry(entry)
}

/**
 * Taking the voucher back off.
 *
 * The reference is cleared *first* and the object deleted after, so the worst
 * outcome of a failure is an orphan rather than an entry pointing at nothing.
 */
export async function clearVoucher(id: string): Promise<EntryRecord> {
  const entry = await findEntry(id)

  if (!entry.voucher) {
    throw new AppError(409, `No voucher is on record for ${entry.entryNumber}.`)
  }

  const key = entry.voucher.key

  entry.set('voucher', null)
  await entry.save()

  await deleteVoucher(key)

  return serializeEntry(entry)
}

/**
 * The stored object's key, once the caller has been proved able to read it.
 *
 * The route streams it. A voucher carries a supplier's name, an amount and
 * often a signature, so the bucket never serves it and this is the only read
 * path.
 */
export async function findVoucher(id: string): Promise<VoucherRef> {
  const entry = await findEntry(id)

  if (!entry.voucher) {
    throw new AppError(404, `No voucher is on record for ${entry.entryNumber}.`)
  }

  return {
    key: entry.voucher.key,
    mimeType: entry.voucher.mimeType as VoucherMimeType,
    originalName: entry.voucher.originalName || `${entry.entryNumber}.pdf`,
  }
}
