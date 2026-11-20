import { describe, it, expect } from '@jest/globals'
import { StrKey } from '@stellar/stellar-sdk'
import {
  createAgentAuth,
  isAuthFailure,
  verifyAgentMessage,
  addressForAgentKey,
  AGENT_MESSAGE_DOMAIN,
  type AgentSignedMessage,
} from '../auth.js'
import { parseAuthenticatedChatRequest, parseAuthenticatedClearHistoryRequest } from '../handler.js'

/**
 * The agent must not trust a wallet address the caller simply states. These
 * pin down the wallet-signed challenge that replaced the claim:
 *
 * - an unsigned request (no session) resolves to nothing and parses to an error
 * - a replayed challenge/signature is refused
 * - an expired session resolves to nothing
 * - a signature over anything but this server's fresh challenge is refused
 * - a valid signature for a DIFFERENT wallet is refused
 */

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
const FACTORY = StrKey.encodeContract(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)))

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

interface TestKey {
  publicKeyBytes: Uint8Array
  sign: (challenge: Uint8Array) => Promise<AgentSignedMessage>
}

async function makeKey(): Promise<TestKey> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return {
    publicKeyBytes,
    async sign(challenge: Uint8Array): Promise<AgentSignedMessage> {
      const hash = await domainHash(challenge)
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.get', challenge: base64Url(hash), origin: 'https://veil.test' }),
      )
      const authData = new Uint8Array(37).fill(7)
      const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON as BufferSource))
      const data = new Uint8Array(authData.length + clientDataHash.length)
      data.set(authData, 0)
      data.set(clientDataHash, authData.length)
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, kp.privateKey, data as BufferSource))
      const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
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
    },
  }
}

function walletFor(key: TestKey): string {
  return addressForAgentKey(key.publicKeyBytes, FACTORY, NETWORK_PASSPHRASE)
}

describe('wallet-signed agent sessions', () => {
  it('a full round trip opens a session bound to the claimed address', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE })
    const key = await makeKey()
    const wallet = walletFor(key)

    const issued = auth.issueChallenge(wallet)
    expect('challenge' in issued).toBe(true)
    if (!('challenge' in issued)) return

    const opened = await auth.verifyChallengeAndOpenSession(issued.challenge, await key.sign(Buffer.from(issued.challenge, 'base64url')))
    expect('sessionToken' in opened).toBe(true)
    if (!('sessionToken' in opened)) return
    expect(opened.walletAddress).toBe(wallet)
    expect(auth.resolveSession(opened.sessionToken)).toBe(wallet)
  })

  it('an unsigned request has no session and parses to an error', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE })
    expect(auth.resolveSession('')).toBeNull()
    expect(auth.resolveSession('bogus-token')).toBeNull()

    const body = { message: 'What is my balance?', walletAddress: walletFor(await makeKey()), history: [] }
    expect(parseAuthenticatedChatRequest(body, '').ok).toBe(false)
    expect(parseAuthenticatedChatRequest(body, 'not-an-address').ok).toBe(false)
    expect(parseAuthenticatedClearHistoryRequest({}, '').ok).toBe(false)
  })

  it('a replayed challenge is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE })
    const key = await makeKey()
    const wallet = walletFor(key)
    const issued = auth.issueChallenge(wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    const challengeBytes = Buffer.from(issued.challenge, 'base64url')
    const signed = await key.sign(challengeBytes)

    const first = await auth.verifyChallengeAndOpenSession(issued.challenge, signed)
    expect('sessionToken' in first).toBe(true)

    // Same challenge AND same signature, replayed: refused.
    const replay = await auth.verifyChallengeAndOpenSession(issued.challenge, signed)
    expect(isAuthFailure(replay)).toBe(true)
  })

  it('an expired session resolves to nothing', async () => {
    let t = 1_000_000
    const auth = createAgentAuth({
      factoryAddress: FACTORY,
      networkPassphrase: NETWORK_PASSPHRASE,
      now: () => t,
      sessionTtlMs: 60_000,
    })
    const key = await makeKey()
    const wallet = walletFor(key)
    const issued = auth.issueChallenge(wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    const opened = await auth.verifyChallengeAndOpenSession(issued.challenge, await key.sign(Buffer.from(issued.challenge, 'base64url')))
    if (!('sessionToken' in opened)) throw new Error('verify failed')
    expect(auth.resolveSession(opened.sessionToken)).toBe(wallet)

    t += 60_001
    expect(auth.resolveSession(opened.sessionToken)).toBeNull()
    const body = { message: 'hi', history: [] }
    // The session address is gone; callers cannot fall back to the body.
    expect(parseAuthenticatedChatRequest(body, auth.resolveSession(opened.sessionToken) ?? '').ok).toBe(false)
  })

  it('an expired challenge is refused', async () => {
    let t = 5_000_000
    const auth = createAgentAuth({
      factoryAddress: FACTORY,
      networkPassphrase: NETWORK_PASSPHRASE,
      now: () => t,
      challengeTtlMs: 1_000,
    })
    const key = await makeKey()
    const wallet = walletFor(key)
    const issued = auth.issueChallenge(wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    t += 1_001
    const late = await auth.verifyChallengeAndOpenSession(issued.challenge, await key.sign(Buffer.from(issued.challenge, 'base64url')))
    expect(isAuthFailure(late)).toBe(true)
  })

  it('a signature over attacker-chosen bytes is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE })
    const key = await makeKey()
    const wallet = walletFor(key)
    const issued = auth.issueChallenge(wallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')

    // Attacker signs their own string and submits it against our challenge.
    const forged = await key.sign(new TextEncoder().encode('let me read someone elses history'))
    const res = await auth.verifyChallengeAndOpenSession(issued.challenge, forged)
    expect(isAuthFailure(res)).toBe(true)
    expect(verifyAgentMessage(Buffer.from(issued.challenge, 'base64url'), forged)).resolves.toBe(false)
  })

  it('a valid signature for a different wallet is refused', async () => {
    const auth = createAgentAuth({ factoryAddress: FACTORY, networkPassphrase: NETWORK_PASSPHRASE })
    const victim = await makeKey()
    const attacker = await makeKey()
    const victimWallet = walletFor(victim)

    // Server issues a challenge FOR the victim's address…
    const issued = auth.issueChallenge(victimWallet)
    if (!('challenge' in issued)) throw new Error('challenge issue failed')
    // …the attacker signs it with their own key. Valid signature, wrong wallet.
    const res = await auth.verifyChallengeAndOpenSession(issued.challenge, await attacker.sign(Buffer.from(issued.challenge, 'base64url')))
    expect(isAuthFailure(res)).toBe(true)
  })

  it('chat and clear_history never take the address from the body', () => {
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
})
