import { Horizon, StrKey } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { fetchPrice, usdValue } from './fetchPrice';
import { fetchContractAssetBalance, fetchContractXlm, getFeePayerAddress } from './activity';

export type Holding = {
  code: string;
  name: string;
  issuer: string | null;
  balance: string;
  /** USD value of the whole balance, or null when unpriced. */
  usd: number | null;
  /** Whether this is the native (XLM) balance. */
  native: boolean;
};

/** Display name for well-known assets; falls back to the code. */
const ASSET_NAMES: Record<string, string> = {
  XLM: 'Lumens',
  USDC: 'USD Coin',
};

function isAccountNotFound(err: unknown): boolean {
  const e = err as { name?: string; response?: { status?: number } };
  return e?.name === 'NotFoundError' || e?.response?.status === 404;
}

/**
 * Load an account's holdings (native XLM + classic trustlines), each priced
 * best-effort. Native first. Shared by the assets list and the send-flow asset
 * selector so both show the same balances.
 */
export async function loadHoldings(address: string): Promise<Holding[]> {
  const server = new Horizon.Server(getNetwork().horizonUrl);
  let balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }>;

  // A smart (contract) wallet has no Horizon account: read its native XLM over
  // Soroban RPC and combine it with the fee-payer G-account, whose classic
  // balances (Friendbot XLM, trustlines) are the spendable side.
  let contractExtraXlm = 0;
  let effective = address;
  if (StrKey.isValidContract(address)) {
    contractExtraXlm = await fetchContractXlm(address);
    const feePayer = await getFeePayerAddress();
    if (!feePayer) {
      return contractExtraXlm > 0
        ? [{ code: 'XLM', name: ASSET_NAMES['XLM']!, issuer: null, balance: contractExtraXlm.toFixed(7), usd: null, native: true }]
        : [];
    }
    effective = feePayer;
  }

  // The dashboard fires several Horizon/RPC calls at once on mount, and Android
  // intermittently drops one with a bare network error ("Unknown") — retry once
  // before concluding anything about the account.
  balances = [];
  let loaded = false;
  let missing = false;
  for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
    try {
      const account = await server.loadAccount(effective);
      balances = account.balances as typeof balances;
      loaded = true;
    } catch (err) {
      if (isAccountNotFound(err)) {
        missing = true; // definitive: the account does not exist
        break;
      }
      console.warn('[holdings] loadAccount failed:', err instanceof Error ? `${err.name}: ${err.message}` : err);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // "Could not reach Horizon" and "this wallet is empty" are different facts,
  // and returning [] for both let the worse one be shown as the better-known
  // one: a funded wallet greeted the user with "No assets yet. Fund this
  // wallet to get started." — under a balance card that was, at that moment,
  // correctly reading 5.35 XLM. That is not a cosmetic inconsistency; it is the
  // wallet telling someone their money is gone.
  //
  // A missing account is genuinely empty. An unreachable one is unknown, and
  // callers get to say so instead of guessing.
  if (!loaded && !missing) {
    throw new Error('Could not reach the network to read balances.');
  }
  if (!loaded) {
    // Account does not exist yet: whatever the contract itself holds is the
    // whole story.
    balances = contractExtraXlm > 0 ? [{ asset_type: 'native', balance: '0' }] : [];
    if (balances.length === 0) return [];
  }

  const rows: Array<{ code: string; issuer: string | null; balance: string; native: boolean }> = [];
  for (const b of balances) {
    if (b.asset_type === 'native') {
      const total = Number(b.balance) + contractExtraXlm;
      rows.unshift({ code: 'XLM', issuer: null, balance: total.toFixed(7), native: true });
    } else if ((b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') && b.asset_code) {
      rows.push({ code: b.asset_code, issuer: b.asset_issuer ?? null, balance: b.balance, native: false });
    }
  }

  // Add what the CONTRACT holds of each issued asset, not just its XLM.
  //
  // A contract's balance is a SAC contract-storage entry, invisible to the
  // Horizon account read above — that only ever sees the fee payer's
  // trustlines. Until contracts could hold anything but XLM this did not
  // matter; now that they can, sending USDC from the fee payer into the
  // contract made 5 of 17 USDC vanish from the list, because the side holding
  // it was never read.
  if (StrKey.isValidContract(address)) {
    await Promise.all(
      rows
        .filter((r) => !r.native && r.issuer)
        .map(async (r) => {
          const held = await fetchContractAssetBalance(address, {
            code: r.code,
            issuer: r.issuer as string,
          });
          if (held > 0) r.balance = (Number(r.balance) + held).toFixed(7);
        }),
    );
  }

  return Promise.all(
    rows.map(async (r): Promise<Holding> => {
      const price = await fetchPrice(r.code, r.issuer);
      return {
        code: r.code,
        name: ASSET_NAMES[r.code] ?? r.code,
        issuer: r.issuer,
        balance: r.balance,
        usd: usdValue(r.balance, price),
        native: r.native,
      };
    }),
  );
}

/** Per-unit USD price of a holding, or null when unpriced. */
export function unitPrice(h: Holding): number | null {
  const bal = Number(h.balance);
  if (h.usd === null || !isFinite(bal) || bal <= 0) return null;
  return h.usd / bal;
}
