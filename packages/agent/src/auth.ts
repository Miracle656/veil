import { randomBytes, createHash, webcrypto } from 'crypto'
import { Keypair, Networks, StrKey, xdr, hash as stellarHash } from '@stellar/stellar-sdk'

const subtle = webcrypto.subtle

export const DEFAULT_CHALLENGE_TTL_MS = 2 * 60 * 1_000
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000
export const MAX_PENDING_CHALLENGES = 10_000
export const MAX_ACTIVE_SESSIONS = 10_000

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/
const STELLAR_CONTRACT = /^C[A-Z2-7]{55}$/
export const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/

const WEBAUTHN_DOMAIN_PREFIX = new TextEncoder().encode('VEIL_SIGNED_MESSAGE_V1\n')

export interface ChallengeRecord {
  challenge: string
  walletAddress: string
  issuedAt: number
  expiresAt: number
}

export interface AgentSession {
  sessionToken: string
  walletAddress: string
  feePayerAddress?: string
  issuedAt: number
  expiresAt: number
}

export interface WebAuthnChallengeProof {
  /** Uncompressed P-256 public key (65 bytes = 130 hex chars starting with 04). */
  publicKey: string
  /** 64-byte raw (r || s) or ASN.1 DER P-256 ECDSA signature, hex-encoded. */
  signature: string
  /** WebAuthn authenticatorData bytes, hex-encoded (optional for raw P-256 proofs). */
  authData?: string
  /** WebAuthn clientDataJSON bytes, hex-encoded (optional for raw P-256 proofs). */
  clientDataJSON?: string
  /** Soroban wallet factory contract ID ("C...") used to derive the wallet address. */
  factoryId?: string
  /** Stellar network passphrase used when deriving the wallet contract address. */
  networkPassphrase?: string
}

export interface VerifyChallengeInput {
  walletAddress: string
  challenge: string
  /** Hex or base64 signature (Ed25519 for G... accounts, or P-256 for C... wallets). */
  signature?: string
  /** Optional fee-payer G... account to bind to the authenticated session. */
  feePayerAddress?: string
  /** WebAuthn / P-256 proof fields for C... contract wallets. */
  publicKey?: string
  authData?: string
  clientDataJSON?: string
  factoryId?: string
  networkPassphrase?: string
  /** Optional nested SignedMessage object produced by @veil/sdk signMessage(). */
  signedMessage?: WebAuthnChallengeProof
}

export type ChallengeIssueResult =
  | { ok: true; challenge: string; walletAddress: string; expiresAt: number }
  | { ok: false; error: string }

export type SessionVerifyResult =
  | { ok: true; session: AgentSession }
  | { ok: false; error: string }

export interface AgentAuthOptions {
  challengeTtlMs?: number
  sessionTtlMs?: number
  maxChallenges?: number
  maxSessions?: number
  now?: () => number
  factoryContractIds?: string[]
  networkPassphrases?: string[]
}

export interface AgentAuthManager {
  issueChallenge: (walletAddress: unknown) => ChallengeIssueResult
  verifyChallenge: (input: unknown) => Promise<SessionVerifyResult>
  verifySession: (sessionToken: unknown) => SessionVerifyResult
  revokeSession: (sessionToken: unknown) => void
  challenges: Map<string, ChallengeRecord>
  sessions: Map<string, AgentSession>
}

/**
 * Canonical challenge text signed by a wallet to prove ownership of `walletAddress`.
 */
export function buildChallengePayload(walletAddress: string, challenge: string): string {
  return `VEIL_AGENT_AUTH_V1\n${walletAddress}\n${challenge}`
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, '')
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null
  return new Uint8Array(Buffer.from(clean, 'hex'))
}

function decodeSignatureBytes(sig: string): Buffer | null {
  const trimmed = sig.trim()
  if (!trimmed) return null
  const hex = hexToBytes(trimmed)
  if (hex) return Buffer.from(hex)
  try {
    const buf = Buffer.from(trimmed, 'base64')
    return buf.length > 0 ? buf : null
  } catch {
    return null
  }
}

function base64UrlToBytes(b64url: string): Uint8Array | null {
  try {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
    const pad = (4 - (b64.length % 4)) % 4
    return new Uint8Array(Buffer.from(b64 + '='.repeat(pad), 'base64'))
  } catch {
    return null
  }
}

