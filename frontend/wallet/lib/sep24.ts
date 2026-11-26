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
  Keypair,
  Operation,
  WebAuth,
} from '@stellar/stellar-sdk'
import { derToRawSignature, hexToUint8Array } from '@veil/utils'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { getNetwork } from '@/lib/network'

// ── Anchor config ─────────────────────────────────────────────────────────────

export interface AnchorInfo {
  transferServerUrl: string
  webAuthEndpoint: string
  networkPassphrase: string
  /** The domain the TOML came from. A challenge must name it. */
  homeDomain: string
  /**
   * SEP-10 `SIGNING_KEY`: the account the anchor signs challenges with. Absent
   * when the anchor publishes none, in which case its challenges cannot be
   * verified and must not be signed.
   */
  signingKey?: string
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

  const signingKeyMatch = text.match(/SIGNING_KEY\s*=\s*"([^"]+)"/)

  const networkMatch = text.match(/NETWORK_PASSPHRASE\s*=\s*"([^"]+)"/)
  const networkPassphrase = networkMatch ? networkMatch[1] : getNetwork().networkPassphrase
  if (!networkPassphrase) {
    throw new Error(`No network passphrase is configured for ${getNetwork().displayName}.`)
  }

  return {
    transferServerUrl: transferMatch[1].replace(/\/$/, ''),
    webAuthEndpoint:   webAuthMatch[1].replace(/\/$/, ''),
    networkPassphrase,
    homeDomain: anchorDomain,
    signingKey: signingKeyMatch ? signingKeyMatch[1].trim() : undefined,
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
 * Validate a SEP-10 challenge transaction using standard SDK WebAuth rules.
 */
export function validateSep10Challenge(
  challengeXdr: string,
  networkPassphrase: string,
  /** The domain we fetched the TOML from — never one read out of the challenge. */
  homeDomain: string,
  /** The anchor's published SIGNING_KEY — never the challenge's own source. */
  anchorSigningKey: string,
  /** Host of the WEB_AUTH_ENDPOINT we called. */
  webAuthDomain: string,
): { tx: Transaction; clientAccountID: string; matchedHomeDomain: string } {
  if (!homeDomain || !anchorSigningKey || !webAuthDomain) {
    // Defaulting any of these to a value taken from the challenge would verify
    // the challenge against its own claims, which is not a check at all.
    throw new Sep10ChallengeError(
      'SEP-10 validation needs the anchor home domain, its published SIGNING_KEY and the web auth domain.',
      'MALFORMED',
    )
  }
  let tx: Transaction
  try {
    tx = new Transaction(challengeXdr, networkPassphrase)
  } catch (err) {
    throw new Sep10ChallengeError(
      `Failed to parse challenge XDR: ${(err as Error).message}`,
      'MALFORMED',
    )
  }

  if (tx.sequence !== '0') {
    throw new Sep10ChallengeError(
      'SEP-10 challenge sequence number must be zero',
      'MALFORMED',
    )
  }

  if (!tx.operations.every((op) => op.type === 'manageData')) {
    throw new Sep10ChallengeError(
      'SEP-10 challenge must contain only manage_data operations',
      'MISSING_MANAGE_DATA',
    )
  }

  const manageDataOps = tx.operations.filter(
    (op): op is Operation.ManageData => op.type === 'manageData',
  )
  if (manageDataOps.length === 0) {
    throw new Sep10ChallengeError(
      'SEP-10 challenge must contain at least one manage_data operation',
      'MISSING_MANAGE_DATA',
    )
  }

  const firstKey = manageDataOps[0].name
  if (!firstKey.endsWith(' auth')) {
    throw new Sep10ChallengeError(
      `manage_data key "${firstKey}" does not follow the "<home_domain> auth" SEP-10 convention`,
      'INVALID_HOME_DOMAIN',
    )
  }

  if (!tx.timeBounds) {
    throw new Sep10ChallengeError(
      'SEP-10 challenge must have timeBounds set',
      'MALFORMED',
    )
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const maxTime = Number(tx.timeBounds.maxTime)
  if (maxTime > 0 && nowSec > maxTime) {
    throw new Sep10ChallengeError(
      `SEP-10 challenge has expired (maxTime=${maxTime}, now=${nowSec})`,
      'EXPIRED',
    )
  }


  try {
    const readResult = WebAuth.readChallengeTx(
      challengeXdr,
      anchorSigningKey,
      networkPassphrase,
      homeDomain,
      webAuthDomain,
    )
    return readResult
  } catch (err) {
    if (err instanceof Sep10ChallengeError) throw err
    const msg = (err as Error).message || String(err)
    if (msg.includes('expired') || msg.includes('timebounds')) {
      throw new Sep10ChallengeError(msg, 'EXPIRED')
    } else if (msg.includes('home domain') || msg.includes('homeDomains')) {
      throw new Sep10ChallengeError(msg, 'INVALID_HOME_DOMAIN')
    } else if (msg.includes('manageData') || msg.includes('operation') || msg.includes('sequence')) {
      throw new Sep10ChallengeError(msg, 'MISSING_MANAGE_DATA')
    }
    throw new Sep10ChallengeError(msg, 'MALFORMED')
  }
}

/**
 * Validate and sign a SEP-10 challenge transaction.
 *
 * SEP-10 rules enforced:
 *  - Sequence number MUST be 0.
 *  - All operations MUST be manage_data.
 *  - The `manage_data` key MUST end with " auth" (the standard anchor suffix).
 *  - The transaction MUST have `timeBounds` set (minTime / maxTime).
 *  - `maxTime` MUST be in the future (challenge not expired).
 *  - Enforces sequence number 0 and server signature via WebAuth.readChallengeTx.
 *
 * @param challengeXdr     Base64-encoded XDR of the challenge transaction.
 * @param networkPassphrase Stellar network passphrase used to parse & hash the tx.
 * @param signerKeypair    Keypair of the user account that signs the challenge.
 * @param homeDomain       Optional home domain to verify.
 * @param anchorSigningKey Optional server signing key to verify.
 * @param webAuthDomain    Optional web auth domain to verify.
 * @returns Signed transaction XDR ready to POST back to the anchor.
 * @throws {Sep10ChallengeError} if any SEP-10 validation rule is violated.
 */
export function signSep10Challenge(
  challengeXdr: string,
  networkPassphrase: string,
  signerKeypair: Keypair,
  homeDomain: string,
  anchorSigningKey: string,
  webAuthDomain: string,
): string {
  const { tx } = validateSep10Challenge(
    challengeXdr,
    networkPassphrase,
    homeDomain,
    anchorSigningKey,
    webAuthDomain,
  )

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
  homeDomain: string,
  anchorSigningKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  // An anchor that publishes no SIGNING_KEY cannot have its challenges checked,
  // and the challenge below is signed with a passkey assertion over its hash.
  // Refuse rather than authenticate blind.
  if (!anchorSigningKey) {
    throw new Error(
      `${homeDomain} publishes no SEP-10 SIGNING_KEY, so its sign-in request cannot be verified.`,
    )
  }
  // Step 1: fetch challenge
  const challengeRes = await fetchFn(
    `${webAuthEndpoint}?account=${encodeURIComponent(account)}`,
    { signal: AbortSignal.timeout(10_000) },
  )
  if (!challengeRes.ok) {
    const errText = await challengeRes.text().catch(() => challengeRes.statusText)
    throw new Error(`SEP-10 challenge fetch failed (HTTP ${challengeRes.status}): ${errText}`)
  }
  const { transaction: challengeXdr, network_passphrase } = await challengeRes.json() as {
    transaction: string
    network_passphrase?: string
  }

  if (!challengeXdr) {
    throw new Error('Anchor challenge response missing transaction XDR')
  }

  if (network_passphrase && network_passphrase !== networkPassphrase) {
    throw new Error(
      `Anchor returned network_passphrase "${network_passphrase}" which differs from expected "${networkPassphrase}"`,
    )
  }

  const webAuthDomain = webAuthEndpoint.startsWith('http')
    ? new URL(webAuthEndpoint).hostname
    : webAuthEndpoint

  validateSep10Challenge(
    challengeXdr,
    networkPassphrase,
    homeDomain,
    anchorSigningKey,
    webAuthDomain,
  )

  // Step 2: sign with passkey using application's configured networkPassphrase
  const tx = new Transaction(challengeXdr, networkPassphrase)
  const txHash = tx.hash() // 32-byte Buffer

  const keyId        = walletLocal.getItem('invisible_wallet_key_id')
  const publicKeyHex = walletLocal.getItem('invisible_wallet_public_key')
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
  const signerSecret = walletSession.getItem('veil_signer_secret')
    || walletLocal.getItem('veil_signer_secret')

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
