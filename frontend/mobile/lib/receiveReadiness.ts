/**
 * Can this wallet actually receive USDC right now?
 *
 * The question is not rhetorical. A Veil wallet has two addresses and only one
 * of them can be paid by an ordinary sender:
 *
 *   - The **C address** is a Soroban contract. It can hold any asset with no
 *     trustline and no reserve, which is lovely, but a classic payment
 *     operation cannot name a contract as its destination at all. Anyone paying
 *     from an exchange, a payroll tool, or another wallet is sending a classic
 *     payment, and it will be rejected outright.
 *   - The **G address** (the fee payer) is an ordinary Stellar account, so
 *     anyone can pay it. But on Stellar an account must exist before it can be
 *     paid, and it must hold a trustline for a non-native asset before that
 *     asset can arrive. Both cost reserve, and a brand new wallet has none.
 *
 * So a fresh mainnet wallet can receive nothing until someone provisions its G
 * account. This module answers which of those states the wallet is in, and
 * keeps "I could not reach Horizon" separate from "not ready" — reporting a
 * failed lookup as a definite no is how a working wallet gets called broken.
 */

import { getNetwork, getNetworkName } from './network';

/** Canonical USDC issuers. Mainnet is Circle's; testnet is the SDF test issuer. */
const USDC_ISSUERS: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

export function usdcIssuerFor(network: 'mainnet' | 'testnet'): string {
  return USDC_ISSUERS[network];
}

export type ReceiveReadiness =
  /** The G account exists and holds a USDC trustline. Payments will land. */
  | { state: 'ready'; address: string; balance: string }
  /** Account exists but has no USDC trustline. Needs 0.5 XLM of reserve to add one. */
  | { state: 'needs-trustline'; address: string; xlm: string }
  /** No account on chain at all. Needs creating before anything can be sent to it. */
  | { state: 'needs-account'; address: string }
  /**
   * Horizon could not be reached. NOT the same as "not ready" — the wallet may
   * be perfectly able to receive and we simply do not know yet.
   */
  | { state: 'unknown'; address: string; reason: string };

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

/**
 * Ask Horizon whether `gAddress` is ready to receive USDC.
 *
 * A 404 from Horizon is a real answer — the account does not exist — and is
 * reported as `needs-account` rather than as a failure. Every other error is
 * `unknown`.
 */
export async function checkReceiveReadiness(
  gAddress: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReceiveReadiness> {
  const doFetch = opts.fetchImpl ?? fetch;
  const network = getNetworkName();
  const issuer = USDC_ISSUERS[network];
  const url = `${getNetwork().horizonUrl.replace(/\/+$/, '')}/accounts/${encodeURIComponent(gAddress)}`;

  let res: Response;
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  } catch (err) {
    return {
      state: 'unknown',
      address: gAddress,
      reason: err instanceof Error ? err.message : 'Could not reach the network',
    };
  }

  // Horizon says 404 for an account that has never been funded. That is a fact
  // about the account, not a failure of the request.
  if (res.status === 404) return { state: 'needs-account', address: gAddress };
  if (!res.ok) {
    return { state: 'unknown', address: gAddress, reason: `Horizon returned HTTP ${res.status}` };
  }

  let balances: HorizonBalance[];
  try {
    const body = (await res.json()) as { balances?: HorizonBalance[] };
    if (!Array.isArray(body.balances)) throw new Error('unexpected response shape');
    balances = body.balances;
  } catch (err) {
    return {
      state: 'unknown',
      address: gAddress,
      reason: err instanceof Error ? err.message : 'Unreadable response',
    };
  }

  const usdc = balances.find(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer,
  );
  if (usdc) return { state: 'ready', address: gAddress, balance: usdc.balance };

  const native = balances.find((b) => b.asset_type === 'native');
  return { state: 'needs-trustline', address: gAddress, xlm: native?.balance ?? '0' };
}

/**
 * One line a person can act on, for each state.
 *
 * Deliberately not "no assets yet". Someone waiting on a payout needs to know
 * whether to send the address or wait, and the difference between "not set up"
 * and "we could not check" decides that.
 */
export function readinessMessage(r: ReceiveReadiness): string {
  switch (r.state) {
    case 'ready':
      return 'Ready to receive USDC.';
    case 'needs-trustline':
      return 'This address exists but cannot hold USDC yet. It needs a USDC trustline.';
    case 'needs-account':
      return 'This address is not active on the network yet. It has to be created before anyone can pay it.';
    case 'unknown':
      return `Could not check this address right now. ${r.reason}`;
  }
}
