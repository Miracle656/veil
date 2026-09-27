/**
 * @jest-environment jsdom
 *
 * Tests for the SEP-45 client (lib/sep45.ts).
 *
 * Covers the gotchas docs/SEP45_SPIKE.md found by probing the SDF test
 * anchor (camelCase vs snake_case fields, the hand-decoded VarArray), the
 * happy path (parse → sign → submit → JWT), and the failure modes the
 * acceptance criteria call out explicitly: an expired challenge, a rejected
 * signature, and a generic anchor 4xx/5xx.
 *
 * The interactive passkey ceremony itself is out of scope for a unit test —
 * `signAuthEntry` is injected, exactly like the SDK's own `authorizeEntries`
 * makes it injectable — so this exercises everything up to and after that
 * ceremony without needing real WebAuthn hardware.
 *
 * jsdom doesn't provide WebCrypto / TextEncoder / TextDecoder, but
 * `@stellar/stellar-sdk` needs them at import time — install Node's real
 * implementations first (same fix as lib/__tests__/feePayer.test.ts).
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Address, Keypair, xdr } from '@stellar/stellar-sdk'
import * as jsXdr from '@stellar/js-xdr'
import type { WebAuthnSignature } from '@veil/sdk'
import {
  fetchSep45Challenge,
  parseSep45ChallengeResponse,
  signSep45Challenge,
  submitSep45Challenge,
  Sep45Error,
  SEP45_SIGNATURE_EXPIRATION_LEDGERS,
  type Sep45Challenge,
} from '../sep45'

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
const ANCHOR_CONTRACT = 'CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX'

const AuthEntryArray = new jsXdr.VarArray(xdr.SorobanAuthorizationEntry)

function encodeEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  const writer = new jsXdr.XdrWriter()
  AuthEntryArray.write(entries, writer)
  return writer.finalize().toString('base64')
}

/** Build one SorobanAuthorizationEntry for `web_auth_verify`, signed or not. */
function authEntry(
  account: string,
  nonce: string,
  signature: xdr.ScVal,
  signatureExpirationLedger = 0,
): xdr.SorobanAuthorizationEntry {
  const address = new Address(account).toScAddress()
  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address,
      nonce: xdr.Int64.fromString(nonce),
      signatureExpirationLedger,
      signature,
    }),
  )
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(ANCHOR_CONTRACT).toScAddress(),
        functionName: 'web_auth_verify',
        args: [],
      }),
    ),
    subInvocations: [],
  })
  return new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation })
}

/** A two-entry challenge shaped like the SDF test anchor's real response. */
function buildChallenge(wallet: string, anchorSigner: string): xdr.SorobanAuthorizationEntry[] {
  const walletEntry = authEntry(wallet, '1', xdr.ScVal.scvVoid(), 0) // unsigned
  const anchorSig = xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(64, 1))])
  const anchorEntry = authEntry(anchorSigner, '2', anchorSig, 4_314_260) // already signed
  return [walletEntry, anchorEntry]
}

const WALLET = Keypair.random().publicKey()
const ANCHOR_SIGNER = Keypair.random().publicKey()

function fakeSignature(): WebAuthnSignature {
  return {
    publicKey: new Uint8Array(65).fill(4),
    authData: new Uint8Array(37).fill(1),
    // Uint8Array.from(Buffer.from(...)), not `new TextEncoder().encode(...)` —
    // the polyfilled TextEncoder installed above produces a Uint8Array from a
    // different realm than the one `nativeToScVal`'s bytes check expects under
    // jsdom, and it rejects it (see sdk/src/crypto/prf.ts for the same class
    // of cross-realm gotcha).
    clientDataJSON: Uint8Array.from(Buffer.from('{"type":"webauthn.get"}', 'utf8')),
    signature: new Uint8Array(64).fill(9),
  }
}

