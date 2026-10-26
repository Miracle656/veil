/**
 * @jest-environment jsdom
 *
 * Tests for initRecoveryInterceptor (lib/recovery.ts): the patch on
 * navigator.credentials.get that lets a wallet recovered from its paper phrase
 * keep signing.
 *
 * This is the no-PRF path. A phrase-recovered wallet has no authenticator at
 * all (key id 'recovery'), so there is no passkey to ask and no PRF output to
 * derive from — docs/MOBILE_PRF_FINDINGS.md records how easily "no PRF" gets
 * misread as "PRF failed". Here the recovery key answers the assertion itself,
 * and reports, as a real credential would, that it has no PRF result.
 *
 * Refusals first: missing keys, a key that does not belong to the wallet, and
 * a request with no challenge must all throw before anything is signed, and
 * must never fall through to the real authenticator.
 *
 * What is real: the module, P-256 and SHA-256 (noble), and the wallet's
 * network-namespaced storage over jsdom's localStorage / sessionStorage. What
 * is faked: navigator.credentials (no authenticator in jsdom), recorded so
 * "the passkey was never asked" can be asserted.
 *
 * No key material is printed: the private key is only ever compared, and each
 * refusal asserts its message does not contain it.
 */

import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { p256 } from '@noble/curves/nist'
import { sha256 } from '@noble/hashes/sha256'
import { bufferToHex, derToRawSignature } from '@veil/utils'
import { deriveP256KeyPair, initRecoveryInterceptor, base64url } from '../recovery'
import { walletLocal, walletSession } from '../walletStorage'
import { getNetworkName, namespaceKey } from '../network'

// The published BIP-39 test vector, and the second one as "another wallet".
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

const mine = deriveP256KeyPair(PHRASE)
const other = deriveP256KeyPair(OTHER_PHRASE)
const MY_PRIV_HEX = bufferToHex(mine.privateKey)
const MY_PUB_HEX = bufferToHex(mine.publicKey)
const OTHER_PRIV_HEX = bufferToHex(other.privateKey)

const KEY_ID = 'invisible_wallet_key_id'
const PUB = 'invisible_wallet_public_key'
const PRIV = 'invisible_wallet_recovery_private_key'

let realGet: jest.Mock
let consoleSpies: jest.SpyInstance[]

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // A fresh credentials container per test: the patch marks the function it
  // installs, so each test starts unpatched.
  realGet = jest.fn(async () => ({ id: 'real-passkey' }))
  Object.defineProperty(navigator, 'credentials', {
    value: { get: realGet },
    configurable: true,
    writable: true,
  })
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    jest.spyOn(console, m).mockImplementation(() => {}),
  )
})

afterEach(() => {
  // Nothing on these paths may write to the console: the inputs are keys.
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  }
})

/** What the recover page stores after a successful paper recovery. */
function storeRecoveredWallet(privHex = MY_PRIV_HEX, pubHex = MY_PUB_HEX) {
  walletLocal.setItem(KEY_ID, 'recovery')
  walletLocal.setItem(PUB, pubHex)
  walletSession.setItem(PRIV, privHex)
}

function request(challenge: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    publicKey: {
      challenge: challenge.buffer.slice(challenge.byteOffset, challenge.byteOffset + challenge.byteLength),
      allowCredentials: [{ id: new Uint8Array([9, 9, 9]).buffer, type: 'public-key' }],
      userVerification: 'required',
      ...extra,
    },
  } as unknown as CredentialRequestOptions
}

const challenge = sha256(new TextEncoder().encode('soroban auth entry payload'))

/** Run a refused request and return its error text, checking it leaks no key. */
async function refusal(options: CredentialRequestOptions): Promise<string> {
  const err = await navigator.credentials.get(options).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  const text = (err as Error).message
  expect(text).not.toContain(MY_PRIV_HEX)
  expect(text).not.toContain(OTHER_PRIV_HEX)
  return text
}

describe('a wallet that is not in recovery mode', () => {
  it('goes to the real authenticator, with the request untouched', async () => {
    // Breaks: every passkey wallet's signing routed through the emulator.
    walletLocal.setItem(KEY_ID, 'Y3JlZC1pZA')
    initRecoveryInterceptor()
    const options = request(challenge)
    await expect(navigator.credentials.get(options)).resolves.toEqual({ id: 'real-passkey' })
    expect(realGet).toHaveBeenCalledTimes(1)
    expect(realGet).toHaveBeenCalledWith(options)
  })

  it('ignores a recovery key left in storage', async () => {
    // Breaks: a stale recovery key answering for a passkey wallet.
    walletLocal.setItem(KEY_ID, 'Y3JlZC1pZA')
    walletLocal.setItem(PUB, MY_PUB_HEX)
    walletSession.setItem(PRIV, MY_PRIV_HEX)
    initRecoveryInterceptor()
    await navigator.credentials.get(request(challenge))
    expect(realGet).toHaveBeenCalledTimes(1)
  })
})