function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function domainSeparatedHash(message: Uint8Array): Uint8Array {
  const payload = new Uint8Array(WEBAUTHN_DOMAIN_PREFIX.length + message.length)
  payload.set(WEBAUTHN_DOMAIN_PREFIX, 0)
  payload.set(message, WEBAUTHN_DOMAIN_PREFIX.length)
  return sha256Bytes(payload)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Convert an ASN.1 DER-encoded ECDSA P-256 signature to 64-byte IEEE P1363 (r || s)
 * format for WebCrypto `subtle.verify`. If already 64 bytes, returns as-is.
 */
function toRawP256Signature(sigBytes: Uint8Array): Uint8Array | null {
  if (sigBytes.length === 64) return sigBytes
  if (sigBytes.length < 8 || sigBytes[0] !== 0x30) return null
  let offset = 2
  if (sigBytes[offset] !== 0x02) return null
  offset++
  const rLen = sigBytes[offset++]
  if (offset + rLen > sigBytes.length) return null
  const rRaw = sigBytes.slice(offset, offset + rLen)
  offset += rLen
  if (sigBytes[offset] !== 0x02) return null
  offset++
  const sLen = sigBytes[offset++]
  if (offset + sLen > sigBytes.length) return null
  const sRaw = sigBytes.slice(offset, offset + sLen)

  const pad32 = (part: Uint8Array): Uint8Array | null => {
    let start = 0
    while (start < part.length - 32 && part[start] === 0) start++
    const trimmed = part.slice(start)
    if (trimmed.length > 32) return null
    const out = new Uint8Array(32)
    out.set(trimmed, 32 - trimmed.length)
    return out
  }

  const r = pad32(rRaw)
  const s = pad32(sRaw)
  if (!r || !s) return null
  const out = new Uint8Array(64)
  out.set(r, 0)
  out.set(s, 32)
  return out
}

/**
 * Deterministically derive the Soroban contract address ("C...") for a Veil passkey
 * wallet from its factory contract ID, 65-byte uncompressed P-256 public key, and
 * network passphrase (mirrors `computeWalletAddress` in `@veil/sdk`).
 */
export function deriveContractWalletAddress(
  factoryId: string,
  publicKeyBytes: Uint8Array,
  networkPassphrase: string = Networks.TESTNET,
): string {
  const salt = stellarHash(Buffer.from(publicKeyBytes))
  const networkId = stellarHash(Buffer.from(networkPassphrase))
  const factoryHash = StrKey.decodeContract(factoryId)

  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      networkId: networkId as any,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          address: xdr.ScAddress.scAddressTypeContract(factoryHash as any),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          salt: salt as any,
        }),
      ),
    }),
  )

  const contractId = stellarHash(preimage.toXDR())
  return StrKey.encodeContract(contractId)
}

function verifyEd25519Ownership(
  walletAddress: string,
  challenge: string,
  signature: string,
): boolean {
  if (!STELLAR_ACCOUNT.test(walletAddress)) return false
  const sigBuf = decodeSignatureBytes(signature)
  if (!sigBuf || sigBuf.length !== 64) return false

  try {
    const kp = Keypair.fromPublicKey(walletAddress)
    const canonical = Buffer.from(buildChallengePayload(walletAddress, challenge), 'utf8')
    if (kp.verify(canonical, sigBuf)) return true
    const raw = Buffer.from(challenge, 'utf8')
    return kp.verify(raw, sigBuf)
  } catch {
    return false
  }
}

