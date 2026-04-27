/**
 * SEP-24 Hosted Deposit/Withdrawal utility.
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 *
 * Provides:
 *  - TOML discovery  (discoverTransferServer)
 *  - Interactive deposit initiation  (initiateDeposit)
 *  - Transaction status polling  (getTransactionStatus)
 */

export interface Sep24DepositParams {
  /** Asset code, e.g. "USDC" or "XLM" */
  assetCode: string
  /** The G... Stellar account that will receive the deposit */
  account: string
  /** BCP-47 language code passed to the anchor iframe (default: "en") */
  lang?: string
}

export interface Sep24DepositResult {
  /** URL to embed in an iframe for the interactive KYC / payment flow */
  url: string
  /** Anchor-assigned transaction ID — use this to poll status */
  id: string
}

export interface Sep24TransactionStatus {
  id: string
  /** SEP-24 status: pending_user_transfer_start | pending_anchor | completed | error | … */
  status: string
  /** Hash of the on-chain Stellar transaction once settled */
  stellar_transaction_id?: string
  /** Human-readable message from the anchor */
  message?: string
  /** Amount credited to the user's account */
  amount_in?: string
  /** Asset code of the credited amount */
  amount_in_asset?: string
}

// ── TOML discovery ────────────────────────────────────────────────────────────

/**
 * Parses the anchor's stellar.toml and extracts TRANSFER_SERVER_SEP0024.
 * Throws if the TOML is missing or malformed.
 */
export async function discoverTransferServer(anchorDomain: string): Promise<string> {
  const tomlUrl = `https://${anchorDomain}/.well-known/stellar.toml`
  const res = await fetch(tomlUrl, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) {
    throw new Error(`Could not fetch stellar.toml from ${anchorDomain} (HTTP ${res.status})`)
  }

  const text  = await res.text()
  const match = text.match(/TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/)
  if (!match) {
    throw new Error(`TRANSFER_SERVER_SEP0024 not found in ${anchorDomain}/.well-known/stellar.toml`)
  }

  return match[1].replace(/\/$/, '') // strip trailing slash for safe URL concatenation
}

// ── Deposit initiation ────────────────────────────────────────────────────────

/**
 * Starts a SEP-24 interactive deposit session with the anchor.
 * Returns the iframe URL and the anchor transaction ID.
 */
export async function initiateDeposit(
  transferServerUrl: string,
  params: Sep24DepositParams,
): Promise<Sep24DepositResult> {
  const body = new URLSearchParams({
    asset_code: params.assetCode,
    account:    params.account,
    lang:       params.lang ?? 'en',
  })

  const res = await fetch(`${transferServerUrl}/transactions/deposit/interactive`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
    signal:  AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Deposit initiation failed (HTTP ${res.status}): ${errText}`)
  }

  const data = await res.json() as { url?: string; id?: string }
  if (!data.url || !data.id) {
    throw new Error('Anchor returned an invalid response (missing url or id)')
  }

  return { url: data.url, id: data.id }
}

// ── Status polling ────────────────────────────────────────────────────────────

/**
 * Fetches the current status of an anchor transaction.
 * Use this to drive a polling loop while the iframe is open.
 */
export async function getTransactionStatus(
  transferServerUrl: string,
  txnId: string,
): Promise<Sep24TransactionStatus> {
  const res = await fetch(`${transferServerUrl}/transaction?id=${encodeURIComponent(txnId)}`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch transaction status (HTTP ${res.status})`)
  }

  const data = await res.json() as { transaction?: Sep24TransactionStatus }
  if (!data.transaction) {
    throw new Error('Anchor response missing transaction object')
  }
  return data.transaction
}

// ── Terminal-status helper ────────────────────────────────────────────────────

/** Returns true once a SEP-24 status no longer requires polling. */
export function isSep24Complete(status: string): boolean {
  return ['completed', 'error', 'refunded', 'expired'].includes(status)
}
