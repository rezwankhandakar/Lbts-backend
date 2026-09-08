import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { embeddedModelKeys, modelMatchKeys, rateKey } from './product-rate.constants'

/**
 * Which rate card rows a challan's model could be answered by.
 *
 * This is the arithmetic behind the bug that made a fully seeded rate card
 * price nothing at all. The card names a refrigerator `1D5`; the challan names
 * the same refrigerator `WCF-1D5-GDEL-LX`. Comparing whole strings says those
 * are different products, so every line came back uncharged — and because an
 * uncharged line shows as a dash rather than an error, nothing anywhere said
 * why.
 *
 * Two kinds of test here, and as with the location matcher the second kind is
 * the important one. The first asks "does it find the row when the challan
 * writes the code the long way". The second asks "does it *refuse* to find
 * rows that merely contain the same characters" — because the card carries
 * models as short as `09`, and a substring rule would charge an air
 * conditioner rate for anything with a nine in it.
 */

describe('modelMatchKeys', () => {
  it('offers the whole model first', () => {
    assert.deepEqual(modelMatchKeys('SWG60N'), ['SWG60N'])
  })

  /** The case from the reported bug, and the reason this function exists. */
  it('offers each hyphen-separated segment of a Walton code', () => {
    assert.deepEqual(modelMatchKeys('WCF-1D5-GDEL-LX'), [
      'WCF1D5GDELLX',
      'WCF',
      '1D5',
      'GDEL',
      'LX',
    ])
  })

  it('finds the card model inside a longer code', () => {
    assert.ok(modelMatchKeys('WCF-1D5-GDEL-LX').includes(rateKey('1D5')))
    assert.ok(modelMatchKeys('WMS-SWG60N-XYZ').includes(rateKey('SWG60N')))
    assert.ok(modelMatchKeys('W-Series 25L Cooler').includes(rateKey('25L')))
  })

  it('treats spaces, underscores and slashes as separators too', () => {
    assert.deepEqual(modelMatchKeys('WCF 1D5_GDEL/LX'), [
      'WCF1D5GDELLX',
      'WCF',
      '1D5',
      'GDEL',
      'LX',
    ])
  })

  it('normalises case and punctuation the way stored keys are normalised', () => {
    assert.ok(modelMatchKeys('wcf-1d5-gdel-lx').includes('1D5'))
  })

  it('offers nothing for a model with no letters or digits in it', () => {
    assert.deepEqual(modelMatchKeys(''), [])
    assert.deepEqual(modelMatchKeys('---'), [])
  })

  it('does not repeat a key when the whole model is one segment', () => {
    assert.deepEqual(modelMatchKeys('1D5'), ['1D5'])
  })

  /**
   * The refusals. A segment is a whole part of the code and is strong
   * evidence; a substring is a coincidence, and the card is full of two-digit
   * models that would collide with almost anything.
   */
  it('does not offer a card model that merely sits inside a segment', () => {
    // Air Conditioner 09 / 12 / 18 must not be reachable from these.
    assert.ok(!modelMatchKeys('W1234-ABC').includes('12'))
    assert.ok(!modelMatchKeys('WFC-2D40-GD').includes('30'))
    // TV 43 must not be reachable from a fridge code that happens to hold 43.
    assert.ok(!modelMatchKeys('WFA-2B430-XX').includes('43'))
  })

  it('does offer a two-digit model when it really is a whole segment', () => {
    // "WSI-INVERNA-12" is an air conditioner writing the card's model plainly.
    assert.ok(modelMatchKeys('WSI-INVERNA-12').includes('12'))
  })
})

/**
 * The containment tier: card models buried inside a challan model that carries
 * no separators.
 *
 * `WCF-1D5-GDEL-LX` is answered by the segment rule. `WCF1D5GDELLX` is the
 * same product written without the hyphens, and only this can see it — which
 * is why it exists, and why every test below that *refuses* something matters
 * more than the ones that find something. A missed match costs a blank
 * somebody fills in; a wrong one is a charge nobody ever questions.
 */
describe('embeddedModelKeys', () => {
  it('finds a card model buried in an unseparated challan code', () => {
    assert.ok(embeddedModelKeys('WCF1D5GDELLX').includes('1D5'))
    assert.ok(embeddedModelKeys('WMSSWG60NXX').includes('SWG60N'))
  })

  it('returns the longest candidates first, so the most specific wins', () => {
    const keys = embeddedModelKeys('WCF1D5GDELLX')
    const lengths = keys.map((key) => key.length)
    assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a))
  })

  /**
   * The guard that matters most. `25L` is an air cooler on the card; `125L`
   * is a different capacity of a different machine, and a substring rule
   * without this would charge one as the other.
   */
  it('refuses a candidate cut out of the middle of a longer number', () => {
    assert.ok(!embeddedModelKeys('WM125LX').includes('25L'))
    assert.ok(!embeddedModelKeys('WMX1250').includes('125'))
    // The same code with a non-digit in front is a genuine match.
    assert.ok(embeddedModelKeys('WM25LX').includes('25L'))
  })

  it('refuses a candidate whose trailing digit runs into another', () => {
    assert.ok(!embeddedModelKeys('XTWG800').includes('TWG80'))
    assert.ok(embeddedModelKeys('XTWG80Y').includes('TWG80'))
  })

  it('refuses anything without both a letter and a digit', () => {
    const keys = embeddedModelKeys('ABCJETDEF')
    // Letters only: a word, not a model code.
    assert.ok(!keys.includes('JET'))
    // Digits only, and far too short to be evidence.
    assert.ok(!embeddedModelKeys('WX0912Y').includes('09'))
    assert.ok(!embeddedModelKeys('WX0912Y').includes('12'))
  })

  it('refuses candidates shorter than three characters', () => {
    assert.ok(embeddedModelKeys('WCF1D5GDELLX').every((key) => key.length >= 3))
  })

  it('offers nothing for a string too short or too long to be a code', () => {
    assert.deepEqual(embeddedModelKeys('X1'), [])
    assert.deepEqual(embeddedModelKeys('A1'.repeat(40)), [])
  })

  it('normalises punctuation and case the way stored keys are normalised', () => {
    assert.ok(embeddedModelKeys('wcf1d5gdellx').includes('1D5'))
  })
})
