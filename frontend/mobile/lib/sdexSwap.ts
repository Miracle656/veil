/**
 * Classic Stellar DEX swap — a Horizon path payment through the on-chain order
 * book. Unlike Soroswap (whose API + liquidity are mainnet-only), the SDEX runs
 * on testnet, so this is the swap engine used there. It self-sends via
 * pathPaymentStrictSend and auto-adds the destination trustline when missing.
 *
 * Liquidity still has to exist: if no offers bridge the pair, the path lookup
 * returns nothing and we surface a clear "no liquidity" error.
 */

import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { inclusionFee } from './fees';
import { classicAsset, pathPaysOut, sameSwapAsset, type PathRecordAssets, type SwapAsset } from './swapAssets';
import { assertFeePayerCanCoverFee } from './feePayerCheck';

/**
 * Well-known issuers per network for the assets we route classically.
 * - Testnet USDC = the issuer the web wallet swaps against (the one with actual
 *   testnet DEX liquidity; differs from the Lens price-oracle issuer).
 * - Testnet USDY = test issuer for yield-bearing stablecoin testing
 * - Mainnet USDC = Circle's issuer (verified via Horizon 2026-08-21: 2.35M
 *   authorized accounts). NGNC = Link.io's naira stablecoin (offramp rail).
 * - Mainnet USDY = will be resolved from Soroswap token list
 */
const ISSUERS: Record<'testnet' | 'mainnet', Record<string, string>> = {
  testnet: {
    USDC: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    USDY: 'GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH', // Test issuer for USDY
  },
  mainnet: {
    USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    USDY: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2BRUY4DQAT2B', // Mainnet USDY issuer
    NGNC: 'GASBV6W7GGED66MXEVC7YZHTWWYMSVYEY35USF2HJZBLABLYIFQGXZY6',
  },
};

/** Map a symbol to a classic Asset, or null when we don't know its issuer. */
export function classicAsset(code: string): Asset | null {
  const u = code.toUpperCase();
  if (u === 'XLM') return Asset.native();
  const issuer = ISSUERS[getNetwork().name]?.[u];
  return issuer ? new Asset(u, issuer) : null;
}

/** Whether a symbol can be routed on the classic DEX (known issuer). */
export function sdexSupported(code: string): boolean {
  return classicAsset(code) !== null;
}

function assetKey(a: Asset): string {
  return a.isNative() ? 'native' : `${a.getCode()}:${a.getIssuer()}`;
}
// Assets arrive as registry-checked code:issuer pairs (lib/swapAssets). This
// module used to keep its own code → issuer table — a third, unsynced copy of
// the registry — and resolve a symbol through it (#793).

type PathHop = { asset_type: string; asset_code?: string; asset_issuer?: string };
type PathRecord = PathRecordAssets & { destination_amount: string; path: PathHop[] };

function hopToAsset(h: PathHop): Asset {
  return h.asset_type === 'native' ? Asset.native() : new Asset(h.asset_code!, h.asset_issuer!);
}

/** The best path that pays out exactly `to` — never a path to another asset. */
function bestPathTo(records: unknown, to: SwapAsset): PathRecord | undefined {
  return (records as PathRecord[]).find((r) => pathPaysOut(r, to));
}

/** Best-effort quote: the destination amount for `amountIn` of `from`. */
export async function getSdexQuote(
  from: SwapAsset,
  amountIn: string,
  to: SwapAsset,
): Promise<{ amountOut: string; path: Asset[] } | null> {
  if (!(Number(amountIn) > 0) || sameSwapAsset(from, to)) return null;

  const server = new Horizon.Server(getNetwork().horizonUrl);
  try {
    const res = await server.strictSendPaths(classicAsset(from), amountIn, [classicAsset(to)]).call();
    const best = bestPathTo(res.records, to);
    if (!best) return null;
    return { amountOut: best.destination_amount, path: (best.path ?? []).map(hopToAsset) };
  } catch {
    return null;
  }
}

/** Does the account already trust (or issue) this asset? */
function trustsAsset(balances: Array<Record<string, unknown>>, asset: Asset): boolean {
  if (asset.isNative()) return true;
  return balances.some(
    (b) => b['asset_code'] === asset.getCode() && b['asset_issuer'] === asset.getIssuer(),
  );
}

/**
 * Execute an XLM↔asset swap on the classic DEX. Adds the destination trustline
 * first when missing, then a pathPaymentStrictSend to self. Returns the hash.
 */
export async function sdexSwap(params: {
  signerSecret: string;
  from: SwapAsset;
  amountIn: string;
  to: SwapAsset;
  slippageBps: number;
}): Promise<string> {
  const src = classicAsset(params.from);
  const dst = classicAsset(params.to);

  const network = getNetwork();
  const server = new Horizon.Server(network.horizonUrl);
  const kp = Keypair.fromSecret(params.signerSecret);

  await assertFeePayerCanCoverFee(kp.publicKey());

  const paths = await server.strictSendPaths(src, params.amountIn, [dst]).call();
  const best = bestPathTo(paths.records, params.to);
  if (!best) throw new Error('No DEX path for this pair — there is no liquidity bridging it.');

  const destMin = (Number(best.destination_amount) * (1 - params.slippageBps / 10_000)).toFixed(7);
  const path = (best.path ?? []).map(hopToAsset);

  const account = await server.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  });

  // The order book pays out `dst`, so the account must trust it first.
  if (!trustsAsset(account.balances as unknown as Array<Record<string, unknown>>, dst)) {
    builder.addOperation(Operation.changeTrust({ asset: dst }));
  }

  const tx = builder
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: src,
        sendAmount: params.amountIn,
        destination: kp.publicKey(),
        destAsset: dst,
        destMin,
        path,
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return res.hash;
}
