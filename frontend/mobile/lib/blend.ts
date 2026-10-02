import {
  PoolV1,
  PoolV2,
  PoolContractV1,
  PoolContractV2,
  RequestType,
  type Network,
} from '@blend-capital/blend-sdk';
import { Account, Asset, BASE_FEE, rpc as SorobanRpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { usdcIssuerFor } from './receiveReadiness';

/**
 * Blend lending-pool reads and transaction building.
 *
 * Ported from `frontend/wallet/lib/blend.ts`; the only differences are the
 * `EXPO_PUBLIC_*` environment variables the Expo bundler inlines and the
 * network coming from the mobile `getNetwork()`.
 */

/**
 * Resolved per call, never captured at module load.
 *
 * The network is a runtime choice in this app — `setNetwork()` persists a
 * switch and the UI re-renders — so a module-scope `getNetwork()` freezes
 * whichever chain happened to be active when this file was first imported.
 * Blend would then keep talking to the old chain after a switch: pools loaded
 * from testnet, a deposit signed against mainnet, and no error until it fails
 * on chain.
 */
function blendNet(): Network {
  const net = getNetwork();
  return { rpc: net.rpcUrl, passphrase: net.networkPassphrase };
}

/**
 * Blend's public Fixed pool on mainnet (XLM, USDC, EURC). A pool id is public
 * and permanent, so shipping it as the default means Earn works in any build
 * rather than only in one whose environment was set up right.
 */
const DEFAULT_POOL_IDS: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  testnet: '',
};

/**
 * Pool ids are per network. A Blend pool is a contract, and a contract id on
 * testnet addresses nothing on mainnet — so one shared list cannot serve both.
 * The per-network variable wins, then the unsuffixed one, then the default.
 *
 * Every variable is read by its full literal name. Expo inlines a public env
 * var into the bundle only when the name is written out; this used to build it
 * as `EXPO_PUBLIC_BLEND_POOL_IDS_${suffix}`, which the bundler cannot see, so
 * the release APK shipped with no pools and Earn said it was unavailable on
 * mainnet while the pool was live. Tests and the dev server resolve env at
 * runtime, which is why nothing caught it before a real build.
 */
function configuredPoolIds(): string[] {
  const name = getNetwork().name;
  const perNetwork =
    name === 'mainnet'
      ? process.env.EXPO_PUBLIC_BLEND_POOL_IDS_MAINNET
      : process.env.EXPO_PUBLIC_BLEND_POOL_IDS_TESTNET;
  const configured: string =
    perNetwork?.trim() ||
    process.env.EXPO_PUBLIC_BLEND_POOL_IDS?.trim() ||
    DEFAULT_POOL_IDS[name === 'mainnet' ? 'mainnet' : 'testnet'];
  const ids = configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    console.warn(`[blend] no pools configured for ${name}`);
  }

  return ids;
}

/** The assets this app can fund a deposit in, from either of the wallet's accounts. */
export type EarnAsset = 'XLM' | 'USDC';

/**
 * The asset a reserve lends, if it is one the wallet can deposit.
 *
 * Matched on the SAC contract id, derived from the asset and the passphrase, so
 * it cannot drift from what the pool actually lists. Anything else (EURC, a
 * testnet-only token) is left out rather than shown with a deposit button that
 * could never be funded.
 */
export function earnAssetFor(assetId: string): EarnAsset | null {
  const net = getNetwork();
  if (assetId === Asset.native().contractId(net.networkPassphrase)) return 'XLM';
  const usdc = new Asset('USDC', usdcIssuerFor(net.name));
  if (assetId === usdc.contractId(net.networkPassphrase)) return 'USDC';
  return null;
}

export interface BlendReserve {
  assetId: string;
  code: EarnAsset;
  /** This reserve's own supply APY, e.g. 0.042 = 4.2%. */
  supplyApy: number;
  totalSupply: string;
}

export interface BlendPool {
  id: string;
  name: string;
  /**
   * One entry per depositable reserve. A pool has no single APY: the old
   * average across reserves blended XLM, USDC and EURC into one figure that
   * matched none of them, next to a button that deposited whichever reserve
   * happened to be listed first.
   */
  reserves: BlendReserve[];
}

export interface BlendPosition {
  poolId: string;
  asset: string;
  code: EarnAsset | null;
  /** Current value of the supply in the underlying asset, in stroops. */
  deposited: string;
  bTokenBalance: string;
}

/** Load configured Blend pools and the APY of each reserve the wallet can use. */
export async function loadBlendPools(): Promise<BlendPool[]> {
  const poolIds = configuredPoolIds();
  if (poolIds.length === 0) return [];

  const pools = await Promise.all(
    poolIds.map(async (poolId): Promise<BlendPool | null> => {
      try {
        const pool = await loadPool(poolId);
        const reserves: BlendReserve[] = [];
        for (const reserve of pool.reserves.values()) {
          const code = earnAssetFor(reserve.assetId);
          if (!code) continue;
          reserves.push({
            assetId: reserve.assetId,
            code,
            supplyApy: Number.isFinite(reserve.estSupplyApy) ? reserve.estSupplyApy : 0,
            totalSupply: reserve.totalSupply().toString(),
          });
        }

        return {
          id: pool.id,
          name: pool.metadata.name || pool.id.slice(0, 8),
          reserves,
        };
      } catch (error) {
        console.warn(`[blend] failed loading pool ${poolId}:`, error);
        return null;
      }
    })
  );

  return pools.filter((pool): pool is BlendPool => pool !== null);
}

