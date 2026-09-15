import { Schema, model } from 'mongoose'
import type { InferSchemaType } from 'mongoose'
import { LOCATION_TYPES } from '../location/location.constants'
import { VEHICLE_OWNERSHIP_TYPES } from '../vendor/vendor.constants'
import {
  CARRYING_KINDS,
  INITIAL_TRIP_STATUS,
  MAX_CARRYING_AMOUNT,
  MAX_CARRYING_ENTRIES,
  MAX_COPY_MISSING_REASON,
  MAX_FLOOR,
  MAX_TRIP_CHALLANS,
  MAX_TRIP_CHARGE,
  MAX_TRIP_LINES,
  RECEIVED_COPY_MIME_TYPES,
  TRIP_STATUSES,
  carryingTotalOf,
  completionMethodFor,
  tripStatusFor,
} from './delivery.constants'

/**
 * One trip: a vehicle, a driver, and the challans that went out on it.
 *
 * The design rule that runs through every sub-document below is **a reference
 * plus a copy**. Each party — vendor, vehicle, driver, challan — is stored as
 * the id that points at it *and* what it said at the moment the trip was
 * confirmed. The id is how a trip is found from the vehicle's side; the copy is
 * what the trip *says*, and it must not change afterwards. A driver whose
 * mobile number changes in March did not have that number on a February trip,
 * and a vehicle whose assigned driver changes tomorrow was still driven by
 * whoever drove it today. The same reasoning the Vendor module's activity log
 * gives for storing a registration number as a copy.
 */

/** What the source challan line said when this trip took it. */
const sourceLineSchema = new Schema(
  {
    productName: { type: String, required: true, trim: true, maxlength: 200 },
    productModel: { type: String, required: true, trim: true, maxlength: 120 },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false },
)

/**
 * One product line on this trip.
 *
 * The stored path is `productModel`, not `model`: `model` collides with
 * Mongoose's own `Document.model()`. The API and the UI still call it `model`,
 * exactly as Gate Pass and Challan do.
 */
const tripLineSchema = new Schema(
  {
    /** Position on the challan, or null for a line the paper never listed. */
    sourceIndex: { type: Number, default: null, min: 0 },
    source: { type: sourceLineSchema, default: null },

    productName: { type: String, required: true, trim: true, maxlength: 200 },
    productModel: { type: String, required: true, trim: true, maxlength: 120 },
    /** Duplicate-free matching key; nothing displays it. */
    productModelKey: { type: String, required: true },
    qty: { type: Number, required: true, min: 1, max: 100000 },
  },
  { _id: false },
)

/**
 * Part of a challan line this trip deliberately left for a later one.
 *
 * This is the whole of what tells a **split** apart from a **correction**, and
 * nothing else can: both take less than the challan orders, and only the
 * operator knows whether the rest is coming on the next lorry or was never
 * there. A split records it here, the challan keeps the quantity, and the next
 * trip is offered it. An ordinary trim records nothing, and the challan is
 * rewritten to what actually went.
 *
 * It is stored rather than derived because a later edit of this same trip has
 * to rebuild the challan from scratch — and a reservation that had been
 * forgotten by then would be corrected away on the second save.
 */
const reservedLineSchema = new Schema(
  {
    productName: { type: String, required: true, trim: true, maxlength: 200 },
    productModel: { type: String, required: true, trim: true, maxlength: 120 },
    productModelKey: { type: String, required: true },
    qty: { type: Number, required: true, min: 1, max: 100000 },
  },
  { _id: false },
)

/**
 * The customer details as the operator confirmed them for this trip, and as
 * the challan printed them.
 *
 * A trip's copy of these may be corrected — a receiver who gave a different
 * number at the gate, an address with a landmark the driver needs — **without
 * touching the challan**. The challan is the corporate office's paperwork and
 * has its own correction path, which regenerates a barcode page; a trip is what
 * went on a lorry. Keeping the original beside the operational value is what
 * lets the manifest mark what was changed.
 */
const deliveryPartySchema = new Schema(
  {
    customerName: { type: String, required: true, trim: true, maxlength: 200 },
    deliveryAddress: { type: String, required: true, trim: true, maxlength: 500 },
    thana: { type: String, default: '', trim: true, maxlength: 120 },
    district: { type: String, default: '', trim: true, maxlength: 120 },
    receiverMobile: { type: String, required: true, trim: true, maxlength: 40 },
  },
  { _id: false },
)

