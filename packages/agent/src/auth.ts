import { StrKey, hash as stellarHash, xdr } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from './network.js'

/**
 * Wallet-signed sessions for the agent.
 *
 * The agent used to decide which conversation a request belonged to from a
 * wallet address the caller simply stated. Stellar addresses are public, so
 * anyone could present somebody else's and read that wallet's agent history
 * (balances, transfers) or clear it. Now the address comes from a verified
 * session instead:
 *
 *   1. `issueChallenge(walletAddress)` — the server hands out a fresh,
 *      single-use nonce tied to the claimed address.
 *   2. The client signs the nonce with its passkey through the SAME path
 *      every other Veil signature uses: the SDK's `signMessage`, which hashes
 *      the bytes under the `VEIL_SIGNED_MESSAGE_V1` domain and runs the
 *      WebAuthn ceremony with that hash as the challenge.
 *   3. `verifyChallengeAndOpenSession(challenge, signed)` — the server checks
 *      the challenge is one it issued, recently, and has not seen used; that
 *      the WebAuthn assertion is valid for exactly those challenge bytes (a
 *      signature over an attacker-chosen string proves nothing); and that the
 *      assertion's public key derives to the claimed contract address. Only
 *      then does it open a session bound to that address.
 *
 * Afterwards callers present the session token and never a wallet address:
 * chat and clear_history resolve the address from the session. A request
 * carrying someone else's address cannot read or clear their history, because
 * there is no address in the request to lie about.
 *
 * Stores are in-memory with expiry, so on serverless they are per-instance —
 * the same caveat `createRateLimiter` in handler.ts documents. Sessions also
 * expire by time, so a stolen token stops working on its own.
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

/** A challenge lives long enough for one passkey ceremony. */
export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000
/** A session lives long enough for a conversation, then needs a fresh signature. */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000

const CHALLENGE_BYTES = 32
const SESSION_TOKEN_BYTES = 32

const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/

// The passkey-wallet factories, per network. Committed for the same reason the
// wallet app commits them: a fresh clone verifies without secret config.
// Overridable per-deployment via AGENT_FACTORY_ADDRESS.
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
}

export type AuthFailure = { ok: false; error: string }
export type ChallengeIssued = { challenge: string; expiresAt: number }
export type SessionOpened = { sessionToken: string; walletAddress: string; expiresAt: number }

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
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto?.subtle
  if (!c) throw new Error('WebCrypto is unavailable')
  return c
}

/**
 * Re-derive the domain-separated hash the SDK signs: SHA-256 over
 * `VEIL_SIGNED_MESSAGE_V1\n` followed by the raw challenge bytes.
 */
async function domainSeparatedHash(message: Uint8Array): Promise<Uint8Array> {
  const domain = new TextEncoder().encode(AGENT_MESSAGE_DOMAIN + '\n')
  const payload = new Uint8Array(domain.length + message.length)
  payload.set(domain, 0)
  payload.set(message, domain.length)
  return new Uint8Array(await subtle().digest('SHA-256', payload as BufferSource))
}

/**
 * Full WebAuthn assertion verification, mirroring the SDK's `verifyMessage`:
 * the signed hash must equal this challenge's hash (binding the signature to
 * bytes the server chose), clientDataJSON must carry that hash as its
 * challenge with a `webauthn.get` ceremony, and the P-256 signature must
 * verify over `authData || SHA-256(clientDataJSON)`.
 */
