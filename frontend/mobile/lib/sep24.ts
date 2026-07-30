/**
 * SEP-24 Hosted Deposit utility (mobile).
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 *
 * Ported from frontend/wallet/lib/sep24.ts. Only the deposit (on-ramp) path is
 * implemented for now, matching the mobile buy screen's scope.
 *
 * Pure / testable — no browser-only APIs (no `window`, `document`,
 * `localStorage`, `sessionStorage`, WebAuthn). Where the web version signs
 * the SEP-10 challenge with a passkey stored in browser storage, this module
 * takes an injectable `signChallenge` async function instead — same pattern
 * as `executeBulkPayout(rows, submitBatch)` in `lib/bulkPayout.ts`. Mobile has
 * no signing infra ported yet, so screens pass a stub today.
 */

import { Networks, Transaction, TransactionBuilder, type Keypair } from '@stellar/stellar-sdk';

// ── Anchor config ────────────────────────────────────────────────────────────

export interface AnchorInfo {
  transferServerUrl: string;
  webAuthEndpoint: string;
  networkPassphrase: string;
}

// ── TOML discovery ───────────────────────────────────────────────────────────

/** Fetch and parse `<domain>/.well-known/stellar.toml` for SEP-24 endpoints. */
export async function discoverAnchorInfo(anchorDomain: string): Promise<AnchorInfo> {
  const res = await fetch(`https://${anchorDomain}/.well-known/stellar.toml`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Could not fetch stellar.toml from ${anchorDomain} (HTTP ${res.status})`);
  }

  const text = await res.text();

  const transferMatch = text.match(/TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/);
  if (!transferMatch) {
    throw new Error(`TRANSFER_SERVER_SEP0024 not found in ${anchorDomain}/.well-known/stellar.toml`);
  }

  const webAuthMatch = text.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/);
  if (!webAuthMatch) {
    throw new Error(`WEB_AUTH_ENDPOINT not found in ${anchorDomain}/.well-known/stellar.toml`);
  }

  const networkMatch = text.match(/NETWORK_PASSPHRASE\s*=\s*"([^"]+)"/);
  const networkPassphrase = networkMatch ? networkMatch[1] : Networks.TESTNET;

  return {
    transferServerUrl: transferMatch[1].replace(/\/$/, ''),
    webAuthEndpoint: webAuthMatch[1].replace(/\/$/, ''),
    networkPassphrase,
  };
}

// ── SEP-10 challenge signing (pure / testable) ──────────────────────────────

/** Error codes for typed SEP-10 validation failures. */
export type Sep10ErrorCode = 'MISSING_MANAGE_DATA' | 'INVALID_HOME_DOMAIN' | 'EXPIRED' | 'MALFORMED';

/**
 * Typed error thrown by {@link signSep10Challenge} when a challenge is invalid.
 * Consumers can narrow on `error.code` for programmatic handling.
 */
export class Sep10ChallengeError extends Error {
  readonly code: Sep10ErrorCode;
  constructor(message: string, code: Sep10ErrorCode) {
    super(message);
    this.name = 'Sep10ChallengeError';
    this.code = code;
  }
}

/**
 * Validate and sign a SEP-10 challenge transaction with a classic Stellar keypair.
 *
 * SEP-10 rules enforced:
 *  - The transaction MUST contain at least one `manage_data` operation.
 *  - The `manage_data` key MUST end with " auth" (the standard anchor suffix).
 *  - The transaction MUST have `timeBounds` set (minTime / maxTime).
 *  - `maxTime` MUST be in the future (challenge not expired).
 *
 * @throws {Sep10ChallengeError} if any SEP-10 validation rule is violated.
 */
export function signSep10Challenge(
  challengeXdr: string,
  networkPassphrase: string,
  signerKeypair: Keypair
): string {
  let tx: Transaction;
  try {
    tx = new Transaction(challengeXdr, networkPassphrase);
  } catch (err) {
    throw new Sep10ChallengeError(`Failed to parse challenge XDR: ${(err as Error).message}`, 'MALFORMED');
  }

  const manageDataOps = tx.operations.filter((op) => op.type === 'manageData');
  if (manageDataOps.length === 0) {
    throw new Sep10ChallengeError(
      'SEP-10 challenge must contain at least one manage_data operation',
      'MISSING_MANAGE_DATA'
    );
  }

  const firstKey = (manageDataOps[0] as { name: string }).name;
  if (!firstKey.endsWith(' auth')) {
    throw new Sep10ChallengeError(
      `manage_data key "${firstKey}" does not follow the "<home_domain> auth" SEP-10 convention`,
      'INVALID_HOME_DOMAIN'
    );
  }

  if (!tx.timeBounds) {
    throw new Sep10ChallengeError('SEP-10 challenge must have timeBounds set', 'MALFORMED');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const maxTime = Number(tx.timeBounds.maxTime);
  if (maxTime > 0 && nowSec > maxTime) {
    throw new Sep10ChallengeError(
      `SEP-10 challenge has expired (maxTime=${maxTime}, now=${nowSec})`,
      'EXPIRED'
    );
  }

  const rebuilt = TransactionBuilder.cloneFrom(tx).build();
  rebuilt.sign(signerKeypair);
  return rebuilt.toXDR();
}

// ── SEP-10 Web Auth ──────────────────────────────────────────────────────────

/**
 * Injectable signer for the SEP-10 challenge. The web app signs with a
 * browser passkey; mobile has no signing infra ported yet, so callers pass a
 * stub (or, once wired up, a function backed by the mobile wallet's signer).
 * Returns the signed (or otherwise anchor-acceptable) transaction XDR.
 */
export type Sep10ChallengeSigner = (params: {
  challengeXdr: string;
  networkPassphrase: string;
  account: string;
}) => Promise<string>;

/**
 * Obtain a SEP-10 JWT by:
 *  1. Fetching the challenge transaction from the anchor's WEB_AUTH_ENDPOINT
 *  2. Signing it via the injected `signChallenge` function
 *  3. Posting the signed transaction back to get a JWT
 */
export async function getSep10Jwt(
  webAuthEndpoint: string,
  account: string,
  networkPassphrase: string,
  signChallenge: Sep10ChallengeSigner
): Promise<string> {
  const challengeRes = await fetch(`${webAuthEndpoint}?account=${encodeURIComponent(account)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!challengeRes.ok) {
    const errText = await challengeRes.text().catch(() => challengeRes.statusText);
    throw new Error(`SEP-10 challenge fetch failed (HTTP ${challengeRes.status}): ${errText}`);
  }
  const { transaction: challengeXdr, network_passphrase } = (await challengeRes.json()) as {
    transaction: string;
    network_passphrase?: string;
  };

  const effectivePassphrase = network_passphrase ?? networkPassphrase;

  const signedXdr = await signChallenge({
    challengeXdr,
    networkPassphrase: effectivePassphrase,
    account,
  });

  const tokenRes = await fetch(webAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: signedXdr }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => tokenRes.statusText);
    throw new Error(`SEP-10 token exchange failed (HTTP ${tokenRes.status}): ${errText}`);
  }

  const { token } = (await tokenRes.json()) as { token?: string };
  if (!token) throw new Error('Anchor did not return a JWT token.');
  return token;
}

