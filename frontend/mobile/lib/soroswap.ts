import { errorMessage } from './errorMessage';
import {
  SoroswapSDK,
  SupportedNetworks,
  SupportedProtocols,
  TradeType,
} from '@soroswap/sdk';
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { inclusionFee } from './fees';
import { getNetwork, getNetworkName } from './network';

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
  rawQuote: unknown;
  ttl: number; // unix timestamp when the quote expires
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string; // in stroops / base units as string
  slippageBps: number; // e.g. 50 = 0.5%
  feePayerAddress: string;
}

/**
 * Fetch a live swap quote from the Soroswap aggregator router.
 * Returns null when the SDK is unavailable or the pair has no liquidity.
 */
export async function getSoroswapQuote(params: SwapParams): Promise<SwapQuote | null> {
  try {
    const client = getSoroswapClient();
    if (!client) {
      console.warn('[soroswap] EXPO_PUBLIC_SOROSWAP_API_KEY is missing; using SDEX fallback');
      return null;
    }

    const result = await client.quote({
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

    if (!result?.amountOut) return null;
    const routePlan = result.routePlan ?? [];
    return {
      amountOut: result.amountOut.toString(),
      priceImpact: Number(result.priceImpactPct || '0'),
      path: routePlan.flatMap((r) => r.swapInfo.path),
      protocols: [...new Set(routePlan.map((r) => r.swapInfo.protocol))],
      rawQuote: result,
      ttl: Date.now() + 30_000, // 30-second TTL
    };
  } catch (err) {
    console.warn('[soroswap] getQuote failed:', err);
    return null;
  }
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

export async function buildSoroswapSwapXdr(params: SwapParams): Promise<string> {
  try {
    const client = getSoroswapClient();
    if (!client) {
      // No API key configured, so the router is unreachable. Say that rather
      // than reporting it as a failed build — it is a deployment gap, not
      // something the user did.
      throw new SoroswapBuildError(
        'Swaps are unavailable: this build has no Soroswap API key configured.',
      );
    }

    const quote = await client.quote({
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

    const build = await client.build({
      quote,
      from: params.feePayerAddress,
      to: params.feePayerAddress,
    });

    return build.xdr;
  } catch (err) {
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
 * Resolve a symbol to its Soroban contract address for the active network.
 * Native XLM is derived locally (it is never in any token list); other symbols
 * come from Soroswap's curated list, whose shape is `{ assets: [{ code,
 * issuer, contract, … }] }` with the network implied by the list itself
 * (mainnet). Testnet token routing goes through the classic DEX instead.
 */
export async function resolveTokenAddress(symbol: string): Promise<string | null> {
  const code = symbol.toUpperCase();
  if (code === 'XLM') return Asset.native().contractId(getNetwork().networkPassphrase);
  if (isTestnet()) return null;
  return (await fetchListAsset(code))?.contract ?? null;
}

type ListAsset = { code?: string; issuer?: string; contract?: string };

async function fetchListAsset(code: string): Promise<ListAsset | null> {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'
    );
    const list = await res.json();
    const assets: ListAsset[] = list.assets ?? [];
    return assets.find((t) => (t.code ?? '').toUpperCase() === code) ?? null;
  } catch {
    return null;
  }
}

/**
 * Make sure the spending account trusts the asset a swap will pay out. The
 * Soroswap router refuses to build a swap whose receiver lacks the destination
 * trustline ("Missing trustline in G… for asset: X"), and SAC payouts to a
 * G-account need one regardless. No-op for XLM and already-trusted assets.
 * The (code, issuer) pair comes from the same curated list the swap's contract
 * address does, so the trustline always matches what the router delivers.
 * Note: a new trustline locks a further 0.5 XLM of base reserve.
 */
export async function ensureSwapOutTrustline(signerSecret: string, code: string): Promise<void> {
  const u = code.toUpperCase();
  if (u === 'XLM' || isTestnet()) return;
  const entry = await fetchListAsset(u);
  if (!entry?.issuer) return; // unknown asset — let the router's own error surface
  const asset = new Asset(u, entry.issuer);

  const network = getNetwork();
  const server = new Horizon.Server(network.horizonUrl);
  const kp = Keypair.fromSecret(signerSecret);
  const account = await server.loadAccount(kp.publicKey());
  const trusted = (account.balances as unknown as Array<Record<string, unknown>>).some(
    (b) => b['asset_code'] === asset.getCode() && b['asset_issuer'] === asset.getIssuer(),
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