/**
 * Load supply positions for a user across configured pools.
 *
 * There is no "accrued interest" here on purpose. It used to be computed as
 * underlying minus bTokens, which is only interest if the bToken rate was
 * exactly 1 at deposit time — on a pool that has been running for months it
 * reported a large part of a fresh deposit as earnings. The principal is not on
 * chain, so the honest figure is the position's current value.
 */
export async function loadBlendPositions(userAddress: string): Promise<BlendPosition[]> {
  const poolIds = configuredPoolIds();
  if (poolIds.length === 0) return [];

  const positions = await Promise.all(
    poolIds.map(async (poolId): Promise<BlendPosition[]> => {
      try {
        const pool = await loadPool(poolId);
        const user = await pool.loadUser(userAddress);

        return [...pool.reserves.values()]
          .map((reserve) => {
            const bTokenBalance = user.getSupplyBTokens(reserve);
            if (bTokenBalance <= 0n) return null;

            return {
              poolId,
              asset: reserve.assetId,
              code: earnAssetFor(reserve.assetId),
              deposited: user.getSupply(reserve).toString(),
              bTokenBalance: bTokenBalance.toString(),
            };
          })
          .filter((item): item is BlendPosition => item !== null);
      } catch (error) {
        console.warn(`[blend] failed loading positions for pool ${poolId}:`, error);
        return [];
      }
    })
  );

  return positions.flat();
}

interface SupplyParams {
  poolId: string;
  assetContract: string;
  amountInStroops: bigint;
  supplierAddress: string;
  sourceAddress: string;
}

/** Build a Blend supply (deposit) transaction XDR. Throws with the reason on failure. */
export async function buildBlendSupplyXdr(params: SupplyParams): Promise<string> {
  return buildBlendSubmitXdr({
    poolId: params.poolId,
    sourceAddress: params.sourceAddress,
    fromAddress: params.supplierAddress,
    toAddress: params.supplierAddress,
    spenderAddress: params.supplierAddress,
    requestType: RequestType.Supply,
    assetContract: params.assetContract,
    amount: params.amountInStroops,
  });
}

interface WithdrawParams {
  poolId: string;
  assetContract: string;
  /** The position's current underlying value, in stroops. */
  depositedStroops: bigint;
  supplierAddress: string;
  sourceAddress: string;
}

/** What to ask for to withdraw a whole position. Exported for the test. */
export function withdrawAllAmount(depositedStroops: bigint): bigint {
  return depositedStroops + depositedStroops / 10n + 1n;
}

/**
 * Build a withdraw-everything transaction XDR.
 *
 * A withdraw request is denominated in the underlying asset, not in bTokens.
 * This used to pass the bToken balance, which is smaller than the underlying by
 * the bToken rate, so "Withdraw all" left the difference in the pool. The pool
 * caps a withdraw at the supplier's balance, so asking for a margin above the
 * last-read value takes everything, including interest accrued between the
 * read and the ledger that executes it.
 */
export async function buildBlendWithdrawXdr(params: WithdrawParams): Promise<string> {
  return buildBlendSubmitXdr({
    poolId: params.poolId,
    sourceAddress: params.sourceAddress,
    fromAddress: params.supplierAddress,
    toAddress: params.supplierAddress,
    spenderAddress: params.supplierAddress,
    requestType: RequestType.Withdraw,
    assetContract: params.assetContract,
    amount: withdrawAllAmount(params.depositedStroops),
  });
}

async function loadPool(poolId: string): Promise<PoolV1 | PoolV2> {
  try {
    return await PoolV2.load(blendNet(), poolId);
  } catch {
    return PoolV1.load(blendNet(), poolId);
  }
}

async function buildBlendSubmitXdr(params: {
  poolId: string;
  sourceAddress: string;
  fromAddress: string;
  toAddress: string;
  spenderAddress: string;
  requestType: RequestType;
  assetContract: string;
  amount: bigint;
}): Promise<string> {
  const rpc = new SorobanRpc.Server(getNetwork().rpcUrl);
  const sourceAccount = await rpc.getAccount(params.sourceAddress);

  const submitArgs = {
    from: params.fromAddress,
    spender: params.spenderAddress,
    to: params.toAddress,
    requests: [
      {
        request_type: params.requestType,
        address: params.assetContract,
        amount: params.amount,
      },
    ],
  };

  let submitOpXdr: string;
  try {
    submitOpXdr = new PoolContractV2(params.poolId).submit(submitArgs);
  } catch {
    submitOpXdr = new PoolContractV1(params.poolId).submit(submitArgs);
  }

  const operation = xdr.Operation.fromXDR(submitOpXdr, 'base64');

  const tx = new TransactionBuilder(
    new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber()),
    {
      fee: BASE_FEE,
      networkPassphrase: getNetwork().networkPassphrase,
    }
  )
    .addOperation(operation)
    .setTimeout(30)
    .build();

  // Failures propagate. Swallowing them into `null` left the screen saying only
  // "Failed to build the transaction", with the pool's actual reason (a supply
  // cap, a missing balance) thrown away.
  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}
