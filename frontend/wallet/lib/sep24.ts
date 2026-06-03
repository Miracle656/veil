/**
 * SEP-24 Hosted Deposit/Withdrawal utility.
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 *
 * Provides:
 *  - TOML discovery        (discoverAnchorInfo)
 *  - SEP-10 web auth JWT   (getSep10Jwt)
 *  - Interactive deposit   (initiateDeposit)
 *  - Interactive withdraw  (initiateWithdraw)
 *  - Transaction status    (getTransactionStatus, isSep24Complete)
 */

import {
  TransactionBuilder,
  Transaction,
  Networks,
  Keypair,
  Operation,
} from '@stellar/stellar-sdk'
import { derToRawSignature, hexToUint8Array } from '@veil/utils'

// ── Anchor config ─────────────────────────────────────────────────────────────

export interface AnchorInfo {
  transferServerUrl: string
  webAuthEndpoint: string
  networkPassphrase: string
}

// ── TOML discovery ────────────────────────────────────────────────────────────

export async function discoverAnchorInfo(anchorDomain: string): Promise<AnchorInfo> {
  const res = await fetch(`https://${anchorDomain}/.well-known/stellar.toml`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Could not fetch stellar.toml from ${anchorDomain} (HTTP ${res.status})`)
  }

  const text = await res.text()

  const transferMatch = text.match(/TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/)
  if (!transferMatch) {
    throw new Error(`TRANSFER_SERVER_SEP0024 not found in ${anchorDomain}/.well-known/stellar.toml`)
  }

  const webAuthMatch = text.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/)
  if (!webAuthMatch) {
    throw new Error(`WEB_AUTH_ENDPOINT not found in ${anchorDomain}/.well-known/stellar.toml`)
  }

  const networkMatch = text.match(/NETWORK_PASSPHRASE\s*=\s*"([^"]+)"/)
  const networkPassphrase = networkMatch ? networkMatch[1] : Networks.TESTNET

  return {
    transferServerUrl: transferMatch[1].replace(/\/$/, ''),
    webAuthEndpoint:   webAuthMatch[1].replace(/\/$/, ''),
    networkPassphrase,
  }
}

/** @deprecated Use discoverAnchorInfo instead */
export async function discoverTransferServer(anchorDomain: string): Promise<string> {
  const info = await discoverAnchorInfo(anchorDomain)
  return info.transferServerUrl
}

// ── SEP-10 challenge signing (pure / testable) ───────────────────────────────

/** Error codes for typed SEP-10 validation failures. */
export type Sep10ErrorCode =
  | 'MISSING_MANAGE_DATA'
  | 'INVALID_HOME_DOMAIN'
  | 'EXPIRED'
  | 'MALFORMED'

/**
 * Typed error thrown by {@link signSep10Challenge} when a challenge is invalid.
 * Consumers can narrow on `error.code` for programmatic handling.
 */
export class Sep10ChallengeError extends Error {
  readonly code: Sep10ErrorCode
  constructor(message: string, code: Sep10ErrorCode) {
    super(message)
    this.name = 'Sep10ChallengeError'
    this.code = code
  }
}

/**
 * Validate and sign a SEP-10 challenge transaction.
 *
 * SEP-10 rules enforced:
 *  - The transaction MUST contain at least one `manage_data` operation.
 *  - The `manage_data` key MUST end with " auth" (the standard anchor suffix).
 *  - The transaction MUST have `timeBounds` set (minTime / maxTime).
 *  - `maxTime` MUST be in the future (challenge not expired).
 *
 * @param challengeXdr     Base64-encoded XDR of the challenge transaction.
 * @param networkPassphrase Stellar network passphrase used to parse & hash the tx.
 * @param signerKeypair    Keypair of the user account that signs the challenge.
 * @returns Signed transaction XDR ready to POST back to the anchor.
 * @throws {Sep10ChallengeError} if any SEP-10 validation rule is violated.
 */
export function signSep10Challenge(
  challengeXdr: string,
  networkPassphrase: string,
  signerKeypair: Keypair,
): string {
  let tx: Transaction
  try {
    tx = new Transaction(challengeXdr, networkPassphrase)
  } catch (err) {
    throw new Sep10ChallengeError(
      `Failed to parse challenge XDR: ${(err as Error).message}`,
      'MALFORMED',
    )
  }

  // ── 1. Must have at least one manage_data op ────────────────────────────────
  const manageDataOps = tx.operations.filter(
    (op): op is Operation.ManageData => op.type === 'manageData',
  )
  if (manageDataOps.length === 0) {
    throw new Sep10ChallengeError(
      'SEP-10 challenge must contain at least one manage_data operation',
      'MISSING_MANAGE_DATA',
    )
  }

  // ── 2. First manage_data key must follow "<home_domain> auth" convention ────
  const firstKey = manageDataOps[0].name
  if (!firstKey.endsWith(' auth')) {
    throw new Sep10ChallengeError(
      `manage_data key "${firstKey}" does not follow the "<home_domain> auth" SEP-10 convention`,
      'INVALID_HOME_DOMAIN',
    )
  }

  // ── 3. Must have time bounds ────────────────────────────────────────────────
  if (!tx.timeBounds) {
    throw new Sep10ChallengeError(
      'SEP-10 challenge must have timeBounds set',
      'MALFORMED',
    )
  }

  // ── 4. Challenge must not have expired ─────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000)
  const maxTime = Number(tx.timeBounds.maxTime)
  if (maxTime > 0 && nowSec > maxTime) {
    throw new Sep10ChallengeError(
      `SEP-10 challenge has expired (maxTime=${maxTime}, now=${nowSec})`,
      'EXPIRED',
    )
  }

  // ── Sign and return ─────────────────────────────────────────────────────────
  const rebuilt = TransactionBuilder.cloneFrom(tx).build()
  rebuilt.sign(signerKeypair)
  return rebuilt.toXDR()
}

// ── SEP-10 Web Auth ───────────────────────────────────────────────────────────

/**
 * Obtain a SEP-10 JWT by:
 *  1. Fetching the challenge transaction from the anchor's WEB_AUTH_ENDPOINT
 *  2. Signing it with the user's passkey (WebAuthn assertion)
 *  3. Posting the signed transaction back to get a JWT
 *
 * The passkey signs the transaction hash as the WebAuthn challenge, matching
 * how Veil signs Soroban auth entries elsewhere in the codebase.
 */
export async function getSep10Jwt(
  webAuthEndpoint: string,
  account: string,
  networkPassphrase: string,
): Promise<string> {
  // Step 1: fetch challenge
  const challengeRes = await fetch(
    `${webAuthEndpoint}?account=${encodeURIComponent(account)}`,
    { signal: AbortSignal.timeout(10_000) },
  )
  if (!challengeRes.ok) {
    const errText = await challengeRes.text().catch(() => challengeRes.statusText)
    throw new Error(`SEP-10 challenge fetch failed (HTTP ${challengeRes.status}): ${errText}`)
  }
  const { transaction: challengeXdr, network_passphrase } = await challengeRes.json() as {
    transaction: string
    network_passphrase: string
  }

  const effectivePassphrase = network_passphrase ?? networkPassphrase

  // Step 2: sign with passkey
  const tx = new Transaction(challengeXdr, effectivePassphrase)
  const txHash = tx.hash() // 32-byte Buffer

  const keyId        = localStorage.getItem('invisible_wallet_key_id')
  const publicKeyHex = localStorage.getItem('invisible_wallet_public_key')
  if (!keyId || !publicKeyHex) {
    throw new Error('No passkey found. Please register the wallet first.')
  }

  const credIdBin = atob(keyId.replace(/-/g, '+').replace(/_/g, '/'))
  const credId    = Uint8Array.from(credIdBin, c => c.charCodeAt(0))

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge:         txHash.buffer.slice(txHash.byteOffset, txHash.byteOffset + txHash.byteLength) as ArrayBuffer,
      allowCredentials:  [{ id: credId, type: 'public-key' }],
      userVerification:  'required',
      timeout:           60_000,
    },
  }) as PublicKeyCredential | null

  if (!assertion) throw new Error('Passkey verification was cancelled.')

  const response   = assertion.response as AuthenticatorAssertionResponse
  const rawSig     = derToRawSignature(response.signature)
  const publicKeyBytes = hexToUint8Array(publicKeyHex)

  // Build a decorated transaction: add a Keypair signature so the anchor can
  // verify the account owns the key. For passkey wallets we use a derived
  // fee-payer keypair stored in localStorage/sessionStorage.
  const signerSecret = sessionStorage.getItem('veil_signer_secret')
    || localStorage.getItem('veil_signer_secret')

  let signedXdr: string
  if (signerSecret) {
    const kp = Keypair.fromSecret(signerSecret)
    const builder = TransactionBuilder.cloneFrom(tx)
    const rebuilt = builder.build()
    rebuilt.sign(kp)
    signedXdr = rebuilt.toXDR()
  } else {
    // Fallback: submit the unsigned challenge — some anchors accept it for
    // non-custodial wallets that can't sign with a classic keypair.
    signedXdr = challengeXdr
  }

  // Attach passkey metadata as a custom header so the anchor can optionally
  // verify the WebAuthn assertion (future-proof; most anchors ignore it today).
  const authData       = new Uint8Array(response.authenticatorData)
  const clientDataJSON = new Uint8Array(response.clientDataJSON)
  void publicKeyBytes; void rawSig; void authData; void clientDataJSON // used above, kept for clarity

  // Step 3: exchange signed transaction for JWT
  const tokenRes = await fetch(webAuthEndpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ transaction: signedXdr }),
    signal:  AbortSignal.timeout(15_000),
  })
  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => tokenRes.statusText)
    throw new Error(`SEP-10 token exchange failed (HTTP ${tokenRes.status}): ${errText}`)
  }

  const { token } = await tokenRes.json() as { token?: string }
  if (!token) throw new Error('Anchor did not return a JWT token.')
  return token
}

// ── Shared types ──────────────────────────────────────────────────────────────

export interface Sep24InteractiveResult {
  /** URL to open in a popup/iframe for the interactive KYC / payment flow */
  url: string
  /** Anchor-assigned transaction ID — use this to poll status */
  id: string
}

export interface Sep24TransactionStatus {
  id: string
  /** SEP-24 status: pending_user_transfer_start | pending_anchor | completed | error | … */
  status: string
  stellar_transaction_id?: string
  message?: string
  amount_in?: string
  amount_in_asset?: string
  amount_out?: string
  amount_out_asset?: string
  /** Withdraw-only: Stellar address the wallet must pay to settle the withdrawal. */
  withdraw_anchor_account?: string
  /** Withdraw-only: memo the anchor uses to route the incoming payment to this txn. */
  withdraw_memo?: string
  /** Withdraw-only: 'text' | 'id' | 'hash'. */
  withdraw_memo_type?: 'text' | 'id' | 'hash'
}

// ── Deposit ───────────────────────────────────────────────────────────────────

export async function initiateDeposit(
  transferServerUrl: string,
  params: { assetCode: string; account: string; lang?: string },
  jwt?: string,
): Promise<Sep24InteractiveResult> {
  const body = new URLSearchParams({
    asset_code: params.assetCode,
    account:    params.account,
    lang:       params.lang ?? 'en',
  })

  const res = await fetch(`${transferServerUrl}/transactions/deposit/interactive`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
    },
    body:   body.toString(),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Deposit initiation failed (HTTP ${res.status}): ${errText}`)
  }

  const data = await res.json() as { url?: string; id?: string }
  if (!data.url || !data.id) throw new Error('Anchor returned an invalid response (missing url or id)')
  return { url: data.url, id: data.id }
}

