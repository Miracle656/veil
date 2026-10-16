/**
 * What a rejected transaction says to the person who sent it.
 *
 * The case that prompted this: a tester saw "Request failed with status code
 * 400" on the web Send screen. Horizon answers 400 for every rejected
 * transaction, so the status carried no information at all — the reason was in
 * the response body the client threw away. These pin the unwrapping (the shape
 * the stellar-sdk actually throws) and the rule that a non-Horizon failure is
 * left alone, because that is what lets this run ahead of the passkey handling
 * without describing a cancelled passkey as a network rejection.
 */

import { horizonErrorMessage } from '../horizonError'

/** What the stellar-sdk throws out of `submitTransaction` on a 400. */
function sdkError(result_codes: { transaction?: string; operations?: string[] }) {
  const err = new Error('Request failed with status code 400') as Error & {
    response?: { data?: unknown }
  }
  err.response = {
    data: {
      type: 'https://stellar.org/horizon-errors/transaction_failed',
      title: 'Transaction Failed',
      status: 400,
      extras: { result_codes },
    },
  }
  return err
}

describe('horizonErrorMessage', () => {
  it('reads the codes out of what the SDK actually throws', () => {
    expect(horizonErrorMessage(sdkError({ transaction: 'tx_failed', operations: ['op_no_destination'] })))
      .toBe('The destination account does not exist on this network.')
  })

  it('accepts a bare failure document too', () => {
    expect(horizonErrorMessage({ extras: { result_codes: { transaction: 'tx_bad_seq' } } }))
      .toBe('This transaction was built against a stale account state. Try again.')
  })

  // The whole point: the status code is not the message.
  it('never answers with the HTTP status', () => {
    const message = horizonErrorMessage(sdkError({ transaction: 'tx_insufficient_balance' }))
    expect(message).not.toContain('400')
    expect(message).toContain('enough XLM')
  })

  it('prefers the operation code over tx_failed, which says nothing', () => {
    expect(horizonErrorMessage(sdkError({ transaction: 'tx_failed', operations: ['op_underfunded'] })))
      .toBe("There isn't enough of that asset in the account to send.")
  })

  it('skips the operations that succeeded', () => {
    // A send with the platform fee appended: the user's payment went through
    // and ours is the one that failed.
    expect(horizonErrorMessage(sdkError({ transaction: 'tx_failed', operations: ['op_success', 'op_no_trust'] })))
      .toBe('The destination has not opted in to this asset yet.')
  })

  it('names an unrecognised code rather than inventing a meaning for it', () => {
    expect(horizonErrorMessage(sdkError({ transaction: 'tx_failed', operations: ['op_something_new'] })))
      .toBe('The network rejected this transaction (op_something_new).')
    expect(horizonErrorMessage(sdkError({ transaction: 'tx_not_a_real_code' })))
      .toBe('The network rejected this transaction (tx_not_a_real_code).')
  })

  // Returning null is what makes this safe to chain ahead of the existing
  // handling. A sentence here would relabel every cancelled passkey.
  it.each([
    ['a cancelled passkey', new DOMException('The operation was aborted', 'NotAllowedError')],
    ['a plain error', new Error('Network request failed')],
    ['a 404 with no codes', { response: { data: { status: 404, title: 'Resource Missing' } } }],
    ['nothing', null],
    ['a string', 'boom'],
  ])('leaves %s alone', (_label, value) => {
    expect(horizonErrorMessage(value)).toBeNull()
  })

  it('is null when the extras carry no result codes', () => {
    expect(horizonErrorMessage({ extras: { envelope_xdr: 'AAAA...' } })).toBeNull()
  })
})
