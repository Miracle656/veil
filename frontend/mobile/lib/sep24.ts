/**
 * SEP-24 Hosted Deposit/Withdrawal utility (mobile port).
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 *
 * Ported from frontend/wallet/lib/sep24.ts. Only the pieces the withdraw
 * (and deposit) flows need are included: TOML discovery, SEP-10 JWT
 * exchange, the interactive withdraw/deposit request, and status polling.
 *
 * The wallet version signs the SEP-10 challenge with a browser passkey
 * (navigator.credentials / crypto.subtle) — none of that exists on React
 * Native. Instead, `getSep10Jwt` takes an injectable `signChallenge`
 * callback that returns a signed challenge XDR, mirroring the
 * `submitBatch` pattern in lib/bulkPayout.ts. The screen can pass a stub
 * today since mobile has no signing infra ported yet.
 */

import { Networks } from '@stellar/stellar-sdk';

// ── Anchor config ────────────────────────────────────────────────────────────

export interface AnchorInfo {
  transferServerUrl: string;
  webAuthEndpoint: string;
  networkPassphrase: string;
}

// ── TOML discovery ───────────────────────────────────────────────────────────

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

// ── SEP-10 Web Auth ──────────────────────────────────────────────────────────

/**
 * Given a raw challenge transaction XDR, return a signed XDR ready to POST
 * back to the anchor. On the web wallet this signs with a WebAuthn passkey;
 * on mobile the caller supplies whatever signing mechanism is available.
 */
export type Sep10ChallengeSigner = (
  challengeXdr: string,
  networkPassphrase: string,
) => Promise<string>;

/**
 * Obtain a SEP-10 JWT by:
 *  1. Fetching the challenge transaction from the anchor's WEB_AUTH_ENDPOINT
 *  2. Signing it via the injected `signChallenge` callback
 *  3. Posting the signed transaction back to get a JWT
 */
export async function getSep10Jwt(
  webAuthEndpoint: string,
  account: string,
  networkPassphrase: string,
  signChallenge: Sep10ChallengeSigner,
): Promise<string> {
  const challengeRes = await fetch(
    `${webAuthEndpoint}?account=${encodeURIComponent(account)}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!challengeRes.ok) {
    const errText = await challengeRes.text().catch(() => challengeRes.statusText);
    throw new Error(`SEP-10 challenge fetch failed (HTTP ${challengeRes.status}): ${errText}`);
  }
  const { transaction: challengeXdr, network_passphrase } = (await challengeRes.json()) as {
    transaction: string;
    network_passphrase?: string;
  };

  const effectivePassphrase = network_passphrase ?? networkPassphrase;
  const signedXdr = await signChallenge(challengeXdr, effectivePassphrase);

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
  /** URL to open in a browser tab for the interactive KYC / payment flow */
  url: string;
  /** Anchor-assigned transaction ID — use this to poll status */
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
  withdraw_memo_type?: 'text' | 'id' | 'hash';
}

// ── Deposit ──────────────────────────────────────────────────────────────────

export async function initiateDeposit(
  transferServerUrl: string,
  params: { assetCode: string; account: string; lang?: string },
  jwt?: string,
): Promise<Sep24InteractiveResult> {
  const body = new URLSearchParams({
    asset_code: params.assetCode,
    account: params.account,
    lang: params.lang ?? 'en',
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

// ── Withdraw ─────────────────────────────────────────────────────────────────

export async function initiateWithdraw(
  transferServerUrl: string,
  params: { assetCode: string; account: string; amount?: string; lang?: string },
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

// ── Status polling ───────────────────────────────────────────────────────────

export async function getTransactionStatus(
  transferServerUrl: string,
  txnId: string,
  jwt?: string,
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
export function isSep24Complete(status: string): boolean {
  return ['completed', 'error', 'refunded', 'expired'].includes(status);
}
