import { Keypair } from '@stellar/stellar-sdk'
import { FRIENDBOT_URL, STORAGE } from './network'

/**
 * Minimal Veil "invisible wallet" helpers for the example.
 *
 * The passkey is the user-facing identity: every payment is gated behind a
 * WebAuthn assertion (`navigator.credentials.get`). The actual Stellar payment
 * is signed by a fee-payer keypair that Veil keeps for the user — the same
 * pattern the other example apps use (`veil_fee_payer_secret`). This keeps the
 * x402 payment flow invisible: one biometric tap, no seed phrases.
 */

const RP_NAME = 'Veil x402 Demo'

export interface VeilWallet {
  /** WebAuthn credential id (base64url), used to scope future assertions. */
  keyId: string
  /** Stellar secret (S…) of the fee-payer that signs the x402 payment. */
  feePayerSecret: string
  /** Public key (G…) of the fee-payer. */
  payerAddress: string
}

/** Returns the saved wallet, or `null` if the user has not set one up yet. */
export function loadWallet(): VeilWallet | null {
  if (typeof window === 'undefined') return null
  const keyId = localStorage.getItem(STORAGE.keyId)
  const feePayerSecret = localStorage.getItem(STORAGE.feePayerSecret)
  if (!keyId || !feePayerSecret) return null
  return { keyId, feePayerSecret, payerAddress: Keypair.fromSecret(feePayerSecret).publicKey() }
}

/**
 * Registers a passkey and provisions a funded fee-payer key, then persists both.
 * Idempotent: if a wallet already exists it is returned unchanged.
 */
export async function createWallet(): Promise<VeilWallet> {
  const existing = loadWallet()
  if (existing) return existing

  // 1. Create the passkey (the Veil identity).
  const userId = crypto.getRandomValues(new Uint8Array(16))
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: RP_NAME },
      user: { id: userId, name: 'veil-x402-user', displayName: 'Veil x402 user' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey registration was cancelled.')

  // 2. Provision and fund the fee-payer key that signs payments.
  const payer = Keypair.random()
  await fundWithFriendbot(payer.publicKey())

  const keyId = base64UrlEncode(new Uint8Array(credential.rawId))
  localStorage.setItem(STORAGE.keyId, keyId)
  localStorage.setItem(STORAGE.feePayerSecret, payer.secret())

  return { keyId, feePayerSecret: payer.secret(), payerAddress: payer.publicKey() }
}

/**
 * Prompts for a passkey assertion — the "confirm with Veil" step shown to the
 * user before money moves. Throws if the user cancels.
 */
export async function confirmWithPasskey(keyId: string): Promise<void> {
  const credId = base64UrlDecode(keyId)
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: credId as BufferSource, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })
  if (!assertion) throw new Error('Passkey verification was cancelled.')
}

async function fundWithFriendbot(address: string): Promise<void> {
  if (!FRIENDBOT_URL) return // mainnet: assume the account is already funded
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`)
  if (!res.ok && res.status !== 400) {
    // 400 usually means "account already exists" — safe to ignore.
    throw new Error(`Friendbot funding failed (${res.status}).`)
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
