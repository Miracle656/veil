import { Networks, StrKey, hash as stellarHash, xdr } from '@stellar/stellar-sdk'
import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'
import { NETWORK, NETWORK_PASSPHRASE } from './network.js'

/**
 * Wallet-signed sessions for the agent.
 *
 * The agent used to decide which conversation a request belonged to from a
 * `walletAddress` the caller simply stated. Stellar addresses are public, so
 * anyone could present somebody else's and read that wallet's agent history
 * (balances, transfers) or clear it. Now the address comes from a verified
 * session instead:
 *
 *   1. `issueChallenge(walletAddress)` — the server hands out a fresh,
 *      short-lived challenge token tied to the claimed address.
 *   2. The client signs it with its passkey through the SAME path every other
 *      Veil signature uses: the SDK's `signMessage`, which hashes the bytes
 *      under the `VEIL_SIGNED_MESSAGE_V1` domain and runs the WebAuthn
 *      ceremony with that hash as the challenge. The bytes the client signs
 *      are `agentLoginMessage(challenge)` — they carry the
 *      `veil-agent-login-v1` purpose, so a signature given for any other Veil
 *      operation (or any other login) does not verify here.
 *   3. `verifyChallengeAndOpenSession(challenge, signed, context)` — the
 *      server checks the challenge is one IT signed, recently, and has not
 *      seen consumed; that the WebAuthn assertion is valid for exactly those
 *      purpose-bound bytes (a signature over an attacker-chosen string proves
 *      nothing); that the authenticator data's rpIdHash and origin match the
 *      caller, and that the user-presence and user-verification flags are set
 *      (the wallet's ceremony requires user verification); and that the
 *      assertion's public key derives to the claimed contract address. Only
 *      then does it open a session bound to that address.
 *
 * Both tokens are HMAC-signed and stateless, so any instance of the serverless
 * route can issue, verify and resolve them: the deployment sets
 * AGENT_SESSION_SECRET and every warm instance validates the other's tokens.
 * Without that secret the tokens are signed with an instance-local key — the
 * single-instance behaviour the per-instance Maps had before — and the code
 * warns so the deployment knows why a different instance would 401.
 *
 * Single-use challenges are enforced per instance (a consumed-jti cache): a
 * replayed challenge could open a second session on another instance within
 * the challenge TTL, but only whoever holds the assertion bytes can replay it,
 * and the session would still be bound to their own wallet.
 */

/** What the SDK's `signMessage` returns; verified here, never trusted. */
export interface AgentSignedMessage {
  version: number
  domain: string
  messageHash: string
  credentialId: string
  signature: string
  publicKey: string
  authData: string
  clientDataJSON: string
}

export const AGENT_MESSAGE_DOMAIN = 'VEIL_SIGNED_MESSAGE_V1'

// The purpose-bound bytes the client signs — one definition shared with the
// wallet's client bundle (see agentLogin.ts).
export { AGENT_LOGIN_PURPOSE, agentLoginMessage } from './agentLogin.js'
import { agentLoginMessage } from './agentLogin.js'

/** A challenge lives long enough for one passkey ceremony. */
export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000
/** A session lives long enough for a conversation, then needs a fresh signature. */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000

const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/

// The passkey-wallet factories, per network. Committed for the same reason the
// wallet app commits them: a fresh clone verifies without secret config.
// Overridable per-deployment via AGENT_FACTORY_ADDRESS. The factory follows the
// SAME network constant as the passphrase (NETWORK from ./network.js) — a
// deployment that sets only NEXT_PUBLIC_NETWORK=testnet gets the testnet
// factory AND the testnet passphrase, never a mismatched pair.
const FACTORY_BY_NETWORK: Record<string, string> = {
  mainnet: 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK',
  testnet: 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA',
}

export interface AgentAuthOptions {
  now?: () => number
  randomBytes?: (n: number) => Uint8Array
  factoryAddress?: string
  network?: string
  networkPassphrase?: string
  challengeTtlMs?: number
  sessionTtlMs?: number
  /**
   * HMAC secret for the stateless challenge and session tokens. Every instance
   * of the deployment must set the same one (AGENT_SESSION_SECRET) so tokens
   * issued by one warm instance validate on another. Left unset, an
   * instance-local key is used and the behaviour is the per-instance Maps the
   * route had before — with a warning, so the deployment notices.
   */
  secret?: string
}

