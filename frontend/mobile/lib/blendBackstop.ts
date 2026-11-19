import {
  BackstopContractV1,
  BackstopContractV2,
  BackstopPoolUser,
  BackstopPoolV1,
  BackstopPoolV2,
  PoolMetadata,
  type Network,
} from '@blend-capital/blend-sdk';
import { Account, BASE_FEE, rpc as SorobanRpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import { getNetwork } from './network';

/**
 * Blend backstop withdrawal queue presentation, state model, and transaction
 * builders for mobile.
 *
 * Blend's backstop uses a protocol-enforced 17-day withdrawal queue:
 *   1. `queue_withdrawal` — moves shares into the queue; backstop emissions
 *      stop while queued, while the depositor's share of pool interest continues.
 *   2. Wait 17 days until `Q4W.exp` (unix seconds) matures.
 *   3. `withdraw` — claims the matured shares out of the backstop.
 *   4. `cancel_withdrawal` (`dequeueWithdrawal` on the contract) — puts queued
 *      shares back into the active backstop immediately so emissions resume.
 *
 * This is NOT a user-chosen savings timelock (unlike the vault timelock in
 * #1278): it is a protocol condition because backstop capital may be drawn to
 * cover bad debt in the pool.
 */

export const BACKSTOP_QUEUE_DAYS = 17;
export const BACKSTOP_QUEUE_SECONDS = BACKSTOP_QUEUE_DAYS * 86_400;

/**
 * Exit terms stated before a user confirms a backstop deposit.
 *
 * Kept as exported copy constants so both the UI and tests reference the exact
 * promises shown before deposit confirmation.
 */
export const BACKSTOP_EXIT_TERMS = {
  heading: '17-day protocol withdrawal queue',
  summary:
    'Your money takes 17 days to come out once you request a withdrawal. This is a Blend protocol rule, not a Veil policy — backstop deposits exist to absorb bad debt in the pool if borrowers default.',
  queueDetail:
    'While waiting in the queue, backstop emissions stop but your share of pool interest continues. You can cancel a queued withdrawal at any time to put your deposit back.',
} as const;

/** Two plain-language facts shown while a withdrawal is queued. */
export const BACKSTOP_QUEUED_FACTS = {
  emissionsStopped: 'Backstop emissions stopped while in the queue.',
  interestContinues: 'Your share of pool interest continues.',
} as const;

/** Reversible-sounding copy for `cancel_withdrawal()`. */
export const BACKSTOP_CANCEL_COPY = {
  actionLabel: 'Cancel withdrawal and put back',
  helper: 'Returns your deposit to the backstop right away so emissions resume.',
} as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type BackstopQueueStatus = 'queued' | 'matured';

export interface BackstopQueuedWithdrawal {
  /** Stable identifier for this queue entry. */
  id: string;
  poolId: string;
  poolName: string;
  backstopId: string;
  /** Backstop shares queued for withdrawal (i128 string, 7-decimal stroops). */
  shares: string;
  /** Estimated backstop LP token value (stroops string). */
  tokens: string;
  /** Unix timestamp in seconds when the 17-day queue matures (`Q4W.exp`). */
  availableAt: number;
}

export interface BackstopPosition {
  poolId: string;
  poolName: string;
  backstopId: string;
  /** Active (non-queued) backstop shares (stroops string). */
  shares: string;
  /** Estimated active backstop LP token value (stroops string). */
  tokens: string;
  /** Queued withdrawals (both waiting and matured). */
  queuedWithdrawals: BackstopQueuedWithdrawal[];
  /** Matured shares ready to claim via `withdraw()` (stroops string). */
  unlockedShares: string;
}

export interface BackstopPoolSummary {
  poolId: string;
  poolName: string;
  backstopId: string;
}

/** Whether a queued withdrawal is still waiting or has matured and can be claimed. */
export function getQueueStatus(
  entry: Pick<BackstopQueuedWithdrawal, 'availableAt'>,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): BackstopQueueStatus {
  return nowSeconds >= entry.availableAt ? 'matured' : 'queued';
}

/**
 * Format a unix timestamp (seconds) as a human-plannable absolute calendar date
 * such as `"19 November"` (or `"6 January 2027"` when the date falls in a
 * different year than `nowSeconds`).
 *
 * Uses explicit month names rather than `Intl.DateTimeFormat` so formatting is
 * identical across Hermes, Android, iOS, and Jest regardless of device locale
 * data.
 */
export function formatCalendarDate(
  timestampSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): string {
  const target = new Date(timestampSeconds * 1_000);
  const now = new Date(nowSeconds * 1_000);
  const day = target.getUTCDate();
  const month = MONTHS[target.getUTCMonth()];
  if (target.getUTCFullYear() !== now.getUTCFullYear()) {
    return `${day} ${month} ${target.getUTCFullYear()}`;
  }
  return `${day} ${month}`;
}

/**
 * Absolute availability label for a queued withdrawal — e.g.
 * `"Available 19 November"`. Never returns a relative day countdown.
 */
export function formatAvailableDate(
  availableAtSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): string {
  return `Available ${formatCalendarDate(availableAtSeconds, nowSeconds)}`;
}

/**
 * Absolute label once a queued withdrawal has matured — e.g.
 * `"Available since 19 November"`.
 */
export function formatMaturedDate(
  availableAtSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): string {
  return `Available since ${formatCalendarDate(availableAtSeconds, nowSeconds)}`;
}

/** Compute the expected maturity timestamp (unix seconds) for a newly queued withdrawal. */
export function computeMaturityTimestamp(queuedAtSeconds: number = Math.floor(Date.now() / 1_000)): number {
  return queuedAtSeconds + BACKSTOP_QUEUE_SECONDS;
}

/**
 * Pure state transition helper for cancelling a queued withdrawal.
 *
 * Moves the cancelled entry's shares and tokens back into the active position
 * and removes the entry from `queuedWithdrawals`. Useful both for optimistic UI
 * updates and for deterministic unit testing.
 */
export function applyWithdrawalCancellation(
  position: BackstopPosition,
  withdrawalId: string,
): BackstopPosition {
  const target = position.queuedWithdrawals.find((entry) => entry.id === withdrawalId);
  if (!target) return position;

  const nextShares = BigInt(position.shares) + BigInt(target.shares);
  const nextTokens = BigInt(position.tokens) + BigInt(target.tokens);
  const remaining = position.queuedWithdrawals.filter((entry) => entry.id !== withdrawalId);
  const unlocked = BigInt(position.unlockedShares);
  const targetShares = BigInt(target.shares);
  const nextUnlocked = unlocked > targetShares ? unlocked - targetShares : 0n;

  return {
    ...position,
    shares: nextShares.toString(),
    tokens: nextTokens.toString(),
    queuedWithdrawals: remaining,
    unlockedShares: nextUnlocked.toString(),
  };
}

// ── Blend network & contract integration ────────────────────────────────────

function blendNet(): Network {
  const net = getNetwork();
  return { rpc: net.rpcUrl, passphrase: net.networkPassphrase };
}

const DEFAULT_POOL_IDS: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  testnet: '',
};

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
  return configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function loadBackstopPool(backstopId: string, poolId: string) {
  try {
    return await BackstopPoolV2.load(blendNet(), backstopId, poolId);
  } catch {
    return BackstopPoolV1.load(blendNet(), backstopId, poolId);
  }
}

