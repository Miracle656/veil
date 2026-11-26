/**
 * A timeout is only a cancellation when the passkey ceremony says so.
 *
 * #1183 taught the spend screens to treat a dismissed prompt as a decision. The
 * first version of that fix recognised a dismissal by looking for the words
 * "timeout", "timed out" or "dismiss" in ANY error, so an axios/Horizon timeout
 * during submission — after the passkey was already accepted — looked like the
 * user changing their mind. The screen then returned to the form with no error,
 * possibly after the transaction had been broadcast.
 *
 * These tests pin the boundary: the ceremony's own DOMException names are the
 * only timeout that counts.
 */

import {
  PASSKEY_CANCELLED_MESSAGE,
  PasskeyCeremonyError,
  classifyPasskeyError,
  isPasskeyCancellation,
  passkeyFailureMessage,
  toPasskeyCeremonyError,
} from '../passkeyOutcome'

describe('a network timeout is a failure, not a cancellation', () => {
  it('does not read axios\'s "timeout of 30000ms exceeded" as the user declining', () => {
    const error = new Error('timeout of 30000ms exceeded')

    expect(isPasskeyCancellation(error)).toBe(false)
    expect(classifyPasskeyError(error)).toBe('failed')
    expect(passkeyFailureMessage(error)).toMatch(/timeout of 30000ms exceeded/)
    expect(passkeyFailureMessage(error)).toMatch(/Nothing was sent/)
  })

  it('does not read "request timed out" from Horizon as the user declining', () => {
    const error = new Error('request timed out')

    expect(isPasskeyCancellation(error)).toBe(false)
    expect(classifyPasskeyError(error)).toBe('failed')
    expect(toPasskeyCeremonyError(error).outcome).toBe('failed')
  })

  it.each([
    new Error('Request failed with status code 504'),
    new Error('The operation was canceled.'),
    new Error('The sheet was dismissed'),
  ])('keeps a non-ceremony error a failure: %p', (error) => {
    expect(isPasskeyCancellation(error)).toBe(false)
    expect(classifyPasskeyError(error)).toBe('failed')
  })
})

describe('the ceremony\'s own cancellation is still a cancellation', () => {
  it('recognises a NotAllowedError raised by navigator.credentials.get', () => {
    const error = new DOMException(
      'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/',
      'NotAllowedError',
    )

    expect(isPasskeyCancellation(error)).toBe(true)
    expect(classifyPasskeyError(error)).toBe('cancelled')
    expect(toPasskeyCeremonyError(error).message).toBe(PASSKEY_CANCELLED_MESSAGE)
    expect(passkeyFailureMessage(error)).toBeNull()
  })

  it('recognises an AbortError', () => {
    const error = new DOMException('The operation was aborted.', 'AbortError')

    expect(isPasskeyCancellation(error)).toBe(true)
    expect(classifyPasskeyError(error)).toBe('cancelled')
  })

  it('trusts a PasskeyCeremonyError that already carries the outcome', () => {
    const error = new PasskeyCeremonyError('cancelled', PASSKEY_CANCELLED_MESSAGE)

    expect(isPasskeyCancellation(error)).toBe(true)
    expect(toPasskeyCeremonyError(error)).toBe(error)
  })
})
