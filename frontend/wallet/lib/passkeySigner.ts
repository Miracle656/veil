/**
 * The passkey signer, and the fee-payer key, as plain functions.
 *
 * Any flow that spends from the wallet needs two things: a `G…` keypair to pay
 * the network fee and source the transaction, and a function that turns a
 * 32-byte auth-entry payload into a WebAuthn assertion `__check_auth` will
 * accept.
 *
 * `app/dashboard/page.tsx` built both inline, inside a click handler, with a
 * comment noting it mirrors `useInvisibleWallet` "but without React state
 * management so it can be used in a plain async handler". That reasoning is
 * right and applies to every other page that wants to spend — so it lives
 * here rather than being copied into each one.
 *
 * Nothing in this module touches React, so it works from an event handler, a
 * `useEffect`, or a plain async function.
 */

import { Keypair } from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'
import { derToRawSignature, hexToUint8Array } from '@veil/utils'

import { walletLocal, walletSession } from './walletStorage'

/** Thrown when the wallet cannot sign, with text meant for a user to read. */
export class PasskeySignerUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasskeySignerUnavailable'
  }
}

/**
 * The fee-payer keypair for this wallet.
 *
 * Session storage wins over local: a secret put there for one tab is the more
 * deliberate of the two.
 *
 * This key pays fees and sources transactions. It does **not** control the
 * wallet's funds — that is the passkey — so losing it costs XLM, not balances.
 */
export function getFeePayerKeypair(): Keypair {
  const secret =
    walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')

  if (!secret) {
    throw new PasskeySignerUnavailable(
      'Signing key not found. Return to the dashboard and tap "Set up fee-payer".',
    )
  }
  return Keypair.fromSecret(secret)
}

/** True when a passkey and a fee-payer are both present, without prompting. */
export function canSignAsWallet(): boolean {
  const hasFeePayer = Boolean(
    walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret'),
  )
  const hasPasskey = Boolean(
    walletLocal.getItem('invisible_wallet_key_id') &&
      walletLocal.getItem('invisible_wallet_public_key'),
  )
  return hasFeePayer && hasPasskey
}

/**
 * Build the function that signs a Soroban auth entry with the wallet's passkey.
 *
 * Returns null when the user dismisses the prompt — a cancellation is not an
 * error, and callers distinguish the two so a dismissed prompt does not read
 * as a failure worth retrying automatically.
 *
 * Throws {@link PasskeySignerUnavailable} when there is no passkey registered
 * at all, which is a different problem with a different remedy.
 */
export function buildSignAuthEntry(): (payload: Uint8Array) => Promise<WebAuthnSignature | null> {
  return async (payload: Uint8Array): Promise<WebAuthnSignature | null> => {
    const keyId = walletLocal.getItem('invisible_wallet_key_id')
    const publicKeyHex = walletLocal.getItem('invisible_wallet_public_key')
    if (!keyId || !publicKeyHex) {
      throw new PasskeySignerUnavailable(
        'No passkey found on this device. Sign in to the wallet first.',
      )
    }

    // The payload may be a view onto a larger buffer, so slice by the view's
    // own offset and length rather than handing over the whole backing store.
    const challenge = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    ) as ArrayBuffer

    // The credential id is stored base64url; `atob` wants plain base64, and
    // the padding it needs was stripped on the way in.
    const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const credId = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))

    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credId, type: 'public-key' }],
        // `__check_auth` checks the user-verified flag in authenticatorData,
        // so a silent assertion would be rejected on-chain after the user had
        // already been through the prompt.
        userVerification: 'required',
      },
    })) as PublicKeyCredential | null

    if (!assertion) return null

    const response = assertion.response as AuthenticatorAssertionResponse
    return {
      publicKey: hexToUint8Array(publicKeyHex),
      authData: new Uint8Array(response.authenticatorData),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      // WebAuthn returns DER; the contract verifies a raw r‖s pair.
      signature: derToRawSignature(response.signature),
    }
  }
}
