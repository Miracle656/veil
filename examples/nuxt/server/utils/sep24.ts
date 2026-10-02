/**
 * Minimal server-side SEP-24 helpers used by the Nitro routes.
 *
 * Unlike the browser SEP-24 utility in `frontend/wallet/lib/sep24.ts`, these run
 * on the server and therefore touch no `localStorage` or WebAuthn APIs — they
 * only speak HTTP to the anchor. See SEP-24:
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 */

export interface AnchorInfo {
  transferServerUrl: string
  webAuthEndpoint: string | null
}

/** Read TRANSFER_SERVER_SEP0024 (and WEB_AUTH_ENDPOINT) from the anchor's TOML. */
export async function discoverAnchorInfo(anchorDomain: string): Promise<AnchorInfo> {
  const res = await fetch(`https://${anchorDomain}/.well-known/stellar.toml`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Could not fetch stellar.toml from ${anchorDomain} (HTTP ${res.status})`)
  }
  const text = await res.text()

  const transfer = text.match(/TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/)
  if (!transfer) {
    throw new Error(`TRANSFER_SERVER_SEP0024 not found in ${anchorDomain}/.well-known/stellar.toml`)
  }
  const webAuth = text.match(/WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/)

  return {
    transferServerUrl: transfer[1].replace(/\/$/, ''),
    webAuthEndpoint: webAuth ? webAuth[1].replace(/\/$/, '') : null,
  }
}

export interface Sep24InteractiveResult {
  url: string
  id: string
}

/**
 * Start an interactive deposit. `callbackUrl` is passed to the anchor so it
 * redirects the user back to our /api/sep24/callback route when the flow ends.
 */
export async function initiateDeposit(
  transferServerUrl: string,
  params: { assetCode: string; account: string; callbackUrl?: string; lang?: string },
  jwt?: string,
): Promise<Sep24InteractiveResult> {
  const body = new URLSearchParams({
    asset_code: params.assetCode,
    account: params.account,
    lang: params.lang ?? 'en',
    ...(params.callbackUrl ? { callback: params.callbackUrl } : {}),
  })

  const res = await fetch(`${transferServerUrl}/transactions/deposit/interactive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Deposit initiation failed (HTTP ${res.status}): ${errText}`)
  }

  const data = (await res.json()) as { url?: string; id?: string }
  if (!data.url || !data.id) {
    throw new Error('Anchor returned an invalid response (missing url or id)')
  }
  return { url: data.url, id: data.id }
}

export interface Sep24TransactionStatus {
  id: string
  status: string
  stellar_transaction_id?: string
  message?: string
}

/** Fetch the canonical status of a SEP-24 transaction from the anchor. */
export async function getTransactionStatus(
  transferServerUrl: string,
  txnId: string,
  jwt?: string,
): Promise<Sep24TransactionStatus> {
  const res = await fetch(`${transferServerUrl}/transaction?id=${encodeURIComponent(txnId)}`, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Failed to fetch transaction status (HTTP ${res.status})`)

  const data = (await res.json()) as { transaction?: Sep24TransactionStatus }
  if (!data.transaction) throw new Error('Anchor response missing transaction object')
  return data.transaction
}