describe('parseSep45ChallengeResponse', () => {
  it('accepts the spec-name (snake_case) fields', () => {
    const entriesXdr = encodeEntries(buildChallenge(WALLET, ANCHOR_SIGNER))
    const parsed = parseSep45ChallengeResponse({
      authorization_entries: entriesXdr,
      network_passphrase: NETWORK_PASSPHRASE,
    })
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.networkPassphrase).toBe(NETWORK_PASSPHRASE)
  })

  it('accepts the SDF test anchor camelCase fields', () => {
    const entriesXdr = encodeEntries(buildChallenge(WALLET, ANCHOR_SIGNER))
    const parsed = parseSep45ChallengeResponse({
      authorizationEntries: entriesXdr,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.networkPassphrase).toBe(NETWORK_PASSPHRASE)
  })

  it('rejects a non-object body', () => {
    expect(() => parseSep45ChallengeResponse(null)).toThrow(Sep45Error)
    expect(() => parseSep45ChallengeResponse('nope')).toThrow(Sep45Error)
  })

  it('surfaces an anchor-reported error', () => {
    try {
      parseSep45ChallengeResponse({ error: 'unknown account' })
      throw new Error('expected parseSep45ChallengeResponse to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(Sep45Error)
      expect((err as Sep45Error).code).toBe('ANCHOR_ERROR')
    }
  })

  it('rejects a response missing both entry field names', () => {
    try {
      parseSep45ChallengeResponse({ network_passphrase: NETWORK_PASSPHRASE })
      throw new Error('expected parseSep45ChallengeResponse to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('INVALID_RESPONSE')
    }
  })

  it('rejects a response missing both network-passphrase field names', () => {
    const entriesXdr = encodeEntries(buildChallenge(WALLET, ANCHOR_SIGNER))
    try {
      parseSep45ChallengeResponse({ authorization_entries: entriesXdr })
      throw new Error('expected parseSep45ChallengeResponse to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('INVALID_RESPONSE')
    }
  })

  it('rejects malformed base64/XDR', () => {
    try {
      parseSep45ChallengeResponse({
        authorization_entries: 'not-valid-xdr!!',
        network_passphrase: NETWORK_PASSPHRASE,
      })
      throw new Error('expected parseSep45ChallengeResponse to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('INVALID_RESPONSE')
    }
  })

  it('rejects fewer than 2 entries', () => {
    const single = encodeEntries([authEntry(WALLET, '1', xdr.ScVal.scvVoid())])
    try {
      parseSep45ChallengeResponse({ authorization_entries: single, network_passphrase: NETWORK_PASSPHRASE })
      throw new Error('expected parseSep45ChallengeResponse to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('INVALID_RESPONSE')
    }
  })
})

describe('fetchSep45Challenge', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('parses a successful anchor response', async () => {
    const entriesXdr = encodeEntries(buildChallenge(WALLET, ANCHOR_SIGNER))
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ authorizationEntries: entriesXdr, networkPassphrase: NETWORK_PASSPHRASE }),
    }) as unknown as typeof fetch

    const challenge = await fetchSep45Challenge('https://testanchor.stellar.org/sep45/auth', WALLET, 'testanchor.stellar.org')
    expect(challenge.entries).toHaveLength(2)
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('account=' + encodeURIComponent(WALLET))
  })

  it('wraps a network failure as NETWORK_ERROR', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch
    try {
      await fetchSep45Challenge('https://testanchor.stellar.org/sep45/auth', WALLET, 'testanchor.stellar.org')
      throw new Error('expected fetchSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('NETWORK_ERROR')
    }
  })

  it('reports a non-2xx response as ANCHOR_ERROR', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'unknown account' }),
    }) as unknown as typeof fetch
    try {
      await fetchSep45Challenge('https://testanchor.stellar.org/sep45/auth', WALLET, 'testanchor.stellar.org')
      throw new Error('expected fetchSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('ANCHOR_ERROR')
      expect((err as Sep45Error).message).toContain('unknown account')
    }
  })

  it('reports a non-JSON body as INVALID_RESPONSE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json') },
    }) as unknown as typeof fetch
    try {
      await fetchSep45Challenge('https://testanchor.stellar.org/sep45/auth', WALLET, 'testanchor.stellar.org')
      throw new Error('expected fetchSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('INVALID_RESPONSE')
    }
  })
})

describe('signSep45Challenge', () => {
  function makeChallenge(): Sep45Challenge {
    return { entries: buildChallenge(WALLET, ANCHOR_SIGNER), networkPassphrase: NETWORK_PASSPHRASE }
  }

  it('signs only the unsigned wallet entry and leaves the anchor entry untouched', async () => {
    const challenge = makeChallenge()
    const signAuthEntry = jest.fn().mockResolvedValue(fakeSignature())

    const signed = await signSep45Challenge(challenge, signAuthEntry, 1000)

    expect(signAuthEntry).toHaveBeenCalledTimes(1) // only the wallet's entry needed signing
    expect(signed).toHaveLength(2)

    const [walletEntry, anchorEntry] = signed
    // Wallet entry: now carries a real signature and the deliberate expiration.
    const walletCred = walletEntry.credentials().address()
    expect(walletCred.signature().switch().name).toBe('scvVec')
    expect(walletCred.signatureExpirationLedger()).toBe(1000 + SEP45_SIGNATURE_EXPIRATION_LEDGERS)

    // Anchor entry: byte-for-byte unchanged (already signed by the anchor).
    expect(anchorEntry.toXDR('base64')).toBe(challenge.entries[1].toXDR('base64'))
  })

  it('honours a caller-supplied expiration window', async () => {
    const challenge = makeChallenge()
    const signAuthEntry = jest.fn().mockResolvedValue(fakeSignature())

    const [signedWallet] = await signSep45Challenge(challenge, signAuthEntry, 500, 10)

    expect(signedWallet.credentials().address().signatureExpirationLedger()).toBe(510)
  })

  it('throws SIGNATURE_REJECTED when the passkey ceremony is cancelled', async () => {
    const challenge = makeChallenge()
    const signAuthEntry = jest.fn().mockResolvedValue(null)

    try {
      await signSep45Challenge(challenge, signAuthEntry, 1000)
      throw new Error('expected signSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('SIGNATURE_REJECTED')
    }
  })

  it('throws INVALID_RESPONSE when no unsigned entry is present', async () => {
    const alreadySignedSig = xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(64, 2))])
    const challenge: Sep45Challenge = {
      entries: [authEntry(WALLET, '1', alreadySignedSig, 999), authEntry(ANCHOR_SIGNER, '2', alreadySignedSig, 999)],
      networkPassphrase: NETWORK_PASSPHRASE,
    }
    const signAuthEntry = jest.fn().mockResolvedValue(fakeSignature())

    try {
      await signSep45Challenge(challenge, signAuthEntry, 1000)
      throw new Error('expected signSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('INVALID_RESPONSE')
    }
    expect(signAuthEntry).not.toHaveBeenCalled()
  })
})