export async function verifyAgentMessage(message: Uint8Array, signed: AgentSignedMessage): Promise<boolean> {
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

    let clientData: { type?: unknown; challenge?: unknown }
    try {
      clientData = JSON.parse(new TextDecoder().decode(clientDataJSON))
    } catch {
      return false
    }
    if (clientData.type !== 'webauthn.get' || typeof clientData.challenge !== 'string') return false

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

interface ChallengeRecord {
  walletAddress: string
  expiresAt: number
  used: boolean
}

interface SessionRecord {
  walletAddress: string
  expiresAt: number
}

export interface AgentAuth {
  issueChallenge: (walletAddress: string) => ChallengeIssued | AuthFailure
  verifyChallengeAndOpenSession: (
    challenge: string,
    signed: AgentSignedMessage,
  ) => Promise<SessionOpened | AuthFailure>
  resolveSession: (sessionToken: string) => string | null
  revokeSession: (sessionToken: string) => void
  /** For tests: how many live challenges/sessions are held. */
  sizes: () => { challenges: number; sessions: number }
}

export function createAgentAuth(options: AgentAuthOptions = {}): AgentAuth {
  const now = options.now ?? Date.now
  const rand = options.randomBytes ?? defaultRandom
  const network = options.network ?? process.env.STELLAR_NETWORK?.trim().toLowerCase() ?? 'mainnet'
  const factoryAddress =
    options.factoryAddress ?? process.env.AGENT_FACTORY_ADDRESS?.trim() ?? FACTORY_BY_NETWORK[network] ?? ''
  const networkPassphrase = options.networkPassphrase ?? NETWORK_PASSPHRASE
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS

  const challenges = new Map<string, ChallengeRecord>()
  const sessions = new Map<string, SessionRecord>()

  function prune(): void {
    const t = now()
    for (const [k, v] of challenges) if (v.expiresAt <= t) challenges.delete(k)
    for (const [k, v] of sessions) if (v.expiresAt <= t) sessions.delete(k)
    if (challenges.size > 10_000) challenges.delete(challenges.keys().next().value as string)
    if (sessions.size > 10_000) sessions.delete(sessions.keys().next().value as string)
  }

  return {
    issueChallenge(walletAddress: string): ChallengeIssued | AuthFailure {
      const address = typeof walletAddress === 'string' ? walletAddress.trim() : ''
      if (!STELLAR_ADDRESS.test(address)) return { ok: false, error: 'walletAddress is not a Stellar address' }
      if (!factoryAddress) return { ok: false, error: 'Agent factory address is not configured' }
      prune()
      const challenge = base64UrlEncode(rand(CHALLENGE_BYTES))
      challenges.set(challenge, { walletAddress: address, expiresAt: now() + challengeTtlMs, used: false })
      return { challenge, expiresAt: now() + challengeTtlMs }
    },

    async verifyChallengeAndOpenSession(challenge: string, signed: AgentSignedMessage): Promise<SessionOpened | AuthFailure> {
      const record = typeof challenge === 'string' ? challenges.get(challenge) : undefined
      // A challenge the server never issued — or already consumed — proves nothing.
      if (!record) return { ok: false, error: 'challenge is unknown or already used' }
      if (record.used) {
        challenges.delete(challenge)
        return { ok: false, error: 'challenge has already been used' }
      }
      if (record.expiresAt <= now()) {
        challenges.delete(challenge)
        return { ok: false, error: 'challenge has expired' }
      }
      // Single-use: consume before verifying, so a concurrent replay cannot win.
      record.used = true
      challenges.delete(challenge)

      let challengeBytes: Uint8Array
      try {
        challengeBytes = base64UrlDecode(challenge)
      } catch {
        return { ok: false, error: 'challenge is malformed' }
      }
      if (challengeBytes.length !== CHALLENGE_BYTES) return { ok: false, error: 'challenge is malformed' }

      // The signature must be over THIS challenge, not attacker-chosen bytes.
      if (!(await verifyAgentMessage(challengeBytes, signed))) {
        return { ok: false, error: 'signature does not match this challenge' }
      }

      // …and the signing key must derive to the address the challenge was
      // issued for. Verifying against the claimed address is the whole check.
      const publicKey = hexToBytes(String(signed.publicKey ?? ''))
      if (!publicKey) return { ok: false, error: 'signature carries no public key' }
      let derived: string
      try {
        derived = addressForAgentKey(publicKey, factoryAddress, networkPassphrase)
      } catch {
        return { ok: false, error: 'signature carries no verifiable wallet key' }
      }
      if (derived !== record.walletAddress) {
        return { ok: false, error: 'signature is not for this wallet' }
      }

      prune()
      const sessionToken = base64UrlEncode(rand(SESSION_TOKEN_BYTES))
      const expiresAt = now() + sessionTtlMs
      sessions.set(sessionToken, { walletAddress: record.walletAddress, expiresAt })
      return { sessionToken, walletAddress: record.walletAddress, expiresAt }
    },

    resolveSession(sessionToken: string): string | null {
      if (typeof sessionToken !== 'string' || !sessionToken) return null
      const record = sessions.get(sessionToken)
      if (!record) return null
      if (record.expiresAt <= now()) {
        sessions.delete(sessionToken)
        return null
      }
      return record.walletAddress
    },

    revokeSession(sessionToken: string): void {
      if (typeof sessionToken === 'string' && sessionToken) sessions.delete(sessionToken)
    },

    sizes(): { challenges: number; sessions: number } {
      return { challenges: challenges.size, sessions: sessions.size }
    },
  }
}

/** Narrow an unknown failure/success union to the failure case. */
export function isAuthFailure(value: { ok?: boolean } | ChallengeIssued | SessionOpened): value is AuthFailure {
  return (value as { ok?: boolean }).ok === false
}