/** Load available backstop pools derived from the configured Blend pools. */
export async function loadBackstopPools(): Promise<BackstopPoolSummary[]> {
  const poolIds = configuredPoolIds();
  if (poolIds.length === 0) return [];

  const summaries = await Promise.all(
    poolIds.map(async (poolId): Promise<BackstopPoolSummary | null> => {
      try {
        const meta = await PoolMetadata.load(blendNet(), poolId);
        if (!meta.backstop) return null;
        return {
          poolId,
          poolName: meta.name || poolId.slice(0, 8),
          backstopId: meta.backstop,
        };
      } catch (error) {
        console.warn(`[blend-backstop] failed loading metadata for pool ${poolId}:`, error);
        return null;
      }
    }),
  );

  return summaries.filter((item): item is BackstopPoolSummary => item !== null);
}

/** Load a user's active backstop positions and queued withdrawals across configured pools. */
export async function loadBackstopPositions(
  userAddress: string,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): Promise<BackstopPosition[]> {
  const poolIds = configuredPoolIds();
  if (poolIds.length === 0) return [];

  const positions = await Promise.all(
    poolIds.map(async (poolId): Promise<BackstopPosition | null> => {
      try {
        const meta = await PoolMetadata.load(blendNet(), poolId);
        if (!meta.backstop) return null;
        const backstopId = meta.backstop;
        const poolName = meta.name || poolId.slice(0, 8);

        const [backstopPool, user] = await Promise.all([
          loadBackstopPool(backstopId, poolId),
          BackstopPoolUser.load(blendNet(), backstopId, poolId, userAddress, nowSeconds),
        ]);

        const activeShares = user.balance.shares;
        const unlockedShares = user.balance.unlockedQ4W;
        const queuedWithdrawals: BackstopQueuedWithdrawal[] = user.balance.q4w.map((q4w, index) => ({
          id: `${poolId}:${q4w.exp.toString()}:${index}`,
          poolId,
          poolName,
          backstopId,
          shares: q4w.amount.toString(),
          tokens: backstopPool.sharesToBackstopTokens(q4w.amount).toString(),
          availableAt: Number(q4w.exp),
        }));

        if (unlockedShares > 0n) {
          queuedWithdrawals.unshift({
            id: `${poolId}:unlocked`,
            poolId,
            poolName,
            backstopId,
            shares: unlockedShares.toString(),
            tokens: backstopPool.sharesToBackstopTokens(unlockedShares).toString(),
            availableAt: nowSeconds,
          });
        }

        if (activeShares <= 0n && queuedWithdrawals.length === 0) return null;

        return {
          poolId,
          poolName,
          backstopId,
          shares: activeShares.toString(),
          tokens: backstopPool.sharesToBackstopTokens(activeShares).toString(),
          queuedWithdrawals,
          unlockedShares: unlockedShares.toString(),
        };
      } catch (error) {
        console.warn(`[blend-backstop] failed loading backstop position for pool ${poolId}:`, error);
        return null;
      }
    }),
  );

  return positions.filter((item): item is BackstopPosition => item !== null);
}