export type AuthFailure = { ok: false; error: string }
export type ChallengeIssued = { challenge: string; expiresAt: number }
export type SessionOpened = { sessionToken: string; walletAddress: string; expiresAt: number }

/** Per-verification WebAuthn binding, supplied by the caller that saw the request. */
export interface VerifyContext {
  /** The Origin the request arrived with; clientDataJSON.origin must equal it. */
  expectedOrigin?: string
  /** The rpId the ceremony must have used; defaults to the origin's hostname. */
  expectedRpId?: string
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function defaultRandom(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n))
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto?.subtle
  if (!c) throw new Error('WebCrypto is unavailable')
  return c
}

/**
 * Re-derive the domain-separated hash the SDK signs: SHA-256 over
 * `VEIL_SIGNED_MESSAGE_V1\n` followed by the message bytes.
 */
async function domainSeparatedHash(message: Uint8Array): Promise<Uint8Array> {
  const domain = new TextEncoder().encode(AGENT_MESSAGE_DOMAIN + '\n')
  const payload = new Uint8Array(domain.length + message.length)
  payload.set(domain, 0)
  payload.set(message, domain.length)
  return new Uint8Array(await subtle().digest('SHA-256', payload as BufferSource))
}

/**
 * Full WebAuthn assertion verification, mirroring the SDK's `verifyMessage` —
 * plus the bindings a login needs and a Soroban auth entry does not have:
 * the authenticator data's rpIdHash must match the expected rpId, the
 * clientDataJSON origin must match the request's origin, and the
 * user-presence and user-verification flags must be set (the wallet's
 * ceremony always asks for user verification — a silent assertion proves
 * nobody was there).
 */
export async function verifyAgentMessage(
  message: Uint8Array,
  signed: AgentSignedMessage,
  context?: VerifyContext,
): Promise<boolean> {
  try {
    if (!signed || typeof signed !== 'object') return false
    if (signed.version !== 1 || signed.domain !== AGENT_MESSAGE_DOMAIN) return false

    const hash = await domainSeparatedHash(message)
    if (bytesToHex(hash) !== String(signed.messageHash).toLowerCase()) return false

    const authData = hexToBytes(String(signed.authData ?? ''))
    const clientDataJSON = hexToBytes(String(signed.clientDataJSON ?? ''))
    const publicKey = hexToBytes(String(signed.publicKey ?? ''))
    const signature = hexToBytes(String(signed.signature ?? ''))
    if (!authData || !clientDataJSON || !publicKey || !signature) return false
    // Uncompressed P-256 SEC1: 0x04 ‖ x ‖ y. Anything else cannot be a Veil key.
    if (publicKey.length !== 65 || publicKey[0] !== 0x04) return false
    if (signature.length !== 64) return false
    // rpIdHash (32) + flags (1) + signCount (4): anything shorter is not an
    // authenticator-data buffer this flow could have produced.
    if (authData.length < 37) return false

    let clientData: { type?: unknown; challenge?: unknown; origin?: unknown }
    try {
      clientData = JSON.parse(new TextDecoder().decode(clientDataJSON))
    } catch {
      return false
    }
    if (clientData.type !== 'webauthn.get' || typeof clientData.challenge !== 'string') return false

    // The user was present at the ceremony, and verified themselves — the
    // wallet's signer always requests user verification, so a flag without it
    // is not an assertion this flow should accept.
    const flags = authData[32]
    if (!(flags & 0x01)) return false
    if (!(flags & 0x04)) return false

    // The assertion must have been scoped to this relying party, not whatever
    // rpId an attacker's own origin would produce.
    const rpId = context?.expectedRpId ?? (context?.expectedOrigin ? new URL(context.expectedOrigin).hostname : undefined)
    if (rpId) {
      const expectedHash = new Uint8Array(await subtle().digest('SHA-256', new TextEncoder().encode(rpId) as BufferSource))
      if (bytesToHex(authData.slice(0, 32)) !== bytesToHex(expectedHash)) return false
    }

    // …and its client data must name the origin the request came from.
    if (context?.expectedOrigin && clientData.origin !== context.expectedOrigin) return false

    const challengeBytes = base64UrlDecode(clientData.challenge)
    if (bytesToHex(challengeBytes) !== bytesToHex(hash)) return false

    const clientDataHash = new Uint8Array(await subtle().digest('SHA-256', clientDataJSON as BufferSource))
    const verificationData = new Uint8Array(authData.length + clientDataHash.length)
    verificationData.set(authData, 0)
    verificationData.set(clientDataHash, authData.length)

    const key = await subtle().importKey('raw', publicKey as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ])
    return await subtle().verify({ name: 'ECDSA', hash: { name: 'SHA-256' } }, key, signature as BufferSource, verificationData as BufferSource)
  } catch {
    return false
  }
}

