import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addressTerms,
  editDistance,
  fuzzyTolerance,
  normalizeLocationName,
  tightLocationKey,
} from './location.normalize'

/**
 * Normalisation is the whole of the difference between "we file the same place
 * six ways" and "we can report on it", so what matters here is not that it
 * changes things — it is exactly *which* differences it is willing to ignore.
 *
 * The tests are therefore in two halves: the differences that carry no
 * information and must be erased, and the ones that carry a place's identity
 * and must survive.
 */

describe('normalising a place name', () => {
  it('ignores case', () => {
    assert.equal(normalizeLocationName('MIRPUR'), 'mirpur')
    assert.equal(normalizeLocationName('MirPur'), 'mirpur')
  })

  it('collapses whitespace, including the leading and trailing kind', () => {
    assert.equal(normalizeLocationName('  Mirpur   Model  '), 'mirpur model')
    assert.equal(normalizeLocationName('\tSavar\n'), 'savar')
  })

  it('turns punctuation into a word break', () => {
    assert.equal(normalizeLocationName('Matlab, Dakshin'), 'matlab dakshin')
    assert.equal(normalizeLocationName('Sher-e-Bangla Nagar'), 'sher e bangla nagar')
  })

  it('drops apostrophes rather than splitting on them', () => {
    // Both spellings arrive on real paperwork, and they are one place.
    assert.equal(normalizeLocationName("Cox's Bazar"), 'coxs bazar')
    assert.equal(normalizeLocationName('Coxs Bazar'), 'coxs bazar')
    assert.equal(normalizeLocationName('Cox’s Bazar'), 'coxs bazar')
  })

  it('removes a trailing unit word in English', () => {
    assert.equal(normalizeLocationName('Mirpur Thana'), 'mirpur')
    assert.equal(normalizeLocationName('Savar Upazila'), 'savar')
    assert.equal(normalizeLocationName('Savar Upazilla'), 'savar')
    assert.equal(normalizeLocationName('Ramu Police Station'), 'ramu')
    assert.equal(normalizeLocationName('Dhaka District'), 'dhaka')
    assert.equal(normalizeLocationName('Dhaka Zilla'), 'dhaka')
  })

  it('removes a trailing unit word in Bangla, with or without the space', () => {
    assert.equal(normalizeLocationName('মিরপুর থানা'), 'মিরপুর')
    assert.equal(normalizeLocationName('মিরপুরথানা'), 'মিরপুর')
    assert.equal(normalizeLocationName('সাভার উপজেলা'), 'সাভার')
    assert.equal(normalizeLocationName('ঢাকা জেলা'), 'ঢাকা')
  })

  it('removes more than one of them', () => {
    assert.equal(normalizeLocationName('Mirpur Thana Upazila'), 'mirpur')
  })

  /**
   * The half that matters more. A normaliser that merged Matlab Dakshin with
   * Matlab Uttar would turn two real places into one, which is a worse failure
   * than never matching anything.
   */
  it('keeps every word that identifies which place it is', () => {
    assert.equal(normalizeLocationName('Matlab Dakshin'), 'matlab dakshin')
    assert.equal(normalizeLocationName('Matlab Uttar'), 'matlab uttar')
    assert.equal(normalizeLocationName('Cumilla Sadar'), 'cumilla sadar')
    assert.equal(normalizeLocationName('Sadar Dakshin'), 'sadar dakshin')
    assert.equal(normalizeLocationName('Mirpur Model'), 'mirpur model')
    assert.equal(normalizeLocationName('Tongi East'), 'tongi east')
  })

  it('never strips a value down to nothing', () => {
    // Meaningless either way, but an empty key would match every other empty
    // key in the collection, which is the one outcome that could do damage.
    assert.equal(normalizeLocationName('Thana'), 'thana')
    assert.equal(normalizeLocationName('থানা'), 'থানা')
  })

  it('leaves an empty value empty', () => {
    assert.equal(normalizeLocationName(''), '')
    assert.equal(normalizeLocationName('   '), '')
  })
})

describe('the whitespace-blind key', () => {
  it('makes spacing irrelevant', () => {
    assert.equal(tightLocationKey('Cox s Bazar'), tightLocationKey("Cox's Bazar"))
    assert.equal(tightLocationKey('Mirpur  Model'), 'mirpurmodel')
    assert.equal(tightLocationKey('MIRPURMODEL'), 'mirpurmodel')
  })
})

describe('edit distance', () => {
  it('counts the edits between two spellings', () => {
    assert.equal(editDistance('mirpur', 'mirpur'), 0)
    assert.equal(editDistance('mirpur', 'mirpor'), 1)
    assert.equal(editDistance('savar', 'sabar'), 1)
    assert.equal(editDistance('jashore', 'jessore'), 2)
  })

  it('gives up rather than measuring how far apart two different places are', () => {
    // The answer only has to be "further than the cap"; a precise number for
    // two unrelated names is of no use to anybody.
    assert.ok(editDistance('mirpur', 'chattogram', 3) > 3)
    assert.ok(editDistance('a', 'abcdefghij', 4) > 4)
  })
})

describe('how much of a typo is tolerable', () => {
  it('gives a short name no slack at all', () => {
    // There are too many four-letter thanas one edit apart: Ramu and Rama,
    // Itna and Etna. One wrong letter there is a different place.
    assert.equal(fuzzyTolerance('ramu'.length), 0)
  })

  it('gives a long one proportionally more', () => {
    assert.equal(fuzzyTolerance('savar'.length), 1)
    assert.equal(fuzzyTolerance('brahmanbaria'.length), 2)
    assert.equal(fuzzyTolerance('sherebanglanagar'.length), 3)
  })
})

describe('reading candidate terms out of an address', () => {
  it('offers every run of one to three words', () => {
    const terms = addressTerms('House 10, Road 5, Mirpur DOHS, Dhaka')

    assert.ok(terms.includes('mirpur'))
    assert.ok(terms.includes('dhaka'))
    assert.ok(terms.includes('mirpur dohs'))
    assert.ok(terms.includes('mirpur dohs dhaka'))
  })

  it('finds a three-word place name', () => {
    const terms = addressTerms('Shop 4, Coxs Bazar Sadar, Chattogram')
    assert.ok(terms.includes('coxs bazar sadar'))
  })

  it('normalises the address the same way a place name is normalised', () => {
    const terms = addressTerms('Holding 12/A, MIRPUR-1, Dhaka.')
    assert.ok(terms.includes('mirpur 1'))
    assert.ok(terms.includes('dhaka'))
  })

  it('has nothing to offer for an empty address', () => {
    assert.deepEqual(addressTerms(''), [])
  })
})