/** The challan's resolved location, copied so the manifest reads without a join. */
const locationCopySchema = new Schema(
  {
    district: { type: String, required: true },
    thana: { type: String, required: true },
    locationType: { type: String, required: true, enum: LOCATION_TYPES },
  },
  { _id: false },
)

/**
 * Pieces of a challan line that went out and came back.
 *
 * The same shape as a reservation, and that is not a coincidence — a return
 * **is** a reservation decided after the fact. The lorry left with four, the
 * receiver took two, two came back, and the challan is in exactly the state it
 * would have been in had the operator split it that way at the gate: it still
 * orders four, two are dispatched, and two are waiting for another lorry.
 *
 * Which is why a return never rewrites the challan. Trimming a line at the gate
 * says "only three ever existed" and the paper is corrected to three; a return
 * says "four existed and two are back on our shelf", and correcting the paper
 * down would lose the two the customer is still owed. `rebuildChallanItems`
 * reads both through the same `held` argument for that reason.
 */
const returnedLineSchema = new Schema(
  {
    productName: { type: String, required: true, trim: true, maxlength: 200 },
    productModel: { type: String, required: true, trim: true, maxlength: 120 },
    productModelKey: { type: String, required: true },
    qty: { type: Number, required: true, min: 1, max: 100000 },
    /** Why it came back, in the operator's own words. Optional; often obvious. */
    reason: { type: String, default: '', trim: true, maxlength: 300 },
  },
  { _id: false },
)

/**
 * Something hired to get the goods the last few metres, and what it cost.
 *
 * A vehicle for the last stretch or people to carry it up — see
 * `CARRYING_KINDS`. An amount of zero is ordinary and is not the same as no
 * entry at all: a helper who carried two boxes up for nothing is worth
 * recording, because next month somebody will ask whether that address always
 * needs one.
 */
const carryingChargeSchema = new Schema(
  {
    kind: { type: String, enum: CARRYING_KINDS, required: true },
    description: { type: String, default: '', trim: true, maxlength: 200 },
    amount: { type: Number, default: 0, min: 0, max: MAX_CARRYING_AMOUNT },
  },
  { _id: false },
)

/**
 * The receiver's signed challan copy, scanned back in through the agent.
 *
 * Private, like every other document in this system that carries a customer's
 * address: MongoDB holds the object key and nothing else, and the API streams
 * it behind the module's own auth and role checks. It is stored under its own
 * R2 prefix so the bucket can give signed copies their own lifecycle rules.
 *
 * Its presence **is** the completion. There is no separate "complete" flag a
 * client could set, for the same reason `documentStatusFor` in Vendor refuses
 * a stored status: a flag beside the evidence is a way to contradict it.
 */