// ── Shared types ─────────────────────────────────────────────────────────────

export interface Sep24InteractiveResult {
  /** URL to open in the anchor's interactive (KYC / payment) flow. */
  url: string;
  /** Anchor-assigned transaction ID — use this to poll status. */
  id: string;
}

export interface Sep24TransactionStatus {
  id: string;
  /** SEP-24 status: pending_user_transfer_start | pending_anchor | completed | error | … */
  status: string;
  stellar_transaction_id?: string;
  message?: string;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
  /** Withdraw-only: Stellar address the wallet must pay to settle the withdrawal. */
  withdraw_anchor_account?: string;
  /** Withdraw-only: memo the anchor uses to route the incoming payment to this txn. */
  withdraw_memo?: string;
  /** Withdraw-only: 'text' | 'id' | 'hash'. */
  withdraw_memo_type?: string;
}

// ── Deposit ──────────────────────────────────────────────────────────────────

export interface InitiateDepositParams {
  assetCode: string;
  account: string;
  amount?: string;
  lang?: string;
}

/** Start a SEP-24 interactive deposit. Returns the interactive URL and txn id to poll. */
export async function initiateDeposit(
  transferServerUrl: string,
  params: InitiateDepositParams,
  jwt?: string
): Promise<Sep24InteractiveResult> {
  const body = new URLSearchParams({
    asset_code: params.assetCode,
    account: params.account,
    lang: params.lang ?? 'en',
    ...(params.amount ? { amount: params.amount } : {}),
  });

  const res = await fetch(`${transferServerUrl}/transactions/deposit/interactive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Deposit initiation failed (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { url?: string; id?: string };
  if (!data.url || !data.id) throw new Error('Anchor returned an invalid response (missing url or id)');
  return { url: data.url, id: data.id };
}

// ── Status polling ───────────────────────────────────────────────────────────

/** Fetch the current status of a SEP-24 transaction from the anchor. */
export async function getTransactionStatus(
  transferServerUrl: string,
  txnId: string,
  jwt?: string
): Promise<Sep24TransactionStatus> {
  const res = await fetch(`${transferServerUrl}/transaction?id=${encodeURIComponent(txnId)}`, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch transaction status (HTTP ${res.status})`);

  const data = (await res.json()) as { transaction?: Sep24TransactionStatus };
  if (!data.transaction) throw new Error('Anchor response missing transaction object');
  return data.transaction;
}

/** Returns true once a SEP-24 status no longer requires polling. */
// ── Withdraw (off-ramp) ──────────────────────────────────────────────────────

/**
 * Start a SEP-24 interactive withdrawal. Same contract as
 * {@link initiateDeposit} — the anchor returns a URL to open and an id to poll
 * — but against `/transactions/withdraw/interactive`.
 */
export async function initiateWithdraw(
  transferServerUrl: string,
  params: InitiateDepositParams,
  jwt?: string,
): Promise<Sep24InteractiveResult> {
  const body = new URLSearchParams({
    asset_code: params.assetCode,
    account: params.account,
    lang: params.lang ?? 'en',
    ...(params.amount ? { amount: params.amount } : {}),
  });

  const res = await fetch(`${transferServerUrl}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Withdraw initiation failed (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { url?: string; id?: string };
  if (!data.url || !data.id) throw new Error('Anchor returned an invalid response (missing url or id)');
  return { url: data.url, id: data.id };
}

export function isSep24Complete(status: string): boolean {
  return ['completed', 'error', 'refunded', 'expired'].includes(status);
}
