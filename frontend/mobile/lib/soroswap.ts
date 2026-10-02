import { errorMessage } from './errorMessage';
import {
  SoroswapSDK,
  SupportedNetworks,
  SupportedProtocols,
  TradeType,
  type QuoteResponse,
} from '@soroswap/sdk';
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { inclusionFee } from './fees';
import { getNetwork, getNetworkName } from './network';
import { classicAsset, quoteMismatch, type SwapAsset } from './swapAssets';
import { assertFeePayerCanCoverFee } from './feePayerCheck';

const SOROSWAP_API_KEY = process.env['EXPO_PUBLIC_SOROSWAP_API_KEY']?.trim() || '';

/** Whether the *currently active* network is testnet. Read per call, not cached. */
function isTestnet(): boolean {
  return getNetworkName() === 'testnet';
}

function getSoroswapClient(): SoroswapSDK | null {
  if (!SOROSWAP_API_KEY) {
    return null;
  }
  // Built per call rather than memoised: the user can switch networks at
  // runtime, and a client pinned at module load would keep quoting the old one.
  return new SoroswapSDK({
    apiKey: SOROSWAP_API_KEY,
    defaultNetwork: isTestnet() ? SupportedNetworks.TESTNET : SupportedNetworks.MAINNET,
  });
}

export interface SwapQuote {
  amountOut: string;
  priceImpact: number;
  path: string[];
  protocols: string[];
  rawQuote: QuoteResponse | null;
  ttl: number; // unix timestamp when the quote expires
}

export interface SwapParams {
  /** SAC of the asset paid — derived from code:issuer (lib/swapAssets), never looked up by symbol. */
  tokenIn: string;
  /** SAC of the asset received, derived the same way. */
  tokenOut: string;
  amountIn: string; // in stroops / base units as string
  slippageBps: number; // e.g. 50 = 0.5%
  feePayerAddress: string;
}

/**
 * The outcome of asking the router. A `mismatch` — the router answered about
 * a different asset than the SACs it was asked for — is never shown as a
 * quote (#793).
 */
export type SoroswapQuoteResult =
  | { ok: true; quote: SwapQuote }
  | { ok: false; kind: 'unavailable' | 'no-route' | 'mismatch'; reason: string };

/** Fetch a live swap quote from the Soroswap aggregator router. */
export async function getSoroswapQuote(params: SwapParams): Promise<SoroswapQuoteResult> {
  const client = getSoroswapClient();
  if (!client) {
    console.warn('[soroswap] EXPO_PUBLIC_SOROSWAP_API_KEY is missing; using SDEX fallback');
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'Swaps are unavailable: this build has no Soroswap API key configured.',
    };
  }

  let result: QuoteResponse;
  try {
    result = await client.quote({
      assetIn: params.tokenIn,
      assetOut: params.tokenOut,
      amount: BigInt(params.amountIn),
      tradeType: TradeType.EXACT_IN,
      protocols: [
        SupportedProtocols.SOROSWAP,
        SupportedProtocols.PHOENIX,
        SupportedProtocols.AQUA,
        SupportedProtocols.SDEX,
      ],
      slippageBps: params.slippageBps,
    });
  } catch (err) {
    console.warn('[soroswap] getQuote failed:', err);
    return { ok: false, kind: 'unavailable', reason: 'Quote failed. Check your connection.' };
  }

  if (!result?.amountOut)
    return { ok: false, kind: 'no-route', reason: 'Soroswap found no route for this pair.' };
  const mismatch = quoteMismatch(result, params.tokenIn, params.tokenOut);
  if (mismatch) return { ok: false, kind: 'mismatch', reason: mismatch };

  const routePlan = result.routePlan ?? [];
  return {
    ok: true,
    quote: {
      amountOut: result.amountOut.toString(),
      priceImpact: Number(result.priceImpactPct || '0'),
      path: routePlan.flatMap((r) => r.swapInfo.path),
      protocols: [...new Set(routePlan.map((r) => r.swapInfo.protocol))],
      rawQuote: result,
      ttl: Date.now() + 30_000, // 30-second TTL
    },
  };
}

/**
 * Build an assembled Soroswap swap XDR ready for passkey signing.
 * Returns null on failure (caller should fall back to classic SDEX).
 */
/** A swap the router could not build, carrying the reason it gave. */
export class SoroswapBuildError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SoroswapBuildError';
    this.cause = cause;
  }
}

/**
 * Build the swap from the quote the user reviewed — not a fresh one, which
 * could route differently from what was shown.
 */
export async function buildSoroswapSwapXdr(
  quote: QuoteResponse,
  feePayerAddress: string
): Promise<string> {
  try {
    const client = getSoroswapClient();
    if (!client) {
      // No API key configured, so the router is unreachable. Say that rather
      // than reporting it as a failed build — it is a deployment gap, not
      // something the user did.
      throw new SoroswapBuildError(
        'Swaps are unavailable: this build has no Soroswap API key configured.'
      );
    }

    await assertFeePayerCanCoverFee(feePayerAddress);

    const build = await client.build({
      quote,
      from: feePayerAddress,
      to: feePayerAddress,
    });

    return build.xdr;
  } catch (err) {
    if (err instanceof SoroswapBuildError) throw err;
    console.warn('[soroswap] buildSwapXdr failed:', err);
    // Rethrow with the underlying reason attached rather than returning null.
    //
    // Swallowing it meant every failure — no liquidity for the pair, an amount
    // below the router's minimum, and most commonly an account with no funds —
    // reached the user as the same "Failed to build swap transaction." That
    // tells them nothing about what to do next, which is the only thing an
    // error at this point is for.
    throw new SoroswapBuildError(errorMessage(err), err);
  }
}

/**
 * Make sure the spending account trusts the asset a swap will pay out. The
 * Soroswap router refuses to build a swap whose receiver lacks the destination
 * trustline ("Missing trustline in G… for asset: X"), and SAC payouts to a
 * G-account need one regardless. No-op for XLM and already-trusted assets.
 * The asset is the registry-checked code:issuer the swap was quoted for — the
 * same pair its SAC was derived from — so the trustline always matches what
 * the router delivers. It used to be looked up by code in Soroswap's token
 * list, which would trust whichever issuer that list happened to name (#793).
 * Note: a new trustline locks a further 0.5 XLM of base reserve.
 */
export async function ensureSwapOutTrustline(signerSecret: string, to: SwapAsset): Promise<void> {
  if (!to.issuer || isTestnet()) return;
  const asset = classicAsset(to);

  const network = getNetwork();
  const server = new Horizon.Server(network.horizonUrl);
  const kp = Keypair.fromSecret(signerSecret);
  const account = await server.loadAccount(kp.publicKey());
  const trusted = (account.balances as unknown as Array<Record<string, unknown>>).some(
    (b) => b['asset_code'] === asset.getCode() && b['asset_issuer'] === asset.getIssuer()
  );
  if (trusted) return;

  const tx = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await server.submitTransaction(tx);
}
