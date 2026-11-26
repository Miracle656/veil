/**
 * Saying what the provider said, instead of guessing.
 *
 * The verification screens used to answer every unreadable failure with one
 * hypothesis: the name on the NIN record probably doesn't match. The provider
 * confirmed on 2026-10-14 that **the name is never checked** — only the NIN —
 * so that advice was wrong every time it was shown, and it was shown to at
 * least three testers who went off to correct a spelling nothing looked at.
 */

import { isNinSpent, ninFailureFor, NIN_FAILURES } from '../ninFailure'

describe('ninFailureFor', () => {
  it.each([
    ['invalid_nin_format'],
    ['nin_already_used'],
    ['nin_verification_failed'],
    ['kyc_provider_error'],
    ['kyc_internal_error'],
  ])('knows %s', (code) => {
    const failure = ninFailureFor(code)
    expect(failure).not.toBeNull()
    expect(failure?.title).toBeTruthy()
    expect(failure?.body).toBeTruthy()
  })

  it('is case- and whitespace-tolerant, since the code crosses two services', () => {
    expect(ninFailureFor('  NIN_ALREADY_USED ')).toBe(NIN_FAILURES['nin_already_used'])
  })

  // Null means "we do not know", and the screen then says something generic.
  // A default would reintroduce exactly the guessing this replaced.
  it.each([[undefined], [''], ['something_new']])('returns null for %s rather than guessing', (code) => {
    expect(ninFailureFor(code)).toBeNull()
  })
})

describe('isNinSpent', () => {
  // The one case with no self-service way out: retrying re-submits a number
  // the provider has already bound elsewhere.
  it('is true only for a NIN bound to another reference', () => {
    expect(isNinSpent('nin_already_used')).toBe(true)
  })

  it.each([
    ['invalid_nin_format'],
    ['nin_verification_failed'],
    ['kyc_provider_error'],
    ['kyc_internal_error'],
    [undefined],
  ])('is false for %s, which is worth retrying', (code) => {
    expect(isNinSpent(code)).toBe(false)
  })
})

describe('the copy itself', () => {
  // The whole reason this file exists.
  it('never tells anyone their name is the problem', () => {
    for (const failure of Object.values(NIN_FAILURES)) {
      expect(`${failure.title} ${failure.body}`).not.toMatch(/spelling|middle name/i)
    }
  })

  // Their side, not the user's number — and nothing is used up, which is the
  // fact that decides whether someone dares try again.
  it.each([['kyc_provider_error'], ['kyc_internal_error']])(
    'says %s is not the user\'s fault and costs nothing',
    (code) => {
      expect(ninFailureFor(code)?.body).toMatch(/nothing was used up|their side/i)
    },
  )
})