async function verifyContractPasskeyOwnership(
  walletAddress: string,
  challenge: string,
  proof: WebAuthnChallengeProof,
  allowedFactories: string[],
  allowedPassphrases: string[],
): Promise<boolean> {
  if (!STELLAR_CONTRACT.test(walletAddress)) return false
  const publicKeyBytes = hexToBytes(proof.publicKey)
  if (!publicKeyBytes || publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
    return false
  }

  const rawSigInput = hexToBytes(proof.signature) ?? decodeSignatureBytes(proof.signature)
  if (!rawSigInput) return false
  const signatureBytes = toRawP256Signature(new Uint8Array(rawSigInput))
  if (!signatureBytes) return false

  // Candidate factory IDs and passphrases to check deterministic contract derivation
  const factories = new Set<string>(allowedFactories.filter((f) => StrKey.isValidContract(f)))
  if (proof.factoryId && StrKey.isValidContract(proof.factoryId.trim())) {
    if (allowedFactories.length === 0 || allowedFactories.includes(proof.factoryId.trim())) {
      factories.add(proof.factoryId.trim())
    }
  }

  const passphrases = new Set<string>(allowedPassphrases)
  if (proof.networkPassphrase && allowedPassphrases.includes(proof.networkPassphrase)) {
    passphrases.add(proof.networkPassphrase)
  }

  let addressMatched = false
  for (const factoryId of factories) {
    for (const passphrase of passphrases) {
      try {
        if (deriveContractWalletAddress(factoryId, publicKeyBytes, passphrase) === walletAddress) {
          addressMatched = true
          break
        }
      } catch {
        // Ignore invalid combination
      }
    }
    if (addressMatched) break
  }

  if (!addressMatched) return false

  let cryptoKey: webcrypto.CryptoKey
  try {
    cryptoKey = await subtle.importKey(
      'raw',
      new Uint8Array(publicKeyBytes),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    return false
  }

  const canonicalBytes = new TextEncoder().encode(buildChallengePayload(walletAddress, challenge))
  const rawChallengeBytes = new TextEncoder().encode(challenge)

  // Case 1: Full WebAuthn assertion (authData + clientDataJSON)
  if (proof.authData && proof.clientDataJSON) {
    const authDataBytes = hexToBytes(proof.authData)
    const clientDataJSONBytes = hexToBytes(proof.clientDataJSON)
    if (!authDataBytes || !clientDataJSONBytes || authDataBytes.length < 37) return false

    let clientData: { type?: string; challenge?: string }
    try {
      clientData = JSON.parse(new TextDecoder().decode(clientDataJSONBytes))
    } catch {
      return false
    }
    if (clientData.type !== 'webauthn.get' || typeof clientData.challenge !== 'string') {
      return false
    }

    const webauthnChallenge = base64UrlToBytes(clientData.challenge)
    if (!webauthnChallenge) return false

    const expectedCandidates = [
      domainSeparatedHash(canonicalBytes),
      domainSeparatedHash(rawChallengeBytes),
      sha256Bytes(canonicalBytes),
      sha256Bytes(rawChallengeBytes),
      canonicalBytes,
      rawChallengeBytes,
    ]
    if (!expectedCandidates.some((cand) => bytesEqual(webauthnChallenge, cand))) {
      return false
    }

    const clientDataHash = sha256Bytes(clientDataJSONBytes)
    const verificationData = new Uint8Array(authDataBytes.length + clientDataHash.length)
    verificationData.set(authDataBytes, 0)
    verificationData.set(clientDataHash, authDataBytes.length)

    return subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      cryptoKey,
      new Uint8Array(signatureBytes),
      verificationData,
    )
  }

  // Case 2: Direct P-256 signature over the canonical challenge payload or raw challenge
  const validCanonical = await subtle.verify(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    cryptoKey,
    new Uint8Array(signatureBytes),
    canonicalBytes,
  )
  if (validCanonical) return true

  return subtle.verify(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    cryptoKey,
    new Uint8Array(signatureBytes),
    rawChallengeBytes,
  )
}

