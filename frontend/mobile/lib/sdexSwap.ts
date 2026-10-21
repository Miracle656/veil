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
import { fetchPlatformFee } from './platformFee';
import { spendableNativeXlm } from './reserves';

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
 *
 * ## Platform fee on swaps
 *
 * Classic SDEX transactions can carry multiple classic operations, so the
 * platform fee rides alongside the swap as an extra payment operation.
 *
 * In contrast, Soroswap swaps execute as a Soroban contract invocation. A
 * Stellar transaction may carry at most ONE Soroban operation, and cannot mix
 * contract invocations with classic fee payments in the same transaction.
 * Therefore, Soroswap swaps cannot carry a platform fee without requiring a
 * second transaction (which would require a second signature/passkey ceremony
 * and create partial-execution risk). Thus, Soroswap swaps remain unfeeable
 * by design.
 *
 * Affordability is checked before the fee operation is added. A fee the user
 * did not ask for must never cause a swap to fail.
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

  builder.addOperation(
    Operation.pathPaymentStrictSend({
      sendAsset: src,
      sendAmount: params.amountIn,
      destination: kp.publicKey(),
      destAsset: dst,
      destMin,
      path,
    }),
  );

  // Platform fee: fetch quote for sending `amountIn` of `src`.
  // Denominated in the source asset so paying the swap means paying the fee.
  const feeAssetCode = params.from.issuer ? params.from.code : 'XLM';
  const platformFee = await fetchPlatformFee(feeAssetCode, Number(params.amountIn));
  if (platformFee) {
    const held = (account.balances as unknown as Array<Record<string, unknown>>).find((b) =>
      platformFee.assetIssuer === null
        ? b['asset_type'] === 'native'
        : b['asset_code'] === platformFee.assetCode && b['asset_issuer'] === platformFee.assetIssuer,
    );

    // XLM has reserve requirements; non-native balances have no reserve.
    const available = platformFee.assetIssuer === null
      ? Number(spendableNativeXlm(account))
      : held ? Number(held['balance']) : 0;

    // Affordability check: balance must cover both swap amount and fee.
    // An unaffordable fee means no fee, never a failed swap.
    if (available >= Number(params.amountIn) + Number(platformFee.amount)) {
      builder.addOperation(
        Operation.payment({
          destination: platformFee.destination,
          asset: platformFee.assetIssuer
            ? new Asset(platformFee.assetCode, platformFee.assetIssuer)
            : Asset.native(),
          amount: platformFee.amount,
        }),
      );
    }
  }

  const tx = builder.setTimeout(60).build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return res.hash;
}