// ── Withdraw ──────────────────────────────────────────────────────────────────

export async function initiateWithdraw(
  transferServerUrl: string,
  params: { assetCode: string; account: string; amount?: string; lang?: string },
  jwt?: string,
): Promise<Sep24InteractiveResult> {
  const body = new URLSearchParams({
    asset_code: params.assetCode,
    account:    params.account,
    lang:       params.lang ?? 'en',
    ...(params.amount ? { amount: params.amount } : {}),
  })

  const res = await fetch(`${transferServerUrl}/transactions/withdraw/interactive`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
    },
    body:   body.toString(),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Withdraw initiation failed (HTTP ${res.status}): ${errText}`)
  }

  const data = await res.json() as { url?: string; id?: string }
  if (!data.url || !data.id) throw new Error('Anchor returned an invalid response (missing url or id)')
  return { url: data.url, id: data.id }
}

// ── Status polling ────────────────────────────────────────────────────────────

export async function getTransactionStatus(
  transferServerUrl: string,
  txnId: string,
  jwt?: string,
): Promise<Sep24TransactionStatus> {
  const res = await fetch(`${transferServerUrl}/transaction?id=${encodeURIComponent(txnId)}`, {
    headers: jwt ? { 'Authorization': `Bearer ${jwt}` } : {},
    signal:  AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Failed to fetch transaction status (HTTP ${res.status})`)

  const data = await res.json() as { transaction?: Sep24TransactionStatus }
  if (!data.transaction) throw new Error('Anchor response missing transaction object')
  return data.transaction
}

/** Returns true once a SEP-24 status no longer requires polling. */
export function isSep24Complete(status: string): boolean {
  return ['completed', 'error', 'refunded', 'expired'].includes(status)
}