export function createAgentAuthManager(options: AgentAuthOptions = {}): AgentAuthManager {
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxChallenges = options.maxChallenges ?? MAX_PENDING_CHALLENGES
  const maxSessions = options.maxSessions ?? MAX_ACTIVE_SESSIONS
  const now = options.now ?? Date.now

  const defaultFactories = [
    process.env.FACTORY_CONTRACT_ID,
    process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID,
    process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID_MAINNET,
    process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID_TESTNET,
  ]
    .map((v) => v?.trim() ?? '')
    .filter((v) => StrKey.isValidContract(v))

  const allowedFactories = options.factoryContractIds ?? defaultFactories
  const allowedPassphrases = options.networkPassphrases ?? [Networks.PUBLIC, Networks.TESTNET]

  const challenges = new Map<string, ChallengeRecord>()
  const sessions = new Map<string, AgentSession>()

  function pruneExpired(currentTime: number): void {
    for (const [key, rec] of challenges) {
      if (currentTime >= rec.expiresAt) challenges.delete(key)
    }
    for (const [token, sess] of sessions) {
      if (currentTime >= sess.expiresAt) sessions.delete(token)
    }
  }

  function issueChallenge(rawWalletAddress: unknown): ChallengeIssueResult {
    const walletAddress = typeof rawWalletAddress === 'string' ? rawWalletAddress.trim() : ''
    if (!STELLAR_ADDRESS.test(walletAddress)) {
      return { ok: false, error: 'walletAddress is not a Stellar address' }
    }

    const currentTime = now()
    pruneExpired(currentTime)

    const challenge = randomBytes(32).toString('hex')
    const expiresAt = currentTime + challengeTtlMs

    challenges.set(challenge, {
      challenge,
      walletAddress,
      issuedAt: currentTime,
      expiresAt,
    })

    if (challenges.size > maxChallenges) {
      const oldest = challenges.keys().next().value
      if (oldest !== undefined) challenges.delete(oldest)
    }

    return { ok: true, challenge, walletAddress, expiresAt }
  }

  async function verifyChallenge(rawInput: unknown): Promise<SessionVerifyResult> {
    if (!rawInput || typeof rawInput !== 'object') {
      return { ok: false, error: 'Expected a verification payload' }
    }
    const input = rawInput as Record<string, unknown>
    const challenge = typeof input.challenge === 'string' ? input.challenge.trim() : ''
    const claimedWallet = typeof input.walletAddress === 'string' ? input.walletAddress.trim() : ''

    if (!challenge) {
      return { ok: false, error: 'challenge is required' }
    }
    if (!STELLAR_ADDRESS.test(claimedWallet)) {
      return { ok: false, error: 'walletAddress is not a Stellar address' }
    }

    const record = challenges.get(challenge)
    // Consume the challenge immediately on first lookup so any replay is refused.
    if (record) {
      challenges.delete(challenge)
    } else {
      return { ok: false, error: 'Challenge is invalid or has already been used' }
    }

    const currentTime = now()
    if (currentTime >= record.expiresAt) {
      return { ok: false, error: 'Challenge has expired' }
    }

    if (record.walletAddress !== claimedWallet) {
      return { ok: false, error: 'Challenge was issued for a different walletAddress' }
    }

    let feePayerAddress: string | undefined
    if (input.feePayerAddress !== undefined && input.feePayerAddress !== null && input.feePayerAddress !== '') {
      if (typeof input.feePayerAddress !== 'string' || !STELLAR_ACCOUNT.test(input.feePayerAddress.trim())) {
        return { ok: false, error: 'feePayerAddress is not a Stellar account' }
      }
      feePayerAddress = input.feePayerAddress.trim()
    }

    let verified = false
    if (STELLAR_ACCOUNT.test(record.walletAddress)) {
      const signature = typeof input.signature === 'string' ? input.signature : ''
      if (!signature) {
        return { ok: false, error: 'signature is required' }
      }
      verified = verifyEd25519Ownership(record.walletAddress, record.challenge, signature)
    } else if (STELLAR_CONTRACT.test(record.walletAddress)) {
      const nested =
        input.signedMessage && typeof input.signedMessage === 'object'
          ? (input.signedMessage as Record<string, unknown>)
          : input
      const publicKey = typeof nested.publicKey === 'string' ? nested.publicKey : ''
      const signature = typeof nested.signature === 'string' ? nested.signature : ''
      if (!publicKey || !signature) {
        return { ok: false, error: 'publicKey and signature are required for contract wallet verification' }
      }
      const proof: WebAuthnChallengeProof = {
        publicKey,
        signature,
        authData: typeof nested.authData === 'string' ? nested.authData : undefined,
        clientDataJSON: typeof nested.clientDataJSON === 'string' ? nested.clientDataJSON : undefined,
        factoryId:
          typeof input.factoryId === 'string'
            ? input.factoryId
            : typeof nested.factoryId === 'string'
              ? nested.factoryId
              : undefined,
        networkPassphrase:
          typeof input.networkPassphrase === 'string'
            ? input.networkPassphrase
            : typeof nested.networkPassphrase === 'string'
              ? nested.networkPassphrase
              : undefined,
      }
      verified = await verifyContractPasskeyOwnership(
        record.walletAddress,
        record.challenge,
        proof,
        allowedFactories,
        allowedPassphrases,
      )
    }

    if (!verified) {
      return { ok: false, error: 'Signature verification failed for walletAddress' }
    }

    const sessionToken = randomBytes(32).toString('hex')
    const session: AgentSession = {
      sessionToken,
      walletAddress: record.walletAddress,
      ...(feePayerAddress ? { feePayerAddress } : {}),
      issuedAt: currentTime,
      expiresAt: currentTime + sessionTtlMs,
    }

    sessions.set(sessionToken, session)
    if (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }

    return { ok: true, session }
  }

  function verifySession(rawToken: unknown): SessionVerifyResult {
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (!token) {
      return { ok: false, error: 'Authentication required' }
    }
    const session = sessions.get(token)
    if (!session) {
      return { ok: false, error: 'Invalid or unknown session' }
    }
    const currentTime = now()
    if (currentTime >= session.expiresAt) {
      sessions.delete(token)
      return { ok: false, error: 'Session has expired' }
    }
    return { ok: true, session }
  }

  function revokeSession(rawToken: unknown): void {
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (token) sessions.delete(token)
  }

  return {
    issueChallenge,
    verifyChallenge,
    verifySession,
    revokeSession,
    challenges,
    sessions,
  }
}
