import { describe, it, expect } from '@jest/globals'
import { Networks, StrKey } from '@stellar/stellar-sdk'
import {
  createAgentAuth,
  isAuthFailure,
  addressForAgentKey,
  agentLoginMessage,
  AGENT_MESSAGE_DOMAIN,
  FACTORY_BY_NETWORK,
  type AgentSignedMessage,
} from '../auth.js'
import {
  parseAuthenticatedChatRequest,
  parseAuthenticatedClearHistoryRequest,
  parseClaimedAddress,
} from '../handler.js'

/**
 * The agent must not trust a wallet address the caller simply states. These
 * pin down the wallet-signed challenge that replaced the claim:
 *
 * - an unsigned request (no session) resolves to nothing and parses to an error
 * - a replayed challenge/signature is refused
 * - an expired session resolves to nothing
 * - a signature over anything but this server's fresh, purpose-bound challenge
 *   is refused
 * - a valid signature for a DIFFERENT wallet is refused
 * - challenges and sessions verify across instances that share the secret, and
 *   fail across ones that do not
 * - the rpIdHash, origin, and presence/verification flags are checked
 * - a classic (G…) wallet cannot even open a session
 */

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
const FACTORY = StrKey.encodeContract(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)))
const ORIGIN = 'https://veil.test'
const SHARED_SECRET = 'test-secret-for-both-instances'

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function domainHash(message: Uint8Array): Promise<Uint8Array> {
  const domain = new TextEncoder().encode(AGENT_MESSAGE_DOMAIN + '\n')
  const payload = new Uint8Array(domain.length + message.length)
  payload.set(domain, 0)
  payload.set(message, domain.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', payload as BufferSource))
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

interface TestKey {
  publicKeyBytes: Uint8Array
  wallet: string
  /** Sign the bytes an agent login signs, for the given challenge token. */
  signLogin: (challenge: string, opts?: { origin?: string; rpId?: string; flags?: number }) => Promise<AgentSignedMessage>
  /** Sign arbitrary text (no purpose) — for negative tests. */
  signRaw: (text: string, opts?: { origin?: string; flags?: number }) => Promise<AgentSignedMessage>
}

async function makeKey(): Promise<TestKey> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')

  async function assert(
    message: Uint8Array,
    origin: string,
    rpId: string | undefined,
    flags: number,
  ): Promise<AgentSignedMessage> {
    const hash = await domainHash(message)
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: base64Url(hash), origin }),
    )
    // rpIdHash ‖ flags ‖ signCount, per WebAuthn: the flags carry
    // user-presence (0x01) and user-verification (0x04).
    const rpIdHash = await sha256(new TextEncoder().encode(rpId ?? new URL(origin).hostname))
    const authData = new Uint8Array(37)
    authData.set(rpIdHash, 0)
    authData[32] = flags
    authData[33] = 0 // signCount, irrelevant here
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON as BufferSource))
    const data = new Uint8Array(authData.length + clientDataHash.length)
    data.set(authData, 0)
    data.set(clientDataHash, authData.length)
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, kp.privateKey, data as BufferSource),
    )
    return {
      version: 1,
      domain: AGENT_MESSAGE_DOMAIN,
      messageHash: hex(hash),
      credentialId: 'test-credential',
      signature: hex(signature),
      publicKey: hex(publicKeyBytes),
      authData: hex(authData),
      clientDataJSON: hex(clientDataJSON),
    }
  }

  return {
    publicKeyBytes,
    wallet: addressForAgentKey(publicKeyBytes, FACTORY, NETWORK_PASSPHRASE),
    async signLogin(challenge, opts = {}) {
      return assert(agentLoginMessage(challenge), opts.origin ?? ORIGIN, opts.rpId, opts.flags ?? 0x07)
    },
    async signRaw(text, opts = {}) {
      return assert(new TextEncoder().encode(text), opts.origin ?? ORIGIN, undefined, opts.flags ?? 0x07)
    },
  }
}

