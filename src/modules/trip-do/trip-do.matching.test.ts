import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { customerMatch, editDistance, modelMatch } from './trip-do.matching'

/**
 * What the Trip DO picker treats as the same, close, or different. The
 * refusals matter as much as the matches: a different model offered as close
 * is a line somebody links without reading.
 */

describe('modelMatch', () => {
  it('is exact when only spacing and punctuation differ', () => {
    assert.equal(modelMatch('WFE-2H2-GDEN', 'wfe 2h2 gden').level, 'exact')
  })

  it('is close when one model carries the other', () => {
    assert.equal(modelMatch('WFE-2H2-GDEN', 'WFE-2H2-GDEN-XX').level, 'close')
    assert.equal(modelMatch('WCF1D5GDELLX', '1D5-GDEL').level, 'close')
  })

  it('is close a letter or two apart', () => {
    assert.equal(modelMatch('WFE-2H2-GDEN', 'WFE-2H2-GDFN').level, 'close')
  })

  it('is close when most segments agree', () => {
    assert.equal(modelMatch('WFE-2H2-GDEN-LX', 'WFE-2H2-GDEN-SC').level, 'close')
  })

  it('keeps unrelated models apart', () => {
    assert.equal(modelMatch('WFE-2H2-GDEN', 'SWG-60N').level, 'different')
    assert.equal(modelMatch('WSI-KRYSTAL-18C', 'WFE-2H2-GDEN').level, 'different')
  })

  it('never calls a short code inside a long one close', () => {
    assert.equal(modelMatch('09', 'WSI-09-INVERNA').level, 'different')
  })

  it('treats a blank model as no evidence', () => {
    assert.equal(modelMatch('', 'WFE-2H2-GDEN').level, 'different')
  })
})

describe('customerMatch', () => {
  it('is exact once case, punctuation and honorifics are set aside', () => {
    assert.equal(customerMatch('Md. Arif Hossain', 'ARIF HOSSAIN').level, 'exact')
  })

  it('is close when one name is inside the other', () => {
    assert.equal(customerMatch('Arif Hossain', 'Arif Hossain Electronics').level, 'close')
  })

  it('is close a spelling apart', () => {
    assert.equal(customerMatch('Arif Hossain', 'Arif Hossen').level, 'close')
  })

  it('matches Bangla names with their vowel signs intact', () => {
    assert.equal(customerMatch('মোঃ আরিফ হোসেন', 'আরিফ হোসেন').level, 'close')
  })

  it('keeps different customers apart', () => {
    assert.equal(customerMatch('Arif Hossain', 'Karim Traders').level, 'different')
  })

  it('treats a blank name as no evidence', () => {
    assert.equal(customerMatch('', 'Arif Hossain').level, 'different')
  })
})

describe('editDistance', () => {
  it('counts insertions, deletions and substitutions', () => {
    assert.equal(editDistance('HOSSAIN', 'HOSSEN'), 2)
    assert.equal(editDistance('', 'ABC'), 3)
  })
})
