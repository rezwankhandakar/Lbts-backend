import 'dotenv/config'
import mongoose from 'mongoose'
import { ensureDnsResolvers } from './src/config/dns'
import {
  renumberTripsGlobally,
  syncDeliveryIndexes,
} from './src/modules/delivery/delivery.migration'
import { backfillTripDoLedger } from './src/modules/trip-do/trip-do.sync'

async function main() {
  ensureDnsResolvers()
  const uri = process.env.DATABASE_URL
  if (!uri) throw new Error('no DATABASE_URL')
  await mongoose.connect(uri, { maxPoolSize: 5, bufferCommands: false })

  await renumberTripsGlobally()
  await syncDeliveryIndexes()
  await backfillTripDoLedger()

  const db = mongoose.connection.db!
  const trips = await db
    .collection('deliveries')
    .find({}, { projection: { tripNumber: 1, tripSerial: 1, vendorTripSerial: 1 }, sort: { tripSerial: 1 } })
    .toArray()
  console.log('\n--- after ---')
  trips.forEach((t) =>
    console.log(`  ${t.tripNumber}  tripSerial=${t.tripSerial}  vendorTripSerial=${t.vendorTripSerial ?? 'gone'}`),
  )
  console.log('counters:', await db.collection('counters').find({ _id: { $regex: '^delivery-trip' } } as never).toArray())
  console.log(
    'indexes:',
    (await db.collection('deliveries').indexes())
      .filter((i) => i.unique)
      .map((i) => `${i.name} ${JSON.stringify(i.key)}`),
  )
  const rows = await db.collection('tripdolines').distinct('tripNumbers')
  console.log('trip numbers on the Trip DO sheet:', rows)

  await mongoose.disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
