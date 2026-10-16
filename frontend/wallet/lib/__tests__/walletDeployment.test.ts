/**
 * Telling "this wallet has never spent" from "something went wrong".
 *
 * A Veil wallet's contract is deployed on its first spend, so a brand-new
 * wallet legitimately has no contract at its address. The classifier exists to
 * recognise that, and it recognised only two of the several ways a node says
 * it — so a tester opening Passkeys on an unspent wallet was shown this,
 * verbatim, on a settings screen:
 *
 *   HostError: Error(Storage, MissingValue) … "trying to get non-existing
 *   value for contract instance" … fn_call, CCDRZY5F…, get_signers
 *
 * Classifying that as `unknown` is what let the caller carry on and read a
 * signer list that could not exist.
 */

// The module imports the Stellar SDK, which needs these before it will load
// under jsdom. Same shim the other suites here use.
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { classifyContractDataError } from '../walletDeployment'

describe('classifyContractDataError', () => {
  // Each of these is a real way a node reports an absent contract instance.
  // The first is the one a tester actually hit, in full.
  it.each([
    [
      'the storage error a tester saw',
      'Simulation failed: HostError: Error(Storage, MissingValue) Event log (newest first): 0: [Diagnostic Event] topics:[error, Error(Storage, MissingValue)], data:"trying to get non-existing value for contract instance" 1: [Diagnostic Event] topics:[fn_call, CCDRZY5F4IRZFPIOIAHOJTCURLTFF736NAFB7WU3FPTP4SJJJZWAMDOE, get_signers], data:Void',
    ],
    ['a plain not-found', 'Contract data not found'],
    ['an HTTP 404', 'Request failed with status code 404'],
    ['a bare MissingValue', 'Error(Storage, MissingValue)'],
    ['mixed case', 'ERROR(STORAGE, MISSINGVALUE)'],
  ])('recognises %s as undeployed', (_label, message) => {
    expect(classifyContractDataError(new Error(message))).toBe('undeployed')
  })

  // A network failure is NOT "this wallet has never spent", and saying so would
  // tell someone with a real, funded wallet that it does not exist.
  it.each([
    ['a network failure', 'fetch failed'],
    ['a timeout', 'The operation timed out'],
    ['a server error', 'Request failed with status code 502'],
    ['a rate limit', 'Too many requests'],
  ])('does not claim %s means undeployed', (_label, message) => {
    expect(classifyContractDataError(new Error(message))).toBe('unknown')
  })

  it('survives a non-Error being thrown', () => {
    expect(classifyContractDataError('Error(Storage, MissingValue)')).toBe('undeployed')
    expect(classifyContractDataError(undefined)).toBe('unknown')
  })
})