describe('submitSep45Challenge', () => {
  const originalFetch = global.fetch
  const ENDPOINT = 'https://testanchor.stellar.org/sep45/auth'

  afterEach(() => {
    global.fetch = originalFetch
  })

  function entries(): xdr.SorobanAuthorizationEntry[] {
    return buildChallenge(WALLET, ANCHOR_SIGNER)
  }

  it('returns the token on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: 'signed.jwt.token' }),
    }) as unknown as typeof fetch

    const token = await submitSep45Challenge(ENDPOINT, entries())
    expect(token).toBe('signed.jwt.token')
    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body).authorization_entries).toEqual(expect.any(String))
  })

  it('maps a 400 mentioning expiration to CHALLENGE_EXPIRED', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'challenge has expired' }),
    }) as unknown as typeof fetch

    try {
      await submitSep45Challenge(ENDPOINT, entries())
      throw new Error('expected submitSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('CHALLENGE_EXPIRED')
    }
  })

  it('maps a generic 400 to SIGNATURE_REJECTED', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid signature' }),
    }) as unknown as typeof fetch

    try {
      await submitSep45Challenge(ENDPOINT, entries())
      throw new Error('expected submitSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('SIGNATURE_REJECTED')
    }
  })

  it('maps a 401 to SIGNATURE_REJECTED', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    }) as unknown as typeof fetch

    try {
      await submitSep45Challenge(ENDPOINT, entries())
      throw new Error('expected submitSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('SIGNATURE_REJECTED')
    }
  })

  it('maps a 5xx to ANCHOR_ERROR', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'service unavailable' }),
    }) as unknown as typeof fetch

    try {
      await submitSep45Challenge(ENDPOINT, entries())
      throw new Error('expected submitSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('ANCHOR_ERROR')
    }
  })

  it('wraps a network failure as NETWORK_ERROR', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch

    try {
      await submitSep45Challenge(ENDPOINT, entries())
      throw new Error('expected submitSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('NETWORK_ERROR')
    }
  })

  it('rejects a 2xx response with no token as INVALID_RESPONSE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }) as unknown as typeof fetch

    try {
      await submitSep45Challenge(ENDPOINT, entries())
      throw new Error('expected submitSep45Challenge to throw')
    } catch (err) {
      expect((err as Sep45Error).code).toBe('INVALID_RESPONSE')
    }
  })
})

describe('SEP-45 JWT used in place of the SEP-10 token (issue #683 acceptance criterion)', () => {
  const originalFetch = global.fetch
  const WEB_AUTH_ENDPOINT = 'https://testanchor.stellar.org/sep45/auth'
  const TRANSFER_SERVER = 'https://testanchor.stellar.org/sep24'

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('the token from submitSep45Challenge authenticates a real SEP-24 deposit call', async () => {
    // 1. Anchor issues the SEP-45 challenge.
    const entriesXdr = encodeEntries(buildChallenge(WALLET, ANCHOR_SIGNER))
    const fetchMock = jest.fn()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ authorizationEntries: entriesXdr, networkPassphrase: NETWORK_PASSPHRASE }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const challenge = await fetchSep45Challenge(WEB_AUTH_ENDPOINT, WALLET, 'testanchor.stellar.org')

    // 2. The wallet signs its entry with the existing passkey signer.
    const signed = await signSep45Challenge(challenge, async () => fakeSignature(), 1_000_000)

    // 3. Anchor verifies and returns a JWT — same shape as a SEP-10 token.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: 'sep45.jwt.for-c-account' }),
    })
    const jwt = await submitSep45Challenge(WEB_AUTH_ENDPOINT, signed)
    expect(jwt).toBe('sep45.jwt.for-c-account')

    // 4. That JWT authenticates a real SEP-24 call — `initiateDeposit` takes any
    //    bearer JWT and never distinguishes SEP-10 from SEP-45, so passing this
    //    one through is the whole integration: the C-account authenticates as
    //    itself, with no fee-payer SEP-10 token involved anywhere in this flow.
    const { initiateDeposit } = await import('../sep24')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://testanchor.stellar.org/interactive/abc', id: 'txn-1' }),
    })
    const result = await initiateDeposit(TRANSFER_SERVER, { assetCode: 'USDC', account: WALLET }, jwt)

    expect(result).toEqual({ url: 'https://testanchor.stellar.org/interactive/abc', id: 'txn-1' })
    const depositCall = fetchMock.mock.calls[2]
    expect(depositCall[1].headers.Authorization).toBe(`Bearer ${jwt}`)
  })
})