describe('recovery mode refuses before signing', () => {
  it('without the recovery private key', async () => {
    // Breaks: a missing key falling through to some other signer.
    walletLocal.setItem(KEY_ID, 'recovery')
    walletLocal.setItem(PUB, MY_PUB_HEX)
    initRecoveryInterceptor()
    expect(await refusal(request(challenge))).toMatch(/private key not found/)
    expect(realGet).not.toHaveBeenCalled()
  })

  it('without the wallet\'s public key', async () => {
    // Breaks: signing with no record of which wallet the key is for.
    walletLocal.setItem(KEY_ID, 'recovery')
    walletSession.setItem(PRIV, MY_PRIV_HEX)
    initRecoveryInterceptor()
    expect(await refusal(request(challenge))).toMatch(/public key not found/)
    expect(realGet).not.toHaveBeenCalled()
  })

  it('when the private key belongs to a different wallet', async () => {
    // The mismatched credential. A recovery key that does not produce the
    // stored signer would sign for the wrong wallet. Breaks: that signature
    // handed back as if it were this wallet's.
    storeRecoveredWallet(OTHER_PRIV_HEX, MY_PUB_HEX)
    initRecoveryInterceptor()
    expect(await refusal(request(challenge))).toMatch(/does not match this wallet's signer/)
    expect(realGet).not.toHaveBeenCalled()
  })

  it('when the stored private key is not a valid P-256 key at all', async () => {
    // Partially valid input: right length, impossible value. Breaks: a library
    // error that might echo the bytes it rejected.
    storeRecoveredWallet('00'.repeat(32))
    initRecoveryInterceptor()
    expect(await refusal(request(challenge))).toMatch(/does not match this wallet's signer/)
    storeRecoveredWallet('ff'.repeat(32))
    expect(await refusal(request(challenge))).toMatch(/does not match this wallet's signer/)
  })

  it('when the request has no challenge', async () => {
    // Breaks: an assertion over nothing, replayable for any transaction.
    storeRecoveredWallet()
    initRecoveryInterceptor()
    expect(await refusal({ publicKey: {} } as CredentialRequestOptions)).toMatch(/challenge is required/)
    expect(await refusal({} as CredentialRequestOptions)).toMatch(/challenge is required/)
    expect(realGet).not.toHaveBeenCalled()
  })
})

describe('recovery mode signs as the recovered wallet', () => {
  it('returns an assertion that verifies under the wallet\'s signer, through the path callers use', async () => {
    // Callers do derToRawSignature(signature) and the contract checks
    // secp256r1(sha256(authData || sha256(clientDataJSON))). Breaks: a
    // recovered wallet that can never sign anything.
    storeRecoveredWallet()
    initRecoveryInterceptor()
    const a = (await navigator.credentials.get(request(challenge))) as any
    expect(realGet).not.toHaveBeenCalled()
    expect(a.id).toBe('recovery')
    expect(a.type).toBe('public-key')

    const authData = new Uint8Array(a.response.authenticatorData)
    const clientDataJSON = new Uint8Array(a.response.clientDataJSON)
    const raw = derToRawSignature(a.response.signature)
    const message = new Uint8Array([...authData, ...sha256(clientDataJSON)])
    expect(p256.verify(raw, sha256(message), mine.publicKey, { lowS: true })).toBe(true)
    expect(p256.verify(raw, sha256(message), other.publicKey)).toBe(false)
  })

  it('binds the request\'s challenge, origin and rpId', () => {
    // Breaks: the contract's clientData checks rejecting the recovery key, or
    // an assertion that is not tied to the transaction it was asked for.
    storeRecoveredWallet()
    initRecoveryInterceptor()
    return (navigator.credentials.get(request(challenge, { rpId: 'wallet.example' })) as Promise<any>).then((a) => {
      const cd = JSON.parse(new TextDecoder().decode(new Uint8Array(a.response.clientDataJSON)))
      expect(cd).toEqual({
        type: 'webauthn.get',
        challenge: base64url(challenge),
        origin: window.location.origin,
        crossOrigin: false,
      })
      const authData = new Uint8Array(a.response.authenticatorData)
      expect(bufferToHex(authData.slice(0, 32))).toBe(bufferToHex(sha256(new TextEncoder().encode('wallet.example'))))
    })
  })

  it('defaults rpId to the page\'s hostname', async () => {
    // Breaks: a request without rpId producing an rpIdHash for no site.
    storeRecoveredWallet()
    initRecoveryInterceptor()
    const a = (await navigator.credentials.get(request(challenge))) as any
    const authData = new Uint8Array(a.response.authenticatorData)
    expect(bufferToHex(authData.slice(0, 32))).toBe(bufferToHex(sha256(new TextEncoder().encode(window.location.hostname))))
  })

  it('reports no PRF result, rather than none at all', async () => {
    // The no-PRF case. A PRF caller (sdk browserPrfEvaluator, the lock page)
    // reads getClientExtensionResults().prf. Without the method it would throw
    // a TypeError and the caller would record a PRF *error* and fall back; with
    // it, the caller sees what is true: this credential has no PRF output.
    // Breaks: "no PRF" misread as "PRF failed", or a PRF value invented for a
    // key that has none.
    storeRecoveredWallet()
    initRecoveryInterceptor()
    const a = (await navigator.credentials.get(
      request(challenge, { extensions: { prf: { eval: { first: new Uint8Array(32).buffer } } } }),
    )) as PublicKeyCredential
    expect(typeof a.getClientExtensionResults).toBe('function')
    const ext = a.getClientExtensionResults() as { prf?: { results?: { first?: unknown } } }
    expect(ext.prf?.results?.first).toBeUndefined()
    expect(realGet).not.toHaveBeenCalled()
  })

  it('a new challenge gets a new signature', async () => {
    // Breaks: one assertion reused across transactions.
    storeRecoveredWallet()
    initRecoveryInterceptor()
    const a = (await navigator.credentials.get(request(challenge))) as any
    const b = (await navigator.credentials.get(request(sha256(challenge)))) as any
    expect(bufferToHex(new Uint8Array(a.response.signature))).not.toBe(bufferToHex(new Uint8Array(b.response.signature)))
  })

  it('uses the session key first, and a legacy key kept in localStorage only when the session has none', async () => {
    // Older builds kept the recovery key in localStorage; the session copy is
    // current. Breaks: a stale persisted key overriding the one just recovered,
    // or an older install that can no longer sign after an upgrade.
    walletLocal.setItem(KEY_ID, 'recovery')
    walletLocal.setItem(PUB, MY_PUB_HEX)
    walletLocal.setItem(PRIV, OTHER_PRIV_HEX) // stale, from another wallet
    walletSession.setItem(PRIV, MY_PRIV_HEX)
    initRecoveryInterceptor()
    await expect(navigator.credentials.get(request(challenge))).resolves.toBeTruthy()

    walletSession.removeItem(PRIV)
    walletLocal.setItem(PRIV, MY_PRIV_HEX)
    await expect(navigator.credentials.get(request(challenge))).resolves.toBeTruthy()

    // And the stale one alone is still refused, not used.
    walletLocal.setItem(PRIV, OTHER_PRIV_HEX)
    expect(await refusal(request(challenge))).toMatch(/does not match/)
  })

  it('carries the requested credential id back as rawId', async () => {
    // Breaks: callers matching the assertion to the credential they asked for.
    storeRecoveredWallet()
    initRecoveryInterceptor()
    const a = (await navigator.credentials.get(request(challenge))) as any
    expect(Array.from(new Uint8Array(a.rawId))).toEqual([9, 9, 9])
  })
})

describe('installing the interceptor', () => {
  it('patches once, however many times it is called', async () => {
    // WalletProvider calls it on every mount. Breaks: nested patches, each
    // wrapping the last.
    initRecoveryInterceptor()
    const first = navigator.credentials.get
    initRecoveryInterceptor()
    expect(navigator.credentials.get).toBe(first)
    walletLocal.setItem(KEY_ID, 'Y3JlZC1pZA')
    await navigator.credentials.get(request(challenge))
    expect(realGet).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the browser has no credentials API', () => {
    // Breaks: the wallet crashing on a browser without WebAuthn.
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true, writable: true })
    expect(() => initRecoveryInterceptor()).not.toThrow()
  })

  it('reads the active network\'s slot, so a mainnet recovery is not answered by testnet\'s key', async () => {
    // Storage is per network (walletStorage.ts). Breaks: the key recovered for
    // one network signing for the other. Shown by writing the recovery under a
    // different network's suffix and confirming the active one does not see it.
    expect(getNetworkName()).toBe('testnet')
    expect(namespaceKey(KEY_ID, 'mainnet')).not.toBe(namespaceKey(KEY_ID, 'testnet'))
    localStorage.setItem(namespaceKey(KEY_ID, 'mainnet'), 'recovery')
    localStorage.setItem(namespaceKey(PUB, 'mainnet'), MY_PUB_HEX)
    sessionStorage.setItem(namespaceKey(PRIV, 'mainnet'), MY_PRIV_HEX)
    initRecoveryInterceptor()
    await navigator.credentials.get(request(challenge))
    // The active (testnet) slot has no recovery, so the real authenticator is
    // asked instead.
    expect(walletLocal.getItem(KEY_ID)).toBeNull()
    expect(realGet).toHaveBeenCalledTimes(1)
  })
})
