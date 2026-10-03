import { Keypair } from '@stellar/stellar-sdk'
import {
  base64UrlDecode,
  base64UrlEncode,
  toAssertionRecord,
  verifyPaymentAssertion,
  type AssertionRecord,
} from './challenge'
import { FRIENDBOT_URL, STORAGE } from './network'

/**
 * Minimal Veil "invisible wallet" helpers for the example.
 *
 * The passkey is the user-facing identity: every payment is gated behind a
 * WebAuthn assertion (`navigator.credentials.get`) whose challenge is DERIVED
 * FROM THE PAYMENT (see `challenge.ts`), and the assertion is verified locally
 * against the passkey's public key before anything is signed. The actual
 * Stellar payment is still signed by a fee-payer keypair that lives in
 * localStorage, so the passkey is a payment-bound consent gate, NOT the
 * authorisation the network checks. See the README for the exact guarantee.
 */

const RP_NAME = 'Veil x402 Demo'

export interface VeilWallet {
  /** WebAuthn credential id (base64url), used to scope future assertions. */
  keyId: string
  /** SPKI (base64url) of the passkey public key, used to verify assertions. */
  publicKey: string
  /** Stellar secret (S…) of the fee-payer that signs the x402 payment. */
  feePayerSecret: string
  /** Public key (G…) of the fee-payer. */
  payerAddress: string
}

/** Returns the saved wallet, or `null` if the user has not set one up yet. */
export function loadWallet(): VeilWallet | null {
  if (typeof window === 'undefined') return null
  const keyId = localStorage.getItem(STORAGE.keyId)
  const publicKey = localStorage.getItem(STORAGE.publicKey)
  const feePayerSecret = localStorage.getItem(STORAGE.feePayerSecret)
  // A wallet saved before the passkey public key was stored cannot verify a
  // payment-bound assertion, so it is treated as not set up.
  if (!keyId || !publicKey || !feePayerSecret) return null
  return { keyId, publicKey, feePayerSecret, payerAddress: Keypair.fromSecret(feePayerSecret).publicKey() }
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

  const spki = (credential.response as AuthenticatorAttestationResponse).getPublicKey()
  if (!spki) throw new Error('This browser did not return the passkey public key.')

  const keyId = base64UrlEncode(new Uint8Array(credential.rawId))
  const publicKey = base64UrlEncode(new Uint8Array(spki))
  localStorage.setItem(STORAGE.keyId, keyId)
  localStorage.setItem(STORAGE.publicKey, publicKey)
  localStorage.setItem(STORAGE.feePayerSecret, payer.secret())

  return { keyId, publicKey, feePayerSecret: payer.secret(), payerAddress: payer.publicKey() }
}

/**
 * Prompts for a passkey assertion over `challenge` (derived from the payment,
 * never random) and verifies it against the wallet's passkey before returning.
 * Throws if the user cancels or the assertion is not over this exact challenge.
 * The returned record is the evidence of what the user approved.
 */
export async function confirmWithPasskey(
  wallet: VeilWallet,
  challenge: Uint8Array,
): Promise<AssertionRecord> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: challenge as BufferSource,
      allowCredentials: [{ id: base64UrlDecode(wallet.keyId) as BufferSource, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey verification was cancelled.')

  const response = credential.response as AuthenticatorAssertionResponse
  const parts = {
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    authenticatorData: new Uint8Array(response.authenticatorData),
    signature: new Uint8Array(response.signature),
  }
  await verifyPaymentAssertion({
    parts,
    expectedChallenge: challenge,
    publicKeySpki: base64UrlDecode(wallet.publicKey),
  })
  return toAssertionRecord(challenge, parts)
}

async function fundWithFriendbot(address: string): Promise<void> {
  if (!FRIENDBOT_URL) return // mainnet: assume the account is already funded
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`)
  if (!res.ok && res.status !== 400) {
    // 400 usually means "account already exists" — safe to ignore.
    throw new Error(`Friendbot funding failed (${res.status}).`)
  }
}