interface BackstopTxParams {
  backstopId: string;
  poolId: string;
  userAddress: string;
  amount: bigint;
}

async function buildBackstopOpXdr(
  params: BackstopTxParams,
  buildOp: (contract: BackstopContractV2 | BackstopContractV1) => string,
): Promise<string> {
  const rpc = new SorobanRpc.Server(getNetwork().rpcUrl);
  const sourceAccount = await rpc.getAccount(params.userAddress);

  let opXdr: string;
  try {
    opXdr = buildOp(new BackstopContractV2(params.backstopId));
  } catch {
    opXdr = buildOp(new BackstopContractV1(params.backstopId));
  }

  const operation = xdr.Operation.fromXDR(opXdr, 'base64');

  const tx = new TransactionBuilder(
    new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber()),
    {
      fee: BASE_FEE,
      networkPassphrase: getNetwork().networkPassphrase,
    },
  )
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

/** Build a backstop deposit transaction XDR. */
export async function buildBackstopDepositXdr(params: BackstopTxParams): Promise<string> {
  return buildBackstopOpXdr(params, (contract) =>
    contract.deposit({
      from: params.userAddress,
      pool_address: params.poolId,
      amount: params.amount,
    }),
  );
}

/** Build a `queue_withdrawal` transaction XDR to start the 17-day queue. */
export async function buildBackstopQueueWithdrawalXdr(params: BackstopTxParams): Promise<string> {
  return buildBackstopOpXdr(params, (contract) =>
    contract.queueWithdrawal({
      from: params.userAddress,
      pool_address: params.poolId,
      amount: params.amount,
    }),
  );
}

/** Build a `cancel_withdrawal` (`dequeueWithdrawal`) transaction XDR. */
export async function buildBackstopCancelWithdrawalXdr(params: BackstopTxParams): Promise<string> {
  return buildBackstopOpXdr(params, (contract) =>
    contract.dequeueWithdrawal({
      from: params.userAddress,
      pool_address: params.poolId,
      amount: params.amount,
    }),
  );
}

/** Build a `withdraw` transaction XDR to claim matured backstop shares. */
export async function buildBackstopWithdrawXdr(params: BackstopTxParams): Promise<string> {
  return buildBackstopOpXdr(params, (contract) =>
    contract.withdraw({
      from: params.userAddress,
      pool_address: params.poolId,
      amount: params.amount,
    }),
  );
}
