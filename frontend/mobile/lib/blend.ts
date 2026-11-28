import {
  Backstop,
  BackstopContractV1,
  BackstopContractV2,
  BackstopPoolUser,
  BackstopPoolUserEst,
  BackstopPoolV1,
  BackstopPoolV2,
  PoolV1,
  PoolV2,
  PoolContractV1,
  PoolContractV2,
  RequestType,
  type Network,
} from '@blend-capital/blend-sdk';
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

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

  return buildBlendOperationXdr(params.sourceAddress, submitOpXdr);
}

/**
 * Wrap one Blend contract operation in a transaction from `sourceAddress`,
 * simulate it and assemble the footprint. Shared by the lending `submit` and the
 * backstop calls, so there is one place that builds a Blend transaction.
 */
async function buildBlendOperationXdr(sourceAddress: string, operationXdr: string): Promise<string> {
  const rpc = new SorobanRpc.Server(getNetwork().rpcUrl);
  const sourceAccount = await rpc.getAccount(sourceAddress);
  const operation = xdr.Operation.fromXDR(operationXdr, 'base64');

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

// ─────────────────────────────────────────────────────────────────────────────
// Backstop
//
// The backstop is first-loss capital behind a lending pool. A depositor holds
// *shares* of a pool's backstop, and a share is not a fixed claim: its value is
// `pool tokens / pool shares`, which rises with the interest the pool pays in and
// FALLS when the backstop is drawn to cover bad debt. Everything here reports the
// current value, never what was deposited.
//
// Reads go through the SDK; every transaction is built here and handed to
// `signAndSubmitSorobanXdr`, the same signing path lending uses.
// ─────────────────────────────────────────────────────────────────────────────

/** Shown before a first deposit. The screen must not let it be dropped. */
export const BACKSTOP_RISK_NOTICE =
  "A backstop share's value can fall. If the pool takes bad debt, its backstop is drawn down to cover it, " +
  'and you can get back less than you put in. Withdrawals also wait in a queue before you can take them out, ' +
  'and queued shares are still exposed to losses while they wait.';

const BACKSTOP_STROOPS = 10_000_000n;

/** A withdrawal still waiting out its queue. Amounts are in stroops (7 decimals). */
export interface BackstopQueuedWithdrawal {
  shares: string;
  /** What those shares are worth right now, in backstop (LP) tokens. */
  lpTokens: string;
  /** When the queue lets them out, in seconds since the epoch. */
  expiresAt: number;
}

/** A pool's backstop, whether or not the wallet holds a part of it. */
export interface BackstopPoolInfo {
  poolId: string;
  poolName: string;
  backstopId: string;
  /** The backstop token (a BLND:USDC LP token), read from the backstop contract. */
  lpToken: string;
  /** Backstop tokens one share is worth right now. Below 1 after a loss. */
  sharePrice: number;
  /** Share of the backstop already queued to leave, 0–1. */
  queuedFraction: number;
}

export interface BackstopPosition extends BackstopPoolInfo {
  /** Shares not queued for withdrawal. */
  activeShares: string;
  /** Withdrawals still waiting out the queue. */
  queued: BackstopQueuedWithdrawal[];
  /** Shares whose queue has expired: these can be withdrawn now. */
  unlockedShares: string;
  /** Current value of every share held (active, queued and unlocked), in LP tokens. */
  lpTokens: string;
  /** The same, at the LP token's spot price in USDC. */
  usdValue: number;
  /**
   * BLND the position has earned. A different thing from the position: it arrives
   * as a reward for backstopping, and is not part of `lpTokens`.
   */
  emissionsBlnd: number;
}

export interface BackstopOverview {
  pools: BackstopPoolInfo[];
  positions: BackstopPosition[];
  /** Pools that could not be read. A position there may exist, so this is shown rather than dropped. */
  failedPoolIds: string[];
}

/** Current value of `shares` of a backstop, in LP-token stroops. */
export function backstopSharesValue(
  pool: { sharesToBackstopTokens: (shares: bigint) => bigint },
  shares: bigint,
): bigint {
  return pool.sharesToBackstopTokens(shares);
}

/** Backstop tokens one share is worth. 1 when nothing is deposited yet. */
export function backstopSharePrice(poolBalance: { shares: bigint; tokens: bigint }): number {
  if (poolBalance.shares <= 0n) return 1;
  return Number(poolBalance.tokens) / Number(poolBalance.shares);
}

/**
 * Parse a typed amount into stroops without going through floats. Null for
 * anything that is not a positive number with at most 7 decimals.
 */
export function parseStroops(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const value = BigInt(whole) * BACKSTOP_STROOPS + BigInt(fraction.padEnd(7, '0'));
  return value > 0n ? value : null;
}

async function loadBackstopPool(backstopId: string, poolId: string): Promise<BackstopPoolV1 | BackstopPoolV2> {
  try {
    return await BackstopPoolV2.load(blendNet(), backstopId, poolId);
  } catch {
    return BackstopPoolV1.load(blendNet(), backstopId, poolId);
  }
}

/**
 * Load the backstop of every configured pool and the wallet's position in each.
 *
 * Nothing here is the amount deposited: the chain does not keep it, and it would
 * be the wrong figure anyway. The value is shares × (pool tokens / pool shares).
 */
export async function loadBackstopOverview(userAddress: string): Promise<BackstopOverview> {
  const overview: BackstopOverview = { pools: [], positions: [], failedPoolIds: [] };
  const poolIds = configuredPoolIds();

  await Promise.all(
    poolIds.map(async (poolId) => {
      try {
        const pool = await loadPool(poolId);
        const backstopId = pool.metadata.backstop;
        const [backstop, backstopPool, user] = await Promise.all([
          Backstop.load(blendNet(), backstopId),
          loadBackstopPool(backstopId, poolId),
          BackstopPoolUser.load(blendNet(), backstopId, poolId, userAddress),
        ]);

        const { shares, tokens, q4w } = backstopPool.poolBalance;
        const info: BackstopPoolInfo = {
          poolId,
          poolName: pool.metadata.name || poolId.slice(0, 8),
          backstopId,
          lpToken: backstop.config.backstopTkn,
          sharePrice: backstopSharePrice({ shares, tokens }),
          queuedFraction: shares > 0n ? Number(q4w) / Number(shares) : 0,
        };
        overview.pools.push(info);

        const { balance } = user;
        const held = balance.shares + balance.totalQ4W;
        if (held <= 0n) return;

        const lpTokens = backstopSharesValue(backstopPool, held);
        overview.positions.push({
          ...info,
          activeShares: balance.shares.toString(),
          queued: balance.q4w.map((entry) => ({
            shares: entry.amount.toString(),
            lpTokens: backstopSharesValue(backstopPool, entry.amount).toString(),
            expiresAt: Number(entry.exp),
          })),
          unlockedShares: balance.unlockedQ4W.toString(),
          lpTokens: lpTokens.toString(),
          usdValue: (Number(lpTokens) / Number(BACKSTOP_STROOPS)) * backstop.backstopToken.lpTokenPrice,
          emissionsBlnd: backstopEmissions(backstop, backstopPool, user),
        });
      } catch (error) {
        console.warn(`[blend] failed loading backstop for pool ${poolId}:`, error);
        overview.failedPoolIds.push(poolId);
      }
    }),
  );

  return overview;
}

/** Accrued BLND, in whole tokens, by the SDK's own estimate. Zero when no emissions are running. */
function backstopEmissions(
  backstop: Backstop,
  pool: BackstopPoolV1 | BackstopPoolV2,
  user: BackstopPoolUser,
): number {
  const { emissions } = BackstopPoolUserEst.build(backstop, pool, user);
  return Number.isFinite(emissions) ? emissions : 0;
}

/**
 * The backstop token the wallet holds, in stroops: what a deposit can draw on.
 * Read from the token contract itself; the address comes from the backstop's own
 * config, never from a constant here.
 */
export async function loadBackstopLpBalance(userAddress: string, lpToken: string): Promise<bigint> {
  const rpc = new SorobanRpc.Server(getNetwork().rpcUrl);
  const tx = new TransactionBuilder(new Account(userAddress, '0'), {
    fee: BASE_FEE,
    networkPassphrase: getNetwork().networkPassphrase,
  })
    .addOperation(new Contract(lpToken).call('balance', new Address(userAddress).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Could not read the backstop token balance: ${sim.error}`);
  }
  const retval = 'result' in sim ? sim.result?.retval : undefined;
  return retval ? BigInt(scValToNative(retval)) : 0n;
}

/** The four calls a backstop position moves through. */
export type BackstopAction = 'deposit' | 'queue' | 'cancel' | 'withdraw';

export interface BackstopActionParams {
  action: BackstopAction;
  backstopId: string;
  poolId: string;
  /** The classic G… account that holds the position and pays the fee. */
  userAddress: string;
  /**
   * Stroops. Backstop tokens for `deposit`; **shares** for `queue`, `cancel` and
   * `withdraw`, because the backstop queues shares, not tokens.
   */
  amount: bigint;
}

/**
 * Build one backstop transaction XDR: `deposit`, `queue_withdrawal`,
 * `dequeue_withdrawal` (the cancel) or `withdraw`.
 *
 * `withdraw` only succeeds for shares whose queue has expired, and `cancel` only
 * for shares still queued. The contract enforces both, so a wrong amount fails
 * simulation with the contract's own reason rather than moving anything.
 */
export async function buildBackstopActionXdr(params: BackstopActionParams): Promise<string> {
  if (params.amount <= 0n) throw new Error('Enter an amount above zero.');

  const args = {
    from: params.userAddress,
    pool_address: params.poolId,
    amount: params.amount,
  };
  const method = {
    deposit: 'deposit',
    queue: 'queueWithdrawal',
    cancel: 'dequeueWithdrawal',
    withdraw: 'withdraw',
  }[params.action] as 'deposit' | 'queueWithdrawal' | 'dequeueWithdrawal' | 'withdraw';

  let operationXdr: string;
  try {
    operationXdr = new BackstopContractV2(params.backstopId)[method](args);
  } catch {
    operationXdr = new BackstopContractV1(params.backstopId)[method](args);
  }
  return buildBlendOperationXdr(params.userAddress, operationXdr);
}

/**
 * When a queued withdrawal of `amount` shares would come out of the queue, read
 * from the backstop itself by simulating `queue_withdrawal`: the contract
 * returns the queue entry it would create, expiry included. Nothing is
 * submitted. Throws if the backstop cannot be read, so the caller never shows a
 * guessed queue length.
 */
export async function loadBackstopQueueLength(
  params: Omit<BackstopActionParams, 'action'>,
): Promise<{ expiresAt: number; seconds: number }> {
  const xdrString = await buildBackstopActionXdr({ ...params, action: 'queue' });
  const net = getNetwork();
  const tx = TransactionBuilder.fromXDR(xdrString, net.networkPassphrase);
  const sim = await new SorobanRpc.Server(net.rpcUrl).simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Could not read the withdrawal queue length: ${sim.error}`);
  }
  const retval = 'result' in sim ? sim.result?.retval : undefined;
  const entry = retval ? (scValToNative(retval) as { exp?: bigint | number }) : undefined;
  if (entry?.exp === undefined) throw new Error('The backstop did not report a queue length.');
  const expiresAt = Number(entry.exp);
  const seconds = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  return { expiresAt, seconds };
}
