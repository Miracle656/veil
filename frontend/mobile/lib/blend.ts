import {
  PoolV1,
  PoolV2,
  PoolContractV1,
  PoolContractV2,
  RequestType,
  type Network,
} from '@blend-capital/blend-sdk';
import { Account, BASE_FEE, rpc as SorobanRpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import { getNetwork } from './network';

/**
 * Blend lending-pool reads and transaction building.
 *
 * Ported from `frontend/wallet/lib/blend.ts`; the only differences are the
 * `EXPO_PUBLIC_*` environment variables the Expo bundler inlines and the
 * network coming from the mobile `getNetwork()`.
 */

const net = getNetwork();

const blendNetwork: Network = {
  rpc: net.rpcUrl,
  passphrase: net.networkPassphrase,
};

function configuredPoolIds(): string[] {
  const configured: string = process.env['EXPO_PUBLIC_BLEND_POOL_IDS'] ?? '';
  const ids = configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    console.warn('[blend] EXPO_PUBLIC_BLEND_POOL_IDS is not configured');
  }

  return ids;
}

export interface BlendPool {
  id: string;
  name: string;
  supplyApy: number; // e.g. 0.042 = 4.2%
  totalSupply: string;
  assets: string[];
}

export interface BlendPosition {
  poolId: string;
  asset: string;
  deposited: string;
  bTokenBalance: string;
  accruedInterest: string;
}

/** Load configured Blend pools and their reserve APYs. */
export async function loadBlendPools(): Promise<BlendPool[]> {
  const poolIds = configuredPoolIds();
  if (poolIds.length === 0) return [];

  const pools = await Promise.all(
    poolIds.map(async (poolId): Promise<BlendPool | null> => {
      try {
        const pool = await loadPool(poolId);
        const reserves = [...pool.reserves.values()];
        const totalSupply = reserves
          .reduce((acc, reserve) => acc + reserve.totalSupply(), 0n)
          .toString();

        const avgSupplyApy =
          reserves.length > 0
            ? reserves.reduce((acc, reserve) => acc + reserve.estSupplyApy, 0) / reserves.length
            : 0;

        return {
          id: pool.id,
          name: pool.metadata.name || pool.id.slice(0, 8),
          supplyApy: avgSupplyApy,
          totalSupply,
          assets: pool.metadata.reserveList,
        };
      } catch (error) {
        console.warn(`[blend] failed loading pool ${poolId}:`, error);
        return null;
      }
    })
  );

  return pools.filter((pool): pool is BlendPool => pool !== null);
}

/** Load supply positions for a user across configured pools. */
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

            const deposited = user.getSupply(reserve);
            const accruedInterest = deposited > bTokenBalance ? deposited - bTokenBalance : 0n;

            return {
              poolId,
              asset: reserve.assetId,
              deposited: deposited.toString(),
              bTokenBalance: bTokenBalance.toString(),
              accruedInterest: accruedInterest.toString(),
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

/** Build a Blend supply (deposit) transaction XDR. */
export async function buildBlendSupplyXdr(params: SupplyParams): Promise<string | null> {
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
  bTokenAmount: bigint;
  supplierAddress: string;
  sourceAddress: string;
}

/** Build a Blend withdraw (redeem) transaction XDR. */
export async function buildBlendWithdrawXdr(params: WithdrawParams): Promise<string | null> {
  return buildBlendSubmitXdr({
    poolId: params.poolId,
    sourceAddress: params.sourceAddress,
    fromAddress: params.supplierAddress,
    toAddress: params.supplierAddress,
    spenderAddress: params.supplierAddress,
    requestType: RequestType.Withdraw,
    assetContract: params.assetContract,
    amount: params.bTokenAmount,
  });
}

async function loadPool(poolId: string): Promise<PoolV1 | PoolV2> {
  try {
    return await PoolV2.load(blendNetwork, poolId);
  } catch {
    return PoolV1.load(blendNetwork, poolId);
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
}): Promise<string | null> {
  try {
    const rpc = new SorobanRpc.Server(net.rpcUrl);
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
        networkPassphrase: net.networkPassphrase,
      }
    )
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const sim = await rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }

    return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
  } catch (error) {
    console.warn('[blend] build submit XDR failed:', error);
    return null;
  }
}