/**
 * The wallet's contract address is a pure function of the passkey: the
 * factory deploys with salt SHA-256(publicKey), so anyone can recompute it
 * off-chain. A signature that verifies under a key deriving to the claimed
 * address proves the signer controls that wallet.
 */
export function addressForAgentKey(publicKey: Uint8Array, factoryAddress: string, networkPassphrase: string): string {
  // stellarHash is SHA-256 over bytes; the casts mirror sdk/src/utils.ts,
  // where the same derivation lives (the SDK pins v15 types, this package v16).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sha = stellarHash as any as (input: Uint8Array) => any
  const salt = sha(Buffer.from(publicKey))
  const networkId = sha(Buffer.from(networkPassphrase))
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new (xdr.HashIdPreimageContractId as any)({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new (xdr.ContractIdPreimageFromAddress as any)({
          address: xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(factoryAddress) as any),
          salt,
        }),
      ),
    }),
  )
  const contractId = sha(preimage.toXDR())
  return StrKey.encodeContract(contractId)
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ── Stateless signed tokens ────────────────────────────────────────────────

interface TokenPayload {
  v: 1
  /** The wallet address the token is bound to. */
  a: string
  /** Expiry, epoch ms. */
  e: number
  /** Unique id, for single-use challenges and per-instance revocation. */
  n: string
  /** Issued-at, epoch ms (sessions only). */
  i?: number
}

function signToken(payload: TokenPayload, secret: Buffer): string {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const mac = createHmac('sha256', secret).update(body).digest()
  return `${body}.${base64UrlEncode(new Uint8Array(mac))}`
}