const receivedCopySchema = new Schema(
  {
    key: { type: String, required: true },
    mimeType: { type: String, enum: RECEIVED_COPY_MIME_TYPES, required: true },
    size: { type: Number, required: true, min: 1 },
    originalName: { type: String, default: '', maxlength: 200 },
    /** Reported by whatever produced the file; never guessed. */
    pageCount: { type: Number, default: null, min: 1 },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
)

const tripChallanSchema = new Schema(
  {
    challanId: { type: Schema.Types.ObjectId, ref: 'Challan', required: true },
    /** Copied: the barcode payload and the serial, as the back page prints them. */
    challanNumber: { type: String, required: true },
    slNumber: { type: Number, required: true },

    customerName: { type: String, required: true, trim: true, maxlength: 200 },
    deliveryAddress: { type: String, required: true, trim: true, maxlength: 500 },
    thana: { type: String, default: '', trim: true, maxlength: 120 },
    district: { type: String, default: '', trim: true, maxlength: 120 },
    receiverMobile: { type: String, required: true, trim: true, maxlength: 40 },

    /** What the challan said — see `deliveryPartySchema`. */
    original: { type: deliveryPartySchema, required: true },
    location: { type: locationCopySchema, default: null },

    note: { type: String, default: '', trim: true, maxlength: 400 },

    lines: {
      type: [tripLineSchema],
      required: true,
      validate: {
        validator: (value: unknown[]) => value.length >= 1 && value.length <= MAX_TRIP_LINES,
        message: `A challan on a trip needs between 1 and ${MAX_TRIP_LINES} product lines.`,
      },
    },

    /** What a split left for a later trip — see `reservedLineSchema`. */
    reserved: { type: [reservedLineSchema], default: [] },

    /**
     * What came back off the lorry — see `returnedLineSchema`. Recorded when
     * the receiver's copy is worked through, not at the gate.
     */
    returned: { type: [returnedLineSchema], default: [] },

    /**
     * Which floor the goods were carried up to. `null` is "nobody said", and
     * `0` is the ground floor — two different answers, which is why there is
     * no default.
     */
    floorNo: { type: Number, default: null, min: 0, max: MAX_FLOOR },

    carrying: {
      type: [carryingChargeSchema],
      default: [],
      validate: {
        validator: (value: unknown[]) => value.length <= MAX_CARRYING_ENTRIES,
        message: `A delivery may record at most ${MAX_CARRYING_ENTRIES} carrying charges.`,
      },
    },
    /** Derived from `carrying` on every save, so a list can sum without opening it. */
    carryingTotal: { type: Number, default: 0, min: 0 },

    deliveryNote: { type: String, default: '', trim: true, maxlength: 600 },

    /** The signed copy. Its presence is what completes the delivery. */
    receivedCopy: { type: receivedCopySchema, default: null },
    /**
     * The operator's statement that the signed copy is lost — the one way a
     * delivery with goods left at the door is completed without the paper.
     * See `completionMethodFor`. Cleared when a copy is filed after all.
     */
    copyMissing: { type: Boolean, default: false },
    copyMissingReason: { type: String, default: '', trim: true, maxlength: MAX_COPY_MISSING_REASON },
    /** Written by the pre-save hook from `completionMethodFor`; nothing sets it directly. */
    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
)

const vendorCopySchema = new Schema(
  {
    vendorCode: { type: String, required: true },
    name: { type: String, required: true },
    mobile: { type: String, default: '' },
  },
  { _id: false },
)

const vehicleCopySchema = new Schema(
  {
    vehicleCode: { type: String, required: true },
    registrationNo: { type: String, required: true },
    /** The fleet's plate key, so a trip is searchable by the last digits too. */
    registrationNoKey: { type: String, required: true },
    brand: { type: String, default: '' },
    vehicleModel: { type: String, default: '' },
    ownershipType: { type: String, enum: VEHICLE_OWNERSHIP_TYPES, required: true },
  },
  { _id: false },
)

const driverCopySchema = new Schema(
  {
    driverCode: { type: String, required: true },
    name: { type: String, required: true },
    mobile: { type: String, default: '' },
    licenseNumber: { type: String, default: '' },
    licenseExpiry: { type: Date, default: null },
  },
  { _id: false },
)

/** The vehicle's assigned driver when the trip was confirmed, for comparison. */
const assignedDriverCopySchema = new Schema(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true },
    driverCode: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false },
)

