import {
  PoolV1,
  PoolV2,
  PoolContractV1,
  PoolContractV2,
  RequestType,
  type Network,
} from '@blend-capital/blend-sdk';
import {
  Account,
  Asset,
  BASE_FEE,
  rpc as SorobanRpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

import { isRegisteredIssuer, USDT0_MAINNET_ISSUER } from './assets';
import { getNetwork, type VeilNetworkName } from './network';
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
 * Blend's public Fixed V2 pool on mainnet. A pool id is public and permanent,
 * so shipping it as the default means Earn works in any build rather than only
 * in one whose environment was set up right.
 *
 * Mainnet reserve check (verified on-chain against https://mainnet.sorobanrpc.com
 * on 2026-11-19 for pool CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD,
 * pool name "Fixed"):
 *   - XLM  (CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA)
 *   - USDC (CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75)
 *   - EURC (CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV)
 *
 * Tether's USDT0 (issuer GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q)
 * has NO reserve in Blend Fixed V2. Rather than silently swapping USDT0 into USDC,
 * Earn keeps USDT0 out of `EarnAsset` and reports it as unavailable on mainnet.
 */
export const DEFAULT_BLEND_MAINNET_POOL_ID =
  'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD';

const DEFAULT_POOL_IDS: Record<'mainnet' | 'testnet', string> = {
  mainnet: DEFAULT_BLEND_MAINNET_POOL_ID,
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
    .filter((value) => value.length > 0 && StrKey.isValidContract(value));

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
  const usdcIssuer = usdcIssuerFor(net.name);
  if (!StrKey.isValidEd25519PublicKey(usdcIssuer)) return null;
  const usdc = new Asset('USDC', usdcIssuer);
  if (assetId === usdc.contractId(net.networkPassphrase)) return 'USDC';
  return null;
}

function shortIssuer(issuer: string): string {
  return `${issuer.slice(0, 4)}…${issuer.slice(-4)}`;
}

/**
 * Derive Tether's pinned USDT0 Soroban SAC contract id from its code and issuer
 * on mainnet (never pasted as a literal). Returns null on testnet, where Tether's
 * USDT0 does not exist.
 */
export function usdt0SacContractId(
  networkName: VeilNetworkName,
  networkPassphrase: string
): string | null {
  if (networkName !== 'mainnet') return null;
  if (!StrKey.isValidEd25519PublicKey(USDT0_MAINNET_ISSUER)) return null;
  const derived = new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(networkPassphrase);
  return StrKey.isValidContract(derived) ? derived : null;
}

/**
 * Whether `code` + `issuer` identifies Tether's real USDT0 on `networkName`.
 * Mainnet has multiple impostor assets called USDT0, so a code match is never
 * enough — the issuer must be a valid Ed25519 key matching the pinned registry
 * issuer.
 */
export function isPinnedUsdt0(
  code: string,
  issuer: string | null | undefined,
  networkName: VeilNetworkName
): boolean {
  if (networkName !== 'mainnet') return false;
  if (code !== 'USDT0') return false;
  if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) return false;
  return isRegisteredIssuer('USDT0', issuer, 'mainnet');
}

export interface UnavailableEarnAsset {
  code: 'USDT0';
  issuer: string;
  issuerName: string;
  /** Display label that pins the issuer so impostor tokens cannot be confused with it. */
  label: string;
  /** Derived Soroban SAC contract id for the pinned code:issuer pair. */
  assetId: string;
  /** Plain availability headline shown on the Earn screen. */
  status: string;
  /** One-line reason why earning is unavailable. */
  reason: string;
  /** Plain statement of what the user will actually be holding. */
  holdingStatement: string;
}

/**
 * Held-wallet stablecoins that users expect to save in Earn but cannot earn on
 * yet because no loaded Blend pool carries a reserve for their pinned issuer.
 *
 * Checked against the derived SAC id of Tether's pinned USDT0 issuer (never by
 * code alone), so an impostor USDT0 reserve can never hide the unavailability
 * notice.
 */
export function unavailableEarnAssets(
  networkName: VeilNetworkName,
  networkPassphrase: string,
  pools: BlendPool[]
): UnavailableEarnAsset[] {
  const usdt0AssetId = usdt0SacContractId(networkName, networkPassphrase);
  if (!usdt0AssetId) return [];

  const hasPinnedUsdt0Reserve = pools.some((pool) =>
    pool.reserves.some((reserve) => reserve.assetId === usdt0AssetId)
  );
  if (hasPinnedUsdt0Reserve) return [];

  return [
    {
      code: 'USDT0',
      issuer: USDT0_MAINNET_ISSUER,
      issuerName: 'Tether',
      label: `USDT0 · Tether (${shortIssuer(USDT0_MAINNET_ISSUER)})`,
      assetId: usdt0AssetId,
      status: 'Earning not available for this asset yet',
      reason: 'Blend Fixed V2 does not have a USDT0 reserve on Stellar mainnet yet.',
      holdingStatement:
        'Your USDT0 stays in your wallet as USDT0 — Veil does not convert it to USDC.',
    },
  ];
}

export type EarnAssetParamCheck =
  | { kind: 'ok' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'unregistered-issuer'; message: string }
  | { kind: 'invalid-issuer'; message: string };

/**
 * Validate a deep-link `/earn?asset=...&issuer=...` pair before matching reserves.
 * Pins USDT0 by issuer so an impostor USDT0 is called out explicitly instead of
 * being treated as Tether's USDT0.
 */
export function checkEarnAssetParam(
  code: string,
  issuer: string,
  networkName: VeilNetworkName
): EarnAssetParamCheck {
  const normalizedCode = code.trim().toUpperCase();
  if (normalizedCode !== 'USDT0') return { kind: 'ok' };

  const trimmedIssuer = issuer.trim();
  if (!trimmedIssuer || !StrKey.isValidEd25519PublicKey(trimmedIssuer)) {
    return {
      kind: 'invalid-issuer',
      message: 'USDT0 must specify a valid Stellar issuer address.',
    };
  }

  if (networkName !== 'mainnet') {
    return {
      kind: 'unavailable',
      message: 'USDT0 is not available on testnet.',
    };
  }

  if (isPinnedUsdt0(normalizedCode, trimmedIssuer, networkName)) {
    return {
      kind: 'unavailable',
      message:
        `Earning not available for USDT0 · Tether (${shortIssuer(USDT0_MAINNET_ISSUER)}) yet. ` +
        'Blend Fixed V2 does not have a USDT0 reserve on Stellar mainnet yet. ' +
        'Your USDT0 stays in your wallet as USDT0.',
    };
  }

  return {
    kind: 'unregistered-issuer',
    message:
      `Unregistered issuer (${shortIssuer(trimmedIssuer)}) for USDT0. ` +
      `This is not Tether's USDT0 (${shortIssuer(USDT0_MAINNET_ISSUER)}), so it cannot be used in Earn.`,
  };
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
