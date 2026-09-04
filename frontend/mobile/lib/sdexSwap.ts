/**
 * Classic Stellar DEX swap — a Horizon path payment through the on-chain order
 * book. Unlike Soroswap (whose API + liquidity are mainnet-only), the SDEX runs
 * on testnet, so this is the swap engine used there. It self-sends via
 * pathPaymentStrictSend and auto-adds the destination trustline when missing.
 *
 * Liquidity still has to exist: if no offers bridge the pair, the path lookup
 * returns nothing and we surface a clear "no liquidity" error.
 */

import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { inclusionFee } from './fees';

/**
 * Well-known issuers per network for the assets we route classically.
 * - Testnet USDC = the issuer the web wallet swaps against (the one with actual
 *   testnet DEX liquidity; differs from the Lens price-oracle issuer).
 * - Mainnet USDC = Circle's issuer (verified via Horizon 2026-08-21: 2.35M
 *   authorized accounts). NGNC = Link.io's naira stablecoin (offramp rail).
 */
const ISSUERS: Record<'testnet' | 'mainnet', Record<string, string>> = {
  testnet: {
    USDC: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
  mainnet: {
    USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
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

type PathHop = { asset_type: string; asset_code?: string; asset_issuer?: string };

function hopToAsset(h: PathHop): Asset {
  return h.asset_type === 'native' ? Asset.native() : new Asset(h.asset_code!, h.asset_issuer!);
}

/** Best-effort quote: the destination amount for `amountIn` of source. */
export async function getSdexQuote(
  sourceCode: string,
  amountIn: string,
  destCode: string,
): Promise<{ amountOut: string; path: Asset[] } | null> {
  const src = classicAsset(sourceCode);
  const dst = classicAsset(destCode);
  if (!src || !dst || !(Number(amountIn) > 0) || assetKey(src) === assetKey(dst)) return null;

  const server = new Horizon.Server(getNetwork().horizonUrl);
  try {
    const res = await server.strictSendPaths(src, amountIn, [dst]).call();
    const best = (res.records as unknown as Array<{ destination_amount: string; path: PathHop[] }>)[0];
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
  sourceCode: string;
  amountIn: string;
  destCode: string;
  slippageBps: number;
}): Promise<string> {
  const src = classicAsset(params.sourceCode);
  const dst = classicAsset(params.destCode);
  if (!src) throw new Error(`${params.sourceCode} isn't available for testnet swaps.`);
  if (!dst) throw new Error(`${params.destCode} isn't available for testnet swaps.`);

  const network = getNetwork();
  const server = new Horizon.Server(network.horizonUrl);
  const kp = Keypair.fromSecret(params.signerSecret);

  const paths = await server.strictSendPaths(src, params.amountIn, [dst]).call();
  const best = (paths.records as unknown as Array<{ destination_amount: string; path: PathHop[] }>)[0];
  if (!best) throw new Error('No DEX path for this pair — there is no testnet liquidity bridging it.');

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