const deliverySchema = new Schema(
  {
    /** `V-0007-TRIP-0012`. See `formatTripNumber`. */
    tripNumber: { type: String, required: true, unique: true, index: true },
    /** The 12 in the number above: this vendor's own running count. */
    vendorTripSerial: { type: Number, required: true, min: 1 },

    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    /**
     * Who drives **this trip**. Not necessarily the vehicle's assigned driver,
     * and choosing somebody else here never touches the assignment collection:
     * that says who is on the vehicle as a rule, this says who was on it for
     * one run. `assignedDriver` below records the rule as it stood, so the two
     * can be told apart afterwards.
     */
    driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },

    vendor: { type: vendorCopySchema, required: true },
    vehicle: { type: vehicleCopySchema, required: true },
    driver: { type: driverCopySchema, required: true },
    assignedDriver: { type: assignedDriverCopySchema, default: null },

    /** The calendar day the trip runs. Stored at UTC midnight, like every day here. */
    tripDate: { type: Date, required: true },
    note: { type: String, default: '', trim: true, maxlength: 600 },

    /**
     * What the trip cost: the vendor's rent for the lorry and the labour bill
     * for loading and unloading it. Whole taka. `null` is "not entered yet",
     * which is not the same as a trip that cost nothing. Entered on the trip's
     * own page at any point in its life — a bill usually arrives after the
     * lorry is back.
     */
    tripRent: { type: Number, default: null, min: 0, max: MAX_TRIP_CHARGE },
    labourBill: { type: Number, default: null, min: 0, max: MAX_TRIP_CHARGE },
    billUpdatedAt: { type: Date, default: null },
    billUpdatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    challans: {
      type: [tripChallanSchema],
      required: true,
      validate: {
        validator: (value: unknown[]) => value.length >= 1 && value.length <= MAX_TRIP_CHALLANS,
        message: `A trip needs between 1 and ${MAX_TRIP_CHALLANS} challans.`,
      },
    },

    /**
     * Derived from `challans` on every save and stored anyway, exactly as
     * `chargeStatus` is on a challan: the list sums and filters on them, and
     * adding up a nested array inside every query is the unindexed work M0
     * cannot afford. A pre-save hook rather than the callers keeps them in
     * step, because there are three places lines can be written.
     */
    challanCount: { type: Number, default: 0 },
    totalQty: { type: Number, default: 0 },

    /**
     * Derived from the challans by the pre-save hook below and stored anyway,
     * exactly as `challanCount` and `totalQty` are: the list filters on it,
     * and an `$expr` over a nested array on every page is the unindexed work
     * M0 cannot afford. Nothing accepts it as an input.
     */
    status: { type: String, enum: TRIP_STATUSES, default: INITIAL_TRIP_STATUS, index: true },
    /** When the last challan on the trip was signed for. Derived, like the status. */
    completedAt: { type: Date, default: null },

    /**
     * The browser's key for this confirmation, generated when the cart was
     * opened. A second press of Confirm — or a retry after a timeout on a
     * cold instance — finds the trip the first one made instead of numbering
     * a second. Unique per author, so two operators' keys can never collide.
     */
    submissionKey: { type: String, required: true },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

deliverySchema.pre('save', async function syncTotals() {
  const challans = this.challans ?? []
  this.challanCount = challans.length
  this.totalQty = challans.reduce(
    (sum, challan) => sum + (challan.lines ?? []).reduce((inner, line) => inner + line.qty, 0),
    0,
  )

  for (const challan of challans) {
    challan.carryingTotal = carryingTotalOf(challan.carrying ?? [])

    /**
     * Completion is derived here, not by the callers: a copy filed, a copy
     * removed, a full return, a lost copy declared or withdrawn — and a trip
     * edit that changes what went — all move it, and a sixth place would only
     * have to forget once. The first save to complete it records when, and
     * whoever made that save.
     */
    const method = completionMethodFor({
      hasCopy: Boolean(challan.receivedCopy),
      copyMissing: Boolean(challan.copyMissing),
      carried: (challan.lines ?? []).reduce((sum, line) => sum + line.qty, 0),
      returned: (challan.returned ?? []).reduce((sum, line) => sum + line.qty, 0),
    })

    if (!method) {
      challan.completedAt = null
      challan.completedBy = null
    } else if (!challan.completedAt) {
      challan.completedAt = new Date()
      challan.completedBy = this.updatedBy ?? this.createdBy
    }
  }

  /**
   * The status is arithmetic over the challans, written here rather than by any
   * caller — completion can be set, cleared and re-set from several places, and
   * a fourth would only have to forget once. The same reasoning `chargeStatus`
   * on a challan is written by a hook for.
   */
  this.status = tripStatusFor(challans)
  this.completedAt =
    this.status === 'Completed'
      ? challans.reduce<Date | null>((latest, challan) => {
          const at = challan.completedAt ?? null
          if (!at) {
            return latest
          }
          return !latest || at > latest ? at : latest
        }, null)
      : null
})

/** Two trips cannot share a vendor serial — the counter's second line of defence. */
deliverySchema.index({ vendorId: 1, vendorTripSerial: 1 }, { unique: true })
/** A replayed confirmation is found here rather than numbered again. */
deliverySchema.index({ createdBy: 1, submissionKey: 1 }, { unique: true })
/**
 * "Which trips carry this challan?" — asked on every cart search to say how
 * much of a challan has already gone out. Multikey over the embedded array.
 */
deliverySchema.index({ 'challans.challanId': 1 })
/**
 * "Which trip is still waiting on this challan's signed copy?" — what a
 * scanned receipt asks, and what the completion backlog counts.
 */
deliverySchema.index({ 'challans.challanId': 1, status: 1 })
/** The list: newest trip day first, optionally by status or vendor. */
deliverySchema.index({ tripDate: -1, createdAt: -1 })
deliverySchema.index({ status: 1, tripDate: -1 })
deliverySchema.index({ vendorId: 1, tripDate: -1 })
/** "Is this lorry already out?" — asked by the vehicle search. */
deliverySchema.index({ vehicleId: 1, status: 1 })
deliverySchema.index({ 'vehicle.registrationNoKey': 1 })

export type Delivery = InferSchemaType<typeof deliverySchema>

export const DeliveryModel = model('Delivery', deliverySchema)

export type DeliveryDocument = InstanceType<typeof DeliveryModel>
