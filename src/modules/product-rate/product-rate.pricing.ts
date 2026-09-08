import type { Rate } from './product-rate.constants'

/**
 * What a challan's product lines cost, as arithmetic.
 *
 * Pure and import-free apart from the rate type, and unit tested — which is
 * the point. This is the only place in the system that turns a rate card into
 * money, and the tiered form is the kind of rule that is either exactly right
 * or quietly wrong on every iron that has ever shipped.
 */

/** Two decimal places. Rates are whole taka today; the arithmetic is not. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * One line's charge, given how much of a tiered allowance the lines before it
 * have already spent.
 *
 * `alreadyPriced` is zero for a flat rate and for the first line of a tiered
 * one. It exists because the rate card says "ek challan e prothom 5 pics" —
 * the allowance belongs to the challan, not to the row — so a challan listing
 * two iron lines of three pieces each pays 5 at the first figure and 1 at the
 * second, exactly as it would for one line of six.
 */
export function lineAmount(rate: Rate, qty: number, alreadyPriced = 0): number {
  if (qty <= 0) {
    return 0
  }

  if (rate.kind === 'flat') {
    return round(qty * rate.amount)
  }

  const allowanceLeft = Math.max(rate.firstQty - alreadyPriced, 0)
  const atFirst = Math.min(qty, allowanceLeft)
  const atRest = qty - atFirst

  return round(atFirst * rate.firstAmount + atRest * rate.restAmount)
}

/**
 * A line waiting to be priced.
 *
 * `rateId` identifies which rate card row matched, and it is what a tiered
 * allowance is spent against — two lines of the same product and model share
 * one allowance, two different products do not share anything. A line that
 * matched nothing carries a null rate and is charged nothing, which is a
 * legitimate outcome: a product absent from the rate card is priced by a
 * person, not guessed at.
 */
export interface PriceableLine {
  rateId: string | null
  rate: Rate | null
  qty: number
}

/**
 * Every line's charge, in order.
 *
 * Order is significant and deliberately so: a tiered allowance is spent by the
 * rows in the order the challan lists them. Any other rule would need a reason
 * to prefer one line over another, and there isn't one — the total is the same
 * whichever way round it is spent, which is what actually matters.
 */
export function priceLines(lines: readonly PriceableLine[]): (number | null)[] {
  const spent = new Map<string, number>()

  return lines.map((line) => {
    if (!line.rate) {
      return null
    }

    const key = line.rateId ?? ''
    const alreadyPriced = spent.get(key) ?? 0
    spent.set(key, alreadyPriced + line.qty)

    return lineAmount(line.rate, line.qty, alreadyPriced)
  })
}

/**
 * What a set of priced lines comes to, and how much of it is missing.
 *
 * `total` is null rather than zero when nothing could be priced, because those
 * are different claims: zero is a challan that costs nothing, null is a
 * challan nobody has costed. `unpriced` is what a list needs to say "3 of 4
 * lines priced" instead of showing a total that quietly leaves a line out.
 */
export interface LineTotals {
  total: number | null
  unpriced: number
}

export function totalOf(amounts: readonly (number | null)[]): LineTotals {
  const priced = amounts.filter((amount): amount is number => amount !== null)

  return {
    total: priced.length > 0 ? round(priced.reduce((sum, amount) => sum + amount, 0)) : null,
    unpriced: amounts.length - priced.length,
  }
}