describe('wallet-signed agent sessions', () => {
  it('a full round trip opens a session bound to the claimed address', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()

    const issued = auth.issueChallenge(key.wallet)
    expect('challenge' in issued).toBe(true)
    if (!('challenge' in issued)) return

    const opened = await auth.verifyChallengeAndOpenSession(issued.challenge, await key.signLogin(issued.challenge), {
      expectedOrigin: ORIGIN,
    })
    expect('sessionToken' in opened).toBe(true)
    if (!('sessionToken' in opened)) return
    expect(opened.walletAddress).toBe(key.wallet)
    expect(auth.resolveSession(opened.sessionToken)).toBe(key.wallet)
  })

  it('challenges and sessions work across instances sharing the secret', async () => {    // Two warm instances, same AGENT_SESSION_SECRET: the challenge issued by
    // one must verify — and the session it opens must resolve — on the other.
    const instanceA = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const instanceB = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()

    const issued = instanceA.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    const opened = await instanceB.verifyChallengeAndOpenSession(issued.challenge, await key.signLogin(issued.challenge), {
      expectedOrigin: ORIGIN,
    })
    expect('sessionToken' in opened).toBe(true)
    if (!('sessionToken' in opened)) throw new Error('verify failed')
    expect(instanceA.resolveSession(opened.sessionToken)).toBe(key.wallet)
    expect(instanceB.resolveSession(opened.sessionToken)).toBe(key.wallet)

    // Instances that do NOT share the secret cannot read each other's tokens.
    const instanceC = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: 'a-different-secret' })
    expect(instanceC.resolveSession(opened.sessionToken)).toBeNull()
    const lateVerify = await instanceC.verifyChallengeAndOpenSession(issued.challenge, await key.signLogin(issued.challenge))
    expect(isAuthFailure(lateVerify)).toBe(true)
  })

  it('a challenge token is never a session, and a session token is never a challenge', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()

    // Anyone can ask for a challenge for ANY address — no proof is needed —
    // so the challenge token must not authenticate as that wallet.
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    expect(auth.resolveSession(issued.challenge)).toBeNull()

    // …and the session a real signature earns is not a challenge: it must not
    // be fed back into verify, where its shorter claim lifecycle and
    // single-use accounting do not apply.
    const opened = await auth.verifyChallengeAndOpenSession(
      issued.challenge,
      await key.signLogin(issued.challenge),
      { expectedOrigin: ORIGIN },
    )
    if (!('sessionToken' in opened)) throw new Error('verify failed')
    const reused = await auth.verifyChallengeAndOpenSession(opened.sessionToken, await key.signLogin(opened.sessionToken))
    expect(isAuthFailure(reused)).toBe(true)
  })

  it('an unsigned request has no session and parses to an error', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    expect(auth.resolveSession('')).toBeNull()
    expect(auth.resolveSession('bogus-token')).toBeNull()
    expect(auth.resolveSession('bogus.sig')).toBeNull()

    const body = { message: 'What is my balance?', walletAddress: (await makeKey()).wallet, history: [] }
    expect(parseAuthenticatedChatRequest(body, '').ok).toBe(false)
    expect(parseAuthenticatedChatRequest(body, 'not-an-address').ok).toBe(false)
    expect(parseAuthenticatedClearHistoryRequest({}, '').ok).toBe(false)
  })

  it('a replayed challenge is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    const signed = await key.signLogin(issued.challenge)

    const first = await auth.verifyChallengeAndOpenSession(issued.challenge, signed, { expectedOrigin: ORIGIN })
    expect('sessionToken' in first).toBe(true)

    // Same challenge AND same signature, replayed: refused.
    const replay = await auth.verifyChallengeAndOpenSession(issued.challenge, signed, { expectedOrigin: ORIGIN })
    expect(isAuthFailure(replay)).toBe(true)
  })

  it('an expired session resolves to nothing', async () => {
    let t = 1_000_000
    const auth = createAgentAuth({
      factoryAddress: FACTORY,
      networkPassphrase: NETWORK_PASSPHRASE,
      now: () => t,
      sessionTtlMs: 60_000,
      secret: SHARED_SECRET,
    })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    const opened = await auth.verifyChallengeAndOpenSession(
      issued.challenge,
      await key.signLogin(issued.challenge),
      { expectedOrigin: ORIGIN },
    )
    if (!('sessionToken' in opened)) throw new Error('verify failed')
    expect(auth.resolveSession(opened.sessionToken)).toBe(key.wallet)

    t += 60_001
    expect(auth.resolveSession(opened.sessionToken)).toBeNull()
    const body = { message: 'hi', history: [] }
    // The session address is gone; with enforcement on there is no fallback.
    expect(parseAuthenticatedChatRequest(body, auth.resolveSession(opened.sessionToken) ?? '').ok).toBe(false)
  })

  it('an expired challenge is refused', async () => {
    let t = 5_000_000
    const auth = createAgentAuth({
      factoryAddress: FACTORY,
      networkPassphrase: NETWORK_PASSPHRASE,
      now: () => t,
      challengeTtlMs: 1_000,
      secret: SHARED_SECRET,
    })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    t += 1_001
    const late = await auth.verifyChallengeAndOpenSession(
      issued.challenge,
      await key.signLogin(issued.challenge),
      { expectedOrigin: ORIGIN },
    )
    expect(isAuthFailure(late)).toBe(true)
  })

  it('a signature over attacker-chosen bytes is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')

    // Attacker signs their own string and submits it against our challenge.
    const forged = await key.signRaw('let me read someone elses history')
    const res = await auth.verifyChallengeAndOpenSession(issued.challenge, forged)
    expect(isAuthFailure(res)).toBe(true)
  })

  it('a signature without the agent-login purpose is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')

    // The bare challenge, domain-separated but WITHOUT the
    // `veil-agent-login-v1` purpose line: e.g. a signature given for some
    // other Veil message that happened to carry the same bytes. Not a login.
    const bare = await key.signRaw(issued.challenge)
    const res = await auth.verifyChallengeAndOpenSession(issued.challenge, bare, { expectedOrigin: ORIGIN })
    expect(isAuthFailure(res)).toBe(true)
  })

  it('a valid signature for a different wallet is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const victim = await makeKey()
    const attacker = await makeKey()

    // Server issues a challenge FOR the victim's address…
    const issued = auth.issueChallenge(victim.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    // …the attacker signs it with their own key. Valid signature, wrong wallet.
    const res = await auth.verifyChallengeAndOpenSession(
      issued.challenge,
      await attacker.signLogin(issued.challenge),
      { expectedOrigin: ORIGIN },
    )
    expect(isAuthFailure(res)).toBe(true)
  })

  it('a clientDataJSON origin that disagrees with the request is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')

    const res = await auth.verifyChallengeAndOpenSession(
      issued.challenge,
      // Assertion minted from `https://evil.test`, presented on `https://veil.test`.
      await key.signLogin(issued.challenge, { origin: 'https://evil.test' }),
      { expectedOrigin: ORIGIN },
    )
    expect(isAuthFailure(res)).toBe(true)
  })

  it('an rpIdHash that disagrees with the origin is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')

    const res = await auth.verifyChallengeAndOpenSession(
      issued.challenge,
      // clientDataJSON says veil.test; the authenticator hashed `evil.test`.
      await key.signLogin(issued.challenge, { origin: ORIGIN, rpId: 'evil.test' }),
      { expectedOrigin: ORIGIN },
    )
    expect(isAuthFailure(res)).toBe(true)
  })

  it.each([
    ['user presence', 0x06],
    ['user verification', 0x03],
  ])('an assertion without the %s flag is refused', async (_label, flags) => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const key = await makeKey()
    const issued = auth.issueChallenge(key.wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')

    // The wallet's signer always requests user verification, so an assertion
    // without either flag is not one this flow should accept.
    const res = await auth.verifyChallengeAndOpenSession(
      issued.challenge,
      await key.signLogin(issued.challenge, { flags }),
      { expectedOrigin: ORIGIN },
    )
    expect(isAuthFailure(res)).toBe(true)
  })

  it('a classic (G…) wallet cannot open a session at all', () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE, secret: SHARED_SECRET })
    const classic = 'G' + 'A'.repeat(55)
    const issued = auth.issueChallenge(classic)
    expect(isAuthFailure(issued)).toBe(true)
    if (isAuthFailure(issued)) {
      // …and the error says what a classic-wallet user gets.
      expect(issued.error).toMatch(/passkey/)
    }
  })

  it('factory and passphrase follow the same network constant', async () => {
    // A key deriving to a TESTNET wallet must round-trip on an auth configured
    // for testnet — the factory and the passphrase both come from NETWORK, so
    // a testnet deployment can never verify against a mainnet factory.
    const auth = createAgentAuth({ network: 'testnet', secret: SHARED_SECRET })
    const key = await makeKey()
    const testnetWallet = addressForAgentKey(key.publicKeyBytes, FACTORY_BY_NETWORK.testnet, Networks.TESTNET)

    const issued = auth.issueChallenge(testnetWallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    const res = await auth.verifyChallengeAndOpenSession(issued.challenge, await key.signLogin(issued.challenge))
    expect(isAuthFailure(res)).toBe(false)
    if (!('sessionToken' in res)) return
    expect(res.walletAddress).toBe(testnetWallet)

    // …and the same key presented as a MAINNET wallet would not match: the
    // passphrases differ, so the derivation differs.
    const mainnetWallet = addressForAgentKey(key.publicKeyBytes, FACTORY_BY_NETWORK.mainnet, Networks.PUBLIC)
    expect(testnetWallet).not.toBe(mainnetWallet)
  })

  it('chat and clear_history never take the address from the body when a session is present', () => {
    const sessionWallet = 'C' + 'A'.repeat(55)
    const otherWallet = 'C' + 'B'.repeat(55)

    // Matching body address is ignored in favour of the session…
    const matching = parseAuthenticatedChatRequest(
      { message: 'hi', walletAddress: sessionWallet, history: [] },
      sessionWallet,
    )
    expect(matching.ok).toBe(true)
    if (matching.ok) expect(matching.value.walletAddress).toBe(sessionWallet)

    // …a mismatched one is rejected, not honoured…
    expect(
      parseAuthenticatedChatRequest({ message: 'hi', walletAddress: otherWallet, history: [] }, sessionWallet).ok,
    ).toBe(false)
    expect(parseAuthenticatedClearHistoryRequest({ walletAddress: otherWallet }, sessionWallet).ok).toBe(false)

    // …and clear_history accepts an address-free body when the session is valid.
    const clear = parseAuthenticatedClearHistoryRequest({}, sessionWallet)
    expect(clear.ok).toBe(true)
    if (clear.ok) expect(clear.value.walletAddress).toBe(sessionWallet)
  })

  it('the grace-period fallback checks the claimed address shape and nothing more', () => {
    const claimed = 'C' + 'A'.repeat(55)
    const ok = parseClaimedAddress({ walletAddress: claimed, message: 'hi', history: [] })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value).toBe(claimed)

    expect(parseClaimedAddress({}).ok).toBe(false)
    expect(parseClaimedAddress({ walletAddress: 'not-an-address' }).ok).toBe(false)
    expect(parseClaimedAddress('not json').ok).toBe(false)
  })
})