function readToken(token: unknown, secret: Buffer): TokenPayload | null {
  if (typeof token !== 'string' || !token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const given = base64UrlDecode(token.slice(dot + 1))
  const expected = createHmac('sha256', secret).update(body).digest()
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), expected)) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as TokenPayload
    if (payload?.v !== 1 || typeof payload.a !== 'string' || typeof payload.e !== 'number' || typeof payload.n !== 'string') {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export interface AgentAuth {
  issueChallenge: (walletAddress: string) => ChallengeIssued | AuthFailure
  verifyChallengeAndOpenSession: (
    challenge: string,
    signed: AgentSignedMessage,
    context?: VerifyContext,
  ) => Promise<SessionOpened | AuthFailure>
  resolveSession: (sessionToken: string) => string | null
  revokeSession: (sessionToken: string) => void
  /** For tests: how many single-use challenges/sessions are tracked locally. */
  sizes: () => { challenges: number; sessions: number }
}

export function createAgentAuth(options: AgentAuthOptions = {}): AgentAuth {
  const now = options.now ?? Date.now
  const rand = options.randomBytes ?? defaultRandom
  // ONE network constant drives the factory AND the passphrase — a deployment
  // that sets only NEXT_PUBLIC_NETWORK cannot end up with a mainnet factory
  // verifying against a testnet passphrase (or the reverse).
  const network = options.network ?? NETWORK
  const factoryAddress =
    options.factoryAddress ?? process.env.AGENT_FACTORY_ADDRESS?.trim() ?? FACTORY_BY_NETWORK[network] ?? ''
  const networkPassphrase =
    options.networkPassphrase ?? (network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC)
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS

  const secretText = options.secret ?? process.env.AGENT_SESSION_SECRET?.trim() ?? ''
  if (!secretText) {
    console.warn(
      '[agent] AGENT_SESSION_SECRET is not set: challenges and sessions are signed with an ' +
        'instance-local key, so a session opened on one warm instance will not resolve on ' +
        'another. Set the same AGENT_SESSION_SECRET on every instance of the deployment.',
    )
  }
  const secret = Buffer.from(secretText || Buffer.from(nodeRandomBytes(32)).toString('hex'), 'utf8')

  // Per-instance caches. They are best-effort bookkeeping, not the source of
  // truth — that is the HMAC signature — so a challenge consumed here stays
  // consumed, but the caches do not have to be shared for tokens to verify.
  const usedChallenges = new Map<string, number>() // jti -> expiresAt
  const revokedSessions = new Map<string, number>() // jti -> expiresAt

  function pruneCaches(): void {
    const t = now()
    for (const [k, at] of usedChallenges) if (at <= t) usedChallenges.delete(k)
    for (const [k, at] of revokedSessions) if (at <= t) revokedSessions.delete(k)
    if (usedChallenges.size > 10_000) usedChallenges.delete(usedChallenges.keys().next().value as string)
    if (revokedSessions.size > 10_000) revokedSessions.delete(revokedSessions.keys().next().value as string)
  }

  return {
    issueChallenge(walletAddress: string): ChallengeIssued | AuthFailure {
      const address = typeof walletAddress === 'string' ? walletAddress.trim() : ''
      if (!STELLAR_ADDRESS.test(address)) return { ok: false, error: 'walletAddress is not a Stellar address' }
      // Say what classic-wallet users get: a G… account has no passkey, so it
      // can never produce the signature this flow verifies. While session
      // enforcement is off (the default) it can still chat without a session;
      // once enforcement is on, a passkey (C…) wallet is required.
      if (address.startsWith('G')) {
        return {
          ok: false,
          error:
            'Classic (G…) wallets have no passkey to sign the challenge with, so they cannot open agent sessions. Use a passkey (C…) wallet.',
        }
      }
      if (!factoryAddress) return { ok: false, error: 'Agent factory address is not configured' }
      pruneCaches()
      const expiresAt = now() + challengeTtlMs
      const challenge = signToken({ v: 1, a: address, e: expiresAt, n: base64UrlEncode(rand(16)) }, secret)
      return { challenge, expiresAt }
    },

    async verifyChallengeAndOpenSession(
      challenge: string,
      signed: AgentSignedMessage,
      context?: VerifyContext,
    ): Promise<SessionOpened | AuthFailure> {
      const payload = readToken(challenge, secret)
      // A challenge this service did not sign proves nothing.
      if (!payload) return { ok: false, error: 'challenge is unknown or already used' }
      if (payload.e <= now()) return { ok: false, error: 'challenge has expired' }
      // Single-use, enforced per instance: the consumed id is remembered until
      // the challenge expires.
      if (usedChallenges.has(payload.n)) return { ok: false, error: 'challenge has already been used' }
      usedChallenges.set(payload.n, payload.e)

      // The signature must be over THIS challenge, purpose-bound as an agent
      // login — not attacker-chosen bytes, and not a signature given for
      // another Veil operation.
      if (!(await verifyAgentMessage(agentLoginMessage(challenge), signed, context))) {
        return { ok: false, error: 'signature does not match this challenge' }
      }

      // …and the signing key must derive to the address the challenge was
      // issued for. Verifying against the challenge's address is the whole check.
      const publicKey = hexToBytes(String(signed.publicKey ?? ''))
      if (!publicKey) return { ok: false, error: 'signature carries no public key' }
      let derived: string
      try {
        derived = addressForAgentKey(publicKey, factoryAddress, networkPassphrase)
      } catch {
        return { ok: false, error: 'signature carries no verifiable wallet key' }
      }
      if (derived !== payload.a) {
        return { ok: false, error: 'signature is not for this wallet' }
      }

      pruneCaches()
      const expiresAt = now() + sessionTtlMs
      const sessionToken = signToken({ v: 1, a: payload.a, i: now(), e: expiresAt, n: base64UrlEncode(rand(16)) }, secret)
      return { sessionToken, walletAddress: payload.a, expiresAt }
    },

    resolveSession(sessionToken: string): string | null {
      const payload = readToken(sessionToken, secret)
      if (!payload) return null
      if (payload.e <= now()) return null
      if (revokedSessions.has(payload.n)) return null
      return payload.a
    },

    revokeSession(sessionToken: string): void {
      const payload = readToken(sessionToken, secret)
      if (payload) revokedSessions.set(payload.n, payload.e)
    },

    sizes(): { challenges: number; sessions: number } {
      return { challenges: usedChallenges.size, sessions: revokedSessions.size }
    },
  }
}

/** Narrow an unknown failure/success union to the failure case. */
export function isAuthFailure(value: { ok?: boolean } | ChallengeIssued | SessionOpened): value is AuthFailure {
  return (value as { ok?: boolean }).ok === false
}

// Re-exported for tests and deployments that need to reason about the pairing.
export { FACTORY_BY_NETWORK }
